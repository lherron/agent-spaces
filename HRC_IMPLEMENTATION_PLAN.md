# HRC Implementation Plan

## Intent

Implement HRC as a new additive package family inside the `agent-spaces` monorepo.

HRC is the host-resident runtime controller defined by the ACP runtime specs. It sits between ACP-style control planes and the existing single-agent execution substrate in this repository. The implementation in this plan is additive only:

- do not remove or rename existing `agent-spaces`, `spaces-runtime`, or `spaces-execution` surfaces
- do not perform cleanup/extraction of current host-owned logic during these phases
- build the new HRC stack beside the current packages, then migrate callers later

All implementation work derived from this document should reference `T-00946`.

## Source Material

This plan is based on:

- `../acp-spec/spec/runtime/HRC.md`
- `../acp-spec/spec/runtime/HRC_DETAIL.md`
- `../acp-spec/spec/runtime/AGENT_SPACES.md`
- `../acp-spec/spec/foundations/CONCEPTS.md`
- `../acp-spec/spec/foundations/MENTAL_MODEL.md`
- `../acp-spec/spec/contracts/SESSION_EVENTS.md`

It also reflects the current local seam shape in:

- `packages/agent-spaces/src/client.ts`
- `packages/agent-spaces/src/session-events.ts`
- `packages/agent-spaces/src/runtime-env.ts`
- `packages/agent-spaces/src/run-tracker.ts`
- `packages/agent-spaces/src/__tests__/hrc-seam-contracts.test.ts`

## Guiding Decisions

1. HRC is a separate package family, not a refactor inside `packages/agent-spaces`.
2. Package names must begin with `hrc-` for easy identification and future monorepo extraction.
3. The first implementation phase covers the ACP-facing HRC core only.
4. The overall plan covers the full HRC footprint, including required companion surfaces.
5. The implementation is prescriptive, not exploratory: concrete IPC, storage, tmux, and wrapper choices are fixed below.
6. `agent-spaces` remains the runtime materialization and execution substrate. HRC must not subsume bundle resolution or execution-policy authority.
7. Cleanup of old surfaces is a separate later effort and is out of scope here.
8. Only one HRC package may depend on `agent-spaces`, `spaces-runtime`, or `spaces-execution`: the explicit adapter package.
9. The adapter package must use public package APIs only. If HRC needs a lower-level seam, that seam must be added deliberately to the upstream package first rather than importing `src/*` internals.

## Scope

HRC will own:

- stable `SessionRef -> active hostSessionId` continuity
- generation and `clear_context` semantics
- tmux-backed interactive runtime hosting
- runtime reconciliation and liveness tracking
- wrapper lifecycle reporting via `hrc-launch`
- attach, capture, interrupt, terminate, and clear-context surfaces
- HRC-assigned event sequencing and replay/watch
- required companion surfaces for in-flight input, surface binding, workbench/app sessions, and local legacy bridges

HRC will not own:

- `SessionRef -> RuntimePlacement` planning
- bundle inference from semantic scope
- reserved file resolution or materialization rules
- generic shell orchestration outside launch specs returned by `agent-spaces`
- transcript/conversation or coordination system-of-record responsibilities

## Additive Rollout Rules

- Keep the current `agent-spaces` public API working throughout all phases.
- Do not move code out of existing packages during the first HRC implementation sequence.
- New code may wrap or duplicate limited internal logic from existing packages if that avoids destabilizing current consumers.
- When an HRC phase needs functionality that already exists in `agent-spaces`, prefer an adapter package over a direct internal import into `hrc-core`.

## Target Package Family

### `packages/hrc-core`

Purpose:

- canonical HRC domain types and request/response contracts
- selector parsing/normalization helpers
- fence validation helpers
- runtime intent, snapshot, launch artifact, and event envelope models
- typed error codes
- platform path resolution policy

Rules:

- no filesystem, tmux, socket, or process side effects
- no dependency on `agent-spaces` runtime code
- may depend on `agent-scope`
- may depend on `spaces-config` for `RuntimePlacement`
- define small local aliases for provider/continuation primitives instead of importing runtime code from `agent-spaces`

### `packages/hrc-store-sqlite`

Purpose:

- SQLite schema and migrations
- repositories for continuity, session, runtime, launch, event, surface, and bridge state
- append-only event sequencing
- watch/replay queries

Concrete choice:

- use SQLite with WAL mode
- use Bun-targeted SQLite access for v1

### `packages/hrc-adapter-agent-spaces`

Purpose:

- adapter between HRC intent and current `agent-spaces` execution/materialization surfaces
- translate `HrcHarnessIntent` to `buildProcessInvocationSpec(...)`
- translate HRC SDK dispatch to `runTurnNonInteractive(...)`
- persist resolved bundle metadata returned by `agent-spaces`
- translate session and hook data into HRC continuation and harness identity updates
- isolate all intentionally ugly coupling to current `agent-spaces`/runtime/execution seams

Required internal boundary:

- `cli-adapter/`
  - phase 1
  - CLI invocation building and interactive launch prep only
- `sdk-adapter/`
  - phase 2
  - SDK dispatch and event-stream mapping only

Dependencies:

- `agent-spaces`
- `spaces-runtime`
- `spaces-execution`

Rules:

- no other HRC package may import those three packages directly
- phase 1 uses only `cli-adapter/`
- phase 2 adds `sdk-adapter/`
- do not import `packages/agent-spaces/src/*` internals from this package

### `packages/hrc-server`

Purpose:

- long-lived host daemon
- Unix socket HTTP API
- tmux server ownership and reconciliation
- runtime orchestration
- callback ingestion for `hrc-launch`
- companion surface APIs

Responsibilities:

- startup migration/reconciliation
- request validation and fence checks
- event append and watch streaming
- launch artifact writing
- wrapper callback replay from spool

### `packages/hrc-sdk`

Purpose:

- typed client for the HRC daemon
- Unix socket discovery
- request/response marshalling
- NDJSON watch parsing into `AsyncIterable`

### `packages/hrc-cli`

Purpose:

- `hrc` operator CLI
- thin wrapper over `hrc-sdk`
- no business logic beyond argument parsing, JSON output, and streaming presentation

### `packages/hrc-launch`

Purpose:

- `hrc-launch exec --launch-file <path>`
- `hrc-launch hook --stdin`
- wrapper-side child PID tracking
- callback spooling when the daemon is unavailable

### `packages/hrc-bridge-agentchat`

Purpose:

- local literal-text bridge for `legacy-agentchat`

Timing:

- phase 5, not phase 1

## Concrete Runtime and Storage Choices

### Runtime directories

HRC will use these path rules:

- `runtimeRoot`
  - `HRC_RUNTIME_DIR` if set
  - else `${XDG_RUNTIME_DIR}/hrc` when `XDG_RUNTIME_DIR` exists
  - else `${TMPDIR:-/tmp}/hrc-${UID}`
- `stateRoot`
  - `HRC_STATE_DIR` if set
  - else `${XDG_STATE_HOME:-$HOME/.local/state}/hrc`

Within those roots:

- control socket: `<runtimeRoot>/hrc.sock`
- tmux socket: `<runtimeRoot>/tmux.sock`
- launch artifacts: `<runtimeRoot>/launches/`
- spool dir: `<runtimeRoot>/spool/`
- sqlite db: `<stateRoot>/state.sqlite`
- migration marker dir: `<stateRoot>/migrations/`

These choices intentionally work on Linux and macOS without special casing the high-level plan.

### IPC

Use HTTP/1.1 over a Unix domain socket.

Public endpoints:

- `POST /v1/sessions/resolve`
- `GET /v1/sessions`
- `GET /v1/sessions/by-host/:hostSessionId`
- `GET /v1/events`
- `POST /v1/runtimes/ensure`
- `POST /v1/turns`
- `POST /v1/interrupt`
- `POST /v1/terminate`
- `POST /v1/clear-context`
- `GET /v1/capture`
- `GET /v1/attach`

Internal endpoints:

- `POST /v1/internal/launches/:launchId/wrapper-started`
- `POST /v1/internal/launches/:launchId/child-started`
- `POST /v1/internal/launches/:launchId/exited`
- `POST /v1/internal/hooks/ingest`

Watch transport:

- `GET /v1/events` returns NDJSON
- support `fromSeq`
- support follow mode for live streaming
- `hrc-sdk.watch(...)` wraps NDJSON into `AsyncIterable<HrcEventEnvelope>`

### HTTP error model

All non-streaming failures return:

```json
{
  "error": {
    "code": "string",
    "message": "string",
    "detail": {}
  }
}
```

Required status mapping:

- `400`
  - malformed request body
  - invalid selector
  - invalid fence shape
- `404`
  - unknown session
  - unknown host session
  - unknown runtime
- `409`
  - `stale_context`
  - `runtime_busy`
  - `run_mismatch`
- `422`
  - `missing_runtime_intent`
  - `provider_mismatch`
  - `inflight_unsupported`
- `503`
  - `runtime_unavailable`
- `500`
  - unexpected internal error

Error codes in HTTP responses must match the HRC domain error code strings so CLI, SDK, and tests can assert the same values.

### Daemon lifecycle

Phase 1 daemon policy is:

- start manually with `hrc server`
- do not auto-start the daemon on first SDK or CLI client call
- use a lock file at `<runtimeRoot>/server.lock` plus socket binding as the single-instance guard
- if another daemon is already healthy, a second `hrc server` exits immediately with a clear error
- if the socket exists but the lock owner is dead, remove the stale socket and stale lock, then start
- on startup, replay spooled callbacks before serving requests
- on startup, run runtime reconciliation after spool replay and before opening the public socket
- on `SIGINT` or `SIGTERM`, stop accepting new requests, flush DB writes, close the public socket, and exit without killing active tmux sessions or child processes
- after graceful shutdown, wrapper callbacks must rely on spool-and-replay when the daemon is restarted

### SQLite policy

Use one SQLite database with:

- `PRAGMA journal_mode = WAL`
- `PRAGMA foreign_keys = ON`
- `PRAGMA busy_timeout = 5000`

The daemon is the single writer. Reads may happen concurrently.

### tmux policy

Use one HRC-owned tmux server on the HRC socket.

Minimum supported tmux version:

- `3.2`

`hrc server` must fail fast at startup if tmux is absent or below the minimum version.

Concrete topology for v1:

- one tmux session per `hostSessionId`
- one main window per tmux session
- one primary pane per runtime host session
- reuse the pane shell for `restartStyle = reuse_pty`
- allocate a new tmux session for `restartStyle = fresh_pty`

Naming:

- tmux session name: `hrc-<hostSessionId-short>`
- window name: `main`

HRC stores the actual tmux `sessionId`, `windowId`, and `paneId` returned by tmux, and never derives truth from names alone.

### Launch artifact

Each launch writes a JSON artifact at `<runtimeRoot>/launches/<launchId>.json`.

The launch artifact must include:

- `launchId`
- `hostSessionId`
- `generation`
- `runtimeId`
- `runId` when dispatching a turn
- `harness` and `provider`
- resolved invocation argv/env/cwd
- callback socket path
- spool dir
- correlation env values
- launch environment overlay policy
- any hook bridge configuration required by the adapter

### Wrapper behavior

`hrc-launch exec` will:

1. read the launch artifact
2. POST `wrapper-started`
3. spawn the child process with inherited stdio
4. POST `child-started`
5. wait for child exit
6. POST `exited`
7. spool callback payloads to disk if the daemon is unavailable

`hrc-launch hook --stdin` will:

1. read structured hook JSON from stdin
2. attach `launchId`, `hostSessionId`, `generation`, and optional `runtimeId`
3. POST `/v1/internal/hooks/ingest`
4. spool if delivery fails

### Event sequencing

HRC event sequence numbers are global and monotonic across the local daemon.

`events.seq` is assigned by SQLite insertion order, not by tmux, wrapper, or adapter code.

## Repository State We Will Wrap First

The first HRC implementation should reuse these existing seams without moving them:

- placement-based invocation construction in `agent-spaces`
- non-interactive SDK turn execution in `agent-spaces`
- current host correlation env var behavior
- current in-flight run support where HRC later needs it

Rules for the first implementation:

- `hrc-adapter-agent-spaces` is the only HRC package allowed to touch existing `agent-spaces` runtime behavior directly
- the adapter must use public `agent-spaces` package APIs only
- phase 1 must not rely on `mapUnifiedEvents`, `createEventEmitter`, `runSession`, or other `src/*` internals from `packages/agent-spaces`
- if HRC needs a lower-level seam that is not publicly exported, create that seam first as an explicit pre-HRC prep task instead of importing internals

## Data Model

The initial schema should include these tables.

### `continuities`

Columns:

- `scope_ref`
- `lane_ref`
- `active_host_session_id`
- `updated_at`

Primary key:

- `(scope_ref, lane_ref)`

Prior continuity chain policy:

- do not denormalize `prior_host_session_ids` into this table
- derive the prior chain from `sessions.prior_host_session_id`, ordered by `generation`, when materializing `HrcContinuityRecord`

### `sessions`

Columns:

- `host_session_id`
- `scope_ref`
- `lane_ref`
- `generation`
- `status`
- `prior_host_session_id`
- `created_at`
- `updated_at`
- `parsed_scope_json`
- `ancestor_scope_refs_json`
- `last_applied_intent_json`
- `continuation_json`

### `runtimes`

Columns:

- `runtime_id`
- `host_session_id`
- `scope_ref`
- `lane_ref`
- `generation`
- `launch_id`
- `transport`
- `harness`
- `provider`
- `status`
- `tmux_json`
- `wrapper_pid`
- `child_pid`
- `harness_session_json`
- `continuation_json`
- `supports_inflight_input`
- `adopted`
- `active_run_id`
- `last_activity_at`
- `created_at`
- `updated_at`

### `runs`

Purpose:

- first-class source of truth for run lifecycle state

Columns:

- `run_id`
- `host_session_id`
- `runtime_id`
- `scope_ref`
- `lane_ref`
- `generation`
- `transport`
- `status`
- `accepted_at`
- `started_at`
- `completed_at`
- `updated_at`
- `error_code`
- `error_message`

### `launches`

Columns:

- `launch_id`
- `host_session_id`
- `generation`
- `runtime_id`
- `harness`
- `provider`
- `launch_artifact_path`
- `tmux_json`
- `wrapper_pid`
- `child_pid`
- `harness_session_json`
- `continuation_json`
- `wrapper_started_at`
- `child_started_at`
- `exited_at`
- `exit_code`
- `signal`
- `status`
- `created_at`
- `updated_at`

### `events`

Columns:

- `seq INTEGER PRIMARY KEY AUTOINCREMENT`
- `ts`
- `host_session_id`
- `scope_ref`
- `lane_ref`
- `generation`
- `run_id`
- `runtime_id`
- `source`
- `event_kind`
- `event_json`

### `runtime_buffers`

Purpose:

- capture text buffers for SDK transport where tmux capture is unavailable

Columns:

- `runtime_id`
- `chunk_seq`
- `text`
- `created_at`

### `surface_bindings`

Timing:

- phase 4

Columns:

- `surface_kind`
- `surface_id`
- `host_session_id`
- `runtime_id`
- `generation`
- `window_id`
- `tab_id`
- `pane_id`
- `bound_at`
- `unbound_at`
- `reason`

### `app_sessions`

Timing:

- phase 5

Purpose:

- app-owned/workbench session reconciliation

### `local_bridges`

Timing:

- phase 5

Purpose:

- bridge target and delivery state for `legacy-agentchat`

## Phase Plan

## Phase 1: ACP-Facing HRC Core

### Goal

Stand up a usable HRC daemon and client stack for stable continuity, tmux-backed interactive runtime hosting, wrapper lifecycle reporting, and the ACP core control surface.

### Packages delivered

- `hrc-core`
- `hrc-store-sqlite`
- `hrc-adapter-agent-spaces`
- `hrc-server`
- `hrc-sdk`
- `hrc-cli`
- `hrc-launch`

### Scope

Implement:

- `resolveSession`
- `listSessions`
- `watch`
- `ensureRuntime`
- `dispatchTurn`
- `interrupt`
- `terminate`
- `clearContext`
- `capture`
- `getAttachDescriptor`

Interactive harness support in phase 1:

- `claude-code`
- `codex-cli`

Transport in phase 1:

- tmux only

Deliberate exclusions from phase 1:

- SDK transport dispatch
- semantic in-flight input
- explicit surface binding APIs
- workbench/app sessions
- local text bridges

### Server behavior

- `resolveSession` creates or reuses the continuity record
- `ensureRuntime` supports only interactive harness intent in phase 1
- in phase 1, `ensureRuntime` prewarms a tmux session and persistent shell only; it does not start a harness child process
- `dispatchTurn` launches a one-shot CLI harness process inside the prepared pane through `hrc-launch exec`
- `restartStyle = reuse_pty` means reusing the prepared tmux shell between launches, not keeping the harness child process alive while idle
- `dispatchTurn` rejects stale fences and runtime-busy conflicts
- `clearContext` rotates `hostSessionId`, increments `generation`, archives the prior session, and optionally relaunches
- `restartStyle = fresh_pty` rotates tmux session without incrementing `generation`
- `capture` uses `tmux capture-pane`
- `attach` returns a tmux attach argv descriptor

### `hrc-adapter-agent-spaces` behavior

- call `buildProcessInvocationSpec(...)` with `placement.correlation = { sessionRef, hostSessionId, runId }`
- merge returned env with HRC launch env policy
- never infer bundle, target, or cwd from scope alone
- preserve `resolvedBundle` for persistence on the session/run side

### Phase 1 implementation order

Phase 1 is implemented in two slices.

Slice 1A: control plane, persistence, and wrapper protocol

1. `hrc-core`
   - selectors, fences, errors, path resolution, event envelope types, HTTP error codes
2. `hrc-store-sqlite`
   - migrations and repositories for continuity, session, runtime, run, launch, events
3. `hrc-launch`
   - wrapper callbacks, hook envelope, spool format
4. `hrc-server`
   - startup migration, single-instance lock, spool replay, continuity service, event appender, foundation HTTP endpoints
5. `hrc-sdk` and `hrc-cli`
   - socket discovery and request plumbing against the foundation endpoints

Slice 1B: interactive runtime path

6. tmux manager in `hrc-server`
   - version check, create/reuse session, prewarm shell, capture, attach, interrupt, terminate
7. `hrc-adapter-agent-spaces` `cli-adapter/`
   - CLI invocation building for interactive harnesses only
8. end-to-end interactive dispatch path
   - `ensureRuntime`, launch artifact writing, wrapper callbacks, run state transitions, event append

This is the human implementation order. The build order appears later and is only the package dependency order for `bun run build`.

### Phase 1 acceptance criteria

Slice 1A acceptance:

- `hrc server` starts, migrates the DB, acquires the single-instance lock, and exposes the foundation endpoints
- `hrc session resolve` creates continuity without pre-provisioning
- `hrc watch` can replay and follow `HrcEventEnvelope` NDJSON
- spool replay runs on daemon startup

Slice 1B acceptance:

- `hrc server` starts and owns the tmux socket
- `hrc runtime ensure` can prewarm a `claude-code` or `codex-cli` runtime
- `hrc turn send` launches a turn and records `turn.accepted`
- `hrc capture` returns tmux pane text
- `hrc clear-context --relaunch` rotates `hostSessionId` and increments `generation`
- stale dispatch across the prior generation is rejected unless `followLatest` is set

## Phase 2: SDK Transport and Identity Parity

### Goal

Complete the core runtime matrix by supporting SDK-backed dispatch and by capturing continuation and harness-native session identity in a first-class way.

### Scope

Implement:

- `dispatchTurn` support for `agent-sdk` and `pi-sdk`
- `transport = sdk` runtime snapshots during active SDK dispatch
- `runtime_buffers` population for `capture(source = sdk-buffer)`
- `provider_mismatch` and continuation validation through the adapter
- persistence of continuation and harness-native session identity from adapter/hook updates

Rules:

- `ensureRuntime` remains interactive-only
- SDK transport is available from `dispatchTurn(...)`, not from `attach(...)`
- `capture(...)` on active SDK transport reads from `runtime_buffers`

### `hrc-adapter-agent-spaces` behavior

- call `runTurnNonInteractive(...)` for SDK harnesses
- map emitted events into HRC event envelopes with `source = agent-spaces`
- update `continuation_json` and `harness_session_json` as keys become known

### Phase 2 acceptance criteria

- `dispatchTurn` can return `transport = sdk`
- active SDK runs emit HRC events through the same watch stream as tmux runs
- continuation and harness-native identity are persisted on the active runtime/launch rows when available
- `capture` on an active SDK run returns `sdk-buffer` text

## Phase 3: Semantic In-Flight Input

### Goal

Add the HRC companion API for semantic sideband input to a busy active run.

### Scope

Add:

- `sendInFlightInput(...)`
- `POST /v1/in-flight-input`
- runtime capability reporting via `supportsInFlightInput`
- `inflight.accepted`
- `inflight.rejected`

Concrete support policy for v1:

- support in-flight input only for runtimes whose adapter declares it safe
- do not fake semantic in-flight input by blindly sending keystrokes to tmux panes
- CLI tmux runtimes default to `supportsInFlightInput = false` unless a harness-specific adapter proves otherwise
- SDK runtimes may support in-flight input through existing `agent-spaces` in-flight APIs

### Phase 3 acceptance criteria

- stale or mismatched `runId` sideband input is rejected
- unsupported runtimes report capability errors cleanly
- successful in-flight input updates runtime activity and emits `inflight.accepted`

## Phase 4: Surface Binding and Attach Integration

### Goal

Make external surface attachment explicit and queryable instead of inferring it from tmux state.

### Scope

Add:

- `surface_bindings` table
- bind/unbind/rebind companion APIs
- `surface.bound`
- `surface.unbound`
- `surface.rebound`
- automatic Ghostty binding in `hrc attach` when `GHOSTTY_SURFACE_UUID` is present

Concrete API additions:

- `POST /v1/surfaces/bind`
- `POST /v1/surfaces/unbind`

Rules:

- the explicit HRC surface binding is authoritative
- tmux attach telemetry is observational only
- rebind across a newer runtime must emit `surface.rebound`

### Phase 4 acceptance criteria

- `hrc attach` can bind a Ghostty surface with the descriptor fence
- surface bindings survive daemon restarts
- bindings move cleanly across fresh PTY rotation and clear-context flows

## Phase 5: Workbench Sessions and Local Bridges

### Goal

Implement the required HRC platform surfaces that are outside the ACP-facing core but required for the current systems in scope.

### Packages delivered

- `hrc-bridge-agentchat`

### Scope

Add:

- app-owned/workbench session keys
- command/workbench session records
- bulk `apply` or `upsert` reconciliation API for app-owned sessions
- local transport target and literal-text delivery bridge for `legacy-agentchat`

Concrete API additions:

- `POST /v1/sessions/apply`
- `POST /v1/bridges/local-target`
- `POST /v1/bridges/deliver`

Rules:

- bridge `transport` and `target` are opaque HRC coordinates
- do not leak raw tmux coordinates through the bridge
- workbench/app reconciliation is host-local metadata, not ACP routing identity

### Phase 5 acceptance criteria

- a local workbench process can reconcile app-owned sessions into HRC
- `legacy-agentchat` can ask HRC for a local target and deliver text through the bridge
- bridge delivery honors `expectedHostSessionId` and `expectedGeneration` fences

## Phase 6: Hardening, Adoption, and Migration Readiness

### Goal

Make HRC resilient enough for real operator use before wider ACP migration begins.

### Scope

Implement:

- orphaned launch reconciliation
- tmux adoption and `adopted = true` flows
- dead/stale runtime detection
- operator diagnostics and richer CLI output
- packaging/docs for running the daemon continuously

### Acceptance criteria

- callback spool replay works after daemon restart
- stale launch callbacks do not mutate active runtime state
- orphaned tmux sessions can be marked dead or adopted safely
- the daemon never silently swallows startup, migration, or reconciliation failures

## API and Behavioral Decisions

### Selectors

Mutating APIs use stable selectors by default:

- `selector: { sessionRef }`

Concrete selectors are allowed only for:

- `interrupt`
- `terminate`
- `capture`
- `attach`

### Fences

Dispatch and in-flight mutation requests honor:

- `expectedHostSessionId`
- `expectedGeneration`
- `followLatest`

Rule:

- stale requests are rejected, never silently redirected, unless `followLatest` is explicitly set

### Runtime intent

HRC consumes explicit runtime intent with:

- `placement`
- `harness.provider`
- `harness.interactive`
- `harness.fallback`
- `harness.model`
- `execution.preferredMode`
- `execution.autoLaunchInteractive`
- `execution.allowFallback`
- `launch.env`
- `launch.unsetEnv`
- `launch.pathPrepend`

The effective runtime intent applied to a host session is cached as derived state in `last_applied_intent_json`.

### Event source mapping

Use these `source` values in `HrcEventEnvelope`:

- `hrc` for daemon-authored lifecycle and control events
- `agent-spaces` for adapter-authored execution events
- `hook` for harness hook ingestion updates
- `tmux` for observational tmux reconciliation events

### Busy state

`busy` is computed from HRC-owned run/runtime truth:

- `runs.status` plus `runtimes.active_run_id`
- not raw tmux pane heuristics

### Capture

Use:

- `tmux capture-pane` for tmux transport
- `runtime_buffers` for SDK transport

tmux capture remains observational, not semantic truth.

## Testing Strategy

This repo uses red/green TDD. HRC work should follow that discipline explicitly.

### Unit tests

Create red tests for:

- selector and fence validation
- path resolution
- SQLite migrations and repository behavior
- launch artifact serialization
- stale callback rejection
- event append ordering

### Integration tests

Create integration tests under `integration-tests/tests/hrc/` for:

- daemon startup
- session resolve/list/watch
- runtime ensure
- turn dispatch
- clear-context
- attach descriptor
- capture
- spool replay

Use:

- a real tmux binary when available
- a tmux shim for deterministic failure-path testing
- harness shims where CLI behavior would otherwise be flaky

### E2E validation

`smokey` should own:

- failing red tests before each implementation slice
- end-to-end smoke validation once a slice is green

Do not mark a phase complete without:

- a recorded failing test first
- a passing post-implementation validation run

## Suggested Workbench Split

When implementation begins, split work by package boundary rather than by file.

Recommended default split:

- `Larry`
  - `hrc-core`
  - `hrc-store-sqlite`
  - `hrc-server`
- `Curly`
  - `hrc-sdk`
  - `hrc-cli`
  - `hrc-launch`
  - `hrc-adapter-agent-spaces`
- `Smokey`
  - red tests
  - tmux/integration fixtures
  - phase acceptance smoke validation

Use separate wrkq subtasks per phase and per package cluster once implementation starts.

## Root Build and Validation Changes

When phase 1 starts, update the root workspace scripts to include the new packages in build order.

This is topological package build order, not the human implementation order used inside phase 1.

Recommended order:

1. `hrc-core`
2. `hrc-store-sqlite`
3. `hrc-adapter-agent-spaces`
4. `hrc-server`
5. `hrc-sdk`
6. `hrc-launch`
7. `hrc-cli`

Validation for implementation phases should include:

- `bun run build`
- `bun run typecheck`
- targeted package tests
- HRC integration tests

Run broad `bun run test` only after package changes are in place and smoke validation is feasible, per repo guidance.

## Explicit Non-Goals for This Plan

- cleaning up or removing current `agent-spaces` host/session logic
- changing ACP ownership boundaries
- implementing conversation or coordination read models
- introducing generic shell orchestration outside `agent-spaces` invocation specs
- hiding errors behind retry loops or catch-and-continue behavior

## First Follow-On Task List

When turning this plan into implementation work, create phase 1 subtasks for:

1. `hrc-core` contracts and path policy
2. `hrc-store-sqlite` schema and migrations
3. `hrc-sdk` and `hrc-cli` transport/client shell
4. `hrc-launch` wrapper and spool format
5. `hrc-server` continuity/event API
6. tmux manager and attach/capture support
7. `hrc-adapter-agent-spaces` CLI invocation adapter
8. phase 1 integration tests and smoke validation

That is the implementation order this plan assumes.
