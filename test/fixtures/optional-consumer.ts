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

// Match the package name only where it appears as an imported module
// specifier: an opening quote immediately followed by the name. No trailing
// quote — under jiti and the compiled binary the absent-package error names
// the full subpath (`'@r3b1s/pi-repair-layer/pi'`), while native ESM names the
// bare package (`'@r3b1s/pi-repair-layer'`); both start with quote-then-name.
// A `node_modules/@r3b1s/pi-repair-layer/...` path segment is preceded by `/`,
// not a quote, so a transitive-missing error does not read as absence.
const REPAIR_PACKAGE_SPECIFIER_QUOTED = "'@r3b1s/pi-repair-layer";

/**
 * Classify a dynamic-import failure as "the pi-repair-layer package is absent"
 * (fall back to the raw tool) versus any other error — a present-but-broken
 * install, an unrelated failure — that must rethrow.
 */
export function isRepairPackageAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return (
    (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") &&
    message.includes(REPAIR_PACKAGE_SPECIFIER_QUOTED)
  );
}

async function loadRepairAdapter(): Promise<
  typeof adaptToolDefinition | undefined
> {
  try {
    const repair = await import("@r3b1s/pi-repair-layer/pi");
    return repair.adaptToolDefinition;
  } catch (error) {
    if (!isRepairPackageAbsent(error)) throw error;
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
