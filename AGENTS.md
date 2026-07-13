# pi-repair-layer

Single-package repo for `@r3b1s/pi-repair-layer` — a validate-then-repair layer for [pi](https://github.com/earendil-works/pi)'s built-in tool calls. Malformed LLM tool inputs are repaired in place before validation, with `<repair_note>` feedback carried back to the model.

## Structure

```
pi-repair-layer/
├── index.ts                # Extension entry for pi auto-discovery (re-exports src/index.ts)
├── src/                    # Extension source (entry point: src/index.ts, see package.json "pi")
├── test/                   # Vitest tests + chaos provider (test/run-chaos.sh)
├── scripts/pi-dev          # Isolated pi dev environment launcher
├── scripts/bin/            # npm/npx shims (redirect to pnpm)
├── tsconfig.json           # ES2024, Bundler resolution, strict, noEmit
├── biome.json              # Formatting + non-type-aware lint
├── eslint.config.js        # Type-aware lint only (recommendedTypeCheckedOnly)
└── mise.toml               # Tool versions + task runner
```

## Commands

```bash
pnpm install
pnpm run check      # tsc --noEmit
pnpm run lint       # biome check . && eslint src/ test/ index.ts
pnpm run test       # vitest run
pnpm run format     # biome check --write .
mise run ci         # check + lint + test
```

## Code Style

- **TypeScript**: ES2024 target, `module: "ESNext"`, `moduleResolution: "Bundler"`, strict mode
- **Formatting**: Biome (space indent, double quotes)
- **Linting**: Biome handles non-type-aware rules. ESLint handles type-aware rules only (`recommendedTypeCheckedOnly`). Zero overlap.
- **Tests**: Vitest

### Biome + ESLint conflict workarounds

If Biome and ESLint produce conflicting diagnostics on the same line:
1. Disable the Biome rule in `biome.json` (Biome is the formatter, ESLint owns type-aware lint)
2. Or disable the ESLint rule for that line if it's a non-type-aware rule that Biome covers

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, etc. Releases are cut by release-please from these commit types; tags are component-prefixed (`pi-repair-layer-vX.Y.Z`).

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`): check job (typecheck + lint + test), then release-please on main, then npm publish when a release is created.

Publishing requires two repo secrets/environments:
- `RELEASE_PLEASE_TOKEN` — a PAT (or app token) so release-please can open release PRs.
- A `Release` environment with npm trusted publishing (OIDC) configured, or an `NODE_AUTH_TOKEN`.

## pi-dev Environment

`scripts/pi-dev` launches pi with an isolated config that loads this extension from the checkout. It scaffolds `.pi-dev/dev-sources.json` on first run. `scripts/pi-dev --clean` resets sessions/trust.
