# Proposal: broker lifecycle contract — retention, harness recovery, and guarded turn retry

**Status:** rewritten recommendation for review. This replaces the two-policy shape in `PROPOSAL_harness-lifecycle.md`.

**Scope:** Agent Spaces / ASP compiler plane, HRC runtime control plane, Harness Broker execution plane.

**Position:** adopt idle self-retirement and harness generation fencing now; introduce child-process recovery as process recovery, not semantic retry; keep automatic turn retry disabled unless the driver can prove the retry is safe.

---

## 0. Executive decision

The original proposal identifies a real gap: broker-tmux runtimes can remain resident indefinitely, and a hung or dead harness child currently falls through to coarse HRC zombie/stale recovery. The proposed direction is good, but the contract shape needs to be split into three policies with different owners and different safety properties:

1. **RuntimeRetentionPolicy** — HRC-owned runtime retention policy, implemented by the broker. This covers `keep-alive` and `idle-ttl`. It is safe because it acts only between turns when the invocation is `ready` and the input queue is empty.
2. **HarnessRecoveryPolicy** — broker-owned child-process recovery mechanics, parameterized by HRC policy. This covers harness generations, child exit/stall observation, runner control, process-tree kill, recycle, stale event fencing, and escalation. It does **not** imply replaying a user input.
3. **TurnRetryPolicy** — semantic replay policy for a user turn. This must default to `none`. It may be enabled only for a narrow safe subset where the broker/driver can prove the prior attempt did not complete and did not produce irreversible side effects.

The main correction is policy placement. Lifecycle policy MUST NOT be written by HRC into `HarnessInvocationSpec` or `InvocationStartRequest` after ASP compilation. The current contract’s compiler-closure rule forbids HRC from mutating compiled execution mechanics. Lifecycle policy therefore needs to be either:

- emitted by ASP as part of the compiled profile/start request from explicit compile inputs; or
- passed as an explicit HRC-owned dispatch overlay outside `startRequest`, persisted and hashed separately from the compiled start request.

This proposal chooses the second option for retention, recovery, and retry policy: an explicit **BrokerLifecyclePolicyOverlay** carried on `InvocationDispatchRequest`, outside the compiled `startRequest` hash, with its own audit hash and capability validation. This keeps the ASP/HRC/broker boundary intact and avoids pretending that HRC-authored runtime policy is compiled harness mechanics.

---

## 1. Correct ownership boundary

The boundary should be stated precisely:

> HRC owns the runtime container, broker process, concrete tmux lease, durable state, public lifecycle semantics, policy, reconciliation, and hard reap. The broker owns live harness-child execution below the broker boundary: native protocol handling, soft lifecycle control, child supervision, child recycle, input disposition, permission requests, and normalized events.

The broker MUST NOT allocate or mutate tmux lifecycle objects. It must not run `tmux new-session`, `kill-session`, `kill-server`, `respawn-pane`, `split-window`, or equivalent lifecycle commands. For tmux-backed routes, HRC supplies an already-admitted `runtime.terminalSurface` lease; the broker receives a pane handle with narrow allowed operations.

The broker MAY, when the driver capability and policy allow it:

- send driver-private lifecycle text such as `/quit` through the already-authorized pane input path, provided it is not exposed as user input and does not emit `input.accepted`;
- control a broker-private runner process that HRC launched inside the leased pane;
- signal, kill, or respawn the harness child or direct child process inside the broker-owned execution boundary;
- rotate per-generation hook/control sockets;
- emit lifecycle and recovery events.

HRC MAY hard-reap the tmux lease/container only as a control-plane action: explicit user stop/dispose, clean terminal cleanup after broker events, broker escalation, conservative reconcile, or orphan/zombie backstop. HRC MUST NOT parse native harness protocols, drive native recovery, or synthesize broker process mechanics.

This split is important because “HRC owns the process” is too broad. HRC owns durable process/container authority and hard cleanup. The broker owns live harness-child control while the invocation is active.

---

## 2. Current implementation facts that constrain the design

The existing tmux runtime shape makes child recovery plausible but not yet implemented.

A broker-tmux pane currently runs:

```text
tmux pane
  -> exec bun <tmux-launch-runner> --launch-file <json>
      -> spawn(harness argv, stdio:'inherit')
```

The pane shell is replaced by the Bun runner. The runner then spawns the harness as a child with inherited stdio and mirrors the child’s exit by exiting itself. That mirror-exit behavior is a policy choice, not an unavoidable process model. A respawn-capable runner can keep the pane alive, kill/restart the child, and preserve the tmux lease without using tmux lifecycle commands.

However, current driver `stop()` implementations are not sufficient for idle retirement. `claude-code-tmux.stop()` explicitly does not kill or quit anything; it releases the hook listener and marks itself exited. `codex-cli-tmux.stop()` similarly clears broker-side state without proving the harness exited. Therefore idle retirement cannot be implemented by simply calling today’s `stop()`. It needs a new driver-private retirement path that performs actual graceful harness exit, verifies child/pane state, emits terminal events, and only then marks the invocation exited.

The current event/protocol surface also lacks the fields required for this design. There is no `harnessGeneration` or turn attempt field on the event envelope, no `harness.*` event family, no lifecycle capabilities, and permission decisions are only `allow | deny`. Those are not incidental omissions; they are the seams this proposal must make explicit.

---

## 3. Policy transport: explicit HRC dispatch overlay

### 3.1 Contract addition

Extend the broker dispatch envelope:

```ts
export interface InvocationDispatchRequest {
  startRequest: InvocationStartRequest
  dispatchEnv?: Record<string, string>
  runtime?: InvocationRuntimeContext

  /**
   * HRC-owned runtime lifecycle policy overlay.
   * Not part of InvocationStartRequest.
   * Not part of the compiled startRequest hash.
   * Must be persisted and hash-audited separately by HRC.
   */
  lifecyclePolicy?: BrokerLifecyclePolicyOverlay
}
```

The overlay is not `dispatchEnv`. `dispatchEnv` is per-invocation environment/correlation material. Lifecycle policy is typed control-plane policy. It should be persisted, validated, and audited as policy, not smuggled through environment variables.

```ts
export interface BrokerLifecyclePolicyOverlay {
  schemaVersion: 'harness-broker.lifecycle-policy/v1'

  /** HRC-generated policy identity for audit/debug. */
  policyId: string

  /** Canonical hash of this policy excluding policyHash itself. */
  policyHash: string

  retention: RuntimeRetentionPolicy
  harnessRecovery: HarnessRecoveryPolicy
  turnRetry: TurnRetryPolicy
}
```

HRC MUST persist `policyId`, `policyHash`, and the canonical policy projection before starting the broker invocation. Suggested persistence locations:

- `runtime_operations.lifecycle_policy_json`
- `broker_invocations.lifecycle_policy_json`
- `broker_invocations.lifecycle_policy_hash`
- `runtime_state_json.lifecycle`
- event ledger entries that reference `policyHash`

The existing compiled `startRequestHash` MUST remain the hash of the ASP-compiled start request only. Lifecycle policy changes do not mutate the compiled plan. If a lifecycle change requires different argv/env/cwd/driver config/continuation encoding/native harness mode, it is no longer an overlay and HRC MUST ask ASP to recompile.

### 3.2 Capability validation

HRC SHOULD preflight the lifecycle overlay against broker/driver capabilities from `broker.hello` or driver summaries. The broker MUST validate the overlay at `invocation.start` and reject unsupported policy with a typed error. There must be no silent downgrade from `idle-ttl` to `keep-alive`, from `recycle-child` to no recovery, or from guarded retry to no retry unless HRC explicitly requested fallback behavior.

Add lifecycle capability information to invocation or driver capabilities:

```ts
export interface InvocationLifecycleCapabilities {
  retention: {
    keepAlive: true
    idleTtl: boolean
    retireModes: Array<'driver-retire' | 'process-terminate'>
  }
  harnessRecovery: {
    generations: boolean
    recycle: 'unsupported' | 'in-pane-runner' | 'direct-child'
    processTreeKill: boolean
    healthProbes: Array<'runner-status' | 'driver-status' | 'native-heartbeat'>
    hookSocketRotation: boolean
  }
  turnRetry: {
    supported: boolean
    modes: Array<'none' | 'safe-retry'>
    canProveNoPriorCompletion: boolean
    canFenceExternalSideEffects: boolean
  }
}
```

The broker response should include the effective accepted lifecycle capability and `policyHash` so HRC can persist what was actually accepted.

---

## 4. RuntimeRetentionPolicy

### 4.1 Purpose

Runtime retention controls what happens after a healthy invocation becomes idle. It is not a turn recovery mechanism. It is safe because it runs only between turns.

```ts
export type RuntimeRetentionPolicy =
  | {
      mode: 'keep-alive'
    }
  | {
      mode: 'idle-ttl'
      idleTtlMs: number
      retire: {
        mode: 'driver-retire'
        graceMs: number
        onTimeout: 'fail-invocation' | 'escalate-hard-reap'
      }
    }
  | {
      mode: 'unmanaged'
      reason: 'test-only' | string
    }
```

`keep-alive` keeps the broker/harness resident until explicit HRC stop/dispose or external failure.

`idle-ttl` starts an idle clock only when the invocation is `ready`, no turn is active, no permission request is pending, and the input queue is empty. The idle clock resets on accepted input, turn start, turn terminal event, recovery start, recovery terminal event, and any state transition that makes the invocation non-idle.

`unmanaged` is allowed only for tests or transitional migration code. Production routes should not rely on it.

### 4.2 Broker behavior for idle TTL

When idle TTL expires, the broker initiates graceful retirement:

1. Emit `invocation.stopping{ reason:'idle-ttl' }`.
2. Invoke a driver-private `retire()` path, not the current generic `stop()` unless `stop()` is strengthened to mean actual graceful retirement.
3. The driver sends the harness-native quit/exit mechanism. For Claude tmux this may be `/quit`; for a process-backed driver this may be `SIGTERM` followed by graceful wait; for app-server it may be a native shutdown request.
4. The driver suppresses user-turn accounting. Retirement MUST NOT emit `input.accepted`, `turn.started`, or assistant/tool events.
5. The broker verifies child/process exit or runner retire completion within `graceMs`.
6. Emit `harness.exited{ reason:'idle-retire' }` when a harness child was present.
7. Emit `invocation.exited{ reason:'idle-ttl', droppedContinuation:false }`.
8. Flush events before the broker process exits or before HRC is allowed to reclaim the lease.

If graceful retirement times out:

- `onTimeout:'fail-invocation'` emits `invocation.failed{ reason:'idle-retire-timeout' }` and leaves hard cleanup to HRC’s normal failure/reconcile path.
- `onTimeout:'escalate-hard-reap'` emits `lifecycle.escalation{ reason:'idle-retire-timeout', requestedAction:'hard-reap' }`; HRC may then hard-reap the lease/container.

### 4.3 HRC projection for idle TTL

HRC MUST project `invocation.exited{ reason:'idle-ttl' }` as clean runtime termination, not stale runtime failure.

This must be implemented transactionally, not as a prose preference. Current runtime listing/reconcile paths can observe a bare tmux pane after the broker exits and mark the runtime stale. To prevent that race:

- event ingestion and tmux liveness reconcile MUST coordinate on a per-runtime lock or compare-and-set;
- terminal broker events MUST be projected before liveness-derived stale classification for the same active invocation;
- liveness reconcile MUST re-read runtime state after acquiring the lock and MUST NOT mark stale if a clean terminal event has already been projected or is being projected;
- terminal projection should set runtime state to a clean terminal status and clear active invocation/run references in the same transaction.

Clean idle retirement is an explicit terminal fact from the broker. A later observation that the pane is gone is cleanup confirmation, not evidence of staleness.

---

## 5. HarnessRecoveryPolicy

### 5.1 Purpose

Harness recovery controls child-process health and recovery mechanics. It may restart a child process or restore a ready harness generation, but it does not replay user input by itself.

```ts
export type HarnessRecoveryPolicy =
  | {
      mode: 'none'
    }
  | {
      mode: 'observe'
      reportChildExit: boolean
    }
  | {
      mode: 'recycle-child'
      maxRecoveriesPerInvocation: number
      activeTurnDisposition: 'fail-before-recycle' | 'escalate-only'
      stallDetection: StallDetectionPolicy
      recycle: {
        mechanism: 'capability-selected' | 'in-pane-runner' | 'direct-child'
        killGraceMs: number
        killProcessTree: boolean
        restartFrom: 'latest-continuation'
        requireContinuation: boolean
      }
      onRecoveryFailure: 'fail-invocation' | 'escalate-hard-reap'
    }

export type StallDetectionPolicy =
  | { mode: 'disabled' }
  | {
      mode: 'no-progress-plus-health'
      noProgressMs: number
      minTurnAgeMs?: number
      healthProbe: 'runner-status' | 'driver-status' | 'native-heartbeat'
    }
```

The existing absolute `process.limits.turnTimeoutMs` remains a separate limit: it is an upper bound on turn duration. `no-progress-plus-health` is not the same thing. A silent model/tool phase may be valid. A stall decision MUST combine no progress with a health signal, not merely “no event for N ms.”

### 5.2 Harness generations

A **harness generation** is one spawn of the harness child within one broker invocation. It is distinct from HRC runtime generation/session generation. It is 1-based:

- generation 1: initial harness child;
- generation N+1: child created after recycle.

Generation changes are local to the broker invocation. The runtime lease and invocation identity remain the same unless HRC hard-reaps or starts a new runtime.

The broker MUST track `currentHarnessGeneration`. The event envelope MUST carry `harnessGeneration` for every generation-scoped event once the first harness child has started.

```ts
export interface InvocationEventEnvelope<TPayload = InvocationEventPayload> {
  invocationId: InvocationId
  seq: number
  time: IsoTimestamp
  type: InvocationEventType
  payload: TPayload
  turnId?: TurnId
  inputId?: InputId
  itemId?: string
  correlation?: Record<string, string>
  driver?: { kind: string; rawType?: string }

  /** Broker-owned child generation, not HRC runtime generation. */
  harnessGeneration?: number

  /** Attempt number for the logical turn; 1 when absent/initial. */
  turnAttempt?: number
}
```

Generation fencing is normative:

- Broker drivers MUST drop or downgrade stale state-affecting events from old generations.
- HRC MUST persist current generation and MUST refuse to project stale generation events into the active runtime/turn state.
- Late hooks from an old generation may be stored only as diagnostics, never as active assistant/tool/permission events.
- Per-generation hook sockets or hook attempt IDs SHOULD rotate on recycle. For drivers that cannot rotate hook sockets, recovery MUST remain disabled unless stale-event attribution is otherwise proven.

### 5.3 Recovery state machine

For child exit while no turn is active:

```text
ready + child-exit
  -> harness.exited
  -> if policy allows recycle: harness.recovery.started -> harness.started(new generation) -> invocation.ready
  -> else invocation.failed or lifecycle.escalation
```

For detected stall while a turn is active:

```text
turn_active + stall
  -> turn.stalled
  -> if activeTurnDisposition == fail-before-recycle:
       turn.failed{ reason:'harness-stalled' }
       harness.recovery.started
       recycle child
       harness.started(new generation)
       invocation.ready
     else if activeTurnDisposition == escalate-only:
       lifecycle.escalation
       invocation.failed or hard reap
```

The default active-turn disposition SHOULD be `fail-before-recycle`, not automatic replay. That gives HRC and the caller a truthful terminal state for the failed turn and preserves broker process recovery for future turns.

If a later `TurnRetryPolicy` decides to replay the turn, it does so as a separate semantic layer after the harness recovery layer has produced a valid target generation.

### 5.4 Runner control channel

For tmux-backed drivers, child recycle should be implemented through a broker-private runner control channel rather than pane text or tmux lifecycle commands.

Required runner verbs:

```text
status   -> returns runner pid, child pid, child state, generation, mode
retire   -> graceful child exit followed by runner exit; used for idle TTL
recycle  -> kill child/process tree; spawn replacement child; runner remains alive
shutdown -> emergency runner exit after broker has emitted failure/escalation
```

The control channel MUST be:

- per invocation/runtime;
- not exposed to user code;
- unlink/cleanup-safe;
- generation-aware;
- authenticated or path-confined enough that unrelated local processes cannot issue lifecycle commands;
- observable by the broker for health probing.

The runner’s current mirror-exit behavior should remain the default when no lifecycle policy is active or when the child exits unexpectedly outside a controlled recycle/retire operation. Recovery policy may override mirror-exit only while the broker is explicitly performing recovery.

### 5.5 Process-tree handling

Recycle is not acceptable unless process ownership is modeled. The current runner spawns the child with inherited stdio and no process-group isolation. A robust recycle implementation must define and test:

- whether the harness child is started in its own process group;
- whether process-group signaling breaks terminal foreground behavior;
- how descendants are killed;
- how stubborn children are escalated from graceful signal to hard kill;
- what happens if the child exits while recycle is in progress;
- what happens if the runner dies during recycle;
- how terminal foreground ownership is restored to the new child;
- how hooks/events from killed descendants are fenced.

Until those tests pass, `harnessRecovery.recycle` capability should remain `unsupported` for tmux drivers.

---

## 6. TurnRetryPolicy

### 6.1 Purpose

Turn retry is semantic replay of a user input. It is not merely child-process recovery. It has at-least-once semantics and can duplicate external effects unless heavily constrained.

```ts
export type TurnRetryPolicy =
  | {
      mode: 'none'
    }
  | {
      mode: 'safe-retry'
      maxAttempts: number
      retryOn: Array<'harness-stalled' | 'harness-crashed'>
      requires: {
        noToolCallObserved: true
        noPermissionRequestPending: true
        noPermissionRequestObserved?: true
        noAssistantFinalObserved: true
        noExternalMutationObserved: true
        continuationKnown: true
        driverCanProvePriorTurnIncomplete: true
      }
      identity: {
        inputId: 'same'
        logicalTurnId: 'same'
        turnAttempt: 'increment'
      }
      semantics: 'at-least-once'
      onUnsafe: 'fail-turn'
    }
```

The default MUST be `mode:'none'`.

`safe-retry` is allowed only when all required predicates hold. If any predicate cannot be evaluated, it fails closed and the broker emits `turn.failed` rather than retrying.

### 6.2 Identity model

A retry MUST NOT emit a second `input.accepted`. The input was already accepted.

Use this identity model:

- `inputId` remains stable across attempts;
- logical `turnId` remains stable across attempts for the public/API turn;
- `turnAttempt` increments for each replay attempt;
- `harnessGeneration` identifies which child emitted each event;
- native driver turn IDs, if any, remain driver metadata and should not become the public logical turn ID.

This is better than `priorTurnId/newTurnId` as the primary contract because HRC and public APIs should see one logical user turn with multiple attempts, not several unrelated turns for one accepted input. Attempt-specific facts remain available for audit and debugging.

### 6.3 Retry flow

Only after harness recovery has produced a healthy target generation may turn retry run:

```text
turn_active attempt=1 stalls
  -> turn.stalled
  -> turn.failed? only if retry disabled/unsafe/exhausted
  -> harness.recovery.started
  -> harness.started generation=2
  -> if TurnRetryPolicy safe predicates pass:
       turn.retry{ inputId, turnId, fromAttempt:1, toAttempt:2, fromGeneration:1, toGeneration:2 }
       turn.started{ turnAttempt:2 }
       ... normal turn terminal ...
     else:
       turn.failed{ reason:'harness-stalled', attempt:1, retrySuppressed:true }
       invocation.ready
```

There are two acceptable terminal models when retry is disabled or unsafe:

1. Fail the turn before recovery, then recover the harness for future inputs.
2. Recover the harness, then emit the failed turn terminal if event ordering requires the new harness to be ready first.

The implementation must choose one and keep HRC projection deterministic. The recommended model is fail-turn-before-recycle because it makes the boundary between semantic failure and process recovery explicit.

### 6.4 Initial driver stance

Until proven otherwise:

- `claude-code-tmux`: `TurnRetryPolicy.safe-retry` unsupported.
- `codex-cli-tmux`: `TurnRetryPolicy.safe-retry` unsupported.
- `codex-app-server`: keep existing turn timeout behavior; `safe-retry` unsupported unless app-server protocol can prove no tool/side-effect/finalization and can replay without duplicating state.

This does not block idle TTL or harness recycle. It only prevents conflating process recovery with exactly-once turn semantics.

---

## 7. Event contract additions

### 7.1 New event families

Add these event types:

```ts
export type LifecycleEventType =
  | 'lifecycle.policy.accepted'
  | 'lifecycle.escalation'
  | 'harness.started'
  | 'harness.exited'
  | 'harness.recovery.started'
  | 'harness.recovery.completed'
  | 'harness.recovery.failed'
  | 'turn.stalled'
  | 'turn.retry'
  | 'permission.cancelled'
```

Recommended payloads:

```ts
export interface LifecyclePolicyAcceptedPayload {
  policyId: string
  policyHash: string
  retentionMode: RuntimeRetentionPolicy['mode']
  harnessRecoveryMode: HarnessRecoveryPolicy['mode']
  turnRetryMode: TurnRetryPolicy['mode']
}

export interface LifecycleEscalationPayload {
  reason:
    | 'idle-retire-timeout'
    | 'recycle-failed'
    | 'runner-unresponsive'
    | 'retry-exhausted'
    | 'broker-degraded'
  requestedAction: 'hard-reap' | 'operator-attention'
  harnessGeneration?: number
  inputId?: InputId
  turnId?: TurnId
  turnAttempt?: number
  policyHash?: string
}

export interface HarnessStartedPayload {
  generation: number
  mode: 'initial' | 'recycle'
  mechanism: 'in-pane-runner' | 'direct-child'
  pid?: number
  argvHash?: string
  controlSocketId?: string
}

export interface HarnessExitedPayload {
  generation: number
  reason:
    | 'idle-retire'
    | 'operator-stop'
    | 'crash'
    | 'recycle-kill'
    | 'process-exit'
    | 'runner-exit'
  exitCode?: number | null
  signal?: string | null
}

export interface HarnessRecoveryStartedPayload {
  fromGeneration: number
  reason: 'child-exit' | 'stall' | 'healthcheck-failed'
  activeTurnDisposition: 'fail-before-recycle' | 'escalate-only' | 'none'
}

export interface HarnessRecoveryCompletedPayload {
  fromGeneration: number
  toGeneration: number
  ready: boolean
}

export interface HarnessRecoveryFailedPayload {
  fromGeneration: number
  reason: 'runner-unresponsive' | 'kill-timeout' | 'spawn-failed' | 'continuation-missing'
  requestedAction?: 'hard-reap'
}

export interface TurnStalledPayload {
  inputId: InputId
  turnId: TurnId
  noProgressMs: number
  thresholdMs: number
  healthProbe: 'runner-status' | 'driver-status' | 'native-heartbeat'
  harnessGeneration: number
  turnAttempt: number
}

export interface TurnRetryPayload {
  inputId: InputId
  turnId: TurnId
  fromAttempt: number
  toAttempt: number
  fromHarnessGeneration: number
  toHarnessGeneration: number
  reason: 'harness-stalled' | 'harness-crashed'
  semantics: 'at-least-once'
}

export interface PermissionCancelledPayload {
  permissionRequestId: PermissionRequestId
  reason: 'harness-generation-ended' | 'turn-failed' | 'invocation-stopping'
  harnessGeneration?: number
  turnAttempt?: number
}
```

### 7.2 Existing event extensions

Do not add lifecycle policy or harness generation to `invocation.started`. Current normalizers constrain `invocation.started` to process/controller start facts. Use `lifecycle.policy.accepted` and `harness.started` instead.

Extend existing payloads narrowly:

```ts
export interface InvocationExitedPayload {
  exitCode?: number | null
  signal?: string | null
  reason?: 'idle-ttl' | 'operator-stop' | 'process-exit' | string
  droppedContinuation?: boolean
}

export interface InvocationFailedPayload {
  code: string
  message: string
  retryable: boolean
  reason?:
    | 'idle-retire-timeout'
    | 'harness-stalled'
    | 'stall-unrecoverable'
    | 'runner-degraded'
    | string
}

export interface TurnStartedPayload {
  inputId?: InputId
  turnAttempt?: number
}

export interface TurnFailedPayload {
  code: string
  message: string
  retryable?: boolean
  reason?: 'harness-stalled' | 'retry-unsafe' | 'retry-exhausted' | string
  turnAttempt?: number
  retrySuppressed?: boolean
}
```

For `continuation.updated`, `usage.updated`, assistant/tool events, and permission events, prefer envelope-level `harnessGeneration` and `turnAttempt` over ad hoc payload extensions.

### 7.3 Event normalization changes

The broker event normalizer must be updated before any driver emits the new events or envelope fields. Otherwise generation, policy, and lifecycle payload fields may be stripped. This is a compatibility gate.

Rules:

- Unknown lifecycle events are rejected unless the protocol version advertises them.
- For known lifecycle events, required fields are validated.
- `harnessGeneration` must be positive integer when present.
- `turnAttempt` must be positive integer when present.
- State-affecting event projection must require generation equality when generation is present.

---

## 8. Permission fencing and cancellation

The original proposal suggested resolving old-generation permissions with `permission.resolved{ decision:'cancelled' }`. That conflicts with the current `allow | deny` permission decision contract.

Use a separate cancellation event instead:

```ts
permission.cancelled{
  permissionRequestId,
  reason:'harness-generation-ended',
  harnessGeneration,
  turnAttempt
}
```

Also extend broker-to-client permission request/response correlation:

```ts
export interface PermissionRequestParams {
  invocationId: InvocationId
  turnId?: TurnId
  turnAttempt?: number
  harnessGeneration?: number
  permissionRequestId: PermissionRequestId
  kind: string
  subject: unknown
  defaultDecision: 'allow' | 'deny'
  deadlineMs?: number
}

export interface PermissionDecisionParams {
  invocationId: InvocationId
  permissionRequestId: PermissionRequestId
  decision: 'allow' | 'deny'
  harnessGeneration?: number
  turnAttempt?: number
}
```

HRC persistence should stop treating `permissionRequestId` alone as sufficient identity. Use one of these:

- globally unique permission IDs that encode invocation/generation/attempt; or
- composite uniqueness on `(invocation_id, harness_generation, turn_attempt, permission_request_id)`.

Late decisions for an old generation MUST be rejected or audited as stale. They MUST NOT be delivered to the current generation. If the broker has an internal pending permission promise when the generation is killed, it should complete that internal promise with a safe local denial/default after emitting `permission.cancelled`; it should not send a synthetic `allow`/`deny` to a dead harness and pretend the user decided.

---

## 9. HRC projection and persistence changes

HRC’s broker event mapper is the only place broker events become HRC runtime/run/message state. It needs explicit lifecycle support.

Required projections:

| Broker event | HRC projection |
| --- | --- |
| `lifecycle.policy.accepted` | store accepted policy hash/modes on broker invocation and runtime state |
| `harness.started` | set current harness generation; record generation transition; runtime remains active |
| `harness.exited` | record child-generation terminal; do not terminate runtime by itself |
| `turn.stalled` | record diagnostic and turn state evidence; no runtime terminal by itself |
| `turn.failed{reason:'harness-stalled'}` | terminal failed turn; runtime may become ready after recovery |
| `harness.recovery.completed` | current generation advances; runtime ready if broker says ready |
| `turn.retry` | add attempt record under same logical input/turn; do not create a second accepted input |
| `permission.cancelled` | mark pending permission stale/cancelled; block late decisions |
| `invocation.exited{reason:'idle-ttl'}` | clean runtime termination, not stale |
| `lifecycle.escalation{requestedAction:'hard-reap'}` | HRC may hard-reap after recording broker-requested escalation |

Suggested schema additions:

```sql
ALTER TABLE broker_invocations
  ADD COLUMN lifecycle_policy_hash TEXT,
  ADD COLUMN lifecycle_policy_json TEXT,
  ADD COLUMN current_harness_generation INTEGER DEFAULT 0,
  ADD COLUMN terminal_reason TEXT;

CREATE TABLE broker_harness_generations (
  invocation_id TEXT NOT NULL,
  harness_generation INTEGER NOT NULL,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  exited_at TEXT,
  exit_reason TEXT,
  exit_code INTEGER,
  signal TEXT,
  PRIMARY KEY (invocation_id, harness_generation)
);

CREATE TABLE broker_turn_attempts (
  invocation_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  turn_attempt INTEGER NOT NULL,
  harness_generation INTEGER,
  started_at TEXT,
  terminal_at TEXT,
  terminal_kind TEXT,
  terminal_reason TEXT,
  PRIMARY KEY (invocation_id, turn_id, turn_attempt)
);
```

Existing event idempotence by `(invocationId, seq)` remains necessary but not sufficient. Projection must also enforce generation and attempt rules.

---

## 10. Broker state machine

### 10.1 Invocation-level lifecycle

Invocation states remain container-level:

```text
starting -> ready -> turn_active -> ready
ready -> stopping -> exited
any -> failed
exited/failed -> disposed
```

Add broker-initiated `ready -> stopping` for idle TTL only. Failure paths such as recycle failure or runner degradation may go directly to `failed`; they do not need to pass through `stopping`.

### 10.2 Harness-generation lifecycle

Generation lifecycle is nested under invocation:

```text
none -> harness.started(generation=1)
harness.started(N) -> harness.exited(N)
harness.exited(N) -> harness.started(N+1)   # only recovery recycle
harness.exited(N) -> invocation terminal    # idle retire/crash/no recovery
```

`harness.exited` is not equivalent to `invocation.exited`. A child may exit as part of successful recycle while the invocation remains active.

### 10.3 Input queue rules

During active recovery:

- no queued input may be applied;
- no second `input.accepted` may be emitted for a retried input;
- the active input remains active until a terminal turn event or retry terminal event;
- after fail-before-recycle, the queue may drain only after recovery completes and invocation is ready;
- after escalation/failure, queued inputs are rejected or left for HRC to re-dispatch according to existing public API semantics.

---

## 11. Driver-specific implications

### 11.1 `claude-code-tmux`

Initial supported target:

- retention: `keep-alive`; `idle-ttl` only after implementing real driver-private retire;
- harness recovery: unsupported until runner control channel, process-tree semantics, hook-socket rotation, and generation fencing exist;
- turn retry: unsupported by default.

Required changes before enabling `idle-ttl`:

- implement `retire()` separate from current `stop()` semantics, or strengthen `stop()` and rename the broker-facing lifecycle meaning;
- send `/quit` or equivalent without user-turn accounting;
- close/rotate hook listener safely;
- observe child/runner exit and emit terminal lifecycle events;
- ensure HRC sees clean terminal before liveness reconcile marks stale.

Required changes before enabling recycle:

- runner control channel;
- process group/tree handling;
- per-generation hook socket or equivalent stale hook fence;
- generation-aware event envelope;
- permission cancellation/fencing;
- recovery acceptance tests.

### 11.2 `codex-cli-tmux`

Treat similarly to `claude-code-tmux`. Current `stop()` does not prove process exit. Do not advertise `idle-ttl` or recycle capability until retire/recycle semantics are real.

### 11.3 `codex-app-server`

The existing absolute turn timeout is useful but distinct from no-progress stall detection. Since app-server is not tmux-pane based, recovery may be direct-child or protocol-level. It still needs:

- generation/attempt model;
- clear distinction between child/process recovery and retry;
- permission/event fencing;
- proof of safe retry before enabling automatic replay.

---

## 12. Failure semantics

Be conservative. Recovery mechanisms should preserve truthful state rather than hide uncertainty.

| Failure | Broker behavior | HRC behavior |
| --- | --- | --- |
| Idle retire succeeds | `invocation.exited{reason:'idle-ttl'}` | clean terminate/runtime reclaimed |
| Idle retire times out | `invocation.failed` or `lifecycle.escalation` per policy | failure projection or hard reap |
| Child crashes while ready | recycle if policy allows; else invocation failed/escalation | keep runtime active only if recovery completes |
| Turn stalls | `turn.stalled`; fail active turn or escalate; no replay unless TurnRetryPolicy allows | project failed turn/recovery; no second input |
| Runner unresponsive | `lifecycle.escalation{requestedAction:'hard-reap'}` | hard reap with audit |
| Broker process dies | no broker event; HRC conservative reconcile/orphan handling | stale/orphan handling, not semantic retry |
| HRC restarts | do not assume live attach/replay unless v2 attach contract exists | recover from durable events; reconcile conservatively |
| Late old-generation hook | stale diagnostic only | do not project into active turn |
| Late old-generation permission approval | reject/audit stale | do not deliver to current generation |

---

## 13. Acceptance tests

The contract is not complete until these tests exist.

### 13.1 Compiler closure and policy transport

- HRC starts an invocation with lifecycle policy overlay and proves `startRequest` bytes/hash are unchanged.
- HRC attempts to patch lifecycle fields into `HarnessInvocationSpec`; test rejects this path.
- Broker rejects unsupported lifecycle policy rather than silently downgrading.
- HRC persists lifecycle policy hash separately from compiled start request hash.

### 13.2 Idle TTL

- Ready + empty queue + no permissions triggers idle timer.
- Active turn prevents idle timer.
- Queued input prevents idle timer.
- Pending permission prevents idle timer.
- Idle retire emits `invocation.stopping -> harness.exited -> invocation.exited` and no `input.accepted`.
- HRC projects idle exit as clean terminal even when tmux liveness reconcile runs concurrently.
- If retire times out, HRC does not classify it as clean idle termination.

### 13.3 Harness generations and recycle

- Initial child emits `harness.started{generation:1}`.
- Recycle emits `harness.exited{generation:1}` then `harness.started{generation:2}`.
- Runtime lease identity remains unchanged across recycle.
- HRC current generation advances exactly once.
- Old-generation assistant/tool events are ignored for active projection.
- Old-generation hooks are either impossible through socket rotation or fenced by generation.

### 13.4 Process-tree correctness

- Child with grandchild is killed/recycled without orphaning descendants.
- Stubborn child escalates from graceful signal to hard kill.
- Runner death during recycle produces escalation, not silent hang.
- New child owns the terminal foreground after recycle.
- Broker never uses forbidden tmux lifecycle commands.

### 13.5 Turn retry

- Retry disabled by default: stalled turn fails once; no input replay.
- Retry does not emit a second `input.accepted`.
- Retry uses same `inputId`, same logical `turnId`, incremented `turnAttempt`.
- Retry is suppressed after any tool call, pending permission, assistant final, unknown continuation, or unknown side-effect evidence.
- Retry exhaustion emits terminal failed turn and does not leave queued inputs half-applied.

### 13.6 Permission fencing

- Permission request includes generation/attempt.
- Recycle emits `permission.cancelled` for pending old-generation requests.
- Late decision for old generation is rejected/audited and not delivered to current generation.
- Permission persistence uniqueness prevents collision across generations.

---

## 14. Phased implementation plan

### Phase 0 — spec/data model only

- Add `BrokerLifecyclePolicyOverlay` to `InvocationDispatchRequest`.
- Add lifecycle capability fields.
- Add envelope `harnessGeneration` and `turnAttempt`.
- Add lifecycle/harness/recovery/retry/permission-cancelled event types.
- Add HRC persistence columns/tables for policy hash, current generation, and attempts.
- Update event normalization to preserve and validate new fields.

No driver should advertise new lifecycle capability until Phase 1+ tests pass.

### Phase 1 — idle TTL only

- Implement driver-private `retire()` for tmux drivers.
- Implement broker idle timer in `ready` with empty queue and no pending permissions.
- Emit clean idle terminal events.
- Implement HRC clean terminal projection and reconcile race fence.
- Advertise `retention.idleTtl=true` only for drivers that pass tests.

This phase is high value and low semantic risk.

### Phase 2 — harness generations and recovery without retry

- Implement runner control channel and status/recycle verbs.
- Add process-tree kill/restart semantics.
- Add hook socket rotation or equivalent generation fence.
- Emit harness generation events.
- On stall, emit `turn.stalled`, fail active turn, recycle child, return invocation to ready.
- Keep `TurnRetryPolicy.mode='none'`.

This phase improves resilience without pretending mid-turn replay is exactly-once.

### Phase 3 — guarded retry for proven-safe subset

- Implement retry predicates and fail-closed behavior.
- Add turn attempt projection.
- Enable only for drivers that can prove no prior completion and no side effects.
- Keep default route policy as `none` until production evidence supports safe retry.

### Phase 4 — long-term architectural cleanup

For non-interactive Discord/ariadne-style workloads, prefer a real non-interactive driver or SDK-backed route over an interactive tmux driver. Tmux is useful as a bridge and for operator-visible interactive sessions, but it is a difficult substrate for exactly-once semantics because lifecycle control is UI/text-driven and liveness is inferred.

---

## 15. Contract verdict

Adopt the proposal only after these corrections:

1. Replace the two-policy model with three distinct policies: retention, harness recovery, and turn retry.
2. Move HRC-authored lifecycle policy out of the hashed compiled start spec and into an explicit, separately persisted dispatch overlay; or else require ASP to compile it.
3. Keep HRC’s ownership to durable runtime/container/broker/lease authority and hard reap; keep broker ownership to live harness-child mechanics and event emission.
4. Implement real idle retirement; do not rely on current tmux driver `stop()` behavior.
5. Add first-class harness generations and turn attempts to the protocol and HRC projection model.
6. Use `permission.cancelled` plus generation-aware permission correlation instead of adding `cancelled` to `allow | deny` decisions.
7. Treat child recycle as process recovery. Do not automatically replay user input unless `TurnRetryPolicy.safe-retry` predicates are all proven.
8. Solve the HRC liveness race transactionally so clean idle exits are never projected as stale panes.

With those changes, the contract is sound and aligned with the HRC/broker separation of concerns. Without them, the original proposal blurs compiler closure, overstates retry safety, under-models generation/attempt identity, and risks converting clean lifecycle events into stale runtime failures.
