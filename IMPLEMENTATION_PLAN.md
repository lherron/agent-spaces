# Implementation Plan: Agent-Spaces Session Separation

Reference spec: `specs/spec_agent_spaces.md`

## Status

All internal implementation items (phases ASP-1 through ASP-4) are **complete**. The agent-spaces public API has been fully rewritten for provider-typed continuity and CP-orchestrated interactive processes.

**Validation (verified 2026-01-28):**
- `bun run build` — all 9 packages pass
- `bun run typecheck` — all 9 packages pass
- `bun run test` — 864 tests pass, 0 fail across all packages
- `bun run lint` — 232 files checked, no issues
- No source code references to deprecated names (`harnessSessionId`, `externalSessionId`, `externalRunId`, `runTurn`)

**Test coverage:**
- 27 unit tests in `packages/agent-spaces/src/client.test.ts`
- 16 integration tests in `integration-tests/tests/agent-spaces-client.test.ts`

## Remaining Items (External Dependencies)

- [ ] **CP repo integration**: control-plane must store provider-typed continuation per CP session, use `buildProcessInvocationSpec` for CLI frontends, and update event consumers to read `continuation`.
- [ ] **Upstream SDK/CLI versions**: confirm agent-sdk resume key format, Pi SDK session key behavior, Codex CLI resume + CODEX_HOME semantics match current implementation assumptions.

## Architecture Notes

### Key Files
- `packages/agent-spaces/src/types.ts` — All new spec types (240 lines)
- `packages/agent-spaces/src/client.ts` — Client implementation with two execution paths (1151 lines)
- `packages/agent-spaces/src/client.test.ts` — Unit tests (27 tests, ~550 lines)
- `integration-tests/tests/agent-spaces-client.test.ts` — Integration tests (16 tests, ~360 lines)
- `scripts/cp-interface-test.ts` — SDK-frontend test script
- `scripts/codex-interface-test.ts` — CLI-frontend test script

### Design Decisions
1. **Two execution paths**: `runTurnNonInteractive` (SDK-only: agent-sdk, pi-sdk) and `buildProcessInvocationSpec` (CLI-only: claude-code, codex-cli). This cleanly separates in-process SDK execution from CLI process preparation.
2. **FRONTEND_DEFS Map**: Keyed by `HarnessFrontend`, each entry contains `{ provider, internalId, models, defaultModel }`. Replaces old `HARNESS_DEFS` with provider-domain typing.
3. **Continuation semantics**: For agent-sdk, the continuation key is the SDK session ID observed from events. For pi-sdk, it's a deterministic directory path (`aspHome/sessions/pi/<sha256(cpSessionId)>`). For CLI frontends, it's passed through to adapter run options.
4. **No session persistence**: Agent-spaces no longer stores session records. CP owns continuity and passes continuation refs on each request.

### Key Findings (from Phase 0 Investigation)
- Both `agent_start.sessionId` and `sdk_session_id` events are handled; `sdk_session_id` takes precedence
- Pi SDK continuation key is a deterministic session directory path; `PiSession` constructor accepts `sessionPath` for resume
- Codex CLI is exclusively a CLI frontend; session state is CP-owned via `buildProcessInvocationSpec`
- Frontend → internal harness mapping: `agent-sdk` → `claude-agent-sdk`, `pi-sdk` → `pi-sdk`, `claude-code` → `claude`, `codex-cli` → `codex`
- `argv[0]` is the resolved binary path from `adapter.detect()`. Interaction mode maps to `interactive: boolean` in adapter options.
