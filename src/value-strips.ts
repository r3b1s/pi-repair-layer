/**
 * Model-gated value strips — a pre-pass that runs at the top of the
 * `prepareArguments` override, before the validate-then-repair engine.
 *
 * Adapted from monotykamary/pi-tool-repair (MIT): its `stripAnchorBleedInPlace`
 * and `stripGrammarTokenLeaksInPlace`. Two differences from upstream:
 *  - Anchor stripping skips regex-typed fields (the `grep.pattern` field), where
 *    a leading `^` / trailing `$` may be intended regex syntax and is
 *    indistinguishable from a bled anchor — so we never guess there.
 *  - Strips are surfaced through this extension's repair-note / telemetry
 *    machinery (a distinct rule id per strip) rather than debug stderr.
 *
 * Why a pre-pass and not an engine rule: the engine's rules fire on
 * schema-invalid input, but an anchor-bled string still validates as a string.
 * Strips transform input that is valid both before and after, so they run
 * ahead of the engine on their own trigger (a model gate), not on a validation
 * failure. See design decision D1.
 */

/** Model families that bleed regex anchors into generated values. */
export const ANCHOR_BLEED_MODELS: readonly RegExp[] = [
  /kimi-k2/i,
  /minimax/i,
  /glm/i,
];

/** Model families that leak GLM-style grammar tokens into keys/values. */
export const GRAMMAR_LEAK_MODELS: readonly RegExp[] = [/glm/i];

/**
 * Regex-typed fields exempt from anchor stripping, keyed by tool. `grep.pattern`
 * is the only true regex field among the built-ins (`find.pattern` is a glob,
 * where anchors are never syntax, so it is *not* exempt). See D2 and
 * docs/research.md Claim 8.
 */
export const ANCHOR_STRIP_SKIP: Record<string, ReadonlySet<string>> = {
  grep: new Set(["pattern"]),
};

export const STRIP_ANCHOR_RULE = "stripAnchorBleed";
export const STRIP_GRAMMAR_RULE = "stripGrammarTokenLeak";

// Leaked grammar markers from GLM/ChatGLM-style tool-call grammars: they can
// land as literal prefixes/suffixes on parsed object keys or string values
// instead of being interpreted as XML tags.
const GRAMMAR_TOKEN_LEAKS = [
  { tag: "<arg_key>", at: "start" as const },
  { tag: "</arg_key>", at: "end" as const },
  { tag: "<arg_value>", at: "start" as const },
  { tag: "</arg_value>", at: "end" as const },
];

export interface ValueStripResult {
  changed: boolean;
  /** Distinct rule identifier per strip that fired. */
  rules: string[];
  /** Model-facing notes for the repair-note channel. */
  notes: string[];
}

function isContainer(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

function modelMatches(
  modelId: string | undefined,
  families: readonly RegExp[],
): boolean {
  if (!modelId) return false;
  return families.some((re) => re.test(modelId));
}

function stripAnchorsFromString(value: string): string {
  let s = value;
  while (s.startsWith("^")) s = s.slice(1);
  while (s.endsWith("$")) s = s.slice(0, -1);
  return s;
}

/**
 * Recursively strip leading `^` / trailing `$` from string values. `skipKeys`
 * exempts regex-typed fields, and only applies at the top level (nested
 * built-in fields are never regex).
 */
function stripAnchorBleed(
  node: Record<string, unknown> | unknown[],
  skipKeys: ReadonlySet<string> | undefined,
): boolean {
  let changed = false;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i];
      if (typeof item === "string") {
        const stripped = stripAnchorsFromString(item);
        if (stripped !== item) {
          node[i] = stripped;
          changed = true;
        }
      } else if (isContainer(item)) {
        if (stripAnchorBleed(item, undefined)) changed = true;
      }
    }
    return changed;
  }
  for (const key of Object.keys(node)) {
    if (skipKeys?.has(key)) continue;
    const value = node[key];
    if (typeof value === "string") {
      const stripped = stripAnchorsFromString(value);
      if (stripped !== value) {
        node[key] = stripped;
        changed = true;
      }
    } else if (isContainer(value)) {
      if (stripAnchorBleed(value, undefined)) changed = true;
    }
  }
  return changed;
}

function stripGrammarTokensFromString(value: string): string {
  let s = value;
  for (const { tag, at } of GRAMMAR_TOKEN_LEAKS) {
    if (at === "start" && s.startsWith(tag)) s = s.slice(tag.length);
    else if (at === "end" && s.endsWith(tag)) s = s.slice(0, -tag.length);
  }
  return s.trim();
}

/** Recursively strip grammar-token leaks from object keys and string values. */
function stripGrammarTokenLeaks(
  node: Record<string, unknown> | unknown[],
): boolean {
  let changed = false;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i];
      if (typeof item === "string") {
        const stripped = stripGrammarTokensFromString(item);
        if (stripped !== item) {
          node[i] = stripped;
          changed = true;
        }
      } else if (isContainer(item)) {
        if (stripGrammarTokenLeaks(item)) changed = true;
      }
    }
    return changed;
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    const newKey = stripGrammarTokensFromString(key);
    if (newKey !== key) {
      delete node[key];
      node[newKey] = value;
      changed = true;
    }
    const target = newKey;
    const current = node[target];
    if (typeof current === "string") {
      const stripped = stripGrammarTokensFromString(current);
      if (stripped !== current) {
        node[target] = stripped;
        changed = true;
      }
    } else if (isContainer(current)) {
      if (stripGrammarTokenLeaks(current)) changed = true;
    }
  }
  return changed;
}

/**
 * Run the model-gated strips over a clone of `input`. Returns the (possibly
 * modified) clone plus a result describing what fired. When nothing fires,
 * `result.changed` is false and the original `input` reference is returned.
 */
export function stripValues(options: {
  toolName: string;
  input: unknown;
  modelId: string | undefined;
}): { input: unknown; result: ValueStripResult } {
  const { toolName, input, modelId } = options;
  const result: ValueStripResult = { changed: false, rules: [], notes: [] };

  if (!isContainer(input)) return { input, result };

  const doAnchor = modelMatches(modelId, ANCHOR_BLEED_MODELS);
  const doGrammar = modelMatches(modelId, GRAMMAR_LEAK_MODELS);
  if (!doAnchor && !doGrammar) return { input, result };

  const clone = structuredClone(input);

  // Grammar tokens first: they wrap the real value, and removing them can expose
  // a bled anchor underneath for the anchor pass to clean.
  if (doGrammar && stripGrammarTokenLeaks(clone)) {
    result.changed = true;
    result.rules.push(STRIP_GRAMMAR_RULE);
    result.notes.push(
      `Removed leaked grammar tokens (\`<arg_key>\`/\`<arg_value>\`) from keys/values for tool "${toolName}". These are grammar markers, not part of your field names or values — send plain keys and values next time.`,
    );
  }

  if (doAnchor) {
    const skip = Array.isArray(clone) ? undefined : ANCHOR_STRIP_SKIP[toolName];
    if (stripAnchorBleed(clone, skip)) {
      result.changed = true;
      result.rules.push(STRIP_ANCHOR_RULE);
      result.notes.push(
        `Stripped leaked regex anchors (\`^\` / \`$\`) from string value(s) for tool "${toolName}". These anchors bled in from the tool-call grammar and were not part of your intended value.`,
      );
    }
  }

  return { input: result.changed ? clone : input, result };
}
