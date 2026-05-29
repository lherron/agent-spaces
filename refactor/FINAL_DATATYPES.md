# FINAL_DATATYPES.md

**Status:** final to-be TypeScript contract DTO surface  
**Scope:** `spaces-runtime-contracts`, ASP compiler API, HRC runtime-control API, Harness Broker protocol/API additions

This file defines the canonical to-be datatypes. Implementations may split these declarations across packages, but wire shapes and semantic fields should remain equivalent.

---

## 0. Package map

```text
packages/spaces-runtime-contracts
  Owns: shared IDs, compiler plan, execution profiles, capability resolution, route decisions,
        runtime state, operations, policy, continuation, hash helpers, public views.

packages/agent-spaces
  Owns: compileRuntimePlan(req) -> RuntimeCompileResponse.
  Imports: spaces-runtime-contracts, spaces-harness-broker-protocol.

packages/spaces-aspc-protocol
  Owns: additive aspc/0.1 JSON-RPC compiler facade DTOs and validators.
  Imports: spaces-runtime-contracts, spaces-harness-broker-protocol.

packages/spaces-aspc-client / packages/spaces-aspc-service
  Own: optional RPC client/service path over the existing ASP compiler SDK implementation.
  Existing SDK callers remain supported.

packages/hrc-server / hrc-core / hrc-sdk
  Owns: public HTTP DTOs, controller result DTOs, persistence records.
  Imports: spaces-runtime-contracts, spaces-harness-broker-client/protocol, and either
           agent-spaces compiler SDK or spaces-aspc-client/protocol.

packages/harness-broker-protocol
  Owns: broker JSON-RPC DTOs, invocation specs, events, capabilities, protocol errors.

packages/harness-broker-client / packages/harness-broker
  Own: client/server protocol execution, not shared HRC DTOs.
```

---

## 1. Shared primitive types

```ts
// spaces-runtime-contracts/src/primitives.ts

export type IsoTimestamp = string
export type JsonObject = Record<string, unknown>
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type SchemaVersion =
  | 'agent-runtime-compile-request/v1'
  | 'agent-runtime-compile-response/v1'
  | 'agent-runtime-plan/v1'
  | 'agent-runtime-profile/v1'
  | 'hrc-route-decision/v1'
  | 'runtime-operation/v1'
  | 'runtime-state/v1'
  | 'runtime-continuation/v1'
  | 'runtime-public-view/v1'
  | 'harness-broker.invocation/v1'
  | 'aspc-compile-harness-invocation-request/v1'
  | 'aspc-compile-harness-invocation-response/v1'
  | 'aspc-compile-and-start-request/v1'
  | 'aspc-compile-and-start-response/v1'

export type ProviderDomain = 'anthropic' | 'openai'
export type HarnessFamily = 'claude-code' | 'codex' | 'pi'
export type HarnessRuntime =
  | 'claude-code-cli'
  | 'claude-agent-sdk'
  | 'codex-cli'
  | 'pi-cli'
  | 'pi-sdk'

export type InteractionMode = 'interactive' | 'headless' | 'nonInteractive'
export type AspcProtocolVersion = 'aspc/0.1'
export type RuntimeControllerKind =
  | 'terminal'
  | 'embedded-sdk'
  | 'harness-broker'
  | 'command-process'
  | 'legacy-exec'

export type RuntimeExecutionProfileKind = RuntimeControllerKind
export type LegacyTransportAlias = 'tmux' | 'headless' | 'sdk'

export type RuntimeStatus =
  | 'allocating'
  | 'compiling'
  | 'admitted'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'unknown_after_restart'
  | 'disposed'
  | string

export type RunStatus =
  | 'accepted'
  | 'started'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'degraded'
  | 'zombie'
  | string
```

---

## 2. Identity and correlation

```ts
// spaces-runtime-contracts/src/ids.ts

export type Id<Name extends string> = string & { readonly __id: Name }

// IDs are branded strings for TypeScript safety and plain strings on the wire.
// Use constructors/validators at trust boundaries; avoid casual `as` casts in
// implementation code outside those constructors.
export type RequestId = Id<'request'>
export type CompileId = Id<'compile'>
export type PlanHash = string
export type ProfileId = Id<'profile'>
export type ProfileHash = string
export type CompatibilityHash = string
export type SpecHash = string
export type StartRequestHash = string
export type ArtifactId = Id<'artifact'>
export type ContentHash = string

export type HostSessionId = Id<'hostSession'>
export type RuntimeId = Id<'runtime'>
export type RuntimeOperationId = Id<'runtimeOperation'>
export type RunId = Id<'run'>
export type TurnId = Id<'turn'>
export type InputId = Id<'input'>
export type InvocationId = Id<'invocation'>
export type MessageId = Id<'message'>
export type ToolCallId = Id<'toolCall'>
export type PermissionRequestId = Id<'permissionRequest'>
export type TraceId = Id<'trace'>
export type ServerInstanceId = Id<'serverInstance'>

export type RuntimeIdentityAllocation = {
  requestId: RequestId
  operationId: RuntimeOperationId
  hostSessionId: HostSessionId
  generation: number
  runtimeId: RuntimeId
  invocationId?: InvocationId | undefined
  initialInputId?: InputId | undefined
  runId?: RunId | undefined
  traceId?: TraceId | undefined
  idempotencyKey?: string | undefined
}

export type RuntimeCorrelation = {
  requestId: RequestId
  operationId?: RuntimeOperationId | undefined
  hostSessionId: HostSessionId
  generation: number
  runtimeId?: RuntimeId | undefined
  runId?: RunId | undefined
  invocationId?: InvocationId | undefined
  traceId?: TraceId | undefined
  appId?: string | undefined
  appSessionKey?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
}
```

---

## 3. Placement, materialization, and external placeholders

These types are placeholders for existing package-owned DTOs. The final contract references them without moving their ownership unless noted.

```ts
// spaces-runtime-contracts/src/external.ts

export type RuntimePlacement = {
  kind?: string | undefined
  root?: string | undefined
  targetName?: string | undefined
  targetDir?: string | undefined
  // NOTE: placement MUST NOT carry env in the compiled plan. ASP resolves only declared
  // lockedEnv (projected onto the execution profiles); operator/ambient env is never projected
  // into placement.
  [key: string]: unknown
}

export type ResolvedRuntimeBundle = {
  bundleIdentity: string
  root?: string | undefined
  lockHash?: string | undefined
  targetName?: string | undefined
  targetDir?: string | undefined
  [key: string]: unknown
}

export type AttachmentRef =
  | { kind: 'local-file'; path: string; mimeType?: string | undefined }
  | { kind: 'image'; path: string; mimeType?: string | undefined }
  | { kind: 'opaque'; ref: string; mimeType?: string | undefined }

export type HrcTaskContext = {
  taskId: string
  phase: string | null
  role: string
  requiredEvidenceKinds: string[]
  hintsText: string
}
```

---

## 4. Hashing and canonicalization types

> **Confidentiality posture (pointer; canonical home: PLANE_SPEC §3.2; execution-env + credential
> sources: §7.5.1).** The contract
> plane may hold raw execution material in memory because HRC must launch the harness. It
> defines **no** generic secret classification, redaction transforms, or digest-substituted
> values. Durable/storage/display planes persist only explicit projections that omit fields
> designated as live execution material. Confidentiality is enforced by not storing/displaying
> those fields — or via runtime env injection, an external secret store, or an on-disk file
> credential outside the compiled DTO (see PLANE_SPEC §7.5.1) — **not** by
> contract-DTO redaction.

```ts
// spaces-runtime-contracts/src/hash.ts

export type HashAlgorithm = 'sha256-canonical-json/v1'

// The canonicalization ALGORITHM (HashAlgorithm) is orthogonal to the projection POLICY
// (RuntimeContractHashProjection). Keep the two version strings separate.
export type RuntimeContractHashProjection = 'runtime-contract-semantic/v2'

export type CanonicalHash = {
  algorithm: HashAlgorithm
  value: string
}

// Hashing rule (replaces the secret-digest model): hashes are closure/dedup/route/reuse/test
// tools, NOT confidentiality controls. Hash material is a named canonical projection selected
// by explicit PATH omission — never key-name matching, never value scanning.
//   - specHash         = HarnessInvocationSpec (lockedEnv included)
//   - startRequestHash = InvocationStartRequest (initialInput included; lockedEnv included)
//   - profileHash      = RuntimeExecutionProfile minus self-hash fields + ephemeral timestamps
//   - planHash         = CompiledRuntimePlan minus self-hash fields + ephemeral timestamps
//   - compatibilityHash = command, args, cwd, pathPrepend, transport, driver config/model/reasoning,
//     bundle identity/lock, policy, resource limits, continuation provider/kind/non-secret identity,
//     + the canonical lockedEnv object (keys and values)
// lockedEnv is a non-secret declared config object and is INCLUDED in
// specHash/startRequestHash/profileHash/planHash/compatibilityHash as the canonical lockedEnv
// object. dispatchEnv is in NONE of them and is never in the compiled projection.
// Hard rule: secrets must NEVER be placed in argv, cwd, driver config, initial input, labels,
// or correlation if those are hashed/persisted/displayed. Secret launch material arrives only
// via process env, runtime env injection, an external secret store/reference, or an on-disk
// file credential — all outside this contract plane (see PLANE_SPEC §7.5.1).
export type HashMaterialPolicy = {
  hashProjection: RuntimeContractHashProjection
  omitPaths: string[]
  timestampMode: 'omit-ephemeral' | 'include-semantic'
}

export interface CanonicalHasher {
  canonicalize(value: unknown, policy?: Partial<HashMaterialPolicy>): string
  hash(value: unknown, policy?: Partial<HashMaterialPolicy>): CanonicalHash
}
```

---

## 5. Capability model

```ts
// spaces-runtime-contracts/src/capabilities.ts

export type CapabilityNeed = 'required' | 'optional' | 'forbidden'

export type CapabilityRequirements = {
  input: {
    user: CapabilityNeed
    steer: CapabilityNeed
    appendContext: CapabilityNeed
    localImages: CapabilityNeed
    fileRefs: CapabilityNeed
    queue: CapabilityNeed
  }
  turns: {
    concurrency: 'single' | 'multiple' | 'any'
    interrupt: CapabilityNeed
  }
  continuation: CapabilityNeed
  permissions: 'none' | 'broker-request' | 'client-mediated'
  events: {
    assistantDeltas: 'required' | 'optional'
    toolCalls: 'required' | 'optional'
    usage: 'required' | 'optional'
    diagnostics: 'required' | 'optional'
  }
  control: {
    stop: CapabilityNeed
    dispose: CapabilityNeed
    reconcile: CapabilityNeed
    attachReplay: CapabilityNeed
  }
}

export type RuntimeCapabilities = {
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
    provider?: string | undefined
    keyKind?: string | undefined
  }
  permissions: {
    mode: 'none' | 'broker-request' | 'client-mediated'
    brokerToClientRequests: boolean
  }
  events: {
    assistantDeltas: boolean
    toolCalls: boolean
    usage: boolean
    diagnostics: boolean
    replay: boolean
    ack: boolean
  }
  control: {
    stop: boolean
    dispose: boolean
    interrupt: boolean
    status: boolean
    attach: boolean
  }
}

export type HrcCapabilityPolicy = {
  allowDegrade: boolean
  allowedDegradations?: Array<{
    path: string
    from: unknown
    to: unknown
    reason: string
  }> | undefined
  requireBrokerDefaultForCodexHeadless: boolean
}

export type CapabilityResolution = {
  selectedProfileHash: ProfileHash
  requirements: CapabilityRequirements
  hrcPolicy: HrcCapabilityPolicy
  brokerHello?: BrokerCapabilities | undefined
  invocation?: InvocationCapabilities | undefined
  persistedRuntime?: RuntimeCapabilities | undefined
  result:
    | { status: 'compatible'; effective: RuntimeCapabilities }
    | { status: 'reject'; reason: string; missing: string[] }
    | { status: 'degrade'; reason: string; effective: RuntimeCapabilities; degradations: string[] }
}
```

`assistantDeltas` describes only availability of streaming `assistant.message.delta` events. It does not make complete assistant messages optional and MUST NOT be used to opt out of the required `assistant.message.completed` contract. `events.assistantDeltas: false` means the runtime cannot stream token/text deltas; it still MUST emit completed natural assistant messages, including intermediate messages with `final: false` and exactly one terminal assistant message with `final: true` per turn.

---

## 6. Permission, input, exposure, resource, observability policies

```ts
// spaces-runtime-contracts/src/permissions.ts

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
        requestId: RequestId
        createdAt: IsoTimestamp
      }
    }
  | {
      mode: 'ask-client'
      timeoutMs: number
      defaultDecision: 'deny' | 'allow'
      surface: 'api' | 'agentchat' | 'both'
      audit: true
    }

export type BrokerPermissionRequestKind = 'command' | 'file_change' | 'tool' | string

export type BrokerPermissionRequest = {
  permissionRequestId: PermissionRequestId
  invocationId: InvocationId
  runtimeId: RuntimeId
  runId?: RunId | undefined
  turnId?: TurnId | undefined
  kind: BrokerPermissionRequestKind
  subject: unknown
  defaultDecision: 'allow' | 'deny'
  deadlineMs?: number | undefined
  requestedAt: IsoTimestamp
}

export type BrokerPermissionDecision = {
  permissionRequestId: PermissionRequestId
  decision: 'allow' | 'deny'
  message?: string | undefined
  decidedAt: IsoTimestamp
}

export type BrokerPermissionDecisionRecord = {
  permissionRequestId: PermissionRequestId
  invocationId: InvocationId
  runtimeId: RuntimeId
  runId?: RunId | undefined
  kind: BrokerPermissionRequestKind
  subjectDisplayJson: string
  defaultDecision: 'allow' | 'deny'
  decision: 'allow' | 'deny'
  decidedBy: 'policy' | 'user' | 'api' | 'timeout'
  policy: BrokerPermissionPolicy
  requestedAt: IsoTimestamp
  decidedAt: IsoTimestamp
}

export type BrokerPermissionRuntimeState = {
  policy: BrokerPermissionPolicy
  negotiated: boolean
  pending: BrokerPermissionRequest[]
  lastDecision?: BrokerPermissionDecisionRecord | undefined
}

// spaces-runtime-contracts/src/input.ts

export type BrokerInputKind = 'user' | 'steer' | 'append_context'

export type BrokerBusyInputPolicy =
  | { whenBusy: 'reject' }
  | { whenBusy: 'queue'; maxDepth: number }
  | { whenBusy: 'interrupt_then_apply'; graceMs: number; enabled: false }

export type BrokerInputPolicy = {
  readyInput: 'start-turn'
  busy: BrokerBusyInputPolicy
  supportedKinds: BrokerInputKind[]
  attachmentPolicy: {
    localImages: boolean
    fileRefs: boolean
  }
}

export type BrokerInputRuntimeState = {
  policy: BrokerInputPolicy
  pendingDepth: number
  lastInputId?: InputId | undefined
  lastDisposition?: 'started' | 'queued' | 'rejected' | undefined
}

export const DEFAULT_CODEX_BROKER_INPUT_POLICY: BrokerInputPolicy = {
  readyInput: 'start-turn',
  busy: { whenBusy: 'reject' },
  supportedKinds: ['user'],
  attachmentPolicy: { localImages: true, fileRefs: false },
}

// spaces-runtime-contracts/src/exposure.ts

export type AgentchatExposurePolicy =
  | { mode: 'none' }
  | { mode: 'hrc-registers-target'; targetKind: 'broker-runtime' }
  | { mode: 'broker-reports-target'; targetKind: string }

export type BrokerTerminalSurface = {
  host: 'tmux'
  startupMethod: 'create-terminal' | 'reuse-existing' | 'adopt-terminal'
  turnDelivery: 'terminal-literal-input'
  operatorAttach: true
  // Must match BrokerExecutionProfile.policy.exposurePolicy exactly.
  exposurePolicy: { mode: 'broker-reports-target'; targetKind: 'tmux-pane' }
}

export type BrokerTerminalSurfaceReport =
  | {
      kind: 'tmux-pane'
      socketPath: string
      sessionId: string
      windowId: string
      paneId: string
      sessionName?: string | undefined
      windowName?: string | undefined
    }
  | {
      // Legacy non-leased report shape accepted during migration.
      kind: 'tmux-session'
      socketPath: string
      sessionName: string
      paneId?: string | undefined
    }

// spaces-runtime-contracts/src/resources.ts

export type RuntimeResourceLimits = {
  startupTimeoutMs?: number | undefined
  turnTimeoutMs?: number | undefined
  stopGraceMs?: number | undefined
  maxEventBytes?: number | undefined
  maxInputQueueDepth?: number | undefined
  maxRuntimeAgeMs?: number | undefined
}

// spaces-runtime-contracts/src/observability.ts

export type RuntimeObservabilityInput = {
  traceId?: TraceId | undefined
  otel?:
    | {
        enabled: boolean
        endpoint?: string | undefined
        headers?: Record<string, string> | undefined
      }
    | undefined
}

export type BrokerObservabilityContract = {
  correlation: {
    requestId: RequestId
    operationId: RuntimeOperationId
    hostSessionId: HostSessionId
    generation: number
    runtimeId: RuntimeId
    runId?: RunId | undefined
    invocationId: InvocationId
    traceId?: TraceId | undefined
  }
  driverConfig?: Record<string, unknown> | undefined
}
```

---

## 7. Continuation types

```ts
// spaces-runtime-contracts/src/continuation.ts

export type HrcContinuationRef = {
  provider: ProviderDomain
  continuationId: string
  key?: string | undefined
}

export type BrokerContinuationRef = {
  provider: string
  kind?: 'thread' | 'session' | 'conversation' | string | undefined
  continuationId: string
  key?: string | undefined
}

export type RuntimeContinuationRef = {
  schemaVersion: 'runtime-continuation/v1'
  hrc: HrcContinuationRef
  broker?: BrokerContinuationRef | undefined
  source: 'embedded-sdk' | 'harness-broker' | 'legacy-exec' | 'terminal-hook'
  sourceEvent?:
    | {
        invocationId?: InvocationId | undefined
        eventSeq?: number | undefined
        eventType?: string | undefined
      }
    | undefined
  observedAt: IsoTimestamp
}
```

---

## 8. ASP compiler API and plan datatypes

```ts
// spaces-runtime-contracts/src/compiler-plan.ts

export type BrokerDriverSelectionPreferences = {
  /**
   * Exact driver request. If provided with selectionMode='exact', compile fails unless
   * that driver can produce a valid selected profile.
   */
  kind?: string | undefined
  /** Candidate allowlist evaluated by the compiler before materialization. */
  allow?: string[] | undefined
  /** Candidate denylist evaluated by the compiler before materialization. */
  deny?: string[] | undefined
  /** Compiler-defined capability ids that the selected driver/profile must satisfy. */
  requireCapabilities?: string[] | undefined
  /**
   * Client-late, compiler-early selection. The client may defer driver choice to ASP,
   * but ASP selects before materialization and before emitting HarnessInvocationSpec.
   */
  selectionMode?: 'exact' | 'best-available' | undefined
}

export type RuntimeCompileRequest = {
  schemaVersion: 'agent-runtime-compile-request/v1'
  identity: RuntimeIdentityAllocation

  placement: RuntimePlacement

  requested: {
    modelProvider?: ProviderDomain | undefined
    model?: string | undefined
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
    harnessFamily?: HarnessFamily | undefined
    preferredHarnessRuntime?: HarnessRuntime | undefined
    interactionMode?: InteractionMode | undefined
    /** Optional additive broker-driver preference; ignored by non-broker profiles. */
    brokerDriver?: BrokerDriverSelectionPreferences | undefined
  }

  materialization: {
    initialPrompt?: string | undefined
    attachments?: AttachmentRef[] | undefined
    taskContext?: HrcTaskContext | undefined
    resolvedBundleHint?: ResolvedRuntimeBundle | undefined
  }

  hrcPolicy: {
    permissionPolicy?: BrokerPermissionPolicy | undefined
    inputPolicy?: BrokerInputPolicy | undefined
    exposurePolicy?: AgentchatExposurePolicy | undefined
    resourceLimits?: RuntimeResourceLimits | undefined
    observability?: RuntimeObservabilityInput | undefined
    capabilityPolicy?: HrcCapabilityPolicy | undefined
  }

  continuation?: RuntimeContinuationRef | undefined
  correlation: RuntimeCorrelation
}

export type RuntimeCompileResponse =
  | {
      schemaVersion: 'agent-runtime-compile-response/v1'
      ok: true
      plan: CompiledRuntimePlan
      diagnostics: CompileDiagnostic[]
    }
  | {
      schemaVersion: 'agent-runtime-compile-response/v1'
      ok: false
      diagnostics: CompileDiagnostic[]
    }

export type CompiledRuntimePlan = {
  schemaVersion: 'agent-runtime-plan/v1'
  compiler: {
    name: 'agent-spaces'
    version: string
  }
  compileId: CompileId
  planHash: PlanHash
  createdAt: IsoTimestamp

  identity: RuntimeIdentityAllocation
  placement: RuntimePlacement
  resolvedBundle: ResolvedRuntimeBundle

  harness: {
    family: HarnessFamily
    runtime: HarnessRuntime
    provider: ProviderDomain
  }

  model: {
    provider: ProviderDomain
    modelId: string
    requestedModel?: string | undefined
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
  }

  executionProfiles: RuntimeExecutionProfile[]

  artifacts: {
    materializedBundleRoot?: string | undefined
    systemPromptFile?: string | undefined
    userPromptFile?: string | undefined
    lockHash?: string | undefined
    bundleIdentity: string
  }

  lockedEnv: {
    lockedEnvKeys: string[]
  }

  diagnostics: CompileDiagnostic[]
}

export type CompileDiagnostic = {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  plane: 'asp-compiler'
  profileId?: ProfileId | undefined
  details?: unknown
}
```

---

### 8.1 ASPC JSON-RPC compiler facade datatypes

These types live in `spaces-aspc-protocol`. They are additive: the existing
`agent-spaces` SDK compiler API remains intact, and broker protocol DTOs remain in
`spaces-harness-broker-protocol`.

```ts
// spaces-aspc-protocol/src/commands.ts

export type AspcMethodV1 =
  | 'aspc.hello'
  | 'aspc.compileRuntimePlan'
  | 'aspc.compileHarnessInvocation'
  | 'aspc.compileAndStart'

export type AspcCommand =
  | JsonRpcRequest<'aspc.hello', AspcHelloRequest>
  | JsonRpcRequest<'aspc.compileRuntimePlan', RuntimeCompileRequest>
  | JsonRpcRequest<'aspc.compileHarnessInvocation', AspcCompileHarnessInvocationRequest>
  | JsonRpcRequest<'aspc.compileAndStart', AspcCompileAndStartRequest>

export interface AspcHelloRequest {
  clientInfo: {
    name: string
    version?: string | undefined
  }
  protocolVersions: AspcProtocolVersion[]
  capabilities?:
    | {
        compileAndStart?: boolean | undefined
      }
    | undefined
}

export interface AspcHelloResponse {
  compilerInfo: {
    name: 'agent-spaces'
    version: string
  }
  protocolVersion: AspcProtocolVersion
  supportedCompileSchemas: Array<'agent-runtime-compile-request/v1'>
  supportedResponseSchemas: Array<'agent-runtime-compile-response/v1'>
  supportedProviders: ProviderDomain[]
  supportedHarnessRuntimes: HarnessRuntime[]
  supportedDriverKinds: string[]
  /**
   * Present only for a co-hosted ASPC+broker facade. This is descriptive only;
   * broker.hello remains the authoritative broker capability negotiation.
   */
  cohostedBroker?:
    | {
        protocolVersions: Array<'harness-broker/0.1'>
        driverKinds: string[]
      }
    | undefined
}

export type BrokerProfileSelector = {
  profileId?: ProfileId | undefined
  profileHash?: ProfileHash | undefined
  brokerDriver?: string | undefined
  interactionMode?: 'headless' | 'interactive' | undefined
  selectionMode?: 'exact' | 'best-available' | undefined
}

export type AspcCompileHarnessInvocationRequest = {
  schemaVersion: 'aspc-compile-harness-invocation-request/v1'
  compile: RuntimeCompileRequest
  /**
   * Optional selector over the compiled plan's BrokerExecutionProfile candidates.
   * Driver selection remains client-late but compiler-early: ASP selects before
   * materialization and returns a concrete HarnessInvocationSpec.
   */
  profileSelector?: BrokerProfileSelector | undefined
}

export type AspcCompileHarnessInvocationResponse =
  | {
      schemaVersion: 'aspc-compile-harness-invocation-response/v1'
      ok: true
      compile: Extract<RuntimeCompileResponse, { ok: true }>
      selectedProfile: BrokerExecutionProfile
      startRequest: InvocationStartRequest
      spec: HarnessInvocationSpec
      initialInput?: InvocationInput | undefined
      diagnostics: CompileDiagnostic[]
    }
  | {
      schemaVersion: 'aspc-compile-harness-invocation-response/v1'
      ok: false
      compile?: RuntimeCompileResponse | undefined
      diagnostics: CompileDiagnostic[]
    }

export type AspcCompileAndStartRequest = {
  schemaVersion: 'aspc-compile-and-start-request/v1'
  compile: AspcCompileHarnessInvocationRequest
  /**
   * Dispatch-time overlays for the broker InvocationDispatchRequest. They are
   * never part of the compiled profile or hash material.
   */
  dispatchEnv?: Record<string, string> | undefined
  runtime?: InvocationRuntimeContext | undefined
}

export type AspcCompileAndStartResponse =
  | {
      schemaVersion: 'aspc-compile-and-start-response/v1'
      ok: true
      compile: Extract<AspcCompileHarnessInvocationResponse, { ok: true }>
      dispatch: InvocationDispatchRequest
      start: InvocationStartResponse
    }
  | {
      schemaVersion: 'aspc-compile-and-start-response/v1'
      ok: false
      phase: 'compile'
      compile?: AspcCompileHarnessInvocationResponse | undefined
      diagnostics: CompileDiagnostic[]
    }
  | {
      schemaVersion: 'aspc-compile-and-start-response/v1'
      ok: false
      phase: 'broker-start'
      compile: Extract<AspcCompileHarnessInvocationResponse, { ok: true }>
      dispatch: InvocationDispatchRequest
      error: RuntimeControlError | JsonRpcError
    }
```

`aspc.compileAndStart` is a convenience facade only. Canonical clients may always call
`aspc.compileHarnessInvocation`, then broker `invocation.start` with
`InvocationDispatchRequest { startRequest, dispatchEnv?, runtime? }`.

---

## 9. Execution profile datatypes

```ts
// spaces-runtime-contracts/src/execution-profile.ts

export type RuntimeExecutionProfile =
  | TerminalExecutionProfile
  | EmbeddedSdkExecutionProfile
  | BrokerExecutionProfile
  | CommandExecutionProfile
  | LegacyExecutionProfile

export type RuntimeExecutionProfileBase = {
  schemaVersion: 'agent-runtime-profile/v1'
  profileId: ProfileId
  profileHash: ProfileHash
  compatibilityHash: CompatibilityHash
  kind: RuntimeExecutionProfileKind
  interactionMode: InteractionMode
  expectedCapabilities: CapabilityRequirements
  diagnostics?: CompileDiagnostic[] | undefined
}

export type TerminalExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'terminal'
  interactionMode: 'interactive'
  terminal: {
    host: 'foreground' | 'tmux' | 'ghostty'
    startupMethod: 'create-terminal' | 'reuse-existing' | 'adopt-terminal' | 'inherit-current-terminal'
    turnDelivery: 'terminal-launch-input' | 'terminal-literal-input'
  }
  process: {
    command: string
    args: string[]
    cwd: string
    // ASP-declared environment required for the harness to function. Hash-covered;
    // HRC MUST NOT modify it. Declared config only — never ambient/operator env, never credentials.
    lockedEnv: Record<string, string>
    io:
      | { kind: 'inherit' }
      | { kind: 'pty'; cols?: number | undefined; rows?: number | undefined }
  }
  policy: {
    exposurePolicy: AgentchatExposurePolicy
    resourceLimits?: RuntimeResourceLimits | undefined
  }
}

export type EmbeddedSdkExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'embedded-sdk'
  interactionMode: 'nonInteractive'
  sdk: {
    runtime: 'claude-agent-sdk' | 'pi-sdk'
    startupMethod: 'create-sdk-session' | 'reuse-existing'
    turnDelivery: 'sdk-turn' | 'sdk-inflight-input'
  }
  session: {
    provider: ProviderDomain
    modelId: string
    cwd: string
    // ASP-declared environment required for the harness to function. Hash-covered;
    // HRC MUST NOT modify it. Declared config only — never ambient/operator env, never credentials.
    lockedEnv: Record<string, string>
    // Ordered directories prepended to the final composed PATH. PATH stays out of
    // lockedEnv; this typed field is launch shape and participates in profile and
    // compatibility hash material.
    pathPrepend?: string[] | undefined
  }
  policy: {
    inputPolicy?: BrokerInputPolicy | undefined
    resourceLimits?: RuntimeResourceLimits | undefined
  }
  continuation?: RuntimeContinuationRef | undefined
}

export type BrokerExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'harness-broker'
  interactionMode: 'headless' | 'interactive'

  brokerProtocol: 'harness-broker/0.1'
  brokerDriver: 'codex-app-server' | 'claude-code-tmux' | 'codex-cli-tmux' | string
  brokerOwnership: 'hrc-owned-process'
  // Selection/exposure metadata for broker-owned interactive terminal surfaces.
  // The launch truth remains harnessInvocation.startRequest.spec.
  brokerTerminal?: BrokerTerminalSurface | undefined

  harnessInvocation: {
    startRequest: InvocationStartRequest
    specHash: SpecHash
    startRequestHash: StartRequestHash
    initialInputHash?: string | undefined
  }

  policy: {
    permissionPolicy: BrokerPermissionPolicy
    inputPolicy: BrokerInputPolicy
    exposurePolicy: AgentchatExposurePolicy
    resourceLimits?: RuntimeResourceLimits | undefined
  }

  continuation?:
    | {
        hrc?: RuntimeContinuationRef | undefined
        broker?: BrokerContinuationRef | undefined
      }
    | undefined

  observability: BrokerObservabilityContract
}

export type CommandExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'command-process'
  interactionMode: 'headless' | 'nonInteractive'
  command: {
    startupMethod: 'create-command-process' | 'reuse-existing'
    turnDelivery: 'process-stdin' | 'none'
    argv: string[]
    cwd: string
    // ASP-declared environment required for the harness to function. Hash-covered;
    // HRC MUST NOT modify it. Declared config only — never ambient/operator env, never credentials.
    lockedEnv: Record<string, string>
    shell?:
      | {
          executable?: string | undefined
          login?: boolean | undefined
          interactive?: boolean | undefined
        }
      | undefined
  }
  policy: {
    resourceLimits?: RuntimeResourceLimits | undefined
    exposurePolicy?: AgentchatExposurePolicy | undefined
  }
}

export type LegacyExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'legacy-exec'
  interactionMode: 'headless'
  migrationOnly: true
  removalGate: 'delete-after-broker-codex-cutover'
  legacy: {
    startupMethod: 'legacy-launch-artifact'
    turnDelivery: 'legacy-launch-input'
    launchArtifactShape: 'hrc-launch-artifact/v1'
  }
}
```

---

## 10. Broker protocol datatypes

These types live in `spaces-harness-broker-protocol`. Existing names are preserved where possible; final additions are marked by comments.

```ts
// spaces-harness-broker-protocol/src/jsonrpc.ts

export type JsonRpcId = string | number | null

export interface JsonRpcRequest<TMethod extends string = string, TParams = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: TMethod
  params?: TParams | undefined
}

export interface JsonRpcNotification<TMethod extends string = string, TParams = unknown> {
  jsonrpc: '2.0'
  method: TMethod
  params?: TParams | undefined
}

export interface JsonRpcResultResponse<TResult = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: TResult
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcResultResponse<TResult> | JsonRpcErrorResponse
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

// spaces-harness-broker-protocol/src/invocation.ts

export interface HarnessInvocationSpec {
  specVersion: 'harness-broker.invocation/v1'
  invocationId?: InvocationId | undefined
  labels?: Record<string, string> | undefined
  harness: HarnessDescriptor
  process: HarnessProcessSpec
  interaction?: InteractionSpec | undefined
  continuation?: ContinuationSpec | undefined
  driver: CodexAppServerDriverSpec | ClaudeCodeTmuxDriverSpec | CodexCliTmuxDriverSpec | UnknownDriverSpec
  correlation?: Record<string, string> | undefined
}

export interface HarnessDescriptor {
  frontend: string
  provider?: string | undefined
  driver: 'codex-app-server' | 'claude-code-tmux' | 'codex-cli-tmux' | string
}

export interface HarnessProcessSpec {
  command: string
  args: string[]
  cwd: string
  // ASP-declared environment required for the harness to function. Hash-covered; HRC MUST NOT
  // modify it. Contains only declared config resolved from space/agent/target configuration —
  // never the operator/ambient environment, never credentials.
  lockedEnv?: Record<string, string> | undefined
  // Ordered directories prepended to the final composed PATH. Hash-covered.
  // PATH itself stays reserved and outside lockedEnv.
  pathPrepend?: string[] | undefined
  harnessTransport: HarnessTransportSpec
  limits?: ProcessLimits | undefined
}

export type HarnessTransportSpec =
  | { kind: 'jsonrpc-stdio' }
  | { kind: 'pipes' }
  | { kind: 'pty'; cols?: number | undefined; rows?: number | undefined }

export interface InteractionSpec {
  mode: 'headless' | 'interactive' | 'service'
  turnConcurrency?: 'single' | undefined
  inputQueue?: 'none' | 'fifo' | undefined
}

export interface ContinuationSpec {
  provider: string
  key: string
  kind?: 'thread' | 'session' | 'conversation' | string | undefined
}

export interface ProcessLimits {
  startupTimeoutMs?: number | undefined
  turnTimeoutMs?: number | undefined
  stopGraceMs?: number | undefined
  maxEventBytes?: number | undefined
}

export interface CodexAppServerDriverSpec {
  kind: 'codex-app-server'
  resumeThreadId?: string | undefined
  model?: string | undefined
  modelReasoningEffort?: string | undefined
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | undefined
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
  profile?: string | undefined
  defaultImageAttachments?: string[] | undefined
  permissionPolicy?: DriverPermissionPolicy | undefined
  resumeFallback?: 'start-fresh' | 'fail' | undefined
}

export interface ClaudeCodeTmuxDriverSpec {
  kind: 'claude-code-tmux'
  terminalHost: 'tmux'
  hookBridge: 'claude-code-hooks/v1'
  eventSource: 'terminal-hook'
}

export interface CodexCliTmuxDriverSpec {
  kind: 'codex-cli-tmux'
  terminalHost: 'tmux'
  hookBridge: 'codex-hooks/v1'
  eventSource: 'codex-lifecycle-hooks+rollout-transcript-tail'
  hooks: {
    requiredEvents: [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'Stop',
    ]
    commandEnvVar: 'HRC_LAUNCH_HOOK_CLI'
    trustStatePathMode: 'canonical-realpath'
  }
  normalization: {
    continuationSource: 'session_id'
    turnIdSource: 'turn_id'
    permissionCorrelation: 'turn_id+tool_input.command'
    transcriptPathSource: 'SessionStart.transcript_path'
    intermediateAssistantMessageSource: 'rollout-transcript-tail'
    finalAssistantMessageSource: 'rollout-task_complete'
    deltas: 'not-emitted'
  }
}

export type CodexTurnLifecycleHookEventName =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'Stop'

export type CodexLifecycleHookEventName = 'SessionStart' | CodexTurnLifecycleHookEventName

export interface CodexSessionStartHookPayload {
  session_id: string
  transcript_path: string
  cwd: string
  hook_event_name: 'SessionStart'
  model?: string | undefined
  permission_mode?: string | undefined
}

export interface CodexLifecycleHookPayloadBase {
  session_id: string
  turn_id: string
  transcript_path: string
  cwd: string
  hook_event_name: CodexTurnLifecycleHookEventName
  model: string
  permission_mode: string
}

export type CodexUserPromptSubmitHookPayload = CodexLifecycleHookPayloadBase & {
  hook_event_name: 'UserPromptSubmit'
  prompt: string
}

export type CodexPreToolUseHookPayload = CodexLifecycleHookPayloadBase & {
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id: string
}

export type CodexPermissionRequestHookPayload = CodexLifecycleHookPayloadBase & {
  hook_event_name: 'PermissionRequest'
  tool_name: string
  tool_input: {
    command: string
    description?: string | undefined
    [key: string]: unknown
  }
  // Codex PermissionRequest hook payloads do not include tool_use_id in v1.
}

export type CodexPostToolUseHookPayload = CodexLifecycleHookPayloadBase & {
  hook_event_name: 'PostToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_response: unknown
  tool_use_id: string
}

export type CodexStopHookPayload = CodexLifecycleHookPayloadBase & {
  hook_event_name: 'Stop'
  stop_hook_active: boolean
}

export type CodexCliTmuxHookPayload =
  | CodexSessionStartHookPayload
  | CodexUserPromptSubmitHookPayload
  | CodexPreToolUseHookPayload
  | CodexPermissionRequestHookPayload
  | CodexPostToolUseHookPayload
  | CodexStopHookPayload

export interface DriverPermissionPolicy {
  mode: 'deny' | 'allow' | 'ask-client'
  timeoutMs?: number | undefined
  defaultDecision?: 'allow' | 'deny' | undefined
}

export interface UnknownDriverSpec {
  kind: string
  [key: string]: unknown
}
```

```ts
// spaces-harness-broker-protocol/src/capabilities.ts

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
    provider?: string | undefined
    keyKind?: string | undefined
  }
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
  permissions?:
    | {
        brokerToClientRequests: boolean
        eventAudit: boolean
      }
    | undefined
}

export interface BrokerCapabilities {
  multiInvocation: boolean
  transports: Array<'stdio-jsonrpc-ndjson'>
  eventNotifications: true
  brokerToClientRequests: boolean
  attachReplay?: boolean | undefined
}

export interface DriverSummary {
  kind: string
  version: string
  available: boolean
  capabilities?: InvocationCapabilities | undefined
  unavailableReason?: string | undefined
}

export interface ClientCapabilities {
  permissionRequests?: boolean | undefined
  eventAcks?: boolean | undefined
}
```

```ts
// spaces-harness-broker-protocol/src/commands.ts

export type BrokerMethodV1 =
  | 'broker.hello'
  | 'broker.health'
  | 'invocation.start'
  | 'invocation.input'
  | 'invocation.interrupt'
  | 'invocation.stop'
  | 'invocation.status'
  | 'invocation.dispose'

export type BrokerMethodV2 =
  | BrokerMethodV1
  | 'broker.attach'
  | 'broker.listInvocations'
  | 'invocation.eventsSince'
  | 'invocation.ackEvents'
  | 'invocation.snapshot'
  | 'invocation.permission.respond'

export type BrokerToClientRequestMethod = 'invocation.permission.request'
export type BrokerNotificationMethod = 'invocation.event'

export type BrokerCommand =
  | JsonRpcRequest<'broker.hello', BrokerHelloRequest>
  | JsonRpcRequest<'broker.health', BrokerHealthRequest>
  | JsonRpcRequest<'invocation.start', InvocationDispatchRequest>
  | JsonRpcRequest<'invocation.input', InvocationInputRequest>
  | JsonRpcRequest<'invocation.interrupt', InvocationInterruptRequest>
  | JsonRpcRequest<'invocation.stop', InvocationStopRequest>
  | JsonRpcRequest<'invocation.status', InvocationStatusRequest>
  | JsonRpcRequest<'invocation.dispose', InvocationDisposeRequest>

export interface BrokerHelloRequest {
  clientInfo: {
    name: string
    version?: string | undefined
  }
  protocolVersions: string[]
  capabilities?: ClientCapabilities | undefined
}

export interface BrokerHelloResponse {
  brokerInfo: {
    name: 'harness-broker'
    version: string
  }
  protocolVersion: 'harness-broker/0.1'
  capabilities: BrokerCapabilities
  drivers: DriverSummary[]
}

export interface BrokerHealthRequest {
  probeDrivers?: boolean | undefined
}

export interface BrokerHealthResponse {
  status: 'ok' | 'degraded' | 'shutting_down'
  activeInvocations: number
  drivers?: DriverSummary[] | undefined
}

export interface InvocationStartRequest {
  spec: HarnessInvocationSpec
  initialInput?: InvocationInput | undefined
}

export type InvocationRuntimeContext = {
  terminalSurface?: TmuxPaneTerminalSurfaceLease | undefined

  /**
   * Deprecated boundary shim for runtime.tmux.socketPath, accepted only during
   * migration from socket-only tmux dispatch. If both fields are present,
   * terminalSurface wins.
   */
  tmux?: { socketPath: string } | undefined
}

export type TmuxPaneTerminalSurfaceLease = {
  kind: 'tmux-pane'
  ownership: 'hrc'
  socketPath: string
  sessionId: string
  windowId: string
  paneId: string
  sessionName?: string | undefined
  windowName?: string | undefined
  allowedOps: {
    inspect: true
    sendInput: true
    sendInterrupt: true
    capture?: boolean | undefined
    resize?: boolean | undefined
  }
}

// Outer dispatch envelope. HRC constructs it and MAY populate dispatchEnv (per-invocation,
// non-identity context — handles/correlation, e.g. a wrkq handoff id). `startRequest` is
// forwarded byte/semantically unchanged and is the only hashed payload. `dispatchEnv` is
// validated at dispatch by the broker, never hashed, never persisted in the contract projection
// plane, and is NOT a recompile trigger. `runtime.terminalSurface` carries HRC-owned
// dispatch resources such as tmux pane leases and is also outside compiled hash material.
export interface InvocationDispatchRequest {
  startRequest: InvocationStartRequest
  dispatchEnv?: Record<string, string>
  runtime?: InvocationRuntimeContext
}

export interface InvocationStartResponse {
  invocationId: InvocationId
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

export interface InvocationInputRequest {
  invocationId: InvocationId
  input: InvocationInput
  policy?: InputPolicy | undefined
}

export interface InvocationInput {
  inputId?: InputId | undefined
  kind: 'user' | 'steer' | 'append_context'
  content: InputContent[]
  metadata?: Record<string, string> | undefined
}

export type InputContent =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string }
  | { type: 'file_ref'; path: string; mimeType?: string | undefined }

export interface InputPolicy {
  whenBusy: 'reject' | 'queue' | 'interrupt_then_apply'
  timeoutMs?: number | undefined
}

export interface InvocationInputResponse {
  inputId: InputId
  accepted: boolean
  disposition: 'started' | 'queued' | 'rejected'
  reason?: string | undefined
  turnId?: TurnId | undefined
}

export interface InvocationInterruptRequest {
  invocationId: InvocationId
  scope: 'turn' | 'invocation'
  reason?: string | undefined
  graceMs?: number | undefined
}

export interface InvocationInterruptResponse {
  accepted: boolean
  effect: 'turn_interrupted' | 'invocation_stopping' | 'unsupported' | 'no_active_turn'
  reason?: string | undefined
}

export interface InvocationStopRequest {
  invocationId: InvocationId
  reason?: string | undefined
  graceMs?: number | undefined
}

export interface InvocationStopResponse {
  accepted: boolean
  state: InvocationState
}

export interface InvocationStatusRequest {
  invocationId: InvocationId
}

export interface InvocationStatusResponse {
  invocationId: InvocationId
  state: InvocationState
  currentTurnId?: TurnId | undefined
  continuation?: ContinuationUpdate | undefined
  capabilities: InvocationCapabilities
  process?:
    | {
        pid?: number | undefined
        exitCode?: number | null | undefined
        signal?: string | null | undefined
      }
    | undefined
}

export interface InvocationDisposeRequest {
  invocationId: InvocationId
}

export interface InvocationDisposeResponse {
  disposed: true
}

export interface PermissionRequestParams {
  invocationId: InvocationId
  turnId?: TurnId | undefined
  permissionRequestId: PermissionRequestId
  kind: 'command' | 'file_change' | 'tool' | string
  subject: unknown
  defaultDecision: 'allow' | 'deny'
  deadlineMs?: number | undefined
}

export interface PermissionDecision {
  decision: 'allow' | 'deny'
  message?: string | undefined
}
```

---

## 11. Broker event datatypes

```ts
// spaces-harness-broker-protocol/src/events.ts

export interface InvocationEventEnvelope<TPayload = InvocationEventPayload> {
  invocationId: InvocationId
  seq: number
  time: IsoTimestamp
  type: InvocationEventType
  payload: TPayload
  turnId?: TurnId | undefined
  inputId?: InputId | undefined
  itemId?: string | undefined
  correlation?: Record<string, string> | undefined
  driver?:
    | {
        kind: string
        rawType?: string | undefined
      }
    | undefined
}

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
  // Broker-owned terminal attach surface report. Not broker.attach/replay.
  | 'terminal.surface.reported'
  | 'permission.requested'
  | 'permission.resolved'

export type InvocationEventPayload =
  | InvocationStartedPayload
  | InvocationReadyPayload
  | InvocationStoppingPayload
  | InvocationExitedPayload
  | InvocationFailedPayload
  | InvocationDisposedPayload
  | ContinuationUpdate
  | InputDispositionPayload
  | TurnStartedPayload
  | TurnCompletedPayload
  | TurnFailedPayload
  | TurnInterruptedPayload
  | AssistantMessageStartedPayload
  | AssistantMessageDeltaPayload
  | AssistantMessageCompletedPayload
  | ToolCallStartedPayload
  | ToolCallDeltaPayload
  | ToolCallCompletedPayload
  | ToolCallFailedPayload
  | UsageUpdatedPayload
  | DiagnosticPayload
  | DriverNoticePayload
  | TerminalSurfaceReportedPayload
  | PermissionRequestedPayload
  | PermissionResolvedPayload

export interface InvocationStartedPayload {
  pid?: number | undefined
  // Process-backed invocations provide command/args. In-process SDK invocations
  // instead identify the controller/sdk below and MUST NOT fake a spawned process.
  command?: string | undefined
  args?: string[] | undefined
  cwd: string
  controller?: string | undefined
  sdk?:
    | {
        runtime: 'claude-agent-sdk' | 'pi-sdk'
        sessionKey?: string | undefined
      }
    | undefined
}

export interface InvocationReadyPayload {
  state: 'ready'
}

export interface InvocationStoppingPayload {
  reason?: string | undefined
}

export interface InvocationExitedPayload {
  exitCode?: number | null | undefined
  signal?: string | null | undefined
}

export interface InvocationFailedPayload {
  message: string
  code?: string | undefined
  data?: unknown
}

export interface InvocationDisposedPayload {
  disposed: true
}

export interface ContinuationUpdate {
  provider: string
  key: string
  kind?: string | undefined
}

export interface InputDispositionPayload {
  inputId: InputId
  reason?: string | undefined
}

export interface TurnStartedPayload {
  turnId: TurnId
}

export interface TurnCompletedPayload {
  turnId: TurnId
  status: 'completed' | 'failed' | 'interrupted'
  finalOutput?: string | undefined
  // True when the normalized controller stream observed assistant text, tool
  // calls/results, or other content-bearing turn activity. Tool-only SDK turns
  // set this true even when finalOutput is empty.
  producedContent?: boolean | undefined
  usage?: unknown
}

export interface TurnFailedPayload {
  turnId: TurnId
  message: string
  code?: string | undefined
  data?: unknown
}

export interface TurnInterruptedPayload {
  turnId: TurnId
  reason?: string | undefined
}

export interface AssistantMessageStartedPayload {
  messageId: MessageId
}

export interface AssistantMessageDeltaPayload {
  messageId: MessageId
  text: string
}

export interface AssistantMessageCompletedPayload {
  messageId: MessageId
  content: Array<{ type: 'text'; text: string }>
  // Required turn-terminal marker. `false` means this completed natural
  // assistant message is not the terminal answer for the turn; `true` marks the
  // terminal assistant message for the turn and MUST appear exactly once.
  final: boolean
}

export interface ToolCallStartedPayload {
  toolCallId: ToolCallId
  name: string
  input?: unknown
}

export interface ToolCallDeltaPayload {
  toolCallId: ToolCallId
  text?: string | undefined
  data?: unknown
}

export interface ToolCallCompletedPayload {
  toolCallId: ToolCallId
  name: string
  result?: unknown
  isError?: boolean | undefined
  durationMs?: number | undefined
}

export interface ToolCallFailedPayload {
  toolCallId: ToolCallId
  name: string
  message: string
  code?: string | undefined
  data?: unknown
}

export interface UsageUpdatedPayload {
  usage: unknown
}

export interface DiagnosticPayload {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  source?: 'controller' | 'broker' | 'harness' | 'driver' | undefined
  data?: unknown
}

export interface DriverNoticePayload {
  message: string
  code?: string | undefined
  data?: unknown
}

export type TerminalSurfaceReportedPayload = BrokerTerminalSurfaceReport

export interface PermissionRequestedPayload {
  permissionRequestId: PermissionRequestId
  kind: 'command' | 'file_change' | 'tool' | string
  subjectDisplay: unknown
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

`AssistantMessageCompletedPayload.final` means "terminal assistant message for the turn", not "this message item is internally complete." Drivers that receive completed assistant messages before they know turn completion MUST use a held-latest pattern: retain the newest completed natural assistant message as the possible terminal answer, emit the previously held message with `final: false` when a later natural assistant message appears, and flush the held message with `final: true` when the turn terminal is known. `assistant.message.delta` remains optional streaming evidence and is governed only by `events.assistantDeltas`.

---

## 12. Broker v2 attach/replay datatypes

```ts
// spaces-harness-broker-protocol/src/attach.ts

export interface BrokerAttachRequest {
  runtimeId: RuntimeId
  invocationId: InvocationId
  ownerServerInstanceId: ServerInstanceId
  lastObservedSeq?: number | undefined
}

export interface BrokerAttachResponse {
  attached: boolean
  invocationId: InvocationId
  state: InvocationState
  capabilities: InvocationCapabilities
  lastSeq?: number | undefined
  reason?: string | undefined
}

export interface BrokerListInvocationsRequest {
  includeDisposed?: boolean | undefined
}

export interface BrokerListInvocationsResponse {
  invocations: Array<{
    invocationId: InvocationId
    state: InvocationState
    driver: string
    currentTurnId?: TurnId | undefined
    lastSeq?: number | undefined
  }>
}

export interface InvocationEventsSinceRequest {
  invocationId: InvocationId
  afterSeq: number
  limit?: number | undefined
}

export interface InvocationEventsSinceResponse {
  invocationId: InvocationId
  events: InvocationEventEnvelope[]
  lastSeq: number
  hasMore: boolean
}

export interface InvocationAckEventsRequest {
  invocationId: InvocationId
  throughSeq: number
}

export interface InvocationAckEventsResponse {
  ackedThroughSeq: number
}

export interface InvocationSnapshotRequest {
  invocationId: InvocationId
}

export interface InvocationSnapshotResponse {
  invocationId: InvocationId
  state: InvocationState
  currentTurnId?: TurnId | undefined
  lastSeq: number
  continuation?: ContinuationUpdate | undefined
  capabilities: InvocationCapabilities
  process?: {
    pid?: number | undefined
    exitCode?: number | null | undefined
    signal?: string | null | undefined
  }
}
```

---

## 13. Route decision datatypes

```ts
// spaces-runtime-contracts/src/route-decision.ts

export type HrcRuntimeIntent = {
  placement: RuntimePlacement
  harness: {
    provider: ProviderDomain
    interactive: boolean
    id?: 'agent-sdk' | 'claude-code' | 'codex-cli' | 'pi' | 'pi-cli' | 'pi-sdk' | undefined
    fallback?: string | undefined
    model?: string | undefined
    yolo?: boolean | undefined
  }
  execution?:
    | {
        preferredMode?: InteractionMode | undefined
        autoLaunchInteractive?: boolean | undefined
        allowFallback?: boolean | undefined
      }
    | undefined
  launch?:
    | {
        env?: Record<string, string> | undefined
        unsetEnv?: string[] | undefined
        pathPrepend?: string[] | undefined
      }
    | undefined
  initialPrompt?: string | undefined
  attachments?: AttachmentRef[] | undefined
  taskContext?: HrcTaskContext | undefined
}

export type HrcRoutePolicy = {
  codexHeadlessDefaultController: 'harness-broker' | 'legacy-exec'
  allowLegacyExec: boolean
  allowSilentFallback: false
  staleGeneration: 'rotate' | 'allow'
  reuse: 'reuse-compatible' | 'always-new' | 'adopt-existing'
  capabilityPolicy: HrcCapabilityPolicy
}

export type RuntimeRouteInput = {
  intent: HrcRuntimeIntent
  compiledPlan: CompiledRuntimePlan
  existingRuntime?: HrcRuntimeSnapshot | undefined
  requestPolicy: HrcRoutePolicy
  now: IsoTimestamp
}

export type RuntimeRouteDecision = {
  schemaVersion: 'hrc-route-decision/v1'
  routeId: string
  operationId: RuntimeOperationId
  compileId: CompileId
  planHash: PlanHash

  selectedProfileId: ProfileId
  selectedProfileHash: ProfileHash
  selectedProfileKind: RuntimeExecutionProfileKind
  controller: RuntimeControllerKind

  admission:
    | { decision: 'admit' }
    | { decision: 'reject'; reason: string; code: string }

  reuse: {
    policy: 'reuse-compatible' | 'always-new' | 'adopt-existing'
    compatibilityHash: CompatibilityHash
    staleGeneration: 'rotate' | 'allow'
    existingRuntimeId?: RuntimeId | undefined
  }

  productPolicy: {
    permissionPolicy?: BrokerPermissionPolicy | undefined
    inputPolicy?: BrokerInputPolicy | undefined
    exposurePolicy?: AgentchatExposurePolicy | undefined
    resourceLimits?: RuntimeResourceLimits | undefined
  }

  capabilities: CapabilityResolution
  legacyTransportAlias: LegacyTransportAlias

  diagnostics?: Array<{
    level: 'info' | 'warning' | 'error'
    code: string
    message: string
  }> | undefined
}
```

---

## 14. Runtime controller datatypes

```ts
// spaces-runtime-contracts/src/controller.ts

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

export type RuntimeControllerStartInput<TDecision extends RuntimeRouteDecision> = {
  decision: TDecision
  compiledPlan: CompiledRuntimePlan
  selectedProfile: RuntimeExecutionProfile
  operation: RuntimeOperation
  // HRC-supplied per-invocation context. This is the concrete dispatchEnv
  // channel for in-process embedded-sdk controller.start() and the source for
  // the broker InvocationDispatchRequest envelope. It is never part of the
  // compiled plan and is hashed nowhere.
  dispatchEnv?: Record<string, string> | undefined
  existingRuntime?: HrcRuntimeSnapshot | undefined
}

export type RuntimeControllerDispatchInput<TDecision extends RuntimeRouteDecision> = {
  decision: TDecision
  runtime: HrcRuntimeSnapshot
  operation: RuntimeOperation
  input: RuntimeInputEnvelope
  dispatchEnv?: Record<string, string> | undefined
}

export interface HarnessBrokerController extends RuntimeController<RuntimeRouteDecision> {
  readonly kind: 'harness-broker'
}

export interface EmbeddedSdkController extends RuntimeController<RuntimeRouteDecision> {
  readonly kind: 'embedded-sdk'
}

// Broker and embedded-sdk controllers emit the same normalized controller-event
// envelope at the HRC boundary. Embedded SDK controllers do not expose native SDK
// events directly and do not define a parallel event taxonomy.
export type ControllerEventEnvelope = InvocationEventEnvelope
export type EmbeddedSdkControllerEventEnvelope = ControllerEventEnvelope

export type RuntimeInputEnvelope = {
  inputId: InputId
  runId?: RunId | undefined
  kind: 'user' | 'steer' | 'append_context'
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'local_image'; path: string }
    | { type: 'file_ref'; path: string; mimeType?: string | undefined }
  >
  metadata?: Record<string, string> | undefined
}

export type RuntimeStartResult =
  | { ok: true; runtime: HrcRuntimeSnapshot; operation: RuntimeOperation; view: RuntimeExecutionView }
  | { ok: false; operation: RuntimeOperation; error: RuntimeControlError }

export type RuntimeDispatchResult =
  | {
      ok: true
      runId: RunId
      runtime: HrcRuntimeSnapshot
      operation: RuntimeOperation
      disposition: 'started' | 'queued' | 'accepted'
    }
  | {
      ok: false
      operation: RuntimeOperation
      error: RuntimeControlError
      disposition?: 'busy' | 'rejected' | 'unsupported' | undefined
    }

export type RuntimeInterruptResult =
  | { ok: true; effect: 'turn_interrupted' | 'invocation_stopping' | 'no_active_turn' }
  | { ok: false; error: RuntimeControlError }

export type RuntimeStopResult =
  | { ok: true; runtime: HrcRuntimeSnapshot; state: RuntimeStatus }
  | { ok: false; error: RuntimeControlError }

export type RuntimeDisposeResult =
  | { ok: true; runtimeId: RuntimeId; disposed: true }
  | { ok: false; error: RuntimeControlError }

export type RuntimeInspection = {
  runtime: HrcRuntimeSnapshot
  state: RuntimeState
  activeOperation?: RuntimeOperation | undefined
  activeInvocation?: BrokerInvocationRecord | undefined
}

export type RuntimeReconcileResult =
  | { state: 'healthy'; status?: InvocationStatusResponse | undefined }
  | { state: 'broker_process_gone'; action: 'mark_runtime_unknown_or_failed' }
  | { state: 'invocation_gone'; action: 'finalize_active_run_degraded' }
  | { state: 'terminal_without_turn_event'; action: 'synthesize_degraded_completion' }
  | { state: 'reattached'; lastObservedSeq?: number | undefined }
```

---

## 15. Runtime state datatypes

```ts
// spaces-runtime-contracts/src/runtime-state.ts

export type RuntimeState =
  | TerminalRuntimeState
  | EmbeddedSdkRuntimeState
  | BrokerRuntimeState
  | CommandProcessRuntimeState
  | LegacyExecRuntimeState

export type RuntimeStateBase = {
  schemaVersion: 'runtime-state/v1'
  kind: RuntimeControllerKind
  runtimeId: RuntimeId
  hostSessionId: HostSessionId
  generation: number
  status: RuntimeStatus
  activeRunId?: RunId | undefined
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type TerminalRuntimeState = RuntimeStateBase & {
  kind: 'terminal'
  terminal: {
    host: 'tmux' | 'ghostty'
    sessionId?: string | undefined
    windowId?: string | undefined
    paneId?: string | undefined
  }
  capabilities: RuntimeCapabilities
  continuation?: RuntimeContinuationRef | undefined
}

export type EmbeddedSdkRuntimeState = RuntimeStateBase & {
  kind: 'embedded-sdk'
  sdk: {
    runtime: 'claude-agent-sdk' | 'pi-sdk'
    sessionKey?: string | undefined
  }
  capabilities: RuntimeCapabilities
  continuation?: RuntimeContinuationRef | undefined
}

export type BrokerRuntimeState = RuntimeStateBase & {
  kind: 'harness-broker'

  compile: {
    compileId: CompileId
    planHash: PlanHash
    selectedProfileId: ProfileId
    selectedProfileHash: ProfileHash
    specHash: SpecHash
    startRequestHash: StartRequestHash
  }

  broker: {
    protocolVersion: 'harness-broker/0.1'
    brokerPid?: number | undefined
    endpoint: { kind: 'stdio-jsonrpc-ndjson' }
    multiInvocation: boolean
    startedAt: IsoTimestamp
    ownerServerInstanceId: ServerInstanceId
  }

  invocation: {
    invocationId: InvocationId
    state: InvocationState
    driver: string
    harnessRuntime: HarnessRuntime | string
    childPid?: number | undefined
    currentTurnId?: TurnId | undefined
    lastEventSeq?: number | undefined
    capabilities: InvocationCapabilities
  }
  terminalSurface?:
    | (BrokerTerminalSurfaceReport & {
        reportedAt: IsoTimestamp
      })
    | undefined

  continuation?: RuntimeContinuationRef | undefined
  brokerContinuation?: BrokerContinuationRef | undefined
  permission: BrokerPermissionRuntimeState
  input: BrokerInputRuntimeState
}

export type CommandProcessRuntimeState = RuntimeStateBase & {
  kind: 'command-process'
  process: {
    pid?: number | undefined
    argv: string[]
    cwd: string
  }
  capabilities: RuntimeCapabilities
}

export type LegacyExecRuntimeState = RuntimeStateBase & {
  kind: 'legacy-exec'
  migrationOnly: true
  launchId?: string | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined
}
```

---

## 16. HRC snapshot, operation, run, and event records

```ts
// spaces-runtime-contracts/src/operations.ts

export type RuntimeOperationKind =
  | 'terminal_launch'
  | 'broker_invocation'
  | 'broker_input'
  | 'sdk_turn'
  | 'command_process'
  | 'legacy_exec'
  | 'interrupt'
  | 'stop'
  | 'dispose'
  | 'reconcile'

export type RuntimeOperationStatus =
  | 'accepted'
  | 'admitted'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'

export type RuntimeOperation = {
  schemaVersion: 'runtime-operation/v1'
  operationId: RuntimeOperationId
  runtimeId: RuntimeId
  runId?: RunId | undefined
  hostSessionId: HostSessionId
  generation: number
  operationKind: RuntimeOperationKind
  controller: RuntimeControllerKind
  compileId?: CompileId | undefined
  planHash?: PlanHash | undefined
  selectedProfileId?: ProfileId | undefined
  selectedProfileHash?: ProfileHash | undefined
  startupMethod: string
  turnDelivery?: string | undefined
  status: RuntimeOperationStatus
  routeDecision: RuntimeRouteDecision
  createdAt: IsoTimestamp
  startedAt?: IsoTimestamp | undefined
  completedAt?: IsoTimestamp | undefined
  updatedAt: IsoTimestamp
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type HrcRuntimeSnapshot = {
  runtimeId: RuntimeId
  runtimeKind?: 'harness' | 'command' | undefined
  hostSessionId: HostSessionId
  scopeRef: string
  laneRef: string
  generation: number

  controller: RuntimeControllerKind
  interactionMode: InteractionMode
  harnessFamily?: HarnessFamily | undefined
  harnessRuntime?: HarnessRuntime | string | undefined
  provider: ProviderDomain
  modelProvider?: ProviderDomain | undefined

  status: RuntimeStatus
  runtimeState?: RuntimeState | undefined

  compileId?: CompileId | undefined
  planHash?: PlanHash | undefined
  selectedProfileHash?: ProfileHash | undefined
  routeDecision?: RuntimeRouteDecision | undefined

  continuation?: RuntimeContinuationRef | undefined
  capabilities: RuntimeCapabilities
  supportsInflightInput: boolean

  activeOperationId?: RuntimeOperationId | undefined
  activeInvocationId?: InvocationId | undefined
  activeRunId?: RunId | undefined

  legacyTransport: LegacyTransportAlias
  transport: LegacyTransportAlias
  launchId?: string | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined

  adopted: boolean
  lastActivityAt?: IsoTimestamp | undefined
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type HrcRunRecord = {
  runId: RunId
  hostSessionId: HostSessionId
  runtimeId?: RuntimeId | undefined
  operationId?: RuntimeOperationId | undefined
  invocationId?: InvocationId | undefined
  scopeRef: string
  laneRef: string
  generation: number
  controller: RuntimeControllerKind
  transport: LegacyTransportAlias
  status: RunStatus
  acceptedAt?: IsoTimestamp | undefined
  startedAt?: IsoTimestamp | undefined
  completedAt?: IsoTimestamp | undefined
  updatedAt: IsoTimestamp
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type HrcEventEnvelope = {
  seq: number
  streamSeq: number
  ts: IsoTimestamp
  hostSessionId: HostSessionId
  scopeRef: string
  laneRef: string
  generation: number
  runId?: RunId | undefined
  runtimeId?: RuntimeId | undefined
  operationId?: RuntimeOperationId | undefined
  invocationId?: InvocationId | undefined
  source: 'agent-spaces' | 'broker' | 'hook' | 'hrc' | 'otel' | 'tmux'
  eventKind: string
  eventJson: unknown
}
```

---

## 17. Broker invocation persistence records

Projection DTOs are **persist/display-boundary** types computed where artifacts are persisted
or displayed. They are the named canonical projections selected by `RuntimeContractHashProjection`.
The projection DTOs MAY carry `lockedEnv` (declared, non-secret config); ambient, credential, and
dispatch env are never present. They are **NOT** embedded in the live `BrokerExecutionProfile` —
the live profile carries the raw `startRequest` plus `specHash`/`startRequestHash` only (HRC needs
the raw request to launch).

```ts
// spaces-runtime-contracts/src/persistence.ts

// Persist/display-boundary projections. Each is the source DTO canonicalized under
// hashProjection = 'runtime-contract-semantic/v2'. Projections MAY carry lockedEnv (declared
// non-secret config); ambient/credential/dispatch env are never present. NOT embedded in the
// live profile.
export type CompiledRuntimePlanProjection = {
  hashProjection: RuntimeContractHashProjection
  planHash: PlanHash
  value: JsonValue
}

export type RuntimeExecutionProfileProjection = {
  hashProjection: RuntimeContractHashProjection
  profileHash: ProfileHash
  value: JsonValue
}

export type HarnessInvocationSpecProjection = {
  hashProjection: RuntimeContractHashProjection
  specHash: SpecHash
  value: JsonValue
}

export type InvocationStartRequestProjection = {
  hashProjection: RuntimeContractHashProjection
  startRequestHash: StartRequestHash
  value: JsonValue
}

export type CompiledRuntimePlanRecord = {
  planHash: PlanHash
  compileId: CompileId
  schemaVersion: 'agent-runtime-plan/v1'
  compilerName: 'agent-spaces'
  compilerVersion: string
  planProjectionJson: string
  diagnosticsJson?: string | undefined
  createdAt: IsoTimestamp
}

export type RuntimeOperationRecord = {
  operationId: RuntimeOperationId
  runtimeId: RuntimeId
  runId?: RunId | undefined
  hostSessionId: HostSessionId
  generation: number
  operationKind: RuntimeOperationKind
  controller: RuntimeControllerKind
  compileId?: CompileId | undefined
  planHash?: PlanHash | undefined
  selectedProfileId?: ProfileId | undefined
  selectedProfileHash?: ProfileHash | undefined
  startupMethod: string
  turnDelivery?: string | undefined
  status: RuntimeOperationStatus
  routeDecisionJson: string
  capabilityResolutionJson?: string | undefined
  createdAt: IsoTimestamp
  startedAt?: IsoTimestamp | undefined
  completedAt?: IsoTimestamp | undefined
  updatedAt: IsoTimestamp
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type BrokerInvocationRecord = {
  invocationId: InvocationId
  operationId: RuntimeOperationId
  runtimeId: RuntimeId
  runId?: RunId | undefined
  brokerProtocol: 'harness-broker/0.1'
  brokerDriver: string
  brokerPid?: number | undefined
  childPid?: number | undefined
  invocationState: InvocationState
  capabilitiesJson: string
  continuationJson?: string | undefined
  brokerContinuationJson?: string | undefined
  specHash: SpecHash
  startRequestHash: StartRequestHash
  selectedProfileHash: ProfileHash
  specProjectionJson?: string | undefined
  startRequestProjectionJson?: string | undefined
  lastEventSeq?: number | undefined
  ownerServerInstanceId?: ServerInstanceId | undefined
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type BrokerInvocationEventRecord = {
  invocationId: InvocationId
  seq: number
  time: IsoTimestamp
  type: InvocationEventType
  runId?: RunId | undefined
  runtimeId: RuntimeId
  brokerEventJson: string
  hrcEventSeq?: number | undefined
  projectionStatus: 'pending' | 'applied' | 'duplicate' | 'failed'
  projectionError?: string | undefined
  createdAt: IsoTimestamp
}

export type RuntimeArtifactRecord = {
  artifactId: ArtifactId
  operationId: RuntimeOperationId
  artifactKind:
    | 'compiled-plan'
    | 'execution-profile'
    | 'broker-spec'
    | 'broker-start-request'
    | 'prompt'
    | 'diagnostics'
    | string
  mediaType: 'application/json' | 'text/plain' | string
  storageKind: 'inline-json' | 'file-path'
  contentHash: ContentHash
  artifactJson?: string | undefined
  artifactPath?: string | undefined
  createdAt: IsoTimestamp
}
```

---

## 18. Broker event mapper datatypes

```ts
// spaces-runtime-contracts/src/event-mapper.ts

export interface BrokerEventMapper {
  apply(event: InvocationEventEnvelope, context: BrokerEventContext): Promise<BrokerEventApplyResult>
}

export type BrokerEventContext = {
  runtime: HrcRuntimeSnapshot
  operation?: RuntimeOperation | undefined
  invocation: BrokerInvocationRecord
  routeDecision: RuntimeRouteDecision
  now: IsoTimestamp
}

export type BrokerEventApplyResult =
  | {
      status: 'applied'
      idempotent: false
      hrcEvents: HrcEventEnvelope[]
      runtimePatch?: Partial<HrcRuntimeSnapshot> | undefined
      runPatch?: Partial<HrcRunRecord> | undefined
    }
  | {
      status: 'duplicate'
      idempotent: true
      existingHrcEventSeq?: number | undefined
    }
  | {
      status: 'ignored'
      reason: string
    }
  | {
      status: 'failed'
      error: RuntimeControlError
    }
```

---

## 19. Public API datatypes

```ts
// spaces-runtime-contracts/src/public-api.ts

export type RuntimeExecutionView = {
  schemaVersion: 'runtime-public-view/v1'
  runtimeId: RuntimeId
  hostSessionId: HostSessionId
  generation: number
  status: RuntimeStatus

  controller:
    | { kind: 'terminal'; terminalHost: 'tmux' | 'ghostty' }
    | { kind: 'embedded-sdk' }
    | {
        kind: 'harness-broker'
        brokerDriver: string
        brokerProtocol: 'harness-broker/0.1'
        brokerTerminal?: BrokerTerminalSurface | undefined
      }
    | { kind: 'command-process' }
    | { kind: 'legacy-exec'; migrationOnly: true }

  harness?:
    | {
        family: HarnessFamily
        runtime: HarnessRuntime | string
        provider: ProviderDomain
      }
    | undefined

  interactionMode: InteractionMode
  startupMethod: string
  turnDelivery: string
  capabilities: RuntimeCapabilities

  compileId?: CompileId | undefined
  planHash?: PlanHash | undefined
  selectedProfileHash?: ProfileHash | undefined
  activeOperationId?: RuntimeOperationId | undefined
  activeInvocationId?: InvocationId | undefined

  transport: LegacyTransportAlias
  supportsInFlightInput: boolean
}

export function legacyTransportAlias(view: RuntimeExecutionView): LegacyTransportAlias {
  switch (view.controller.kind) {
    case 'terminal':
      return 'tmux'
    case 'embedded-sdk':
      return 'sdk'
    case 'harness-broker':
      return view.controller.brokerTerminal?.host === 'tmux' ? 'tmux' : 'headless'
    case 'command-process':
    case 'legacy-exec':
      return 'headless'
  }
}

export type EnsureRuntimeRequest = {
  hostSessionId: HostSessionId
  intent: HrcRuntimeIntent
  restartStyle?: 'reuse_pty' | 'fresh_pty' | undefined
  allowStaleGeneration?: boolean | undefined
}

export type EnsureRuntimeResponse = RuntimeExecutionView
export type StartRuntimeRequest = EnsureRuntimeRequest
export type StartRuntimeResponse = RuntimeExecutionView

export type DispatchTurnRequest = {
  hostSessionId: HostSessionId
  prompt: string
  attachments?: AttachmentRef[] | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  waitForCompletion?: boolean | undefined
  allowStaleGeneration?: boolean | undefined
  idempotencyKey?: string | undefined
}

export type DispatchTurnResponse = {
  runId: RunId
  hostSessionId: HostSessionId
  generation: number
  runtimeId: RuntimeId
  controller: RuntimeControllerKind
  transport: LegacyTransportAlias
  status: 'completed' | 'started' | 'queued' | 'rejected'
  supportsInFlightInput: boolean
  operationId?: RuntimeOperationId | undefined
  invocationId?: InvocationId | undefined
  inputDisposition?: 'started' | 'queued' | 'rejected' | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type RuntimeInputRequest = {
  runtimeId: RuntimeId
  runId?: RunId | undefined
  input: RuntimeInputEnvelope
  idempotencyKey?: string | undefined
}

export type RuntimeInputResponse = RuntimeDispatchResult

export type InterruptRuntimeRequest = {
  runtimeId: RuntimeId
  scope?: 'turn' | 'runtime' | undefined
  reason?: string | undefined
  hard?: boolean | undefined
}

export type InterruptRuntimeResponse = RuntimeInterruptResult

export type StopRuntimeRequest = {
  runtimeId: RuntimeId
  reason?: string | undefined
  graceMs?: number | undefined
  dropContinuation?: boolean | undefined
}

export type StopRuntimeResponse = RuntimeStopResult

export type DisposeRuntimeRequest = {
  runtimeId: RuntimeId
}

export type DisposeRuntimeResponse = RuntimeDisposeResult

export type InspectRuntimeRequest = {
  runtimeId: RuntimeId
}

export type InspectRuntimeResponse = RuntimeExecutionView & {
  runtimeState: RuntimeState
  activeOperation?: RuntimeOperation | undefined
  activeInvocation?: BrokerInvocationRecord | undefined
  continuation?: RuntimeContinuationRef | undefined
  continuationStale?: boolean | undefined
}

export type ListRuntimesRequest = {
  hostSessionId?: HostSessionId | undefined
  controller?: RuntimeControllerKind | undefined
  status?: RuntimeStatus[] | undefined
  limit?: number | undefined
}

export type ListRuntimesResponse = RuntimeExecutionView[]

export type ReconcileRuntimesRequest = {
  runtimeId?: RuntimeId | undefined
  controller?: RuntimeControllerKind | undefined
  dryRun?: boolean | undefined
}

export type ReconcileRuntimesResponse = {
  ok: true
  results: Array<{
    runtimeId: RuntimeId
    result: RuntimeReconcileResult
  }>
}

export type PermissionRespondRequest = {
  permissionRequestId: PermissionRequestId
  decision: 'allow' | 'deny'
  message?: string | undefined
}

export type PermissionRespondResponse = {
  ok: true
  record: BrokerPermissionDecisionRecord
}
```

---

## 20. Error datatypes

```ts
// spaces-runtime-contracts/src/errors.ts

export type RuntimeControlErrorCode =
  | 'compile-failed'
  | 'no-admissible-profile'
  | 'capability-missing'
  | 'capability-degrade-forbidden'
  | 'legacy-disabled'
  | 'broker-protocol-mismatch'
  | 'broker-driver-unavailable'
  | 'broker-start-failed'
  | 'broker-input-rejected'
  | 'broker-busy'
  | 'broker-queue-not-supported'
  | 'permission-denied'
  | 'permission-timeout'
  | 'runtime-not-found'
  | 'runtime-state-invalid'
  | 'runtime-recompile-required'
  | 'event-projection-failed'
  | 'restart-reattach-unsupported'
  | string

export type RuntimeControlError = {
  code: RuntimeControlErrorCode
  message: string
  retryable: boolean
  plane: 'asp-compiler' | 'hrc-control' | 'harness-broker' | 'broker-driver'
  details?: unknown
}

export enum BrokerErrorCode {
  UnknownInvocation = -32001,
  InvalidInvocationState = -32002,
  UnsupportedCapability = -32003,
  InputRejected = -32004,
  HarnessError = -32005,
  Timeout = -32006,
  ResourceError = -32007,
  ShutdownInProgress = -32008,
  DriverUnavailable = -32009,
  PermissionDenied = -32010,
}
```

---

## 21. Route catalog datatypes

```ts
// spaces-runtime-contracts/src/route-catalog.ts

export type RuntimeRouteCatalogEntry = {
  controller: RuntimeControllerKind
  terminalHost?: 'foreground' | 'tmux' | 'ghostty' | undefined
  migrationOnly?: boolean | undefined
  modelProvider: ProviderDomain
  harnessFamily: HarnessFamily
  harnessRuntime: HarnessRuntime
  interactionMode: InteractionMode
  startupMethods: string[]
  turnDeliveries: string[]
  broker?:
    | {
        protocolVersion: 'harness-broker/0.1'
        driver: 'codex-app-server' | 'claude-code-tmux' | 'codex-cli-tmux' | string
        processTransport: 'jsonrpc-stdio' | 'pty'
      }
    | undefined
  removalGate?: string | undefined
}

export const RUNTIME_ROUTE_CATALOG: RuntimeRouteCatalogEntry[] = [
  {
    controller: 'terminal',
    terminalHost: 'tmux',
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-code-cli',
    interactionMode: 'interactive',
    startupMethods: ['create-terminal', 'reuse-existing', 'adopt-terminal', 'inherit-current-terminal'],
    turnDeliveries: ['terminal-launch-input', 'terminal-literal-input'],
  },
  {
    controller: 'terminal',
    terminalHost: 'tmux',
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    interactionMode: 'interactive',
    startupMethods: ['create-terminal', 'reuse-existing', 'adopt-terminal', 'inherit-current-terminal'],
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
    terminalHost: 'tmux',
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-code-cli',
    interactionMode: 'interactive',
    startupMethods: ['create-broker-invocation', 'reuse-existing'],
    turnDeliveries: ['broker-input', 'terminal-literal-input'],
    broker: {
      protocolVersion: 'harness-broker/0.1',
      driver: 'claude-code-tmux',
      processTransport: 'pty',
    },
  },
  {
    controller: 'harness-broker',
    terminalHost: 'tmux',
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    interactionMode: 'interactive',
    startupMethods: ['create-broker-invocation', 'reuse-existing'],
    turnDeliveries: ['broker-input', 'terminal-literal-input'],
    broker: {
      protocolVersion: 'harness-broker/0.1',
      driver: 'codex-cli-tmux',
      processTransport: 'pty',
    },
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
]
```

---

## 22. Boundary check datatypes

```ts
// spaces-runtime-contracts/src/boundary-checks.ts

export type BoundaryCheck = {
  id: string
  description: string
  command: string
  severity: 'warning' | 'error'
  allowedPaths?: string[] | undefined
}

export const REQUIRED_BOUNDARY_CHECKS: BoundaryCheck[] = [
  {
    id: 'no-nonlegacy-exec-ts',
    description: 'No broker-capable HRC path may invoke launch/exec.ts.',
    command:
      "rg \"launch/exec|exec\\.ts\" packages/hrc-server/src -g '!**/runtime-controllers/legacy-exec/**' -g '!**/__tests__/legacy-exec/**'",
    severity: 'error',
  },
  {
    id: 'no-hrc-driver-internals',
    description: 'HRC broker paths must not import concrete harness driver internals.',
    command:
      "rg \"spaces-harness-codex|runCodexAppServerOneShot|codexAppServer|harness-broker/src/drivers\" packages/hrc-* -g '!**/runtime-controllers/legacy-exec/**' -g '!**/__tests__/**'",
    severity: 'error',
  },
  {
    id: 'no-hrc-broker-spec-synthesis',
    description: 'HRC broker paths must not synthesize or mutate broker execution mechanics.',
    command:
      "rg \"InvocationStartRequest\\s*=|HarnessInvocationSpec\\s*=|spec\\.driver|spec\\.process|process\\.args|process\\.env|process\\.cwd|driver:\" packages/hrc-server/src -g '!**/runtime-controllers/legacy-exec/**' -g '!**/__tests__/**'",
    severity: 'error',
  },
]
```
