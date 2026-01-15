- [ ] Migrate `@lherron/session-agent-sdk` to the agent-spaces execution plane.
  - [ ] Introduce/locate a Claude Agent SDK session runner in `packages/execution` (new module or existing run path) that owns query loop + HooksBridge.
  - [ ] Move or re-export the `AgentSession`, `HooksBridge`, and permission hook logic from `session-agent-sdk` so execution-plane becomes the source of truth.
  - [ ] Update `session-agent-sdk` to consume the execution-plane module and keep its public API stable (`AgentSDKBackend`, `AgentSDKSessionBackend`).
  - [ ] Preserve session ID persistence (`onSdkSessionId`) and permission gating behavior.

- [ ] Migrate `@lherron/session-pi` to the agent-spaces execution plane.
  - [ ] Decide whether to use `pi` (CLI) or `pi-sdk` (SDK) harness for CP sessions; document the expected behavior and environment requirements.
  - [ ] Use execution-plane bundle materialization to supply `PI_CODING_AGENT_DIR` and any hook/skills dirs rather than custom materializers.
  - [ ] Keep existing event bridging (Rex EventHub) and permission hook integration; ensure session persistence and per-session state paths are preserved.

- [ ] Update control-plane wiring and tests for new harness and session backends.
  - [ ] Adjust control-plane backend router/config defaults if needed to reference `claude-agent-sdk`.
  - [ ] Update any admin or schema validation that expects specific backend kinds/harness IDs.
  - [ ] Add/extend integration tests in control-plane to cover agent-spaces materialization via `claude-agent-sdk` and Pi harness flows.
  - [ ] Run smoke tests using `asp run --dry-run` where applicable for new harness paths.

Completed (2026-01-15)
- Swapped control-plane deps/imports to `spaces-config`/`spaces-execution` and wired `claude-agent-sdk` for agent-spaces materialization.
- Added `claude-agent-sdk` harness support (types/schema, adapter, registry, CLI, tests) and execution `materializeFromRefs` wrapper.
- Fixed control-plane permission hook routing to fall back to the project’s active run when no session_id is available.
