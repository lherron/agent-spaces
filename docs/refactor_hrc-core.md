# hrc-core Refactor Notes

## Purpose

`hrc-core` is the shared domain contract package for Harness Runtime Controller clients, servers, CLIs, stores, and ACP integration points. It defines the canonical HRC API version, runtime/session/app-session/event/message DTOs, selector grammar, freshness fences, path resolution, domain error model, and monitor reader/condition evaluation logic used by `hrc-server`, `hrc-sdk`, `hrc-cli`, `hrcchat-cli`, `hrc-store-sqlite`, and `acp-server`.

## Public Surface

The package exposes a single package entry point, `hrc-core`, backed by `src/index.ts`.

Exported runtime values:

- `HRC_API_VERSION` from `src/index.ts`, derived from `package.json`.
- Error helpers and classes from `src/errors.ts`: `HrcErrorCode`, `httpStatusForErrorCode`, `createHrcError`, `HrcDomainError`, `HrcBadRequestError`, `HrcNotFoundError`, `HrcConflictError`, `HrcUnprocessableEntityError`, `HrcRuntimeUnavailableError`, and `HrcInternalError`.
- Selector helpers from `src/selectors.ts`: `parseSelector`, `formatSelector`, `normalizeSessionRef`, `splitSessionRef`, `formatCanonicalScopeRef`, `formatCanonicalSessionRef`, `isStableSelector`, and `isConcreteSelector`.
- Fence helpers from `src/fences.ts`: `parseFence` and `validateFence`.
- Path helpers from `src/paths.ts`: `resolveRuntimeRoot`, `resolveStateRoot`, `resolveControlSocketPath`, `resolveTmuxSocketPath`, `resolveLaunchesDir`, `resolveSpoolDir`, `resolveDatabasePath`, and `resolveMigrationsDir`.
- Monitor helpers from `src/monitor/index.ts` and `src/monitor/condition-engine.ts`: `createMonitorReader` and `createMonitorConditionEngine`.

Exported type surface:

- Core records and domain DTOs from `src/contracts.ts`: provider/harness/runtime intent types, launch artifacts, lifecycle events, sessions, runtimes, runs, launches, bridge records, surface bindings, app-session records, status responses, and capability views.
- HTTP wire contracts from `src/http-contracts.ts`: session, runtime, dispatch, attach, clear-context, sweep, surface, bridge, app-owned session, app harness turn, literal input, interrupt, terminate, and health/status request/response types.
- hrcchat wire contracts from `src/hrcchat-contracts.ts`: target views, durable message records, message filters, and DTOs for `/v1/targets/ensure`, `/v1/targets`, `/v1/targets/by-session-ref`, `/v1/turns/by-selector`, `/v1/literal-input/by-selector`, `/v1/capture/by-selector`, `/v1/messages`, `/v1/messages/watch`, `/v1/messages/wait`, and `/v1/messages/dm`.
- Monitor state, event, snapshot, capture, watch, condition, outcome, and reader/engine contracts from `src/monitor/index.ts` and `src/monitor/condition-engine.ts`.

There are no CLI commands or HTTP handlers implemented in this package; it is consumed by CLIs and servers as a shared contract/helper layer.

## Internal Structure

- `src/index.ts` is the public barrel and currently re-exports all runtime values and shared types from the package.
- `src/contracts.ts` defines base HRC domain records: harness/provider choices, runtime intent, launch artifacts, lifecycle events, persisted session/runtime/run/launch records, bridge/surface/app-session records, and status/capability views.
- `src/http-contracts.ts` defines route-level request/response DTOs shared by `hrc-server` and `hrc-sdk`, including runtime lifecycle, dispatch, app-session, bridge, surface, sweep, and window companion contracts.
- `src/hrcchat-contracts.ts` defines hrcchat target/message models and the semantic DM/list/watch/wait request and response DTOs.
- `src/errors.ts` owns HRC error codes, HTTP status mapping, structured error response creation, and domain-specific error subclasses.
- `src/fences.ts` parses and validates host-session/generation freshness fences against active session state.
- `src/selectors.ts` parses object selectors and monitor selector strings, formats canonical selectors, normalizes session refs, and bridges to `agent-scope` validation/formatting.
- `src/paths.ts` resolves runtime/state roots, sockets, spool, launches, database, and migrations paths from HRC-specific env vars, Praesidium defaults, XDG env vars, and temp fallbacks.
- `src/monitor/index.ts` builds a monitor reader over an in-memory `HrcMonitorState`, resolves selectors to current session/runtime state, emits snapshots, replays events, and creates atomic capture cursors.
- `src/monitor/condition-engine.ts` waits for monitor conditions such as `turn-finished`, `idle`, `response`, `response-or-idle`, and `runtime-dead` by evaluating snapshots and watched events.
- `src/__tests__/*.ts` cover errors, fences, paths, selectors, bridge/window contract shape, monitor reader behavior, and monitor condition behavior.

## Dependencies

Production dependencies:

- `acp-core`: supplies `AttachmentRef` for runtime intent and dispatch DTOs.
- `agent-scope`: supplies canonical scope/session parsing, formatting, and lane/scope validation used by `src/selectors.ts`.
- `spaces-config`: supplies `RuntimePlacement` for `HrcRuntimeIntent`.

Development and test dependencies:

- `@types/bun`: Bun test/runtime types.
- `typescript`: typechecking and build.
- Bun test runner via the package `test` script.

## Test Coverage

The package has 8 test files and 113 `test(...)` cases:

- `errors.test.ts` covers error-code completeness, status mapping, response shape, and error subclasses.
- `fences.test.ts` covers fence parsing, invalid inputs, success results, and stale host/generation failures.
- `paths.test.ts` covers runtime/state root env precedence and derived socket/database paths.
- `selectors.test.ts` covers object selectors, canonical session refs, monitor selector grammar, formatting, and structured invalid-selector errors.
- `bridge-contracts.test.ts` and `windows-contracts.test.ts` provide compile/runtime smoke coverage for bridge and window DTO shapes.
- `monitor.acceptance.test.ts` covers selector resolution, snapshots, default replay/follow behavior, correlated message events, and atomic capture cursors.
- `monitor-condition-engine.acceptance.test.ts` covers response waits, response-or-idle behavior, event correlation, context changes, runtime failures, timeout/stall handling, and missed-event protection.

Coverage gaps:

- `src/http-contracts.ts` and `src/hrcchat-contracts.ts` are mostly DTO-only and rely on downstream compile use; only bridge/window slices have direct contract tests.
- `src/contracts.ts` has no direct shape or compatibility tests for persisted records such as `HrcSessionRecord`, `HrcRuntimeSnapshot`, `HrcManagedSessionRecord`, and `HrcLifecycleEvent`.
- Monitor tests exercise the static reader/fixture model well, while live polling behavior is implemented in `hrc-cli/src/monitor-watch.ts` and `hrc-cli/src/monitor-wait.ts` outside this package.

## Recommended Refactors and Reductions

1. Split `src/http-contracts.ts` by route family while preserving the root barrel exports. The file is 531 lines and mixes session/runtime lifecycle types (`EnsureRuntimeRequest`, `DispatchTurnRequest`), bridge types (`HrcBridgeTargetRequest`, `HrcBridgeDeliverTextRequest`), app-owned session types (`EnsureAppSessionRequest`, `ApplyAppManagedSessionsRequest`), and window companion types (`EnsureWindowRequest`, `SendWindowLiteralInputRequest`). Smaller files such as `http/runtime.ts`, `http/bridges.ts`, and `http/app-sessions.ts` would reduce review scope without changing the exported symbols.

2. Split `src/contracts.ts` into domain-focused contract files. At 410 lines, it combines launch artifacts, lifecycle events, persisted session/runtime/run/launch records, app-session records, local bridge records, and status/capability views. The app-session duplication between `HrcAppSessionRecord` and `HrcManagedSessionRecord` is especially easy to misread; giving the legacy/simple app-session record and managed app-session record separate homes or explicit legacy naming would clarify ownership for `hrc-store-sqlite/src/repositories.ts` and `src/http-contracts.ts` consumers.

3. Consolidate freshness fence DTOs and parsers. `src/fences.ts` defines `HrcFence` plus `parseFence`, while `src/http-contracts.ts` defines `AppSessionFreshnessFence` and `hrc-server/src/server-parsers.ts` implements a separate `parseAppSessionFence`. If app-session fences intentionally lack `followLatest`, encode that as a named derived type from `HrcFence`; otherwise reuse `parseFence` so stale-host/generation validation semantics cannot drift.

4. Export monitor condition metadata from `src/monitor/condition-engine.ts`. The condition literals are defined as the `HrcMonitorCondition` type, but `hrc-cli/src/monitor-watch.ts` and `hrc-cli/src/monitor-wait.ts` each duplicate `VALID_CONDITIONS` and `MSG_REQUIRED_CONDITIONS`. Exporting runtime constants or small predicates such as `isHrcMonitorCondition` and `monitorConditionRequiresMessageSelector` would remove duplicate CLI validation tables.

5. Break up `src/monitor/condition-engine.ts` around evaluation responsibilities. The 552-line file mixes stream timing (`nextStreamResult`, deadline helpers), start snapshot evaluation, event evaluation, context-change detection, failure classification, and output event construction. Extracting pure evaluators for context changes, runtime state, turn completion, and message responses would make the acceptance tests easier to map to implementation branches.

6. Consider a narrower public barrel or subpath exports for high-churn areas. `src/index.ts` is 235 lines and exports all contracts, monitor internals, errors, path helpers, and selector helpers from one entry point. Keeping `hrc-core` as the compatibility barrel while adding documented subpaths for `hrc-core/http`, `hrc-core/hrcchat`, and `hrc-core/monitor` would reduce accidental coupling for consumers that only need DTOs or path helpers.

