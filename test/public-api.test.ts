import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import {
  formatRepairNotes,
  repairToolInput,
  runRepairPipeline,
} from "../src/core.ts";
import { parseToolGrammarLeaks } from "../src/grammar.ts";
import { adaptToolDefinition, UnrepairableToolInputError } from "../src/pi.ts";

describe("documented public API", () => {
  test("core and compatibility facade work without a pi session", () => {
    const schema = Type.Object({ path: Type.String() });
    const outcomes: string[] = [];
    expect(
      runRepairPipeline({
        input: '{"path":"/x"}',
        config: {
          toolName: "custom",
          schema,
          onOutcome: (result) => outcomes.push(result.outcome),
        },
      }),
    ).toMatchObject({ outcome: "repaired", args: { path: "/x" } });
    expect(outcomes).toEqual(["repaired"]);
    expect(
      repairToolInput({ toolName: "custom", schema, input: { path: "/x" } })
        .outcome,
    ).toBe("valid");
    expect(formatRepairNotes(["fixed"])).toBe(
      "<repair_note>fixed</repair_note>",
    );
  });

  test("grammar entry point remains pure", () => {
    expect(
      parseToolGrammarLeaks(
        '<tool_call>{"name":"read","arguments":{"path":"/x"}}</tool_call>',
      ),
    ).toHaveLength(1);
  });

  test("tool-owner adapter chains the owner shim and fails closed", () => {
    const outcomes: string[] = [];
    const definition = adaptToolDefinition(
      {
        name: "owned",
        label: "Owned",
        description: "test",
        parameters: Type.Object({ path: Type.String() }),
        prepareArguments(input) {
          if (typeof input === "string") return { path: input };
          return input as { path: string };
        },
        async execute() {
          return {
            content: [{ type: "text", text: "ok" }],
            details: undefined,
          };
        },
      },
      { onOutcome: (result) => outcomes.push(result.outcome) },
    );
    expect(definition.prepareArguments?.("/x")).toEqual({ path: "/x" });
    expect(outcomes).toEqual(["valid"]);
    expect(() => definition.prepareArguments?.(42)).toThrow(
      UnrepairableToolInputError,
    );
  });
});
