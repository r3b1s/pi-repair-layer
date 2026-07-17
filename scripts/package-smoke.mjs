import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), "pi-repair-package-"));
const packs = join(temporary, "packs");
const consumer = join(temporary, "consumer");
mkdirSync(packs);
mkdirSync(consumer);

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

try {
  run("pnpm", ["run", "build"], root);
  run("pnpm", ["pack", "--pack-destination", packs], root);
  const tarballName = readdirSync(packs).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("pnpm pack did not produce a tarball");
  const tarball = join(packs, tarballName);

  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "pi-repair-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  run(
    "pnpm",
    [
      "add",
      "--ignore-scripts",
      tarball,
      "typebox@1.1.38",
      "@earendil-works/pi-coding-agent@0.80.6",
      "@earendil-works/pi-tui@0.80.6",
      "typescript@5.9.3",
    ],
    consumer,
  );

  writeFileSync(
    join(consumer, "smoke.mjs"),
    `
import extension from "@r3b1s/pi-repair-layer";
import { runRepairPipeline, repairToolInput } from "@r3b1s/pi-repair-layer/core";
import { parseToolGrammarLeaks } from "@r3b1s/pi-repair-layer/grammar";
import { adaptToolDefinition } from "@r3b1s/pi-repair-layer/pi";
import { Type } from "typebox";

if (typeof extension !== "function") throw new Error("extension export missing");
const schema = Type.Object({ path: Type.String() });
const result = runRepairPipeline({ input: '{"path":"/x"}', config: { toolName: "x", schema } });
if (result.outcome !== "repaired") throw new Error("core pipeline failed");
if (repairToolInput({ toolName: "x", schema, input: { path: "/x" } }).outcome !== "valid") throw new Error("facade failed");
if (parseToolGrammarLeaks("").length !== 0) throw new Error("grammar import failed");
const adapted = adaptToolDefinition({ name: "x", label: "x", description: "x", parameters: schema, async execute() { return { content: [{ type: "text", text: "ok" }], details: undefined }; } });
if (adapted.prepareArguments({ path: "/x" }).path !== "/x") throw new Error("pi adapter failed");
`,
  );
  cpSync(
    join(root, "test", "fixtures", "public-consumer.ts"),
    join(consumer, "consumer.ts"),
  );
  run("node", ["smoke.mjs"], consumer);
  run(
    join(consumer, "node_modules", ".bin", "tsc"),
    [
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2024",
      "--skipLibCheck",
      "consumer.ts",
    ],
    consumer,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
