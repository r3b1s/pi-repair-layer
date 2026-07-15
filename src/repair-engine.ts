/**
 * Validate-then-repair engine for LLM tool-call inputs.
 *
 * Design (matching the publicly described behavior of commandcode's repair layer):
 *
 * - Strictly valid inputs are never touched: the fast path is a plain
 *   `Value.Check` and returns the original input by reference.
 * - On failure, the validator's own issue list localizes the damage. Repairs are
 *   attempted only at the exact paths the schema disagreed with, in a fixed
 *   order (JSON-array parsing must run before bare-string wrapping, or
 *   `'["a","b"]'` becomes `['["a","b"]']`).
 * - Every mutation produces a model-facing note so the model can learn the real
 *   contract on the next turn. Transparency over silent magic.
 *
 * The strict check deliberately runs BEFORE TypeBox's `Value.Convert` (which pi
 * applies during validation), because Convert silently corrupts exactly the
 * inputs this layer exists to fix: `'["a","b"]'` for an array field becomes
 * `['["a","b"]']`, `null` for an optional string becomes the string `"null"`,
 * and `null` for an optional number becomes `0` — all of which then pass
 * validation and execute with garbage. Repairing at the strict-error sites
 * first means those inputs are fixed properly (with a note) instead. Benign
 * coercions ("5" -> 5) are left to Convert: if no repair rule fires and Convert
 * alone makes the input valid, the input is reported as valid and returned
 * untouched, so pi's native behavior is preserved.
 *
 * The one deliberate exception to validate-then-repair is markdown auto-link
 * unwrapping on path fields: `[notes.md](http://notes.md)` is a perfectly valid
 * string, so validation can never flag it. It is unwrapped unconditionally, but
 * only in the degenerate case where the link text equals the url without its
 * protocol — real markdown links pass through untouched.
 */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

export interface StructuralRepair {
  /** Rule name recorded in telemetry when the repair fires. */
  name: string;
  /** Mutate `args` in place. Return a model-facing note when a repair was applied, false otherwise. */
  apply(args: Record<string, unknown>, toolName: string): string | false;
}

export interface ToolRepairConfig {
  /** canonical field name -> wrong names models emit for it, matched at any depth by key. */
  fieldAliases?: Record<string, readonly string[]>;
  /** When the whole input is a bare string, wrap it as `{ [field]: value }`. */
  rootString?: { field: string; wrapInArray?: boolean };
  /** Top-level string fields holding filesystem paths (markdown auto-link unwrapping). */
  pathFields?: readonly string[];
  /** Tool-specific shape folds that single-field rules cannot express. */
  structural?: readonly StructuralRepair[];
}

export interface RepairResult {
  outcome: "valid" | "repaired" | "unrepairable";
  /** What prepareArguments should return: the untouched input, the repaired input, or (unrepairable) the untouched input. */
  args: unknown;
  rulesFired: string[];
  notes: string[];
  /** Compact description of the original validation failure, for telemetry. */
  issueSummary: string | undefined;
  /** Stable hash of (tool, failure shape), for spotting per-model regressions. */
  fingerprint: string | undefined;
  /**
   * Model-readable error for unrepairable input. Throwing this from
   * prepareArguments matters: handing the raw input back to pi instead would
   * let Value.Convert corrupt it (null -> "null") and execute the call anyway.
   */
  retryMessage: string | undefined;
}

const MAX_ISSUES = 32;

// ---------------------------------------------------------------------------
// Markdown auto-link unwrapping
// ---------------------------------------------------------------------------

const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const PROTOCOL = /^https?:\/\//;

export function unwrapMarkdownAutoLinks(value: string): string {
  return value.replace(MARKDOWN_LINK, (match, text: string, url: string) =>
    url.replace(PROTOCOL, "") === text ? text : match,
  );
}

// ---------------------------------------------------------------------------
// Issue collection (TypeBox emits AJV-style errors)
// ---------------------------------------------------------------------------

interface RawIssue {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown> | undefined;
  message: string | undefined;
}

interface IssueSite {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  keyword: string;
  /** JSON-schema type name the schema expected at this site, when known. */
  expected: string | undefined;
}

function collectErrors(schema: TSchema, value: unknown): RawIssue[] {
  const out: RawIssue[] = [];
  for (const error of Value.Errors(schema, value)) {
    out.push({
      keyword: String((error as { keyword?: string }).keyword ?? ""),
      instancePath: String(
        (error as { instancePath?: string }).instancePath ?? "",
      ),
      params: (error as { params?: Record<string, unknown> }).params,
      message: (error as { message?: string }).message,
    });
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

function parsePointer(pointer: string): (string | number)[] {
  if (pointer === "" || pointer === "/") return [];
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => {
      const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
    });
}

function resolveAt(root: unknown, segments: (string | number)[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isContainer(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

/** Value.Check without its type predicate — the predicate narrows `unknown` to `never` on the false branch. */
function schemaAccepts(schema: TSchema, value: unknown): boolean {
  return Value.Check(schema, value);
}

function collectIssueSites(schema: TSchema, value: unknown): IssueSite[] {
  const sites: IssueSite[] = [];
  const seen = new Set<string>();
  const push = (site: IssueSite, pointerKey: string) => {
    if (seen.has(pointerKey)) return;
    seen.add(pointerKey);
    sites.push(site);
  };
  for (const issue of collectErrors(schema, value)) {
    if (issue.keyword === "required") {
      const container = resolveAt(value, parsePointer(issue.instancePath));
      if (!isPlainObject(container)) continue;
      const missing = issue.params?.requiredProperties;
      if (!Array.isArray(missing)) continue;
      for (const key of missing) {
        if (typeof key !== "string") continue;
        push(
          {
            parent: container,
            key,
            keyword: issue.keyword,
            expected: undefined,
          },
          `${issue.instancePath}::${key}`,
        );
      }
      continue;
    }
    const segments = parsePointer(issue.instancePath);
    if (segments.length === 0) continue; // root-level issues are handled by root repairs
    const parent = resolveAt(value, segments.slice(0, -1));
    if (!isContainer(parent)) continue;
    const key = segments[segments.length - 1];
    const expected =
      typeof issue.params?.type === "string" ? issue.params.type : undefined;
    push(
      { parent, key, keyword: issue.keyword, expected },
      `${issue.instancePath}`,
    );
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Per-issue repair rules, in application order
// ---------------------------------------------------------------------------

type IssueRule = (
  site: IssueSite,
  toolName: string,
  config: ToolRepairConfig,
) => string | false;

const renameAliasedField: IssueRule = (site, toolName, config) => {
  const { parent, key } = site;
  if (typeof key !== "string" || !isPlainObject(parent)) return false;
  // A null target does not block the rename: `{path: null, file_path: "/x"}`
  // should recover from the alias, and dropNullOrUndefinedField runs later.
  if (key in parent && parent[key] !== undefined && parent[key] !== null)
    return false;
  const aliases = config.fieldAliases?.[key];
  if (!aliases) return false;
  for (const alias of aliases) {
    if (!(alias in parent)) continue;
    const value = parent[alias];
    if (value == null) continue;
    if (value === "") continue;
    parent[key] = value;
    delete parent[alias];
    return `Renamed \`${alias}\` to \`${key}\` for tool "${toolName}". Use \`${key}\` next time — \`${alias}\` is not a valid field for this tool.`;
  }
  return false;
};

const dropNullOrUndefinedField: IssueRule = (site, toolName) => {
  const { parent, key } = site;
  if (typeof key !== "string" || !isPlainObject(parent)) return false;
  if (!(key in parent)) return false;
  const value = parent[key];
  if (value !== null && value !== undefined) return false;
  delete parent[key];
  const kind = value === null ? "null" : "undefined";
  return `Dropped ${kind} \`${key}\` from tool "${toolName}". Optional fields can be omitted entirely rather than sent as ${kind}.`;
};

const dropEmptyObjectPlaceholder: IssueRule = (site, toolName) => {
  const { parent, key, expected } = site;
  if (expected !== "array" || !isPlainObject(parent) || typeof key !== "string")
    return false;
  const value = parent[key];
  if (!isPlainObject(value) || Object.keys(value).length > 0) return false;
  delete parent[key];
  return `Dropped empty \`{}\` placeholder from \`${key}\` for tool "${toolName}". Send an actual array (or omit the field) next time.`;
};

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const parseJsonStringifiedArray: IssueRule = (site, toolName) => {
  const { parent, key, expected } = site;
  if (expected !== "array") return false;
  const value = (parent as Record<string | number, unknown>)[key];
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
  const parsed = tryParseJson(trimmed);
  if (!Array.isArray(parsed)) return false;
  (parent as Record<string | number, unknown>)[key] = parsed;
  return `Parsed JSON-stringified array for \`${String(key)}\` in tool "${toolName}". Send the array literal directly (e.g. \`["a","b"]\`) next time, not a string.`;
};

const parseJsonStringifiedObject: IssueRule = (site, toolName) => {
  const { parent, key, expected } = site;
  if (expected !== "object") return false;
  const value = (parent as Record<string | number, unknown>)[key];
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  const parsed = tryParseJson(trimmed);
  if (!isPlainObject(parsed)) return false;
  (parent as Record<string | number, unknown>)[key] = parsed;
  return `Parsed JSON-stringified object for \`${String(key)}\` in tool "${toolName}". Send the object literal directly next time, not a string.`;
};

const wrapBareStringAsArray: IssueRule = (site, toolName) => {
  const { parent, key, expected } = site;
  if (expected !== "array") return false;
  const value = (parent as Record<string | number, unknown>)[key];
  if (typeof value !== "string") return false;
  (parent as Record<string | number, unknown>)[key] = [value];
  return `Wrapped your bare string in a single-element array for \`${String(key)}\` in tool "${toolName}". Send an array (e.g. \`["foo"]\`) next time, not a single string.`;
};

/**
 * Stage 5 re-collects issue sites after each pass that fired a rule, so
 * repairs that reveal nested problems (parse a stringified array, then rename
 * aliased fields inside it) converge instead of failing. Three passes cover
 * every known two-step combination with one pass of headroom.
 */
const MAX_ISSUE_PASSES = 3;

// Order matters: parse before wrap, rename before drop.
const ISSUE_RULES: readonly [string, IssueRule][] = [
  ["renameAliasedField", renameAliasedField],
  ["dropNullOrUndefinedField", dropNullOrUndefinedField],
  ["dropEmptyObjectPlaceholder", dropEmptyObjectPlaceholder],
  ["parseJsonStringifiedArray", parseJsonStringifiedArray],
  ["parseJsonStringifiedObject", parseJsonStringifiedObject],
  ["wrapBareStringAsArray", wrapBareStringAsArray],
];

// ---------------------------------------------------------------------------
// Fingerprinting (FNV-1a) for local telemetry
// ---------------------------------------------------------------------------

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function describeIssue(issue: RawIssue): string {
  const path = issue.instancePath === "" ? "(root)" : issue.instancePath;
  const detail =
    typeof issue.params?.type === "string"
      ? issue.params.type
      : Array.isArray(issue.params?.requiredProperties)
        ? issue.params.requiredProperties.join(",")
        : "";
  return `${path}|${issue.keyword}|${detail}`;
}

function formatRetryMessage(
  toolName: string,
  issues: RawIssue[],
  input: unknown,
): string {
  const lines = issues
    .slice(0, 8)
    .map(
      (issue) =>
        `  • ${issue.instancePath === "" ? "(root)" : issue.instancePath}: ${issue.message ?? issue.keyword}`,
    );
  let received: string;
  try {
    received = JSON.stringify(input) ?? String(input);
  } catch {
    received = String(input);
  }
  if (received.length > 300) received = `${received.slice(0, 300)}…`;
  return `Invalid input for tool "${toolName}". Fix these issues and retry:\n${lines.join("\n")}\nReceived: ${received}`;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export function repairToolInput(options: {
  toolName: string;
  schema: TSchema;
  input: unknown;
  config?: ToolRepairConfig;
}): RepairResult {
  const { toolName, schema, input } = options;
  const config = options.config ?? {};
  const rulesFired: string[] = [];
  const notes: string[] = [];
  const fire = (rule: string, note: string) => {
    if (!rulesFired.includes(rule)) rulesFired.push(rule);
    notes.push(note);
  };

  const unwrapPathFields = (target: Record<string, unknown>) => {
    for (const field of config.pathFields ?? []) {
      const value = target[field];
      if (typeof value !== "string") continue;
      const unwrapped = unwrapMarkdownAutoLinks(value);
      if (unwrapped === value) continue;
      target[field] = unwrapped;
      fire(
        "unwrapMarkdownAutoLink",
        `Unwrapped a markdown auto-link in \`${field}\` for tool "${toolName}" (\`${value}\` -> \`${unwrapped}\`). Send plain paths, not markdown links.`,
      );
    }
  };

  // Stage 1: unconditional path-field cleanup on a clone. Auto-linked paths are
  // valid strings, so validation alone can never catch them.
  let current: unknown = structuredClone(input);
  if (isPlainObject(current)) unwrapPathFields(current);

  // Stage 2: strict fast path. No Convert here — see the header comment.
  if (schemaAccepts(schema, current)) {
    if (rulesFired.length === 0) {
      return {
        outcome: "valid",
        args: input,
        rulesFired,
        notes,
        issueSummary: undefined,
        fingerprint: undefined,
        retryMessage: undefined,
      };
    }
    return {
      outcome: "repaired",
      args: current,
      rulesFired,
      notes,
      issueSummary: undefined,
      fingerprint: undefined,
      retryMessage: undefined,
    };
  }

  // Record the original failure shape before repairs mutate it.
  const originalIssues = collectErrors(schema, current);
  const issueSummary = originalIssues.map(describeIssue).join("; ");
  const fingerprint = fnv1a(
    `${toolName}::${originalIssues.map(describeIssue).sort().join(";")}`,
  );
  const unrepairable = (): RepairResult => ({
    outcome: "unrepairable",
    args: input,
    rulesFired: [],
    notes: [],
    issueSummary,
    fingerprint,
    retryMessage: formatRetryMessage(toolName, originalIssues, input),
  });

  // Stage 3: root repairs — the model sent something other than an object.
  if (typeof current === "string") {
    const trimmed = current.trim();
    const parsed =
      trimmed.startsWith("{") && trimmed.endsWith("}")
        ? tryParseJson(trimmed)
        : undefined;
    if (isPlainObject(parsed)) {
      current = parsed;
      fire(
        "parseJsonStringifiedRootObject",
        `Parsed your JSON-stringified arguments for tool "${toolName}". Send the arguments as a JSON object next time, not a string.`,
      );
    } else if (config.rootString) {
      const { field, wrapInArray } = config.rootString;
      current = { [field]: wrapInArray ? [current] : current };
      fire(
        "wrapRootStringAsObject",
        `Wrapped your bare string as \`{${field}: ${wrapInArray ? '["..."]' : '"..."'}}\` for tool "${toolName}". Call this tool with an object, not a bare string, next time.`,
      );
    }
    if (isPlainObject(current)) unwrapPathFields(current);
  }
  if (!isPlainObject(current)) return unrepairable();

  // Stage 4: tool-specific structural repairs.
  for (const structural of config.structural ?? []) {
    const note = structural.apply(current, toolName);
    if (note !== false) fire(structural.name, note);
  }

  // Stage 5: per-issue repairs at the strict validator's failure sites.
  // Iterates because one repair can expose sites the first collection couldn't
  // see — e.g. parsing a stringified `edits` array surfaces aliased fields
  // inside the parsed elements. Stops when the value validates or a full pass
  // fires nothing (each firing rule mutates `current`, so a firing pass always
  // makes progress); the cap only bounds pathological rule interactions.
  for (
    let pass = 0;
    pass < MAX_ISSUE_PASSES && !schemaAccepts(schema, current);
    pass++
  ) {
    let repairedThisPass = false;
    for (const site of collectIssueSites(schema, current)) {
      for (const [name, rule] of ISSUE_RULES) {
        const note = rule(site, toolName, config);
        if (note !== false) {
          fire(name, note);
          repairedThisPass = true;
          break;
        }
      }
    }
    if (!repairedThisPass) break;
  }

  // Stage 6: final verdict, now through pi's own pipeline (Convert, then
  // Check) so benign coercions like "5" -> 5 are accounted for.
  const probe = Value.Convert(schema, structuredClone(current));
  if (schemaAccepts(schema, probe)) {
    if (rulesFired.length === 0) {
      // Convert alone fixes it — defer to pi's native coercion, untouched.
      return {
        outcome: "valid",
        args: input,
        rulesFired,
        notes,
        issueSummary: undefined,
        fingerprint: undefined,
        retryMessage: undefined,
      };
    }
    return {
      outcome: "repaired",
      args: probe,
      rulesFired,
      notes,
      issueSummary,
      fingerprint,
      retryMessage: undefined,
    };
  }
  return unrepairable();
}
