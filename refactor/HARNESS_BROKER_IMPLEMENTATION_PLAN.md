# HARNESS_BROKER_IMPLEMENTATION_PLAN.md

**Status:** implementation plan for making Harness Broker the execution/data plane defined by the final runtime contracts  
**Scope:** `source-repos/agent-spaces/packages/harness-broker-protocol`, `packages/harness-broker-client`, and `packages/harness-broker`  
**Target contract baseline:** `AGENT_RUNTIME_CONTRACT_PLANE_SPEC.md`, `FINAL_CONTRACTS.md`, `FINAL_DATATYPES.md`  
**Primary outcome:** Harness Broker executes ASP-compiled broker profiles, owns native harness protocols, emits typed normalized events, enforces default-deny permissions, and exposes a stable broker protocol that HRC can drive without importing or parsing concrete harness internals.

---

## 0. Executive implementation thesis

Harness Broker is already past the prototype line. The repo has a real protocol package, a stdio JSON-RPC client, a single-invocation broker, an invocation state manager, a Codex app-server driver, fake Codex fixtures, event mapping, queue policy tests, permission tests, redaction tests, and integration tests that launch the broker binary.

The implementation plan should therefore be a **hardening and contract-alignment plan**, not a rewrite.

The broker must become the clean execution/data plane between HRC and concrete harnesses:

```text
HRC HarnessBrokerController
  -> spaces-harness-broker-client
  -> broker.hello
  -> invocation.start(ASP-emitted startRequest unchanged)
  -> invocation.input / stop / status / dispose
  <- invocation.event notifications
  <- invocation.permission.request broker-to-client requests when negotiated

Harness Broker
  -> validates protocol input
  -> starts native harness process
  -> speaks native harness protocol inside driver
  -> applies permission/input policy
  -> emits normalized, typed, redacted broker events
  -> reports invocation status/capabilities
```

The most important implementation cut is permission semantics. Current broker code has the right concept but the wrong final shape: permission request events are emitted through an `as never` escape hatch, the event vocabulary does not include the final `permission.requested` / `permission.resolved` events, and the `ask-client` timeout path still contains a v0 optimistic approval branch. Those must be fixed before HRC makes broker Codex headless the default.

The second important cut is event shape. HRC must consume exactly one normalized broker event stream. That requires the protocol package to own all event names and payload schemas, the Codex driver to map native events into that vocabulary only, and the broker/client to expose ordered event notifications without leaking Codex-native protocol semantics.

The third important cut is identity determinism. For HRC-owned paths, ASP will compile a start request containing HRC-allocated `invocationId` and `initialInput.inputId`. Broker must preserve those IDs exactly. Broker-generated IDs may remain only for CLI/testing convenience.

Identity fields should also be branded string aliases in TypeScript, not broad
`string` aliases. The wire format remains JSON strings, but DTOs should use the
shared `Id<Name>` convention from `FINAL_DATATYPES.md` (or a structurally
equivalent protocol-local helper if package dependency direction requires it) so
`RuntimeId`, `RunId`, `InvocationId`, `InputId`, and permission/request IDs are
not accidentally interchanged in implementation code.

---

## 1. Current broker state

### 1.1 Useful substrate already present

Current packages:

```text
packages/harness-broker-protocol
  protocol DTOs
  broker command types
  event envelope and event type union
  capability types
  JSON-RPC and NDJSON framing
  lightweight schema validators
  golden fixtures

packages/harness-broker-client
  stdio transport
  JSON-RPC request/response handling
  notification handling
  per-invocation async event iterator
  broker process lifecycle handling
  permission request callback surface

packages/harness-broker
  broker facade
  protocol server
  single-invocation manager
  event sequencer
  input disposition/queue handling
  process spawning and termination helpers
  redaction helpers
  Codex app-server driver
  fake Codex app-server fixtures
  integration/lifecycle/permission/input/redaction tests
```

Current broker capabilities already align with the v1 posture:

```text
multiInvocation: false
transports: ['stdio-jsonrpc-ndjson']
eventNotifications: true
brokerToClientRequests: clientCapabilities.permissionRequests === true
```

Current invocation manager already has several properties worth preserving:

```text
- one active invocation per broker process
- broker-owned input.accepted / input.queued / input.rejected emission
- monotonic per-invocation event sequencing
- terminal event uniqueness guard
- per-invocation FIFO queue substrate
- composed queue capability from driver + interaction spec
- queue eviction on stopping/terminal states
- status reporting with capabilities and continuation
```

Current Codex driver already owns the native Codex app-server boundary:

```text
- starts a child process via compiled HarnessProcessSpec
- initializes app-server JSON-RPC
- starts or resumes Codex thread
- maps Codex notifications to broker events
- handles process exit during startup/turn
- applies turn/startup timeouts
- handles stop/dispose
- reports continuation.updated with Codex thread id
```

That is the right direction. The work now is to remove v0 escape hatches and make the protocol surface precise enough that HRC can depend on it.

### 1.2 Gaps relative to final contracts

The gaps are concrete and mostly localized:

```text
Protocol/event gaps
  - InvocationEventType does not include permission.requested or permission.resolved.
  - The driver emits 'invocation.permission.request' through an `as never` cast.
  - Protocol package defines PermissionRequestParams / PermissionDecision, but BrokerMethod excludes broker-to-client request methods.
  - Event payload types are partial; typed payload union is not complete.
  - validateEventEnvelope does not validate payload-specific required fields.
  - schemas.ts does not validate permission.defaultDecision.
  - protocol server accepts unvalidated params unless handlers validate manually.

Permission gaps
  - ask-client without negotiated capability denies, which is correct.
  - allow/deny policy modes are immediate, which is acceptable.
  - ask-client with negotiated capability currently depends on an event-side callback and a timeout story.
  - timeout without explicit default can still optimistically approve for longer timeoutMs.
  - no final permission.resolved audit event exists.
  - permission request subject is not represented as subjectRedacted in final event vocabulary.
  - no explicit decidedBy value is emitted.

Client gaps
  - BrokerClient.startInvocation accepts spec + initialInput rather than the exact InvocationStartRequest object HRC receives from ASP.
  - Permission handling is split between request handling and event handling for the v0 event hack.
  - There is no typed startRequestHash/pass-through assertion surface; that remains HRC/ASP-owned, but client should avoid convenience mutation.
  - Event streams are notification-only, which is fine for v1, but must be documented as such.

Broker manager/state gaps
  - Broker may generate invocationId when spec omits one; this is okay for CLI/testing but not HRC-owned paths.
  - Broker emits invocation.ready payload as `{}`; final event type expects at least `{ state: 'ready' }`.
  - dispose updates status but does not emit invocation.disposed.
  - status does not include currentTurnId or child process info in all cases.
  - maxEventBytes exists in ProcessLimits but is not enforced centrally.
  - start/input handlers do not validate full request shape at the protocol server boundary.

Codex driver gaps
  - Native event mapping does not annotate driver.rawType for diagnostics.
  - Native turn failure payloads currently blur turn.completed(status='failed') versus final TurnFailedPayload shape.
  - buildThreadStartParams ignores some driver fields that may matter, such as reasoning effort/profile/config-related values, unless those are intentionally not supported.
  - permission request transport must be a real broker-to-client request, not an event-only simulation.
  - startup handshake should validate the Codex app-server protocol response explicitly.

Security/redaction gaps
  - Redaction is useful but should become event-boundary invariant, not best effort.
  - Permission subjects need a redacted event representation.
  - Diagnostic/tool payloads need size and secret guards.
  - deprecated redaction stubs should be removed once call sites are gone.
```

---

## 2. Target end state

Harness Broker is accepted when these statements are true:

```text
1. `spaces-harness-broker-protocol` defines the full v1 broker method, event, capability, input, permission, and validation surface.
2. `spaces-harness-broker-client` can start a broker process, negotiate hello, send an exact InvocationStartRequest, deliver inputs, stop/status/dispose, stream ordered invocation.event notifications, and answer broker-to-client permission requests.
3. `spaces-harness-broker` validates incoming commands, preserves ASP/HRC-provided IDs, executes the native harness process, enforces input/permission policy, and emits only typed normalized broker events.
4. Codex app-server native protocol parsing exists only inside the Codex broker driver.
5. Permission behavior is default-deny, explicit, audited, redacted, and tested.
6. Event ordering is append-only by `(invocationId, seq)`, stable enough for HRC idempotent persistence.
7. Broker v1 remains notification-stream based; attach/replay is explicitly v2.
```

The broker does **not** need to understand `CompiledRuntimePlan`, `RuntimeRouteDecision`, HRC persistence, runtime reuse, public API compatibility, or HRC event projection. Those are HRC/ASP concerns. Broker consumes only `InvocationStartRequest` and broker protocol commands.

---

## 3. Non-negotiable invariants for broker implementation

### 3.1 Broker owns native harness execution

Concrete harness protocol code must remain behind broker drivers:

```text
packages/harness-broker/src/drivers/codex-app-server/*
future packages/harness-broker/src/drivers/claude-*/...
future packages/harness-broker/src/drivers/pi-*/...
```

HRC must never need to parse Codex app-server JSON-RPC or stdout. Agent Spaces may compile driver specs, but the broker interprets those driver specs.

### 3.2 Broker preserves compiled execution identity

For HRC-owned paths:

```text
spec.invocationId must be preserved exactly.
initialInput.inputId must be preserved exactly.
input.inputId must be preserved exactly when supplied.
```

Broker-generated IDs are allowed only for standalone CLI/testing paths where the caller omitted IDs.

Recommended implementation detail:

```ts
export type BrokerStrictIdentityMode = 'required' | 'generate-when-missing'
```

Default for library tests/CLI can stay `generate-when-missing`. HRC-facing client/controller should use `required` by passing an option or by relying on HRC-side validation before `invocation.start`.

### 3.3 Broker emits normalized event facts only

Every event leaving the broker must be one of `InvocationEventType` and must validate against its payload schema. Native event names may appear only in `event.driver.rawType` or redacted diagnostic payloads.

### 3.4 Permissions default to deny

Final rules:

```text
mode: deny        -> decline, emit permission.resolved(decision='deny', decidedBy='policy') when a native request occurs
mode: allow       -> approve, emit permission.resolved(decision='allow', decidedBy='policy') when a native request occurs
mode: ask-client  -> requires negotiated client permissionRequests capability
missing capability -> deny
missing defaultDecision -> deny
client timeout -> explicit defaultDecision if present, otherwise deny
handler failure -> explicit defaultDecision if present, otherwise deny
no optimistic allow branch exists
```

For `ask-client`, broker emits/requests permission in two channels:

```text
1. JSON-RPC broker-to-client request: method 'invocation.permission.request'
   - this is the decision transport

2. Broker event notifications:
   - permission.requested
   - permission.resolved
   - these are audit/event-stream facts
```

### 3.5 V1 is notification-stream based

Do not implement `broker.attach`, `invocation.eventsSince`, `invocation.snapshot`, or `invocation.ackEvents` in this phase. They belong in v2. V1 only promises live ordered notifications over the owned broker connection.

---

## 4. Package-level target layout

### 4.1 `spaces-harness-broker-protocol`

Target source layout:

```text
packages/harness-broker-protocol/src/
  capabilities.ts
  commands.ts
  errors.ts
  events.ts
  invocation.ts
  jsonrpc.ts
  ndjson.ts
  schemas.ts
  permissions.ts        # new or split from commands.ts
  payload-schemas.ts    # optional if schemas.ts gets too large
  index.ts
```

This package must remain pure DTO/schema/framing code. It should not import broker implementation, client implementation, Codex driver code, HRC code, or Agent Spaces compiler code.

### 4.2 `spaces-harness-broker-client`

Target source layout:

```text
packages/harness-broker-client/src/
  client.ts
  errors.ts
  event-iterator.ts
  permission-mediator.ts    # optional extraction
  stdio-transport.ts
  index.ts
```

Client should be a thin typed transport wrapper. It must not interpret Codex events. It may mediate permission decisions through a caller callback because broker-to-client permission request is a broker protocol feature, not a Codex-native feature.

### 4.3 `spaces-harness-broker`

Target source layout:

```text
packages/harness-broker/src/
  broker.ts
  cli.ts
  protocol-server.ts
  invocation-manager.ts
  events.ts
  errors.ts
  security/redaction.ts
  security/event-safety.ts          # optional central event size/redaction enforcement
  runtime/env.ts
  runtime/process-runner.ts
  runtime/signals.ts
  drivers/driver.ts
  drivers/registry.ts
  drivers/noop-driver.ts
  drivers/codex-app-server/driver.ts
  drivers/codex-app-server/event-map.ts
  drivers/codex-app-server/input.ts
  drivers/codex-app-server/permissions.ts
  drivers/codex-app-server/rpc-client.ts
```

Broker implementation should remain driver-agnostic except through `Driver`.

---

## 5. Implementation phases

## Phase 0 — freeze current behavior with baseline tests

Before changing semantics, add tests that capture the intended current substrate and expose known contract mismatches.

### Tasks

Add or update tests for:

```text
packages/harness-broker-protocol/test/schemas.test.ts
  - validates PermissionPolicy.defaultDecision when present
  - rejects invalid defaultDecision
  - validates known event envelopes for all event types

packages/harness-broker/test/broker-lifecycle.test.ts
  - invocation.ready payload shape
  - invocation.disposed event emission expectation, initially skipped/todo if needed
  - status includes currentTurnId during active turn once supported

packages/harness-broker/test/drivers/codex-app-server/permissions.test.ts
  - mark optimistic ask-client approval as a failing/todo final-contract test

packages/harness-broker-client/test/permission-handler.test.ts
  - broker-to-client request path is the decision transport
  - event-only permission path is deprecated/failing final-contract test
```

### Acceptance

```text
- Existing tests still pass before semantic changes.
- New final-contract tests are either passing or explicitly todo with owner comments.
- Known gaps are represented by tests, not just prose.
```

---

## Phase 1 — protocol contract alignment

This phase updates `spaces-harness-broker-protocol` first so implementation packages compile against the final surface.

### 1.0 Add branded ID aliases to protocol DTOs

Use branded string aliases for ID-bearing broker DTO fields:

```ts
export type Id<Name extends string> = string & { readonly __id: Name }

export type InvocationId = Id<'invocation'>
export type InputId = Id<'input'>
export type RunId = Id<'run'>
export type TurnId = Id<'turn'>
export type PermissionRequestId = Id<'permissionRequest'>
export type RuntimeId = Id<'runtime'>
export type TraceId = Id<'trace'>
```

These remain plain strings on the JSON-RPC wire. Constructors/validators should
sit at trust boundaries and be the only place raw strings become branded IDs.
If the protocol package cannot import `spaces-runtime-contracts` without
violating package boundaries, define the same structural helper locally and keep
the names aligned with `FINAL_DATATYPES.md`.

### 1.1 Add final permission event types

Update `events.ts`:

```ts
export type InvocationEventType =
  | existing
  | 'permission.requested'
  | 'permission.resolved'
```

Add payloads:

```ts
export interface PermissionRequestedPayload {
  permissionRequestId: PermissionRequestId
  kind: 'command' | 'file_change' | 'tool' | string
  subjectRedacted: unknown
  defaultDecision: 'allow' | 'deny'
  deadlineMs?: number | undefined
}

export interface PermissionResolvedPayload {
  permissionRequestId: PermissionRequestId
  decision: 'allow' | 'deny'
  decidedBy: 'policy' | 'user' | 'api' | 'timeout'
  message?: string | undefined
}
```

Keep `PermissionRequestParams` / `PermissionDecision` in `commands.ts` or move them to `permissions.ts` and re-export.

### 1.2 Separate broker method classes

Update `commands.ts`:

```ts
export type BrokerMethodV1 =
  | 'broker.hello'
  | 'broker.health'
  | 'invocation.start'
  | 'invocation.input'
  | 'invocation.interrupt'
  | 'invocation.stop'
  | 'invocation.status'
  | 'invocation.dispose'

export type BrokerToClientRequestMethod = 'invocation.permission.request'
export type BrokerNotificationMethod = 'invocation.event'
```

Do **not** add `invocation.events` to v1. The final v1 transport is live notifications. Add v2 method aliases only as types or comments if useful:

```ts
export type BrokerMethodV2 =
  | BrokerMethodV1
  | 'broker.attach'
  | 'broker.listInvocations'
  | 'invocation.eventsSince'
  | 'invocation.ackEvents'
  | 'invocation.snapshot'
  | 'invocation.permission.respond'
```

### 1.3 Extend capabilities

Update `InvocationCapabilities`:

```ts
events: {
  assistantDeltas: boolean
  toolCalls: boolean
  usage: boolean
  diagnostics: boolean
  replay?: boolean | undefined
  ack?: boolean | undefined
}
control: {
  stop: boolean
  dispose: boolean
  status?: boolean | undefined
  attach?: boolean | undefined
}
permissions?: {
  brokerToClientRequests: boolean
  eventAudit: boolean
}
```

For v1 Codex driver, return:

```ts
permissions: {
  brokerToClientRequests: true, // effective only when client negotiated it
  eventAudit: true
}
events.replay = false/undefined
events.ack = false/undefined
control.status = true
control.attach = false/undefined
```

The broker hello capability remains:

```ts
brokerToClientRequests: clientCapabilities.permissionRequests === true
attachReplay: false/undefined
```

### 1.4 Tighten schemas

Update `schemas.ts`:

```text
- add permission.requested / permission.resolved to eventTypes
- validate DriverPermissionPolicy.defaultDecision enum
- validate permission request params
- validate permission decision response shape if helper exists
- validate InvocationReadyPayload if payload-specific validation is introduced
- validate InvocationDisposedPayload if emitted
```

Strong recommendation: add a payload-specific validation table, but keep it lightweight. The protocol package does not need a full schema library to be useful.

### Acceptance

```text
- TypeScript compile passes for protocol.
- Protocol tests cover every final v1 event type.
- No `as never` is required anywhere to emit permission events.
- Permission policy validation includes defaultDecision.
- v1 method list remains notification-based; attach/replay is typed only as v2 future surface.
```

---

## Phase 2 — permission transport and audit semantics

This is the most important phase. It changes `ask-client` from event simulation to real broker-to-client request/response.

### 2.1 Extend driver context with broker-to-client request capability

Current `DriverContext` only supports `emit`. Add request support:

```ts
export interface DriverContext {
  invocationId: InvocationId
  clientCapabilities: ClientCapabilities

  emit<TPayload>(...): InvocationEventEnvelope<TPayload>

  requestPermission?(params: PermissionRequestParams): Promise<PermissionDecision>
}
```

The broker/invocation manager provides `requestPermission` only when the protocol server/client path supports broker-to-client requests. For in-process tests, it may use a supplied test handler.

A cleaner option is to add a generic request primitive:

```ts
requestClient<TParams, TResult>(method: BrokerToClientRequestMethod, params: TParams): Promise<TResult>
```

For v1, keep it permission-specific to avoid inventing a general channel prematurely.

### 2.2 Add broker options for client requests

In `createBroker(options)`:

```ts
export interface BrokerOptions {
  drivers: Driver[]
  onEvent?: (event: InvocationEventEnvelope) => void
  onClientRequest?: (request: JsonRpcRequest) => Promise<unknown>
  now?: () => Date
  maxInputQueueDepth?: number
}
```

Or more typed:

```ts
onPermissionRequest?: (params: PermissionRequestParams) => Promise<PermissionDecision>
```

The `cli.runStdio()` protocol server should wire this to `server.requestClient(...)` or equivalent.

### 2.3 Add outbound request support to protocol server

Current `createProtocolServer` can respond to inbound requests and send notifications. It cannot send JSON-RPC requests to the client.

Add:

```ts
export interface ProtocolServer {
  register(method: string, handler: RequestHandler): void
  start(): Promise<void>
  notify(notification: JsonRpcNotification): void
  request<T>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T>
  close(): Promise<void>
}
```

Implementation requirements:

```text
- maintain next outbound id, e.g. broker_req_1
- store pending outbound requests
- handle incoming JSON-RPC responses and resolve/reject pending requests
- retain inbound request routing for HRC/client commands
- on close, reject pending outbound requests
- on timeout, reject with BrokerErrorCode.Timeout or transport-level timeout
```

Today `protocol-server.ts` ignores non-request frames. After this change it must route responses for broker-initiated requests.

### 2.4 Use real request path in `permissions.ts`

Final behavior for native permission requests:

```ts
const policy = driver.permissionPolicy ?? { mode: 'deny' }
const defaultDecision = policy.defaultDecision ?? 'deny'
const permissionRequestId = stable id from invocation/turn/input/counter

emit('permission.requested', {
  permissionRequestId,
  kind,
  subjectRedacted,
  defaultDecision,
  deadlineMs,
})

switch policy.mode:
  deny:
    emit resolved deny/policy
    return decline

  allow:
    emit resolved allow/policy
    return approve

  ask-client:
    if !clientCapabilities.permissionRequests or !ctx.requestPermission:
      emit diagnostic warn
      emit resolved deny/policy
      return decline

    decision = await withTimeout(ctx.requestPermission(params), timeoutMs)
      timeout -> defaultDecision, decidedBy='timeout'
      request error -> defaultDecision, decidedBy='api' or 'timeout' depending cause
      valid decision -> decision, decidedBy='user' or 'api'

    emit resolved
    return decision allow ? approve : decline
```

Remove this behavior entirely:

```text
Long timeout + no explicit defaultDecision -> auto approve
```

There should be no branch where missing default approves.

### 2.5 Redact permission subject

Add or reuse:

```ts
redactPermissionSubject(subject: unknown, envSecrets: Set<string>): unknown
```

The broker-to-client request may contain either raw subject or redacted subject depending on intended client UX. For HRC safety, use this split:

```text
PermissionRequestParams.subject       may contain subject needed by HRC/user decision, but must not contain env secrets.
permission.requested.subjectRedacted  is always safe for event persistence.
```

If native subjects can contain sensitive data, the broker-to-client request should also be redacted by default. HRC should not need raw secrets to approve a command/file/tool request.

### 2.6 Client permission handling cleanup

Update `BrokerClient`:

```text
- keep transport.onRequest handler for 'invocation.permission.request'
- remove event-based permission request handling for 'invocation.permission.request' event
- ignore permission.requested/permission.resolved as normal events; do not answer decisions from events
- on handler missing/failure, return defaultDecision or deny
- respect deadlineMs/timeout on broker side, not client side
```

### Acceptance

```text
- No code emits 'invocation.permission.request' as an event.
- Permission request decision transport is JSON-RPC broker-to-client request.
- Broker event stream contains permission.requested and permission.resolved audit facts.
- ask-client without negotiated capability denies.
- ask-client timeout uses explicit defaultDecision, else deny.
- ask-client handler failure uses explicit defaultDecision, else deny.
- No optimistic approval branch exists.
- Permission tests pass at broker and client levels.
```

---

## Phase 3 — command validation at the broker boundary

Current protocol validators exist but the stdio server handlers mostly cast params. HRC integration needs invalid requests to fail predictably.

### 3.1 Validate requests before dispatch

Option A: validate in `protocol-server.ts` for all registered broker methods.  
Option B: validate in `cli.ts` handler registration wrappers.

Prefer B to keep `ProtocolServer` generic:

```ts
server.register('invocation.start', async ({ params }) => {
  const req = validateInvocationStartRequest(params)
  return broker.start(req)
})
```

Similarly validate:

```text
broker.hello
broker.health
invocation.input
invocation.interrupt
invocation.stop
invocation.status
invocation.dispose
```

Add helper validators if they do not exist.

### 3.2 Error mapping

Ensure validation errors become JSON-RPC invalid params:

```text
-32602 Invalid params
```

with `data.issues` containing stable validation issues.

`toJsonRpcError(...)` in `harness-broker/src/errors.ts` should explicitly map protocol validation errors.

### 3.3 In-process broker validation

The library API can either assume typed callers or also validate. For HRC confidence, validate at broker facade methods too:

```ts
start(req) {
  const valid = validateInvocationStartRequest(req)
  ...
}
```

If this creates duplicated validation in CLI, acceptable. The runtime cost is negligible compared with launching a harness.

### Acceptance

```text
- Invalid start/input/status params return stable JSON-RPC errors.
- schema tests and protocol-server tests cover invalid params.
- broker facade rejects invalid specs before driver lookup/spawn.
- no handler relies on `params as ...` without validation in broker stdio mode.
```

---

## Phase 4 — event vocabulary and state-machine hardening

This phase makes broker events final-contract compatible and safe for HRC persistence.

### 4.1 Finalize event payloads

Update emissions:

```text
invocation.ready      payload { state: 'ready' }
invocation.disposed   payload { disposed: true }
permission.requested  final payload
permission.resolved   final payload
turn.failed           payload includes turnId, message/code/data where available
turn.interrupted      payload includes turnId, reason where available
```

Keep compatibility where useful by allowing `TurnCompletedPayload` to carry `status`, but do not rely on `turn.completed(status='failed')` for failure semantics. A failed turn should emit `turn.failed`.

### 4.2 Add driver raw type annotations

In `mapCodexNotification(...)`, set:

```ts
extra.driver = {
  kind: 'codex-app-server',
  rawType: notification.method,
}
```

This gives HRC/debuggers provenance without requiring HRC to know Codex event names.

### 4.3 Track current turn centrally

Today the Codex driver tracks `currentTurnId`, while invocation manager state does not expose it directly. Add manager-level tracking from events:

```ts
interface Invocation {
  currentTurnId?: string
  currentInputId?: string
  lastSeq?: number
  childPid?: number
  ...
}
```

Update `applyEventState(...)`:

```text
turn.started      -> currentTurnId = event.turnId; state = turn_active
turn.completed    -> clear currentTurnId/currentInputId; state = ready unless terminal
turn.failed       -> clear currentTurnId/currentInputId; state = ready unless terminal
turn.interrupted  -> clear currentTurnId/currentInputId; state = ready unless terminal
invocation.started -> childPid = payload.pid if present
terminal/disposed -> clear active turn/input
```

Update status:

```ts
process: { pid, exitCode, signal }
currentTurnId
capabilities
continuation
```

The driver may still track its own native current turn for request correlation, but the manager should own public status projection.

### 4.4 Emit disposed event

`dispose(...)` should emit:

```text
invocation.disposed
```

after successful driver dispose. It should be terminal and idempotent.

### 4.5 Enforce event size and redaction centrally

Create a single event finalization path in invocation manager:

```text
1. safe payload constraint for invocation.started
2. redaction by envSecrets
3. permission subject redaction
4. maxEventBytes check/truncation/failure policy
5. sequencing
6. state update
7. onEvent notification
```

For `maxEventBytes`, choose deterministic behavior:

```text
- if serialized payload exceeds maxEventBytes, replace large fields with '[TRUNCATED]' and emit diagnostic
- if envelope still exceeds maxEventBytes, emit diagnostic only or fail invocation with BrokerErrorCode.ResourceError
```

Recommended v1 behavior: truncate event payloads rather than failing the invocation, except for truly unsafe unserializable payloads.

### Acceptance

```text
- Every emitted event validates with protocol validator.
- Event seq increments exactly once per emitted event.
- Duplicate terminal events remain impossible.
- invocation.disposed is emitted exactly once.
- status reflects currentTurnId during active turn.
- maxEventBytes has tests.
- redaction tests still pass and include permission subject examples.
```

---

## Phase 5 — Codex app-server driver contract hardening

This phase ensures the concrete Codex driver is a trustworthy broker driver.

### 5.1 Validate Codex handshake

Current startup sends `initialize` and `initialized`. Add explicit validation of the initialize response:

```text
- response must be an object
- protocolVersion should be accepted if present
- unsupported/missing critical fields should produce diagnostic or HarnessError depending severity
```

Do not overfit to fake server output if real Codex app-server response is loose. Start with tolerant validation:

```ts
if (protocolVersion !== undefined && !String(protocolVersion).startsWith('codex-app-server/')) {
  throw BrokerError(HarnessError, 'Unsupported Codex app-server protocol version')
}
```

### 5.2 Align driver spec fields with compiler output

Review `CodexAppServerDriverSpec` fields:

```text
model
modelReasoningEffort
approvalPolicy
sandboxMode
profile
defaultImageAttachments
permissionPolicy
resumeFallback
```

`buildThreadStartParams(...)` should either use each field or explicitly document that the field is currently metadata-only/unsupported. Prefer using fields that Codex app-server accepts.

Likely updates:

```text
- include modelReasoningEffort in config if Codex expects it there
- include profile/config if app-server supports profile selection
- preserve approvalPolicy and sandboxMode encoding
- preserve defaultImageAttachments behavior in buildTurnStartParams
```

Do not move Codex-specific config mutation into HRC. If a field needs transformation, broker driver or ASP compiler owns it depending on whether it is native driver semantics or compiled process setup.

### 5.3 Normalize native event mapping

Update `event-map.ts` to satisfy final payloads:

```text
turn/started                  -> turn.started
thread/tokenUsage/updated     -> usage.updated
item/started agentMessage     -> assistant.message.started
item/agentMessage/delta       -> assistant.message.delta
item/completed agentMessage   -> assistant.message.completed
item/started tool types       -> tool.call.started
item/*/outputDelta/progress   -> tool.call.delta
item/completed tool success   -> tool.call.completed
tool error/nonzero/status     -> tool.call.failed
turn/completed success        -> turn.completed
turn/completed failed         -> turn.failed
turn/completed interrupted    -> turn.interrupted
unknown native notification   -> optionally driver.notice or ignored with trace-level diagnostic
```

Golden tests should compare full event envelopes after stripping timestamps/seq where necessary.

### 5.4 Process exit and active turn semantics

Keep current useful behavior but make it final-contract precise:

```text
process exits during startup -> invocation.failed, startup promise rejects
process exits during active turn without stopping -> turn.failed then invocation.exited
process exits during stop -> turn.interrupted if active, then invocation.exited
startup timeout -> invocation.failed(code='Timeout')
turn timeout -> turn.failed(code='Timeout'), then close/stop process if necessary
```

There should be no successful `turn.completed` after an invocation terminal event.

### 5.5 Resume semantics

Current resume behavior is reasonable:

```text
resumeThreadId or spec.continuation provider=codex -> thread/resume
missing thread + resumeFallback=start-fresh -> driver.notice + thread/start
missing thread + resumeFallback=fail -> diagnostic + invocation.failed
```

Add tests ensuring `continuation.updated` after fallback reports the fresh thread id, not the missing id.

### Acceptance

```text
- Codex driver no longer emits any untyped event.
- Golden event fixtures reflect final event vocabulary.
- Handshake incompatibility fails predictably.
- Reasoning/profile/config fields are either implemented or explicitly rejected/diagnosed.
- Resume fallback/fail paths are deterministic.
- Process exit/timeout semantics are covered by tests.
```

---

## Phase 6 — broker client final API

HRC should be able to pass ASP's compiled start request without the client reconstructing it.

### 6.1 Add exact start-request API

Current:

```ts
startInvocation(spec: HarnessInvocationSpec, initialInput?: InvocationInput)
```

Add:

```ts
startInvocationFromRequest(
  request: InvocationStartRequest
): Promise<{
  invocationId: InvocationId
  response: InvocationStartResponse
  events: AsyncIterable<InvocationEventEnvelope>
}>
```

Then make old API delegate:

```ts
startInvocation(spec, initialInput) {
  return this.startInvocationFromRequest(initialInput === undefined ? { spec } : { spec, initialInput })
}
```

HRC should call only `startInvocationFromRequest` or a similarly named exact-pass-through method.

### 6.2 Preserve early events for known invocation IDs

The current client pre-creates an event stream when `spec.invocationId` is provided. Keep this behavior for start request path:

```ts
const expectedInvocationId = request.spec.invocationId
const expectedEvents = expectedInvocationId ? this.#eventStream(expectedInvocationId) : undefined
```

This prevents losing early `invocation.started` events emitted before the start response resolves.

### 6.3 Remove event-based permission decision path

After Phase 2, client should not answer permissions based on an event. It should answer only inbound JSON-RPC requests:

```ts
this.#transport.onRequest(async (request) => {
  if (request.method === 'invocation.permission.request') {
    return this.#handlePermissionRequest(request.params)
  }
  throw new Error(...)
})
```

`permission.requested` and `permission.resolved` remain visible in `events` like any other broker event.

### 6.4 Improve close/error behavior for HRC

Add a public close/error hook if needed:

```ts
onClose(handler: (error: BrokerTransportError) => void): void
```

HRC controller will likely need to mark runtime unknown/failed when broker process exits. The client already has transport close handling; expose it cleanly.

### Acceptance

```text
- HRC can call a method that accepts InvocationStartRequest exactly.
- Old spec+input method remains compatibility wrapper.
- Permission handler is request-based only.
- Early events are not lost when invocationId is known.
- Broker process exit closes event iterators and calls close handler.
```

---

## Phase 7 — invocation manager strictness and determinism

This phase tightens the manager as the broker's core state machine.

### 7.1 Strict identity mode

Add option:

```ts
export interface InvocationManagerOptions {
  identityMode?: 'required' | 'generate-when-missing'
  ...
}
```

Behavior:

```text
required:
  - start rejects if spec.invocationId missing
  - input rejects if input.inputId missing, unless broker-generated input ids are explicitly allowed

generate-when-missing:
  - current behavior retained for CLI/tests
```

For HRC production, the controller or client should use `required` if broker exposes it. If not exposed over stdio, enforce in HRC before send and keep broker generation as fallback. The broker still should preserve supplied IDs exactly.

### 7.2 Avoid mutating caller objects

Broker should not mutate `spec`, `request`, or `input` objects supplied by the caller. It can copy them into internal state:

```ts
const specCopy = structuredClone(spec)
const inputWithId = { ...input, inputId }
```

Add tests:

```text
- original InvocationStartRequest deepEquals after broker.start
- original InvocationInput deepEquals after broker.input
```

This supports HRC's invariant that it sends the ASP-emitted request unchanged.

### 7.3 Input policy behavior

Keep current v1 defaults:

```text
ready + user input -> start turn
turn_active + no policy -> reject
turn_active + reject -> reject + input.rejected
turn_active + queue but no capability -> return rejected queue_not_supported + input.rejected
turn_active + queue enabled -> input.queued, FIFO drain after ready
turn_active + interrupt_then_apply -> rejected unsupported
```

One behavioral cleanup: prefer returning `InvocationInputResponse { accepted: false }` for expected policy rejections instead of throwing for all input rejections. However, changing thrown/rejected behavior may affect existing tests and HRC integration.

Recommended compromise:

```text
- protocol/invalid-state errors throw BrokerError
- policy decisions return accepted=false where already implemented
- `whenBusy: reject` may continue throwing BrokerErrorCode.InputRejected for compatibility, but HRC client should map it to busy/rejected
```

Do not silently queue unless all three agree:

```text
spec.interaction.inputQueue === 'fifo'
driver.acceptsSequentialUserInputs === true
capabilities.input.queue === true
```

### 7.4 Terminal/dispose behavior

Terminal states:

```text
exited
failed
disposed
```

Rules:

```text
- terminal invocation accepts status
- terminal invocation rejects input/interrupt/stop according to current terminal semantics
- dispose allowed only after exited/failed, idempotent after disposed
- dispose emits invocation.disposed exactly once
- active queue is rejected on stopping/exited/failed/disposed
```

### Acceptance

```text
- Identity preservation tests pass.
- Optional strict identity mode exists or documented as HRC-side enforcement.
- No start/input call mutates caller-owned objects.
- Queue tests still pass.
- Dispose event tests pass.
```

---

## Phase 8 — redaction and event safety

This phase makes the broker safe as an event source for HRC persistence.

### 8.1 Centralize event safety

Create one function used by invocation manager before sequencing:

```ts
finalizeEventPayload({
  type,
  payload,
  envSecrets,
  maxEventBytes,
}): {
  payload: unknown
  diagnostics?: DiagnosticPayload[]
}
```

It should:

```text
- constrain invocation.started payload
- scrub env secret values
- scrub bearer/auth/token patterns
- redact permission subjects
- truncate oversized payloads deterministically
- preserve JSON-serializable shape
```

### 8.2 Replace deprecated redaction stubs

Remove or stop exporting:

```ts
redactEnv(...)
redactSecrets(...)
```

only after callers are migrated. If public exports require compatibility, keep them but implement them correctly or mark internal.

### 8.3 Add targeted tests

Add redaction tests for:

```text
- env secret in diagnostic line
- env secret in tool result
- bearer token in permission subject
- oversized assistant delta/tool output truncation
- invocation.started does not include env
- local_image emits only path, never binary content
```

### Acceptance

```text
- No raw env values appear in serialized event JSON.
- Permission audit events contain subjectRedacted only.
- Oversized payload behavior is deterministic and tested.
- Redaction happens before event notification leaves broker.
```

---

## Phase 9 — v1/v2 boundary and attach/replay deferral

The final contracts intentionally keep v1 simple: one broker process per HRC runtime, one active invocation, live notifications, conservative HRC recovery.

### 9.1 Document v1 explicitly

Add docs or comments in protocol package:

```text
v1 supported:
  broker.hello
  broker.health
  invocation.start
  invocation.input
  invocation.interrupt
  invocation.stop
  invocation.status
  invocation.dispose
  notification: invocation.event
  broker-to-client request: invocation.permission.request

v1 not supported:
  broker.attach
  broker.listInvocations
  invocation.eventsSince
  invocation.ackEvents
  invocation.snapshot
  invocation.permission.respond
  multiInvocation
```

### 9.2 Capability truthfulness

Ensure hello/status never imply attach/replay support:

```ts
BrokerCapabilities.attachReplay = false/undefined
InvocationCapabilities.events.replay = false/undefined
InvocationCapabilities.events.ack = false/undefined
InvocationCapabilities.control.attach = false/undefined
```

### 9.3 Prepare but do not implement event ledger

Do not add an in-broker durable ledger for v1. HRC is the durable event ledger. Broker process memory may retain recent events only for tests/debugging if needed, but do not expose replay methods until v2 semantics are designed.

### Acceptance

```text
- Unsupported v2 methods return JSON-RPC method-not-found.
- Capability tests assert no attach/replay in v1.
- Docs/tests make notification-only v1 explicit.
```

---

## Phase 10 — CLI and developer ergonomics

The broker CLI is useful for testing and future operations. Keep it small and contract-aligned.

### 10.1 `harness-broker run --transport stdio`

Keep as primary HRC mode. Ensure:

```text
- stdout contains only NDJSON JSON-RPC frames
- stderr carries diagnostics only
- broker exits when stdin closes
- broker rejects invalid transport
- all registered handlers validate params
```

### 10.2 `harness-broker drivers --json`

Keep for diagnostics. It should report driver summary and capabilities through the same broker hello path.

### 10.3 `harness-broker run-once`

Update to accept either:

```text
--start-request start-request.json
```

or the old split:

```text
--spec invocation.json --input input.json
```

Prefer `--start-request` because that matches ASP compiler output and HRC pass-through semantics.

### 10.4 Add validation command

Optional but useful:

```text
harness-broker validate-start-request --file start-request.json
```

This helps ASP compiler authors test emitted profiles without running Codex.

### Acceptance

```text
- CLI tests cover run, drivers, run-once start-request, invalid params.
- stdout-only-frames invariant remains tested.
- run-once uses the same InvocationStartRequest path as HRC.
```

---

## Phase 11 — integration with ASP compiler and HRC controller

This phase is mostly seam work, but the broker packages should expose the right affordances.

HRC integration must start from the ASP compiler product. Broker-capable Codex
headless should use `compileRuntimePlan(req)` and select a compiled
`BrokerExecutionProfile`; it should not call legacy helper APIs such as
`buildHarnessBrokerInvocation` directly. The broker/client integration point is
the selected profile's ASP-emitted `InvocationStartRequest`.

Public HRC endpoint versioning is not a broker requirement for v1 adoption. The
runtime contracts use `schemaVersion` fields such as
`agent-runtime-compile-request/v1` and `runtime-public-view/v1`, while existing
HRC `/v1` lifecycle endpoints may remain if they can add controller/profile/
capability fields compatibly. Introduce `/v2` endpoints only if backward-
compatible request/response views cannot be preserved.

### 11.1 Broker package commitments to ASP

ASP compiler needs stable protocol types and validators:

```text
HarnessInvocationSpec
InvocationStartRequest
InvocationInput
DriverPermissionPolicy
validateInvocationStartRequest
validateInvocationSpec
validateInvocationInput
```

ASP will compute hashes/redacted artifacts outside the broker. Broker should not attempt to compute plan/profile/start hashes.

### 11.2 Broker package commitments to HRC

HRC needs:

```text
BrokerClient.start(...)
client.hello(...)
client.startInvocationFromRequest(startRequest)
client.input(...)
client.stop(...)
client.status(...)
client.dispose(...)
client.onPermissionRequest(...)
client.onClose(...)
events AsyncIterable<InvocationEventEnvelope>
```

HRC should not import `packages/harness-broker/src/drivers/*`.

### 11.3 Pass-through integrity

Broker client should not mutate `InvocationStartRequest`. Add tests in client package:

```text
- request object deepEquals after startInvocationFromRequest rejects
- request object deepEquals after successful startInvocationFromRequest
```

HRC/ASP will own hash verification. Broker only needs to avoid convenience mutation.

### Acceptance

```text
- agent-spaces compiler can import protocol validators.
- hrc-server can import client/protocol only.
- client exposes exact start-request API.
- no HRC-facing API requires Codex-specific driver imports.
```

---

## Phase 12 — test gates

### 12.1 Protocol tests

Required:

```text
- BrokerMethodV1 excludes attach/replay and includes all v1 commands.
- BrokerToClientRequestMethod includes invocation.permission.request.
- BrokerNotificationMethod includes invocation.event.
- validateInvocationStartRequest accepts final Codex broker start request fixture.
- validateInvocationStartRequest rejects mismatched harness.driver/driver.kind.
- validateInvocationStartRequest validates permissionPolicy.defaultDecision.
- validateEventEnvelope accepts every final event type.
- validateEventEnvelope rejects unknown event type.
- validatePermissionRequestParams rejects missing permissionRequestId/defaultDecision.
```

### 12.2 Broker lifecycle tests

Required:

```text
- broker.hello negotiates protocol and client capabilities.
- broker.hello rejects unsupported protocolVersions.
- broker.health reports active invocation count.
- single-invocation broker rejects second active start.
- invocation.start preserves provided invocationId.
- invocation.start with initialInput preserves inputId.
- invocation.status reports currentTurnId during turn_active.
- invocation.stop emits invocation.stopping and exactly one terminal event.
- invocation.dispose emits invocation.disposed exactly once.
- duplicate terminal native/process events do not duplicate terminal broker events.
```

### 12.3 Permission tests

Required:

```text
- deny mode declines and emits permission.resolved deny/policy.
- allow mode approves and emits permission.resolved allow/policy.
- ask-client without negotiated permissionRequests denies and emits diagnostic + permission.resolved deny/policy.
- ask-client with negotiated permissionRequests sends JSON-RPC broker-to-client request.
- ask-client handler allow approves and emits permission.resolved allow/user or api.
- ask-client handler deny declines and emits permission.resolved deny/user or api.
- ask-client timeout with defaultDecision allow approves and emits decidedBy=timeout.
- ask-client timeout with defaultDecision deny declines and emits decidedBy=timeout.
- ask-client timeout without defaultDecision denies.
- handler failure without defaultDecision denies.
- no test expects optimistic approval.
- permission.requested event uses subjectRedacted.
```

### 12.4 Input policy tests

Keep and extend current tests:

```text
- ready invocation accepts user input and emits input.accepted before turn.started.
- unsupported steer rejected before driver apply.
- unsupported append_context rejected before driver apply.
- busy no-policy rejects.
- busy whenBusy=reject rejects.
- queue requested but capability absent returns queue_not_supported.
- FIFO queue path works with test driver that supports sequential inputs.
- queue full emits input.rejected for overflow.
- pending queue evicted on stop/terminal.
- interrupt_then_apply rejected unsupported in v1.
```

### 12.5 Codex event-map tests

Required:

```text
- each known Codex native notification maps to final event type/payload.
- tool nonzero/error maps to tool.call.failed.
- turn failed maps to turn.failed, not turn.completed(status=failed).
- turn interrupted maps to turn.interrupted.
- driver.rawType is populated.
- unknown events do not leak native payloads unless redacted diagnostic policy allows.
```

### 12.6 Redaction/security tests

Required:

```text
- env secret scrubbed from diagnostic/tool/driver notice payloads.
- bearer/token strings scrubbed.
- permission subject redacted.
- invocation.started payload excludes env.
- oversized payload truncates or fails deterministically.
- local image event contains path only.
```

### 12.7 Client integration tests

Required:

```text
- client starts real broker binary and drives fake Codex turn.
- client.startInvocationFromRequest uses exact request object.
- early events are not lost when invocationId is pre-known.
- broker-to-client permission request callback allow/deny works.
- permission timeout/default behavior works through stdio transport.
- broker process exit closes event streams and rejects pending requests.
- malformed broker frames fail transport predictably.
```

---

## 13. PR-by-PR sequence

### PR 1 — protocol event and schema alignment

Files:

```text
packages/harness-broker-protocol/src/events.ts
packages/harness-broker-protocol/src/commands.ts
packages/harness-broker-protocol/src/capabilities.ts
packages/harness-broker-protocol/src/schemas.ts
packages/harness-broker-protocol/test/*
```

Changes:

```text
- add final permission events
- add payload types
- add method class aliases
- extend capabilities
- validate defaultDecision and final event names
```

Exit gate:

```text
bun run --filter spaces-harness-broker-protocol test
bun run --filter spaces-harness-broker-protocol typecheck
```

### PR 2 — protocol server outbound requests

Files:

```text
packages/harness-broker/src/protocol-server.ts
packages/harness-broker/test/protocol-server.test.ts
packages/harness-broker/src/errors.ts
```

Changes:

```text
- support broker-initiated JSON-RPC requests
- route inbound JSON-RPC responses
- pending request timeout/close rejection
- tests for request/response and timeout
```

Exit gate:

```text
bun run --filter spaces-harness-broker test
```

### PR 3 — permission semantics rewrite

Files:

```text
packages/harness-broker/src/drivers/driver.ts
packages/harness-broker/src/invocation-manager.ts
packages/harness-broker/src/broker.ts
packages/harness-broker/src/cli.ts
packages/harness-broker/src/drivers/codex-app-server/permissions.ts
packages/harness-broker-client/src/client.ts
packages/harness-broker-client/test/permission-handler.test.ts
packages/harness-broker/test/drivers/codex-app-server/permissions.test.ts
```

Changes:

```text
- add requestPermission path
- emit permission.requested/resolved audit events
- remove event-based permission request hack
- remove optimistic allow branch
- update client to answer broker-to-client JSON-RPC request only
```

Exit gate:

```text
rg "invocation\.permission\.request' as never|optimistic|auto-approve" packages/harness-broker packages/harness-broker-client
# should return no implementation hits
bun run --filter spaces-harness-broker test
bun run --filter spaces-harness-broker-client test
```

### PR 4 — broker boundary validation

Files:

```text
packages/harness-broker/src/broker.ts
packages/harness-broker/src/cli.ts
packages/harness-broker/src/errors.ts
packages/harness-broker-protocol/src/schemas.ts
packages/harness-broker/test/cli.test.ts
packages/harness-broker/test/protocol-server.test.ts
```

Changes:

```text
- validate command params before broker facade execution
- map validation to JSON-RPC -32602
- add invalid params tests
```

Exit gate:

```text
invalid request tests pass
no handler is raw-casting params without validation
```

### PR 5 — event/state finalization

Files:

```text
packages/harness-broker/src/invocation-manager.ts
packages/harness-broker/src/events.ts
packages/harness-broker/src/security/redaction.ts
packages/harness-broker/src/security/event-safety.ts
packages/harness-broker-protocol/src/events.ts
packages/harness-broker/test/broker-lifecycle.test.ts
packages/harness-broker/test/events.test.ts
packages/harness-broker/test/security/redaction.test.ts
```

Changes:

```text
- final payloads for ready/disposed/failure/interrupted
- manager-level currentTurnId/inputId/childPid tracking
- event validation before emit in tests or debug mode
- central maxEventBytes/redaction behavior
```

Exit gate:

```text
all emitted events validate
redaction tests pass
status tests pass
```

### PR 6 — Codex driver hardening and golden updates

Files:

```text
packages/harness-broker/src/drivers/codex-app-server/driver.ts
packages/harness-broker/src/drivers/codex-app-server/event-map.ts
packages/harness-broker/src/drivers/codex-app-server/input.ts
packages/harness-broker/test/drivers/codex-app-server/*
packages/harness-broker/testdata/codex-app-server/v0/*
```

Changes:

```text
- validate initialize response
- annotate driver.rawType
- map failed/interrupted turns to final event types/payloads
- implement or reject/diagnose unused driver spec fields
- update golden fixtures
```

Exit gate:

```text
Codex driver golden tests pass
fake Codex integration tests pass
```

### PR 7 — client exact start-request API

Files:

```text
packages/harness-broker-client/src/client.ts
packages/harness-broker-client/src/index.ts
packages/harness-broker-client/test/integration.test.ts
packages/harness-broker-client/test/interleaving.test.ts
```

Changes:

```text
- add startInvocationFromRequest
- make old startInvocation wrapper delegate
- expose close hook if needed
- assert no request mutation
```

Exit gate:

```text
client integration tests pass
request immutability tests pass
```

### PR 8 — CLI start-request mode and validation utility

Files:

```text
packages/harness-broker/src/cli.ts
packages/harness-broker/test/cli.test.ts
```

Changes:

```text
- add run-once --start-request
- optionally add validate-start-request --file
- keep --spec/--input compatibility
```

Exit gate:

```text
CLI run-once uses same InvocationStartRequest path as client/HRC
stdout JSON-RPC invariant remains true
```

### PR 9 — boundary and package hygiene

Files:

```text
packages/harness-broker*/package.json
packages/harness-broker*/src/index.ts
scripts/check-boundaries.ts if needed
```

Changes:

```text
- ensure exports expose only intended public surfaces
- prevent client/protocol from importing broker implementation
- prevent broker from importing HRC
- mark v2 attach/replay as unsupported
```

Exit gate:

```text
bun run check:boundaries
bun run --filter spaces-harness-broker-protocol typecheck
bun run --filter spaces-harness-broker-client typecheck
bun run --filter spaces-harness-broker typecheck
```

---

## 14. Acceptance definition for Harness Broker v1

Harness Broker v1 is implementation-ready for HRC Codex headless default only when all are true:

```text
1. Protocol package defines all final v1 commands, broker-to-client permission request method, notification method, capabilities, event names, and payload types.
2. Broker stdio transport supports inbound HRC requests, outbound permission requests, responses, notifications, timeout, and close rejection.
3. `InvocationStartRequest` is validated and consumed as the executable broker contract.
4. Broker preserves provided branded invocationId and inputId values exactly.
5. Broker does not mutate caller-owned start request or input objects.
6. Broker emits append-only ordered events by `(invocationId, seq)`.
7. Every emitted event validates against protocol event vocabulary.
8. Permission behavior is default-deny, explicit, audited, and redacted.
9. There is no optimistic ask-client approval branch.
10. Permission decisions flow through JSON-RPC broker-to-client request, not through fake events.
11. Permission audit facts are emitted as `permission.requested` and `permission.resolved`.
12. Codex app-server native event parsing exists only in the Codex broker driver.
13. HRC-facing client API accepts exact `InvocationStartRequest` objects.
14. Client does not lose early startup events when invocationId is known.
15. Broker hello/status capabilities truthfully report no v1 attach/replay.
16. Redaction and max-event-size behavior are centrally enforced before event notification.
17. CLI stdout remains JSON-RPC-only in stdio mode.
18. All broker/protocol/client tests pass under root `bun run test`.
19. HRC integration consumes ASP `compileRuntimePlan` output and selected `BrokerExecutionProfile`, not direct broker-invocation helper APIs.
20. Existing HRC `/v1` endpoints either expose the new schema-versioned runtime views compatibly or explicitly document why a `/v2` API is required.
```

---

## 15. Explicit non-goals for this plan

Do not implement these in the v1 broker hardening phase:

```text
- HRC HarnessBrokerController
- HRC persistence tables
- HRC BrokerEventMapper
- ASP CompiledRuntimePlan generation
- broker attach/replay
- shared broker process / multi-invocation
- durable broker-side event ledger
- live broker reattach after HRC restart
- Claude/Pi broker drivers
- Agentchat exposure for broker headless
```

Those depend on the broker v1 surface being stable first.

---

## 16. Main risks and mitigations

### Risk 1 — permission semantics become ambiguous

The broker currently has enough permission machinery to look finished while still containing an unsafe optimistic branch. Treat this as the highest-risk issue.

Mitigation:

```text
- remove event-based permission request hack
- remove optimistic allow branch
- add table-driven permission tests for every mode/capability/default/timeout combination
- require permission.resolved audit event for every native permission request
```

### Risk 2 — HRC starts depending on broker internals

If HRC imports driver internals or broker source files, the execution/data-plane boundary collapses.

Mitigation:

```text
- expose only protocol + client packages to HRC
- do not export driver packages as public HRC dependencies
- enforce boundary checks in HRC repo
```

### Risk 3 — event projection drift due to unstable event shapes

If broker event payloads change casually, HRC event projection becomes brittle.

Mitigation:

```text
- finalize event vocabulary in protocol first
- golden-test Codex mappings
- validate emitted events in tests
- keep native event names only in driver.rawType
```

### Risk 4 — identity/hash instability

If broker generates IDs for HRC-owned starts, HRC cannot reliably compare start request hashes or correlate events.

Mitigation:

```text
- require HRC/ASP to provide branded invocationId and inputId for production starts
- broker preserves supplied IDs exactly
- generated IDs remain only CLI/test fallback
- raw strings become branded IDs only through validators/constructors at trust boundaries
- add immutability tests
```

### Risk 5 — redaction misses nested payloads

Tool outputs, diagnostics, and permission subjects can contain secrets.

Mitigation:

```text
- centralize redaction at event emission boundary
- scrub env values and common auth/token strings
- add permission subject redaction
- enforce maxEventBytes/truncation
```

---

## 17. Recommended first cut

The fastest safe route is this sequence:

```text
1. Protocol event/types update.
2. Real broker-to-client permission request support.
3. Remove optimistic permission approval and event hack.
4. Add exact startInvocationFromRequest client API.
5. Harden event payloads/status/dispose.
6. Update Codex golden fixtures.
7. Add validation at stdio broker boundary.
```

Do this before HRC adopts broker Codex headless by default. HRC integration can begin behind a feature flag once PR 3 lands, but default cutover should wait until PRs 1-7 are complete.

---

## 18. Final position

Harness Broker is close enough to be a serious execution plane, but not yet safe enough to be HRC's default Codex headless path. The repo already has the core runtime machinery. The missing work is not broad; it is concentrated around final protocol typing, permission request/decision semantics, event payload hardening, request validation, exact start-request pass-through, and redaction guarantees.

The success criterion is simple:

```text
ASP compiles InvocationStartRequest.
HRC passes it unchanged.
Broker validates it, executes it, and emits normalized facts.
HRC never needs Codex-native knowledge.
```

Once this plan is complete, Harness Broker can carry the Codex headless vertical slice without relying on `exec.ts`, callback/spool delivery, HRC-owned Codex parsing, or hidden HRC-side runtime construction.
