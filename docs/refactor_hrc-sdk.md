# hrc-sdk Refactor Notes

## Purpose

`hrc-sdk` is the typed Bun client for talking to the HRC daemon over its Unix socket HTTP API. It provides socket discovery, converts HRC error envelopes into `HrcDomainError`, wraps runtime/session/bridge/target/message endpoints in TypeScript methods, and re-exports the shared wire DTOs needed by SDK callers.

## Public Surface

The package exports one module, `hrc-sdk`, via `src/index.ts`; it has no CLI commands and does not serve HTTP routes itself. Its public runtime exports are `discoverSocket()` from `src/discover.ts` and `HrcClient` from `src/client.ts`.

`HrcClient` wraps these server endpoints:

- Session methods: `resolveSession()` for `POST /v1/sessions/resolve`, `listSessions()` for `GET /v1/sessions`, and `getSession()` for `GET /v1/sessions/by-host/:hostSessionId`.
- Runtime and turn methods: `ensureRuntime()` for `POST /v1/runtimes/ensure`, `startRuntime()` for `POST /v1/runtimes/start`, `dispatchTurn()` for `POST /v1/turns`, `sendInFlightInput()` for `POST /v1/in-flight-input`, `clearContext()` for `POST /v1/clear-context`, `capture()` for `GET /v1/capture`, `getAttachDescriptor()` for `GET /v1/attach`, `attachRuntime()` for `POST /v1/runtimes/attach`, `interrupt()` for `POST /v1/interrupt`, `terminate()` for `POST /v1/terminate`, `inspectRuntime()` for `POST /v1/runtimes/inspect`, `sweepRuntimes()` for `POST /v1/runtimes/sweep`, and `dropContinuation()` for `POST /v1/sessions/drop-continuation`.
- Surface methods: `bindSurface()`, `unbindSurface()`, and `listSurfaces()` for `/v1/surfaces`.
- Bridge methods: `acquireBridgeTarget()` for `POST /v1/bridges/target`, `deliverBridgeText()` for `POST /v1/bridges/deliver-text`, legacy `registerBridgeTarget()` for `POST /v1/bridges/local-target`, legacy `deliverBridge()` for `POST /v1/bridges/deliver`, `closeBridge()` for `POST /v1/bridges/close`, and `listBridges()` for `GET /v1/bridges`.
- Diagnostics methods: `getHealth()` for `GET /v1/health`, `getStatus()` for `GET /v1/status`, `listRuntimes()` for `GET /v1/runtimes`, `listLaunches()` for `GET /v1/launches`, and `adoptRuntime()` for `POST /v1/runtimes/adopt`.
- hrcchat target and dispatch methods: `listTargets()`, `getTarget()`, `ensureTarget()`, `dispatchTurnBySelector()`, `deliverLiteralBySelector()`, and `captureBySelector()`.
- Durable-message methods: `createMessage()`, `listMessages()`, `waitMessage()`, `semanticDm()`, and `watchMessages()`.
- Event streaming: `watch()` consumes `GET /v1/events` as NDJSON.

`src/index.ts` re-exports many request/response types from `src/types.ts` and record aliases from `hrc-core`, including session, runtime, surface, bridge, diagnostics, target, message, and watch option types.

## Internal Structure

- `src/client.ts` contains the entire SDK implementation: Unix-socket `fetch` helpers, typed error translation, endpoint-specific methods, query-string construction, and NDJSON streaming for lifecycle events and messages.
- `src/types.ts` is a DTO barrel. Most request/response contracts are re-exported from `hrc-core`; SDK-only filter/options types such as `SessionFilter`, `RuntimeListFilter`, `WatchOptions`, and `WatchMessagesOptions` live here.
- `src/discover.ts` resolves the daemon socket through `resolveControlSocketPath()` from `hrc-core` and verifies the path exists.
- `src/index.ts` is the package barrel.
- `src/__tests__/sdk.test.ts` covers socket discovery, constructor behavior, typed errors, selected runtime lifecycle methods, lifecycle NDJSON watching, diagnostics integration with `hrc-server`, watch abort/malformed-line behavior, `sendInFlightInput()`, and root exports.
- `src/__tests__/sdk-phase6-bridge.test.ts` covers canonical bridge methods plus `closeBridge()` and `listBridges()`.

## Dependencies

Production dependencies are only `hrc-core` for socket path resolution, shared HRC records/DTOs, API constants, and `HrcDomainError`. The runtime also relies on Bun's `fetch` Unix-socket extension.

Declared test/development dependencies are `@types/bun` and `typescript`. Tests additionally use Bun's built-in test runner, Node filesystem/path/os modules, and dynamically import `hrc-server` in `src/__tests__/sdk.test.ts`.

## Test Coverage

There are 30 test cases across 2 test files:

- `src/__tests__/sdk.test.ts` has 25 cases covering socket discovery, constructor setup, selected runtime lifecycle calls, domain error conversion, lifecycle NDJSON parsing, diagnostics round trips through a real `hrc-server`, malformed NDJSON tolerance, abort handling, non-JSON error excerpts, `sendInFlightInput()`, and export smoke checks.
- `src/__tests__/sdk-phase6-bridge.test.ts` has 5 cases covering `acquireBridgeTarget()`, `deliverBridgeText()`, `closeBridge()`, and `listBridges()`.

Main gaps: many public `HrcClient` methods have no endpoint-plumbing tests, including `ensureRuntime()`, `dispatchTurn()`, `clearContext()`, `capture()`, `getAttachDescriptor()`, `interrupt()`, `terminate()`, `inspectRuntime()`, `sweepRuntimes()`, `dropContinuation()`, surface methods, target methods, selector-based dispatch methods, and most durable-message methods. `watchMessages()` has no direct test for NDJSON parsing, malformed lines, `timeoutMs`, or abort behavior even though it duplicates much of `watch()`'s stream logic.

## Recommended Refactors and Reductions

1. Synchronize the root type barrel with the actual `HrcClient` method surface. `src/client.ts` uses public request/response types such as `DropContinuationRequest`, `DropContinuationResponse`, `HrcBridgeTargetRequest`, `HrcBridgeTargetResponse`, `HrcBridgeDeliverTextRequest`, `HrcBridgeDeliverTextResponse`, `InspectRuntimeRequest`, `InspectRuntimeResponse`, `SweepRuntimesRequest`, `SweepRuntimesResponse`, `TerminateRuntimeRequest`, and `TerminateRuntimeResponse`, all re-exported by `src/types.ts`; `src/index.ts` omits them. Consumers importing from `hrc-sdk` can call the methods but cannot import all matching DTO types from the package root.

2. Remove or repurpose the unused `AdoptRuntimeRequest` shape. `src/types.ts` defines `AdoptRuntimeRequest` and `src/index.ts` exports it, but `HrcClient.adoptRuntime()` accepts a bare `runtimeId: string` and constructs `{ runtimeId }` internally. Either change `adoptRuntime()` to accept the request object or drop the exported SDK-only type to reduce API clutter.

3. Consolidate duplicated NDJSON stream parsing. `watchMessages()` in `src/client.ts` and `watch()` in the same file both maintain a text buffer, split on newlines, skip malformed JSON, flush trailing content, and check `AbortSignal`. A private `parseNdjsonStream<T>()` helper would reduce duplicate control flow and make malformed-line and abort behavior consistent.

4. Retire stale red-gate comments and `as any` calls from tests. `src/__tests__/sdk.test.ts` still says methods such as `getHealth()`, `getStatus()`, `listRuntimes()`, `listLaunches()`, and `adoptRuntime()` do not exist, and it calls several implemented methods through `(client as any)`. Updating those tests to call the typed methods directly would make type regressions visible.

5. Make integration dependencies explicit or isolate them. `src/__tests__/sdk.test.ts` dynamically imports `hrc-server`, but `packages/hrc-sdk/package.json` does not list `hrc-server` in `devDependencies`. Add the workspace test dependency or move the real-server diagnostics suite to an integration package so package-scoped installs and test runs have an explicit dependency graph.

6. Fill focused endpoint-plumbing tests before broad behavior tests. The client surface in `src/client.ts` is mostly request routing, query-string construction, and response typing; lightweight Bun.serve tests like those in `src/__tests__/sdk-phase6-bridge.test.ts` would catch wrong paths or dropped filters for currently untested symbols such as `listTargets()`, `getTarget()`, `listMessages()`, `waitMessage()`, `terminate()`, `sweepRuntimes()`, and `listSurfaces()` without needing a full HRC server.
