# agent-spaces Refactor Notes

## Purpose

`packages/agent-spaces` is the host-facing client surface for resolving Agent Spaces specs, describing materialized tool/hook/skill state, building CLI harness invocation specs, and running SDK-backed turns. It bridges public request/response contracts to `spaces-config`, `spaces-execution`, `spaces-runtime`, and SDK/CLI harness adapters, while preserving compatibility for older `SpaceSpec`/`cpSessionId` callers and newer placement-based runtime requests.

## Public Surface

The package exports only `.` from `package.json`, with Bun resolving to `src/index.ts` and compiled consumers resolving to `dist/index.js`/`dist/index.d.ts`.

`src/index.ts` exports the public client factory `createAgentSpacesClient`, placement helpers `buildCorrelationEnvVars`, `getProviderForFrontend`, and `validateProviderMatch`, and the public type surface from `src/types.ts` and `src/placement-api.ts`.

Primary exported types include `AgentSpacesClient`, `AgentSpacesClientOptions`, `AgentSpacesError`, `AgentEvent`, `BaseEvent`, `SessionCallbacks`, `SessionState`, `RunResult`, `SpaceSpec`, `ProcessInvocationSpec`, `BuildProcessInvocationSpecRequest`, `BuildProcessInvocationSpecResponse`, `RunTurnNonInteractiveRequest`, `RunTurnNonInteractiveResponse`, `RunTurnInFlightRequest`, `QueueInFlightInputRequest`, `QueueInFlightInputResponse`, `InterruptInFlightTurnRequest`, `ResolveRequest`, `ResolveResponse`, `DescribeRequest`, `DescribeResponse`, `HarnessCapabilities`, `HarnessContinuationRef`, `HarnessContinuationKey`, `HarnessFrontend`, `ProviderDomain`, `InteractionMode`, `IoMode`, `HostCorrelation`, `PlacementBuildInvocationRequest`, `PlacementBuildInvocationResponse`, `PlacementRunTurnRequest`, and `PlacementRunTurnResponse`.

`AgentSpacesClient` exposes `runTurnNonInteractive`, `runTurnInFlight`, `queueInFlightInput`, `interruptInFlightTurn`, `buildProcessInvocationSpec`, `resolve`, `describe`, and `getHarnessCapabilities`. The package defines no HTTP routes or CLI commands.

## Internal Structure

- `src/client.ts` implements `createAgentSpacesClient`, legacy `SpaceSpec` paths, placement-based invocation and SDK run paths, image attachment extraction, error conversion, in-flight turn handling, SDK/CLI harness adapter dispatch, and session lifecycle management.
- `src/types.ts` is the central public contract file for provider/frontends, continuation refs, process invocation specs, request/response types, event unions, errors, and the client interface.
- `src/placement-api.ts` defines placement-specific request/response aliases and public correlation/provider helper functions.
- `src/client-support.ts` defines frontend constants, model lists/defaults for `pi-sdk` and Codex CLI, `FrontendDef`, `CodedError`, `resolveFrontend`, `resolveModel`, provider-continuation validation, and display-command formatting.
- `src/client-materialization.ts` validates `SpaceSpec`, resolves specs to locks, materializes targets or refs, discovers skills, collects hooks/tools, and runs lint over resolved lock entries.
- `src/session-events.ts` adapts `UnifiedSessionEvent` from the runtime layer into public `AgentEvent` values, serializes event callback delivery, normalizes attachment inputs, and runs a single session turn.
- `src/run-tracker.ts` stores active in-flight runs, serializes queued prompts through `sendChain`, and emits success/failure completion responses.
- `src/runtime-env.ts` applies/restores process environment overlays, scopes `ASP_HOME`, derives deterministic Pi session paths, and resolves canonical host/run identifiers.
- `src/__tests__/*.test.ts`, `src/client.test.ts`, and `src/session-events.test.ts` cover public API contracts, event mapping, placement cutover behavior, HRC seams, system prompt materialization, Pi CLI typing, and source-level regression checks.

## Dependencies

Production dependencies from `package.json`: `spaces-config`, `spaces-execution`, `spaces-harness-codex`, `spaces-harness-pi-sdk`, and `spaces-runtime`.

Runtime imports use Node built-ins (`node:crypto`, `node:fs`, `node:fs/promises`, `node:path`) plus the workspace packages above. `spaces-config` supplies harness catalog data, model constants, placement resolution, lock/materialization helpers, linting, hooks, and `RuntimePlacement`; `spaces-execution` supplies session creation, harness registry/adapters, placement runtime planning, Codex runtime home preparation, local component detection, and materialization; `spaces-runtime` supplies attachment types and system prompt materialization; `spaces-harness-pi-sdk/pi-session` supplies the Pi SDK session and bundle loader.

Test/dev dependencies from `package.json`: `@types/bun` and `typescript`. Tests use `bun:test`, Node filesystem/path/tempdir utilities, and several workspace packages for cross-package contract checks.

## Test Coverage

The package contains 10 test files with 174 `test`/`it` cases. Coverage is broad around validation errors, provider/model compatibility, event sequencing, continuation refs, placement request shape, correlation environment variables, in-flight guard behavior, and system prompt materialization.

Gaps: many placement and cleanup tests are source-inspection tests (`readFileSync`/regex over `client.ts` or neighboring packages), so they verify that strings and function names remain present rather than exercising the full runtime behavior. The legacy `buildProcessInvocationSpec` happy path is lightly covered because most client tests intentionally fail before materialization or harness detection. In-flight success/queue/interrupt behavior is also under-covered beyond missing-run and unsupported-frontend guards.

## Recommended Refactors and Reductions

1. Split `src/client.ts` by responsibility. At 1,376 lines, it contains legacy invocation, placement invocation, legacy SDK runs, placement SDK runs, in-flight controls, attachment filtering, and error conversion. Extracting `buildPlacementInvocationSpec`, `runPlacementTurnNonInteractive`, and legacy run/build helpers into focused modules would reduce review risk and make repeated session lifecycle branches easier to compare.

2. Remove or wire the unused constructor registry option. `createAgentSpacesClient` stores `options?.registryPath` in `_clientRegistryPath` in `src/client.ts`, but the value is never used. Either thread it into `resolve`, `describe`, `materializeSpec`, and placement paths where appropriate, or remove the field from `AgentSpacesClientOptions` if constructor-level registry override is no longer supported.

3. Consolidate duplicate public option types. `AgentSpacesClientOptions` is declared in both `src/client.ts` and `src/placement-api.ts`, while `src/index.ts` re-exports the type from `placement-api.ts`. Keeping one source of truth would avoid drift between the implementation signature and the exported type contract.

4. Unify duplicate helper logic for errors and attachments. `toAgentSpacesError` appears in both `src/client.ts` and `src/run-tracker.ts`; string/file attachment normalization appears in both `src/session-events.ts` and `src/run-tracker.ts`; image attachment detection is local to `src/client.ts`. A small internal helper module would remove repeated conversions that currently need to stay behaviorally identical.

5. Reconcile provider helper coverage for `pi-cli`. `src/client-support.ts` treats `PI_CLI_FRONTEND` as a supported OpenAI CLI frontend, and `BuildProcessInvocationSpecRequest` accepts `'pi-cli'`, but the exported `getProviderForFrontend` map in `src/placement-api.ts` only includes `agent-sdk`, `claude-code`, `pi-sdk`, and `codex-cli`. Add `pi-cli` there or stop exporting the standalone helper to prevent public consumers from getting an `Unknown frontend` error for a supported frontend.

6. Delete empty warning plumbing or make it meaningful. `src/client.ts` initializes `const warnings: string[] = []` in both legacy and placement invocation builders, but neither path appends warnings. Returning conditional empty-warning state adds noise without behavior; either remove the local arrays or connect real warning producers.

