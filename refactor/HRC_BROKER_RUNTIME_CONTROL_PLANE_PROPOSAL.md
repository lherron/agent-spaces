# HRC Broker Runtime Control Plane Proposal

**Proposed name:** HRC Broker Runtime Control Plane

**Replaces:** the current “runtime vocabulary refactor” framing.

**Core decision:** broker-capable harness execution must move behind an HRC-owned `HarnessBrokerController`. `packages/hrc-server/src/launch/exec.ts` must not be carried forward as the broker-world execution boundary. It may survive temporarily as a legacy launch wrapper for non-broker and migration paths, but target HRC code must not route broker-capable harnesses through it.

---

## 1. Executive position

The existing refactor plan is directionally right but too vocabulary-centered. The real architectural split is not `transport` → `runtimeController`; it is **launch wrapping** versus **runtime control** versus **harness execution**.

Today, `exec.ts` is doing all three. It is therefore the wrong boundary to preserve. In the broker-first design, `exec.ts` is replaced by these components:

1. `HarnessBrokerController`: HRC-owned controller for broker-capable harness runtimes.
2. `BrokerProcessSupervisor`: starts and owns the broker process, not the harness process directly.
3. `BrokerInvocationStore`: persists broker invocation identity, route/spec hashes, capabilities, continuation, and lifecycle state.
4. `BrokerEventMapper`: maps normalized broker events into HRC runtime/run/message/event records.
5. `BrokerPermissionCoordinator`: answers or escalates broker permission requests according to HRC policy.
6. `TerminalRuntimeController`: owns attachable terminal runtimes such as tmux/Ghostty. It can use a small terminal launcher, but that launcher must not contain harness execution semantics.
7. `CommandProcessController`: owns arbitrary non-harness command processes. It is not a bucket for broker-capable Codex/Claude/Pi execution.
8. `LegacyExecAdapter`: temporary compatibility path for existing `exec.ts` behavior. It should be isolated, feature-gated, and explicitly deleted.

The target invariant should be enforceable by tests and boundary checks:

> For any broker-capable harness route, HRC must not import harness driver packages, must not parse harness stdout as protocol, must not call Codex app-server helpers, must not synthesize harness-specific turn lifecycle inside a launch wrapper, and must not invoke `launch/exec.ts` as the execution path.

---

## 2. Source anchors used for this proposal

This proposal is based on the uploaded `REFACTOR_PLAN.md` and the uploaded source tree. The important current anchors are:

- `hrc-core/src/contracts.ts:8-11,46,69-106`: current provider/harness/execution/transport intent vocabulary.
- `hrc-core/src/http-contracts.ts:77-107,136-144`: public HTTP responses still expose `transport: 'tmux' | 'headless' | 'sdk'`.
- `hrc-store-sqlite/src/migrations.ts:53-76,84-132`: runtime/run/launch persistence stores `transport`, `harness`, `provider`, launch artifacts, pids, optional JSON blobs.
- `hrc-server/src/launch/exec.ts:10,203-225,227-337,339-491,505-519,617-744`: `exec.ts` imports Codex harness code, detects headless Codex, parses JSONL, drives Codex app-server, mutates Codex config, spawns children, posts callbacks, and deregisters agentchat targets.
- `hrc-server/src/index.ts:2312-2424,2650-2777,4978-5089`: HRC headless dispatch/start builds launch artifacts and shells through `exec.ts`.
- `hrc-server/src/index.ts:9454-9494,9652-9698`: routing predicates and runtime reuse are currently coupled to old transport/harness labels.
- `hrc-server/src/index.ts:11603-11605`: launch commands are rendered as `bun run .../launch/exec.ts --launch-file ...`.
- `agent-spaces/src/types.ts:213-239` and `agent-spaces/src/client.ts:461-466,1446-1511`: Agent Spaces already exposes `buildHarnessBrokerInvocation`, returning `InvocationStartRequest`, `HarnessInvocationSpec`, and optional initial input.
- `harness-broker-protocol/src/commands.ts:11-20,60-160`: broker protocol already has hello/health/start/input/interrupt/stop/status/dispose.
- `harness-broker-protocol/src/events.ts:19-44`: broker protocol already exposes normalized invocation/turn/message/tool/usage events.
- `harness-broker-protocol/src/invocation.ts:1-69`: broker invocation spec captures harness descriptor, process spec, interaction spec, continuation, driver spec, and permission policy.
- `harness-broker-protocol/src/capabilities.ts:1-36`: broker and invocation capabilities already represent input, queueing, interruption, continuation, events, stop/dispose, and multi-invocation limits.
- `harness-broker-client/src/client.ts:52-123`: broker client already supports start/input/interrupt/stop/status/dispose and event streams.
- `harness-broker/src/broker.ts:98-110` and `harness-broker/src/invocation-manager.ts:277-285`: current broker reports `multiInvocation: false` and rejects concurrent active invocations.
- `harness-broker/src/invocation-manager.ts:374-492`: broker input semantics are policy/capability gated; no-policy busy input is rejected.
- `harness-broker/src/drivers/codex-app-server/event-map.ts:31-205`: Codex app-server event mapping belongs in the broker driver, not HRC.
- `harness-broker/src/drivers/codex-app-server/permissions.ts:21-103`: permission handling exists but needs HRC product/security policy.

---

## 3. What is wrong with carrying `exec.ts` forward

`exec.ts` is not just a wrapper. It is a hidden harness runtime controller. That creates the wrong dependency direction:

- HRC imports `spaces-harness-codex/codex-session` directly.
- HRC detects Codex-specific launch modes from launch artifacts.
- HRC parses Codex JSONL stdout.
- HRC maps Codex-specific records into HRC lifecycle events.
- HRC drives Codex app-server one-shot behavior.
- HRC writes Codex OTEL config.
- HRC treats launch-exit as a possible synthetic turn-completion source.
- HRC posts callback/spool messages as the effective execution event bus.

Those responsibilities are exactly what the broker was built to own or normalize. Preserving `exec.ts` as the broker-world path keeps the old coupling alive under better names.

### Replacement rule

In the target system:

```text
HRC HTTP/API request
  -> RuntimeRouteDecision
  -> RuntimeController
  -> HarnessBrokerController
  -> BrokerClient
  -> harness-broker protocol
  -> broker driver
  -> harness process
```

Not:

```text
HRC HTTP/API request
  -> launch artifact
  -> bun run launch/exec.ts
  -> Codex-specific launch detection
  -> Codex-specific stdout/app-server parsing
  -> callback/spool back into HRC
```

---

## 4. As-is architecture

### 4.1 As-is core vocabulary

Current HRC types flatten provider identity, harness family, harness runtime, and execution controller identity into a few broad labels:

```ts
// As-is: hrc-core/src/contracts.ts
export type HrcProvider = 'anthropic' | 'openai'

export type HrcHarness =
  | 'agent-sdk'
  | 'claude-code'
  | 'codex-cli'
  | 'pi'
  | 'pi-cli'
  | 'pi-sdk'

export type HrcExecutionMode = 'headless' | 'interactive' | 'nonInteractive'

export type HrcLifecycleTransport = 'sdk' | 'tmux' | 'headless'

export type HrcHarnessIntent = {
  provider: HrcProvider
  interactive: boolean
  id?: HrcHarness | undefined
  fallback?: string | undefined
  model?: string | undefined
  yolo?: boolean | undefined
}

export type HrcRuntimeIntent = {
  placement: RuntimePlacement
  harness: HrcHarnessIntent
  execution?: HrcExecutionIntent | undefined
  launch?: HrcLaunchEnvConfig | undefined
  initialPrompt?: string | undefined
  attachments?: AttachmentRef[] | undefined
  taskContext?: HrcTaskContext | undefined
}
```

Problems:

- `HrcHarness` mixes product family, CLI runtime, SDK runtime, and fallback labels.
- `headless` is not a transport. It is an interaction/attachability mode.
- `sdk` is not a transport. It is either a harness runtime, a startup/delivery mechanism, or an embedded execution controller.
- `provider` is overloaded between model provider, continuation provider, and harness execution family.

### 4.2 As-is public API shape

Current API responses leak old execution labels:

```ts
// As-is: hrc-core/src/http-contracts.ts
export type EnsureRuntimeResponse = {
  runtimeId: string
  hostSessionId: string
  transport: 'tmux'
  status: string
  supportsInFlightInput: boolean
  tmux: {
    sessionId: string
    windowId: string
    paneId: string
  }
}

export type StartRuntimeResponse =
  | EnsureRuntimeResponse
  | {
      runtimeId: string
      hostSessionId: string
      transport: 'headless'
      status: string
      supportsInFlightInput: boolean
    }

export type DispatchTurnResponse = {
  runId: string
  hostSessionId: string
  generation: number
  runtimeId: string
  transport: 'sdk' | 'tmux' | 'headless'
  status: 'completed' | 'started'
  supportsInFlightInput: boolean
}
```

Problems:

- API consumers cannot distinguish `headless via exec.ts`, `headless via SDK`, and `headless via broker`.
- API consumers cannot see the controller boundary or capability model.
- New broker semantics would be hidden behind `transport: 'headless'` unless an explicit compatibility plan is added.

### 4.3 As-is persistence shape

Current storage persists `transport`, `harness`, and `provider`, plus optional JSON blobs:

```ts
// As-is: simplified from hrc-store-sqlite migrations
CREATE TABLE runtimes (
  runtime_id TEXT PRIMARY KEY,
  host_session_id TEXT NOT NULL,
  transport TEXT NOT NULL,
  harness TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  tmux_json TEXT,
  wrapper_pid INTEGER,
  child_pid INTEGER,
  harness_session_json TEXT,
  continuation_json TEXT,
  supports_inflight_input INTEGER NOT NULL,
  active_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  runtime_id TEXT,
  transport TEXT NOT NULL,
  status TEXT NOT NULL,
  accepted_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE TABLE launches (
  launch_id TEXT PRIMARY KEY,
  runtime_id TEXT,
  harness TEXT NOT NULL,
  provider TEXT NOT NULL,
  launch_artifact_path TEXT NOT NULL,
  tmux_json TEXT,
  wrapper_pid INTEGER,
  child_pid INTEGER,
  harness_session_json TEXT,
  continuation_json TEXT,
  status TEXT NOT NULL
);
```

Problems:

- The schema permits impossible states: `transport = 'headless'` with `tmux_json`, missing broker invocation identity, or a continuation whose provider vocabulary does not match the runtime path.
- `launches` is doing double duty: terminal launch record and non-terminal harness operation record.
- `wrapper_pid` and `child_pid` are not expressive enough for broker process, harness child process, driver process, and terminal wrapper ownership.

### 4.4 As-is headless Codex flow

Current start/dispatch flow is:

```text
handleHeadlessDispatchTurn / runHeadlessCliStartLaunch
  -> buildDispatchInvocation(...)
  -> write launch artifact
  -> insert launch row
  -> Bun.spawn(process.execPath, ['.../launch/exec.ts', '--launch-file', artifact])
  -> exec.ts spawns Codex/app-server child
  -> exec.ts parses Codex output or drives app-server
  -> exec.ts posts callback/spool events
  -> HRC persists continuation/events/runs from callback path
```

That is the path to sever.

### 4.5 As-is `exec.ts` responsibilities

| Responsibility currently in `exec.ts` | Problem | Target owner |
| --- | --- | --- |
| Read launch artifact | Launch artifacts are overused as execution contract | Controller-specific operation spec, not artifact file |
| Print launch header/prompts/env | Valid terminal UX concern, not harness execution | `TerminalLaunchPresenter` |
| Register/deregister agentchat target | Cross-cutting control-surface concern | `AgentchatTargetRegistrar` called by controller that exposes a target |
| Spawn child process | Too broad; child may be terminal, command, broker, or harness | `TerminalRuntimeController`, `CommandProcessController`, or `BrokerProcessSupervisor` |
| Detect headless Codex launch | Harness-specific routing inside wrapper | `RuntimeRouteDecision` + `HarnessBrokerController` |
| Parse Codex JSONL stdout | Harness protocol parsing inside HRC | Broker driver/event mapper |
| Drive Codex app-server one-shot | Direct harness driver import in HRC | Broker `codex-app-server` driver |
| Post continuation callback | HRC callback loop instead of direct event ingestion | Broker event `continuation.updated` → `BrokerEventMapper` |
| Post/synthesize `turn.completed` | Harness lifecycle policy in wrapper | Broker events + HRC reconcile policy |
| Inject Codex OTEL config | Harness config mutation in wrapper | Agent Spaces broker builder or broker driver |
| Forward signals and post exit | Useful process supervision, but not Codex-specific | Controller-specific supervisor |

---

## 5. To-be architecture

### 5.1 Layer model

The target split has four explicit layers:

```text
1. Agent Spaces provisioning
   Owns model/harness/runtime placement and broker invocation construction.

2. HRC routing policy
   Owns reuse/create/adopt decisions and chooses a runtime controller.

3. HRC runtime controller
   Owns lifecycle, input, observation, stop/dispose, persistence integration.

4. Harness execution boundary
   Broker owns broker-capable harness execution and driver protocols.
```

The important negative statement: HRC routing may choose a broker controller, but HRC must not reconstruct broker driver details from launch artifacts or parse harness-native protocols.

### 5.2 To-be package/module layout

Recommended HRC server layout:

```text
packages/hrc-server/src/
  runtime-routing/
    route-decision.ts
    route-catalog.ts
    legacy-compat.ts

  runtime-controllers/
    controller.ts
    terminal/
      terminal-runtime-controller.ts
      terminal-launch-presenter.ts
      agentchat-target-registrar.ts
    broker/
      harness-broker-controller.ts
      broker-process-supervisor.ts
      broker-event-mapper.ts
      broker-permission-coordinator.ts
      broker-continuation-codec.ts
      broker-reconciler.ts
    embedded-sdk/
      embedded-sdk-controller.ts
    command-process/
      command-process-controller.ts
    legacy-exec/
      legacy-exec-adapter.ts
      legacy-launch-wrapper.ts      // moved/renamed exec.ts during sunset

  runtime-state/
    runtime-state.ts
    persistence-codecs.ts

  operations/
    runtime-operation-store.ts
    broker-invocation-store.ts
```

`launch/exec.ts` should be renamed/moved under `runtime-controllers/legacy-exec` once references are isolated. The old path can remain as a shim for a short compatibility window:

```ts
// packages/hrc-server/src/launch/exec.ts
// Temporary compatibility shim only.
import '../runtime-controllers/legacy-exec/legacy-launch-wrapper.js'
```

Boundary rule: new broker controller code must not import anything from `legacy-exec`.

---

## 6. To-be type contracts

### 6.1 Agent Spaces-owned request/provisioning contract

Raw intent should express user/provider/harness preference. It should not choose HRC controller mechanics.

```ts
export type ModelProvider = 'anthropic' | 'openai'

export type HarnessFamily =
  | 'claude-code'
  | 'codex'
  | 'pi'

export type HarnessRuntime =
  | 'claude-code-cli'
  | 'claude-agent-sdk'
  | 'codex-cli'
  | 'pi-cli'
  | 'pi-sdk'

export type InteractionMode = 'interactive' | 'headless' | 'nonInteractive'

export type ModelSelectionRequest = {
  model?: string | undefined
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
}

export type AgentRuntimeIntent = {
  placement: RuntimePlacement
  modelProvider: ModelProvider
  harnessFamily?: HarnessFamily | undefined
  preferredHarnessRuntime?: HarnessRuntime | undefined
  interactionMode?: InteractionMode | undefined
  model?: ModelSelectionRequest | undefined
  yolo?: boolean | undefined
  launch?: HrcLaunchEnvConfig | undefined
  initialPrompt?: string | undefined
  attachments?: AttachmentRef[] | undefined
  taskContext?: HrcTaskContext | undefined
}
```

Agent Spaces resolved output should separate model resolution from harness runtime resolution:

```ts
export type ResolvedModelSelection = {
  modelProvider: ModelProvider
  requestedModel?: string | undefined
  modelId: string
  modelAlias?: string | undefined
  modelVersion?: string | undefined
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
}

export type ProvisionedHarness =
  | {
      modelProvider: 'anthropic'
      harnessFamily: 'claude-code'
      harnessRuntime: 'claude-code-cli' | 'claude-agent-sdk'
    }
  | {
      modelProvider: 'openai'
      harnessFamily: 'codex'
      harnessRuntime: 'codex-cli'
    }
  | {
      modelProvider: 'openai'
      harnessFamily: 'pi'
      harnessRuntime: 'pi-cli' | 'pi-sdk'
    }

export type ResolvedProvisioning = ProvisionedHarness & {
  model: ResolvedModelSelection
  cwd: string
  env: Record<string, string>
  resolvedBundle?: ResolvedRuntimeBundle | undefined
  warnings?: string[] | undefined
}
```

Agent Spaces remains the only owner of `HarnessInvocationSpec` construction for broker-capable routes:

```ts
export type BuildBrokerInvocation = (
  req: BuildHarnessBrokerInvocationRequest
) => Promise<BuildHarnessBrokerInvocationResponse>
```

HRC may pass correlation, labels, continuation, permission policy, and limits. HRC should not rebuild `spec.driver`, `spec.process.args`, or Codex app-server descriptors after the fact.

### 6.2 HRC route-decision contract

`RuntimeRouteDecision` is an HRC-owned policy result. It should be a discriminated union, not a bag of enums.

```ts
export type RuntimeControllerKind =
  | 'terminal'
  | 'embedded-sdk'
  | 'harness-broker'
  | 'command-process'
  | 'legacy-exec'

export type TerminalHost = 'tmux' | 'ghostty'

export type StartupMethod =
  | 'reuse-existing'
  | 'create-terminal'
  | 'adopt-terminal'
  | 'create-sdk-session'
  | 'create-broker-invocation'
  | 'create-command-process'
  | 'legacy-launch-artifact'

export type TurnDelivery =
  | 'terminal-literal-input'
  | 'terminal-launch-input'
  | 'sdk-turn'
  | 'sdk-inflight-input'
  | 'broker-input'
  | 'command-stdin'
  | 'legacy-launch-input'

export type RuntimeReusePolicy =
  | { kind: 'reuse-compatible'; staleGeneration: 'rotate' | 'allow' }
  | { kind: 'always-new' }
  | { kind: 'adopt-existing'; selector: RuntimeSelector }

export type RouteCapabilities = {
  attach: boolean
  capture: boolean
  literalInput: boolean
  structuredInput: boolean
  stop: boolean
  dispose: boolean
  continuation: boolean
  permissionRequests: boolean
}

export type TerminalRouteDecision = ResolvedProvisioning & {
  controller: 'terminal'
  terminalHost: TerminalHost
  interactionMode: 'interactive'
  startupMethod: 'reuse-existing' | 'create-terminal' | 'adopt-terminal'
  turnDelivery: 'terminal-launch-input' | 'terminal-literal-input'
  reusePolicy: RuntimeReusePolicy
  capabilities: RouteCapabilities & {
    attach: true
    capture: true
    literalInput: true
    structuredInput: false
  }
}

export type EmbeddedSdkRouteDecision = ResolvedProvisioning & {
  controller: 'embedded-sdk'
  harnessRuntime: 'claude-agent-sdk' | 'pi-sdk'
  interactionMode: 'nonInteractive'
  startupMethod: 'reuse-existing' | 'create-sdk-session'
  turnDelivery: 'sdk-turn' | 'sdk-inflight-input'
  reusePolicy: RuntimeReusePolicy
  capabilities: RouteCapabilities & {
    attach: false
    capture: false
    literalInput: false
    structuredInput: true
  }
}

export type BrokerRouteDecision = ResolvedProvisioning & {
  controller: 'harness-broker'
  harnessFamily: 'codex' // first target; other families can be added deliberately
  harnessRuntime: 'codex-cli'
  interactionMode: 'headless'
  startupMethod: 'reuse-existing' | 'create-broker-invocation'
  turnDelivery: 'broker-input'
  broker: {
    protocolVersion: 'harness-broker/0.1'
    driver: 'codex-app-server'
    processTransport: 'jsonrpc-stdio'
    brokerOwnership: 'hrc-owned-process'
  }
  inputPolicy: BrokerInputPolicy
  permissionPolicy: BrokerPermissionPolicy
  reusePolicy: RuntimeReusePolicy
  capabilities: RouteCapabilities & {
    attach: false
    capture: false
    literalInput: false
    structuredInput: true
    stop: true
    dispose: true
    continuation: true
  }
}

export type CommandProcessRouteDecision = {
  controller: 'command-process'
  runtimeKind: 'command'
  interactionMode: 'headless' | 'interactive'
  startupMethod: 'create-command-process' | 'reuse-existing'
  turnDelivery: 'command-stdin'
  command: HrcCommandLaunchSpec
  reusePolicy: RuntimeReusePolicy
  capabilities: RouteCapabilities
}

export type LegacyExecRouteDecision = ResolvedProvisioning & {
  /** Temporary only. No new broker-capable behavior may be added here. */
  controller: 'legacy-exec'
  interactionMode: 'headless'
  startupMethod: 'legacy-launch-artifact'
  turnDelivery: 'legacy-launch-input'
  migrationOnly: true
  removalGate: 'delete-after-broker-codex-cutover'
  reusePolicy: RuntimeReusePolicy
  capabilities: RouteCapabilities & {
    attach: false
    capture: false
    literalInput: false
    structuredInput: false
  }
}

export type RuntimeRouteDecision =
  | TerminalRouteDecision
  | EmbeddedSdkRouteDecision
  | BrokerRouteDecision
  | CommandProcessRouteDecision
  | LegacyExecRouteDecision
```

Key design choice: `terminal` is the controller kind; `tmux` and `ghostty` are terminal hosts. This avoids carrying host-specific names as if they are the general controller abstraction. Public compatibility can still expose `legacyTransport: 'tmux' | 'headless' | 'sdk'` during migration.

### 6.3 Broker input and permission policy contracts

Broker input behavior must not be implied by `turnDelivery: 'broker-input'`. It must be explicit because the current broker builder emits `inputQueue: 'none'` and broker busy input defaults to rejection.

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

export type BrokerPermissionPolicy =
  | {
      mode: 'deny'
      audit: true
    }
  | {
      mode: 'allow'
      audit: true
      requireExplicitYolo: true
    }
  | {
      mode: 'ask-client'
      timeoutMs: number
      defaultDecision: 'deny' | 'allow'
      surface: 'api' | 'agentchat' | 'both'
      audit: true
    }
```

Recommended default for Codex broker routes:

```ts
export const DEFAULT_CODEX_BROKER_POLICY: Pick<BrokerRouteDecision, 'inputPolicy' | 'permissionPolicy'> = {
  inputPolicy: {
    readyInput: 'start-turn',
    busy: { whenBusy: 'reject' },
    supportedKinds: ['user'],
    attachmentPolicy: { localImages: true, fileRefs: false },
  },
  permissionPolicy: { mode: 'deny', audit: true },
}
```

Do not silently enable `allow`. If `yolo` maps to broader permissions, that mapping should be explicit, logged, and tied to request provenance.

### 6.4 Runtime controller interface

Controller selection must become executable, not just descriptive.

```ts
export type RuntimeControllerStartInput<TDecision extends RuntimeRouteDecision> = {
  decision: TDecision
  session: HrcSessionRecord
  runtime?: HrcRuntimeSnapshot | undefined
  run?: HrcRunRecord | undefined
  prompt?: string | undefined
  attachments?: AttachmentRef[] | undefined
  continuation?: HrcContinuationRef | undefined
  waitForCompletion?: boolean | undefined
  correlation: HrcCorrelation
}

export type RuntimeControllerDispatchInput<TDecision extends RuntimeRouteDecision> = {
  decision: TDecision
  session: HrcSessionRecord
  runtime: HrcRuntimeSnapshot
  run: HrcRunRecord
  prompt: string
  attachments?: AttachmentRef[] | undefined
  continuation?: HrcContinuationRef | undefined
  waitForCompletion?: boolean | undefined
  correlation: HrcCorrelation
}

export type RuntimeStartResult = {
  runtimeId: string
  status: HrcRuntimeStatus
  runtimeState: RuntimeState
  capabilities: RuntimeCapabilities
  continuation?: HrcContinuationRef | undefined
  legacyTransport: LegacyTransportAlias
}

export type RuntimeDispatchResult = {
  runId: string
  runtimeId: string
  status: 'started' | 'completed' | 'queued' | 'rejected'
  runtimeState: RuntimeState
  capabilities: RuntimeCapabilities
  continuation?: HrcContinuationRef | undefined
  legacyTransport: LegacyTransportAlias
}

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

Controllers implement mechanics. They should not recompute route policy.

### 6.5 Runtime state contract

Replace optional JSON blobs with a discriminated `runtimeState`. During migration this can be stored in a new JSON column or derived from legacy columns; the target type should be strict.

```ts
export type RuntimeState =
  | TerminalRuntimeState
  | EmbeddedSdkRuntimeState
  | BrokerRuntimeState
  | CommandProcessRuntimeState
  | LegacyExecRuntimeState

export type TerminalRuntimeState = {
  kind: 'terminal'
  host: 'tmux' | 'ghostty'
  pane?: TmuxPaneState | undefined
  surface?: GhosttySurfaceState | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined
  agentchatTarget?: AgentchatTargetRef | undefined
  lastCaptureAt?: string | undefined
}

export type EmbeddedSdkRuntimeState = {
  kind: 'embedded-sdk'
  harnessRuntime: 'claude-agent-sdk' | 'pi-sdk'
  harnessSession?: HarnessSessionState | undefined
  continuation?: HrcContinuationRef | undefined
  activeRunId?: string | undefined
}

export type BrokerRuntimeState = {
  kind: 'harness-broker'
  broker: {
    protocolVersion: 'harness-broker/0.1'
    brokerPid?: number | undefined
    endpoint: { kind: 'stdio-jsonrpc-ndjson' }
    multiInvocation: false | boolean
    startedAt: string
    ownerServerInstanceId: string
  }
  invocation: {
    invocationId: string
    state: BrokerInvocationState
    driver: 'codex-app-server' | string
    harnessRuntime: HarnessRuntime
    processTransport: 'jsonrpc-stdio' | 'pipes' | 'pty'
    childPid?: number | undefined
    currentTurnId?: string | undefined
    lastEventSeq?: number | undefined
    capabilities: InvocationCapabilities
    specHash: string
    startRequestHash: string
    redactedSpec?: RedactedHarnessInvocationSpec | undefined
  }
  continuation?: HrcContinuationRef | undefined
  brokerContinuation?: BrokerContinuationRef | undefined
  permission: BrokerPermissionRuntimeState
  input: BrokerInputRuntimeState
  activeRunId?: string | undefined
}

export type BrokerInvocationState =
  | 'starting'
  | 'ready'
  | 'turn_active'
  | 'stopping'
  | 'exited'
  | 'failed'
  | 'disposed'
  | 'unknown_after_restart'

export type CommandProcessRuntimeState = {
  kind: 'command-process'
  processPid?: number | undefined
  stdinMode: 'none' | 'pipe' | 'pty'
  exit?: { code?: number | null; signal?: string | null } | undefined
}

export type LegacyExecRuntimeState = {
  kind: 'legacy-exec'
  launchId: string
  launchArtifactPath: string
  wrapperPid?: number | undefined
  childPid?: number | undefined
  continuation?: HrcContinuationRef | undefined
  removalGate: 'delete-after-broker-codex-cutover'
}
```

### 6.6 Continuation contract

The current HRC continuation type uses model-provider vocabulary. Broker continuations use harness-driver vocabulary. Do not conflate them.

```ts
export type HrcContinuationRef = {
  provider: 'anthropic' | 'openai'
  key?: string | undefined
}

export type BrokerContinuationRef = {
  provider: string       // e.g. 'codex'
  kind?: 'thread' | 'session' | 'conversation' | string | undefined
  key: string
}

export type RuntimeContinuationRef = {
  hrc: HrcContinuationRef
  broker?: BrokerContinuationRef | undefined
  source: 'embedded-sdk' | 'harness-broker' | 'legacy-exec' | 'terminal-hook'
  observedAt: string
}

export interface BrokerContinuationCodec {
  toBroker(input: HrcContinuationRef | undefined, decision: BrokerRouteDecision): BrokerContinuationRef | undefined
  fromBroker(input: BrokerContinuationRef, decision: BrokerRouteDecision): HrcContinuationRef
}
```

For Codex broker v1, the codec should be explicit:

```ts
export const CodexBrokerContinuationCodec: BrokerContinuationCodec = {
  toBroker(input) {
    if (!input?.key) return undefined
    if (input.provider !== 'openai') throw new Error('Codex continuation requires openai HRC provider')
    return { provider: 'codex', kind: 'thread', key: input.key }
  },
  fromBroker(input) {
    if (input.provider !== 'codex' || !input.key) {
      throw new Error('Unsupported Codex broker continuation')
    }
    return { provider: 'openai', key: input.key }
  },
}
```

### 6.7 Broker controller contract

`HarnessBrokerController` is the concrete replacement for the broker-relevant parts of `exec.ts`.

```ts
export interface HarnessBrokerController extends RuntimeController<BrokerRouteDecision> {
  readonly kind: 'harness-broker'

  start(input: RuntimeControllerStartInput<BrokerRouteDecision>): Promise<RuntimeStartResult>
  dispatchTurn(input: RuntimeControllerDispatchInput<BrokerRouteDecision>): Promise<RuntimeDispatchResult>
  deliverInput(input: RuntimeControllerDispatchInput<BrokerRouteDecision>): Promise<RuntimeDispatchResult>

  interrupt(runtime: HrcRuntimeSnapshot, reason?: string): Promise<RuntimeInterruptResult>
  stop(runtime: HrcRuntimeSnapshot, reason?: string): Promise<RuntimeStopResult>
  dispose(runtime: HrcRuntimeSnapshot): Promise<RuntimeDisposeResult>
  inspect(runtime: HrcRuntimeSnapshot): Promise<RuntimeInspection>
  reconcile(runtime: HrcRuntimeSnapshot): Promise<RuntimeReconcileResult>
}

export type BrokerStartPlan = {
  decision: BrokerRouteDecision
  session: HrcSessionRecord
  runtimeId: string
  runId?: string | undefined
  brokerInvocationId: string
  continuation?: HrcContinuationRef | undefined
  buildRequest: BuildHarnessBrokerInvocationRequest
  startRequest: InvocationStartRequest
  specHash: string
  startRequestHash: string
}

export interface BrokerProcessSupervisor {
  startBroker(input: {
    runtimeId: string
    brokerInvocationId: string
    env: NodeJS.ProcessEnv
    cwd: string
  }): Promise<{
    client: BrokerClient
    brokerPid?: number | undefined
    endpoint: { kind: 'stdio-jsonrpc-ndjson' }
  }>

  attachExisting?(state: BrokerRuntimeState): Promise<BrokerClient | null>
  close(runtimeId: string): Promise<void>
}

export interface BrokerInvocationStore {
  createPending(plan: BrokerStartPlan, now: string): Promise<void>
  markStarted(input: BrokerStartedRecord, now: string): Promise<void>
  updateState(input: BrokerStateUpdate, now: string): Promise<void>
  appendEvent(input: BrokerStoredEvent): Promise<'inserted' | 'duplicate'>
  markTerminal(input: BrokerTerminalUpdate, now: string): Promise<void>
}
```

#### Start flow

```ts
async function startBrokerRuntime(input: RuntimeControllerStartInput<BrokerRouteDecision>) {
  const plan = await buildBrokerStartPlan(input)

  await brokerInvocationStore.createPending(plan, now())

  const { client, brokerPid, endpoint } = await brokerSupervisor.startBroker({
    runtimeId: plan.runtimeId,
    brokerInvocationId: plan.brokerInvocationId,
    env: process.env,
    cwd: plan.startRequest.spec.process.cwd,
  })

  const hello = await client.hello({
    clientInfo: { name: 'hrc-server', version: HRC_VERSION },
    protocolVersions: ['harness-broker/0.1'],
    capabilities: { permissionRequests: plan.decision.permissionPolicy.mode === 'ask-client' },
  })

  client.onPermissionRequest((request) => permissionCoordinator.decide(request, plan.decision))

  const { invocationId, events } = await client.startInvocation(
    plan.startRequest.spec,
    plan.startRequest.initialInput
  )

  await brokerInvocationStore.markStarted({
    runtimeId: plan.runtimeId,
    invocationId,
    brokerPid,
    endpoint,
    protocolVersion: hello.protocolVersion,
    capabilities: hello.capabilities,
  }, now())

  void consumeBrokerEvents({ plan, events, client })

  return toRuntimeStartResult(plan)
}
```

#### Follow-up input flow

```ts
async function deliverBrokerInput(input: RuntimeControllerDispatchInput<BrokerRouteDecision>) {
  const state = requireBrokerRuntimeState(input.runtime)
  const client = await brokerSupervisor.attachExisting?.(state)
    ?? await brokerSupervisor.startBrokerForExistingInvocation(state)

  const response = await client.input({
    invocationId: state.invocation.invocationId,
    input: toBrokerInvocationInput(input),
    policy: toBrokerInputPolicy(input.decision.inputPolicy),
  })

  await brokerInvocationStore.updateState({
    runtimeId: input.runtime.runtimeId,
    invocationId: state.invocation.invocationId,
    inputId: response.inputId,
    disposition: response.disposition,
    turnId: response.turnId,
  }, now())

  return toRuntimeDispatchResult(response)
}
```

Important: if the current broker cannot attach to an already-running broker process after HRC restart, the controller must say so and reconcile conservatively. Do not fake continuity.

### 6.8 Broker event mapper contract

Broker events are the broker-world replacement for launch callbacks/spool files.

```ts
export interface BrokerEventMapper {
  apply(event: InvocationEventEnvelope, context: BrokerEventContext): Promise<BrokerEventApplyResult>
}

export type BrokerEventContext = {
  session: HrcSessionRecord
  runtime: HrcRuntimeSnapshot
  run?: HrcRunRecord | undefined
  decision: BrokerRouteDecision
  continuationCodec: BrokerContinuationCodec
  now: () => string
}

export type BrokerEventApplyResult = {
  inserted: boolean
  runtimePatch?: Partial<BrokerRuntimeState> | undefined
  runPatch?: HrcRunPatch | undefined
  hrcEvents: HrcLifecycleEventDraft[]
  bufferChunks?: Array<{ runId: string; text: string }> | undefined
  messages?: HrcMessageDraft[] | undefined
  continuation?: RuntimeContinuationRef | undefined
}
```

Required event mapping:

| Broker event | HRC state/action |
| --- | --- |
| `invocation.started` | Persist broker/harness child process metadata; runtime `starting` or `ready` depending on event order. |
| `invocation.ready` | Runtime `ready` when no active turn; persist capabilities/status. |
| `input.accepted` | Emit HRC `input.accepted`; associate input with run/turn. |
| `input.queued` | Emit HRC `input.queued`; do not mark run started yet unless policy says queued run is active. |
| `input.rejected` | Mark dispatch rejected or failed according to caller path; emit auditable event. |
| `turn.started` | Run `started`; runtime `busy`; set `activeRunId`; persist broker `currentTurnId`. |
| `assistant.message.started` | Create/track assistant message projection if HRC message store supports it. |
| `assistant.message.delta` | Append runtime buffer chunk and/or message delta. |
| `assistant.message.completed` | Finalize assistant message; append final content if deltas were not stored. |
| `tool.call.started` | Emit HRC tool event; optionally persist tool-call projection. |
| `tool.call.delta` | Append tool delta event. |
| `tool.call.completed` | Finalize tool call. |
| `tool.call.failed` | Finalize failed tool call; associate error. |
| `usage.updated` | Persist usage metrics on run/event. |
| `continuation.updated` | Convert broker continuation to HRC continuation; update runtime and session continuation. |
| `turn.completed` | Run `completed`; runtime `ready`; clear `activeRunId`; persist final output. |
| `turn.failed` | Run `failed`; runtime `ready` or `failed` based on invocation state; clear `activeRunId`. |
| `turn.interrupted` | Run `interrupted`; runtime `ready` unless invocation is stopping. |
| `invocation.stopping` | Runtime `stopping`. |
| `invocation.exited` | Runtime `exited`; finalize active run as degraded if no terminal turn event arrived. |
| `invocation.failed` | Runtime `failed`; fail active run with broker error. |
| `invocation.disposed` | Runtime `disposed`; no future reuse. |
| `diagnostic` | Persist diagnostic HRC event with redaction. |
| `driver.notice` | Persist driver notice HRC event with redaction. |

The mapper must be idempotent. Store broker event `(invocationId, seq)` and ignore duplicates.

### 6.9 Public API compatibility contract

New API should expose target fields while preserving old `transport` during migration.

```ts
export type LegacyTransportAlias = 'tmux' | 'headless' | 'sdk'

export type RuntimeControllerView =
  | { controller: 'terminal'; terminalHost: 'tmux' | 'ghostty' }
  | { controller: 'embedded-sdk' }
  | { controller: 'harness-broker'; brokerDriver: string; brokerProtocol: string }
  | { controller: 'command-process' }
  | { controller: 'legacy-exec'; migrationOnly: true }

export type RuntimeViewV2 = {
  runtimeId: string
  hostSessionId: string
  generation: number
  status: string
  controller: RuntimeControllerView
  interactionMode: InteractionMode
  harnessFamily?: HarnessFamily | undefined
  harnessRuntime?: HarnessRuntime | undefined
  modelProvider?: ModelProvider | undefined
  startupMethod?: StartupMethod | undefined
  turnDelivery?: TurnDelivery | undefined
  capabilities: RuntimeCapabilities
  runtimeState?: RedactedRuntimeState | undefined

  /** Compatibility only. Derived from controller. */
  transport: LegacyTransportAlias
}

export type DispatchTurnResponseV2 = {
  runId: string
  hostSessionId: string
  generation: number
  runtimeId: string
  status: 'completed' | 'started' | 'queued' | 'rejected'
  controller: RuntimeControllerView
  interactionMode: InteractionMode
  turnDelivery: TurnDelivery
  capabilities: RuntimeCapabilities

  /** Compatibility only. Derived from controller. */
  transport: LegacyTransportAlias
  supportsInFlightInput: boolean
}
```

Compatibility mapping:

```ts
export function legacyTransportAlias(decision: RuntimeRouteDecision): LegacyTransportAlias {
  switch (decision.controller) {
    case 'terminal': return 'tmux' // until ghostty has public aliasing semantics
    case 'embedded-sdk': return 'sdk'
    case 'harness-broker': return 'headless'
    case 'legacy-exec': return 'headless'
    case 'command-process': return 'headless'
  }
}
```

This should be treated as response compatibility only. New HRC internals should not branch on `transport`.

---

## 7. Persistence changes

### 7.1 Target schema direction

Do not force broker invocations into `launches`. A broker invocation is not a launch artifact. Introduce operation records that can cover terminal launch, broker invocation, SDK turn, and command process without pretending all are file-backed launches.

```sql
ALTER TABLE runtimes ADD COLUMN runtime_controller TEXT;
ALTER TABLE runtimes ADD COLUMN interaction_mode TEXT;
ALTER TABLE runtimes ADD COLUMN harness_family TEXT;
ALTER TABLE runtimes ADD COLUMN harness_runtime TEXT;
ALTER TABLE runtimes ADD COLUMN model_provider TEXT;
ALTER TABLE runtimes ADD COLUMN route_decision_json TEXT;
ALTER TABLE runtimes ADD COLUMN runtime_state_json TEXT;
ALTER TABLE runtimes ADD COLUMN legacy_transport TEXT;

CREATE TABLE IF NOT EXISTS runtime_operations (
  operation_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  run_id TEXT,
  host_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  operation_kind TEXT NOT NULL, -- terminal_launch | broker_invocation | sdk_turn | command_process | legacy_exec
  controller TEXT NOT NULL,
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
  FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id)
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
```

`launches` can remain for terminal and legacy paths until deletion. It should not become the broker operation table.

### 7.2 Migration principle

Phase 1 can derive new fields from old columns. Phase 2 should write both old and new. Phase 3 should read new fields and derive old API fields. Phase 4 deletes old internal branching.

Do not migrate storage first if the controller boundary is still old. Storage migrations before behavioral separation create churn without reducing coupling.

---

## 8. Replacing `exec.ts` explicitly

### 8.1 New broker-world call path

The Codex broker path should become:

```text
HRC dispatch/start
  -> normalize request intent
  -> Agent Spaces resolves placement/runtime
  -> HRC RuntimeRouteDecision chooses controller: 'harness-broker'
  -> HRC creates runtime/run/operation records
  -> HRC calls Agent Spaces buildHarnessBrokerInvocation(...)
  -> HRC starts/uses BrokerClient
  -> HRC sends broker.hello
  -> HRC sends invocation.start(spec, initialInput?)
  -> HRC consumes InvocationEventEnvelope stream
  -> BrokerEventMapper updates runs/runtime/messages/events/continuation
  -> HRC returns DispatchTurnResponseV2 / StartRuntimeResponseV2
```

No launch artifact. No `exec.ts`. No HRC Codex app-server import. No HRC Codex JSONL parsing.

### 8.2 What remains from `exec.ts`

Only these concepts are worth preserving, and none should keep the name `exec.ts` in the target architecture:

| Current useful behavior | New component | Applies to broker routes? |
| --- | --- | --- |
| Pretty-print terminal launch metadata and prompt material | `TerminalLaunchPresenter` | No |
| Register/deregister terminal agentchat target | `AgentchatTargetRegistrar` | Only if broker exposes a target, not by default |
| Spawn an attachable terminal child/wrapper | `TerminalRuntimeController` | No |
| Spawn arbitrary command process | `CommandProcessController` | No, unless command runtime is explicitly non-harness |
| Forward signals and record process exit | Controller-specific supervisors | Broker supervisor handles broker process; broker handles harness process |
| Callback/spool for wrapper surviving server unavailability | `LegacyExecAdapter` only; broker needs explicit event/reconcile strategy | No |

### 8.3 Legacy sunset contract

```ts
export type LegacyExecAdapter = RuntimeController<LegacyExecRouteDecision> & {
  readonly deletionIssue: 'delete-after-broker-codex-cutover'
  readonly allowedHarnesses: ReadonlyArray<'codex-cli'>
  readonly allowedReasons: ReadonlyArray<'rollback' | 'migration-compat' | 'test-fixture'>
}
```

Rules:

- `legacy-exec` must require an explicit feature flag, for example `HRC_ENABLE_LEGACY_EXEC_HARNESS=1`.
- `legacy-exec` must be excluded from new route catalog entries.
- Boundary checks must fail if `legacy-exec` imports appear outside the legacy adapter/tests.
- Boundary checks must fail if HRC imports `spaces-harness-codex` outside legacy code.
- Existing tests around `launch-exec` can remain but should be moved under legacy tests.
- New broker tests must assert no `exec.ts` spawn occurred.

### 8.4 Mechanical deletion gates

Completion is not “the new types exist.” Completion is:

```bash
# Must produce no non-legacy hits.
rg "launch/exec|exec\.ts" packages/hrc-server/src \
  -g '!**/runtime-controllers/legacy-exec/**' \
  -g '!**/__tests__/legacy-exec/**'

rg "runCodexAppServerOneShot|spaces-harness-codex" packages/hrc-* \
  -g '!**/runtime-controllers/legacy-exec/**' \
  -g '!**/__tests__/legacy-exec/**'

rg "codexAppServer" packages/hrc-* \
  -g '!**/runtime-controllers/legacy-exec/**' \
  -g '!**/__tests__/legacy-exec/**'
```

And behaviorally:

- Headless Codex start uses `HarnessBrokerController`.
- Headless Codex dispatch uses `HarnessBrokerController`.
- Codex continuation is persisted from `continuation.updated`, not launch callback.
- Assistant output is persisted from broker message events, not parsed stdout in HRC.
- Run completion is persisted from broker turn/invocation terminal events, not wrapper exit.
- Permission requests are audited even when default-denied.
- Broker busy input is rejected or queued according to explicit `BrokerInputPolicy`.

---

## 9. Route catalog

A route catalog should be the source of valid combinations. It should be data-backed and used to generate validation/tests, but the resolved runtime route should still be a discriminated union.

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
    capabilities: { attach: true, capture: true, literalInput: true, structuredInput: false },
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
    capabilities: { attach: true, capture: true, literalInput: true, structuredInput: false },
  },
  {
    controller: 'embedded-sdk',
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-agent-sdk',
    interactionMode: 'nonInteractive',
    startupMethods: ['create-sdk-session', 'reuse-existing'],
    turnDeliveries: ['sdk-turn', 'sdk-inflight-input'],
    capabilities: { attach: false, capture: false, literalInput: false, structuredInput: true },
  },
  {
    controller: 'embedded-sdk',
    modelProvider: 'openai',
    harnessFamily: 'pi',
    harnessRuntime: 'pi-sdk',
    interactionMode: 'nonInteractive',
    startupMethods: ['create-sdk-session', 'reuse-existing'],
    turnDeliveries: ['sdk-turn', 'sdk-inflight-input'],
    capabilities: { attach: false, capture: false, literalInput: false, structuredInput: true },
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
    inputQueues: ['none'],
    capabilities: { attach: false, capture: false, literalInput: false, structuredInput: true },
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

Important exclusions:

- No `openai + claude-code` route.
- No `anthropic + codex` route.
- No SDK runtime under terminal controllers.
- No broker input outside `harness-broker`.
- No `legacy-exec` for new harness behavior.
- No broker-capable Codex headless path through `command-process`.

---

## 10. Operational concerns that must be in scope

### 10.1 Broker process ownership

Current broker reports `multiInvocation: false` and rejects concurrent active invocations. HRC must choose a policy:

```ts
export type BrokerProcessOwnership =
  | {
      kind: 'one-broker-process-per-runtime'
      maxActiveInvocations: 1
      preferred: true
    }
  | {
      kind: 'one-broker-process-per-invocation'
      maxActiveInvocations: 1
      cleanupAfterTerminal: true
    }
  | {
      kind: 'shared-broker-process'
      allowedOnlyWhenBrokerMultiInvocation: true
    }
```

Recommendation: start with **one broker process per runtime** or **per invocation**, not shared. A shared broker is dishonest while `multiInvocation: false` is the actual capability.

### 10.2 HRC restart and reconciliation

The proposal must not imply that broker event streams survive HRC restart unless the broker/supervisor actually supports reattachment. Target behavior should be explicit:

```ts
export type BrokerReconcileResult =
  | { state: 'healthy'; status: InvocationStatusResponse }
  | { state: 'broker_process_gone'; action: 'mark_runtime_unknown_or_failed' }
  | { state: 'invocation_gone'; action: 'finalize_active_run_degraded' }
  | { state: 'terminal_without_turn_event'; action: 'synthesize_degraded_completion' }
  | { state: 'reattached'; lastObservedSeq?: number }
```

Initial conservative rule:

- If HRC cannot reattach to the broker process, mark runtime `unknown_after_restart` and active run `failed` or `degraded` according to last persisted broker event.
- Do not pretend a live continuation exists unless `continuation.updated` or `status.continuation` has been observed and persisted.
- If broker status is available and terminal, reconcile active run to terminal state.

### 10.3 Permission negotiation

Permission is product/security policy, not just broker plumbing.

Required contract:

```ts
export type BrokerPermissionDecisionRecord = {
  permissionRequestId: string
  invocationId: string
  runtimeId: string
  runId?: string | undefined
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

Required behavior:

- Default policy is deny.
- Ask-client requires negotiated `permissionRequests: true`.
- Every request and decision is persisted as an auditable HRC event.
- `yolo` mapping to allow must be explicit and visible in route decision/persistence.
- Timeout behavior must never silently approve unless the policy explicitly says so.

### 10.4 Input queue semantics

The first Codex broker route should assume `inputQueue: 'none'` unless Agent Spaces intentionally emits FIFO and the broker capabilities report queue support.

Required behavior:

- If invocation state is `ready`, `broker-input` starts a turn.
- If invocation state is `turn_active` and policy is reject, HRC returns rejected/busy.
- If policy is queue but capability says no queue, HRC returns rejected with reason.
- If policy is queue and capability says queue, HRC records queued run/input and waits for broker events to start the run.
- `interrupt_then_apply` should remain disabled until broker support is real.

### 10.5 Agentchat/local bridge ownership

Broker headless routes should not accidentally lose control surfaces. Choose one:

```ts
export type AgentchatExposurePolicy =
  | { mode: 'none' }
  | { mode: 'hrc-registers-target'; targetKind: 'broker-runtime' }
  | { mode: 'broker-reports-target'; targetKind: string }
```

Recommendation for first cut: broker headless routes use `mode: 'none'` unless a concrete user/API requirement exists. Do not inherit terminal agentchat registration from `exec.ts` just because it was there.

### 10.6 Observability and OTEL

`exec.ts` currently mutates Codex config for OTEL. Broker cutover needs replacement ownership:

```ts
export type BrokerObservabilityContract = {
  correlation: {
    hostSessionId: string
    runtimeId: string
    runId?: string | undefined
    invocationId: string
    traceId?: string | undefined
  }
  env: Record<string, string>
  driverConfig?: Record<string, unknown> | undefined
  redaction: 'broker-redaction-required'
}
```

Recommendation:

- HRC generates correlation IDs and passes them into Agent Spaces `buildHarnessBrokerInvocation`.
- Agent Spaces/broker driver owns Codex-specific config mutation.
- Broker events carry enough correlation for HRC event storage.
- HRC must not write Codex home config directly for broker routes.

### 10.7 Redaction and persisted specs

Broker specs include env, cwd, args, prompt-derived material, and possibly secrets. Persist hashes always; persist redacted specs only.

```ts
export type RedactedHarnessInvocationSpec = {
  specVersion: 'harness-broker.invocation/v1'
  invocationId?: string
  harness: HarnessDescriptor
  process: {
    command: string
    args: string[] // redacted where needed
    cwd: string
    envKeys: string[]
    harnessTransport: HarnessTransportSpec
    limits?: ProcessLimits
  }
  interaction?: InteractionSpec
  continuation?: { provider: string; kind?: string; keyHash: string }
  driver: { kind: string; redacted: true }
  correlation?: Record<string, string>
}
```

---

## 11. Implementation plan

### Slice 0: Add boundary checks before refactoring

Add repo checks that identify current violations but can run in warning mode:

- HRC imports of `spaces-harness-codex`.
- HRC references to `runCodexAppServerOneShot`.
- HRC references to `codexAppServer` outside legacy and Agent Spaces adapter compatibility.
- HRC spawns of `launch/exec.ts` outside legacy.

This gives the migration a visible burn-down list.

### Slice 1: Extract route decision without changing behavior

Create `runtime-routing/route-decision.ts` that encapsulates the current predicate mesh:

- `shouldUseHeadlessTransport`
- `shouldUseSdkTransport`
- `shouldUseHeadlessSdkExecutor`
- `deriveInteractiveHarness`
- `deriveSdkHarness`
- headless runtime reuse filtering

Initially emit both target fields and legacy aliases.

Acceptance:

- Existing tests pass.
- Golden table covers old behavior.
- No caller branches on raw `intent.harness` where route decision should be used.

### Slice 2: Split `exec.ts` into legacy-only modules

Move implementation into:

```text
runtime-controllers/legacy-exec/legacy-launch-wrapper.ts
runtime-controllers/legacy-exec/legacy-exec-adapter.ts
runtime-controllers/terminal/terminal-launch-presenter.ts
runtime-controllers/terminal/agentchat-target-registrar.ts
```

Keep `launch/exec.ts` as a shim only.

Acceptance:

- Old launch tests pass under legacy naming.
- No new controller imports legacy wrapper.
- Codex-specific code is contained in legacy-exec only until broker path lands.

### Slice 3: Implement broker controller skeleton

Add:

- `HarnessBrokerController`
- `BrokerProcessSupervisor`
- `BrokerEventMapper`
- `BrokerContinuationCodec`
- `BrokerPermissionCoordinator`
- `BrokerInvocationStore`

Wire to `spaces-harness-broker-client` and Agent Spaces `buildHarnessBrokerInvocation`.

Acceptance:

- Unit tests use fake broker client to start invocation and consume events.
- Event mapper tests are independent of Codex.
- Permission coordinator tests cover deny/allow/ask-client timeout.

### Slice 4: Route Codex headless through broker behind a flag

Feature flag:

```text
HRC_CODEX_HEADLESS_CONTROLLER=harness-broker | legacy-exec
```

Default can remain `legacy-exec` for one cycle, but CI should run broker mode.

Acceptance:

- Headless Codex start/dispatch pass in broker mode.
- Continuation persists from broker event/status.
- Assistant output persists from broker events.
- No launch artifact is created for broker path.
- No `exec.ts` process is spawned for broker path.

### Slice 5: Persist runtime state and broker operations

Add `runtime_state_json`, `route_decision_json`, `runtime_operations`, `broker_invocations`, and `broker_invocation_events`.

Acceptance:

- Old API responses still work.
- New API fields expose controller/turnDelivery/startupMethod/capabilities.
- Reconcile can inspect broker runtime state.

### Slice 6: Turn broker on by default for Codex headless

Default:

```text
HRC_CODEX_HEADLESS_CONTROLLER=harness-broker
```

Legacy requires explicit opt-in.

Acceptance:

- Boundary checks fail on non-legacy `exec.ts` use.
- Operational runbook covers rollback.
- Broker crash/restart/reconcile tests exist.

### Slice 7: Delete legacy exec harness path

Delete or retain only terminal bootstrap code that has no harness execution semantics. If a terminal bootstrap remains, it should not be called `exec.ts` and should not live in a generic `launch` directory that invites reuse as a harness executor.

Acceptance:

- `legacy-exec` route is removed from catalog.
- `launch/exec.ts` shim is gone or only supports terminal bootstrap with no Codex/headless code.
- HRC has no dependency on `spaces-harness-codex`.

---

## 12. Test gates

### 12.1 Boundary tests

1. Broker Codex start does not spawn `launch/exec.ts`.
2. Broker Codex dispatch does not spawn `launch/exec.ts`.
3. HRC broker path does not import `spaces-harness-codex`.
4. HRC broker path does not parse Codex JSONL or inspect Codex app-server native event names.
5. `LegacyExecAdapter` is the only path allowed to call the legacy launch wrapper.

### 12.2 Route tests

1. `openai + codex + headless` resolves to `controller: 'harness-broker'` when broker flag is on.
2. `openai + codex + interactive` resolves to terminal controller.
3. `anthropic + claude-code + nonInteractive` resolves to embedded SDK or future broker route, but not terminal by accident.
4. Explicit SDK harnesses do not reuse CLI runtimes.
5. Old `transport` aliases are derived, not used as route source of truth.

### 12.3 Broker lifecycle tests

1. `broker.hello` protocol mismatch fails cleanly.
2. `invocation.start` persists invocation id and capabilities.
3. `invocation.ready` marks runtime ready.
4. `turn.started` marks run started and runtime busy.
5. `turn.completed` marks run completed and runtime ready.
6. `invocation.failed` fails active run.
7. `invocation.exited` without `turn.completed` finalizes active run degraded.
8. Duplicate broker events are ignored by `(invocationId, seq)`.
9. Out-of-order terminal event handling is deterministic.
10. Broker process exit closes event stream and triggers reconcile.

### 12.4 Continuation tests

1. HRC `{ provider: 'openai', key }` converts to broker `{ provider: 'codex', kind: 'thread', key }`.
2. Broker `continuation.updated` converts back to HRC continuation.
3. Follow-up turn uses persisted continuation.
4. Failed resume with `resumeFallback: 'fail'` clears or preserves continuation according to explicit policy.
5. Failed resume with `resumeFallback: 'start-fresh'` persists the new continuation only after broker reports it.

### 12.5 Input policy tests

1. Ready invocation accepts user input and starts a turn.
2. Busy invocation with reject policy returns busy/rejected.
3. Busy invocation with queue policy but no broker queue capability returns queue-not-supported.
4. FIFO queue path works only when spec and capabilities both allow it.
5. `interrupt_then_apply` returns unsupported until implemented.

### 12.6 Permission tests

1. Default deny declines requests and writes audit event.
2. Explicit allow requires yolo/provenance and writes audit event.
3. Ask-client without negotiated permission capability auto-denies.
4. Ask-client timeout uses explicit default decision.
5. Permission subject is redacted before persistence.

### 12.7 Recovery tests

1. HRC restart with broker runtime in `starting` reconciles to failed/unknown if broker unavailable.
2. HRC restart with broker runtime in `turn_active` and broker unavailable finalizes active run degraded or unknown according to policy.
3. Broker status terminal but HRC active run open reconciles run terminal.
4. Persisted continuation survives HRC restart.
5. Orphan broker process cleanup does not kill unrelated harness processes.

---

## 13. Open decisions to settle explicitly

1. **Broker process lifetime:** one process per runtime or per invocation? Recommended initial answer: one process per runtime, because it maps naturally to HRC runtime identity while respecting `multiInvocation: false`.
2. **Broker reattachment:** can HRC reconnect to a broker process after restart? If not, define conservative recovery and do not imply live reuse.
3. **Public API versioning:** add V2 fields in-place or introduce `/v2` runtime views? Recommended initial answer: add fields in-place while keeping old `transport` alias.
4. **Ghostty terminology:** should `ghostty` be a terminal host under `controller: 'terminal'`, not a top-level controller? Recommended answer: yes.
5. **Command runtime contract:** should command runtimes have no `harnessFamily`? Recommended answer: yes; command runtimes are siblings, not harnesses.
6. **Claude/Pi SDK future:** remain `embedded-sdk` or move behind broker after Codex? Recommended answer: leave as `embedded-sdk` until there is a real broker driver; do not overgeneralize early.
7. **OTEL ownership:** Agent Spaces builder versus broker driver? Recommended answer: broker driver owns harness-specific config; HRC owns correlation only.
8. **Agentchat exposure for broker:** none, HRC-registered target, or broker-reported target? Recommended initial answer: none unless a concrete control surface is required.

---

## 14. Final acceptance definition

The broker runtime control plane is done when all of these are true:

1. Codex headless start and dispatch use `HarnessBrokerController` by default.
2. Broker-capable HRC routes do not spawn `launch/exec.ts`.
3. Broker-capable HRC routes do not import Codex harness-driver packages.
4. Broker-capable HRC routes do not parse Codex stdout or app-server native events.
5. HRC obtains `HarnessInvocationSpec` from Agent Spaces.
6. HRC persists broker invocation identity, capabilities, continuation, state, and event sequence.
7. HRC maps broker events to HRC state through one idempotent mapper.
8. HRC permission decisions are explicit and audited.
9. HRC busy-input behavior is explicit and tested.
10. HRC restart/reconcile behavior is explicit and tested.
11. Legacy `exec.ts` code is isolated behind `LegacyExecAdapter`, feature-gated, and has a deletion gate.
12. Public APIs expose the new controller/capability fields while deriving old `transport` aliases for compatibility.

The final deletion criterion is simple:

> There is no broker-capable harness execution path in HRC that depends on `exec.ts`, launch artifacts, callback/spool delivery, or HRC-owned harness protocol parsing.

---

## 15. Summary recommendation

Adopt **HRC Broker Runtime Control Plane** as the proposal name and orient the work around severing the execution boundary, not just renaming transport fields.

The right replacement for `exec.ts` in the broker harness world is not another generic process wrapper. It is a typed broker controller stack:

```text
HarnessBrokerController
  BrokerProcessSupervisor
  BrokerInvocationStore
  BrokerEventMapper
  BrokerContinuationCodec
  BrokerPermissionCoordinator
  BrokerReconciler
```

`exec.ts` can live for a few cycles as `LegacyExecAdapter` implementation detail, but the target design should make it impossible for broker-capable harnesses to route through it accidentally. The proposal should be judged by boundary tests and operational behavior, not by whether the new vocabulary appears in type definitions.
