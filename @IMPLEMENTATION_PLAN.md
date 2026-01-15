# Implementation Plan (pi-sdk harness)

- Refactor `packages/engine/src/run.ts` to stop treating “non-claude” as “pi” (remove `buildPiBundle()` shortcut) so each non-Claude harness loads/uses its own composed bundle metadata.
- Update CLI output/flags to mention `pi-sdk` where appropriate (run/install/harnesses).
- Document the runner runtime choice (bun) and extension dependency constraints.
- Add tests for `pi-sdk` bundle composition ordering + `bundle.json` generation (mirror `packages/engine/src/harness/pi-adapter.test.ts`) and CLI/integration tests for `--harness pi-sdk` acceptance and error messages.
- Update docs (`README.md`/`USAGE.md`/`ARCHITECTURE.md`) to mention the new harness and its expected `--model` semantics (e.g., `provider:model`).

## Findings

- `bun run typecheck` requires a prior `bun run build` so workspace package `dist` typings exist.
