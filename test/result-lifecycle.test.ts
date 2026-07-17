import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import toolRepairExtension from "../src/index.ts";

type Handler = (event: any, context: any) => Promise<any>;
const handlers = new Map<string, Handler>();
const tools = new Map<string, unknown>();
const directory = mkdtempSync(join(tmpdir(), "repair-lifecycle-"));
const settings = join(directory, "settings.json");
writeFileSync(
  settings,
  JSON.stringify({ policyProfile: "recover", grammarRecovery: "recover" }),
);
process.env.PI_TOOL_REPAIR_SETTINGS = settings;
process.env.PI_TOOL_REPAIR_TELEMETRY = "off";

const fakePi = {
  registerTool: (definition: { name: string }) =>
    tools.set(definition.name, definition),
  registerCommand: () => {},
  appendEntry: () => {},
  getActiveTools: () => ["cooperating_custom"],
  on: (event: string, handler: Handler) => handlers.set(event, handler),
} as any;

beforeAll(async () => {
  toolRepairExtension(fakePi);
  await handlers.get("session_start")?.(
    {},
    {
      cwd: directory,
      model: { id: "glm-4.6" },
      sessionManager: { getEntries: () => [] },
    },
  );
});

describe("global result lifecycle", () => {
  test("grammar-recovered custom tool receives one note on an error result", async () => {
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: `<tool_call>cooperating_custom\n<arg_key>path</arg_key>\n<arg_value>/x</arg_value>\n</tool_call>`,
        },
      ],
    };
    const replacement = await handlers.get("message_end")?.({ message }, {});
    const call = replacement.message.content.find(
      (item: { type?: string }) => item.type === "toolCall",
    );
    expect(call.name).toBe("cooperating_custom");

    const event = {
      type: "tool_result",
      toolName: call.name,
      toolCallId: call.id,
      input: call.arguments,
      content: [{ type: "text", text: "custom failed" }],
      details: { code: "E_CUSTOM" },
      isError: true,
    };
    const first = await handlers.get("tool_result")?.(event, {});
    expect(first.content[0].text).toContain("<repair_note>");
    expect(first.content[0].text).toContain("cooperating_custom");
    expect(event.details).toEqual({ code: "E_CUSTOM" });
    expect(event.isError).toBe(true);

    const second = await handlers.get("tool_result")?.(
      { ...event, content: first.content },
      {},
    );
    expect(second).toBeUndefined();
    expect(first.content[0].text.match(/<repair_note>/g)).toHaveLength(1);
  });

  test("session shutdown clears lifecycle state", async () => {
    await expect(
      handlers.get("session_shutdown")?.({}, {}),
    ).resolves.toBeUndefined();
  });
});
