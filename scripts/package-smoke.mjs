import { execFileSync, spawnSync } from "node:child_process";
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
const absentConsumer = join(temporary, "absent-consumer");
mkdirSync(packs);
mkdirSync(consumer);
mkdirSync(absentConsumer);

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function assert(condition, message) {
  if (!condition) throw new Error(`package smoke failed: ${message}`);
}

const OPTIONAL_RUNNER = `
import { activateOptionalConsumer } from "./optional-consumer.js";

const registered = [];
const result = await activateOptionalConsumer({
  registerTool: (definition) => registered.push(definition),
});
const report = {
  branch: result.branch,
  registeredCount: registered.length,
  registeredIsResult: registered[0] === result.registered,
  hasPrepareArguments: typeof registered[0]?.prepareArguments === "function",
};
if (report.hasPrepareArguments) {
  report.prepared = registered[0].prepareArguments({ file_path: "/x" });
}
console.log(JSON.stringify(report));
`;

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
  // Keep transitive pi packages on the verified integration baseline; a
  // floating @earendil-works/pi-ai breaks pi-coding-agent@0.80.6.
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    'overrides:\n  "@earendil-works/pi-ai": 0.80.6\n',
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
  cpSync(
    join(root, "test", "fixtures", "optional-consumer.ts"),
    join(consumer, "optional-consumer.ts"),
  );
  run("node", ["smoke.mjs"], consumer);
  const tscArgs = [
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2024",
    "--skipLibCheck",
  ];
  run(
    join(consumer, "node_modules", ".bin", "tsc"),
    ["--noEmit", ...tscArgs, "consumer.ts", "optional-consumer.ts"],
    consumer,
  );
  // Emit the optional-consumer fixture as JS so its runtime behavior can be
  // exercised both with the package installed and in a clean project without it.
  run(
    join(consumer, "node_modules", ".bin", "tsc"),
    [...tscArgs, "optional-consumer.ts"],
    consumer,
  );
  writeFileSync(join(consumer, "optional-runner.mjs"), OPTIONAL_RUNNER);

  // Present-package scenario: the adapter branch must be taken, silently.
  const presentRun = runCapture("node", ["optional-runner.mjs"], consumer);
  const present = JSON.parse(presentRun.stdout.trim().split("\n").at(-1));
  assert(
    present.branch === "adapted",
    `expected adapted branch with package installed, got ${present.branch}`,
  );
  assert(
    present.registeredCount === 1 && present.registeredIsResult,
    "adapted branch did not register the adapted definition",
  );
  assert(
    present.hasPrepareArguments && present.prepared?.path === "/x",
    "adapted prepareArguments did not apply the configured alias repair",
  );
  assert(
    !`${presentRun.stdout}${presentRun.stderr}`.includes("running unwrapped"),
    "fallback note emitted although the package is installed",
  );

  // Absent-package scenario: same compiled fixture in a clean project without
  // the tarball; the fallback branch must register the raw definition and
  // emit the one-line note.
  writeFileSync(
    join(absentConsumer, "package.json"),
    `${JSON.stringify({ name: "pi-repair-smoke-absent", private: true, type: "module" }, null, 2)}\n`,
  );
  run("pnpm", ["add", "--ignore-scripts", "typebox@1.1.38"], absentConsumer);
  cpSync(
    join(consumer, "optional-consumer.js"),
    join(absentConsumer, "optional-consumer.js"),
  );
  writeFileSync(join(absentConsumer, "optional-runner.mjs"), OPTIONAL_RUNNER);
  const absentRun = runCapture("node", ["optional-runner.mjs"], absentConsumer);
  const absent = JSON.parse(absentRun.stdout.trim().split("\n").at(-1));
  assert(
    absent.branch === "fallback",
    `expected fallback branch without the package, got ${absent.branch}`,
  );
  assert(
    absent.registeredCount === 1 && absent.registeredIsResult,
    "fallback branch did not register the raw definition",
  );
  assert(
    absent.hasPrepareArguments === false,
    "fallback branch registered a wrapped definition instead of the raw one",
  );
  assert(
    absentRun.stderr.includes(
      "[optional-consumer] @r3b1s/pi-repair-layer not found",
    ),
    "fallback note missing from stderr",
  );
  console.log("optional-consumer scenarios passed (adapted + fallback)");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
