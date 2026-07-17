import type { RepairPipelineConfig } from "@r3b1s/pi-repair-layer/core";
import {
  formatRepairNotes,
  runRepairPipeline,
} from "@r3b1s/pi-repair-layer/core";
import { parseToolGrammarLeaks } from "@r3b1s/pi-repair-layer/grammar";
import { adaptToolDefinition } from "@r3b1s/pi-repair-layer/pi";
import { Type } from "typebox";

const schema = Type.Object({ path: Type.String() });
const config: RepairPipelineConfig = { toolName: "consumer", schema };
const outcome = runRepairPipeline({ input: { path: "/x" }, config });
formatRepairNotes(outcome.changes.map((change) => change.note));
parseToolGrammarLeaks("");

adaptToolDefinition({
  name: "consumer",
  label: "Consumer",
  description: "consumer fixture",
  parameters: schema,
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: undefined };
  },
});
