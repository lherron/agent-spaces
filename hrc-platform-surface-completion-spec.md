# HRC Platform Surface Completion Spec

Status: proposed implementation spec  
Audience: `hrc-core`, `hrc-server`, `hrc-sdk`, `hrc-cli`, `hrc-store-sqlite` maintainers  
Scope: required HRC platform surfaces beyond the ACP-facing semantic runtime core

## 1. Why this exists

`HRC.md` and `HRC_DETAIL.md` already state that HRC, for the systems currently in scope, must include more than the ACP-facing semantic `SessionRef` runtime core. In particular, they call out app-owned sessions, managed `command` / PTY sessions, surface bindings, in-flight input, and legacy local transport bridges as required HRC platform capabilities.

The current implementation covers most of the semantic runtime core, but those platform surfaces are still incomplete. The result is that downstream host-local applications can resolve semantic sessions through HRC, but they cannot yet rely on HRC as the sole owner of long-lived local harness panes and generic command panes. They still need direct tmux knowledge or client-side workarounds.

This document fills in that missing contract. It defines the required HRC platform surface so downstream applications can treat HRC as the only local runtime/session host and can stop treating tmux as a public API.

## 2. Goals

HRC MUST:

1. Expose first-class app-owned managed sessions without requiring synthetic ACP `SessionRef`s.
2. Support two managed session kinds:
   - `harness`: a long-lived interactive coding-agent runtime
   - `command`: a long-lived managed PTY / shell / command pane
3. Provide enough lifecycle and attach/capture/input surface that a downstream app never needs to invoke tmux directly.
4. Preserve the existing ACP-facing semantic runtime core for real `SessionRef` workflows.
5. Make capability detection explicit so downstream apps can decide whether to use HRC or fall back to their own tmux path.
6. Keep tmux behind HRC as implementation detail; returned attach data may describe a tmux attach command, but callers MUST treat it as opaque host-local attach information.
7. Provide a real legacy local text-delivery bridge for migration clients, not only event logging.
8. Keep logic paths standard: stable selector -> active host continuity -> runtime/PTY -> attach/capture/input/interrupt/terminate.

## 3. Non-goals

This spec does not make HRC responsible for:

- project/workflow orchestration above runtime hosting
- ACP routing or `SessionRef -> RuntimePlacement` policy
- app-specific agent assignment policy, layout policy, or UI policy
- message storage, inbox semantics, or presence/lease semantics for coordination apps
- replacing tmux internally; tmux remains the default PTY substrate behind HRC

## 4. Baseline from the current codebase

The current implementation already provides:

- semantic session continuity (`/v1/sessions/resolve`, `/v1/sessions`, `/v1/sessions/by-host/...`)
- runtime ensure and semantic turn dispatch for ACP-style sessions
- attach/capture/interrupt/terminate for existing runtimes
- surface binding APIs
- SDK runtime support for semantic in-flight input
- an app-session metadata table and bulk-apply endpoint
- a local bridge registry plus stale-fence enforcement
- health/status/list diagnostics

The current implementation does **not** yet provide the full platform surface required by the HRC spec:

1. `app_sessions` are only metadata rows keyed by `(app_id, app_session_key)` and pointing to a pre-existing `host_session_id`. They are not first-class managed sessions with their own lifecycle, kind, ensure/attach/capture/input APIs, or context rotation semantics.
2. `EnsureRuntimeRequest` currently requires `hostSessionId` and `intent`, and `validateEnsureRuntimeIntent(...)` explicitly rejects non-interactive runtimes. That is insufficient for generic managed `command` sessions.
3. `HrcRuntimeSnapshot` and `HrcLaunchRecord` currently assume every runtime is a harness runtime with non-null `harness` and `provider`. That does not represent generic managed `command` sessions cleanly.
4. `/v1/attach` and `/v1/capture` are keyed by `runtimeId`, not by app-owned stable selectors.
5. `/v1/surfaces/bind` is keyed by concrete runtime identity only. That is workable for attach-time binding, but it is not enough as the only app-facing ownership model.
6. `/v1/status` currently reports only uptime/paths/counts. It does not expose a capability matrix that lets a caller determine whether HRC can replace direct tmux ownership.
7. `/v1/bridges/local-target` and `/v1/bridges/deliver` manage bridge metadata and stale fences, but delivery currently appends a `bridge.delivered` event instead of injecting text into a live PTY/runtime.
8. The persistence model uses `sessions(host_session_id)` as the parent for runtimes, launches, bridges, and surface bindings. That couples all runtime continuity to ACP semantic sessions and does not cleanly model app-owned managed sessions.

This spec is the delta required to close those gaps.

## 5. Required platform model

### 5.1 Managed session selector

Add a first-class host-local selector:

```ts
type HrcAppSessionRef = {
  appId: string
  appSessionKey: string
}
```

Rules:

- `(appId, appSessionKey)` is a stable host-local selector owned by the consuming app.
- HRC MUST NOT require the consuming app to invent a semantic `SessionRef` for these sessions.
- HRC MAY reuse existing internal storage concepts, but synthetic semantic identifiers MUST NOT appear in the public API, event stream, or error details for app-owned sessions.

### 5.2 Managed session kinds

```ts
type HrcManagedSessionKind = 'harness' | 'command'
```

Semantics:

- `harness` is a long-lived interactive coding-agent runtime. It may support semantic turn dispatch and semantic in-flight input.
- `command` is a long-lived managed PTY session such as a shell or generic command pane. It supports literal input, capture, attach, interrupt, restart, and terminate. It does **not** imply semantic turn dispatch.

### 5.3 Managed session record

```ts
type HrcManagedSessionRecord = {
  appId: string
  appSessionKey: string
  kind: HrcManagedSessionKind
  label?: string
  metadata?: Record<string, unknown>
  activeHostSessionId: string
  generation: number
  status: 'active' | 'removed'
  createdAt: string
  updatedAt: string
  removedAt?: string
}
```

Rules:

- This is the stable app-owned continuity record.
- It points to the currently active concrete host context through `activeHostSessionId`.
- `generation` increments only on semantic reset / `clearContext`.
- A fresh-PTY restart MAY rotate the active concrete context without incrementing `generation`.
- Removal is a lifecycle state of the app-owned session key; it is not identical to terminating its current runtime.

### 5.4 Concrete context continuity for app-owned sessions

App-owned sessions need the same concrete continuity model as semantic sessions:

- stable app-owned selector
- active concrete host context (`hostSessionId`)
- `generation` for semantic reset
- `runtimeId` for the currently bound live runtime or PTY

The key behavioral rule is the same as the semantic core:

- `clearContext` rotates concrete continuity and increments `generation`
- fresh-PTY restart rotates concrete continuity but does **not** increment `generation`

## 6. Runtime model enhancements

The existing runtime model is too harness-specific. HRC MUST support command runtimes as first-class runtime objects.

### 6.1 Recommended public shape

The clean model is a discriminated union:

```ts
type HrcRuntimeCommon = {
  runtimeId: string
  runtimeKind: 'harness' | 'command'
  hostSessionId: string
  generation: number
  launchId?: string
  transport: 'tmux' | 'sdk'
  status: 'launching' | 'ready' | 'idle' | 'busy' | 'stale' | 'dead' | 'terminated'
  tmux?: HrcTmuxBinding
  wrapperPid?: number
  childPid?: number
  lastActivityAt?: string
  createdAt: string
  updatedAt: string
  supportsAttach: boolean
  supportsCapture: boolean
  supportsLiteralInput: boolean
}

type HrcHarnessRuntimeSnapshot = HrcRuntimeCommon & {
  runtimeKind: 'harness'
  harness: HrcHarness
  provider?: HrcProvider
  continuation?: HrcContinuationRef
  harnessSession?: HrcHarnessSessionIdentity
  supportsInFlightInput: boolean
  activeRunId?: string
}

type HrcCommandRuntimeSnapshot = HrcRuntimeCommon & {
  runtimeKind: 'command'
  command: {
    launchMode: 'shell' | 'exec'
    argv?: string[]
    cwd?: string
  }
  supportsInFlightInput: false
}
```

### 6.2 Status semantics

- `harness` runtimes may use `idle` and `busy` with semantic meaning.
- `command` runtimes SHOULD use `ready`, `launching`, `stale`, `dead`, and `terminated`.
- HRC MUST NOT claim semantic `busy` semantics for generic `command` sessions unless it has a real prompt-/protocol-aware detector. A generic shell PTY does not reliably expose semantic busy/idle.

### 6.3 Existing core compatibility

The ACP-facing core may keep its existing harness-oriented API shapes if needed for an incremental migration, but the platform surface for app-owned sessions MUST support command runtimes as first-class citizens.

Preferred implementation:

- generalize `HrcRuntimeSnapshot` and `HrcLaunchRecord` in `hrc-core`
- update store/schema accordingly
- keep old SDK helpers as compatibility wrappers where necessary

## 7. Required HRC platform APIs

The following APIs are required in addition to the ACP-facing core.

### 7.1 App-owned session registry

Canonical endpoints:

```text
POST   /v1/app-sessions/ensure
GET    /v1/app-sessions
GET    /v1/app-sessions/by-key
POST   /v1/app-sessions/remove
POST   /v1/app-sessions/apply
```

#### Ensure

```ts
type HrcCommandLaunchSpec = {
  launchMode?: 'shell' | 'exec'
  argv?: string[]
  cwd?: string
  env?: Record<string, string>
  unsetEnv?: string[]
  pathPrepend?: string[]
  shell?: {
    executable?: string
    login?: boolean
    interactive?: boolean
  }
}

type HrcAppHarnessSessionSpec = {
  kind: 'harness'
  runtimeIntent: HrcRuntimeIntent
}

type HrcAppCommandSessionSpec = {
  kind: 'command'
  command: HrcCommandLaunchSpec
}

type EnsureAppSessionRequest = {
  selector: HrcAppSessionRef
  label?: string
  metadata?: Record<string, unknown>
  spec: HrcAppHarnessSessionSpec | HrcAppCommandSessionSpec
  forceRestart?: boolean
  restartStyle?: 'reuse_pty' | 'fresh_pty'
}

type EnsureAppSessionResponse = {
  session: HrcManagedSessionRecord
  runtimeId?: string
  status: string
}
```

Rules:

- First ensure creates the app-owned session record and a first concrete host context.
- Repeated ensure is idempotent if the current session already satisfies the requested spec.
- `forceRestart` restarts the active runtime/PTY even if healthy.
- `restartStyle: 'reuse_pty'` relaunches in the current concrete host context when possible.
- `restartStyle: 'fresh_pty'` rotates to a fresh concrete host context without incrementing `generation`.
- For `harness`, HRC stores the last applied runtime intent.
- For `command`, HRC stores the last applied command launch spec.

#### Get / list

`GET /v1/app-sessions` supports filters:

```ts
type HrcAppSessionFilter = {
  appId?: string
  kind?: 'harness' | 'command'
  status?: 'active' | 'removed'
  includeRemoved?: boolean
}
```

`GET /v1/app-sessions/by-key` requires `appId` and `appSessionKey`.

#### Remove

```ts
type RemoveAppSessionRequest = {
  selector: HrcAppSessionRef
  terminateRuntime?: boolean
}
```

Rules:

- Removal marks the app-owned session record removed.
- If `terminateRuntime` is omitted, default is `true`.
- Removal MUST close active bridge targets and unbind active surfaces for that session.
- Removal MUST preserve audit history of prior concrete contexts.

#### Apply

`/v1/app-sessions/apply` is a convenience bulk-upsert surface for app-owned sessions.

```ts
type ApplyAppManagedSessionInput = {
  appSessionKey: string
  label?: string
  metadata?: Record<string, unknown>
  spec: HrcAppHarnessSessionSpec | HrcAppCommandSessionSpec
}

type ApplyAppManagedSessionsRequest = {
  appId: string
  sessions: ApplyAppManagedSessionInput[]
  pruneMissing?: boolean
}
```

Rules:

- This endpoint MUST NOT require a pre-existing `hostSessionId`.
- It manages app-owned stable selectors directly.
- `pruneMissing` defaults to `false`.
- If `pruneMissing=true`, HRC removes app-owned sessions for that `appId` that are absent from the payload.
- Removal performed by prune is equivalent to calling `remove` with `terminateRuntime=true`.

### 7.2 App-owned harness session operations

Canonical endpoints:

```text
POST   /v1/app-sessions/turns
POST   /v1/app-sessions/in-flight-input
POST   /v1/app-sessions/clear-context
POST   /v1/app-sessions/interrupt
POST   /v1/app-sessions/terminate
GET    /v1/app-sessions/capture
GET    /v1/app-sessions/attach
POST   /v1/app-sessions/literal-input
```

#### Semantic turn dispatch

```ts
type DispatchAppHarnessTurnRequest = {
  selector: HrcAppSessionRef
  runId: string
  intent?: HrcRuntimeIntent
  input: { text: string }
  fence?: {
    expectedHostSessionId?: string
    expectedGeneration?: number
    followLatest?: boolean
  }
}
```

Rules:

- Valid only for `kind='harness'`.
- If `intent` is omitted, HRC uses the last applied harness intent.
- If there is no current or cached intent, reject with `missing_runtime_intent`.
- Dispatch semantics match the existing semantic-core `dispatchTurn(...)` semantics.

#### Semantic in-flight input

```ts
type SendAppHarnessInFlightInputRequest = {
  selector: HrcAppSessionRef
  runId?: string
  input: { text: string }
  fence?: {
    expectedHostSessionId?: string
    expectedGeneration?: number
  }
}
```

Rules:

- Valid only for `kind='harness'`.
- Must reject when the runtime is not interactive, not healthy, not busy, or does not support semantic in-flight input.
- Must reject stale `hostSessionId`/`generation` fences.

#### Literal input

```ts
type SendLiteralInputRequest = {
  selector: HrcAppSessionRef
  text: string
  enter?: boolean
  fence?: {
    expectedHostSessionId?: string
    expectedGeneration?: number
  }
}
```

Rules:

- Valid for PTY-backed `harness` and `command` sessions.
- This is literal transport injection, not semantic turn dispatch.
- Successful delivery MUST write to the live PTY/runtime, not merely append an HRC event.
- HRC MUST preserve text literally; `enter` is a separate submit action.
- This surface is the generic underlying primitive that legacy local bridge profiles may call.

#### Clear context

```ts
type ClearAppSessionContextRequest = {
  selector: HrcAppSessionRef
  relaunch?: boolean
  reason?: string
  spec?: HrcAppHarnessSessionSpec | HrcAppCommandSessionSpec
}
```

Rules:

- `clearContext` rotates to a fresh concrete host context and increments `generation`.
- If `relaunch=true`, HRC relaunches using the supplied spec or the last applied spec for that app-owned session.
- If `relaunch=true` and no effective spec exists, reject with `missing_runtime_intent` or `missing_session_spec`.

#### Interrupt / terminate / capture / attach

These are the same conceptual operations as the ACP-facing core, but keyed by the app-owned selector.

- `interrupt` attempts cooperative stop; hard mode is optional.
- `terminate` ends the active runtime but keeps the app-owned stable selector.
- `capture` returns current visible text / runtime buffer.
- `attach` returns an opaque host-local attach descriptor.

### 7.3 Command session operations

Command sessions use the same attach/capture/interrupt/terminate/literal-input surfaces as above, plus ensure/remove.

Rules specific to `command` sessions:

- `dispatchTurn` and semantic in-flight input are invalid and MUST reject with `unsupported_capability` or `session_kind_mismatch`.
- `literal-input` is the canonical input surface.
- `capture` is observational PTY capture.
- `interrupt` SHOULD send `Ctrl-C` to the PTY for soft interrupt; hard terminate MAY kill the child process or the tmux session.
- A `command` session MAY default to a login shell when `launchMode='shell'` and no explicit shell executable is provided.

### 7.4 Attach descriptor

Canonical response shape:

```ts
type HrcAttachDescriptor = {
  kind: 'exec'
  argv: string[]
  env?: Record<string, string>
  fence: {
    hostSessionId: string
    generation: number
    runtimeId?: string
  }
}
```

Rules:

- Callers MUST treat `argv` and `env` as opaque host-local attach instructions.
- HRC MAY return a tmux attach command internally, but callers MUST NOT construct tmux commands themselves.
- `attach` MUST work for both app-owned `harness` and `command` sessions when the underlying runtime/PTY is attachable.
- The returned fence is the freshness token for any companion `bindSurface(...)` call.

### 7.5 Surface binding

The existing surface-binding API remains valid, but it MUST work with app-owned sessions via attach descriptors and fences.

Preferred request shape:

```ts
type BindSurfaceRequest = {
  surfaceKind: string
  surfaceId: string
  hostSessionId: string
  generation: number
  runtimeId?: string
  windowId?: string
  tabId?: string
  paneId?: string
}
```

Rules:

- One active `(surfaceKind, surfaceId)` may belong to only one owner at a time.
- Rebinding MUST emit an explicit `surface.rebound` transition.
- `bindSurface(...)` MUST reject stale fences.
- App-owned sessions and semantic sessions share the same concrete surface-binding model.

## 8. Legacy local bridge completion

The local bridge becomes a real compatibility transport, not only a registry + audit event.

### 8.1 Canonical endpoints

```text
POST   /v1/bridges/target
POST   /v1/bridges/deliver-text
POST   /v1/bridges/close
GET    /v1/bridges
```

Existing `/v1/bridges/local-target` and `/v1/bridges/deliver` MAY remain as compatibility aliases during migration, but the canonical contract is the new one.

### 8.2 Target acquisition

```ts
type HrcLocalTransportTargetRequest = {
  selector:
    | { sessionRef: SessionRef }
    | { appSession: HrcAppSessionRef }
    | { hostSessionId: string }
  bridge: 'legacy-agentchat' | string
}

type HrcLocalTransportTarget = {
  bridge: 'legacy-agentchat' | string
  transport: string
  target: string
  hostSessionId: string
  generation: number
  runtimeId?: string
}
```

Rules:

- Returned `transport` and `target` values are opaque HRC bridge coordinates.
- They are not tmux coordinates in disguise.
- Target acquisition MUST fail if the selected session is not eligible for the requested bridge profile.

### 8.3 Text delivery

```ts
type HrcLocalTextDeliveryRequest = {
  bridge: 'legacy-agentchat' | string
  transport: string
  target: string
  text: string
  enter?: boolean
  oobSuffix?: string
  fence?: {
    expectedHostSessionId?: string
    expectedGeneration?: number
  }
}
```

Rules:

- Delivery MUST write to the live PTY/runtime. Event append alone is insufficient.
- `text` is literal text.
- `enter` is a separate submit action.
- `oobSuffix` is appended literally after `text` when supplied.
- HRC MUST reject stale fences and invalidated targets after runtime rotation.
- Delivery is a host-local compatibility transport only. It MUST NOT mutate ACP run planning, continuation ownership, or semantic state merely because text was injected.

### 8.4 Eventing and auditing

A successful delivery SHOULD emit `bridge.delivered`, but the event payload SHOULD contain:

- bridge/profile id
- transport/target id
- `payloadLength`
- `enter`
- `oobSuffixLength`
- `hostSessionId`
- `generation`
- `runtimeId`

The literal delivered text SHOULD NOT be persisted in the event log by default.

## 9. Capability reporting

`GET /v1/status` MUST become the capability-discovery surface.

### 9.1 Required response additions

```ts
type HrcCapabilityStatus = {
  ok: true
  uptime: number
  startedAt: string
  socketPath: string
  dbPath: string
  sessionCount: number
  runtimeCount: number
  apiVersion: string
  capabilities: {
    semanticCore: {
      sessions: boolean
      ensureRuntime: boolean
      dispatchTurn: boolean
      inFlightInput: boolean
      capture: boolean
      attach: boolean
      clearContext: boolean
    }
    platform: {
      appOwnedSessions: boolean
      appHarnessSessions: boolean
      commandSessions: boolean
      literalInput: boolean
      surfaceBindings: boolean
      legacyLocalBridges: string[]
    }
    bridgeDelivery: {
      actualPtyInjection: boolean
      enter: boolean
      oobSuffix: boolean
      freshnessFence: boolean
    }
    backend: {
      tmux: {
        available: boolean
        version?: string
      }
    }
  }
}
```

Rules:

- `status` MUST allow a downstream client to decide whether HRC is usable as a full local session host.
- `actualPtyInjection` MUST be `false` until bridge delivery is real.
- `commandSessions` MUST be `false` until the full command-session surface is shipped.
- If tmux is unavailable or unsupported, `backend.tmux.available` MUST be `false` and HRC MUST report why in logs and, ideally, a diagnostic field.

## 10. Persistence model

The current schema couples runtime continuity to ACP semantic sessions. The final HRC platform surface needs a more general parent identity.

### 10.1 Final-state requirement

`hostSessionId` MUST be a generic concrete host-context key, not a key that can exist only under a semantic ACP session row.

### 10.2 Recommended schema

Preferred final storage model:

1. `semantic_continuities`
   - `(scope_ref, lane_ref) -> active_host_session_id`
2. `app_managed_sessions`
   - `(app_id, app_session_key)` stable selector row
   - `kind`, `label`, `metadata_json`, `active_host_session_id`, `generation`, `status`, timestamps
3. `host_contexts`
   - one row per concrete host continuity instance
   - `host_session_id`, `owner_kind`, `owner_scope_ref`, `owner_lane_ref`, `owner_app_id`, `owner_app_session_key`, `generation`, `status`, `prior_host_session_id`, timestamps
   - optional `last_applied_intent_json`, `last_applied_command_spec_json`, `continuation_json`
4. `runtimes`
   - FK to `host_contexts(host_session_id)`
   - generalized runtime kind / launch metadata
5. `launches`
   - FK to `host_contexts(host_session_id)` and `runtimes(runtime_id)`
6. `surface_bindings`
   - FK to `host_contexts(host_session_id)` and optional `runtimes(runtime_id)`
7. `local_bridges`
   - FK to `host_contexts(host_session_id)` and optional `runtimes(runtime_id)`
8. `events`
   - FK to `host_contexts(host_session_id)` and optional runtime/run rows

### 10.3 Incremental compatibility allowance

For a staged migration, HRC MAY temporarily keep the current semantic `sessions` table and layer app-owned sessions through an internal compatibility translation, **provided that**:

- app-owned public selectors are first-class in the API
- synthetic semantic identifiers never leak publicly
- command sessions are supported fully
- bridge delivery is real
- the final state removes the semantic-session-only FK constraint on runtime continuity

## 11. Error model

Reuse existing HRC error categories where possible. Add the following if needed:

- `unknown_app_session`
- `app_session_removed`
- `session_kind_mismatch`
- `unsupported_capability`
- `missing_session_spec`
- `bridge_target_invalid`
- `bridge_delivery_failed`

Behavioral requirements:

- stale concrete continuity => `stale_context`
- wrong session kind for requested operation => `session_kind_mismatch`
- operation not implemented for that session/runtime => `unsupported_capability`
- no stored spec/intent for relaunch => `missing_session_spec` or `missing_runtime_intent`

## 12. Event model additions

HRC SHOULD add platform-surface events:

- `app_session.created`
- `app_session.updated`
- `app_session.removed`
- `app_session.context_cleared`
- `app_session.runtime_ensured`
- `command.input.accepted`
- `command.interrupt.applied`
- `bridge.delivered`
- `bridge.closed`

Event payload rules:

- include stable selector identity (`appId`, `appSessionKey`) for app-owned sessions
- include `hostSessionId`, `generation`, and optional `runtimeId`
- avoid persisting raw literal input text by default

## 13. CLI surface

`hrc-cli` MUST grow app-owned session commands.

Canonical CLI:

```bash
hrc app-session ensure --app <appId> --key <appSessionKey> --kind harness --intent <intent.json>
hrc app-session ensure --app <appId> --key <appSessionKey> --kind command --spec <command.json>
hrc app-session get --app <appId> --key <appSessionKey>
hrc app-session list [--app <appId>] [--kind harness|command] [--include-removed]
hrc app-session remove --app <appId> --key <appSessionKey>
hrc app-session clear-context --app <appId> --key <appSessionKey> [--relaunch]
hrc app-session attach --app <appId> --key <appSessionKey>
hrc app-session capture --app <appId> --key <appSessionKey>
hrc app-session literal-input --app <appId> --key <appSessionKey> --text "..." [--enter]
hrc app-session interrupt --app <appId> --key <appSessionKey> [--hard]
hrc app-session terminate --app <appId> --key <appSessionKey> [--hard]

hrc bridge target --bridge legacy-agentchat --app <appId> --key <appSessionKey>
hrc bridge deliver --bridge legacy-agentchat --transport <transport> --target <target> --text "..." [--enter] [--oob-suffix "..."]
```

## 14. Security and operational requirements

1. HRC remains Unix-socket local by default.
2. Attach descriptors are opaque host-local commands and MUST NOT require downstream apps to know tmux socket paths.
3. Bridge and literal-input delivery MUST be literal text injection only. HRC MUST NOT reinterpret the payload as shell syntax beyond writing bytes to the PTY and optionally submitting Enter.
4. HRC SHOULD apply a configurable payload-size limit to bridge/literal input and advertise the limit in capabilities or diagnostics.
5. HRC SHOULD redact or avoid persisting raw injected payloads in durable events.
6. Clearing context or removing an app-owned session MUST invalidate old bridge targets.
7. Surface rebind MUST not allow the same active surface identity to appear bound to two sessions simultaneously.

## 15. Implementation plan by package

### 15.1 `hrc-core`

Required work:

- add `HrcAppSessionRef`, managed-session request/response types, command-session spec types, new status capability type
- add new HTTP DTOs for `/v1/app-sessions/*` and canonical bridge endpoints
- either generalize `HrcRuntimeSnapshot` / `HrcLaunchRecord` or add platform-specific unions/types that can represent command runtimes
- add error codes if introduced

### 15.2 `hrc-store-sqlite`

Required work:

- add schema support for app-owned managed sessions as stable selectors, not just metadata rows pointing at a pre-existing semantic `host_session_id`
- add final-state or staged support for generic host-context ownership beyond semantic sessions
- update bridge and surface-binding FKs if the parent context table changes
- add repository methods for app-owned ensure/get/list/remove/apply/clear-context flows

### 15.3 `hrc-server`

Required work:

- implement `/v1/app-sessions/*`
- implement real PTY delivery for literal input and bridge delivery
- implement command-session launch/restart/attach/capture/interrupt/terminate flows
- implement app-owned harness dispatch/in-flight flows keyed by `HrcAppSessionRef`
- extend `/v1/status` capability reporting
- maintain compatibility aliases for old bridge endpoints during migration

### 15.4 `hrc-sdk`

Required work:

- add typed methods for app-owned session ensure/get/list/remove/attach/capture/literal-input/interrupt/terminate/clear-context
- add bridge target/deliver-text methods using the canonical shapes
- expose capability status strongly enough for downstream fallback logic

### 15.5 `hrc-cli`

Required work:

- add `app-session` subcommands
- add canonical `bridge target` and `bridge deliver` subcommands
- preserve existing semantic session commands unchanged

## 16. Acceptance criteria

The implementation is complete when all of the following are true.

### 16.1 App-owned harness sessions

1. A caller can create/ensure a `harness` app-owned session with only `(appId, appSessionKey)` plus a runtime intent.
2. The caller can attach, capture, interrupt, terminate, clear context, and relaunch that session without knowing tmux details.
3. Semantic turn dispatch and semantic in-flight input work through the app-owned selector.
4. Fresh-PTY restart rotates concrete continuity without incrementing `generation`.
5. `clearContext` rotates concrete continuity and increments `generation`.

### 16.2 Command sessions

1. A caller can create/ensure a `command` app-owned session with only `(appId, appSessionKey)` plus a command spec.
2. The caller can send literal input, capture output, attach, interrupt, terminate, and restart that session without knowing tmux details.
3. Literal input actually changes PTY state and is observable via capture.
4. `dispatchTurn` against a `command` session rejects with a specific kind/capability error.

### 16.3 Bridge delivery

1. A caller can acquire an opaque local bridge target for an eligible session.
2. Delivering text to that target injects text into the live PTY/runtime.
3. `enter` and `oobSuffix` are supported.
4. Stale fences and invalidated targets are rejected.
5. Clearing context invalidates older targets.

### 16.4 Capability reporting

1. `GET /v1/status` exposes whether app-owned sessions, command sessions, and real bridge delivery are available.
2. A downstream caller can decide whether HRC is sufficient to replace direct tmux ownership using only `status`.

### 16.5 Surface binding

1. Attach-side surface binding works for app-owned sessions using attach-descriptor fences.
2. Rebinding a reused surface emits explicit rebind events and preserves uniqueness.

## 17. Explicit source-file deltas

This section is intentionally concrete for the implementation team.

### `packages/hrc-core/src/contracts.ts`

Needs:

- first-class app-owned managed selector/type definitions
- managed-session kind support
- runtime model able to represent `command` sessions
- status capability model additions

### `packages/hrc-core/src/http-contracts.ts`

Needs:

- canonical `/v1/app-sessions/*` DTOs
- canonical bridge target/deliver-text DTOs
- `/v1/status` capability DTO additions
- current `ApplyAppSessionsRequest` must stop requiring `hostSessionId`

### `packages/hrc-server/src/index.ts`

Needs:

- real implementation of app-owned session ensure/get/list/remove/apply
- real command-session lifecycle surface
- app-owned harness dispatch keyed by app-owned selector
- literal PTY delivery and bridge delivery implementation
- capability-rich status response
- compatibility aliases for old bridge endpoints if retained

### `packages/hrc-server/src/agentchat-bridge.ts`

Needs:

- canonical bridge target/deliver-text request support
- `enter` and `oobSuffix` support
- no assumption that bridge delivery is only `text`

### `packages/hrc-store-sqlite/src/migrations.ts`

Needs:

- schema support for app-owned managed sessions as first-class continuity rows
- generalized host-context parent model or staged compatibility equivalent
- runtime/launch/bridge/surface tables no longer constrained to semantic-session-only parents

### `packages/hrc-store-sqlite/src/repositories.ts`

Needs:

- repositories for app-owned ensure/get/list/remove/apply/clear-context
- repository changes to runtime/launch lookup if the parent context model changes
- bridge invalidation / surface unbind helpers on context rotation/removal

### `packages/hrc-sdk/src/client.ts`

Needs:

- typed app-owned session methods
- typed canonical bridge methods
- typed capability status support

### `packages/hrc-cli/src/cli.ts`

Needs:

- `app-session` command family
- canonical bridge commands

## 18. Recommended delivery order

1. Extend `/v1/status` capability reporting.
2. Implement real bridge delivery and canonical bridge endpoint shape.
3. Ship app-owned managed-session registry and ensure/get/list/remove/apply.
4. Ship `command` session lifecycle and literal-input surface.
5. Ship app-owned `harness` dispatch/in-flight surfaces.
6. Complete CLI/SDK coverage.
7. Remove or deprecate compatibility-only assumptions that app sessions are metadata rows bound to an existing semantic `hostSessionId`.

## 19. Final implementation invariant

After this work lands, a host-local application that wants HRC to own its local runtime panes MUST be able to do all of the following without invoking tmux directly:

- create stable app-owned session keys
- ensure long-lived harness and command sessions
- attach and capture them
- send semantic turns to harness sessions
- send literal text to command sessions and compatibility bridges
- interrupt, terminate, restart, and clear context
- discover capability support up front

That is the threshold at which HRC becomes a complete local runtime host rather than a semantic-session runtime helper with partial platform shims.
