/**
 * Chaos provider — a scripted fake model that deterministically exercises the
 * repair layer through pi's REAL agent loop (streaming, preflight, validation,
 * execution, TUI, session persistence). No network, no tokens.
 *
 * Turn 1 emits a batch of malformed tool calls covering every reachable repair
 * rule (plus one unrepairable call to demonstrate the retry error). Turn 2
 * reads the tool results back out of the conversation and prints a
 * deterministic report of the <repair_note> lines and errors it observed —
 * i.e. exactly what a real model would have seen.
 *
 * Run via: test/run-chaos.sh
 * Or manually, from a directory containing the fixtures (see run-chaos.sh):
 *   pi -e <repo>/test/chaos-provider.ts --provider chaos --model repair-chaos -p go
 */

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Malformed on purpose — each entry names the rules it should trigger. */
const CHAOS_CALLS: {
  id: string;
  name: string;
  arguments: unknown;
  expect: string;
}[] = [
  {
    id: "chaos-read-alias",
    name: "read",
    arguments: { file_path: "fixture-a.txt" },
    expect: "renameAliasedField",
  },
  {
    id: "chaos-read-autolink",
    name: "read",
    arguments: { path: "[fixture-a.txt](http://fixture-a.txt)" },
    expect: "unwrapMarkdownAutoLink",
  },
  {
    id: "chaos-bash-root-string",
    name: "bash",
    arguments: "echo chaos-bare-root-string",
    expect: "wrapRootStringAsObject",
  },
  {
    id: "chaos-bash-root-json",
    name: "bash",
    arguments: '{"command":"echo chaos-json-root"}',
    expect: "parseJsonStringifiedRootObject",
  },
  {
    id: "chaos-edit-flat",
    name: "edit",
    arguments: {
      file_path: "fixture-b.txt",
      old_string: "alpha",
      new_string: "omega",
    },
    expect: "renameAliasedField + foldFlatEditFields",
  },
  {
    id: "chaos-edit-nested",
    name: "edit",
    arguments: {
      path: "fixture-c.txt",
      edits: [{ old_string: "gamma", new_string: "theta" }],
    },
    expect: "renameAliasedField (nested in edits[0])",
  },
  {
    id: "chaos-edit-stringified-snake",
    name: "edit",
    arguments: {
      path: "fixture-d.txt",
      edits: '[{"old_text":"delta","new_text":"kappa"}]',
    },
    // pi's own edit shim (prepareEditArguments) parses the stringified array
    // before our engine runs, so end-to-end this repairs via renameAliasedField
    // alone. The engine's iterative parse+rename path for the same shape is
    // covered by unit tests; this scenario pins the full-pipeline outcome.
    expect: "renameAliasedField x2 (pi shim pre-parses the stringified array)",
  },
  {
    id: "chaos-grep-alias-null",
    name: "grep",
    arguments: { query: "alpha", path: ".", glob: null },
    expect: "renameAliasedField + dropNullOrUndefinedField",
  },
  {
    id: "chaos-write-unrepairable",
    name: "write",
    arguments: { path: "chaos-out.txt", content: null },
    expect:
      "unrepairable -> retry error (content null has no alias to recover from)",
  },
];

function baseMessage(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function chaosStream(
  model: Model<any>,
  context: Context,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output = baseMessage(model);
    stream.push({ type: "start", partial: output });

    const pushText = (text: string) => {
      output.content.push({ type: "text", text: "" });
      const contentIndex = output.content.length - 1;
      stream.push({ type: "text_start", contentIndex, partial: output });
      const block = output.content[contentIndex] as {
        type: "text";
        text: string;
      };
      block.text = text;
      stream.push({
        type: "text_delta",
        contentIndex,
        delta: text,
        partial: output,
      });
      stream.push({
        type: "text_end",
        contentIndex,
        content: text,
        partial: output,
      });
    };

    const assistantTurns = context.messages.filter(
      (message) => message.role === "assistant",
    ).length;

    if (assistantTurns === 0) {
      pushText(
        `Chaos turn: emitting ${CHAOS_CALLS.length} deliberately malformed tool calls:\n${CHAOS_CALLS.map(
          (call) => `- ${call.id} (${call.expect})`,
        ).join("\n")}`,
      );
      for (const call of CHAOS_CALLS) {
        const toolCall: ToolCall = {
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: call.arguments as Record<string, any>,
        };
        output.content.push(toolCall);
        const contentIndex = output.content.length - 1;
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall,
          partial: output,
        });
      }
      output.stopReason = "toolUse";
      stream.push({ type: "done", reason: "toolUse", message: output });
    } else {
      const notes: string[] = [];
      const errors: string[] = [];
      for (const message of context.messages) {
        if (message.role !== "toolResult") continue;
        const text = message.content
          .filter(
            (block): block is { type: "text"; text: string } =>
              block.type === "text",
          )
          .map((block) => block.text)
          .join("\n");
        for (const match of text.matchAll(
          /<repair_note>([\s\S]*?)<\/repair_note>/g,
        )) {
          notes.push(`[${message.toolName}] ${match[1]}`);
        }
        if (message.isError) {
          errors.push(`[${message.toolName}] ${text.split("\n")[0]}`);
        }
      }
      const report = [
        "CHAOS REPORT",
        `repair_notes=${notes.length}`,
        `errors=${errors.length}`,
        "--- notes the model saw ---",
        ...notes.map((note, i) => `${i + 1}. ${note}`),
        "--- errors the model saw ---",
        ...errors.map((error, i) => `${i + 1}. ${error}`),
      ].join("\n");
      pushText(report);
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
    }
    stream.end();
  })().catch((error) => {
    const output = baseMessage(model);
    output.stopReason = "error";
    output.errorMessage =
      error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: "error", error: output });
    stream.end();
  });
  return stream;
}

export default function chaosProviderExtension(pi: ExtensionAPI) {
  pi.registerProvider("chaos", {
    name: "Chaos (scripted repair exercise)",
    baseUrl: "http://chaos.invalid",
    apiKey: "chaos-key",
    api: "chaos-scripted",
    streamSimple: chaosStream,
    models: [
      {
        id: "repair-chaos",
        name: "Repair Chaos",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 8192,
      },
    ],
  });
}
