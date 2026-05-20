# Harness Broker Specification

**Spec version:** `harness-broker/0.1-draft`  
**Status:** Draft for implementation planning  
**First supported harness:** Codex app-server  
**Reference client:** any runtime controller; HRC is only one example implementation

## 1. Purpose

Harness Broker is a small execution component that provides a single, provider-neutral control and event interface for running agent harnesses. It starts a harness invocation, sends input, applies supported control operations, normalizes streaming events, and returns continuation/result information.

The broker is intentionally **not** a compiler, placement engine, bundle materializer, runtime store, session database, tmux manager, or operator UI. Those responsibilities belong to clients or upstream build-time systems.

### 1.1 Core contract

```text
Client / Runtime Controller
  │
  │  JSON-RPC 2.0 over NDJSON
  │  commands, responses, async events
  ▼
Harness Broker
  │
  │  driver-owned transport
  │  e.g. Codex app-server JSON-RPC over child stdio
  ▼
Harness Process
```

### 1.2 Design principles

1. **Compile before broker.** The broker receives an already-compiled invocation spec. It does not resolve targets, compose tools, select a provider, or materialize bundles.
2. **Provider details stay in drivers.** Clients talk to broker commands and normalized event types. Codex/Pi/Claude-specific operations are contained by driver config and driver code.
3. **One structured protocol channel.** Commands, responses, and async broker events share one broker protocol transport. Raw harness stdout/stderr/pty traffic never shares the broker protocol stream.
4. **No durable state in broker.** Broker state is in-memory and scoped to a running broker process. Clients own persistence, replay, operator state, and recovery policy.
5. **Capability-first semantics.** The broker reports what the active driver supports. If an input/control operation is unsupported, the broker rejects it with a normalized error rather than leaking provider-specific behavior.
6. **Safe by default.** The broker spawns exact argv without a shell, treats env and attachment paths as sensitive, and avoids echoing secrets in events.

## 2. Definitions

| Term | Meaning |
|---|---|
| Client | Any process that starts or connects to a broker and speaks the broker protocol. |
| Broker | Process implementing this spec. |
| Invocation | A broker-managed logical harness execution context. In v0, normally one invocation per broker process. |
| Turn | A single unit of user input and harness response inside an invocation. |
| Harness | The actual provider/frontend runtime, for example Codex app-server. |
| Driver | Broker module that maps generic commands/events to a harness-specific transport. |
| Continuation | Provider-specific handle that lets a later invocation resume context, such as a Codex thread id. |
| Compiled invocation spec | Build-time output consumed by the broker. It contains process, cwd, env, driver kind, and driver config. |

## 3. Non-goals

Harness Broker must not provide:

- Target selection, placement resolution, or bundle materialization.
- Harness catalog management.
- Session/run database records.
- Durable event persistence, event replay, fences, or zombie recovery.
- tmux ownership or terminal multiplexer lifecycle.
- Operator/chat CLI semantics.
- Build-time validation beyond invocation-spec structural validation.
- Provider choice. The client gives the broker the chosen driver and exact process configuration.

The broker may expose diagnostics and capability metadata, but it must not encode the client’s session model.

## 4. Process model

### 4.1 Recommended v0 shape

Use **one broker process per invocation**.

```text
client process
  ├─ broker process
  │    └─ harness child process, e.g. codex app-server
  └─ client-owned persistence / terminal / supervision
```

This is the preferred initial design because it keeps lifecycle and fault isolation simple. If the harness wedges, the client can stop the broker process. If the client exits, the broker can be reaped by the client’s process supervision strategy.

The protocol still includes `invocationId`, so a future daemon or per-runtime broker can support multiple invocations without changing event schemas.

### 4.2 Broker stdio ownership

For the default transport:

```text
broker stdin   = broker protocol input only
broker stdout  = broker protocol output only
broker stderr  = broker diagnostics only; never machine-required protocol data
```

Harness stdio is always owned by the driver. For Codex app-server, the driver creates a child process with piped stdin/stdout and speaks Codex JSON-RPC over those pipes.

### 4.3 tmux and pty ownership

The broker does not own tmux. A client or external supervisor may launch the broker inside tmux, attach a terminal UI to broker events, or allocate terminal resources. The broker may support pty-backed harness drivers in future versions, but tmux session/window/pane lifecycle is outside this spec.

For v0 Codex app-server, `harnessTransport.kind` is `jsonrpc-stdio`; no pty is required.

## 5. Transport protocol

### 5.1 Default transport

The default broker transport is:

```ts
export interface StdioJsonRpcNdjsonTransport {
  kind: 'stdio-jsonrpc-ndjson'
  stdin: 0
  stdout: 1
  stderr: 'diagnostics-only'
}
```

Messages are JSON-RPC 2.0 objects framed by a single newline. Each line MUST contain exactly one JSON object.

### 5.2 Message types

The broker protocol supports:

- Client-to-broker JSON-RPC requests.
- Broker-to-client JSON-RPC responses.
- Broker-to-client JSON-RPC notifications for async events.
- Optional broker-to-client JSON-RPC requests for permission decisions, only when negotiated.

Async invocation events are notifications:

```json
{
  "jsonrpc": "2.0",
  "method": "invocation.event",
  "params": {
    "invocationId": "inv_01J...",
    "seq": 12,
    "time": "2026-05-20T18:12:34.123Z",
    "type": "assistant.message.delta",
    "turnId": "turn_abc",
    "payload": { "text": "working..." }
  }
}
```

### 5.3 Ordering

- `seq` is monotonically increasing per invocation and starts at `1`.
- Responses may interleave with event notifications.
- Within a single broker process and invocation, events are emitted in the order observed or generated by the driver.
- The broker is not a durable event log. Clients that need replay must persist events.

## 6. Compiled invocation spec

The broker consumes a compiled invocation spec. The spec is not a launch envelope for a particular client and must not contain runtime database ids, run ids, tmux ids, callback socket paths, spool directories, or persistence concepts.

```ts
export interface HarnessInvocationSpec {
  specVersion: 'harness-broker.invocation/v1'

  /** Client-chosen stable identifier for this invocation, or omitted for broker-generated id. */
  invocationId?: string

  /** Human/debug labels only. The broker must not interpret client-specific semantics. */
  labels?: Record<string, string>

  harness: HarnessDescriptor
  process: HarnessProcessSpec
  interaction?: InteractionSpec
  continuation?: ContinuationSpec

  /** Driver-specific config. The shape is selected by harness.driver. */
  driver: CodexAppServerDriverSpec | UnknownDriverSpec

  /** Optional opaque correlation echoed in events, never interpreted by the broker. */
  correlation?: Record<string, string>
}

export interface HarnessDescriptor {
  /** Stable frontend/harness name, e.g. 'codex'. */
  frontend: string

  /** Stable provider family, e.g. 'openai'. */
  provider?: string

  /** Broker driver implementation. */
  driver: 'codex-app-server' | string
}

export interface HarnessProcessSpec {
  /** Executable path or command resolved by the client environment. No shell. */
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>

  /** Driver transport to the harness child process. */
  harnessTransport: HarnessTransportSpec

  /** Optional process limits requested by client. Enforcement is best-effort unless supported. */
  limits?: ProcessLimits
}

export type HarnessTransportSpec =
  | { kind: 'jsonrpc-stdio' }
  | { kind: 'pipes' }
  | { kind: 'pty'; cols?: number; rows?: number }

export interface InteractionSpec {
  mode: 'headless' | 'interactive' | 'service'
  turnConcurrency?: 'single'
  inputQueue?: 'none' | 'fifo'
}

export interface ContinuationSpec {
  provider: string
  key: string
  kind?: 'thread' | 'session' | 'conversation' | string
}

export interface ProcessLimits {
  startupTimeoutMs?: number
  turnTimeoutMs?: number
  stopGraceMs?: number
  maxEventBytes?: number
}

export interface UnknownDriverSpec {
  kind: string
  [key: string]: unknown
}
```

### 6.1 Codex app-server driver spec

```ts
export interface CodexAppServerDriverSpec {
  kind: 'codex-app-server'

  /** Thread id to resume. Equivalent to continuation.key when continuation.provider is 'codex'. */
  resumeThreadId?: string

  model?: string
  modelReasoningEffort?: string
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  profile?: string

  /** Paths supplied later in input can also include images. */
  defaultImageAttachments?: string[]

  /** How to respond when Codex asks the client for permission. */
  permissionPolicy?: PermissionPolicy

  /** Whether to retry resume by starting a fresh thread when Codex reports the thread is missing. */
  resumeFallback?: 'start-fresh' | 'fail'
}

export interface PermissionPolicy {
  mode: 'deny' | 'allow' | 'ask-client'
  timeoutMs?: number
  defaultDecision?: 'deny' | 'allow'
}
```

### 6.2 Codex app-server example spec

```json
{
  "specVersion": "harness-broker.invocation/v1",
  "harness": {
    "frontend": "codex",
    "provider": "openai",
    "driver": "codex-app-server"
  },
  "process": {
    "command": "codex",
    "args": ["--enable", "goals", "app-server"],
    "cwd": "/workspace/project",
    "env": {
      "CODEX_HOME": "/workspace/.codex-home"
    },
    "harnessTransport": { "kind": "jsonrpc-stdio" },
    "limits": {
      "startupTimeoutMs": 20000,
      "turnTimeoutMs": 900000,
      "stopGraceMs": 5000
    }
  },
  "interaction": {
    "mode": "headless",
    "turnConcurrency": "single",
    "inputQueue": "none"
  },
  "driver": {
    "kind": "codex-app-server",
    "model": "gpt-5.5-codex",
    "approvalPolicy": "never",
    "sandboxMode": "workspace-write",
    "resumeFallback": "start-fresh",
    "permissionPolicy": { "mode": "deny" }
  }
}
```

## 7. Commands

All commands are JSON-RPC requests sent from client to broker unless otherwise noted.

### 7.1 `broker.hello`

Negotiates protocol version and capabilities. This should be the first request after broker process start.

Request:

```ts
export interface BrokerHelloRequest {
  clientInfo: {
    name: string
    version?: string
  }
  protocolVersions: string[]
  capabilities?: ClientCapabilities
}

export interface ClientCapabilities {
  permissionRequests?: boolean
  eventAcks?: boolean
}
```

Response:

```ts
export interface BrokerHelloResponse {
  brokerInfo: {
    name: 'harness-broker'
    version: string
  }
  protocolVersion: 'harness-broker/0.1'
  capabilities: BrokerCapabilities
  drivers: DriverSummary[]
}

export interface BrokerCapabilities {
  multiInvocation: boolean
  transports: Array<'stdio-jsonrpc-ndjson'>
  eventNotifications: true
  brokerToClientRequests: boolean
}

export interface DriverSummary {
  kind: string
  version: string
  available: boolean
  capabilities?: InvocationCapabilities
  unavailableReason?: string
}
```

Example:

```json
{"jsonrpc":"2.0","id":"1","method":"broker.hello","params":{"clientInfo":{"name":"example-client"},"protocolVersions":["harness-broker/0.1"],"capabilities":{"permissionRequests":true}}}
```

### 7.2 `broker.health`

Returns broker health and active invocation count. This does not probe external harness command availability unless `probeDrivers` is true.

Request:

```ts
export interface BrokerHealthRequest {
  probeDrivers?: boolean
}
```

Response:

```ts
export interface BrokerHealthResponse {
  status: 'ok' | 'degraded' | 'shutting_down'
  activeInvocations: number
  drivers?: DriverSummary[]
}
```

### 7.3 `invocation.start`

Starts a harness invocation from a compiled spec. For v0, a broker may reject this if an invocation already exists.

Request:

```ts
export interface InvocationStartRequest {
  spec: HarnessInvocationSpec

  /** Optional convenience; semantically equivalent to start followed by invocation.input. */
  initialInput?: InvocationInput
}
```

Response:

```ts
export interface InvocationStartResponse {
  invocationId: string
  state: InvocationState
  capabilities: InvocationCapabilities
}

export type InvocationState =
  | 'starting'
  | 'ready'
  | 'turn_active'
  | 'stopping'
  | 'exited'
  | 'failed'
  | 'disposed'
```

Expected events after success:

1. `invocation.started`
2. `invocation.ready`
3. `continuation.updated`, if the driver establishes a resumable continuation
4. If `initialInput` is present, input and turn events

### 7.4 `invocation.input`

Submits input to an invocation. The broker decides how to apply the input based on driver capability and request policy.

Request:

```ts
export interface InvocationInputRequest {
  invocationId: string
  input: InvocationInput
  policy?: InputPolicy
}

export interface InvocationInput {
  inputId?: string
  kind: 'user' | 'steer' | 'append_context'
  content: InputContent[]
  metadata?: Record<string, string>
}

export type InputContent =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string }
  | { type: 'file_ref'; path: string; mimeType?: string }

export interface InputPolicy {
  whenBusy: 'reject' | 'queue' | 'interrupt_then_apply'
  timeoutMs?: number
}
```

Response:

```ts
export interface InvocationInputResponse {
  inputId: string
  accepted: boolean
  disposition: 'started' | 'queued' | 'rejected'
  reason?: string
  turnId?: string
}
```

Rules:

- `user` starts a new turn if the invocation is ready.
- `steer` attempts to affect the active turn. If unsupported, the broker rejects it unless `whenBusy` permits queuing as a future user turn.
- `append_context` attempts to add context without necessarily changing the user-visible prompt. If unsupported, reject or queue according to policy.
- For Codex app-server v0, only `user` input is supported. Images are supported as local image paths when passed as turn input. `steer` and `append_context` are rejected unless explicitly configured to queue as a later `user` turn.

### 7.5 `invocation.interrupt`

Attempts to interrupt active work without necessarily ending the invocation.

Request:

```ts
export interface InvocationInterruptRequest {
  invocationId: string
  scope: 'turn' | 'invocation'
  reason?: string
  graceMs?: number
}
```

Response:

```ts
export interface InvocationInterruptResponse {
  accepted: boolean
  effect: 'turn_interrupted' | 'invocation_stopping' | 'unsupported' | 'no_active_turn'
  reason?: string
}
```

Rules:

- If the driver has a protocol-level turn interrupt, use it.
- If only process-level termination is available and `scope` is `turn`, reject unless the driver declares that process termination is the interrupt strategy.
- For Codex app-server v0, turn interrupt is **not supported unless a Codex protocol interrupt method is verified**. `invocation.interrupt({scope:'turn'})` should return `unsupported`. `scope:'invocation'` may map to `invocation.stop`.

### 7.6 `invocation.stop`

Stops the invocation and its harness process.

Request:

```ts
export interface InvocationStopRequest {
  invocationId: string
  reason?: string
  graceMs?: number
}
```

Response:

```ts
export interface InvocationStopResponse {
  accepted: boolean
  state: InvocationState
}
```

Expected events:

1. `invocation.stopping`
2. `turn.interrupted` or `turn.failed`, if a turn was active and cannot complete
3. `invocation.exited`

### 7.7 `invocation.status`

Returns current in-memory state.

Request:

```ts
export interface InvocationStatusRequest {
  invocationId: string
}
```

Response:

```ts
export interface InvocationStatusResponse {
  invocationId: string
  state: InvocationState
  currentTurnId?: string
  continuation?: ContinuationUpdate
  capabilities: InvocationCapabilities
  process?: {
    pid?: number
    exitCode?: number | null
    signal?: string | null
  }
}
```

### 7.8 `invocation.dispose`

Releases broker resources after the invocation has exited. In one-broker-per-invocation mode, the broker may exit after acknowledging dispose.

Request:

```ts
export interface InvocationDisposeRequest {
  invocationId: string
}
```

Response:

```ts
export interface InvocationDisposeResponse {
  disposed: true
}
```

### 7.9 Optional broker-to-client request: `invocation.permission.request`

A driver may need a permission decision. This method is broker-to-client, only if negotiated in `broker.hello`. If not negotiated, the driver must apply its configured `permissionPolicy` locally.

Request from broker to client:

```ts
export interface PermissionRequestParams {
  invocationId: string
  turnId?: string
  permissionRequestId: string
  kind: 'command' | 'file_change' | 'tool' | string
  subject: unknown
  defaultDecision: 'allow' | 'deny'
  deadlineMs?: number
}
```

Client response:

```ts
export interface PermissionDecision {
  decision: 'allow' | 'deny'
  message?: string
}
```

For Codex app-server v0, the default recommended policy is `deny`, matching a safe non-interactive posture. `ask-client` can be added once the reference client supports broker-to-client requests.

## 8. Capabilities

Capabilities are returned by `broker.hello`, `invocation.start`, and `invocation.status`.

```ts
export interface InvocationCapabilities {
  input: {
    user: boolean
    steer: boolean
    appendContext: boolean
    localImages: boolean
    fileRefs: boolean
    queue: boolean
  }
  turns: {
    concurrency: 'single' | 'multiple'
    interrupt: 'unsupported' | 'protocol' | 'process'
  }
  continuation: {
    supported: boolean
    provider?: string
    keyKind?: string
  }
  events: {
    assistantDeltas: boolean
    toolCalls: boolean
    usage: boolean
    diagnostics: boolean
  }
  control: {
    stop: boolean
    dispose: boolean
  }
}
```

Codex app-server v0 capabilities:

```json
{
  "input": {
    "user": true,
    "steer": false,
    "appendContext": false,
    "localImages": true,
    "fileRefs": false,
    "queue": false
  },
  "turns": {
    "concurrency": "single",
    "interrupt": "unsupported"
  },
  "continuation": {
    "supported": true,
    "provider": "codex",
    "keyKind": "thread"
  },
  "events": {
    "assistantDeltas": true,
    "toolCalls": true,
    "usage": true,
    "diagnostics": true
  },
  "control": {
    "stop": true,
    "dispose": true
  }
}
```

## 9. Event model

### 9.1 Event envelope

```ts
export interface InvocationEventEnvelope<TPayload = unknown> {
  invocationId: string
  seq: number
  time: string
  type: InvocationEventType
  payload: TPayload

  turnId?: string
  inputId?: string
  itemId?: string
  correlation?: Record<string, string>
  driver?: {
    kind: string
    rawType?: string
  }
}
```

### 9.2 Event types

```ts
export type InvocationEventType =
  | 'invocation.started'
  | 'invocation.ready'
  | 'invocation.stopping'
  | 'invocation.exited'
  | 'invocation.failed'
  | 'invocation.disposed'
  | 'continuation.updated'
  | 'input.accepted'
  | 'input.rejected'
  | 'input.queued'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.interrupted'
  | 'assistant.message.started'
  | 'assistant.message.delta'
  | 'assistant.message.completed'
  | 'tool.call.started'
  | 'tool.call.delta'
  | 'tool.call.completed'
  | 'tool.call.failed'
  | 'usage.updated'
  | 'diagnostic'
  | 'driver.notice'
```

### 9.3 Broker-owned fields

The broker owns:

- `invocationId`
- `seq`
- `time`
- `type`
- `turnId` when produced or learned from the harness
- `inputId` if client omits one
- `itemId` for assistant/tool stream items
- normalized payload shape

The broker only echoes `correlation`; it must not interpret it.

### 9.4 Payload sketches

```ts
export interface InvocationStartedPayload {
  pid?: number
  command: string
  args: string[]
  cwd: string
}

export interface ContinuationUpdate {
  provider: string
  key: string
  kind?: string
}

export interface TurnStartedPayload {
  turnId: string
}

export interface AssistantMessageDeltaPayload {
  messageId: string
  text: string
}

export interface AssistantMessageCompletedPayload {
  messageId: string
  content: Array<{ type: 'text'; text: string }>
  final?: boolean
}

export interface ToolCallStartedPayload {
  toolCallId: string
  name: string
  input?: unknown
}

export interface ToolCallDeltaPayload {
  toolCallId: string
  text?: string
  data?: unknown
}

export interface ToolCallCompletedPayload {
  toolCallId: string
  name: string
  result?: unknown
  isError?: boolean
  durationMs?: number
}

export interface TurnCompletedPayload {
  turnId: string
  status: 'completed' | 'failed' | 'interrupted'
  finalOutput?: string
  usage?: unknown
}

export interface DiagnosticPayload {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  source?: 'broker' | 'harness' | 'driver'
  data?: unknown
}
```

## 10. Codex app-server driver

### 10.1 Responsibilities

The Codex app-server driver owns:

- Spawning the configured Codex process with exact `command`, `args`, `cwd`, and sanitized `env`.
- Speaking Codex app-server JSON-RPC over the child process stdio.
- Initializing the app-server protocol.
- Starting or resuming a Codex thread.
- Starting turns from normalized `user` input.
- Handling Codex notifications and requests.
- Mapping Codex thread/turn/items to broker events.
- Stopping the child process safely.

It does not own target composition, Codex home generation, MCP config creation, or provider choice.

### 10.2 Startup sequence

```text
Client                  Broker                    Codex app-server
  │ broker.hello          │                               │
  │──────────────────────▶│                               │
  │◀──────────────────────│                               │
  │ invocation.start      │                               │
  │──────────────────────▶│ spawn codex ... app-server    │
  │                       │──────────────────────────────▶│
  │                       │ initialize                    │
  │                       │──────────────────────────────▶│
  │                       │◀──────────────────────────────│
  │                       │ initialized                   │
  │                       │──────────────────────────────▶│
  │                       │ thread/start or thread/resume │
  │                       │──────────────────────────────▶│
  │                       │◀──────────────────────────────│
  │◀─ invocation.started ─│                               │
  │◀─ continuation.updated│                               │
  │◀─ invocation.ready ───│                               │
```

### 10.3 Turn sequence

```text
Client                  Broker                    Codex app-server
  │ invocation.input      │                               │
  │──────────────────────▶│ turn/start                    │
  │                       │──────────────────────────────▶│
  │◀─ input.accepted ─────│                               │
  │◀─ turn.started ───────│◀──── turn/started ────────────│
  │◀─ assistant/tool ... ─│◀──── item/* notifications ────│
  │◀─ turn.completed ─────│◀──── turn/completed ──────────│
```

### 10.4 Codex protocol mapping

| Codex app-server message | Broker event/action |
|---|---|
| response to `thread/start` / `thread/resume` | `continuation.updated` with `provider:'codex'`, `kind:'thread'` |
| `turn/started` | `turn.started` |
| `thread/tokenUsage/updated` | `usage.updated` |
| `item/started` where item is `agentMessage` | `assistant.message.started` |
| `item/agentMessage/delta` | `assistant.message.delta` |
| `item/completed` where item is `agentMessage` | `assistant.message.completed` |
| `item/started` where item is `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, `imageView` | `tool.call.started` |
| `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/mcpToolCall/progress` | `tool.call.delta` |
| `item/completed` for tool-like item | `tool.call.completed` or `tool.call.failed` |
| `turn/completed` | `turn.completed`, `turn.failed`, or `turn.interrupted` based on status |
| `error` notification | `diagnostic` and either `turn.failed` or `invocation.failed` depending on active state |
| child stderr line | `diagnostic` with `source:'harness'` unless suppressed by config |
| child exit | `invocation.exited` |

### 10.5 Resume fallback

If `resumeThreadId` is present and Codex reports that no rollout/thread exists, behavior is controlled by `driver.resumeFallback`:

- `start-fresh`: emit `driver.notice`, start a new thread, and emit `continuation.updated` with the new key.
- `fail`: emit `invocation.failed` and reject/terminate the invocation.

### 10.6 Permission handling

Codex may send request messages such as command/file-change approval requests. The driver handles these according to `permissionPolicy`:

- `deny`: immediately return denial.
- `allow`: immediately return approval. This should be rare and explicit.
- `ask-client`: send `invocation.permission.request` to the client and await a response within `timeoutMs`; if timed out, apply `defaultDecision` or deny.

## 11. State machines

### 11.1 Invocation state

```text
            ┌──────────┐
            │ starting │
            └────┬─────┘
                 │ app-server initialized + thread ready
                 ▼
              ┌───────┐
       ┌─────▶│ ready │◀──────────────┐
       │      └───┬───┘               │
       │          │ input accepted     │ turn completed
       │          ▼                   │
       │   ┌─────────────┐            │
       │   │ turn_active │────────────┘
       │   └──────┬──────┘
       │          │ stop / fatal error
       ▼          ▼
 ┌──────────┐  ┌────────┐
 │ stopping │─▶│ exited │─▶ disposed
 └──────────┘  └────────┘
       │
       ▼
    failed
```

### 11.2 Input policy state

```text
ready + user input       -> accepted, turn starts
turn_active + user/reject -> input.rejected
turn_active + user/queue  -> input.queued, starts after active turn if queue supported
turn_active + steer       -> apply if supported, else reject
turn_active + append      -> apply if supported, else reject or queue by policy
```

For Codex app-server v0: no queue, no steer, no append-context. Single active turn only.

## 12. Error model

Use standard JSON-RPC error codes for protocol errors and broker-defined codes for domain errors.

```ts
export enum BrokerErrorCode {
  UnknownInvocation = -32001,
  InvalidInvocationState = -32002,
  UnsupportedCapability = -32003,
  InputRejected = -32004,
  HarnessError = -32005,
  Timeout = -32006,
  ResourceError = -32007,
  ShutdownInProgress = -32008,
  DriverUnavailable = -32009
}
```

Error response example:

```json
{
  "jsonrpc": "2.0",
  "id": "req_7",
  "error": {
    "code": -32003,
    "message": "Codex app-server driver does not support steer input during an active turn",
    "data": {
      "capability": "input.steer",
      "invocationId": "inv_01J..."
    }
  }
}
```

Fatal driver errors should also emit events, so clients that persist only events can observe terminal outcomes.

## 13. Security and environment handling

### 13.1 Process spawning

- Spawn by exact command and args; never use a shell.
- Validate `cwd` exists and is a directory before spawn.
- Treat env values as sensitive. Do not echo full env in events.
- Prefer allowlisted env construction by the upstream compiler/materializer. The broker may reject obviously invalid env keys but should not invent build-time env.
- Do not expand `~`, `$VAR`, glob patterns, or shell syntax.

### 13.2 Sensitive event data

The broker should redact by default:

- Environment values.
- Authorization headers or tokens found in diagnostics.
- Full local file contents unless emitted by the harness as intentional model/tool output.
- Attachment binary content.

### 13.3 Path handling

For local images or file refs:

- Paths are local to the broker/harness execution environment.
- Driver should pass paths through only when the harness supports them.
- Optional future policy may restrict paths to cwd or declared readable roots.

## 14. CLI shape

A minimal broker CLI:

```text
harness-broker run --transport stdio
harness-broker validate-spec < spec.json
harness-broker drivers --json
```

`harness-broker run` starts the broker protocol loop. It does not take compile-time options. Clients send `invocation.start` over the protocol.

For local testing, an optional helper may run a single invocation from a JSON file:

```text
harness-broker run-once --spec invocation.json --input input.json
```

`run-once` is a development convenience and should internally use the same protocol/driver path.

## 15. Package architecture

Recommended package split:

```text
packages/
  harness-broker-protocol/
    src/types.ts
    src/jsonrpc.ts
    src/schemas.ts

  harness-broker/
    src/cli.ts
    src/broker.ts
    src/protocol-server.ts
    src/invocation-manager.ts
    src/events.ts
    src/errors.ts
    src/security/redaction.ts
    src/drivers/driver.ts
    src/drivers/codex-app-server/driver.ts
    src/drivers/codex-app-server/rpc-client.ts
    src/drivers/codex-app-server/event-map.ts

  harness-broker-client/        # optional reference client library
    src/client.ts
    src/stdio-transport.ts
```

Protocol types should have no dependency on Codex, Agent Spaces internals, or a runtime controller. The broker package depends on protocol types and driver implementations. A reference client may depend only on protocol types.

## 16. Testing requirements

### 16.1 Protocol tests

- Parses NDJSON JSON-RPC requests/responses/notifications.
- Handles interleaving responses and events.
- Rejects malformed messages without corrupting subsequent frames.
- Preserves ordering with monotonic event `seq`.

### 16.2 Broker lifecycle tests

- `hello` negotiates protocol.
- `start` rejects invalid specs.
- One-invocation broker rejects a second active invocation.
- `status`, `stop`, `dispose` work across every state.
- Child process exit emits exactly one terminal event.

### 16.3 Codex app-server fake-harness tests

Use fake app-server scripts that speak newline-delimited JSON-RPC.

Required scenarios:

1. Start fresh thread and complete a turn.
2. Resume existing thread and complete a turn.
3. Resume missing thread with `start-fresh` fallback.
4. Resume missing thread with `fail`.
5. Assistant message deltas and final message.
6. Command execution, file change, MCP tool call, web search, and image view item mappings.
7. Token usage update.
8. App-server sends permission request with `deny`, `allow`, and `ask-client` policies.
9. App-server emits error during startup.
10. App-server exits during active turn.
11. Stop active invocation.
12. Unsupported steer/append/interrupt rejection.

### 16.4 Golden event tests

Maintain golden normalized event sequences for Codex app-server. These are the compatibility contract clients should depend on.

## 17. MVP implementation plan

### Phase 0: Protocol package

- Define TypeScript interfaces from this spec.
- Add runtime validation schemas.
- Implement JSON-RPC NDJSON transport primitives.
- Add event envelope and error code helpers.

### Phase 1: Broker process skeleton

- Implement `harness-broker run --transport stdio`.
- Implement `broker.hello`, `broker.health`, `invocation.status`, `invocation.dispose`.
- Implement in-memory invocation manager and event sequencer.

### Phase 2: Codex app-server driver

- Spawn process from exact spec.
- Implement app-server JSON-RPC client.
- Send `initialize` and `initialized`.
- Start or resume thread.
- Emit `invocation.started`, `continuation.updated`, and `invocation.ready`.
- Implement `invocation.input` for user turns.
- Map Codex notifications to normalized events.
- Implement stop/dispose.

### Phase 3: Control and policies

- Add timeout handling.
- Add permission policy support.
- Add unsupported-operation errors for steer, append-context, and interrupt.
- Add event redaction for diagnostics.

### Phase 4: Reference client integration

- Build a small client library that starts broker as a child process and exposes typed command methods plus async event iteration.
- Treat any runtime controller, including HRC, as a consumer of this client library rather than as part of the broker spec.

## 18. Open questions

1. **Codex app-server protocol stability.** The driver should version-gate or probe Codex app-server availability before starting an invocation.
2. **Turn interrupt.** Do not claim support until a Codex protocol-level interrupt/cancel method is verified. Process termination is stop, not turn interrupt.
3. **Permission request UX.** v0 can safely deny by default, but useful interactive approval needs broker-to-client requests and client UI support.
4. **Event granularity.** Codex emits rich item types. Golden tests should lock down which fields are normalized versus retained as `driver.raw` metadata.
5. **Output schemas and structured final results.** The protocol allows future `outputSchema`, but v0 should treat final output as text plus raw usage/artifacts.
6. **Multiple invocations per broker.** The wire protocol supports it; the v0 process model should not implement it until one-invocation behavior is stable.
7. **PTY/interactive drivers.** Codex app-server does not need pty. Future CLI drivers need careful separation between broker protocol stdout and harness pty streams.

## 19. Minimal end-to-end example

Client starts broker process, then sends:

```json
{"jsonrpc":"2.0","id":"1","method":"broker.hello","params":{"clientInfo":{"name":"example-client","version":"0.1.0"},"protocolVersions":["harness-broker/0.1"]}}
```

```json
{"jsonrpc":"2.0","id":"2","method":"invocation.start","params":{"spec":{"specVersion":"harness-broker.invocation/v1","harness":{"frontend":"codex","provider":"openai","driver":"codex-app-server"},"process":{"command":"codex","args":["--enable","goals","app-server"],"cwd":"/workspace/project","env":{"CODEX_HOME":"/workspace/.codex-home"},"harnessTransport":{"kind":"jsonrpc-stdio"}},"interaction":{"mode":"headless","turnConcurrency":"single","inputQueue":"none"},"driver":{"kind":"codex-app-server","approvalPolicy":"never","sandboxMode":"workspace-write","resumeFallback":"start-fresh","permissionPolicy":{"mode":"deny"}}}}}
```

Broker emits:

```json
{"jsonrpc":"2.0","method":"invocation.event","params":{"invocationId":"inv_1","seq":1,"time":"2026-05-20T18:00:00.000Z","type":"invocation.started","payload":{"pid":1234,"command":"codex","args":["--enable","goals","app-server"],"cwd":"/workspace/project"}}}
```

```json
{"jsonrpc":"2.0","method":"invocation.event","params":{"invocationId":"inv_1","seq":2,"time":"2026-05-20T18:00:00.100Z","type":"continuation.updated","payload":{"provider":"codex","kind":"thread","key":"thread_abc"}}}
```

```json
{"jsonrpc":"2.0","method":"invocation.event","params":{"invocationId":"inv_1","seq":3,"time":"2026-05-20T18:00:00.101Z","type":"invocation.ready","payload":{}}}
```

Client sends user input:

```json
{"jsonrpc":"2.0","id":"3","method":"invocation.input","params":{"invocationId":"inv_1","input":{"kind":"user","content":[{"type":"text","text":"Summarize the repository architecture."}]},"policy":{"whenBusy":"reject"}}}
```

Broker emits assistant/tool/turn events until:

```json
{"jsonrpc":"2.0","method":"invocation.event","params":{"invocationId":"inv_1","seq":20,"time":"2026-05-20T18:01:30.000Z","type":"turn.completed","turnId":"turn_abc","payload":{"turnId":"turn_abc","status":"completed","finalOutput":"..."}}}
```

## 20. Source components worth examining, not inheriting wholesale

When implementing this greenfield spec, the following existing components are useful reference material:

- Codex app-server launch descriptor construction in `agent-spaces/packages/harness-codex/src/adapters/codex-adapter.ts`.
- Codex app-server JSON-RPC client in `agent-spaces/packages/harness-codex/src/codex-session/rpc-client.ts`.
- Codex one-shot thread/turn flow and event mapping in `agent-spaces/packages/harness-codex/src/codex-session/run-one-shot.ts`.
- Existing process wrapper behavior in `hrc-runtime/packages/hrc-server/src/launch/exec.ts`, but only as operational inspiration; callback/spool/runtime metadata are client-specific and should not enter the broker spec.

The implementation should re-use ideas and tests where helpful, but the broker API should be defined by this spec, not by current package boundaries.
