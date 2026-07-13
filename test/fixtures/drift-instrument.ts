/**
 * In-process instrumentation extension for test/upstream-drift.test.ts.
 *
 * Loaded through pi's real extension loader so its handlers run on the real
 * agent loop. It reads its per-test configuration and records what it observes
 * through `globalThis.__drift`, which the test process populates before each
 * run (the loader imports this file into the same process, so the global is
 * shared). This is a test double, never shipped.
 */

interface DriftBridge {
  /** Every `tool_call` event the loop surfaced, in order. */
  toolCallFired: { toolName: string; input: unknown }[];
  /** When set, the tool_call handler mutates `event.input` in place. */
  mutateInPlace?: boolean;
  /** When set, the tool_call handler reassigns `event.input` to a new object. */
  reassign?: boolean;
  /**
   * When set, the message_end handler appends a toolCall for this tool to an
   * assistant message that has none, returning the replacement — to prove a
   * message_end replacement's toolCalls execute same-turn.
   */
  injectToolCall?: { name: string; arguments: Record<string, unknown> };
}

function bridge(): DriftBridge {
  const g = globalThis as unknown as { __drift?: DriftBridge };
  if (!g.__drift) g.__drift = { toolCallFired: [] };
  if (!g.__drift.toolCallFired) g.__drift.toolCallFired = [];
  return g.__drift;
}

export default function driftInstrument(pi: {
  on: (event: string, handler: (event: any, ctx: any) => unknown) => void;
}) {
  pi.on("tool_call", (event) => {
    const g = bridge();
    g.toolCallFired.push({ toolName: event.toolName, input: event.input });
    if (g.mutateInPlace && event.input && typeof event.input === "object") {
      (event.input as Record<string, unknown>).path = "/mutated";
    }
    if (g.reassign) {
      event.input = { path: "/reassigned" };
    }
  });

  pi.on("message_end", (event) => {
    const g = bridge();
    const inject = g.injectToolCall;
    if (!inject) return;
    const message = event.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content))
      return;
    const hasToolCall = message.content.some(
      (part: any) => part?.type === "toolCall",
    );
    if (hasToolCall) return;
    // One-shot: clear so the follow-up assistant turn isn't re-injected
    // (which would loop forever).
    g.injectToolCall = undefined;
    const next = {
      ...message,
      content: [
        ...message.content,
        {
          type: "toolCall",
          id: `drift-injected-${Date.now().toString(36)}`,
          name: inject.name,
          arguments: inject.arguments,
        },
      ],
      stopReason: "toolUse",
    };
    return { message: next };
  });
}
