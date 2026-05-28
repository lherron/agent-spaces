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

The key move is to stop treating HRC as the place where runtime execution facts are assembled. HRC is allowed to select, admit, reject, persist, reconcile, stop, and expose a runtime. HRC is not allowed to construct or repair compiled execution mechanics after ASP compilation.

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

ASP owns runtime construction. It resolves placement, target bundle, model, harness family, harness runtime, prompt/context materialization, the declared `lockedEnv` (from resolved space/agent/target config), process argv, driver spec, continuation encoding, permission policy input, and broker start request construction. ASP MUST NOT project the operator or ambient environment into the spec, and MUST NOT derive `lockedEnv` from `process.env`.

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

Interactive broker runtimes with an HRC-owned tmux pane lease are an explicit concrete target contract, not inherited terminal-controller behavior. They MUST declare `brokerTerminal.host: 'tmux'`, `brokerTerminal.operatorAttach: true`, and `AgentchatExposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-pane' }`. `brokerTerminal.exposurePolicy` and `policy.exposurePolicy` MUST be identical.

---

## 3. Contract triangle

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ASP Compiler Plane                                                   │
│                                                                      │
│ Owns: placement, bundle resolution, target materialization, harness   │
│ runtime selection, model resolution, process spec, broker driver spec,│
│ continuation encoding, prompt/context materialization, lockedEnv/argv,│
│ canonical projections, hashes, diagnostics.                          │
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
| Process command/args/cwd/lockedEnv | Owns | Transmits unchanged | Executes |
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
| Canonical projections/hashes for compiled artifacts | Owns | Persists projections + hashes | Emits normalized events/status (no redaction transform) |

### 3.2 Confidentiality posture (canonical home)

> The contract plane defines **no** generic secret classification, redaction transforms, or digest-substituted values. It achieves confidentiality structurally: the compiled spec is **credential-free and ambient-free by contract**. ASP-declared, non-secret configuration the harness requires lives in `spec.process.lockedEnv` or `session.lockedEnv` and is hash-covered like any other compiled mechanic. Credential material never enters the compiled spec; it reaches the harness only through an execution-owner credential source (the broker/driver launch environment, embedded SDK controller environment, an external secret store, or an on-disk file credential materialized outside the compiled DTO; see §7.5.1). The ambient baseline is supplied by the execution owner's own environment through a fixed allowlist and is likewise absent from the spec. Confidentiality is therefore enforced by *what the spec is allowed to contain*, **not** by contract-DTO redaction.

### 3.3 Timing boundaries: compile-time, dispatch-time, runtime

Compiled runtime routes have three distinct timing surfaces. They are intentionally separate:

| Surface | Producer | Consumer | Contains | Must not contain |
| --- | --- | --- | --- | --- |
| Compile-time contract | ASP compiler | HRC, then broker | Reproducible launch mechanics: selected profile, `HarnessInvocationSpec`, `InvocationStartRequest`, driver kind/config, process command/args/cwd/`lockedEnv`, transport requirements, interaction intent, policies, projections, hashes | Runtime allocations, tmux socket/session/pane ids, callback sockets, run database ids, HRC operation ids, ambient or credential material |
| Dispatch-time contract | HRC runtime control plane | Broker process/driver or embedded SDK controller | Per-operation runtime allocations and handles supplied after profile selection: operation identity, validated `dispatchEnv`, pre-allocated external resources, credential source handles, and other typed overlays explicitly defined as outside compiled hash material | Mutations to compiled process/driver/session mechanics, inferred driver/config defaults, replacement argv/env/cwd, untyped hidden defaults |
| Runtime-reported facts | Harness Broker/driver or embedded SDK controller | HRC event projection/API views | Observed facts emitted after start: invocation status, normalized events, terminal surface reports where applicable, continuation reports, process status where applicable, SDK session state where applicable | New compile decisions, reconstructed profile material, client persistence semantics |

The compile-time contract answers “what kind of runtime is required and how must the harness be launched?” The dispatch-time contract answers “which already-admitted runtime resources will this operation use?” Runtime-reported facts answer “what actually happened after the driver started?”

Concrete example: an interactive `claude-code-tmux` profile may compile with `brokerTerminal.host: 'tmux'`, `terminalHost: 'tmux'`, `harnessTransport.kind: 'pty'`, and broker exposure policy. It MUST NOT compile a concrete tmux server socket, session id, window id, pane id, session name, or window name. HRC supplies an HRC-owned pane lease at dispatch time through `runtime.terminalSurface`; the broker driver attaches to the leased pane and never creates tmux lifecycle objects.

```ts
const runtime: InvocationRuntimeContext = {
  terminalSurface: {
    kind: 'tmux-pane',
    ownership: 'hrc',
    socketPath: '/tmp/hrc/tmux/default.sock',
    sessionId: '$12',
    windowId: '@34',
    paneId: '%56',
    sessionName: 'hrc-agent-spaces',
    windowName: 'larry',
    allowedOps: {
      inspect: true,
      sendInput: true,
      sendInterrupt: true,
      capture: true,
      resize: true,
    },
  },
}
```

The `claude-code-tmux` and `codex-cli-tmux` broker drivers MUST require `runtime.terminalSurface.kind === 'tmux-pane'` and `ownership === 'hrc'`. They may perform only the lease's allowed pane operations: `inspect`, `sendInput`, `sendInterrupt`, and, when cap-gated by `allowedOps`, `capture` and `resize`. They MUST NOT issue tmux lifecycle verbs including `start-server`, `kill-server`, `new-session`, `new-window`, `split-window`, `rename-session`, `kill-session`, `attach-session`, `respawn-pane`, or `set-environment`. The driver reports the observed leased pane with `terminal.surface.reported`.

Dispatch-time overlays are not a loophole in compiler closure. If a value changes the deterministic launch mechanics selected by ASP, it belongs in compile input and requires recompilation. If a value selects or references an already-admitted runtime resource owned by HRC, it belongs at dispatch time and must be explicit, typed, and validated at the broker boundary.

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

> **After ASP emits a `CompiledRuntimePlan`, HRC MUST NOT reconstruct, mutate, patch, infer, or synthesize compiled execution mechanics.**

This includes, but is not limited to:

- `HarnessInvocationSpec`
- `InvocationStartRequest`
- `spec.driver`
- driver config
- `spec.process.command`
- `spec.process.args`
- `spec.process.cwd`
- `spec.process.lockedEnv`
- `session.lockedEnv`
- `session.pathPrepend`
- SDK runtime/session config
- harness transport descriptors
- Codex app-server descriptors
- prompt/context materialization file paths
- harness-specific continuation encoding
- harness-specific OTEL/config mutation
- native harness launch mode detection

HRC MAY do only these things after compilation:

1. Select one execution profile already present in `CompiledRuntimePlan.executionProfiles`.
2. Reject the plan or selected profile.
3. Persist the plan/profile hashes **and** plan/profile projections, plus diagnostics.
4. Check capability compatibility.
5. Pass ASP-emitted `InvocationStartRequest` to the broker unchanged.
6. Apply HRC-owned product/security decisions through explicit policy fields that are part of the compiled profile or explicitly identified as HRC overlays that do not mutate process/driver mechanics.
7. Ask ASP to recompile if runtime policy, placement, model, harness, continuation, permissions, prompt materialization, `lockedEnv` (keys and values), or driver requirements change. A change to `dispatchEnv` is **not** a recompile trigger: `dispatchEnv` is HRC-supplied per-invocation context, carries no compiled-launch-shape semantics, and is hashed nowhere.

If HRC needs a different argv, `lockedEnv`, driver config, transport descriptor, continuation shape, prompt materialization strategy, or broker start request, the answer is **recompile**, not patch.

This invariant is stronger than “HRC obtains `HarnessInvocationSpec` from Agent Spaces.” HRC must obtain the complete selected execution profile from ASP and then treat it as immutable.

### INV-ENV — execution env is a validated disjoint union of four channels

The harness execution environment is `ambientAllowlist(executionOwnerEnv) ⊎ credentials ⊎ lockedEnv ⊎ dispatchEnv` (see §7.5.1). For broker routes, the execution owner is the broker process at harness spawn. For embedded-sdk routes, it is the in-process SDK controller for the scoped SDK session. The compiled spec is **credential-free and ambient-free by contract**: it carries neither credential material nor ambient/operator environment. `lockedEnv` is ASP-declared, non-secret config that is hash-covered (`specHash`/`startRequestHash`/`profileHash`/`planHash`/`compatibilityHash` as applicable); `lockedEnvKeys` MUST be a subset of the resolved declared source and MUST NOT be derived from `process.env`. `dispatchEnv` is HRC-supplied per-invocation context, hashed nowhere, and changeable without recompilation. A cross-channel key collision is a validation error resolved by rejection, never by precedence: `lockedEnv` colliding with an ambient-baseline/credential/harness-reserved key is rejected at compile; `dispatchEnv` colliding with any other channel (including shadowing `lockedEnv`) is rejected at dispatch.

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
  owns projection/hash/file-backed runtime artifacts such as compiled plans, specs, prompts, diagnostics
  persisted artifacts are explicit projections (credential-free and ambient-free by contract; self-hash/timestamp fields omitted by path)
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

HRC calls ASP with intent and product/security overlays before compilation. Compile input is the only place HRC may affect compiled execution mechanics.

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

  lockedEnv: {
    lockedEnvKeys: string[]
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
}
```

### 7.3.1 Terminal execution profile

Terminal profiles model interactive harness processes. The host determines who owns the terminal lifetime and whether the controller has a writable input channel.

```ts
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
    lockedEnv: Record<string, string>
    io:
      | { kind: 'inherit' }
      | { kind: 'pty'; cols?: number; rows?: number }
  }
  policy: {
    exposurePolicy: AgentchatExposurePolicy
    resourceLimits?: RuntimeResourceLimits
  }
}
```

Foreground terminal profiles are the Path-1 `asp run` shape: stdio is inherited from the caller, process lifetime is caller-owned, `terminal.startupMethod` is `inherit-current-terminal`, `process.io` is `{ kind: 'inherit' }`, and `policy.exposurePolicy` is `{ mode: 'none' }`. HRC does not register a foreground target and does not keep a pane, pipe, or controller-mediated input channel for later turns.

Controller-owned terminal hosts (`tmux` and `ghostty`) use a pty, have HRC/controller-owned lifetime, and may support attach, remote-control, and controller-mediated input. For these hosts, `process.io.kind` is `pty`; the tmux host registers its target with `exposurePolicy: 'hrc-registers-target'`.

`turnDelivery` keeps the existing union. Validators MUST enforce that `terminal.host: 'foreground'` permits only `terminal-launch-input`; `terminal-literal-input` is forbidden because it requires a controller-owned pane such as the tmux send-keys path. Foreground delivers at most one launch turn, with the initial prompt baked into process argv. Subsequent interaction is operator typing into the inherited TTY and is not modeled as controller delivery. A blank REPL launch is an empty launch-input turn, not a separate delivery mode.

### 7.3.2 Embedded SDK execution profile

Embedded SDK profiles model non-interactive SDK sessions run in-process by the runtime controller. They do not describe a spawned harness process, callback socket, broker protocol, pty, or terminal surface.

```ts
export type EmbeddedSdkExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'embedded-sdk'
  interactionMode: 'nonInteractive'
  sdk: {
    runtime: 'claude-agent-sdk' | 'pi-sdk'
    startupMethod: 'create-sdk-session' | 'reuse-existing'
    turnDelivery: 'sdk-turn' | 'sdk-inflight-input'
  }
  session: {
    provider: 'anthropic' | 'openai'
    modelId: string
    cwd: string
    lockedEnv: Record<string, string>
    pathPrepend?: string[]
  }
  policy: {
    inputPolicy?: BrokerInputPolicy
    resourceLimits?: RuntimeResourceLimits
  }
  continuation?: RuntimeContinuationRef
}
```

The immutable launch/session truth for an embedded SDK profile is `sdk`, `session.cwd`, `session.lockedEnv`, `session.pathPrepend`, model/provider fields, policy, resource limits, and continuation metadata. `session.pathPrepend` is the typed PATH mutation for SDK sessions; `PATH` MUST NOT be placed in `session.lockedEnv`.

Validator gates:

- embedded SDK profiles require `interactionMode: 'nonInteractive'` exactly; `headless` is not SDK mode.
- `sdk.runtime: 'claude-agent-sdk'` requires `session.provider: 'anthropic'`.
- `sdk.runtime: 'pi-sdk'` requires `session.provider: 'openai'`.
- `sdk.startupMethod` MUST be `create-sdk-session` or `reuse-existing`.
- `sdk.turnDelivery` MUST be `sdk-turn` or `sdk-inflight-input`; `sdk-inflight-input` additionally requires selected profile, HRC policy, runtime state, and SDK implementation capability to allow in-flight input.
- `session.lockedEnv` follows the same declared non-secret, hash-covered environment rules as process `lockedEnv`; it MUST be disjoint from ambient-baseline, credential/capability, and harness-reserved key classes.
- `session.pathPrepend` participates in profile and compatibility hash material.
- No embedded SDK profile may declare broker protocol fields, process command/args, harness transport, terminal host, or broker input delivery.

### 7.4 Broker execution profile

This is the critical profile for Codex headless and broker-capable harnesses. Broker interactive is supported only for the explicit tmux driver shapes described here: `claude-code-tmux` and `codex-cli-tmux`.

```ts
export type BrokerTerminalSurface = {
  host: 'tmux'
  startupMethod: 'create-terminal' | 'reuse-existing' | 'adopt-terminal'
  turnDelivery: 'terminal-literal-input'
  operatorAttach: true
  exposurePolicy: { mode: 'broker-reports-target'; targetKind: 'tmux-pane' }
}

export type BrokerExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'harness-broker'
  interactionMode: 'headless' | 'interactive'

  brokerProtocol: 'harness-broker/0.1'
  brokerDriver: 'codex-app-server' | 'claude-code-tmux' | 'codex-cli-tmux' | string
  brokerOwnership: 'hrc-owned-process'
  brokerTerminal?: BrokerTerminalSurface

  harnessInvocation: {
    startRequest: InvocationStartRequest
    specHash: string
    startRequestHash: string
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

The immutable launch truth for a broker profile remains `harnessInvocation.startRequest.spec`, especially `spec.process.command`, `spec.process.args`, `spec.process.cwd`, `spec.process.lockedEnv`, `spec.process.pathPrepend`, `spec.process.harnessTransport`, and `spec.driver`. `brokerTerminal` is selection/exposure metadata only. It MUST validate against the start request; it MUST NOT duplicate or override process launch mechanics.

Validator gates:

- `brokerDriver: 'codex-app-server'` requires `interactionMode: 'headless'`, no `brokerTerminal`, `spec.interaction.mode: 'headless'`, and `spec.process.harnessTransport.kind: 'jsonrpc-stdio'`.
- `brokerDriver: 'claude-code-tmux'` requires `interactionMode: 'interactive'`, `brokerTerminal.host: 'tmux'`, `brokerTerminal.turnDelivery: 'terminal-literal-input'`, `brokerTerminal.operatorAttach: true`, `brokerTerminal.exposurePolicy` identical to `policy.exposurePolicy`, `policy.exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-pane' }`, `spec.driver.kind: 'claude-code-tmux'`, `spec.driver.terminalHost: 'tmux'`, `spec.interaction.mode: 'interactive'`, `spec.process.harnessTransport.kind: 'pty'`, and dispatch `runtime.terminalSurface` with `kind: 'tmux-pane'` and `ownership: 'hrc'`.
- `brokerDriver: 'codex-cli-tmux'` requires `interactionMode: 'interactive'`, `brokerTerminal.host: 'tmux'`, `brokerTerminal.turnDelivery: 'terminal-literal-input'`, `brokerTerminal.operatorAttach: true`, `brokerTerminal.exposurePolicy` identical to `policy.exposurePolicy`, `policy.exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-pane' }`, `spec.driver.kind: 'codex-cli-tmux'`, `spec.driver.terminalHost: 'tmux'`, `spec.driver.hookBridge: 'codex-hooks/v1'`, `spec.interaction.mode: 'interactive'`, `spec.process.harnessTransport.kind: 'pty'`, and dispatch `runtime.terminalSurface` with `kind: 'tmux-pane'` and `ownership: 'hrc'`.
- A `claude-code-tmux` or `codex-cli-tmux` broker profile whose `harnessTransport.kind` is not `pty` MUST reject.
- A broker profile with `interactionMode: 'interactive'` and no `brokerTerminal.host: 'tmux'` MUST reject.
- A `codex-app-server` profile with `interactionMode: 'interactive'` MUST reject.
- The pre-HRC interactive Claude Code and Codex tmux paths MUST compile/select `kind: 'harness-broker'`; older `TerminalExecutionProfile` routes remain valid only when terminal-controller behavior is explicitly requested.

`codex-cli-tmux` uses Codex lifecycle hooks and the Codex rollout transcript tail as driver-private input. ASP/driver mechanics MUST install or overlay trusted Codex hook configuration for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop`. The broker driver maps those raw native payloads plus transcript tail entries into normalized broker events and MUST NOT expose native Codex hook names or rollout entry names as normalized event `type`s`. Real Codex hook evidence from T-01681 and rollout-tail evidence from T-01700 define the v1 field contract:

- `SessionStart` carries `transcript_path`; the driver uses it to tail the Codex rollout transcript for assistant-message evidence.
- `UserPromptSubmit` carries `turn_id`, `session_id`, `prompt`, `cwd`, and `model`; it opens the normalized turn and can report the broker continuation from `session_id`.
- `PreToolUse` carries `tool_use_id`, `tool_name`, `tool_input`, and `turn_id`; it maps to `tool.call.started`.
- `PermissionRequest` carries `tool_name`, `tool_input.command`, optional `tool_input.description`, and `turn_id`, but no `tool_use_id`; the driver correlates it to a pending tool call by `(turn_id, tool_input.command)`.
- `PostToolUse` carries `tool_use_id`, `tool_name`, `tool_input`, `tool_response`, and `turn_id`; it maps to `tool.call.completed`, preserving command errors/results in the result payload rather than normalizing command failure to `tool.call.failed`.
- The Codex rollout transcript tail is the first conforming implementation source for the generic held-latest assistant-message contract: completed assistant-message entries are held as the possible terminal answer, previously held natural assistant messages are emitted as `assistant.message.completed` with `{ final: false }`, and rollout `task_complete` flushes the held terminal assistant message as `assistant.message.completed` with `{ final: true }`.
- `Stop` carries `stop_hook_active`, `turn_id`, and `session_id`; it is only the turn-completion/continuation hook and maps to `turn.completed` plus `continuation.updated`.

Codex hooks are discrete lifecycle events and the rollout transcript tail currently provides complete assistant messages, not token deltas. `codex-cli-tmux` MUST set `capabilities.events.assistantDeltas` to `false`; `assistant.message.delta` and `tool.call.delta` are unavailable unless a future native source provides them. `session_id` is the Codex v1 continuation key; `turn_id` is per-turn; `transcript_path` is driver-private assistant-message evidence and MUST NOT be required by HRC to project continuation.

### 7.5 Compiler determinism and hashing

ASP SHOULD make plans deterministic given:

```text
compile request
resolved bundle lock
compiler version
environment resolution inputs
policy overlays
```

The hashes (`specHash`/`profileHash`/`planHash`/`compatibilityHash`, plus `contentHash` for persisted bytes) are **closure/dedup/route/reuse/test** tools, **not** confidentiality controls.

Hash material is a **named canonical projection** selected by **explicit PATH selection**, versioned `hashProjection: 'runtime-contract-semantic/v2'`. The projection omits only self-hash fields and ephemeral timestamps by path; it omits no semantic launch material, and it never carries `dispatchEnv`. Path-based projection works by explicit JSON path — never by key-name matching, never by value scanning. Canonicalization survives unchanged.

`hashProjection: 'runtime-contract-semantic/v2'` is the **projection policy** and is orthogonal to the canonicalization **algorithm** `HashAlgorithm = 'sha256-canonical-json/v1'` (unchanged). The two version strings stay separate.

ASP MUST compute:

- `specHash`: `HarnessInvocationSpec` (lockedEnv **included**).
- `startRequestHash`: `InvocationStartRequest` (initialInput **included**; lockedEnv **included**).
- `profileHash`: `RuntimeExecutionProfile` minus self-hash fields and ephemeral timestamps (lockedEnv **included**).
- `planHash`: `CompiledRuntimePlan` minus self-hash fields and ephemeral timestamps (lockedEnv **included**).
- `compatibilityHash`: command, args, cwd, pathPrepend, transport, driver config/model/reasoning, bundle identity/lock, policy, resource limits, continuation provider/kind/non-secret identity, **plus the canonical `lockedEnv` object (keys and values)**.

`lockedEnv` is declared **non-secret** config and is **INCLUDED** as the canonical `lockedEnv` object in `specHash`, `startRequestHash`, `profileHash`, `planHash`, and `compatibilityHash`. `dispatchEnv` is included in **NONE** of these and is never part of the compiled projection. Hashes remain **closure/dedup/reuse/test** tools, **not** confidentiality controls.

**Hard secret rule:** Secrets MUST NEVER appear in the compiled spec — including `spec.process.lockedEnv`, `session.lockedEnv`, argv, cwd, driver/session config, initial input, labels, or correlation. Credential material reaches the harness only through an execution-owner credential source (the broker/driver launch environment, embedded SDK controller environment, an external secret store, or an on-disk file credential materialized outside the compiled DTO; see §7.5.1). The compiled spec is **credential-free and ambient-free by contract**.

HRC MAY use these hashes for persistence, reuse, diagnostics, and boundary tests. HRC MUST NOT use them as a license to reconstruct the underlying artifacts.

### 7.5.1 Execution-env composition (canonical home)

The harness execution environment is composed by the execution owner as a **validated disjoint union** of four channels. Broker routes compose this map at harness process spawn. Embedded SDK routes compose the same map inside `EmbeddedSdkController.start()` before creating or reusing the scoped in-process SDK session:

```text
harnessEnv = ambientAllowlist(executionOwnerEnv) ⊎ credentials ⊎ lockedEnv ⊎ dispatchEnv
```

- **ambientAllowlist** — a fixed, minimal set inherited from the execution owner's own environment: `HOME`, `PATH`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`, `USER`, `USERNAME`, `TERM`, `LANG`, `LC_*`, `TZ`. Harness-family extensions only after validation. Not in the compiled spec; not hashed.
- **credentials** — credential material reaches the harness through a credential source that is **never the compiled spec DTO and never hashed**. Accepted sources: (a) **env-value credentials** from the execution owner's environment or an external secret store, composed into this channel by the execution owner; or (b) an **on-disk file credential** living outside the compiled DTO that the harness reads directly. The compiled spec carries at most a non-secret path to such a file (e.g. `CODEX_HOME`) in `lockedEnv`, never the credential bytes. For env-value credentials, missing required values fail before harness start with a typed credential error. For on-disk file credentials, absence/invalidity MAY instead surface as the native harness startup failure rather than a pre-start credential error, and the file MAY be materialized by the broker/driver, embedded SDK controller, or runtime-home preparation step — placement of the file outside the DTO is what matters, not which component writes it. **Codex driver v1:** the credentials env map is empty; `auth.json` under `CODEX_HOME` is the accepted on-disk file credential, materialized by runtime-home preparation as today and read directly by Codex; missing/invalid auth surfaces as the native Codex startup failure.
- **lockedEnv** — ASP-declared environment the harness requires to function (`spec.process.lockedEnv` for broker/terminal process profiles, `session.lockedEnv` for embedded SDK profiles). Hash-covered; HRC MUST NOT modify it.
- **dispatchEnv** — HRC-supplied per-invocation context (handles/correlation, e.g. a wrkq handoff id). For embedded SDK, this enters through `RuntimeControllerStartInput.dispatchEnv` / `RuntimeControllerDispatchInput.dispatchEnv`; for broker, it enters through `InvocationDispatchRequest.dispatchEnv`. Not in the compiled spec, not hashed, not a recompile trigger.

For on-disk file credentials, the **credentials** env contribution to this map MAY be empty; the file credential itself lives outside the `harnessEnv` map and outside all hashes/projections, so it does not participate in the disjoint union (Codex v1: empty credentials map, `auth.json` on disk).

A key collision across channels is a **validation error**, never resolved by precedence. `lockedEnv` and `dispatchEnv` MUST be disjoint from the ambient-baseline, credential/capability, and harness-reserved operational key classes; `dispatchEnv` MUST additionally not shadow any `lockedEnv` key. Controlled reserved-key overrides are expressed only through a typed driver-config field.

**Semantic boundary rule.** Anything affecting compiled launch/session shape or reuse compatibility (command/executable, cwd, driver config, transport, model/provider/reasoning, resource/policy, materialization paths, `ASP_HOME`, tool paths, routing flags, typed `pathPrepend`) is compiled hash material. Environment values in that class are `lockedEnv`; PATH mutation uses typed `pathPrepend`, never `lockedEnv.PATH`. `dispatchEnv` carries only per-invocation context/handles/correlation that the harness/tool consumes without changing the compiled runtime shape; a handoff id qualifies only as an opaque non-secret handle (sensitive payloads use an external store, passing only the handle).

### 7.6 Compiler diagnostics

```ts
export type CompileDiagnostic = {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  plane: 'asp-compiler'
  details?: unknown
}
```

If ASP cannot construct a valid broker or embedded-sdk profile, it MUST return diagnostics explaining why. HRC may select a different compiled profile or reject the request. HRC MUST NOT fill in the missing mechanics itself.

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
- process argv/lockedEnv/cwd by patching;
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

Controllers implement mechanics. They do not recompute route policy. `RuntimeControllerStartInput` and `RuntimeControllerDispatchInput` MAY carry `dispatchEnv?: Record<string, string>` as the HRC-owned per-invocation context channel. Broker dispatch MAY also carry `runtime?: InvocationRuntimeContext` for typed HRC-owned resource leases such as `runtime.terminalSurface`. Controllers validate these dispatch-time overlays before use; they are never copied into the compiled profile or hash material.

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
  -> HRC persists CompiledRuntimePlan projection
  -> HRC creates RuntimeOperation(kind='broker_invocation')
  -> HRC starts broker process
  -> HRC sends broker.hello
  -> HRC validates capability intersection
  -> HRC builds InvocationDispatchRequest { startRequest, dispatchEnv?, runtime? }
       (startRequest = selectedProfile.harnessInvocation.startRequest, verbatim)
       (runtime.terminalSurface required for claude-code-tmux/codex-cli-tmux)
  -> HRC (MAY preflight-validate dispatchEnv/runtime)
  -> HRC calls broker invocation.start(envelope)
  -> broker validates dispatchEnv/runtime at dispatch, then merges dispatchEnv at spawn
  -> HRC stores BrokerInvocation
  -> HRC consumes normalized broker events
```

HRC sends an `InvocationDispatchRequest { startRequest, dispatchEnv?, runtime? }` envelope. `startRequest` is forwarded **verbatim** and is the **only hashed payload**; `dispatchEnv` and `runtime` are per-invocation context, hashed nowhere. The broker validates `dispatchEnv` and `runtime` at dispatch (HRC MAY preflight) and merges only `dispatchEnv` into the execution-env disjoint union at spawn (see §7.5.1). Broker `invocation.start` takes the envelope. For `claude-code-tmux` and `codex-cli-tmux`, `runtime.terminalSurface` is required and contains the HRC-owned tmux pane lease. `runtime.tmux.socketPath` is a deprecated boundary shim accepted only during the migration window; if both are present, `runtime.terminalSurface` wins.

The phrase “verbatim” is intentional. If HRC needs a changed `startRequest`, it recompiles; `dispatchEnv` and `runtime` are the only per-invocation channels HRC may vary without recompiling.

### 9.6 EmbeddedSdkController contract

`EmbeddedSdkController` consumes a selected `EmbeddedSdkExecutionProfile` from the compiled plan. It does not build or patch the profile. It runs the SDK in-process inside `hrc-server`; it MUST NOT spawn a harness process, create a callback socket, start a broker, allocate a pty, or expose a terminal surface.

```ts
export interface EmbeddedSdkController extends RuntimeController<RuntimeRouteDecision> {
  readonly kind: 'embedded-sdk'
}
```

Start flow:

```text
HRC receives start/dispatch
  -> HRC calls ASP compileRuntimePlan(...)
  -> HRC selects EmbeddedSdkExecutionProfile
  -> HRC persists CompiledRuntimePlan projection
  -> HRC creates RuntimeOperation(kind='sdk_turn')
  -> HRC passes RuntimeControllerStartInput { selectedProfile, operation, dispatchEnv? }
  -> EmbeddedSdkController validates profile legality and dispatchEnv disjointness
  -> EmbeddedSdkController composes scoped SDK env:
       ambientAllowlist(controllerEnv) ⊎ credentials ⊎ session.lockedEnv ⊎ dispatchEnv
  -> EmbeddedSdkController applies session.pathPrepend to the scoped PATH
  -> EmbeddedSdkController creates or reuses the in-process SDK session
  -> EmbeddedSdkController emits normalized ControllerEventEnvelope events
```

Dispatch flow:

```text
HRC receives input for ready embedded-sdk runtime
  -> HRC validates runtime state/capabilities/input policy
  -> HRC creates RuntimeOperation(kind='sdk_turn')
  -> HRC calls dispatchTurn/deliverInput with RuntimeControllerDispatchInput { input, dispatchEnv? }
  -> EmbeddedSdkController validates input policy and dispatchEnv disjointness
  -> EmbeddedSdkController delivers an SDK turn or rejects/queues according to compiled policy and capability
  -> EmbeddedSdkController emits normalized ControllerEventEnvelope events
```

Stop/dispose semantics:

- `stop` ends the in-process SDK session for the selected runtime and emits `invocation.stopping` followed by `invocation.exited` or `invocation.failed`.
- `dispose` releases controller-owned SDK session state and emits `invocation.disposed`.
- `interrupt` is supported only when the SDK implementation exposes a safe cancellation primitive; otherwise the controller returns unsupported rather than simulating interruption.
- `reconcile` is local to HRC process memory plus persisted runtime state. There is no broker process, callback socket, or child process to reattach after restart.

Output/event contract:

- Embedded SDK controllers emit the same normalized `ControllerEventEnvelope`/`InvocationEventEnvelope` vocabulary as broker controllers: `invocation.*`, `input.*`, `turn.*`, `assistant.message.*`, `tool.call.*`, `usage.updated`, `diagnostic`, `permission.*`, and `continuation.updated` where applicable.
- HRC MUST NOT parse Claude SDK, Pi SDK, or harness-native SDK events outside the controller. The controller maps native SDK output into the normalized envelope and exposes only that envelope at the HRC boundary.
- Tool-only turns are successful content-bearing turns. A native SDK turn that produces tool calls/results but no assistant text MUST emit normalized `tool.call.*` events and a `turn.completed` payload with `producedContent: true`; it MUST NOT be mapped to `empty_response` or `runtime_unavailable` solely because `finalOutput` is empty.
- `empty_response` is reserved for turns that complete without assistant text, tool events, continuation updates, diagnostics that explain a terminal failure, or other normalized content-bearing activity.

### 9.7 Runtime state

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

  terminalSurface?: {
    kind: 'tmux-pane'
    socketPath: string
    sessionId: string
    windowId: string
    paneId: string
    sessionName?: string
    windowName?: string
    reportedAt: string
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
terminal.surface.reported
permission.requested
permission.resolved
```

Assistant message completion is a required harness-agnostic contract. Every natural assistant message before the terminal answer for a turn MUST be emitted as `assistant.message.completed` with `{ final: false }` before the turn terminal. The terminal assistant message for the turn MUST be emitted as `assistant.message.completed` with `{ final: true }` exactly once, before the turn terminal event.

`final` means "terminal assistant message for the turn"; it does not mean "this message item is internally complete." Drivers that learn message completion before turn completion MUST use a held-latest pattern: hold the newest completed natural assistant message as the possible terminal answer, emit the previously held message with `final: false` when another natural assistant message arrives, and flush the held message with `final: true` only when the turn terminal is known. `assistant.message.delta` remains optional streaming evidence; `capabilities.events.assistantDeltas` MUST NOT be overloaded to waive the completed-message requirement.

`terminal.surface.reported` is the canonical v1 event for an attachable terminal surface. For HRC-leased `claude-code-tmux` and `codex-cli-tmux` routes, the payload MUST be `{ kind: 'tmux-pane', socketPath, sessionId, windowId, paneId, sessionName?, windowName? }`. This event is not `driver.notice`, not a launch callback, and not `broker.attach`; it only reports the leased tmux pane for operators and HRC projection. Legacy non-leased routes may continue to report `{ kind: 'tmux-session', socketPath, sessionName, paneId? }` during migration.

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
  subjectDisplayJson: string
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
- Broker/driver emits a bounded display subject (`subjectDisplayJson`); raw native payloads are not persisted by default.

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

HRC continuation vocabulary is provider-facing. Broker and embedded SDK continuation vocabulary is driver/runtime-facing. They are bridged by explicit codecs.

```ts
export type HrcContinuationRef = {
  provider: 'anthropic' | 'openai'
  continuationId: string
  key?: string
}

export type BrokerContinuationRef = {
  provider: string
  kind?: 'thread' | 'session' | 'conversation' | string
  continuationId: string
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

- ASP owns encoding HRC continuation into broker profile/start request or embedded SDK profile continuation metadata.
- Broker owns reporting native continuation updates.
- EmbeddedSdkController owns reporting SDK continuation updates through the normalized `continuation.updated` event and `EmbeddedSdkRuntimeState.sdk.sessionKey`.
- HRC owns adopting reported continuation into session/runtime state only after broker event/status or embedded controller event/state proves it exists.
- HRC persists the opaque `continuationId` (identity only); it omits raw keys by default.
- HRC persists raw continuation keys only where operationally required.
- Embedded SDK `reuse-existing` requires a valid continuation/session key for the selected runtime. If the SDK requires deterministic local session storage, the session key/path is part of the continuation identity and must be validated before reuse.
- A failed embedded SDK turn MUST NOT advance or persist a new continuation unless the normalized controller event stream proves the SDK created a valid continuation.

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
  plan_projection_json TEXT NOT NULL,
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
  capability_resolution_json TEXT,
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
  spec_projection_json TEXT,
  start_request_projection_json TEXT,
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
  projection_status TEXT NOT NULL DEFAULT 'pending',
  projection_error TEXT,
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
  artifact_json TEXT,
  artifact_path TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES runtime_operations(operation_id)
);

CREATE TABLE IF NOT EXISTS permission_decisions (
  permission_request_id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  subject_display_json TEXT NOT NULL,
  default_decision TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT NOT NULL
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

Persist enough compiler projection state and metadata to prove HRC selected an ASP-generated profile and did not synthesize one:

- `plan_hash`
- `compile_id`
- `selected_profile_id`
- `selected_profile_hash`
- `spec_hash`
- `start_request_hash`
- `plan_projection_json` (self-hash fields and ephemeral timestamps omitted by path; MAY carry `lockedEnv`)
- `spec_projection_json` / `start_request_projection_json` (self-hash fields and ephemeral timestamps omitted by path; MAY carry `lockedEnv`)
- `projection_status` / `projection_error`
- `capability_resolution_json`
- compiler diagnostics

`dispatchEnv` is **not** persisted in the contract plane. It carries no compiled-launch-shape semantics, is hashed nowhere, and is at most operational dispatch metadata recorded outside the compiler-closure tables.

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
    | {
        kind: 'harness-broker'
        brokerDriver: string
        brokerProtocol: string
        brokerTerminal?: BrokerTerminalSurface
      }
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
    case 'harness-broker':
      return view.controller.brokerTerminal?.host === 'tmux' ? 'tmux' : 'headless'
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
rg "driver:|spec\.driver|process\.args|process\.lockedEnv|InvocationStartRequest|HarnessInvocationSpec" packages/hrc-server/src \
  -g '!**/runtime-controllers/legacy-exec/**' \
  -g '!**/__tests__/**'
```

The third check needs allowlists for type-only references, validation, and hashing. It must fail on construction/mutation sites. HRC forbidden-mutation checks apply to `startRequest` (including `spec.process.lockedEnv`): HRC MUST NOT construct or mutate it. HRC **owns** `dispatchEnv` (the per-invocation channel) and may set it freely; `dispatchEnv` is never part of `startRequest` and is exempt from these construction/mutation checks.

---

## 17. Route catalog

The route catalog describes valid combinations. HRC route decisions select from compiled profiles and validate against this catalog.

Terminal route hosts include `foreground`, `tmux`, and `ghostty`. Interactive route startup methods include `inherit-current-terminal` for foreground `asp run`; validators narrow host-specific combinations so foreground uses inherited stdio and launch input only, while controller-owned terminal hosts use pty semantics.

The pre-HRC interactive Claude Code and Codex tmux routes use an HRC-owned tmux pane lease, not terminal-controller ownership and not broker-created tmux lifecycle objects. They remain attachable through a tmux pane surface reported by the broker driver, while normalized events come from the broker event stream.

```ts
export const RUNTIME_ROUTE_CATALOG = [
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
] as const
```

Hard exclusions:

- No `openai + claude-code` route.
- No `anthropic + codex` route.
- No SDK runtime under terminal controllers.
- No broker input outside `harness-broker`.
- No `legacy-exec` for new harness behavior.
- No broker-capable Codex headless path through `command-process`.
- No `codex-app-server` broker profile with `interactionMode: 'interactive'`.
- No interactive broker profile without `brokerTerminal.host: 'tmux'`.
- No `claude-code-tmux` or `codex-cli-tmux` broker profile whose `spec.process.harnessTransport.kind` is not `pty`.
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
  driverConfig?: Record<string, unknown>
}
```

Rules:

- HRC owns correlation IDs.
- ASP embeds correlation into compiled profiles.
- HRC-supplied per-invocation correlation/handles reach the harness through `dispatchEnv` (§7.5.1), not by mutating `spec.process.lockedEnv`; `dispatchEnv` is hashed nowhere.
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
- HRC construction/mutation of broker `HarnessInvocationSpec`, driver config, process argv/lockedEnv/cwd, or Codex descriptors.

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
- projection/hash helpers

Acceptance:

- ASP, HRC, and tests import shared contracts.
- No concrete harness driver imports appear in shared contracts.

### Phase 2 — ASP emits `CompiledRuntimePlan`

ASP compiler emits terminal, embedded-sdk, broker, command, and legacy profiles where applicable.

Acceptance:

- Golden plans for Codex headless, Codex terminal, Claude terminal, Claude SDK, Pi SDK.
- Broker profile includes complete `InvocationStartRequest`.
- Plan/profile/spec hashes are stable.
- Plan/profile/spec projection hashes are deterministic and computed by explicit path omission.

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
4. Projection hashes are deterministic; `lockedEnv` is included and changing a `lockedEnv` key or value changes the hash, while `dispatchEnv` is hashed nowhere.
5. Recompilation produces a different hash when process/driver mechanics or `lockedEnv` change; changing only `dispatchEnv` requires no recompile and changes no hash.
6. HRC cannot construct a broker profile in tests without ASP compiler output.
7. INV-14.4 mutation attempts fail tests.

### 20.2 Boundary tests

1. Broker Codex start does not spawn `launch/exec.ts`.
2. Broker Codex dispatch does not spawn `launch/exec.ts`.
3. HRC broker path does not import `spaces-harness-codex`.
4. HRC broker path does not parse Codex JSONL, hook, OTEL, or app-server native events.
5. `LegacyExecAdapter` is the only path allowed to call legacy wrapper.
6. HRC broker path does not assign `spec.driver`, `spec.process.args`, or `spec.process.lockedEnv`. HRC owns `dispatchEnv` and may set it.

### 20.3 Route tests

1. `openai + codex + headless` resolves to `controller: 'harness-broker'` when broker default is enabled.
2. `openai + codex + interactive` with terminal-controller behavior explicitly requested resolves to terminal controller.
3. Pre-HRC `openai + codex + interactive` resolves to `controller: 'harness-broker'` with `codex-cli-tmux`, not terminal.
4. `anthropic + claude-code + nonInteractive` resolves to embedded SDK unless a real broker profile exists.
5. Explicit SDK harnesses do not reuse CLI runtimes.
6. Old `transport` aliases are derived, not route source of truth.
7. Missing required capability rejects before broker start.

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
6. Persisted permission subject is a bounded display subject (`subject_display_json`); raw native payloads are not persisted by default.

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

1. ASP emits versioned, hashable `CompiledRuntimePlan` artifacts; persisted forms are explicit projections that are credential-free and ambient-free by contract (self-hash/timestamp fields omitted by path; `lockedEnv` included, `dispatchEnv` never present).
2. HRC route decisions select execution profiles from compiled plans.
3. Codex headless routes select `controller: 'harness-broker'` by default.
4. **Invariant 14.4 is enforced:** HRC never reconstructs, mutates, patches, infers, or synthesizes broker driver specs, process argv/lockedEnv/cwd, `HarnessInvocationSpec`, `InvocationStartRequest`, Codex app-server descriptors, continuation encoding, or harness-specific config after ASP compilation. HRC's only per-invocation broker channels are `dispatchEnv` and typed `runtime` overlays such as `runtime.terminalSurface`.
5. HRC broker paths do not import Codex harness-driver packages.
6. HRC broker paths do not spawn or reference `launch/exec.ts`.
7. HRC broker paths do not parse Codex stdout, Codex JSONL, or Codex app-server native events.
8. Broker invocation identity, plan hash, selected profile hash, spec hash, start request hash, capabilities, continuation, state, and event sequence are persisted.
9. Broker events are mapped through one idempotent `BrokerEventMapper`.
10. Permission decisions are explicit, audited, default-deny, and persist a bounded display subject.
11. Busy-input behavior is explicit and tested against actual broker capabilities.
12. HRC restart behavior is conservative in v1 and reattachable only after broker attach/replay support exists.
13. Public APIs expose controller/profile/capability fields while deriving old `transport` aliases.
14. Legacy `exec.ts` is feature-gated, isolated, and deleted after Codex broker cutover.
15. Cross-repo boundary checks enforce the intended dependency direction.
16. The compiled spec is **credential-free and ambient-free**: it contains no credential material and no ambient/operator environment.
17. `lockedEnvKeys` ⊆ the resolved declared source (space/agent/target config); ASP never derives `lockedEnv` from `process.env`.
18. `lockedEnv` (keys and values) participates in `specHash`, `startRequestHash`, `profileHash`, `planHash`, and `compatibilityHash`; changing it changes the relevant hashes.
19. `dispatchEnv` is hashed nowhere and is changeable per invocation without recompilation.
20. A `lockedEnv` key colliding with an ambient-baseline, credential/capability, or harness-reserved key is rejected at compile.
21. A `dispatchEnv` key colliding with any other channel (including shadowing a `lockedEnv` key) is rejected at dispatch.

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
