# Implementation Plan: Agent-Spaces Session Separation

Reference spec: `specs/spec_agent_spaces.md`

## Completed Items

- [x] 0. Resolve continuation + CLI contract decisions (blocking)
  - [x] Inspect agent-sdk events/resume API to confirm the Anthropic continuation key source (`sdk_session_id` vs `agent_start.sessionId`) and document the decision.
    - **Finding:** Both `agent_start.sessionId` and `sdk_session_id` events are handled. The `sdk_session_id` event takes precedence when present. The continuation key is captured from whichever fires first and propagated on all subsequent events.
  - [x] Inspect Pi SDK session persistence (`PiSession`, SessionManager) to decide the OpenAI continuation key (sessionId vs sessionPath vs provider thread id) and how resume should work.
    - **Finding:** Pi SDK continuation key is a deterministic session directory path: `aspHome/sessions/pi/<sha256(cpSessionId)>`. The `PiSession` constructor accepts a `sessionPath` parameter for resume. For first runs, the directory is created; for resume, its existence is validated.
  - [x] Verify Codex CLI resume behavior (`codex resume` semantics) and whether CODEX_HOME must be per-session; decide how continuation keys map to CLI args and storage.
    - **Finding:** Codex CLI is now exclusively a CLI frontend. `buildProcessInvocationSpec` uses the codex adapter's `buildRunArgs`/`getRunEnv` to construct argv/env. Resume is handled via `continuation.key` passed to adapter run options. Session state is CP-owned; no per-session CODEX_HOME creation by agent-spaces.
  - [x] Confirm external frontend → internal harness mapping: `agent-sdk` → `claude-agent-sdk`, `pi-sdk` → `pi-sdk`, `claude-code` → `claude`, `codex-cli` → `codex` (adjust if different).
    - **Finding:** Mapping confirmed and implemented in `FRONTEND_DEFS` Map in client.ts.
  - [x] Clarify `interactionMode`/`ioMode` mapping for CLI harnesses (Claude `-p`/stdin vs Codex `exec`/`resume`, PTY vs pipes) and whether `argv[0]` should be the resolved binary path; update spec if gaps remain.
    - **Finding:** `argv[0]` is the resolved binary path from `adapter.detect()`. Interaction mode is passed to adapter run options as `interactive: boolean`. IO mode is included in ProcessInvocationSpec for CP to apply when spawning.

- [x] 1. Public API + event model rewrite (packages/agent-spaces + consumers)
  - [x] Add core types in `packages/agent-spaces/src/types.ts`: `ProviderDomain`, `HarnessContinuationKey`, `HarnessContinuationRef`, `HarnessFrontend`, `InteractionMode`, `IoMode`, `ProcessInvocationSpec`, `BuildProcessInvocationSpecRequest/Response`, `RunTurnNonInteractiveRequest/Response`.
  - [x] Replace `externalSessionId`/`externalRunId` with `cpSessionId`/`runId`, and `harnessSessionId` with `continuation` in all request/response/event types; add `provider_mismatch`/`continuation_not_found` error codes.
  - [x] Add `buildProcessInvocationSpec` + `runTurnNonInteractive` to `AgentSpacesClient`; remove `runTurn`/`RunTurnRequest/Response`.
  - [x] Update exports in `packages/agent-spaces/src/index.ts`, scripts, and CLI consumers; `DescribeRequest.harness` renamed to `frontend`, `sessionId` replaced with `cpSessionId`.

- [x] 2. Provider-typed harness registry + capabilities (packages/agent-spaces)
  - [x] Replace `HARNESS_DEFS` with `FRONTEND_DEFS` Map including provider domain, internal harness id, default model, and supported models per frontend.
  - [x] Replaced `resolveHarness` with `resolveFrontend`; enforce provider match when `continuation` is supplied via `validateProviderMatch`.
  - [x] Updated `getHarnessCapabilities` to return `{ id, provider, frontends, models }` per provider domain (anthropic, openai).
  - [x] Model id formats reconciled: SDK frontends use `provider/model` format, CLI frontends use bare model names. Default models set per frontend.

- [x] 3. Remove implicit session persistence and CP-owned continuity (packages/agent-spaces)
  - [x] Removed `SessionRecord` storage and `readSessionRecord`/`writeSessionRecord` usage.
  - [x] Replaced `prepareSessionContext` with continuation-key-only resume (no auto-resume from cpSessionId). Kept `piSessionPath` as deterministic helper for pi-sdk first-run.
  - [x] Dropped `ensureCodexSessionHome`/per-session CODEX_HOME creation; CLI session state is now fully CP-owned via `buildProcessInvocationSpec`.
  - [x] Updated error handling with new codes: `provider_mismatch`, `continuation_not_found`, `model_not_supported`, `unsupported_frontend`. All failures emit events before returning.

- [x] 4. Implement `buildProcessInvocationSpec` for CLI frontends
  - [x] Materialize spec via spaces-execution adapters and load composed bundle.
  - [x] Use `buildRunArgs`/`getRunEnv` from harness adapter to assemble `{ argv, cwd, env }`. `argv[0]` is resolved binary from `adapter.detect()`.
  - [x] Map `interactionMode`/`ioMode` into ProcessInvocationSpec. Resume args applied from `continuation.key`. Provider/frontend compatibility validated.
  - [x] `displayCommand` emitted using `shellQuote` helper. Env is a delta. CWD is absolute.
  - [x] Materialization warnings plumbed through `BuildProcessInvocationSpecResponse.warnings`.

- [x] 5. Align `runTurnNonInteractive` with SDK-only execution
  - [x] Renamed `runTurn` to `runTurnNonInteractive`. CLI frontends rejected with `unsupported_frontend` pointing to `buildProcessInvocationSpec`.
  - [x] Uses `continuation.key` for resume (agent-sdk: SDK session ID observed from events; pi-sdk: deterministic session path). Never auto-resumes from `cpSessionId`.
  - [x] Continuation captured on first observation and propagated via `eventEmitter.setContinuation`. All subsequent events include continuation.
  - [x] Response includes `{ provider, frontend, model?, continuation? }`. Events use `{ cpSessionId, runId, continuation? }`.

- [x] 6. Tests and fixtures updates
  - [x] Updated `packages/agent-spaces/src/client.test.ts` with 7 tests covering: getHarnessCapabilities, resolve errors, model_not_supported, event field validation, continuation_not_found, provider_mismatch, pi-sdk continuation creation.
  - [x] Updated `scripts/cp-interface-test.ts` to new API: `--frontend`, `--cp-session-id`, `--run-id`, `--continuation-key`. Uses `runTurnNonInteractive`.
  - [x] Updated `scripts/codex-interface-test.ts` to use `buildProcessInvocationSpec`: `--frontend`, `--interaction-mode`, `--io-mode`, `--spawn`. Supports both codex-cli and claude-code frontends.

- [x] 8. Validation (after code changes)
  - [x] `bun run build` — all 9 packages pass.
  - [x] `bun run typecheck` — all 9 packages pass.
  - [x] `bun run test` — 828 tests pass, 0 fail across all packages.
  - [x] Grep for deprecated names confirms no source code references to `harnessSessionId`, `externalSessionId`, `externalRunId`, `runTurn` (only spec/doc references remain).

## Remaining Items

- [ ] 7. Docs + external dependencies
  - [ ] Update runbooks/docs in `docs/*` and `USAGE.md` to reflect new API names (`cpSessionId`, `continuation`, `runTurnNonInteractive`, `buildProcessInvocationSpec`).
  - [ ] Add a brief note in `docs/archived-specs/codex-agent-harness.md` pointing to `specs/spec_agent_spaces.md` and marking session-record behavior obsolete.
  - [ ] External dependency: control-plane/CP repo must store provider-typed continuation per CP session, use `buildProcessInvocationSpec` for CLI frontends, and update event consumers to read `continuation`.
  - [ ] External dependency: confirm upstream SDK/CLI version requirements discovered in step 0 (agent-sdk resume key, Pi SDK session key, Codex CLI resume + CODEX_HOME behavior).

- [ ] 9. Lower-priority coverage improvements (after ASP phases)
  - [ ] Add integration-style tests for `resolve()` success paths and `describe()` coverage.
  - [ ] Add tests for `buildProcessInvocationSpec` (claude-code, codex-cli): argv/env/cwd, resume flags, displayCommand, provider mismatch.
  - [ ] Add tests for `mapUnifiedEvents` transitions, `applyEnvOverlay` restore semantics, and `validateSpec` edge cases.

## Architecture Notes

### Key Files Modified
- `packages/agent-spaces/src/types.ts` — Complete rewrite with 242 lines; all new spec types
- `packages/agent-spaces/src/client.ts` — Complete rewrite with 1156 lines; new execution paths
- `packages/agent-spaces/src/index.ts` — Updated exports (29 lines)
- `packages/agent-spaces/src/client.test.ts` — New test suite (169 lines, 7 tests)
- `scripts/cp-interface-test.ts` — Updated for new API (SDK-frontend test)
- `scripts/codex-interface-test.ts` — Rewritten for CLI-frontend test (`buildProcessInvocationSpec`)

### Design Decisions
1. **Two execution paths**: `runTurnNonInteractive` (SDK-only: agent-sdk, pi-sdk) and `buildProcessInvocationSpec` (CLI-only: claude-code, codex-cli). This cleanly separates in-process SDK execution from CLI process preparation.
2. **FRONTEND_DEFS Map**: Keyed by `HarnessFrontend`, each entry contains `{ provider, internalId, models, defaultModel }`. This replaces the old `HARNESS_DEFS` and adds provider-domain typing.
3. **Continuation semantics**: For agent-sdk, the continuation key is the SDK session ID observed from events. For pi-sdk, it's a deterministic directory path. For CLI frontends, it's passed through to adapter run options.
4. **No session persistence**: Agent-spaces no longer stores session records. CP owns continuity and passes continuation refs on each request.
