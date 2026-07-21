# Roadmap

Longer-horizon items that are not yet scheduled into an OpenSpec change.

## Optional-integration loader shim package

Ship a tiny, zero-runtime-dependency loader package (working name
`@r3b1s/pi-repair-layer-loader`) that consumers hard-depend on instead of
hand-rolling the optional-integration recipe. The shim owns the dynamic
`import("@r3b1s/pi-repair-layer/pi")` and the absence discrimination, so the
fragile classification logic lives in one place we test and version, rather
than being copy-pasted (and drifting) across every consumer.

- **Consumer surface:** `const adapt = await loadRepairAdapter()` — returns the
  adapter or `undefined` when the engine is absent.
- **Why a separate package:** the absence detector can't ship from the main
  package (you'd have to import it from the thing that might be missing —
  bootstrap paradox). A zero-dependency shim can't itself be
  "present-but-broken," so it removes the last copy-paste hazard.
- **Trade-off:** a second published package plus version coordination; converts
  "optional heavy dependency" into "required tiny shim + optional heavy
  engine." Justified once external adoption is broad enough that copy-paste
  drift becomes a real maintenance cost.
- **Depends on:** the A+B work (zero-runtime-dep `/pi` entry + robust
  quoted-specifier matcher), which makes the shim's internal logic trivial and
  its detection unambiguous.
