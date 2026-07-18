// Compile-time and runtime fixture for the documented optional-integration
// recipe (docs/tool-owner-integration.md). The recipe here is the canonical
// copy: the guide's snippet must stay in sync with this file.
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  adaptToolDefinition,
  PiToolOwnerAdapterOptions,
} from "@r3b1s/pi-repair-layer/pi";
import { Type } from "typebox";

const parameters = Type.Object({ path: Type.String() });

const repairOptions = {
  policy: "adaptive",
  preprocessors: [
    {
      kind: "alias",
      selector: "/path",
      aliases: ["file_path"],
      accepts: "string",
    },
  ],
} satisfies PiToolOwnerAdapterOptions;

const definition: ToolDefinition<typeof parameters> = {
  name: "inspect_asset",
  label: "Inspect asset",
  description: "optional-consumer fixture tool",
  parameters,
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `Inspecting ${params.path}` }],
      details: undefined,
    };
  },
};

async function loadRepairAdapter(): Promise<
  typeof adaptToolDefinition | undefined
> {
  try {
    const repair = await import("@r3b1s/pi-repair-layer/pi");
    return repair.adaptToolDefinition;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    const packageAbsent =
      (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") &&
      message.includes("@r3b1s/pi-repair-layer");
    if (!packageAbsent) throw error;
    return undefined;
  }
}

export interface OptionalConsumerActivation {
  branch: "adapted" | "fallback";
  registered: ToolDefinition<typeof parameters>;
}

export async function activateOptionalConsumer(
  pi: Pick<ExtensionAPI, "registerTool">,
): Promise<OptionalConsumerActivation> {
  const adapt = await loadRepairAdapter();
  if (!adapt) {
    console.error(
      "[optional-consumer] @r3b1s/pi-repair-layer not found; inspect_asset running unwrapped",
    );
  }
  const registered = adapt ? adapt(definition, repairOptions) : definition;
  pi.registerTool(registered);
  return { branch: adapt ? "adapted" : "fallback", registered };
}

export default async function optionalConsumer(pi: ExtensionAPI) {
  await activateOptionalConsumer(pi);
}
