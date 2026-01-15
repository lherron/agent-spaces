- Pin control-plane to local agent-spaces packages (filesystem links) and remove legacy `spaces-*` deps.
  - In `../../core/control-plane/package.json`, replace `spaces-core`, `spaces-engine`, `spaces-store`, `spaces-git`, `spaces-materializer`, `spaces-lint`, `spaces-claude` with `spaces-config` and `spaces-execution` file links to `../../agents/spaces/packages/config` and `../../agents/spaces/packages/execution`.
  - Keep `@lherron/agent-spaces` file link (CLI) as-is; remove obsolete overrides for legacy `spaces-*` packages.
  - Update any remaining `spaces-*` imports in control-plane to `spaces-config`/`spaces-execution` exports (use `rg` to confirm no stale imports remain).

- Add a new harness ID `claude-agent-sdk` to agent-spaces (execution-plane + config-plane compatibility).
  - Extend `HarnessId`, `HARNESS_IDS`, and schema enums in `packages/config` (`core/types/harness.ts`, `core/schemas/space.schema.json`, any related validators) to include `claude-agent-sdk`.
  - Update harness-support filtering and hook/permissions mapping utilities (e.g., hooks/permissions filters that currently accept `'claude' | 'pi'`) to treat `claude-agent-sdk` as Claude-compatible.
  - Implement a `ClaudeAgentSdkAdapter` in `packages/execution/src/harness/` that delegates materialization/compose/run-args behavior to the existing Claude adapter, but with `id = 'claude-agent-sdk'` and a distinct `name`.
  - Register the new adapter in the harness registry and export it from `packages/execution/src/harness/index.ts`.
  - Update CLI options/validation to accept `--harness claude-agent-sdk` (and ensure `asp run --dry-run` prints the correct command).
  - Add/extend tests that cover detection/registration and basic compose/run-arg behavior for the new harness ID.

- Provide execution-plane wrappers for low-level materialization so callers don’t manage adapters manually.
  - Add an `execution.materializeFromRefs` wrapper that mirrors `spaces-config`’s API but injects the appropriate harness adapter from the registry.
  - Decide if the wrapper should live in `packages/execution/src/index.ts` alongside `install/build` wrappers, or as a new `execution/materialize` module.
  - Ensure wrapper surfaces `pluginDirs`, `lock`, `skills`, and `materialization` so control-plane can re-use its existing workflow.

- Update control-plane Agent Spaces integration to use config/execution packages and `claude-agent-sdk`.
  - Replace `spaces-core`/`spaces-engine`/`spaces-store` usage in `packages/control-plane/src/agent-spaces-integration.ts` with `spaces-config` + new `spaces-execution.materializeFromRefs` wrapper.
  - Ensure lock path, registry path, and aspHome semantics remain unchanged; keep caching behavior and TTL logic.
  - For control-plane sessions using Agent SDK, set harness to `claude-agent-sdk` so the correct adapter and compatibility paths are used.
  - Verify agent-space skill discovery still works via `MaterializeFromRefsResult.skills` and continues injecting skills in `agent-spaces-preparer`.

- Migrate `@lherron/session-agent-sdk` to the agent-spaces execution plane.
  - Introduce/locate a Claude Agent SDK session runner in `packages/execution` (new module or existing run path) that owns query loop + HooksBridge.
  - Move or re-export the `AgentSession`, `HooksBridge`, and permission hook logic from `session-agent-sdk` so execution-plane becomes the source of truth.
  - Update `session-agent-sdk` to consume the execution-plane module and keep its public API stable (`AgentSDKBackend`, `AgentSDKSessionBackend`).
  - Preserve session ID persistence (`onSdkSessionId`) and permission gating behavior.

- Migrate `@lherron/session-pi` to the agent-spaces execution plane.
  - Decide whether to use `pi` (CLI) or `pi-sdk` (SDK) harness for CP sessions; document the expected behavior and environment requirements.
  - Use execution-plane bundle materialization to supply `PI_CODING_AGENT_DIR` and any hook/skills dirs rather than custom materializers.
  - Keep existing event bridging (Rex EventHub) and permission hook integration; ensure session persistence and per-session state paths are preserved.

- Update control-plane wiring and tests for new harness and session backends.
  - Adjust control-plane backend router/config defaults if needed to reference `claude-agent-sdk`.
  - Update any admin or schema validation that expects specific backend kinds/harness IDs.
  - Add/extend integration tests in control-plane to cover agent-spaces materialization via `claude-agent-sdk` and Pi harness flows.
  - Run smoke tests using `asp run --dry-run` where applicable for new harness paths.
