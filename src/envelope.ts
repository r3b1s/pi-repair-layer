import type { RepairChange, RepairPipelineLimits } from "./types.ts";

export interface EnvelopeLimits {
  maxInputBytes: number;
  maxNestingDepth: number;
  maxDecodeAttempts: number;
  maxCandidates: number;
  maxWorkMs: number;
}

export const DEFAULT_ENVELOPE_LIMITS: EnvelopeLimits = {
  maxInputBytes: 256 * 1024,
  maxNestingDepth: 64,
  maxDecodeAttempts: 3,
  maxCandidates: 4,
  maxWorkMs: 25,
};

export interface EnvelopeRecoveryResult {
  value: unknown;
  changes: RepairChange[];
  candidates: unknown[];
  limited: boolean;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inputBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function nestingDepth(value: unknown, limit: number): number {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let maximum = 0;
  const seen = new Set<object>();
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    maximum = Math.max(maximum, item.depth);
    if (maximum > limit) return maximum;
    if (item.value === null || typeof item.value !== "object") continue;
    if (seen.has(item.value)) return limit + 1;
    seen.add(item.value);
    const children = Array.isArray(item.value)
      ? item.value
      : Object.values(item.value as Record<string, unknown>);
    for (const child of children) {
      stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return maximum;
}

/** Escape only literal JSON control characters that occur inside a string. */
export function escapeJsonStringControlCharacters(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let changed = false;
  for (const character of text) {
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      output += character;
      inString = false;
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20) {
      output += `\\u${code.toString(16).padStart(4, "0")}`;
      changed = true;
    } else {
      output += character;
    }
  }
  return changed ? output : text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function change(ruleId: string, note: string): RepairChange {
  return { ruleId, stage: "envelope", note };
}

const TRUNCATED_SUFFIXES = ["}", '"}', "]}", '"}]}'] as const;

export function recoverEnvelope(
  input: unknown,
  overrides: RepairPipelineLimits = {},
): EnvelopeRecoveryResult {
  const limits = { ...DEFAULT_ENVELOPE_LIMITS, ...overrides };
  const unchanged = (limited = false): EnvelopeRecoveryResult => ({
    value: input,
    changes: [],
    candidates: [],
    limited,
  });
  if (
    inputBytes(input) > limits.maxInputBytes ||
    nestingDepth(input, limits.maxNestingDepth) > limits.maxNestingDepth
  ) {
    return unchanged(true);
  }

  const started = performance.now();
  const changes: RepairChange[] = [];
  let value = structuredClone(input);
  let attempts = 0;

  while (
    typeof value === "string" &&
    attempts < limits.maxDecodeAttempts &&
    performance.now() - started <= limits.maxWorkMs
  ) {
    attempts += 1;
    const escaped = escapeJsonStringControlCharacters(value);
    const parsed = parseJson(escaped);
    if (parsed === undefined) break;
    value = parsed;
    changes.push(
      change(
        "envelope.decode-json",
        "Decoded a JSON-encoded tool-argument envelope. Send the argument object directly next time.",
      ),
    );
    if (escaped !== input && attempts === 1) {
      changes.push(
        change(
          "envelope.escape-control-character",
          "Escaped a raw control character inside the JSON argument envelope.",
        ),
      );
    }
  }

  if (Array.isArray(value) && value.length === 1 && isPlainObject(value[0])) {
    value = value[0];
    changes.push(
      change(
        "envelope.unwrap-singleton-object-array",
        "Unwrapped a singleton object array used as the tool-argument envelope.",
      ),
    );
  }

  if (isPlainObject(value)) {
    if (nestingDepth(value, limits.maxNestingDepth) > limits.maxNestingDepth) {
      return unchanged(true);
    }
    return { value, changes, candidates: [], limited: false };
  }

  const candidates: unknown[] = [];
  if (typeof input === "string" && input.trimStart().startsWith("{")) {
    for (const suffix of TRUNCATED_SUFFIXES) {
      if (candidates.length >= limits.maxCandidates) break;
      if (performance.now() - started > limits.maxWorkMs) break;
      const parsed = parseJson(
        escapeJsonStringControlCharacters(`${input}${suffix}`),
      );
      if (isPlainObject(parsed)) candidates.push(parsed);
    }
  }

  return { value: input, changes: [], candidates, limited: false };
}

export function truncatedEnvelopeChange(): RepairChange {
  return change(
    "envelope.complete-truncated-object",
    "Completed a truncated JSON object envelope after the completed candidate passed the tool schema.",
  );
}
