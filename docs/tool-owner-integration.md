# Integrating repairs into extension-owned tools

This guide shows how a pi extension can apply pi-repair-layer's public repair
pipeline to tools that extension owns. The usual integration is one wrapper
around the tool definition. A lower-level core API is available when the tool
owner needs to control the surrounding lifecycle.

## Contents

- [The ownership boundary](#the-ownership-boundary)
- [Install the package](#install-the-package)
- [Recommended: wrap the tool definition](#recommended-wrap-the-tool-definition)
- [Optional integration](#optional-integration)
- [Configure only known-safe transforms](#configure-only-known-safe-transforms)
- [Existing `prepareArguments` hooks](#existing-preparearguments-hooks)
- [Optional: receive structured outcomes](#optional-receive-structured-outcomes)
- [Optional: attach `<repair_note>` feedback](#optional-attach-repair_note-feedback)
- [Lower level: call the pure core](#lower-level-call-the-pure-core)
- [Test the integration](#test-the-integration)

## The ownership boundary

pi validates tool arguments after calling that tool's `prepareArguments`.
Because arguments that fail validation never reach `tool_call`, repair must run
in `prepareArguments` to recover them safely.

Only the extension that owns a tool definition can reliably install that hook.
Installing pi-repair-layer repairs pi's built-in tools, but it does not discover,
replace, or wrap tools registered by other extensions. Those extensions must
explicitly use one of the APIs below.

## Install the package

Add pi-repair-layer as a dependency of the extension that owns the tool:

```bash
pnpm add @r3b1s/pi-repair-layer
```

The dependency does not have to be hard. A standalone extension can keep
pi-repair-layer out of its runtime dependencies entirely and degrade to its
raw tool definition when the package is absent — see
[Optional integration](#optional-integration) before committing your users to
an extra install.

The public APIs are compiled ESM with TypeScript declarations:

- `@r3b1s/pi-repair-layer/pi` provides the pi tool-definition adapter.
- `@r3b1s/pi-repair-layer/core` provides the pure pipeline, configuration
  types, lifecycle helpers, and repair-note formatting.
- `@r3b1s/pi-repair-layer/grammar` provides pure leaked-grammar parsing and
  recovery helpers.

Do not import files from `src/`; they are not part of the compatibility
contract. Node 22 or later is required. The verified pi integration baseline is
0.80.6.

## Recommended: wrap the tool definition

`adaptToolDefinition` returns a copy of the supplied definition with a repair
aware `prepareArguments`. It preserves the tool's schema and executor and
chains any `prepareArguments` already supplied by the owner.

Once wrapped, bounded envelope recovery and schema-located repairs such as
dropping an invalid optional `null` or parsing a JSON-stringified array are
automatic. Exact aliases, cleanup of values that already satisfy the schema,
and tool-specific shape changes require explicit preprocessors because only the
tool owner knows where those transformations are semantically safe.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adaptToolDefinition } from "@r3b1s/pi-repair-layer/pi";
import { Type } from "typebox";

const parameters = Type.Object({
  path: Type.String(),
  labels: Type.Optional(Type.Array(Type.String())),
});

export default function myExtension(pi: ExtensionAPI) {
  pi.registerTool(
    adaptToolDefinition(
      {
        name: "inspect_asset",
        label: "Inspect asset",
        description: "Inspect an asset and optionally apply labels",
        parameters,
        async execute(_toolCallId, params) {
          return {
            content: [
              {
                type: "text",
                text: `Inspecting ${params.path}`,
              },
            ],
            details: undefined,
          };
        },
      },
      {
        policy: "adaptive",
        preprocessors: [
          {
            kind: "alias",
            selector: "/path",
            aliases: ["file_path", "filePath"],
            accepts: "string",
          },
          {
            kind: "filesystem-path",
            selector: "/path",
          },
          {
            kind: "string-or-array",
            selector: "/labels",
          },
        ],
      },
    ),
  );
}
```

With this configuration, `{file_path: "/tmp/a"}` becomes
`{path: "/tmp/a"}`, a markdown auto-link in `path` is unwrapped, and a single
string in `labels` becomes a one-item array. Each mutation has a stable rule ID
and explanatory note, and the final result must pass the supplied schema.

The adapter fails closed by throwing `UnrepairableToolInputError` with a
model-readable retry message. `unrepairable: "passthrough"` is available for a
deliberate compatibility migration, but it can expose the input to pi's native
conversion and should not be the default.

## Optional integration

`adaptToolDefinition` is a pure decorator: it takes a `ToolDefinition` and
returns a `ToolDefinition`. That makes the identity function a complete
fallback — an extension can attempt to load the adapter at activation time and
register its unmodified definition when pi-repair-layer is not installed.
Repair support then becomes an end-user opt-in instead of an author-imposed
dependency.

### The recipe

Author repair options as pure data, import only types at compile time, and
attempt one dynamic import inside the (awaited) extension factory:

```ts
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
  description: "Inspect an asset",
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

export default async function myExtension(pi: ExtensionAPI) {
  const adapt = await loadRepairAdapter();
  if (!adapt) {
    console.error(
      "[my-extension] @r3b1s/pi-repair-layer not found; inspect_asset running unwrapped",
    );
  }
  pi.registerTool(adapt ? adapt(definition, repairOptions) : definition);
}
```

The details are load-bearing:

- **Discriminate before falling back.** A missing package surfaces as
  `code: "MODULE_NOT_FOUND"` (jiti's require path) or
  `code: "ERR_MODULE_NOT_FOUND"` (native ESM and the compiled pi binary). But
  a *present-but-broken* install — pi-repair-layer resolvable while one of its
  own transitive modules is not — throws the same codes naming the
  *transitive* module. Requiring the message to name
  `@r3b1s/pi-repair-layer` keeps a broken install loud instead of silently
  running unwrapped while the user believes repairs are active. Match the
  package name, not the `/pi` subpath: native ESM reports only
  `Cannot find package '@r3b1s/pi-repair-layer'`.
- **Rethrow everything else.** Any other error is a real failure, not
  absence.
- **Emit one stderr line when falling back.** The two branches differ in
  behavior (see the caveats below); a silent divergence cannot be diagnosed
  from a session transcript.
- **Keep repair options as pure data.** `satisfies PiToolOwnerAdapterOptions`
  with a type-only import gives full typechecking with no runtime import, so
  the compiled extension activates in installs without the package.

The runnable, tested copy of this recipe is
[`test/fixtures/optional-consumer.ts`](../test/fixtures/optional-consumer.ts);
the package smoke test exercises both branches in clean projects. Keep the
snippet above and that fixture in sync when editing either.

### Consumer `package.json` shape

```jsonc
{
  "devDependencies": {
    // for typechecking and local tests only; erased from the runtime story
    "@r3b1s/pi-repair-layer": "^0.3.0"
  },
  "peerDependencies": {
    "@r3b1s/pi-repair-layer": ">=0.3.0"
  },
  "peerDependenciesMeta": {
    "@r3b1s/pi-repair-layer": { "optional": true }
  }
}
```

`import type` and `satisfies` are erased at compile time, so the
`devDependencies` entry is all that is needed to build. The optional peer
declaration documents which versions the extension was written against
without forcing an install.

### Adoption paths

**End-user opt-in via pi's shared install root (the default story).** pi
installs every `npm:`-installed extension into one shared project per scope,
so all such extensions sit side by side in a flat `node_modules`. When an end
user runs:

```bash
pi install npm:@r3b1s/pi-repair-layer
```

to get repairs for pi's built-in tools, the package also becomes resolvable to
every npm-installed extension in that scope — and consenting extensions using
this recipe light up automatically. Nothing is required from the extension
author beyond the recipe.

**Author-controlled `optionalDependencies`.** An author who wants repairs
whenever the environment can provide them can instead declare:

```jsonc
{
  "optionalDependencies": {
    "@r3b1s/pi-repair-layer": "^0.3.0"
  }
}
```

The package installs alongside the extension when possible, and a failed
optional install does not fail the extension's install. This is also the path
for consumers the shared-root story cannot reach (see the caveats).

### Caveats

- **Install source and scope matter.** The shared `node_modules` is per pi
  scope, and only for `npm:` installs. Git-installed extensions get their own
  clone-local dependency install, and project-scope installs do not resolve
  user-scope siblings (or vice versa). Those consumers fall back even though
  the user installed the package; `optionalDependencies` is the alternative
  there. The layout is observed pi behavior (verified 0.80.6–0.80.10), not a
  documented pi guarantee — see
  [research Claim 10](research.md#claim-10--pi-maintains-one-shared-npm-install-project-per-scope-with-flat-sibling-resolution).
- **The compiled pi binary never takes the adapter branch today.** Under the
  standalone (Bun-compiled) pi executable, dynamic `import()` cannot resolve
  npm-installed siblings at all, so this recipe falls back — safely, with the
  note — even when the package is installed. The optional pattern currently
  activates only under Node-based pi installs (`npm install -g` /
  `bun install -g`). A hard static dependency resolves under both
  distributions. See
  [research Claim 13](research.md#claim-13--bun-binary-probe-the-optional-dynamic-import-falls-back-under-the-compiled-binary-resolves-under-npm-dist-pi).
- **Fallback mode is baseline pi, not "repairs minus notes."** Without the
  adapter, pi's native validation runs `Value.Convert` first, which silently
  coerces some invalid input into valid-looking values (`null` → `"null"`)
  instead of repairing or rejecting it. Decide explicitly whether that is
  acceptable for your tool, and test both branches.
- **No double-wrap.** The installable pi-repair-layer extension only overrides
  pi's built-in tools; it never discovers or wraps tools registered by other
  extensions. A tool adapted by this recipe is wrapped exactly once in either
  branch.

### Stability contract for optional consumers

Copies of this recipe keep working across versions because the surface it
touches is deliberately small and covered by the compatibility contract in
[Install the package](#install-the-package):

- The subpath names (`/pi`, `/core`, `/grammar`) and the
  `adaptToolDefinition(definition, options?)` signature are stable for the
  current major; documented exports follow semantic versioning.
- Absence detection semantics are part of the contract: a missing package
  surfaces with `code` `MODULE_NOT_FOUND` or `ERR_MODULE_NOT_FOUND` and a
  message naming the requested module.
- Unrecognized preprocessor `kind`s are ignored — never fatal, no mutation, no
  claimed change — and results are still schema-validated. Repair options
  written against a newer minor version therefore degrade to the recognized
  subset when an older version is installed, instead of throwing at
  configuration time.

## Configure only known-safe transforms

Preprocessors use JSON-Pointer-like selectors. `"/path"` selects a field,
`"/edits/*/oldText"` selects a field in every array item, and `""` selects the
root. Pointer escapes `~0` and `~1` represent `~` and `/` in field names.

Available preprocessors are:

| Kind | Intended use |
|---|---|
| `alias` | Move an explicitly listed alternative key to its canonical location. |
| `filesystem-path` | Unwrap a markdown auto-link in one path string. |
| `filesystem-path-array` | Apply path cleanup to string items in one array. |
| `string-or-array` | Wrap one configured string as a one-item array. |
| `scalar` | Convert a configured string/number/boolean scalar to the declared scalar type. |
| `anchor-bleed` | Strip model-gated `^`/`$` artifacts from one configured string. |
| `grammar-tokens` | Strip model-gated argument tokens at configured keys/values. |
| `structural` | Apply an owner-supplied shape transformation with a stable rule ID and note. |

Alias values can be guarded with `accepts: "string"`, `"number"`,
`"boolean"`, `"array"`, or `"object"`. By default, an existing canonical
value wins. Set `emptyEquivalentToMissing: true` only when an empty canonical
value is invalid or genuinely means “not supplied.”

Model-specific transforms require both a matching `modelId` and configured
`modelFamilies`:

```ts
{
  policy: "adaptive",
  modelId: "provider/model-id",
  preprocessors: [{
    kind: "anchor-bleed",
    selector: "/path",
    modelFamilies: [/kimi-k2/i, /glm/i],
  }],
}
```

Adapter options are captured when the definition is wrapped. If the tool must
follow model changes during a session, either re-register it with the new model
ID or use the pure-core pattern below from an owner-managed `prepareArguments`
that reads current model state for each call.

Do not apply path cleanup to arbitrary content or anchor cleanup to regex
fields. The pipeline deliberately does not guess aliases, fuzzily rename keys,
or delete unknown fields.

### Policy profiles

- `conservative` permits bounded lossless envelope recovery, exact configured
  preprocessing, and schema-guided repair. It observes model-gated valid-value
  artifacts without mutating them.
- `adaptive` additionally permits schema-validated truncated-object completion
  and configured model-gated value cleanup. This is the default.
- `recover` has the same tool-argument behavior as adaptive and additionally
  enables gated assistant-text grammar promotion when the installable extension
  is handling `message_end`.

The adapter itself does not register grammar hooks or turn assistant text into
tool calls.

## Existing `prepareArguments` hooks

If the definition already has `prepareArguments`, keep it on the definition.
The adapter calls it after envelope recovery and before configured
preprocessors and schema repair:

```ts
pi.registerTool(
  adaptToolDefinition({
    ...definition,
    prepareArguments(input) {
      return migrateMyExtensionVersion(input);
    },
  }),
);
```

The owner shim should perform only compatibility work belonging to that tool.
If it throws, the pipeline preserves the recovered envelope and continues to a
fail-closed validity decision.

## Optional: receive structured outcomes

Use `onOutcome` for metrics or owner-managed feedback. It runs once with the
same result returned by the pipeline:

```ts
adaptToolDefinition(definition, {
  onOutcome(result) {
    if (result.outcome === "repaired") {
      recordValueFreeMetric({
        tool: definition.name,
        policy: result.policy,
        rules: result.changes.map((change) => change.ruleId),
        stages: result.changes.map((change) => change.stage),
        fingerprint: result.fingerprint,
      });
    }
  },
});
```

`result.args` contains the actual arguments. Do not write it to telemetry or
session metadata. Rule IDs, stages, policy, outcome, and non-value failure
fingerprints are suitable for value-free reporting. Callback errors are
isolated and do not alter the repair verdict.

## Optional: attach `<repair_note>` feedback

The adapter repairs arguments, but it cannot attach feedback by itself because
`prepareArguments` runs before pi creates or exposes the validated call through
`tool_call`. Tool owners that want model-facing notes can use the exported
bounded `RepairLifecycle` to bridge that gap:

```ts
import {
  attachRepairNotes,
  RepairLifecycle,
} from "@r3b1s/pi-repair-layer/core";
import { adaptToolDefinition } from "@r3b1s/pi-repair-layer/pi";

const lifecycle = new RepairLifecycle();
const toolName = definition.name;

pi.registerTool(
  adaptToolDefinition(definition, {
    policy: "adaptive",
    preprocessors,
    onOutcome(result) {
      if (result.outcome !== "repaired") return;
      lifecycle.enqueue(toolName, result.args, {
        rules: result.changes.map((change) => change.ruleId),
        notes: result.changes.map((change) => change.note),
        stages: [...new Set(result.changes.map((change) => change.stage))],
        profile: result.policy,
        outcome: "repaired",
        fingerprint: result.fingerprint,
      });
    },
  }),
);

pi.on("tool_call", async (event) => {
  lifecycle.correlate(event.toolName, event.input, event.toolCallId);
});

pi.on("tool_result", async (event) => {
  const feedback = lifecycle.take(event.toolCallId);
  if (!feedback || feedback.notes.length === 0) return undefined;
  return {
    content: attachRepairNotes(event.content, feedback.notes),
  };
});

pi.on("session_shutdown", async () => {
  lifecycle.clear();
});
```

The lifecycle uses stable argument serialization, FIFO matching for identical
concurrent calls, bounded queues, and a TTL. `attachRepairNotes` preserves other
content and avoids inserting an identical tagged note twice. A custom TUI
indicator remains the owning extension's responsibility.

## Lower level: call the pure core

Use `runRepairPipeline` when the adapter does not fit the tool framework or when
repair is needed outside a pi session:

```ts
import { runRepairPipeline } from "@r3b1s/pi-repair-layer/core";

const result = runRepairPipeline({
  input: rawArguments,
  config: {
    toolName: "inspect_asset",
    schema: parameters,
    policy: "adaptive",
    preprocessors,
  },
});

if (result.outcome === "unrepairable") {
  throw new Error(result.retryMessage);
}

const validatedArguments = result.args;
```

The core registers no pi events and performs no filesystem, UI, telemetry,
network, or persistence work. It does not mutate caller-owned input. A
`repaired` outcome always means the final arguments passed the supplied schema;
an `unrepairable` outcome returns the original input and no claimed changes.

## Test the integration

At minimum, an owning extension should test:

1. Strictly valid input remains unchanged.
2. Every configured alias and selector repair produces valid arguments.
3. Unconfigured content and similar-but-unknown keys remain unchanged.
4. Unrepairable input throws before the executor runs.
5. An existing owner `prepareArguments` is still called.
6. If result feedback is enabled, concurrent identical calls receive one note
   each and stale notes do not leak to later calls.
7. Telemetry and persisted entries contain no argument values or note text.

Optional consumers (the [Optional integration](#optional-integration) recipe)
should additionally test both branches:

8. With the package absent, activation still succeeds: the raw definition is
   registered and the one-line fallback note is emitted.
9. Strictly valid input behaves identically in both branches; for invalid
   input, the fallback branch exposes pi's native coercion — confirm that is
   acceptable for your tool.

For a working compile-time example, see
[`test/fixtures/public-consumer.ts`](../test/fixtures/public-consumer.ts). The
package smoke test installs the packed tarball into a clean project and imports
every documented subpath.
