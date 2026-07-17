import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { recoverEnvelope } from "../src/envelope.ts";
import { runRepairPipeline } from "../src/pipeline.ts";

const DEFAULT_SEED = 0x5eedc0de;
const seed = Number(process.env.PI_REPAIR_FUZZ_SEED ?? DEFAULT_SEED) >>> 0;
const cases = Number(process.env.PI_REPAIR_FUZZ_CASES ?? 300);

function random(seedValue: number): () => number {
  let state = seedValue;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function generateJson(next: () => number, depth = 0): unknown {
  const choice = Math.floor(next() * (depth >= 4 ? 5 : 9));
  if (choice === 0) return null;
  if (choice === 1) return next() < 0.5;
  if (choice === 2) return Math.floor(next() * 10_000) - 5_000;
  if (choice === 3)
    return ["", "text", "{", '["x"', "\u0000", "__proto__"][
      Math.floor(next() * 6)
    ];
  if (choice === 4) return `value-${Math.floor(next() * 1000)}`;
  if (choice === 5) {
    return Array.from({ length: Math.floor(next() * 4) }, () =>
      generateJson(next, depth + 1),
    );
  }
  const record = Object.create(null) as Record<string, unknown>;
  const keys = ["path", "content", "nested", "__proto__", "constructor"];
  const count = Math.floor(next() * 4);
  for (let index = 0; index < count; index += 1) {
    record[keys[Math.floor(next() * keys.length)] ?? `key-${index}`] =
      generateJson(next, depth + 1);
  }
  if (choice === 7) return JSON.stringify(record);
  if (choice === 8) return `${JSON.stringify(record).slice(0, -1)}`;
  return record;
}

const regressions: Array<{ name: string; input: unknown }> = [
  {
    name: "prototype-looking decoded object",
    input: '{"path":"/x","__proto__":{"polluted":true}}',
  },
  { name: "non-singleton array", input: [{ path: "/x" }, { path: "/y" }] },
  { name: "unterminated control string", input: '{"path":"a\nb"' },
  {
    name: "decoded coercible field returns final converted value",
    input: '{"path":4164}',
  },
];

const schema = Type.Object({ path: Type.String() });

function assertInvariants(input: unknown): void {
  const before = structuredClone(input);
  const first = recoverEnvelope(input);
  const second = recoverEnvelope(input);
  expect(first).toEqual(second);
  expect(input).toEqual(before);

  const pipeline = runRepairPipeline({
    input,
    config: {
      toolName: "fuzz",
      schema,
      limits: {
        maxInputBytes: 32 * 1024,
        maxNestingDepth: 16,
        maxDecodeAttempts: 3,
        maxCandidates: 4,
        maxWorkMs: 25,
      },
    },
  });
  expect(input).toEqual(before);
  if (pipeline.outcome === "repaired") {
    expect(Value.Check(schema, pipeline.args)).toBe(true);
    expect(pipeline.changes.length).toBeGreaterThan(0);
    for (const change of pipeline.changes) {
      expect(change.ruleId).not.toBe("");
      expect(change.note).not.toBe("");
    }
  }
  if (pipeline.outcome === "unrepairable") {
    expect(pipeline.args).toBe(input);
  }
}

function shrinkCandidates(input: unknown): unknown[] {
  if (typeof input === "string") {
    const candidates: unknown[] = ["", input.slice(0, input.length / 2)];
    try {
      candidates.push(JSON.parse(input));
    } catch {
      // Malformed strings still have the direct string shrinks above.
    }
    return candidates;
  }
  if (Array.isArray(input)) {
    return [[], ...input.map((item) => [item])];
  }
  if (input !== null && typeof input === "object") {
    return [
      {},
      ...Object.entries(input as Record<string, unknown>).map(
        ([key, value]) => ({
          [key]: value,
        }),
      ),
    ];
  }
  return [null, false, 0];
}

function minimizeFailure(input: unknown): unknown {
  let current = input;
  let size = JSON.stringify(current)?.length ?? Number.POSITIVE_INFINITY;
  for (let pass = 0; pass < 32; pass += 1) {
    const smaller = shrinkCandidates(current).find((candidate) => {
      const candidateSize = JSON.stringify(candidate)?.length ?? size;
      if (candidateSize >= size) return false;
      try {
        assertInvariants(candidate);
        return false;
      } catch {
        return true;
      }
    });
    if (smaller === undefined) break;
    current = smaller;
    size = JSON.stringify(current)?.length ?? size;
  }
  return current;
}

describe("seeded envelope fuzz invariants", () => {
  test(`seed ${seed} across ${cases} cases`, () => {
    const next = random(seed);
    const inputs = [
      ...regressions.map((regression) => regression.input),
      ...Array.from({ length: cases }, () => generateJson(next)),
    ];
    for (const [index, input] of inputs.entries()) {
      try {
        assertInvariants(input);
      } catch (error) {
        const minimized = minimizeFailure(input);
        throw new Error(
          `Fuzz failure: seed=${seed} case=${index} replay="PI_REPAIR_FUZZ_SEED=${seed} PI_REPAIR_FUZZ_CASES=${cases} pnpm run test:fuzz" minimized=${JSON.stringify(minimized)} input=${JSON.stringify(input)}`,
          { cause: error },
        );
      }
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
