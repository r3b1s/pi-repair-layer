/**
 * Grammar-leak recovery — adapted in place from monotykamary/pi-tool-repair
 * (MIT), `src/grammar-repair.ts`. The grammar-family parsers, candidate
 * selection, code-fence awareness, and `removeRanges` are kept close to
 * upstream; the driver (`recoverGrammarLeaks`) is rewritten to integrate this
 * extension's settings, model gate, and telemetry, and to add a stopReason gate
 * upstream lacks.
 *
 * What it does: some models print a tool call as literal text (10 grammar
 * families — DSML, Qwen/GLM XML, Kimi/Mistral/Llama/MiniMax sentinels, etc.)
 * instead of emitting a real tool call. On the `message_end` hook this detects
 * those leaked blocks, strips them from the assistant text, and — in `recover`
 * mode — promotes the parsed calls to real toolCalls that execute the same turn.
 *
 * The one deliberate improvement over upstream: promotion happens ONLY when the
 * original message's `stopReason` is `"stop"` (see `recoverGrammarLeaks`).
 * Upstream promotes regardless and overwrites `stopReason: "length"`, defeating
 * pi's protection that fails all tool calls on truncated output
 * (docs/research.md Claim 7). Stripping leaked text is permitted on any
 * stopReason; only promotion is gated.
 */

export const GRAMMAR_NAMES = [
  "dsml",
  "invoke",
  "qwen",
  "kimi",
  "mistral",
  "llama",
  "glm",
  "granite",
  "minimax-text",
  "olmo",
] as const;

export type GrammarName = (typeof GRAMMAR_NAMES)[number];
export type GrammarRecoveryMode = "off" | "strip" | "recover";

export interface RecoveredToolCall {
  name: string;
  arguments: Record<string, unknown>;
  grammar: GrammarName;
}

interface Candidate extends RecoveredToolCall {
  range: Range;
  stripOnly?: boolean;
}

interface Range {
  start: number;
  end: number;
}

interface MinimalTextContent {
  type: "text";
  text: string;
  [key: string]: unknown;
}

interface MinimalThinkingContent {
  type: "thinking";
  thinking: string;
  [key: string]: unknown;
}

interface MinimalToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  [key: string]: unknown;
}

type MinimalAssistantContent =
  | MinimalTextContent
  | MinimalThinkingContent
  | MinimalToolCallContent
  | Record<string, unknown>;

export interface MinimalAssistantMessage {
  role: string;
  content: MinimalAssistantContent[];
  stopReason?: string;
  [key: string]: unknown;
}

const ALL_GRAMMARS = [...GRAMMAR_NAMES];

/**
 * Open-model families known to print tool-call grammar as text. Grammar
 * recovery runs only when the current model matches one of these — a heuristic
 * gate that keeps the parsers off frontier models (Claude/GPT/Gemini) that emit
 * native tool calls and may legitimately quote grammar in prose. The real
 * safety is the known-tool / empty-args / stopReason gates; this list is the
 * cheap first filter and can be loosened as telemetry warrants.
 */
export const GRAMMAR_RECOVERY_MODELS: readonly RegExp[] = [
  /glm/i,
  /kimi/i,
  /minimax/i,
  /qwen/i,
  /mistral/i,
  /llama/i,
  /granite/i,
  /olmo/i,
  /deepseek/i,
];

/** Whether grammar recovery's model gate matches the given model id. */
export function modelLeaksGrammar(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return GRAMMAR_RECOVERY_MODELS.some((re) => re.test(modelId));
}

export interface GrammarRecoveryOptions {
  mode: GrammarRecoveryMode;
  /** Active/allowed tool names; a leaked call is only promoted if its name is here. */
  knownTools: Set<string>;
  /** Which grammar families to detect. Default: all. */
  grammars?: readonly GrammarName[];
  /** Require the recovered tool name to be in `knownTools`. Default: true. */
  requireKnownTool?: boolean;
}

export interface GrammarRecoveryResult {
  /** Whether the message was modified (text stripped and/or calls promoted). */
  changed: boolean;
  /** Calls promoted to real toolCalls (empty unless a promotion happened). */
  recoveredCalls: RecoveredToolCall[];
  /** Distinct grammar families whose leaked text was stripped. */
  strippedGrammars: GrammarName[];
  /** Number of leaked ranges removed from text. */
  strippedRanges: number;
  /** True when calls were promoted and stopReason was set to "toolUse". */
  promoted: boolean;
  /** The replacement message (same object when unchanged). */
  message: MinimalAssistantMessage;
}

/**
 * Detect leaked tool-call grammar in an assistant message, strip it from the
 * text, and (in `recover` mode, on a `stopReason: "stop"` message with no
 * existing toolCalls) promote the parsed calls to real toolCalls.
 */
export function recoverGrammarLeaks(
  message: MinimalAssistantMessage,
  options: GrammarRecoveryOptions,
): GrammarRecoveryResult {
  const unchanged: GrammarRecoveryResult = {
    changed: false,
    recoveredCalls: [],
    strippedGrammars: [],
    strippedRanges: 0,
    promoted: false,
    message,
  };

  if (
    options.mode === "off" ||
    message.role !== "assistant" ||
    !Array.isArray(message.content)
  ) {
    return unchanged;
  }

  const enabled = new Set(options.grammars ?? ALL_GRAMMARS);
  const requireKnownTool = options.requireKnownTool ?? true;
  const existingToolCalls = message.content.filter(isToolCallContent);
  const recoveredCalls: RecoveredToolCall[] = [];
  const strippedGrammars = new Set<GrammarName>();
  let strippedRanges = 0;
  let changed = false;

  const nextContent = message.content.map((part) => {
    const text = getPartText(part);
    if (text === undefined) return part;

    const candidates = selectCandidates(
      parseToolGrammarCandidates(text, enabled),
    ).filter(
      (candidate) =>
        candidate.stripOnly ||
        isAllowedTool(candidate.name, requireKnownTool, options.knownTools),
    );

    if (candidates.length === 0) return part;

    strippedRanges += candidates.length;
    changed = true;
    for (const candidate of candidates) {
      strippedGrammars.add(candidate.grammar);
      if (candidate.stripOnly) continue;
      // Safety: a candidate that parsed to an empty argument object is almost
      // always a malformed fragment (e.g. `<tool_call>write</tool_call>`); it
      // would crash as a real call with missing required properties. Skip it.
      if (Object.keys(candidate.arguments).length === 0) continue;
      recoveredCalls.push({
        name: candidate.name,
        arguments: candidate.arguments,
        grammar: candidate.grammar,
      });
    }

    const strippedText = removeRanges(
      text,
      candidates.map((candidate) => candidate.range),
    );
    return setPartText(part, strippedText);
  });

  // Promotion gate: recover mode, no existing real toolCalls, something to
  // promote, AND the original stopReason is "stop" (never overwrite
  // "length"/"error"/"aborted"). Stripping above is allowed regardless.
  const shouldRecover =
    options.mode === "recover" &&
    existingToolCalls.length === 0 &&
    recoveredCalls.length > 0 &&
    message.stopReason === "stop";

  if (!changed && !shouldRecover) return unchanged;

  if (shouldRecover) {
    let index = 0;
    for (const call of recoveredCalls) {
      nextContent.push({
        type: "toolCall",
        id: makeRecoveredToolCallId(call.grammar, index++),
        name: call.name,
        arguments: call.arguments,
      });
    }
  }

  const nextMessage: MinimalAssistantMessage = {
    ...message,
    content: nextContent,
  };
  if (shouldRecover) nextMessage.stopReason = "toolUse";

  return {
    changed: changed || shouldRecover,
    recoveredCalls: shouldRecover ? recoveredCalls : [],
    strippedGrammars: [...strippedGrammars],
    strippedRanges,
    promoted: shouldRecover,
    message: nextMessage,
  };
}

/** Pure parse: leaked tool calls in text (no stripping, no gates). For tests. */
export function parseToolGrammarLeaks(
  text: string,
  grammars: Iterable<GrammarName> = ALL_GRAMMARS,
): RecoveredToolCall[] {
  const enabled = new Set(grammars);
  return selectCandidates(parseToolGrammarCandidates(text, enabled))
    .filter((candidate) => !candidate.stripOnly)
    .map((candidate) => ({
      name: candidate.name,
      arguments: candidate.arguments,
      grammar: candidate.grammar,
    }));
}

// ─── Grammar-family parsers (adapted verbatim from upstream) ──────────────────

function parseToolGrammarCandidates(
  text: string,
  enabled: Set<GrammarName>,
): Candidate[] {
  const candidates: Candidate[] = [];
  if (enabled.has("dsml")) {
    candidates.push(...parseDsml(text));
    candidates.push(...parseDsmlDanglingMarkers(text));
  }
  if (enabled.has("kimi")) candidates.push(...parseKimi(text));
  if (enabled.has("mistral")) {
    candidates.push(...parseMistral(text));
    candidates.push(...parseBareJsonToolCalls(text, "mistral"));
  }
  if (enabled.has("minimax-text")) candidates.push(...parseMiniMaxText01(text));
  if (enabled.has("invoke")) candidates.push(...parseInvokeXml(text));
  if (enabled.has("qwen") || enabled.has("glm") || enabled.has("granite")) {
    candidates.push(...parseToolCallXml(text, enabled));
  }
  if (enabled.has("granite"))
    candidates.push(...parseBarePythonicToolCalls(text, "granite"));
  if (enabled.has("llama")) {
    candidates.push(...parseLlamaPythonTag(text));
    candidates.push(...parseBareJsonToolCalls(text, "llama"));
  }
  if (enabled.has("olmo")) candidates.push(...parseOlmo(text));
  return candidates.filter(
    (candidate) => candidate.range.end > candidate.range.start,
  );
}

function parseDsml(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const prefix = "(?:｜{1,2}DSML｜{1,2}|DSML｜|\\s*\\|\\s*DSML\\s*\\|\\s*)";
  const outerOpen = new RegExp(
    `<${prefix}(?:tool_calls|function_calls)>`,
    "giu",
  );

  for (const match of text.matchAll(outerOpen)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const start = match.index;
    const bodyStart = start + match[0].length;
    const close =
      findDsmlClose(text, bodyStart, "tool_calls") ??
      findDsmlClose(text, bodyStart, "function_calls");
    const end = close ? close.end : findBestUnclosedDsmlEnd(text, bodyStart);
    if (end === undefined) continue;
    const body = text.slice(bodyStart, close ? close.start : end);
    const calls = parseDsmlInvokes(body);
    for (const call of calls) {
      candidates.push({ ...call, grammar: "dsml", range: { start, end } });
    }
  }

  return candidates;
}

function parseDsmlDanglingMarkers(text: string): Candidate[] {
  if (!text.includes("DSML")) return [];
  const prefix = "(?:｜{1,2}DSML｜{1,2}|DSML｜|\\s*\\|\\s*DSML\\s*\\|\\s*)";
  const markerRe = new RegExp(
    `</?${prefix}(?:tool_calls|function_calls|invoke|parameter)(?:\\s+[^>\\n]*)?>?`,
    "giu",
  );
  const candidates: Candidate[] = [];
  for (const match of text.matchAll(markerRe)) {
    if (match.index === undefined) continue;
    if (isInsideCodeFence(text, match.index)) continue;
    candidates.push({
      name: "",
      arguments: {},
      grammar: "dsml",
      range: { start: match.index, end: match.index + match[0].length },
      stripOnly: true,
    });
  }
  return candidates;
}

function findDsmlClose(
  text: string,
  from: number,
  outerName: string,
): Range | undefined {
  const prefix = "(?:｜{1,2}DSML｜{1,2}|DSML｜|\\s*\\|\\s*DSML\\s*\\|\\s*)";
  const closeRe = new RegExp(`</${prefix}${outerName}>`, "giu");
  closeRe.lastIndex = from;
  const match = closeRe.exec(text);
  return match && match.index >= from
    ? { start: match.index, end: match.index + match[0].length }
    : undefined;
}

function findBestUnclosedDsmlEnd(
  text: string,
  from: number,
): number | undefined {
  const invokeClose =
    /<\/(?:｜{1,2}DSML｜{1,2}|DSML｜|\s*\|\s*DSML\s*\|\s*)invoke>/giu;
  invokeClose.lastIndex = from;
  let end: number | undefined;
  for (;;) {
    const match = invokeClose.exec(text);
    if (!match) break;
    end = match.index + match[0].length;
  }
  return end;
}

function parseDsmlInvokes(
  body: string,
): Array<Omit<Candidate, "range" | "grammar">> {
  const calls: Array<Omit<Candidate, "range" | "grammar">> = [];
  const prefix = "(?:｜{1,2}DSML｜{1,2}|DSML｜|\\s*\\|\\s*DSML\\s*\\|\\s*)";
  const invokeRe = new RegExp(
    `<${prefix}invoke\\s+name=["']([^"']+)["']\\s*>`,
    "giu",
  );

  for (const match of body.matchAll(invokeRe)) {
    if (match.index === undefined) continue;
    const name = match[1]?.trim();
    if (!name) continue;
    const invokeBodyStart = match.index + match[0].length;
    const close = findPattern(
      body,
      new RegExp(`</${prefix}invoke>`, "iu"),
      invokeBodyStart,
    );
    if (!close) continue;
    const invokeBody = body.slice(invokeBodyStart, close.start);
    calls.push({ name, arguments: parseDsmlArguments(invokeBody) });
  }

  return calls;
}

function parseDsmlArguments(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const prefix = "(?:｜{1,2}DSML｜{1,2}|DSML｜|\\s*\\|\\s*DSML\\s*\\|\\s*)";
  const paramRe = new RegExp(
    `<${prefix}parameter\\s+name=["']([^"']+)["'](?:\\s+string=["'](true|false)["'])?\\s*>([\\s\\S]*?)</${prefix}parameter>`,
    "giu",
  );

  for (const match of body.matchAll(paramRe)) {
    const key = match[1]?.trim();
    if (!key) continue;
    const stringAttr = match[2];
    const rawValue = match[3] ?? "";
    args[key] =
      stringAttr === "false"
        ? parseJsonValueOrString(rawValue.trim())
        : rawValue;
  }

  if (Object.keys(args).length > 0) return args;

  const direct = parseJsonObject(
    extractFirstBalancedJson(body.trim())?.json ?? body.trim(),
  );
  return normalizeArgumentsObject(direct) ?? {};
}

function parseKimi(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const sectionRe =
    /<\|tool_calls?_section_begin\|>([\s\S]*?)<\|tool_calls?_section_end\|>/gi;

  for (const section of text.matchAll(sectionRe)) {
    if (section.index === undefined || isInsideCodeFence(text, section.index))
      continue;
    const sectionStart = section.index;
    const body = section[1] ?? "";
    const callRe =
      /<\|tool_call_begin\|>([^<]*?)<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/gi;
    for (const call of body.matchAll(callRe)) {
      const idText = (call[1] ?? "").trim();
      const name = parseKimiToolName(idText);
      if (!name) continue;
      const args = parseJsonObject(call[2]?.trim() ?? "") ?? {};
      candidates.push({
        name,
        arguments: args,
        grammar: "kimi",
        range: { start: sectionStart, end: sectionStart + section[0].length },
      });
    }
  }

  return candidates;
}

function parseKimiToolName(idText: string): string | undefined {
  const canonical = /^functions\.([A-Za-z_][\w.-]*):\d+$/.exec(idText);
  if (canonical) return canonical[1];
  const relaxed = /^(?:functions\.)?([A-Za-z_][\w.-]*)(?::\d+)?$/.exec(idText);
  if (relaxed && !/^call[_-]?\d+$/i.test(relaxed[1] ?? "")) return relaxed[1];
  return undefined;
}

function parseMistral(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const marker = "[TOOL_CALLS]";
  let index = 0;

  for (
    index = text.indexOf(marker, index);
    index !== -1;
    index = text.indexOf(marker, index)
  ) {
    if (isInsideCodeFence(text, index)) {
      index += marker.length;
      continue;
    }

    const afterMarker = index + marker.length;
    const rest = text.slice(afterMarker).trimStart();
    const whitespace = text.slice(afterMarker).length - rest.length;
    const jsonStart = afterMarker + whitespace;

    if (rest.startsWith("[")) {
      const extracted = extractFirstBalancedJson(text.slice(jsonStart));
      if (extracted?.json.startsWith("[")) {
        for (const item of parseJsonArrayObjects(extracted.json)) {
          const call = callFromJsonObject(item);
          if (call) {
            candidates.push({
              ...call,
              grammar: "mistral",
              range: { start: index, end: jsonStart + extracted.end },
            });
          }
        }
        index = jsonStart + extracted.end;
        continue;
      }
    }

    const v11 = /^([A-Za-z_][\w.-]*)\[CALL_ID\]([^[]*)\[ARGS\]/.exec(rest);
    if (v11) {
      const name = v11[1];
      const argsStart = jsonStart + v11[0].length;
      const extracted = extractFirstBalancedJson(text.slice(argsStart));
      if (extracted) {
        candidates.push({
          name,
          arguments:
            normalizeArgumentsObject(parseJsonObject(extracted.json)) ?? {},
          grammar: "mistral",
          range: { start: index, end: argsStart + extracted.end },
        });
        index = argsStart + extracted.end;
        continue;
      }
    }

    index += marker.length;
  }

  return candidates;
}

function parseMiniMaxText01(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const re = /<function_call>[\s\S]*?functions\.([A-Za-z_][\w.-]*)\s*\(/gi;

  for (const match of text.matchAll(re)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const name = match[1];
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatching(text, openParen, "(", ")");
    if (closeParen === undefined) continue;
    const rawArgs = text.slice(openParen + 1, closeParen).trim();
    const args = normalizeArgumentsObject(parseJsonObject(rawArgs)) ?? {};
    const fenceEnd = text.indexOf("```", closeParen);
    const end = fenceEnd === -1 ? closeParen + 1 : fenceEnd + 3;
    candidates.push({
      name,
      arguments: args,
      grammar: "minimax-text",
      range: { start: match.index, end },
    });
  }

  return candidates;
}

function parseInvokeXml(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const wrappedRe =
    /<(?:[A-Za-z][\w.-]*:)?tool_call>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?tool_call>/gi;

  for (const wrapper of text.matchAll(wrappedRe)) {
    if (wrapper.index === undefined || isInsideCodeFence(text, wrapper.index))
      continue;
    const calls = parseInvokeBody(wrapper[1] ?? "");
    for (const call of calls) {
      candidates.push({
        ...call,
        grammar: "invoke",
        range: { start: wrapper.index, end: wrapper.index + wrapper[0].length },
      });
    }
  }

  const standaloneRe =
    /<invoke\s+name=["']([^"']+)["']\s*>[\s\S]*?<\/invoke>/gi;
  for (const match of text.matchAll(standaloneRe)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const calls = parseInvokeBody(match[0]);
    for (const call of calls) {
      candidates.push({
        ...call,
        grammar: "invoke",
        range: { start: match.index, end: match.index + match[0].length },
      });
    }
  }

  candidates.push(...parseMalformedMiniMaxInvoke(text));
  return candidates;
}

function parseInvokeBody(
  body: string,
): Array<Omit<Candidate, "range" | "grammar">> {
  const calls: Array<Omit<Candidate, "range" | "grammar">> = [];
  const invokeRe = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/gi;

  for (const match of body.matchAll(invokeRe)) {
    const name = match[1]?.trim();
    if (!name) continue;
    calls.push({ name, arguments: parseInvokeArguments(match[2] ?? "") });
  }

  return calls;
}

function parseInvokeArguments(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const paramRe =
    /<parameter\s+name=["']([^"']+)["'](?:\s+string=["'](true|false)["'])?\s*>([\s\S]*?)<\/parameter>/gi;

  for (const match of body.matchAll(paramRe)) {
    const key = match[1]?.trim();
    if (!key) continue;
    const raw = match[3] ?? "";
    args[key] =
      match[2] === "false"
        ? parseJsonValueOrString(raw.trim())
        : maybeParseJsonValue(raw.trim());
  }

  if (Object.keys(args).length > 0) return args;
  return normalizeArgumentsObject(parseJsonObject(body.trim())) ?? {};
}

function parseMalformedMiniMaxInvoke(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const re =
    /(?:^|\n)(\s*)invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)(?:\n\s*(?:\/invoke|invoke)>|$)/gi;

  for (const match of text.matchAll(re)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    const name = match[2]?.trim();
    if (!name) continue;
    const args: Record<string, unknown> = {};
    const paramRe =
      /parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)\s*parameter>/gi;
    for (const param of (match[3] ?? "").matchAll(paramRe)) {
      const key = param[1]?.trim();
      if (key) args[key] = maybeParseJsonValue((param[2] ?? "").trim());
    }
    candidates.push({
      name,
      arguments: args,
      grammar: "invoke",
      range: { start, end: match.index + match[0].length },
    });
  }

  return candidates;
}

function parseToolCallXml(
  text: string,
  enabled: Set<GrammarName>,
): Candidate[] {
  const candidates: Candidate[] = [];
  const wrapperRe = /<(tool_call|tools)>[\s\S]*?<\/\1>/gi;

  for (const match of text.matchAll(wrapperRe)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const tag = match[1]?.toLowerCase();
    const openTagEnd = match[0].indexOf(">") + 1;
    const body = match[0].slice(
      openTagEnd,
      match[0].length - `</${tag}>`.length,
    );

    if (enabled.has("granite") || enabled.has("qwen")) {
      const jsonGrammar =
        tag === "tools" || !enabled.has("granite") ? "qwen" : "granite";
      const jsonCalls = parseToolCallJsonBody(body, jsonGrammar);
      for (const call of jsonCalls) {
        candidates.push({
          ...call,
          range: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    if (enabled.has("glm")) {
      const glmCall = parseGlmToolCallBody(body);
      if (glmCall)
        candidates.push({
          ...glmCall,
          range: { start: match.index, end: match.index + match[0].length },
        });
    }

    if (enabled.has("qwen")) {
      const qwenCalls = parseQwenFunctionBody(body);
      for (const call of qwenCalls) {
        candidates.push({
          ...call,
          range: { start: match.index, end: match.index + match[0].length },
        });
      }
    }
  }

  if (enabled.has("qwen")) {
    const bareFunctionRe =
      /<function=([A-Za-z_][\w.-]*)>[\s\S]*?<\/function>/gi;
    for (const match of text.matchAll(bareFunctionRe)) {
      if (match.index === undefined || isInsideCodeFence(text, match.index))
        continue;
      const calls = parseQwenFunctionBody(match[0]);
      for (const call of calls) {
        candidates.push({
          ...call,
          range: { start: match.index, end: match.index + match[0].length },
        });
      }
    }
  }

  return candidates;
}

function parseToolCallJsonBody(
  body: string,
  grammar: GrammarName,
): Array<Omit<Candidate, "range">> {
  const calls: Array<Omit<Candidate, "range">> = [];
  const trimmed = unwrapMarkdownFence(body.trim());
  const json = extractFirstBalancedJson(trimmed)?.json ?? trimmed;
  const parsed = parseJsonValue(json);

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (isObject(item)) {
        const call = callFromJsonObject(item);
        if (call) calls.push({ ...call, grammar });
      }
    }
    return calls;
  }

  if (isObject(parsed)) {
    const call = callFromJsonObject(parsed);
    if (call) calls.push({ ...call, grammar });
  }

  return calls;
}

function parseQwenFunctionBody(body: string): Array<Omit<Candidate, "range">> {
  const calls: Array<Omit<Candidate, "range">> = [];
  const functionRe = /<function=([A-Za-z_][\w.-]*)>\s*([\s\S]*?)<\/function>/gi;

  for (const match of body.matchAll(functionRe)) {
    const name = match[1]?.trim();
    if (!name) continue;
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi;
    for (const param of (match[2] ?? "").matchAll(paramRe)) {
      const key = param[1]?.trim();
      if (!key) continue;
      args[key] = maybeParseJsonValue((param[2] ?? "").trim());
    }
    calls.push({ name, arguments: args, grammar: "qwen" });
  }

  return calls;
}

function parseGlmToolCallBody(
  body: string,
): Omit<Candidate, "range"> | undefined {
  const keyRe = /<arg_key>([\s\S]*?)<\/arg_key>/gi;
  const valueRe = /<arg_value>([\s\S]*?)<\/arg_value>/gi;
  const keys = [...body.matchAll(keyRe)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  const values = [...body.matchAll(valueRe)].map((m) => (m[1] ?? "").trim());
  const nameEnd = keys.length === 0 ? body.length : body.search(/<arg_key>/i);
  const name = body.slice(0, nameEnd).trim().split(/\s+/)[0];
  if (!name || !/^[A-Za-z_][\w.-]*$/.test(name)) return undefined;

  const args: Record<string, unknown> = {};
  keys.forEach((key, i) => {
    args[key] = maybeParseJsonValue(values[i] ?? "");
  });
  return { name, arguments: args, grammar: "glm" };
}

function parseLlamaPythonTag(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const marker = "<|python_tag|>";
  let index = 0;

  for (
    index = text.indexOf(marker, index);
    index !== -1;
    index = text.indexOf(marker, index)
  ) {
    if (isInsideCodeFence(text, index)) {
      index += marker.length;
      continue;
    }
    const bodyStart = index + marker.length;
    const rest = text.slice(bodyStart).trimStart();
    const whitespace = text.slice(bodyStart).length - rest.length;
    const payloadStart = bodyStart + whitespace;

    const extracted = extractFirstBalancedJson(text.slice(payloadStart));
    if (extracted) {
      const parsed = parseJsonValue(extracted.json);
      for (const call of callsFromJsonValue(parsed)) {
        candidates.push({
          ...call,
          grammar: "llama",
          range: { start: index, end: payloadStart + extracted.end },
        });
      }
      index = payloadStart + extracted.end;
      continue;
    }

    const lineEnd = findLineEnd(text, payloadStart);
    for (const call of parsePythonicCalls(text.slice(payloadStart, lineEnd))) {
      candidates.push({
        ...call,
        grammar: "llama",
        range: { start: index, end: lineEnd },
      });
    }
    index = lineEnd;
  }

  return candidates;
}

function parseBareJsonToolCalls(
  text: string,
  grammar: GrammarName,
): Candidate[] {
  const candidates: Candidate[] = [];
  const objectRe = /\{\s*"(?:name|function_name|function)"/g;

  for (const match of text.matchAll(objectRe)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const extracted = extractFirstBalancedJson(text.slice(match.index));
    if (!extracted) continue;
    for (const call of callsFromJsonValue(parseJsonValue(extracted.json))) {
      candidates.push({
        ...call,
        grammar,
        range: { start: match.index, end: match.index + extracted.end },
      });
    }
  }

  const arrayRe = /\[\s*\{\s*"(?:name|function_name|function)"/g;
  for (const match of text.matchAll(arrayRe)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const extracted = extractFirstBalancedJson(text.slice(match.index));
    if (!extracted) continue;
    for (const call of callsFromJsonValue(parseJsonValue(extracted.json))) {
      candidates.push({
        ...call,
        grammar,
        range: { start: match.index, end: match.index + extracted.end },
      });
    }
  }

  return candidates;
}

function parseBarePythonicToolCalls(
  text: string,
  grammar: GrammarName,
): Candidate[] {
  const candidates: Candidate[] = [];
  const lineRe = /(?:^|\n)\s*([A-Za-z_][\w.-]*)\s*\(/g;

  for (const match of text.matchAll(lineRe)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    const openParen = match.index + match[0].lastIndexOf("(");
    const closeParen = findMatching(text, openParen, "(", ")");
    if (closeParen === undefined) continue;
    const lineStart = text.lastIndexOf("\n", openParen) + 1;
    if (text.slice(lineStart, match.index).trim() !== "") continue;
    const [call] = parsePythonicCalls(text.slice(start, closeParen + 1));
    if (call)
      candidates.push({
        ...call,
        grammar,
        range: { start, end: closeParen + 1 },
      });
  }

  return candidates;
}

function parseOlmo(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const re = /<function_calls>([\s\S]*?)<\/function_calls>/gi;
  for (const match of text.matchAll(re)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    for (const call of parsePythonicCalls(match[1] ?? "")) {
      candidates.push({
        ...call,
        grammar: "olmo",
        range: { start: match.index, end: match.index + match[0].length },
      });
    }
  }
  return candidates;
}

function parsePythonicCalls(
  text: string,
): Array<Omit<Candidate, "range" | "grammar">> {
  const calls: Array<Omit<Candidate, "range" | "grammar">> = [];
  const re = /(?:^|\n)\s*([A-Za-z_][\w.-]*)\s*\(/g;
  for (const match of text.matchAll(re)) {
    if (match.index === undefined) continue;
    const name = match[1];
    const openParen = match.index + match[0].lastIndexOf("(");
    const closeParen = findMatching(text, openParen, "(", ")");
    if (closeParen === undefined) continue;
    const argsText = text.slice(openParen + 1, closeParen);
    calls.push({ name, arguments: parseKeywordArguments(argsText) });
  }
  return calls;
}

function parseKeywordArguments(text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const part of splitTopLevel(text, ",")) {
    const eq = findTopLevelChar(part, "=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!/^[A-Za-z_][\w.-]*$/.test(key)) continue;
    args[key] = parsePythonishValue(part.slice(eq + 1).trim());
  }
  return args;
}

function parsePythonishValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "True") return true;
  if (trimmed === "False") return false;
  if (trimmed === "None") return null;
  if (/^[-+]?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).replace(/\\(['"\\])/g, "$1");
  }
  return parseJsonValueOrString(
    trimmed
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNone\b/g, "null"),
  );
}

function callsFromJsonValue(
  value: unknown,
): Array<Omit<Candidate, "range" | "grammar">> {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      isObject(item) ? callsFromJsonValue(item) : [],
    );
  }
  if (!isObject(value)) return [];
  const call = callFromJsonObject(value);
  return call ? [call] : [];
}

function callFromJsonObject(
  value: Record<string, unknown>,
): Omit<Candidate, "range" | "grammar"> | undefined {
  const name =
    value.name ??
    value.function_name ??
    (isObject(value.function) ? value.function.name : undefined);
  if (typeof name !== "string" || !name.trim()) return undefined;

  let args: unknown = value.arguments ?? value.args ?? value.parameters;
  if (args === undefined && isObject(value.function))
    args = value.function.arguments;
  const normalized = normalizeArgumentsObject(args) ?? {};
  return { name: name.trim(), arguments: normalized };
}

function normalizeArgumentsObject(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    return normalizeArgumentsObject(parseJsonValue(value));
  }
  if (isObject(value)) {
    const nested = value.arguments;
    if (typeof nested === "string" || isObject(nested)) {
      const unwrapped = normalizeArgumentsObject(nested);
      if (unwrapped) return unwrapped;
    }
    return value;
  }
  return undefined;
}

function parseJsonArrayObjects(json: string): Record<string, unknown>[] {
  const parsed = parseJsonValue(json);
  return Array.isArray(parsed) ? parsed.filter(isObject) : [];
}

function parseJsonObject(json: string): Record<string, unknown> | undefined {
  const parsed = parseJsonValue(json);
  return isObject(parsed) ? parsed : undefined;
}

function parseJsonValue(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function parseJsonValueOrString(value: string): unknown {
  const parsed = parseJsonValue(value);
  return parsed === undefined ? value : parsed;
}

function maybeParseJsonValue(value: string): unknown {
  if (value === "") return "";
  if (/^(?:true|false|null|-?\d|[[{]|")/.test(value)) {
    return parseJsonValueOrString(value);
  }
  return value;
}

function selectCandidates(candidates: Candidate[]): Candidate[] {
  const selected: Candidate[] = [];
  const sorted = [...candidates].sort((a, b) => {
    if (a.range.start !== b.range.start) return a.range.start - b.range.start;
    return b.range.end - b.range.start - (a.range.end - a.range.start);
  });

  for (const candidate of sorted) {
    const duplicate = selected.some((existing) => {
      const sameRange =
        existing.range.start === candidate.range.start &&
        existing.range.end === candidate.range.end;
      return !sameRange && rangesOverlap(existing.range, candidate.range);
    });
    if (!duplicate) selected.push(candidate);
  }

  return selected;
}

function rangesOverlap(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

function isAllowedTool(
  candidateName: string,
  requireKnownTool: boolean,
  knownTools: Set<string>,
): boolean {
  if (!requireKnownTool) return true;
  return knownTools.size > 0 && knownTools.has(candidateName);
}

function removeRanges(text: string, ranges: Range[]): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let result = "";
  let cursor = 0;
  for (const range of sorted) {
    result += text.slice(cursor, range.start);
    cursor = Math.max(cursor, range.end);
  }
  result += text.slice(cursor);
  return result
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getPartText(part: MinimalAssistantContent): string | undefined {
  if (isObject(part) && part.type === "text" && typeof part.text === "string")
    return part.text;
  if (
    isObject(part) &&
    part.type === "thinking" &&
    typeof part.thinking === "string"
  )
    return part.thinking;
  return undefined;
}

function setPartText(
  part: MinimalAssistantContent,
  text: string,
): MinimalAssistantContent {
  if (isObject(part) && part.type === "text") return { ...part, text };
  if (isObject(part) && part.type === "thinking")
    return { ...part, thinking: text };
  return part;
}

function isToolCallContent(
  part: MinimalAssistantContent,
): part is MinimalToolCallContent {
  return (
    isObject(part) && part.type === "toolCall" && typeof part.name === "string"
  );
}

function makeRecoveredToolCallId(grammar: GrammarName, index: number): string {
  return `tool_repair_${grammar.replace(/[^a-z0-9]/gi, "_")}_${Date.now().toString(36)}_${index}`;
}

function findPattern(
  text: string,
  pattern: RegExp,
  from: number,
): Range | undefined {
  pattern.lastIndex = 0;
  const chunk = text.slice(from);
  const match = pattern.exec(chunk);
  return match
    ? { start: from + match.index, end: from + match.index + match[0].length }
    : undefined;
}

function extractFirstBalancedJson(
  text: string,
): { json: string; start: number; end: number } | undefined {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  const opener = text[start];
  const closer = opener === "{" ? "}" : "]";
  const end = findMatching(text, start, opener, closer);
  if (end === undefined) return undefined;
  return { json: text.slice(start, end + 1), start, end: end + 1 };
}

function findMatching(
  text: string,
  openIndex: number,
  opener: string,
  closer: string,
): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === opener) depth++;
    if (ch === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }

  return undefined;
}

function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === delimiter && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function findTopLevelChar(text: string, target: string): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === target && depth === 0) return i;
  }

  return -1;
}

function findLineEnd(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline === -1 ? text.length : newline;
}

function isInsideCodeFence(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const fences = before.match(/```/g);
  return Boolean(fences && fences.length % 2 === 1);
}

function unwrapMarkdownFence(text: string): string {
  const match = /^```\w*\s*([\s\S]*?)\s*```$/.exec(text);
  return match ? (match[1] ?? "") : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
