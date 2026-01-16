- [x] Migrate `@lherron/session-agent-sdk` to the agent-spaces execution plane.
  - [x] Introduce/locate a Claude Agent SDK session runner in `packages/execution` (new module or existing run path) that owns query loop + HooksBridge.
  - [x] Move or re-export the `AgentSession`, `HooksBridge`, and permission hook logic from `session-agent-sdk` so execution-plane becomes the source of truth.
  - [x] Update `session-agent-sdk` to consume the execution-plane module and keep its public API stable (`AgentSDKBackend`, `AgentSDKSessionBackend`).
  - [x] Preserve session ID persistence (`onSdkSessionId`) and permission gating behavior.

- [x] Migrate `@lherron/session-pi` to the agent-spaces execution plane.
  - [x] Use `pi-sdk` (SDK) harness for CP sessions; load bundle.json + hooks/skills/context from execution-plane.
  - [x] Use execution-plane bundle materialization to supply `PI_CODING_AGENT_DIR` and hook/skills dirs (bundle root).
  - [x] Keep event bridging (Rex EventHub) and permission hook integration; preserve session persistence and per-session state paths.
  - [x] Re-export pi-coding-agent helpers/types from `spaces-execution/pi-session` to keep control-plane free of direct pi-sdk imports.
  - [x] Refresh control-plane dependencies so `spaces-execution/pi-session` resolves during builds.
  - [x] Replace Bun-only I/O/spawn usage in `spaces-config` with Node-compatible fs/spawn to unblock control-plane runtime.

- [ ] Update control-plane wiring and tests for new harness and session backends.
  - [x] Wire control-plane Pi backend to agent-spaces pi-sdk materialization (`materializePiSdkForProject`).
  - [x] Add integration test for pi-sdk materialization (`tests/integration/agent-spaces-pi-sdk.test.js`).
  - [x] Run control-plane tests/typecheck/lint after dependency refresh.
  - [ ] Run smoke tests using `asp run --dry-run` where applicable for new harness paths (not yet needed).

**STRETCH GOAL: Remove all dependencies on agent-sdk and pi-sdk from control-plane.**
- [x] Re-export Claude Agent SDK helpers from `spaces-execution/agent-sdk` so control-plane sidecar can avoid direct SDK imports.

Completed (2026-01-15)
- Swapped control-plane deps/imports to `spaces-config`/`spaces-execution` and wired `claude-agent-sdk` for agent-spaces materialization.
- Added `claude-agent-sdk` harness support (types/schema, adapter, registry, CLI, tests) and execution `materializeFromRefs` wrapper.
- Fixed control-plane permission hook routing to fall back to the project's active run when no session_id is available.
- Migrated `@lherron/session-agent-sdk` core session runner + hook bridge into `spaces-execution` and adapted control-plane wrappers to keep Project-specific config in CP.
- Agent-spaces tests/typecheck/lint/build run clean after pi-session module additions.
- Added CP context and JSONL event emission support for multi-agent coordination:
  - Created `packages/execution/src/events/` module with `cp-context.ts` (CP env var extraction) and `events.ts` (structured JSONL event emitter)
  - Added `CpContext` type to `spaces-config` harness types with new `HarnessRunOptions` fields: `cpContext`, `artifactDir`, `emitEvents`
  - Updated `run.ts` to extract CP context from env vars (CP_WORK_ITEM_ID, CP_RUN_ID, CP_ROLE, CP_KIND, CP_TRACE_ID)
  - Run function now emits `job_started` and `job_completed` JSONL events when `emitEvents` is enabled
  - CP context is passed through to harness adapters and child process environment
  - Deterministic artifact directories generated based on CP_RUN_ID when available
