# Agent Runtime Contract Plane Specification

**Status:** Proposed normative architecture  
**Supersedes:** `HRC_BROKER_RUNTIME_CONTROL_PLANE_PROPOSAL.md`  
**Primary decision:** make ASP the compiler, make HRC the runtime control plane, make Harness Broker the execution/data plane, and connect them through versioned, hashable, capability-checked contracts.

---

## 0. Executive thesis

The old proposal correctly identifies the immediate cut: broker-capable harness execution must not continue through `packages/hrc-server/src/launch/exec.ts`. That cut is necessary but not sufficient.

The durable architecture is a three-contract runtime system:

```text
ASP compiler plane
  owns reproducible runtime construction
  emits CompiledRuntimePlan

HRC runtime control plane
  owns route admission, lifecycle, reuse, persistence, policy, API semantics
  emits RuntimeRouteDecision + RuntimeOperation + RuntimeState

Harness Broker execution plane
  owns harness process execution, native driver protocols, normalized broker events
  emits InvocationEventEnvelope + InvocationStatus
```

The key move is to stop treating HRC as the place where runtime execution facts are assembled. HRC is allowed to select, admit, reject, persist, reconcile, stop, and expose a runtime. HRC is not allowed to construct or repair broker execution mechanics after ASP compilation.

The old path:

```text
HRC request
  -> launch artifact
  -> bun run launch/exec.ts
  -> Codex-specific launch detection
  -> Codex stdout / app-server parsing in HRC wrapper
  -> callback/spool back into HRC
```

The target path:

```text
HRC request
  -> ASP compileRuntimePlan(...)
  -> HRC RuntimeRouteDecision selects one compiled execution profile
  -> HRC RuntimeController executes selected profile
  -> HarnessBrokerController passes ASP-emitted startRequest unchanged
  -> Broker protocol
  -> broker driver
  -> harness process
  -> normalized broker events
  -> HRC event projection
```

This is not a vocabulary refactor. It is an ownership refactor with explicit contracts.

---

## 1. Normative language

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

A broker-capable harness route means any route whose selected execution profile can run through Harness Broker, including Codex headless v1 and future Claude/Pi broker drivers.

A legacy path means code under an explicitly named, feature-gated legacy adapter whose only purpose is migration compatibility or rollback. Legacy paths are not extension points.

---

## 2. Closed architecture decisions

### AD-001 — ASP is the compiler

ASP owns runtime construction. It resolves placement, target bundle, model, harness family, harness runtime, prompt/context materialization, environment, process argv, driver spec, continuation encoding, permission policy input, and broker start request construction.

ASP emits one immutable compiler product: `CompiledRuntimePlan`.

### AD-002 — HRC is the runtime control plane

HRC owns route admission, runtime lifecycle, reuse, operation identity, persistence, product/security policy, API response shape, state projection, and reconciliation.

HRC selects one execution profile from the compiled plan. HRC does not reconstruct the selected profile.

### AD-003 — Harness Broker is the execution/data plane

Harness Broker owns harness process execution, native harness driver protocols, process supervision below the broker boundary, permission request emission, input disposition, normalized event stream, invocation status, and driver-level continuation reporting.

### AD-004 — `exec.ts` is not a broker execution boundary

`launch/exec.ts` may survive temporarily as `LegacyExecAdapter` implementation detail. It MUST NOT be used by broker-capable routes. It MUST NOT be the place where Codex, Claude, Pi, or future broker-capable harness semantics accrete.

### AD-005 — capabilities are negotiated, not inferred

`headless`, `sdk`, `tmux`, `codex-cli`, `agent-sdk`, and `broker-capable` are not capability models. Effective runtime behavior is the intersection of compiler-declared requirements, HRC policy, broker hello capabilities, invocation capabilities, and persisted runtime state.

### AD-006 — public compatibility is additive

Public APIs SHOULD add controller/profile/capability fields in place while deriving old `transport: 'tmux' | 'headless' | 'sdk'` aliases for compatibility. New internals MUST NOT branch on legacy `transport`.

### AD-007 — one broker process per HRC runtime for v1

For v1, HRC SHOULD run one broker process per HRC runtime. A shared broker process is not valid until the broker advertises and proves multi-invocation support plus attach/event replay semantics.

### AD-008 — no live broker reattach in v1 unless explicitly implemented

If HRC cannot reattach to a broker process after restart, it MUST reconcile conservatively. It MUST NOT pretend live reuse exists merely because persisted runtime state exists.

### AD-009 — default permission behavior is deny

No explicit allow means deny. No negotiated permission request channel means deny. Timeout means the explicit default decision. If no explicit default exists, deny.

### AD-010 — broker headless has no implicit Agentchat exposure

Broker headless runtimes SHOULD use `AgentchatExposurePolicy: { mode: 'none' }` until a concrete broker target contract exists. They MUST NOT inherit terminal Agentchat behavior accidentally from legacy `exec.ts`.

---

## 3. Contract triangle

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ASP Compiler Plane                                                   │
│                                                                      │
│ Owns: placement, bundle resolution, target materialization, harness   │
│ runtime selection, model resolution, process spec, broker driver spec,│
│ continuation encoding, prompt/context materialization, env/argv,       │
│ redaction, hashes, diagnostics.                                      │
│                                                                      │
│ Output: CompiledRuntimePlan                                          │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ compile contract
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ HRC Runtime Control Plane                                             │
│                                                                      │
│ Owns: route admission, selected profile, reuse, lifecycle, runtime    │
│ operation identity, persistence, product/security policy, API views,  │
│ event projection, restart/reconcile.                                  │
│                                                                      │
│ Output: RuntimeRouteDecision, RuntimeOperation, RuntimeState          │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ broker protocol contract
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Harness Broker Execution Plane                                        │
│                                                                      │
│ Owns: broker process, invocation process, native harness protocol,    │
│ permission requests, input disposition, normalized events, status,     │
│ driver continuation reports.                                          │
│                                                                      │
│ Output: InvocationEventEnvelope, InvocationStatus                     │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 Plane ownership matrix

| Concern | ASP compiler | HRC control plane | Harness Broker |
| --- | --- | --- | --- |
| User/API request normalization | Participates only through compile input | Owns | No |
| Placement resolution | Owns | Requests/rejects | No |
| Bundle/materialized target | Owns | References only | No |
| Harness family/runtime resolution | Owns | Selects among compiled profiles | Reports observed runtime |
| Model resolution | Owns | Enforces policy/admission | No |
| Process command/args/cwd/env | Owns | Transmits unchanged | Executes |
| Broker driver spec | Owns | Transmits unchanged | Interprets |
| Codex app-server descriptors | Owns via compiler/driver contract | Forbidden | Owns/uses inside driver |
| Permission product policy | Provides compile-time policy input shape | Owns final policy/adjudication | Requests/enforces driver decision |
| Permission request transport | No | Coordinates/answers | Emits requests |
| Input queue policy | Emits requested profile/policy | Admits against capabilities | Enforces/disposes |
| Turn lifecycle state | No | Owns projection | Emits normalized facts |
| Native event parsing | No | Forbidden | Owns |
| Runtime reuse | No | Owns | Reports capability/status |
| Restart reconciliation | No | Owns | Supports status/attach when implemented |
| Public API compatibility | No | Owns | No |
| Redaction/hashes for compiled artifacts | Owns | Persists redacted/hash forms | Emits redacted events/status |

---

## 4. System invariants

These invariants are release gates. Violating any of them means the architecture has regressed.

### INV-001 — broker-capable routes do not use `exec.ts`

For any broker-capable harness route, HRC MUST NOT invoke `packages/hrc-server/src/launch/exec.ts`, shell through a launch artifact, or use callback/spool delivery as the execution event bus.

Allowed exception: feature-gated `LegacyExecAdapter` for explicit rollback/migration only.

### INV-002 — HRC does not import harness driver internals

Broker-capable HRC paths MUST NOT import `spaces-harness-codex`, Codex app-server helpers, Claude/Pi driver internals, or future harness driver packages. Driver packages live behind ASP compiler code or Harness Broker driver code.

### INV-003 — HRC does not parse native harness protocols

HRC MUST NOT parse Codex stdout JSONL, Codex app-server native events, Claude SDK native events, Pi native events, or driver-specific process output as protocol. HRC consumes normalized broker events and controller-level state only.

### INV-14.4 — ASP compiler closure invariant

This is the load-bearing invariant for the entire ASP-as-compiler thesis:

> **After ASP emits a `CompiledRuntimePlan`, HRC MUST NOT reconstruct, mutate, patch, infer, or synthesize broker execution mechanics.**

This includes, but is not limited to:

- `HarnessInvocationSpec`
- `InvocationStartRequest`
- `spec.driver`
- driver config
- `spec.process.command`
- `spec.process.args`
- `spec.process.cwd`
- `spec.process.env`
- harness transport descriptors
- Codex app-server descriptors
- prompt/context materialization file paths
- harness-specific continuation encoding
- harness-specific OTEL/config mutation
- native harness launch mode detection

HRC MAY do only these things after compilation:

1. Select one execution profile already present in `CompiledRuntimePlan.executionProfiles`.
2. Reject the plan or selected profile.
3. Persist the redacted plan/profile hashes and diagnostics.
4. Check capability compatibility.
5. Pass ASP-emitted `InvocationStartRequest` to the broker unchanged.
6. Apply HRC-owned product/security decisions through explicit policy fields that are part of the compiled profile or explicitly identified as HRC overlays that do not mutate process/driver mechanics.
7. Ask ASP to recompile if runtime policy, placement, model, harness, continuation, permissions, prompt materialization, environment, or driver requirements change.

If HRC needs a different argv, env, driver config, transport descriptor, continuation shape, prompt materialization strategy, or broker start request, the answer is **recompile**, not patch.

This invariant is stronger than “HRC obtains `HarnessInvocationSpec` from Agent Spaces.” HRC must obtain the complete broker execution profile from ASP and then treat it as immutable.

### INV-005 — route decisions are profile selections

`RuntimeRouteDecision` MUST select one compiled execution profile by `profileId`/`profileHash`. It MUST NOT derive a hidden execution profile from raw harness/provider/transport labels.

### INV-006 — effective behavior is capability-intersection behavior

Runtime behavior MUST be admitted only if all of these are compatible:

```text
ASP expected capabilities
  ∩ HRC route/product policy
  ∩ Broker hello capabilities
  ∩ Broker invocation capabilities
  ∩ persisted runtime capabilities
```

If an expected capability is missing, HRC MUST reject, recompile for a different profile, or explicitly degrade through a documented policy. Silent degradation is forbidden.

### INV-007 — broker events are append-only and idempotent

HRC MUST store broker events by `(invocationId, seq)` and apply them idempotently through one broker event mapper. HRC MUST NOT scatter broker event projection logic across route handlers.

### INV-008 — permissions are explicit and audited

Every broker permission request and decision MUST be auditable. Default behavior is deny. `yolo` MUST compile into explicit allow policy with provenance; it MUST NOT remain a casual boolean flowing through three packages.

### INV-009 — runtime operation identity is mandatory

Every start/dispatch/input/stop/dispose/reconcile action against a runtime MUST have a `RuntimeOperation` or equivalent operation identity. Broker invocation identity MUST NOT be hidden inside `launches`, callback paths, or opaque JSON blobs.

### INV-010 — legacy is not an extension point

`LegacyExecAdapter` MUST be feature-gated, isolated, tested as legacy, and scheduled for deletion. New harness behavior MUST NOT be added to legacy.

---

## 5. Domain object model

Use one object model across compiler output, route decisions, persistence, events, and APIs.

```text
Session
  owns user-visible continuity and conversation/generation identity

Runtime
  owns reusable execution container identity

RuntimeOperation
  owns one control-plane operation against a runtime
  examples: terminal_launch, broker_invocation, sdk_turn, command_process, legacy_exec

CompiledRuntimePlan
  owns ASP's immutable compiler product for a runtime attempt

RuntimeExecutionProfile
  owns one valid execution strategy produced by ASP

RuntimeRouteDecision
  owns HRC's selected profile plus policy/admission decision

BrokerInvocation
  owns one broker protocol invocation and broker-observed capabilities

Turn
  owns one user-visible unit of agent work

Input
  owns one delivered user/steer/context input

Event
  owns append-only normalized facts observed from controllers, broker, hooks, or reconciliation

Artifact
  owns redacted/hash/file-backed runtime artifacts such as compiled plans, specs, prompts, diagnostics
```

`launches` is not a universal domain object. It can describe legacy launch artifacts and terminal bootstraps during migration. It MUST NOT become the broker operation ledger.

### 5.1 Identifier type convention

Identifier DTO fields SHOULD use branded string aliases in
`spaces-runtime-contracts`, not raw `string` aliases:

```ts
export type Id<Name extends string> = string & { readonly __id: Name }

export type RuntimeId = Id<'runtime'>
export type RuntimeOperationId = Id<'runtimeOperation'>
export type RunId = Id<'run'>
export type InvocationId = Id<'invocation'>
export type InputId = Id<'input'>
export type CompileId = Id<'compile'>
export type ProfileId = Id<'profile'>
```

The wire format remains JSON strings. The branding is a TypeScript guardrail so
HRC runtime IDs, broker invocation IDs, run IDs, input IDs, and compiler artifact
IDs cannot be accidentally interchanged in implementation code. Constructors or
validators should sit at trust boundaries and be the only place raw strings are
cast into branded IDs.

---

## 6. Shared runtime contracts package

Create a small shared package:

```text
packages/spaces-runtime-contracts/
  src/compiler-plan.ts
  src/execution-profile.ts
  src/capabilities.ts
  src/route-decision.ts
  src/continuation.ts
  src/redaction.ts
  src/hash.ts
```

Allowed imports:

```text
agent-spaces            -> spaces-runtime-contracts
hrc-server              -> spaces-runtime-contracts
harness-broker-client   -> harness-broker-protocol
harness-broker          -> harness-broker-protocol
```

Disallowed imports:

```text
hrc-server -> spaces-harness-codex
hrc-server -> harness-broker/src/drivers/*
hrc-server -> legacy-exec from broker controller
agent-spaces -> hrc-server
harness-broker -> hrc-server
```

`spaces-runtime-contracts` contains cross-plane DTOs and helpers only. It MUST NOT import HRC server code, broker driver code, or concrete harness packages.

---

## 7. ASP compiler plane

### 7.1 Compile request

HRC calls ASP with intent and product/security overlays before compilation. Compile input is the only place HRC may affect broker execution mechanics.

```ts
export type RuntimeCompileRequest = {
  schemaVersion: 'agent-runtime-compile-request/v1'

  requestId: string
  hostSessionId: string
  generation: number

  placement: RuntimePlacement

  requested: {
    modelProvider?: 'anthropic' | 'openai'
    model?: string
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    harnessFamily?: 'claude-code' | 'codex' | 'pi'
    preferredHarnessRuntime?:
      | 'claude-code-cli'
      | 'claude-agent-sdk'
      | 'codex-cli'
      | 'pi-cli'
      | 'pi-sdk'
    interactionMode?: 'interactive' | 'headless' | 'nonInteractive'
  }

  materialization: {
    initialPrompt?: string
    attachments?: AttachmentRef[]
    taskContext?: HrcTaskContext
    resolvedBundleHint?: ResolvedRuntimeBundle
  }

  hrcPolicy: {
    permissionPolicy?: BrokerPermissionPolicy
    inputPolicy?: BrokerInputPolicy
    exposurePolicy?: AgentchatExposurePolicy
    resourceLimits?: RuntimeResourceLimits
    observability?: RuntimeObservabilityInput
  }

  continuation?: RuntimeContinuationRef

  correlation: {
    traceId?: string
    hostSessionId: string
    runtimeId?: string
    runId?: string
  }
}
```

### 7.2 Compiler output

ASP returns a complete, immutable plan. HRC stores and routes over this plan.

```ts
export type CompiledRuntimePlan = {
  schemaVersion: 'agent-runtime-plan/v1'

  compiler: {
    name: 'agent-spaces'
    version: string
  }

  compileId: string
  planHash: string
  redactedPlanHash: string
  createdAt: string

  placement: RuntimePlacement
  resolvedBundle: ResolvedRuntimeBundle

  harness: {
    family: 'claude-code' | 'codex' | 'pi'
    runtime:
      | 'claude-code-cli'
      | 'claude-agent-sdk'
      | 'codex-cli'
      | 'pi-cli'
      | 'pi-sdk'
    provider: 'anthropic' | 'openai'
  }

  model: {
    provider: 'anthropic' | 'openai'
    modelId: string
    requestedModel?: string
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  }

  executionProfiles: RuntimeExecutionProfile[]

  artifacts: {
    materializedBundleRoot?: string
    systemPromptFile?: string
    userPromptFile?: string
    lockHash?: string
    bundleIdentity: string
  }

  secrets: {
    envKeys: string[]
    secretEnvKeys: string[]
  }

  diagnostics: CompileDiagnostic[]
}
```

### 7.3 Execution profile union

```ts
export type RuntimeExecutionProfile =
  | TerminalExecutionProfile
  | EmbeddedSdkExecutionProfile
  | BrokerExecutionProfile
  | CommandExecutionProfile
  | LegacyExecutionProfile

export type RuntimeExecutionProfileBase = {
  profileId: string
  profileHash: string
  kind:
    | 'terminal'
    | 'embedded-sdk'
    | 'harness-broker'
    | 'command-process'
    | 'legacy-exec'
  interactionMode: 'interactive' | 'headless' | 'nonInteractive'
  expectedCapabilities: CapabilityRequirements
  compatibilityHash: string
  redactedProfile: unknown
}
```

### 7.4 Broker execution profile

This is the critical profile for Codex headless and future broker-capable harnesses.

```ts
export type BrokerExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'harness-broker'
  interactionMode: 'headless'

  brokerProtocol: 'harness-broker/0.1'
  brokerDriver: 'codex-app-server' | string
  brokerOwnership: 'hrc-owned-process'

  harnessInvocation: {
    startRequest: InvocationStartRequest
    specHash: string
    startRequestHash: string
    redactedSpec: RedactedHarnessInvocationSpec
    initialInputHash?: string
  }

  policy: {
    permissionPolicy: BrokerPermissionPolicy
    inputPolicy: BrokerInputPolicy
    exposurePolicy: AgentchatExposurePolicy
  }

  continuation?: {
    hrc?: RuntimeContinuationRef
    broker?: BrokerContinuationRef
  }

  observability: BrokerObservabilityContract
}
```

### 7.5 Compiler determinism and hashing

ASP SHOULD make plans deterministic given:

```text
compile request
resolved bundle lock
compiler version
environment resolution inputs
policy overlays
```

ASP MUST compute:

- `planHash`: hash of the complete canonical plan, excluding ephemeral timestamps and raw secrets.
- `redactedPlanHash`: hash of the redacted plan persisted by HRC.
- `profileHash`: hash of each execution profile.
- `compatibilityHash`: hash over fields that determine runtime reuse compatibility.
- `specHash`: hash of the broker `HarnessInvocationSpec`.
- `startRequestHash`: hash of the broker `InvocationStartRequest`.

HRC MAY use these hashes for persistence, reuse, diagnostics, and boundary tests. HRC MUST NOT use them as a license to reconstruct the underlying artifacts.

### 7.6 Compiler diagnostics

```ts
export type CompileDiagnostic = {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  plane: 'asp-compiler'
  redactedDetails?: unknown
}
```

If ASP cannot construct a valid broker profile, it MUST return diagnostics explaining why. HRC may select a different compiled profile or reject the request. HRC MUST NOT fill in the missing broker mechanics itself.

---

## 8. Capability contract

### 8.1 Capability requirements

```ts
export type CapabilityRequirements = {
  input: {
    user: 'required' | 'optional' | 'forbidden'
    steer: 'required' | 'optional' | 'forbidden'
    appendContext: 'required' | 'optional' | 'forbidden'
    localImages: 'required' | 'optional' | 'forbidden'
    fileRefs: 'required' | 'optional' | 'forbidden'
    queue: 'required' | 'optional' | 'forbidden'
  }

  turns: {
    concurrency: 'single' | 'multiple' | 'any'
    interrupt: 'required' | 'optional' | 'forbidden'
  }

  continuation: 'required' | 'optional' | 'forbidden'
  permissions: 'none' | 'broker-request' | 'client-mediated'

  events: {
    assistantDeltas: 'required' | 'optional'
    toolCalls: 'required' | 'optional'
    usage: 'required' | 'optional'
    diagnostics: 'required' | 'optional'
  }
}
```

### 8.2 Effective capability resolution

```ts
export type CapabilityResolution = {
  selectedProfileHash: string
  requirements: CapabilityRequirements
  hrcPolicy: HrcCapabilityPolicy
  brokerHello?: BrokerCapabilities
  invocation?: InvocationCapabilities
  persistedRuntime?: RuntimeCapabilities
  result:
    | { status: 'compatible'; effective: RuntimeCapabilities }
    | { status: 'reject'; reason: string; missing: string[] }
    | { status: 'degrade'; reason: string; effective: RuntimeCapabilities }
}
```

Degrade is allowed only when explicitly declared by HRC policy. Silent degrade is not allowed.

---

## 9. HRC runtime control plane

### 9.1 Route decision input

HRC route decisions consume a compiled plan, not raw harness strings.

```ts
export type RuntimeRouteInput = {
  intent: HrcRuntimeIntent
  compiledPlan: CompiledRuntimePlan
  existingRuntime?: HrcRuntimeSnapshot
  requestPolicy: HrcRoutePolicy
  now: string
}
```

### 9.2 Route decision output

```ts
export type RuntimeRouteDecision = {
  schemaVersion: 'hrc-route-decision/v1'

  routeId: string
  compileId: string
  planHash: string

  selectedProfileId: string
  selectedProfileHash: string
  selectedProfileKind:
    | 'terminal'
    | 'embedded-sdk'
    | 'harness-broker'
    | 'command-process'
    | 'legacy-exec'

  controller:
    | 'terminal'
    | 'embedded-sdk'
    | 'harness-broker'
    | 'command-process'
    | 'legacy-exec'

  admission:
    | { decision: 'admit' }
    | { decision: 'reject'; reason: string }

  reuse: {
    policy: 'reuse-compatible' | 'always-new' | 'adopt-existing'
    compatibilityHash: string
    staleGeneration: 'rotate' | 'allow'
  }

  productPolicy: {
    permissionPolicy?: BrokerPermissionPolicy
    inputPolicy?: BrokerInputPolicy
    exposurePolicy?: AgentchatExposurePolicy
  }

  capabilities: CapabilityResolution

  legacyTransportAlias: 'tmux' | 'headless' | 'sdk'
}
```

### 9.3 Route decision rule

HRC may decide:

- whether the compiled plan is admissible;
- which compiled profile to use;
- whether to reuse/adopt/create a runtime;
- whether product policy allows the route;
- whether capability requirements are satisfied;
- how to expose compatibility fields.

HRC may not decide:

- broker driver kind/config by inference;
- process argv/env/cwd by patching;
- Codex app-server descriptors;
- native continuation encoding;
- prompt materialization paths;
- native event vocabulary.

If HRC cannot admit any compiled profile, it rejects or asks ASP to compile a different plan.

### 9.4 Runtime controller interface

```ts
export interface RuntimeController<TDecision extends RuntimeRouteDecision = RuntimeRouteDecision> {
  readonly kind: TDecision['controller']

  start(input: RuntimeControllerStartInput<TDecision>): Promise<RuntimeStartResult>
  dispatchTurn(input: RuntimeControllerDispatchInput<TDecision>): Promise<RuntimeDispatchResult>

  deliverInput?(input: RuntimeControllerDispatchInput<TDecision>): Promise<RuntimeDispatchResult>
  interrupt?(runtime: HrcRuntimeSnapshot, reason?: string): Promise<RuntimeInterruptResult>
  stop?(runtime: HrcRuntimeSnapshot, reason?: string): Promise<RuntimeStopResult>
  dispose?(runtime: HrcRuntimeSnapshot): Promise<RuntimeDisposeResult>
  inspect(runtime: HrcRuntimeSnapshot): Promise<RuntimeInspection>
  reconcile(runtime: HrcRuntimeSnapshot): Promise<RuntimeReconcileResult>
}
```

Controllers implement mechanics. They do not recompute route policy.

### 9.5 HarnessBrokerController contract

`HarnessBrokerController` consumes a selected `BrokerExecutionProfile` from the compiled plan. It does not build the profile.

```ts
export interface HarnessBrokerController extends RuntimeController<RuntimeRouteDecision> {
  readonly kind: 'harness-broker'
}
```

Start flow:

```text
HRC receives start/dispatch
  -> HRC calls ASP compileRuntimePlan(...)
  -> HRC selects BrokerExecutionProfile
  -> HRC persists CompiledRuntimePlan redacted artifact
  -> HRC creates RuntimeOperation(kind='broker_invocation')
  -> HRC starts broker process
  -> HRC sends broker.hello
  -> HRC validates capability intersection
  -> HRC sends selectedProfile.harnessInvocation.startRequest unchanged
  -> HRC stores BrokerInvocation
  -> HRC consumes normalized broker events
```

The phrase “unchanged” is intentional. If HRC needs a changed request, it recompiles.

### 9.6 Runtime state

```ts
export type RuntimeState =
  | TerminalRuntimeState
  | EmbeddedSdkRuntimeState
  | BrokerRuntimeState
  | CommandProcessRuntimeState
  | LegacyExecRuntimeState

export type BrokerRuntimeState = {
  kind: 'harness-broker'

  compile: {
    compileId: string
    planHash: string
    selectedProfileId: string
    selectedProfileHash: string
    specHash: string
    startRequestHash: string
  }

  broker: {
    protocolVersion: 'harness-broker/0.1'
    brokerPid?: number
    endpoint: { kind: 'stdio-jsonrpc-ndjson' }
    multiInvocation: boolean
    startedAt: string
    ownerServerInstanceId: string
  }

  invocation: {
    invocationId: string
    state: BrokerInvocationState
    driver: string
    harnessRuntime: string
    childPid?: number
    currentTurnId?: string
    lastEventSeq?: number
    capabilities: InvocationCapabilities
  }

  continuation?: RuntimeContinuationRef
  brokerContinuation?: BrokerContinuationRef
  permission: BrokerPermissionRuntimeState
  input: BrokerInputRuntimeState
  activeRunId?: string
}
```

---

## 10. Harness Broker execution plane

### 10.1 Required broker commands for v1

The broker protocol already has the essential v1 surface:

```text
broker.hello
broker.health
invocation.start
invocation.input
invocation.interrupt
invocation.stop
invocation.status
invocation.dispose
invocation.events
```

HRC v1 uses those commands through `spaces-harness-broker-client`.

### 10.2 Required broker commands for v2

For multi-year durability, add explicit attach/replay commands:

```text
broker.attach
broker.listInvocations
invocation.eventsSince
invocation.ackEvents
invocation.snapshot
invocation.permission.respond
```

V2 restart flow:

```text
HRC restart
  -> load BrokerRuntimeState
  -> broker.attach(runtimeId/invocationId)
  -> invocation.status
  -> invocation.eventsSince(lastEventSeq)
  -> replay through BrokerEventMapper
  -> reconcile runtime/run/message projections
```

Until attach/replay exists, v1 recovery remains conservative.

### 10.3 Broker event normalization

Broker events are the only broker-world event bus. Launch callbacks and spool files are legacy-only.

Required normalized event families:

```text
invocation.started
invocation.ready
input.accepted
input.queued
input.rejected
turn.started
assistant.message.started
assistant.message.delta
assistant.message.completed
tool.call.started
tool.call.delta
tool.call.completed
tool.call.failed
usage.updated
continuation.updated
turn.completed
turn.failed
turn.interrupted
invocation.stopping
invocation.exited
invocation.failed
invocation.disposed
diagnostic
driver.notice
permission.requested
permission.resolved
```

### 10.4 Broker event mapper

```ts
export interface BrokerEventMapper {
  apply(event: InvocationEventEnvelope, context: BrokerEventContext): Promise<BrokerEventApplyResult>
}
```

The mapper MUST be idempotent by `(invocationId, seq)`. The mapper MUST be the only place where broker events become HRC runtime/run/message/event records.

---

## 11. Permission contract

### 11.1 Policy shape

```ts
export type BrokerPermissionPolicy =
  | {
      mode: 'deny'
      audit: true
    }
  | {
      mode: 'allow'
      audit: true
      provenance: {
        source: 'user-request' | 'operator-config' | 'test'
        requestId: string
        createdAt: string
      }
    }
  | {
      mode: 'ask-client'
      timeoutMs: number
      defaultDecision: 'deny' | 'allow'
      surface: 'api' | 'agentchat' | 'both'
      audit: true
    }
```

### 11.2 Decision record

```ts
export type BrokerPermissionDecisionRecord = {
  permissionRequestId: string
  invocationId: string
  runtimeId: string
  runId?: string
  kind: string
  subjectRedactedJson: string
  defaultDecision: 'allow' | 'deny'
  decision: 'allow' | 'deny'
  decidedBy: 'policy' | 'user' | 'api' | 'timeout'
  policy: BrokerPermissionPolicy
  requestedAt: string
  decidedAt: string
}
```

### 11.3 Hard rules

- Default policy is deny.
- `ask-client` requires negotiated permission capability.
- Missing negotiated capability means deny.
- Timeout uses explicit default decision.
- Missing explicit default decision means deny.
- `yolo` compiles to explicit allow with provenance and audit.
- Permission subject is redacted before persistence.

---

## 12. Input contract

```ts
export type BrokerBusyInputPolicy =
  | { whenBusy: 'reject' }
  | { whenBusy: 'queue'; maxDepth: number }
  | { whenBusy: 'interrupt_then_apply'; graceMs: number; enabled: false }

export type BrokerInputPolicy = {
  readyInput: 'start-turn'
  busy: BrokerBusyInputPolicy
  supportedKinds: Array<'user' | 'steer' | 'append_context'>
  attachmentPolicy: {
    localImages: boolean
    fileRefs: boolean
  }
}
```

Codex broker v1 default:

```ts
export const DEFAULT_CODEX_BROKER_INPUT_POLICY: BrokerInputPolicy = {
  readyInput: 'start-turn',
  busy: { whenBusy: 'reject' },
  supportedKinds: ['user'],
  attachmentPolicy: { localImages: true, fileRefs: false },
}
```

Rules:

- If invocation is `ready`, broker input starts a turn.
- If invocation is `turn_active` and policy is reject, HRC returns busy/rejected.
- If policy is queue but broker capability lacks queue support, HRC rejects with `queue-not-supported`.
- If policy is queue and capability supports queue, HRC records queued input/run and waits for broker events.
- `interrupt_then_apply` remains disabled until broker support exists.

---

## 13. Continuation contract

HRC continuation vocabulary is provider-facing. Broker continuation vocabulary is driver-facing. They are bridged by an explicit codec.

```ts
export type HrcContinuationRef = {
  provider: 'anthropic' | 'openai'
  keyHash: string
  key?: string
}

export type BrokerContinuationRef = {
  provider: string
  kind?: 'thread' | 'session' | 'conversation' | string
  keyHash: string
  key?: string
}

export type RuntimeContinuationRef = {
  schemaVersion: 'runtime-continuation/v1'
  hrc: HrcContinuationRef
  broker?: BrokerContinuationRef
  source: 'embedded-sdk' | 'harness-broker' | 'legacy-exec' | 'terminal-hook'
  sourceEvent?: {
    invocationId?: string
    eventSeq?: number
    eventType?: string
  }
  observedAt: string
}
```

Rules:

- ASP owns encoding HRC continuation into broker profile/start request.
- Broker owns reporting native continuation updates.
- HRC owns adopting reported continuation into session/runtime state only after broker event/status proves it exists.
- HRC persists redacted/hash continuation by default.
- HRC persists raw continuation keys only where operationally required.

---

## 14. Persistence contract

### 14.1 New tables

```sql
CREATE TABLE IF NOT EXISTS compiled_runtime_plans (
  plan_hash TEXT PRIMARY KEY,
  compile_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  compiler_name TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  redacted_plan_hash TEXT NOT NULL,
  redacted_plan_json TEXT NOT NULL,
  diagnostics_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_operations (
  operation_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  run_id TEXT,
  host_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  operation_kind TEXT NOT NULL,
  controller TEXT NOT NULL,
  compile_id TEXT,
  plan_hash TEXT,
  selected_profile_id TEXT,
  selected_profile_hash TEXT,
  startup_method TEXT NOT NULL,
  turn_delivery TEXT,
  status TEXT NOT NULL,
  route_decision_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id),
  FOREIGN KEY (plan_hash) REFERENCES compiled_runtime_plans(plan_hash)
);

CREATE TABLE IF NOT EXISTS broker_invocations (
  invocation_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  run_id TEXT,
  broker_protocol TEXT NOT NULL,
  broker_driver TEXT NOT NULL,
  broker_pid INTEGER,
  child_pid INTEGER,
  invocation_state TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  continuation_json TEXT,
  broker_continuation_json TEXT,
  spec_hash TEXT NOT NULL,
  start_request_hash TEXT NOT NULL,
  selected_profile_hash TEXT NOT NULL,
  redacted_spec_json TEXT,
  last_event_seq INTEGER,
  owner_server_instance_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES runtime_operations(operation_id),
  FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE TABLE IF NOT EXISTS broker_invocation_events (
  invocation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  time TEXT NOT NULL,
  type TEXT NOT NULL,
  run_id TEXT,
  runtime_id TEXT NOT NULL,
  broker_event_json TEXT NOT NULL,
  hrc_event_seq INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (invocation_id, seq),
  FOREIGN KEY (invocation_id) REFERENCES broker_invocations(invocation_id),
  FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id)
);

CREATE TABLE IF NOT EXISTS runtime_artifacts (
  artifact_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  redaction_state TEXT NOT NULL,
  artifact_json TEXT,
  artifact_path TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES runtime_operations(operation_id)
);
```

### 14.2 Runtime columns

```sql
ALTER TABLE runtimes ADD COLUMN runtime_controller TEXT;
ALTER TABLE runtimes ADD COLUMN interaction_mode TEXT;
ALTER TABLE runtimes ADD COLUMN harness_family TEXT;
ALTER TABLE runtimes ADD COLUMN harness_runtime TEXT;
ALTER TABLE runtimes ADD COLUMN model_provider TEXT;
ALTER TABLE runtimes ADD COLUMN compile_id TEXT;
ALTER TABLE runtimes ADD COLUMN plan_hash TEXT;
ALTER TABLE runtimes ADD COLUMN selected_profile_hash TEXT;
ALTER TABLE runtimes ADD COLUMN route_decision_json TEXT;
ALTER TABLE runtimes ADD COLUMN runtime_state_json TEXT;
ALTER TABLE runtimes ADD COLUMN legacy_transport TEXT;
```

### 14.3 Migration principle

Migrate behavior before storage cleanup:

1. Add new fields and tables.
2. Write both old and new fields.
3. Read new fields and derive old API fields.
4. Delete old internal branching.
5. Delete legacy `launches` usage for broker routes.
6. Delete legacy execution path.

### 14.4 Persistence rule for compiler closure

Persist enough redacted compiler state to prove HRC selected an ASP-generated profile and did not synthesize one:

- `plan_hash`
- `redacted_plan_hash`
- `compile_id`
- `selected_profile_id`
- `selected_profile_hash`
- `spec_hash`
- `start_request_hash`
- redacted profile/spec artifacts
- compiler diagnostics

This persistence is evidence for INV-14.4. It is not a cache from which HRC may reconstruct process/driver mechanics.

---

## 15. Public API contract

Expose new fields in place. Keep old `transport` only as a derived compatibility alias.

```ts
export type RuntimeExecutionView = {
  runtimeId: string
  hostSessionId: string
  generation: number
  status: string

  controller:
    | { kind: 'terminal'; terminalHost: 'tmux' | 'ghostty' }
    | { kind: 'embedded-sdk' }
    | { kind: 'harness-broker'; brokerDriver: string; brokerProtocol: string }
    | { kind: 'command-process' }
    | { kind: 'legacy-exec'; migrationOnly: true }

  harness?: {
    family: 'claude-code' | 'codex' | 'pi'
    runtime: string
    provider: 'anthropic' | 'openai'
  }

  interactionMode: 'interactive' | 'headless' | 'nonInteractive'
  startupMethod: string
  turnDelivery: string
  capabilities: RuntimeCapabilities

  compileId?: string
  planHash?: string
  selectedProfileHash?: string
  activeOperationId?: string
  activeInvocationId?: string

  /** Compatibility only. New internals must not branch on this. */
  transport: 'tmux' | 'headless' | 'sdk'

  /** Compatibility only. Derived from capabilities. */
  supportsInFlightInput: boolean
}
```

Compatibility mapping:

```ts
export function legacyTransportAlias(view: RuntimeExecutionView): 'tmux' | 'headless' | 'sdk' {
  switch (view.controller.kind) {
    case 'terminal': return 'tmux'
    case 'embedded-sdk': return 'sdk'
    case 'harness-broker': return 'headless'
    case 'command-process': return 'headless'
    case 'legacy-exec': return 'headless'
  }
}
```

---

## 16. Package dependency contract

### 16.1 Allowed HRC dependencies

```text
hrc-server may import:
  agent-spaces
  spaces-runtime-contracts
  spaces-config
  spaces-harness-broker-client
  spaces-harness-broker-protocol
```

### 16.2 Disallowed HRC dependencies for broker-capable routes

```text
hrc-server must not import:
  spaces-harness-codex
  spaces-harness-claude driver internals
  spaces-harness-pi driver internals
  harness-broker/src/drivers/*
```

### 16.3 Boundary checks

```bash
# No broker-capable HRC path may depend on legacy exec.
rg "launch/exec|exec\.ts" packages/hrc-server/src \
  -g '!**/runtime-controllers/legacy-exec/**' \
  -g '!**/__tests__/legacy-exec/**'

# No HRC broker path may import Codex driver internals.
rg "spaces-harness-codex|runCodexAppServerOneShot|codexAppServer" packages/hrc-* \
  -g '!**/runtime-controllers/legacy-exec/**' \
  -g '!**/__tests__/legacy-exec/**'

# No HRC broker path may synthesize broker process/driver mechanics.
rg "driver:|spec\.driver|process\.args|process\.env|InvocationStartRequest|HarnessInvocationSpec" packages/hrc-server/src \
  -g '!**/runtime-controllers/legacy-exec/**' \
  -g '!**/__tests__/**'
```

The third check needs allowlists for type-only references, validation, hashing, and redacted persistence. It must fail on construction/mutation sites.

---

## 17. Route catalog

The route catalog describes valid combinations. HRC route decisions select from compiled profiles and validate against this catalog.

```ts
export const RUNTIME_ROUTE_CATALOG = [
  {
    controller: 'terminal',
    terminalHost: 'tmux',
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-code-cli',
    interactionMode: 'interactive',
    startupMethods: ['create-terminal', 'reuse-existing', 'adopt-terminal'],
    turnDeliveries: ['terminal-launch-input', 'terminal-literal-input'],
  },
  {
    controller: 'terminal',
    terminalHost: 'tmux',
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    interactionMode: 'interactive',
    startupMethods: ['create-terminal', 'reuse-existing', 'adopt-terminal'],
    turnDeliveries: ['terminal-launch-input', 'terminal-literal-input'],
  },
  {
    controller: 'embedded-sdk',
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-agent-sdk',
    interactionMode: 'nonInteractive',
    startupMethods: ['create-sdk-session', 'reuse-existing'],
    turnDeliveries: ['sdk-turn', 'sdk-inflight-input'],
  },
  {
    controller: 'embedded-sdk',
    modelProvider: 'openai',
    harnessFamily: 'pi',
    harnessRuntime: 'pi-sdk',
    interactionMode: 'nonInteractive',
    startupMethods: ['create-sdk-session', 'reuse-existing'],
    turnDeliveries: ['sdk-turn', 'sdk-inflight-input'],
  },
  {
    controller: 'harness-broker',
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    interactionMode: 'headless',
    startupMethods: ['create-broker-invocation', 'reuse-existing'],
    turnDeliveries: ['broker-input'],
    broker: {
      protocolVersion: 'harness-broker/0.1',
      driver: 'codex-app-server',
      processTransport: 'jsonrpc-stdio',
    },
  },
  {
    controller: 'legacy-exec',
    migrationOnly: true,
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    interactionMode: 'headless',
    startupMethods: ['legacy-launch-artifact'],
    turnDeliveries: ['legacy-launch-input'],
    removalGate: 'delete-after-broker-codex-cutover',
  },
] as const
```

Hard exclusions:

- No `openai + claude-code` route.
- No `anthropic + codex` route.
- No SDK runtime under terminal controllers.
- No broker input outside `harness-broker`.
- No `legacy-exec` for new harness behavior.
- No broker-capable Codex headless path through `command-process`.
- No route that requires HRC to construct a broker spec after ASP compilation.

---

## 18. Operational behavior

### 18.1 Broker process ownership

V1 policy:

```ts
export type BrokerProcessOwnership = {
  kind: 'one-broker-process-per-runtime'
  maxActiveInvocations: 1
  sharedBroker: false
}
```

A shared broker process becomes valid only when the broker supports:

```text
multiInvocation: true
broker.attach
invocation.eventsSince
invocation.snapshot
per-invocation permission channels
per-invocation flow control
```

### 18.2 HRC restart and reconciliation

V1 conservative behavior:

```ts
export type BrokerReconcileResult =
  | { state: 'healthy'; status: InvocationStatusResponse }
  | { state: 'broker_process_gone'; action: 'mark_runtime_unknown_or_failed' }
  | { state: 'invocation_gone'; action: 'finalize_active_run_degraded' }
  | { state: 'terminal_without_turn_event'; action: 'synthesize_degraded_completion' }
  | { state: 'reattached'; lastObservedSeq?: number }
```

Rules:

- If HRC cannot reattach to broker, mark runtime `unknown_after_restart`.
- If active run exists and no terminal broker event exists, mark run failed/degraded according to policy.
- If broker status is available and terminal, reconcile active run to terminal state.
- Do not claim live continuation unless broker event/status proves it.

### 18.3 Observability and OTEL

```ts
export type BrokerObservabilityContract = {
  correlation: {
    hostSessionId: string
    runtimeId: string
    runId?: string
    invocationId: string
    traceId?: string
  }
  env: Record<string, string>
  driverConfig?: Record<string, unknown>
  redaction: 'broker-redaction-required'
}
```

Rules:

- HRC owns correlation IDs.
- ASP embeds correlation into compiled profiles.
- Broker/driver owns harness-specific OTEL/config mutation.
- HRC MUST NOT write Codex home config directly for broker routes.

### 18.4 Agentchat exposure

```ts
export type AgentchatExposurePolicy =
  | { mode: 'none' }
  | { mode: 'hrc-registers-target'; targetKind: 'broker-runtime' }
  | { mode: 'broker-reports-target'; targetKind: string }
```

Initial broker headless policy is `mode: 'none'`.

---

## 19. Implementation plan

### Phase 0 — boundary checks and invariant tests

Add warning-mode checks for:

- HRC imports of `spaces-harness-codex`.
- HRC references to Codex app-server helpers.
- HRC spawns of `launch/exec.ts` outside legacy.
- HRC construction/mutation of broker `HarnessInvocationSpec`, driver config, process argv/env/cwd, or Codex descriptors.

Acceptance:

- Violations are visible in CI.
- INV-14.4 has a dedicated failing test/check, not just prose.

### Phase 1 — create `spaces-runtime-contracts`

Add:

- `CompiledRuntimePlan`
- `RuntimeExecutionProfile`
- `BrokerExecutionProfile`
- `CapabilityRequirements`
- `RuntimeContinuationRef`
- redaction/hash helpers

Acceptance:

- ASP, HRC, and tests import shared contracts.
- No concrete harness driver imports appear in shared contracts.

### Phase 2 — ASP emits `CompiledRuntimePlan`

ASP compiler emits terminal, embedded-sdk, broker, command, and legacy profiles where applicable.

Acceptance:

- Golden plans for Codex headless, Codex terminal, Claude terminal, Claude SDK, Pi SDK.
- Broker profile includes complete `InvocationStartRequest`.
- Plan/profile/spec hashes are stable.
- Redacted plan contains no raw secrets.

### Phase 3 — HRC route engine selects compiled profiles

Replace old transport/harness predicate mesh with route decisions over compiled profiles.

Acceptance:

- No new route code branches on raw legacy `transport`.
- Invalid combinations reject before controller start.
- Reuse compatibility uses `compatibilityHash`.

### Phase 4 — isolate `exec.ts` under legacy

Move current wrapper implementation to:

```text
runtime-controllers/legacy-exec/legacy-launch-wrapper.ts
runtime-controllers/legacy-exec/legacy-exec-adapter.ts
```

Keep `launch/exec.ts` only as temporary shim.

Acceptance:

- Legacy route requires `HRC_ENABLE_LEGACY_EXEC_HARNESS=1` or equivalent.
- Broker controller imports nothing from legacy.
- New tests are under broker/route/controller paths, not launch-exec paths.

### Phase 5 — implement `HarnessBrokerController` from compiled profile

Controller consumes selected `BrokerExecutionProfile` and passes ASP-emitted start request unchanged.

Acceptance:

- HRC calls ASP compiler.
- HRC selects broker profile.
- HRC starts broker process.
- HRC sends broker hello.
- HRC sends profile `InvocationStartRequest` unchanged.
- HRC consumes normalized events through one mapper.
- No launch artifact is created.
- No `exec.ts` process is spawned.
- No Codex native event names are inspected by HRC.

### Phase 6 — add persistence

Add compiled plan, runtime operation, broker invocation, broker event, and runtime artifact persistence.

Acceptance:

- Every runtime operation has `operation_id`.
- Every broker invocation has `invocation_id`, `specHash`, `startRequestHash`, capabilities, and `lastEventSeq`.
- Every broker event is idempotent by `(invocationId, seq)`.
- Runtime state can be reconstructed from operation + invocation + event ledger.

### Phase 7 — make Codex headless broker default

Set:

```text
HRC_CODEX_HEADLESS_CONTROLLER=harness-broker
```

Legacy requires explicit opt-in:

```text
HRC_ENABLE_LEGACY_EXEC_HARNESS=1
```

Acceptance:

- Codex headless start/dispatch use `HarnessBrokerController` by default.
- Permission, busy-input, crash, restart, continuation, and event idempotency tests pass.
- Boundary checks fail on non-legacy `exec.ts` use.

### Phase 8 — delete legacy broker-capable harness path

Delete broker-capable harness execution through `exec.ts`.

Acceptance:

- `legacy-exec` route removed from catalog.
- `launch/exec.ts` shim gone or only supports terminal bootstrap with no harness execution semantics.
- HRC has no dependency on `spaces-harness-codex`.
- No broker-capable path depends on launch artifacts, callback/spool delivery, or HRC-owned harness protocol parsing.

### Phase 9 — broker v2 attach/replay

Add broker attach and event replay contracts.

Acceptance:

- HRC restart can reattach to live broker runtimes.
- HRC can replay from `lastEventSeq`.
- Event ack/snapshot semantics are tested.
- Shared broker process remains disabled until broker proves multi-invocation semantics.

---

## 20. Test gates

### 20.1 Compiler contract tests

1. ASP emits `CompiledRuntimePlan` for each supported runtime shape.
2. Broker profile includes complete `InvocationStartRequest`.
3. Broker profile hashes are stable.
4. Redacted plan excludes raw secrets.
5. Recompilation produces a different hash when process/driver mechanics change.
6. HRC cannot construct a broker profile in tests without ASP compiler output.
7. INV-14.4 mutation attempts fail tests.

### 20.2 Boundary tests

1. Broker Codex start does not spawn `launch/exec.ts`.
2. Broker Codex dispatch does not spawn `launch/exec.ts`.
3. HRC broker path does not import `spaces-harness-codex`.
4. HRC broker path does not parse Codex JSONL or app-server native events.
5. `LegacyExecAdapter` is the only path allowed to call legacy wrapper.
6. HRC broker path does not assign `spec.driver`, `spec.process.args`, or `spec.process.env`.

### 20.3 Route tests

1. `openai + codex + headless` resolves to `controller: 'harness-broker'` when broker default is enabled.
2. `openai + codex + interactive` resolves to terminal controller.
3. `anthropic + claude-code + nonInteractive` resolves to embedded SDK unless a real broker profile exists.
4. Explicit SDK harnesses do not reuse CLI runtimes.
5. Old `transport` aliases are derived, not route source of truth.
6. Missing required capability rejects before broker start.

### 20.4 Broker lifecycle tests

1. `broker.hello` protocol mismatch fails cleanly.
2. `invocation.start` persists invocation id, spec hash, and capabilities.
3. `invocation.ready` marks runtime ready.
4. `turn.started` marks run started and runtime busy.
5. `turn.completed` marks run completed and runtime ready.
6. `invocation.failed` fails active run.
7. `invocation.exited` without `turn.completed` finalizes active run degraded.
8. Duplicate broker events are ignored by `(invocationId, seq)`.
9. Out-of-order terminal event handling is deterministic.
10. Broker process exit closes event stream and triggers reconcile.

### 20.5 Permission tests

1. Default deny declines requests and writes audit event.
2. Explicit allow requires provenance and writes audit event.
3. Ask-client without negotiated permission capability denies.
4. Ask-client timeout uses explicit default decision.
5. Missing default decision denies.
6. Permission subject is redacted before persistence.

### 20.6 Input policy tests

1. Ready invocation accepts user input and starts a turn.
2. Busy invocation with reject policy returns busy/rejected.
3. Busy invocation with queue policy but no broker queue capability returns queue-not-supported.
4. FIFO queue path works only when spec, policy, and capabilities all allow it.
5. `interrupt_then_apply` returns unsupported until implemented.

### 20.7 Recovery tests

1. HRC restart with broker runtime in `starting` reconciles to failed/unknown if broker unavailable.
2. HRC restart with broker runtime in `turn_active` and broker unavailable finalizes active run degraded/unknown according to policy.
3. Broker status terminal but HRC active run open reconciles run terminal.
4. Persisted continuation survives HRC restart.
5. Orphan broker cleanup does not kill unrelated harness processes.

---

## 21. Final acceptance definition

The architecture is accepted only when all of these are true:

1. ASP emits versioned, hashable, redacted `CompiledRuntimePlan` artifacts.
2. HRC route decisions select execution profiles from compiled plans.
3. Codex headless routes select `controller: 'harness-broker'` by default.
4. **Invariant 14.4 is enforced:** HRC never reconstructs, mutates, patches, infers, or synthesizes broker driver specs, process argv/env/cwd, `HarnessInvocationSpec`, `InvocationStartRequest`, Codex app-server descriptors, continuation encoding, or harness-specific config after ASP compilation.
5. HRC broker paths do not import Codex harness-driver packages.
6. HRC broker paths do not spawn or reference `launch/exec.ts`.
7. HRC broker paths do not parse Codex stdout, Codex JSONL, or Codex app-server native events.
8. Broker invocation identity, plan hash, selected profile hash, spec hash, start request hash, capabilities, continuation, state, and event sequence are persisted.
9. Broker events are mapped through one idempotent `BrokerEventMapper`.
10. Permission decisions are explicit, audited, redacted, and default-deny.
11. Busy-input behavior is explicit and tested against actual broker capabilities.
12. HRC restart behavior is conservative in v1 and reattachable only after broker attach/replay support exists.
13. Public APIs expose controller/profile/capability fields while deriving old `transport` aliases.
14. Legacy `exec.ts` is feature-gated, isolated, and deleted after Codex broker cutover.
15. Cross-repo boundary checks enforce the intended dependency direction.

Final deletion criterion:

> There is no broker-capable harness execution path in HRC that depends on `exec.ts`, launch artifacts, callback/spool delivery, HRC-owned harness protocol parsing, or HRC-owned reconstruction of ASP-compiled broker execution mechanics.

---

## 22. Summary position

This spec replaces “HRC Broker Runtime Control Plane” with a stronger architecture: **Agent Runtime Contract Plane**.

The system succeeds when the three contracts are coherent:

```text
ASP compiles complete, immutable runtime plans.
HRC selects, controls, persists, and projects runtime behavior.
Harness Broker executes harnesses and normalizes execution events.
```

The decisive invariant is 14.4. Without it, HRC remains a hidden compiler and the broker cutover becomes another wrapper migration. With it, ASP becomes the single source of reproducible runtime construction, HRC becomes a true runtime control plane, and Harness Broker becomes a replaceable execution/data plane with a stable protocol boundary.
