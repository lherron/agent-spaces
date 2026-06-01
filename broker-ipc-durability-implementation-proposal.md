# Broker IPC Durability Implementation Proposal

Date: 2026-06-01

## Decision

Implement **durable broker IPC over Unix-domain NDJSON JSON-RPC**, with the broker process supervised inside the **existing per-runtime HRC `btmux` lease**.

Do **not** create an additional tmux server/session “per broker.” The repo already creates a per-runtime tmux lease under `runtimeRoot/btmux/<driver>-<runtimeId>.sock` and a deterministic `hrc-<driver>-<runtimeId>` session for interactive broker runtimes. The correct tmux shape is therefore:

```text
one tmux server/socket per HRC runtime
  session: hrc-<driver>-<runtimeId>
    window: broker   # harness-broker process, non-user control surface
    window: tui      # Claude/Codex interactive TUI, operator attach target

HRC <--> Unix socket IPC <--> harness-broker
broker driver <--> leased TUI pane through tmux pane controller
```

Tmux is the **process holder and operator/debug surface**. The Unix socket is the **control plane**. Direct tmux input remains only an explicit degraded recovery mode, not the normal path and not a source of semantic completion.

## Summary of fresh-eye changes vs. the prior proposal

The prior proposal correctly identified the stdio-child durability bug and the need for broker IPC. The main correction is that “tmux per broker” should be read as **broker process inside the existing per-runtime tmux lease**, not as a separate broker tmux server/socket. A separate broker tmux lease would duplicate HRC’s existing `btmux` allocation, introduce another sweep/orphan namespace, and make operator attach/dispose/reassociate behavior harder to reason about.

Additional gaps to account for:

1. **Attach/replay must use the existing v2 protocol sketch.** The protocol already sketches `broker.attach`, `invocation.eventsSince`, `invocation.ackEvents`, and `invocation.snapshot`; avoid introducing a parallel `events.subscribe` API unless deliberately replacing that design.
2. **Input idempotency is required.** Event replay alone does not cover the case where HRC sends `invocation.input`, the broker accepts it, and the IPC connection drops before HRC receives the response. The broker must de-duplicate by `inputId` and return the original disposition on retry.
3. **Permission requests are reconnect state.** Broker-to-client permission requests currently depend on the live JSON-RPC request channel. A reconnectable broker needs pending permission snapshots, default-deny timeout semantics, and idempotent response handling.
4. **Broker event durability must live on the broker side too.** HRC already persists projected broker events, but if HRC is down while the broker emits events, only a broker-side ledger can replay them.
5. **Hook callback sockets need durability and uniqueness.** Claude already hashes hook sockets by invocation/runtime. Codex currently defaults to a single `codex-hooks.sock` under `/tmp/harness-broker`, which is unsafe for multiple durable broker runtimes and should be moved to a per-runtime/per-invocation broker IPC directory.
6. **The broker pane is not the operator attach surface.** `hrc runtime attach` should attach to the TUI window/pane, not the broker process pane. Broker stdout/stderr should go to a log/capture surface, not replace the user-facing terminal.
7. **Current fallback falsely synthesizes completion.** In degraded direct-tmux mode, HRC should record “input delivered degraded” or “accepted degraded,” not `turn.completed`, unless a real broker/hook/terminal event confirms completion.
8. **Broker crash is not automatically recoverable.** Phase 1 should support HRC restart while the broker survives. If the broker dies but the TUI lives, HRC may allow degraded direct-tmux input. Automatic “restart broker and attach to existing TUI” should wait for explicit driver-level attach contracts.

## Source anchors from the attached repository

These are the implementation-relevant anchors used for this proposal:

| Area | Source anchor |
|---|---|
| HRC broker transport is stdio-only | `hrc-runtime/packages/hrc-server/src/broker/controller.ts:56-59` |
| Active broker clients are only in memory | `hrc-runtime/packages/hrc-server/src/broker/controller.ts:243-259`, `:412-420` |
| `dispatchInput` fails after restart with `broker_runtime_not_active` | `hrc-runtime/packages/hrc-server/src/broker/controller.ts:446-456` |
| HRC starts broker through stdio child factory | `hrc-runtime/packages/hrc-server/src/broker/controller.ts:283-310` |
| Current direct-tmux fallback sends literal input and immediately completes run | `hrc-runtime/packages/hrc-server/src/index.ts:2804-2820`, `:2904-3018` |
| Existing per-runtime btmux allocation | `hrc-runtime/packages/hrc-server/src/index.ts:3135-3180`, `:12523-12530` |
| Startup currently reassociates only tmux lease identity, not broker IPC | `hrc-runtime/packages/hrc-server/src/index.ts:10922-10949`, `:11130-11148` |
| Orphan sweep already owns `runtimeRoot/btmux` | `hrc-runtime/packages/hrc-server/src/index.ts:11022-11027` |
| HRC broker event projection/high-water state | `hrc-runtime/packages/hrc-store-sqlite/src/migrations.ts:892-945`, `repositories.ts:3760-3815`, `broker/controller.ts:1202-1215` |
| Protocol transport capabilities are stdio-only | `agent-spaces/packages/harness-broker-protocol/src/capabilities.ts:46-52` |
| Protocol v2 attach/replay method names already sketched but not exported | `agent-spaces/packages/harness-broker-protocol/src/commands.ts:22-31` |
| Broker CLI rejects non-stdio transport | `agent-spaces/packages/harness-broker/src/cli.ts:20-30` |
| Broker advertises `multiInvocation: false` and stdio transport | `agent-spaces/packages/harness-broker/src/broker.ts:99-110` |
| Invocation manager is single-active-invocation and memory-backed | `agent-spaces/packages/harness-broker/src/invocation-manager.ts:360-368`, `:461-566`, `:612-631` |
| Broker client owns only `StdioTransport` | `agent-spaces/packages/harness-broker-client/src/client.ts:43-70` |
| Closing stdio transport terminates the broker child | `agent-spaces/packages/harness-broker-client/src/stdio-transport.ts:137-164` |
| Tmux drivers consume HRC-owned pane lease and do not own the tmux server | `agent-spaces/packages/harness-broker/src/drivers/claude-code-tmux/driver.ts:126-132`, `:177-226`; `codex-cli-tmux/driver.ts:149-164`, `:221-247` |
| Claude driver explicitly says no live reattach / no replay today | `agent-spaces/packages/harness-broker/src/drivers/claude-code-tmux/driver.ts:110-118` |
| Current runtime state stores stdio endpoint only | `agent-spaces/packages/spaces-runtime-contracts/src/runtime-state.ts:86-90` |
| Broker v1 requirements say shared/restart reattach needs v2 attach/replay | `hrc-runtime/docs/harness-broker-hrc-run-requirements.md:143-150` |

## Current failure model

Today, for interactive broker-tmux runtimes:

```text
HRC launchd process
  -> spawns harness-broker as child over stdio
       -> broker starts/controls TUI in HRC-owned tmux lease
```

The durable pieces are SQLite runtime metadata and the tmux lease/TUI process. The broker control connection is not durable. After HRC restarts, the new HRC process has the runtime record and can find the TUI pane, but it no longer has the old `BrokerClient` in `HarnessBrokerController.active`. The broker process was also a child of the old HRC instance and usually disappears when the old stdio transport closes.

The current fallback injects directly into tmux when `broker_runtime_not_active` occurs. This is useful proof that the TUI can survive and receive input, but it bypasses broker semantics: input policy, queueing, permissions, event correlation, continuation, lifecycle projection, and real turn completion.

## Target architecture

### Runtime layout

Use one HRC-owned tmux server/socket per runtime:

```text
runtimeRoot/
  btmux/
    <driver>-<runtimeId>.sock       # existing per-runtime tmux lease socket
  broker-ipc/
    <shortRuntimeHash>/
      broker.sock                   # broker JSON-RPC Unix socket
      broker-events.jsonl           # broker event ledger, or broker-events.sqlite
      attach-token                  # 0600, redacted in inspect output
      broker.log                    # structured broker stderr/log output
      hooks/
        <invocationId>.claude.sock
        <invocationId>.codex.sock
```

Tmux session:

```text
socket:  runtimeRoot/btmux/<driver>-<runtimeId>.sock
session: hrc-<driver>-<runtimeId>

window: broker
  command: exec harness-broker run \
    --transport unix \
    --socket <runtimeRoot>/broker-ipc/<shortRuntimeHash>/broker.sock \
    --runtime-id <runtimeId> \
    --host-session-id <hostSessionId> \
    --generation <generation> \
    --attach-token-file <...>/attach-token \
    --event-ledger <...>/broker-events.jsonl \
    --log-file <...>/broker.log

window: tui
  pane: shell initially, then Claude/Codex TUI launched by broker driver
```

The broker should be started by a tmux command such as `new-window -d -n broker 'exec ...'` or `new-session -d -s ... -n broker 'exec ...'`, not by `send-keys` into a shell. The TUI launch may continue to use the driver’s hardened paste/readiness logic.

### Normal control path

```text
HRC -> Unix-domain NDJSON JSON-RPC -> broker -> driver -> tmux pane controller -> TUI
```

The broker emits event notifications over the Unix socket and appends every invocation event to its broker-side ledger before/while emitting it. HRC projects those events into existing HRC SQLite tables and acks the broker high-water mark only after successful projection.

### Restart path

On HRC startup, for each non-terminal interactive harness-broker runtime:

1. Load persisted runtime, invocation, generation, btmux lease, broker IPC endpoint, and last projected broker event sequence.
2. Inspect the existing per-runtime tmux server/session.
3. Verify the broker pane exists and appears to be the broker process.
4. Verify the TUI pane/window still matches the persisted lease identity.
5. Connect to the broker Unix socket.
6. Run `broker.hello` and `broker.attach` with `runtimeId`, `invocationId`, `generation`, `startRequestHash`, `selectedProfileHash`, and attach token.
7. Fetch `invocation.snapshot`.
8. Fetch or stream `invocation.eventsSince({ afterSeq: lastEventSeq })`.
9. Project replayed events idempotently through the existing HRC broker event mapper.
10. Ack events with `invocation.ackEvents({ throughSeq })`.
11. Rebuild `HarnessBrokerController.active` from the live Unix-socket client.
12. Mark runtime state as `controlMode: 'broker-ipc'`, `brokerAttached: true`, and update `ownerServerInstanceId`.

If broker IPC is unavailable but the TUI pane is convincingly live, mark:

```json
{
  "controlMode": "direct-tmux-degraded",
  "brokerAttached": false,
  "tuiLive": true,
  "degradedReason": "broker_ipc_unavailable_after_hrc_restart"
}
```

That degraded mode may deliver plain text input, but it must not claim queueing, permission mediation, broker events, or semantic completion.

## State model additions

### Runtime-state JSON

Current runtime state stores only `broker.endpoint: { kind: 'stdio-jsonrpc-ndjson' }`. Extend it to a union:

```ts
type BrokerEndpoint =
  | { kind: 'stdio-jsonrpc-ndjson' }
  | {
      kind: 'unix-jsonrpc-ndjson'
      socketPath: string
      attachTokenRef: { kind: 'file'; path: string; redacted: true }
    }
```

Add durable attachment/control fields:

```json
{
  "broker": {
    "protocolVersion": "harness-broker/0.2",
    "endpoint": {
      "kind": "unix-jsonrpc-ndjson",
      "socketPath": ".../broker.sock",
      "attachTokenRef": { "kind": "file", "path": ".../attach-token", "redacted": true }
    },
    "multiInvocation": false,
    "startedAt": "...",
    "ownerServerInstanceId": "hrc-server-...",
    "brokerPid": 12345,
    "tmux": {
      "socketPath": ".../btmux/<driver>-<runtimeId>.sock",
      "sessionName": "hrc-<driver>-<runtimeId>",
      "windowName": "broker",
      "paneId": "%1"
    }
  },
  "control": {
    "mode": "broker-ipc",
    "brokerAttached": true,
    "attachedAt": "...",
    "lastAttachError": null
  },
  "tui": {
    "host": "tmux",
    "socketPath": ".../btmux/<driver>-<runtimeId>.sock",
    "sessionName": "hrc-<driver>-<runtimeId>",
    "windowName": "tui",
    "paneId": "%2",
    "operatorAttachTarget": true
  },
  "eventHighWater": 123
}
```

### Runtime statuses

Keep existing statuses but make control mode explicit:

| Status/control | Meaning |
|---|---|
| `ready` + `broker-ipc` | Normal reusable broker runtime; HRC has a live broker socket. |
| `ready`/`busy` + `direct-tmux-degraded` | TUI is live, broker IPC is absent; plain-text emergency delivery only. |
| `terminated` | Intentional end, including user `/quit`/logout/clear when mapped from broker continuation clear reasons. |
| `dead` | Unexpected process death or crash with high confidence. |
| `stale` | Metadata/generation/lease mismatch or unsafe-to-reuse state. |
| `disposed` | Explicit broker/runtime disposal. |

## ASP / Agent Spaces work

ASP owns protocol, broker implementation, broker client transport, and broker drivers.

### 1. Protocol package

Repository area: `agent-spaces/packages/harness-broker-protocol`.

Implement protocol version `harness-broker/0.2` or an explicit negotiated v2 feature set. Prefer versioned capability negotiation because current `BrokerMethod` exports only v1 even though v2 method names are sketched.

Required changes:

```ts
type BrokerTransportKind =
  | 'stdio-jsonrpc-ndjson'
  | 'unix-jsonrpc-ndjson'

interface BrokerCapabilities {
  multiInvocation: boolean
  transports: BrokerTransportKind[]
  eventNotifications: true
  brokerToClientRequests: boolean
  attachReplay?: boolean
}
```

Export v2 methods:

```ts
type BrokerMethod = BrokerMethodV2
```

Add request/response contracts:

```ts
interface BrokerAttachRequest {
  runtimeId: string
  hostSessionId: string
  generation: number
  invocationId: InvocationId
  startRequestHash: string
  selectedProfileHash: string
  controllerInstanceId: string
  attachToken: string
  lastProjectedSeq?: number
  clientCapabilities?: ClientCapabilities
}

interface BrokerAttachResponse {
  attached: true
  brokerInstanceId: string
  runtimeId: string
  generation: number
  invocationId: InvocationId
  activeControllerInstanceId: string
  currentSeq: number
  retentionFloorSeq: number
  snapshot: InvocationSnapshot
}

interface InvocationSnapshotRequest {
  invocationId: InvocationId
}

interface InvocationSnapshot {
  invocationId: InvocationId
  state: InvocationState
  currentTurnId?: TurnId
  continuation?: ContinuationUpdate
  capabilities: InvocationCapabilities
  pendingInputIds: InputId[]
  inputDispositions: Record<string, InvocationInputResponse>
  pendingPermissionRequests: PermissionRequestParams[]
  terminalSurface?: BrokerTerminalSurfaceReport
  process?: { brokerPid?: number; childPid?: number; exitCode?: number | null; signal?: string | null }
  currentSeq: number
  retentionFloorSeq: number
}

interface InvocationEventsSinceRequest {
  invocationId: InvocationId
  afterSeq: number
  live?: boolean
}

interface InvocationEventsSinceResponse {
  events: InvocationEventEnvelope[]
  currentSeq: number
  retentionFloorSeq: number
  liveStreamAttached?: boolean
}

interface InvocationAckEventsRequest {
  invocationId: InvocationId
  throughSeq: number
  controllerInstanceId: string
}

interface InvocationAckEventsResponse {
  ackedThroughSeq: number
}
```

Define retention failure explicitly:

```text
If afterSeq < retentionFloorSeq, broker returns a typed error such as
BROKER_EVENT_REPLAY_UNAVAILABLE. HRC must not silently mark the runtime healthy;
it should either use a snapshot-only degraded state or mark stale depending on
which lifecycle events could have been missed.
```

### 2. Broker client package

Repository area: `agent-spaces/packages/harness-broker-client`.

Current `BrokerClient` is hard-bound to `StdioTransport`, and closing the transport kills the child broker process. Split process spawn from transport connection.

Target shape:

```ts
interface BrokerJsonRpcTransport {
  request<T>(method: string, params?: unknown): Promise<T>
  onNotification(handler: NotificationHandler): void
  onRequest(handler: RequestHandler): void
  onClose(handler: CloseHandler): void
  close(): Promise<void> // closes only this connection
}

class StdioTransport implements BrokerJsonRpcTransport {
  static start(options: StdioTransportStartOptions): Promise<StdioTransport>
  close(): Promise<void> // legacy: still terminates child, only for stdio-owned broker
}

class UnixSocketTransport implements BrokerJsonRpcTransport {
  static connect(options: { socketPath: string; timeoutMs?: number }): Promise<UnixSocketTransport>
  close(): Promise<void> // close socket only; do not kill broker
}

class BrokerClient {
  static startStdio(options: StdioTransportStartOptions): Promise<BrokerClient>
  static connectUnix(options: { socketPath: string; timeoutMs?: number }): Promise<BrokerClient>
  attach(req: BrokerAttachRequest): Promise<BrokerAttachResponse>
  eventsSince(req: InvocationEventsSinceRequest): Promise<InvocationEventsSinceResponse>
  ackEvents(req: InvocationAckEventsRequest): Promise<InvocationAckEventsResponse>
  snapshot(req: InvocationSnapshotRequest): Promise<InvocationSnapshot>
}
```

Client-side event handling must support replayed batches and live notifications without duplication. De-duplicate by `(invocationId, seq)` before pushing to the HRC consumer stream.

### 3. Broker CLI and Unix socket server

Repository area: `agent-spaces/packages/harness-broker/src`.

Add CLI:

```bash
harness-broker run \
  --transport unix \
  --socket <path> \
  --runtime-id <runtimeId> \
  --host-session-id <hostSessionId> \
  --generation <generation> \
  --attach-token-file <path> \
  --event-ledger <path> \
  --log-file <path>
```

Keep stdio support for existing tests/migration:

```bash
harness-broker run --transport stdio
```

Refactor `createProtocolServer` so it can bind either stdio streams or a `net.Socket` connection. A Unix server should:

1. Create parent directory with `0700` where possible.
2. Remove stale socket file before bind only after verifying no live server owns it.
3. Bind `server.listen(socketPath)`.
4. Restrict to one active controller connection or use explicit fencing where the latest valid `broker.attach` replaces the prior controller.
5. Close only the controller connection on HRC shutdown; keep the broker process alive.
6. Unlink the socket on broker exit/dispose.

### 4. Broker event ledger

Repository area: `agent-spaces/packages/harness-broker/src`.

The broker must persist events before or atomically with notification. JSONL is sufficient for v1 if writes are append-only and fsynced at lifecycle boundaries; SQLite is better if reused code exists.

Minimum durable record:

```json
{
  "invocationId": "inv-...",
  "seq": 123,
  "time": "2026-06-01T00:00:00.000Z",
  "type": "turn.completed",
  "event": { "...": "full InvocationEventEnvelope" }
}
```

Ledger responsibilities:

- `append(event)` is idempotent by `(invocationId, seq)`.
- `eventsSince(invocationId, afterSeq)` returns ordered events with `seq > afterSeq`.
- `ackEvents(invocationId, throughSeq)` records controller high-water.
- Pruning is allowed only at or below the acknowledged sequence and only if snapshot state remains sufficient for current liveness. For early implementation, do not prune active invocation events.
- On broker restart without driver attach support, the ledger may explain what happened before broker death, but it does not make the TUI controllable again. Do not claim broker restart recovery until driver attach exists.

### 5. Input idempotency ledger

Repository area: `agent-spaces/packages/harness-broker/src/invocation-manager.ts`.

Add `inputId` de-duplication. Current HRC already sends an `inputId` on in-flight input; the broker should persist the disposition for every accepted/rejected input.

Behavior:

- If a duplicate `inputId` arrives with byte-identical input content/policy, return the original `InvocationInputResponse`.
- If a duplicate `inputId` arrives with different content/policy, return a conflict error.
- Store queued, started, and rejected dispositions.
- Include recent `inputDispositions` in `invocation.snapshot`.

This prevents duplicate user turns when HRC reconnects after an ambiguous RPC result.

### 6. Permission reconnect semantics

Repository area: broker protocol, broker, broker client.

Current permission requests are broker-to-client JSON-RPC requests on the live transport. For reconnect:

- Emit `permission.requested` audit event before sending broker-to-client request.
- Store pending permission requests in invocation state and snapshot.
- If HRC disconnects with an outstanding request, keep it pending until deadline.
- On attach, include pending requests in `invocation.snapshot` and allow HRC to answer via `invocation.permission.respond`.
- If deadline expires before response, apply `defaultDecision` and emit `permission.resolved` with `decidedBy: 'timeout'` or equivalent.
- Make `invocation.permission.respond` idempotent by `permissionRequestId`.

### 7. Driver and hook socket changes

Repository area: `agent-spaces/packages/harness-broker/src/drivers`.

The first implementation should not require driver-level TUI attach after broker death. It only requires the broker process to survive HRC restart. However, drivers need better runtime-scoped resources:

- Move Claude/Codex hook sockets under the broker IPC runtime directory.
- Make Codex hook sockets per invocation/runtime, not a single global `/tmp/harness-broker/codex-hooks.sock`.
- Include runtime/generation/invocation identity in hook envelopes or listener context.
- Reject hook envelopes whose callback socket or identity does not match the live invocation.
- Expose terminal surface identity in `invocation.snapshot`.
- Clarify capabilities: current `control.attach: true` on tmux drivers must not be interpreted as “broker can restart and reattach to a live TUI.” Add a distinct capability such as `control.driverAttachExistingSurface` if/when implemented.

### 8. ASP tests

Add tests for:

- Unix transport request/response/notification framing.
- Broker CLI rejects invalid transport and accepts `--transport unix`.
- `BrokerClient.connectUnix()` does not terminate broker on `close()`.
- `broker.attach` success/failure for matching and mismatched runtime/generation/token.
- `eventsSince` replay, empty replay, retention-floor failure, and `ackEvents`.
- Duplicate `invocation.input` with same `inputId` returns original disposition.
- Duplicate `invocation.input` with conflicting content errors.
- Pending permission request survives controller disconnect and is visible on attach.
- Codex and Claude hook sockets are unique per runtime/invocation.

## HRC work

HRC owns runtime selection, persistence, tmux allocation/supervision, startup reconciliation, projection, and CLI/API surfacing.

### 1. Runtime contracts and persistence

Repository areas: `hrc-runtime/packages/hrc-core`, `hrc-store-sqlite`, `hrc-server`.

Extend runtime state to include:

- `broker.endpoint.kind = 'unix-jsonrpc-ndjson'`
- broker IPC socket path
- attach token reference, redacted
- broker tmux pane/window metadata
- TUI tmux pane/window metadata
- `control.mode`
- `control.brokerAttached`
- `control.lastAttachError`
- `eventHighWater`
- broker pid reported by broker
- active controller/server instance id

SQLite may continue storing most of this in `runtime_state_json`, but add columns or indexes if monitor/list/status need fast filtering by `controlMode` or `brokerAttached`.

The existing `broker_invocation_events` table should remain HRC’s projection ledger. Replay should append through the existing idempotent `(invocation_id, seq)` path.

### 2. Tmux manager extensions

Repository area: `hrc-runtime/packages/hrc-server/src/tmux*` / existing `createTmuxManager` implementation.

Current allocation creates one lease pane. Extend it to create a named broker window/pane and a named TUI window/pane under the same per-runtime tmux server.

Needed operations:

```ts
createBrokerRuntimeSession(input): {
  socketPath: string
  sessionName: string
  brokerPane: PaneRef
  tuiPane: PaneRef
}

createWindowWithCommand(input: {
  sessionName: string
  windowName: 'broker'
  command: string[] | string
  env?: Record<string, string>
}): PaneRef

createOrInspectWindow(input: {
  sessionName: string
  windowName: 'tui'
}): PaneRef

inspectPaneProcess(paneId): {
  alive: boolean
  panePid?: number
  currentCommand?: string
  startCommand?: string
}
```

Important behavior:

- Start the broker pane with `exec harness-broker ...`, not pasted text.
- The TUI pane remains the lease passed to `InvocationDispatchRequest.runtime.terminalSurface`.
- `hrc runtime attach` defaults to the TUI pane/window.
- Broker pane attach/log inspection is a separate diagnostic path.
- Reconciliation checks both broker pane and TUI pane identities; do not rely on pane IDs alone if generation/token/process identity mismatches.

### 3. Broker process launch flow

Repository area: `hrc-runtime/packages/hrc-server/src/broker/controller.ts` and server runtime launch code.

Replace stdio-only launch for interactive durable broker runtimes:

Current:

```text
BrokerClient.start({ command: 'harness-broker', args: ['run', '--transport', 'stdio'] })
```

Target:

```text
allocate existing per-runtime btmux server/session
create broker IPC dir + attach token
start broker in tmux broker window with --transport unix
connect BrokerClient.connectUnix(socketPath)
hello
invocation.start with frozen start request + runtime.terminalSurface = TUI pane lease
consume events
```

Headless broker runtimes may remain stdio-child in the first cut unless/until they also need restart durability. Do not mix headless broker recovery semantics with interactive tmux recovery; headless has no durable TUI process after HRC restart.

### 4. Startup reconciliation and active map rebuild

Repository area: `hrc-runtime/packages/hrc-server/src/index.ts`, `broker/controller.ts`.

Add a reconciliation pass before orphan sweeping:

```text
for each non-terminal runtime where controllerKind == harness-broker:
  if runtime.transport != tmux:
    existing headless orphan behavior applies
  else:
    inspect btmux socket/session
    inspect broker and tui panes
    if broker socket exists:
      connect unix client
      hello
      attach
      snapshot
      eventsSince(lastEventSeq)
      project replay
      ackEvents
      controller.active.set(runtimeId, client/invocationId)
      mark brokerAttached true
    else if tui pane live and lease identity matches:
      mark direct-tmux-degraded
    else:
      mark stale/dead and dispose according to existing policy
```

Do not sweep claimed btmux sessions until after attach/reassociation attempts. The existing orphan sweeper should be extended to understand broker and TUI windows so it does not kill a live runtime because only one pane is missing during a crash window.

### 5. Event replay projection

Repository area: `hrc-runtime/packages/hrc-server/src/broker/controller.ts`, `event-mapper.ts`.

Replay path should use the same mapper as live events:

```text
for event in replayedEvents:
  mapper.apply(event) // existing idempotent append/projection
  update lastEventSeq
ackEvents(throughSeq = maxProjectedSeq)
then attach live notification stream
```

Failure cases:

- Replay conflict in HRC DB: mark runtime `stale`, close client, do not continue.
- Broker retention floor is above HRC lastEventSeq: mark runtime unsafe unless `invocation.snapshot` can prove no lifecycle events were missed. Conservative default: `stale`.
- Broker state says invocation terminal: project events, mark runtime according to existing terminal mapping, do not leave ready.
- HRC fails after projection but before ack: on next startup, broker replays the same events; HRC idempotent append handles duplicates.

### 6. Dispatch behavior and degraded direct-tmux mode

Repository area: `hrc-runtime/packages/hrc-server/src/index.ts`.

Normal in-flight input:

```text
HRC dispatchTurn -> broker controller dispatchInput -> Unix socket invocation.input
```

If broker IPC is attached, direct tmux fallback should not run.

If broker IPC is unavailable but runtime is marked `direct-tmux-degraded`, allow only explicit plain-text delivery. Suggested response semantics:

```json
{
  "status": "started",
  "controlMode": "direct-tmux-degraded",
  "semanticCompletion": false,
  "supportsInFlightInput": false,
  "warning": "input delivered directly to TUI; broker queueing/events/permissions unavailable"
}
```

Change current fallback behavior:

- Do not mark the run `completed` immediately after `sendKeys`.
- Do not emit `turn.completed` without a real broker/hook event.
- Record `turn.accepted` / `turn.user_prompt` / `turn.started` only if those names are acceptable for degraded delivery; otherwise add a distinct diagnostic event such as `turn.degraded_input_delivered`.
- Keep delayed literal `sendKeys` behavior because it is known to work for direct TUI recovery.

### 7. API/CLI/monitoring surfacing

Repository areas: `hrc-runtime/packages/hrc-cli`, `hrc-core`, `hrc-sdk`.

Expose:

- `controlMode`
- `brokerAttached`
- broker IPC socket path, redacted token
- broker tmux pane/window
- TUI tmux pane/window and attach descriptor
- last broker event high-water
- replay status on startup
- degraded fallback reason

`hrc runtime inspect` should clearly distinguish:

```text
Broker control: attached over Unix IPC
Operator attach: tmux TUI window
Broker process: tmux broker window
```

`hrc server tmux status` and broker lease kill/sweep commands should operate on the per-runtime `btmux` namespace and show both broker/TUI panes.

### 8. Security and filesystem policy

Repository area: both ASP and HRC.

- Use owner-only directories for broker IPC artifacts.
- Redact attach tokens from API/CLI output.
- Validate `runtimeId`, `hostSessionId`, `generation`, `invocationId`, `startRequestHash`, and `selectedProfileHash` during attach.
- Use short socket paths and fail early if path length exceeds platform `sockaddr_un` limits. Prefer `runtimeRoot/bipc/<hash>/b.sock` over deep names if needed.
- Remove stale socket files only when no live socket server responds.
- Consider OS peer credential checks if Bun/Node exposes them sufficiently; otherwise rely on owner-only directory plus attach token.
- Handle split-brain: if two HRC instances attach, broker should either reject the second or fence the first. Recommended: latest valid controller attach wins, old connection receives a terminal control error and is closed.

### 9. HRC tests

Add tests for:

- Existing stdio path remains valid for headless broker runtimes.
- Interactive broker starts broker pane and TUI pane under one existing per-runtime `btmux` socket.
- HRC restart reconnects to the broker Unix socket and rebuilds `HarnessBrokerController.active`.
- Events emitted while HRC is down are replayed and projected.
- HRC crash after event projection but before ack replays idempotently.
- HRC crash after input accepted but before response does not duplicate user input on retry.
- `/quit` while HRC is down replays terminal/continuation events and marks runtime `terminated`.
- Broker socket missing + TUI live yields `direct-tmux-degraded`, not healthy broker mode.
- Degraded direct-tmux input does not emit fake `turn.completed`.
- Broker pane dead + TUI pane live does not claim broker attach; direct fallback only if explicitly allowed.
- Broker/TUI pane generation mismatch marks stale.
- Orphan sweep preserves claimed healthy runtimes and kills unclaimed/stale broker sessions after grace.
- Runtime attach opens TUI pane, not broker pane.

## Alternatives considered

| Alternative | Assessment |
|---|---|
| Keep stdio child + direct tmux fallback | Lowest implementation cost, but keeps the core failure and bypasses broker semantics. Not acceptable as normal control. |
| Separate tmux server/session per broker | Worse than reusing existing `btmux`; duplicates lifecycle/sweep ownership and complicates attach UX. Reject. |
| Broker process in existing per-runtime tmux lease + Unix IPC | Best near-term fit. Reuses current tmux lease ownership while making broker control reconnectable. Recommended. |
| Detached broker daemon process with pidfile/socket, no tmux | Cleaner process model in isolation, but HRC would need new supervision/orphan/logging/operator-inspection logic. It does not remove the need for attach/replay. Defer. |
| launchd/systemd per runtime broker | Stronger supervision, but OS-specific and heavyweight for dynamic runtime processes. It still does not solve broker in-memory invocation restore. Defer. |
| Shared multi-invocation broker daemon | Architecturally possible later, but current broker advertises `multiInvocation: false` and rejects concurrent active invocations. Too broad for this fix. |

## Implementation phases

### Phase 0: tighten current fallback

HRC-only safety fix:

- Rename current fallback to `direct-tmux-degraded`.
- Persist `brokerAttached: false` and `controlMode` when fallback is used.
- Stop marking degraded direct-tmux runs as completed immediately.
- Surface degraded mode in inspect/monitor.

This reduces false success before the Unix transport lands.

### Phase 1: ASP Unix transport and protocol v2

ASP work:

- Add `unix-jsonrpc-ndjson` transport capability.
- Add Unix socket server mode to `harness-broker run`.
- Add Unix socket client transport.
- Export/formalize attach/replay/snapshot/ack protocol.
- Keep stdio tests passing.

HRC work:

- Accept both stdio and Unix endpoint kinds in type contracts.
- Add feature flags or route guards for interactive durable broker IPC.

### Phase 2: broker event/input/permission durability

ASP work:

- Add broker-side event ledger.
- Add `eventsSince` and `ackEvents`.
- Add `inputId` idempotency.
- Add permission pending snapshot/respond semantics.

HRC work:

- Project replayed events idempotently.
- Ack broker events after projection.
- Treat retention gaps as unsafe.

### Phase 3: broker in existing per-runtime tmux lease

ASP work:

- Move hook sockets under runtime IPC directory.
- Ensure drivers report terminal surface identity in snapshot.

HRC work:

- Extend tmux manager for broker and TUI windows.
- Start broker with tmux command/`exec`.
- Connect over Unix socket.
- Pass TUI pane lease to `InvocationDispatchRequest.runtime.terminalSurface`.
- Persist broker and TUI pane metadata separately.

### Phase 4: restart reattachment

HRC work:

- Startup reconciliation connects to broker IPC.
- Run `broker.attach`, snapshot, replay, ack.
- Rebuild `HarnessBrokerController.active`.
- Preserve healthy broker/TUI tmux sessions during sweep.

ASP work:

- Harden controller fencing and attach-token validation.
- Add retention-floor errors.

### Phase 5: harden and remove unsafe assumptions

- Make inspect/status/adopt/sweep broker-aware.
- Add diagnostics for broker-detached/TUI-live runtimes.
- Add integration coverage for HRC restart, broker death, TUI death, `/quit`, and ambiguous input response.
- Decide later whether broker restart can attach to existing TUI. Do not claim this until drivers implement explicit attach-to-existing-surface semantics.

## Acceptance criteria

The implementation is acceptable when:

1. A Claude/Codex interactive broker runtime can receive a turn, HRC can restart, and a later `hrcchat dm`/`hrc run --no-attach` routes through broker IPC, not direct tmux fallback.
2. Events emitted while HRC is down replay into HRC SQLite and update run/runtime state correctly.
3. A user `/quit` while HRC is down causes the next reconciliation to mark the runtime `terminated` and the next run creates a fresh TUI.
4. Duplicate input retry after reconnect does not duplicate the user prompt.
5. Pending permission request behavior is deterministic across HRC disconnect/reconnect.
6. `hrc runtime inspect` shows broker control attachment separately from operator TUI attachment.
7. Killing the broker pane while leaving the TUI pane alive results in explicit degraded mode or stale/dead state, never silent healthy broker mode.
8. Direct tmux fallback no longer emits fake completion.
9. No additional per-broker tmux server/socket is created; all broker/TUI panes for a runtime live under the existing per-runtime `btmux` socket.

## Final recommendation

Implement the proposal as **Unix socket broker IPC with attach/replay, broker-side event/input/permission durability, and broker process supervision inside the existing per-runtime HRC tmux lease**.

Reject a separate tmux-per-broker server. It is not the simplest durable boundary in this repo because HRC already has a per-runtime tmux ownership model, a `btmux` namespace, startup reassociation, attach descriptors, and orphan sweeping. The missing piece is not more tmux; it is reconnectable broker protocol state.
