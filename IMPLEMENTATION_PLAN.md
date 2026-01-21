# Agent Spaces Implementation Plan

## Project Goal
Implement the Codex harness as described in `specs/codex-agent-harness.md` so Codex is supported for:
- `asp install`/`asp run` via the Codex CLI
- programmatic `runTurn()` via the Codex app-server

## Dependencies and External Tasks
- [ ] Confirm Codex CLI availability and app-server protocol stability.
  - [ ] Ensure a documented minimum Codex CLI version with `codex app-server` support is available for dev/CI.
  - [ ] Capture JSON-RPC v2 method/notification shapes from upstream Codex app-server docs/artifacts for use in types/tests.

## Implementation Tasks (Priority Order)
- [ ] 1) Foundation: add codex to shared types and schemas.
  - [ ] Update `packages/config/src/core/types/harness.ts` to add `codex` to `HarnessId`/`HARNESS_IDS`, add `SpaceCodexConfig`, and extend `ComposedTargetBundle` with codex paths.
  - [ ] Update `packages/config/src/core/types/space.ts` to include `codex` in `SpaceHarnessConfig.supports` and add `codex?: SpaceCodexConfig` on `SpaceManifest`.
  - [ ] Update `packages/config/src/core/types/targets.ts` to add `[codex]` options (model, approval_policy, sandbox_mode, profile) plus helpers to resolve defaults.
  - [ ] Update schemas `packages/config/src/core/schemas/space.schema.json` and `packages/config/src/core/schemas/targets.schema.json` to validate codex config.
  - [ ] Update type exports/tests that rely on harness enums or manifest validation to cover codex.

- [ ] 2) Codex harness adapter (materialization + template composition).
  - [ ] Create `packages/execution/src/harness/codex-adapter.ts` implementing `HarnessAdapter` with detect/validate/materialize/compose/buildRunArgs/getTargetOutputPath.
  - [ ] Materialize per-space artifacts: copy skills, flatten `commands/*.md` into prompts, copy MCP config, and extract instructions from `AGENTS.md` or `AGENT.md` with `SpaceCodexConfig` toggles honored.
  - [ ] Compose `codex.home`: merge skills/prompts (last wins), render `AGENTS.md` with per-space blocks, compose MCP into `config.toml`, add `project_doc_fallback_filenames`, and merge `codex.config` dotted keypaths; optionally emit `mcp.json` and `manifest.json`.
  - [ ] Populate `ComposedTargetBundle` codex fields and set `pluginDirs`/`mcpConfigPath` (pointing at `codex.home`) for compatibility with existing discovery.

- [ ] 3) Execution pipeline updates for CLI run (`asp run --harness codex`).
  - [ ] Register the codex adapter in `packages/execution/src/harness/index.ts` (optionally gated by `ASP_EXPERIMENTAL_CODEX`).
  - [ ] Update `packages/execution/src/run.ts` to handle `codex` in the non-Claude path: load a codex bundle, set `CODEX_HOME=<output>/codex.home`, and include it in dry-run/print-command output.
  - [ ] Wire target-level codex defaults and `--model`/`--yolo` into `buildRunArgs` (model, sandbox mode, approval policy) without swallowing errors.

- [ ] 4) Codex app-server session (programmatic `runTurn`).
  - [ ] Add `codex` to `SessionKind` and extend `CreateSessionOptions` in `packages/execution/src/session/types.ts` and `packages/execution/src/session/factory.ts`.
  - [ ] Implement `packages/execution/src/codex-session/` (RPC client + session + event mapper + approval handler) to spawn `codex app-server`, initialize, start/resume threads, and map notifications into `UnifiedSessionEvent`.
  - [ ] Handle attachments (local images vs text references), approvals via `PermissionHandler`, and optional JSONL capture (`eventsOutputPath`).

- [ ] 5) Agent-spaces client integration for `harness: "codex"`.
  - [ ] Add `CODEX_MODELS` and default model to `HARNESS_DEFS` in `packages/agent-spaces/src/client.ts`, plus `getHarnessCapabilities` coverage.
  - [ ] Add `codexSessionPath` and session-home materialization (copy `config.toml`, symlink skills/prompts/AGENTS) and apply `CODEX_HOME` during `runTurn`.
  - [ ] Create `CodexSession` via `createSession`, persist `harnessSessionId` as the thread id, and update `packages/agent-spaces/src/client.test.ts`.

- [ ] 6) Discovery and compatibility tweaks.
  - [ ] Decide on skill discovery for codex: set `bundle.pluginDirs` to `codex.home` or add codex-aware discovery in `packages/config/src/orchestration/materialize-refs.ts`.
  - [ ] Ensure tools discovery works for codex by wiring `mcp.json` (or a codex config parser) into `collectTools`.

- [ ] 7) Tests.
  - [ ] Add codex adapter unit tests (skills merge, prompts flattening, `AGENTS.md` composition, `config.toml` rendering).
  - [ ] Add codex session tests using a fake JSON-RPC app-server (initialize, thread start/resume, turn flow, approvals, attachments).
  - [ ] Add integration tests for `asp install/build/run --harness codex` using a codex shim or fake server; update harness registry/client tests for new harness IDs.

- [ ] 8) Docs and rollout.
  - [ ] Update README/USAGE and CLI `asp harnesses` output to list codex as experimental; document `ASP_EXPERIMENTAL_CODEX` if used.
  - [ ] Align `docs/codex-smoke-test-runbook.md` with the actual `space.toml` schema and codex target options; document Codex CLI prerequisites.
