# hrc-server Refactor Notes

## Purpose

`hrc-server` is the HRC daemon package. It owns the Unix-socket HTTP API, session and continuity lifecycle, runtime orchestration across tmux, headless CLI, and SDK transports, bridge and surface binding state, lifecycle/event ingestion, and launch-wrapper callback handling. It persists state through `hrc-store-sqlite`, delegates process invocation planning to `agent-spaces`, and coordinates tmux panes, launch artifacts, spool replay, and OTLP/HTTP log ingestion for Codex runs.

## Public Surface

The package root exports `createHrcServer(options)`, `HrcServerOptions`, `HrcServer`, `createTmuxManager`, `TmuxManager`, `TmuxManagerOptions`, `RestartStyle`, `buildCliInvocation`, and `CliInvocationResult` from `src/index.ts`. The root starts a Bun Unix-socket server with `stop()` and optional `otelEndpoint` on the returned server handle.

The server exposes HTTP routes under `/v1` on the configured Unix socket. Session and continuity routes include `POST /v1/sessions/resolve`, `GET /v1/sessions`, `GET /v1/sessions/by-host/:hostSessionId`, `POST /v1/sessions/apply`, `GET /v1/sessions/app`, `POST /v1/sessions/clear-context`, and `POST /v1/sessions/drop-continuation`. Runtime routes include `POST /v1/runtimes/ensure`, `POST /v1/runtimes/start`, `POST /v1/runtimes/attach`, `POST /v1/runtimes/inspect`, `POST /v1/runtimes/sweep`, `GET /v1/runtimes`, `GET /v1/launches`, `POST /v1/runtimes/adopt`, `POST /v1/turns`, `POST /v1/in-flight-input`, `GET /v1/capture`, `GET /v1/attach`, `POST /v1/interrupt`, `POST /v1/terminate`, and `POST /v1/clear-context`.

The app-session API includes `POST /v1/app-sessions/ensure`, `GET /v1/app-sessions`, `GET /v1/app-sessions/by-key`, `POST /v1/app-sessions/remove`, `POST /v1/app-sessions/apply`, `POST /v1/app-sessions/turns`, `POST /v1/app-sessions/in-flight-input`, `POST /v1/app-sessions/clear-context`, `POST /v1/app-sessions/literal-input`, `GET /v1/app-sessions/capture`, `GET /v1/app-sessions/attach`, `POST /v1/app-sessions/interrupt`, and `POST /v1/app-sessions/terminate`.

Bridge, surface, target, and messaging routes include `POST /v1/surfaces/bind`, `POST /v1/surfaces/unbind`, `GET /v1/surfaces`, `POST /v1/bridges/local-target`, `POST /v1/bridges/target`, `POST /v1/bridges/deliver`, `POST /v1/bridges/deliver-text`, `POST /v1/bridges/close`, `GET /v1/bridges`, `GET /v1/targets`, `GET /v1/targets/by-session-ref`, `POST /v1/targets/ensure`, `POST /v1/messages`, `POST /v1/messages/query`, `POST /v1/messages/dm`, `POST /v1/messages/wait`, `POST /v1/messages/watch`, `POST /v1/capture/by-selector`, `POST /v1/literal-input/by-selector`, and `POST /v1/turns/by-selector`. Operational routes include `GET /v1/events`, `GET /v1/health`, and `GET /v1/status`.

Internal callback routes include `POST /v1/internal/hooks/ingest` and `POST /v1/internal/launches/:launchId/{wrapper-started,child-started,continuation,event,exited}`. OTEL ingestion is served on a separate loopback HTTP listener at `POST /v1/logs` when enabled. The package does not expose CLI commands through `package.json`, but `src/launch/exec.ts` and `src/launch/hook-cli.ts` are executable wrapper entrypoints spawned by the server or hook integrations.

Several files also export helpers for tests and in-package use: `server-parsers.ts` exports parser functions and request types, `tmux.ts` exports `TmuxManager` and `parsePaneState`, `otel-ingest.ts` exports OTLP normalization/auth helpers, `hrc-event-helper.ts` exports event derivation helpers, `agentchat-bridge.ts` exports `AgentchatBridge`, and `launch/index.ts` re-exports launch artifact, callback, spool, and hook helpers. These are not all package-root exports.

## Internal Structure

`src/index.ts` is the daemon core. It defines the Bun socket server, exact route table, request dispatch, lock handling, session CRUD, app-managed sessions, runtime start/ensure/attach/capture/interrupt/terminate flows, headless CLI and SDK turn execution, bridge delivery, surface bindings, target and message APIs, event streaming, launch callbacks, OTEL ingest integration, and many DB mapping and runtime helper functions.

`src/server-parsers.ts` contains JSON body and query parsing for most API routes. It validates runtime intents, app-session specs, command launch specs, bridge selectors, runtime filters, stale-generation options, attachments, fences, message payloads, and session refs, translating malformed input into `hrc-core` domain errors.

`src/tmux.ts` wraps the `tmux` binary. It validates tmux version 3.2+, starts/scrubs the tmux server, creates or reuses one-window sessions, parses pane metadata, captures panes, sends literal input/Enter/C-c, builds attach descriptors, and terminates sessions. `src/launch/env.ts` provides env scrubbing and tmux PATH sanitization used by both tmux and launch code.

`src/agent-spaces-adapter/cli-adapter.ts` converts `HrcRuntimeIntent` into an `agent-spaces` process invocation spec, resolving provider/frontend, execution mode, prompts, continuation, placement, correlation env, and launch env overrides. `src/agent-spaces-adapter/sdk-adapter.ts` runs non-interactive turns through `agent-spaces`, emits HRC events, buffers assistant text, validates provider continuity, and implements Anthropic SDK in-flight input support.

`src/launch/` contains launch-wrapper support. `exec.ts` reads launch artifacts, prints launch context, executes child harness processes, forwards lifecycle callbacks, handles headless Codex output, injects Codex OTEL config, and spools callbacks when the server socket is unavailable. `launch-artifact.ts` reads/writes artifact JSON, `callback-client.ts` posts Unix-socket callbacks, `spool.ts` persists and replays failed callbacks, `hook.ts` builds hook envelopes, `hook-cli.ts` is the hook executable, and `codex-otel.ts` modifies Codex TOML for OTLP/HTTP JSON export.

`src/otel-ingest.ts` owns the loopback OTLP/HTTP server, OTLP JSON normalization, per-launch auth via `x-hrc-launch-auth`, post-exit grace validation, event-kind extraction, timestamp selection, and conversion into HRC event records. `src/hrc-event-helper.ts` maps raw hook, SDK, launch, and Codex OTEL data into typed HRC lifecycle and semantic turn events. `src/agentchat-bridge.ts` is a small client for registering, delivering to, and closing legacy local bridge targets over the HRC Unix socket.

`src/__tests__/fixtures/hrc-test-fixture.ts` provides the main test fixture around a temporary server, database, tmux mocks, and seeded sessions/runtimes. The remaining test files cover route behavior, launch wrappers, bridge/surface APIs, OTEL ingest, SDK/headless dispatch, stale-generation rotation, runtime sweep/inspect/list/adopt/terminate behavior, parser behavior, and hrcchat acceptance paths.

## Dependencies

Declared production dependencies are `@iarna/toml` for Codex OTEL TOML edits; `agent-scope` for session handle formatting; `agent-spaces` for invocation planning and SDK/non-interactive execution; `hrc-core` for API types, error classes, fences, and constants; `hrc-events` for hook and OTEL event normalization; `hrc-store-sqlite` for daemon persistence; `spaces-execution` for prompt and command rendering in the launch wrapper; and `spaces-runtime`. The source also imports `spaces-config` from `src/index.ts`, `src/server-parsers.ts`, `src/agent-spaces-adapter/cli-adapter.ts`, and `src/agent-spaces-adapter/sdk-adapter.ts`, but `spaces-config` is not declared in `packages/hrc-server/package.json`. Runtime platform dependencies include Bun, Node built-ins, Unix sockets, SQLite through `hrc-store-sqlite`, and tmux for interactive runtimes.

Development dependencies are `@types/bun` and `typescript`. Tests use Bun's built-in test runner through `bun test`; there are no package-local third-party test libraries.

## Test Coverage

The package has 32 test files under `src/__tests__`, plus one shared fixture file, with 266 `test(...)` or `it(...)` cases detected. Coverage is broad around lifecycle-heavy behavior: launch artifact IO and callback spooling, hook ingestion, tmux pane parsing and env scrubbing, server route behavior for sessions/runtimes/messages/bridges/surfaces/app-sessions, SDK and headless dispatch, in-flight input, OTEL ingest and typed event derivation, stale-generation rotation, runtime sweep/list/inspect/adopt/terminate, hrcchat JSON acceptance, and error paths for launch spawn/exit handling.

The main gaps are structural rather than route-count gaps. `src/index.ts` is mostly tested through high-level route scenarios, so branch ownership inside the 9,485-line server file is hard to see and regressions can hide in unexercised private helper combinations. `src/server-parsers.ts` has targeted runtime-intent coverage but not a complete parser contract matrix for every exported parser. `src/launch/exec.ts` has important crash-path tests, but its prompt display, Codex OTEL injection path, and headless output pump are not obviously isolated as unit tests. `src/agentchat-bridge.ts` has direct tests; several other helper modules rely mostly on integration-level coverage.

## Recommended Refactors and Reductions

1. Split `src/index.ts` by route domain. The file is 9,485 lines and currently contains route registration, request handlers, runtime orchestration, launch callback ingestion, OTEL handling, message/target logic, bridge/surface logic, DB mapping helpers, and runtime liveness utilities. Extracting handlers into domain modules such as sessions, runtimes, app-sessions, bridges, messages, launch-callbacks, and status would reduce merge risk without changing the HTTP contract.

2. Split `src/server-parsers.ts` into parser groups and remove duplicated parse work. The file is 1,564 lines and mixes runtime, app-session, command, bridge, surface, target, message, attachment, and query parsing. `parseDispatchTurnRequest` also spreads `fences: parseFenceInput(fences)` twice, which should be reduced to one parse and one assignment.

3. Fix duplicated statements in event normalization helpers. `src/hrc-event-helper.ts` creates a `turn.tool_result` payload with `type: 'tool_execution_end'` listed twice in the same object. `src/otel-ingest.ts` increments `rejected` twice for one non-object `logRecord`. Both are small reductions with behavior impact: the first is dead duplicate syntax, while the second overcounts malformed OTLP records.

4. Retire the legacy prompt extraction fallback in `src/launch/exec.ts` after confirming all written launch artifacts carry structured `prompts`. The file explicitly says "Remove after one release" around `extractLegacySystemPromptFromArgv` and `extractLegacyPrimingPromptFromArgv`; keeping it indefinitely duplicates prompt-source logic now represented by `artifact.prompts`.

5. Clarify package-root exports versus internal helper exports. `src/server-parsers.ts`, `src/otel-ingest.ts`, `src/hrc-event-helper.ts`, `src/launch/index.ts`, and `src/agentchat-bridge.ts` export many symbols for tests or internal callers, but `package.json` only exposes `"."` and `src/index.ts` only re-exports a small subset. A short explicit "internal testable exports" convention or moving test-only access behind package-internal modules would make the public boundary less ambiguous.

6. Tighten declared dependencies in `packages/hrc-server/package.json`. The package imports `spaces-config` directly in four source files but does not declare it, and `spaces-runtime` is declared even though no `packages/hrc-server/src` file imports it. Adding the direct `spaces-config` dependency and removing the unused `spaces-runtime` declaration, if no generated output depends on it, would make the package boundary match the code.
