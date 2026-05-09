Confirmed — I still have the relevant source context from `agent-spaces`. This plan is based on the accepted input-admission proposal plus the current implementation shape in the uploaded source.

# Implementation plan: ACP input admission in `agent-spaces`

## 0. Design target

The implementation should not start by “adding steering.” It should start by making ACP admission durable and linearizable.

The target invariant:

```text
Inbound ACP input
  -> durable InputAttempt
  -> immutable admission decision
  -> current mutable state
  -> one of:
       started_run
       queued_run
       accepted_in_flight
       admission_pending
       rejected
```

Default behavior:

```text
ordinary input / omitted intent -> new_work
idle SessionRef                 -> start a run
busy SessionRef                 -> queue a future run
explicit contribution intent    -> attempt active-run contribution
control intent                  -> interrupt/cancel/pause, never text input
```

The hard correctness rules:

```text
1. No accepted input is lost.
2. No input is semantically duplicated after retry or timeout.
3. FIFO admission is linearizable per canonical {scopeRef, laneRef}.
4. HRC runtime_busy is not surfaced as a failed ACP run.
5. HRC delivery ambiguity becomes admission_pending, not fallback-to-queue.
6. accepted_in_flight means “accepted by delivery layer,” not “applied by model.”
7. Literal tmux/terminal input is not semantic active-run contribution.
```

## 1. Current source reality

The main seam is that ACP currently conflates **input attempt**, **run creation**, and **dispatch**.

The obvious entry points are:

```text
packages/acp-server/src/handlers/inputs.ts
packages/acp-server/src/handlers/interface-messages.ts
```

Both create an `InputAttempt`, get a `Run`, and then launch immediately.

The coupling exists in the stores:

```text
packages/acp-server/src/domain/input-attempt-store.ts
packages/acp-state-store/src/repos/input-attempt-repo.ts
```

Both currently require a `RunStore` when creating an attempt. SQLite also enforces this coupling:

```text
packages/acp-state-store/src/open-store.ts
```

Current schema:

```sql
input_attempts.run_id TEXT NOT NULL
```

That must change. An input can be rejected, accepted as active-run contribution, or admission-pending without creating a new run.

Current run status is also too narrow:

```ts
'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
```

Add `queued`. Do not add `admission_pending` to `Run.status`; that is input/application state, not run state.

HRC already has in-flight input, but it is the wrong shape for this design:

```text
packages/hrc-sdk/src/types.ts
packages/hrc-sdk/src/client.ts
packages/hrc-server/src/index.ts
```

Current HRC in-flight request is effectively:

```ts
{
  runtimeId: string
  runId: string
  prompt: string
}
```

That lacks ACP correlation:

```text
inputAttemptId
inputApplicationId
idempotencyKey
selector/fence semantics
durable delivery ledger
query/reconciliation path
```

Provider capability is also inconsistent. HRC currently has provider-name-based SDK capability, while Claude and Codex harness metadata report `supportsInFlightInput: false`. Treat all active-run contribution as disabled until richer capability plus smoke tests exist.

## 2. Add core ACP model types

Add:

```text
packages/acp-core/src/models/input-admission.ts
```

Recommended types:

```ts
export type InputIntent =
  | { kind: 'new_work' }
  | {
      kind: 'contribute_to_active_run'
      fallback: 'queue' | 'reject' | 'pending_only'
      contributionSemantics?: 'append_context' | 'interrupt_and_continue'
    }
  | {
      kind: 'control_active_run'
      action: 'interrupt' | 'cancel' | 'pause'
      fallback?: 'reject'
    }

export type InputAdmissionKind =
  | 'started_run'
  | 'queued_run'
  | 'accepted_in_flight'
  | 'admission_pending'
  | 'rejected'

export type InputQueueStatus =
  | 'queued'
  | 'leased'
  | 'dispatching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'

export type InputApplicationStatus =
  | 'pending'
  | 'accepted'
  | 'applied'
  | 'failed'
  | 'ambiguous'
  | 'cancelled'

export type InputResetPolicy =
  | 'follow_latest'
  | 'expire_on_generation_change'
  | 'pin_generation'
```

Update:

```text
packages/acp-core/src/models/run.ts
```

to:

```ts
export type RunStatus =
  | 'queued'
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
```

Use them as:

```text
queued    = durable future run waiting behind active/earlier work
pending   = selected for dispatch, launch resolving, or dispatch in progress
running   = HRC accepted and ACP has hrcRunId/runtime context
completed = terminal success
failed    = terminal failure
cancelled = terminal cancellation
```

## 3. Migrate ACP state store

Current ACP SQLite schema is inline in:

```text
packages/acp-state-store/src/open-store.ts
```

This cannot be handled with simple `ALTER TABLE ADD COLUMN`, because two changes require table rebuilds:

```text
runs.status CHECK must include queued
input_attempts.run_id must become nullable
```

Introduce a proper migration table now, or implement explicit idempotent rebuild helpers. The current `migrateLegacySchema` approach is not enough for loosening `NOT NULL` and changing a `CHECK`.

Minimum schema changes:

```sql
-- runs: rebuild table with expanded status set
status TEXT NOT NULL CHECK (
  status IN ('queued', 'pending', 'running', 'completed', 'failed', 'cancelled')
);

-- input_attempts: rebuild table with nullable run_id
run_id TEXT;
```

Keep the column name `run_id` for compatibility, but reinterpret it as “associated/target run,” not necessarily “new run created for this input.”

For new work:

```text
input_attempts.run_id = created run
```

For active-run contribution:

```text
input_attempts.run_id = target active ACP run, when known
```

For rejection without target:

```text
input_attempts.run_id = null
```

Add new ACP state tables:

```sql
CREATE TABLE input_admissions (
  input_attempt_id TEXT PRIMARY KEY,
  admission_kind TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  original_response_json TEXT NOT NULL,
  current_state_json TEXT,
  run_id TEXT,
  input_application_id TEXT,
  queue_item_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (input_attempt_id) REFERENCES input_attempts(input_attempt_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE TABLE input_applications (
  input_application_id TEXT PRIMARY KEY,
  input_attempt_id TEXT NOT NULL,
  target_run_id TEXT,
  hrc_run_id TEXT,
  host_session_id TEXT,
  generation INTEGER,
  runtime_id TEXT,
  status TEXT NOT NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (input_attempt_id) REFERENCES input_attempts(input_attempt_id),
  FOREIGN KEY (target_run_id) REFERENCES runs(run_id)
);

CREATE TABLE input_queue (
  queue_item_id TEXT PRIMARY KEY,
  input_attempt_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  scope_ref TEXT NOT NULL,
  lane_ref TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  reset_policy TEXT NOT NULL,
  expected_host_session_id TEXT,
  expected_generation INTEGER,
  not_before_at TEXT,
  leased_at TEXT,
  lease_owner TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_ref, lane_ref, seq),
  FOREIGN KEY (input_attempt_id) REFERENCES input_attempts(input_attempt_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE TABLE session_admission_sequence (
  scope_ref TEXT NOT NULL,
  lane_ref TEXT NOT NULL,
  next_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_ref, lane_ref)
);
```

Add repositories:

```text
packages/acp-state-store/src/repos/input-admission-repo.ts
packages/acp-state-store/src/repos/input-application-repo.ts
packages/acp-state-store/src/repos/input-queue-repo.ts
packages/acp-state-store/src/repos/session-admission-sequence-repo.ts
```

Expose them from:

```text
packages/acp-state-store/src/open-store.ts
```

Also add matching in-memory/domain stores for test fixtures:

```text
packages/acp-server/src/domain/
```

## 4. Decouple `InputAttempt` from `Run`

Change current input attempt creation so it does not create a run implicitly.

Current conceptual shape:

```ts
createAttempt({
  sessionRef,
  content,
  actor,
  runStore,
  ...
})
```

New shape:

```ts
createAttempt({
  sessionRef,
  taskId,
  idempotencyKey,
  content,
  actor,
  metadata,
  associatedRunId,
})
```

Add explicit association:

```ts
associateRun(inputAttemptId: string, runId: string): InputAttempt
```

On idempotent replay, return the original immutable admission plus current state:

```ts
{
  inputAttempt,
  originalAdmission,
  currentState
}
```

Do not recompute admission on replay. A retry must not observe a changed busy/idle condition and make a different decision.

This is important for cases like:

```text
first request  -> queued_run
later retry    -> first run has completed
wrong behavior -> recompute and start immediately
right behavior -> return original queued_run + currentState
```

## 5. Add `InputAdmissionService`

Add:

```text
packages/acp-server/src/input-admission/input-admission-service.ts
```

This becomes the only place that decides input fate.

Suggested dependency shape:

```ts
export type InputAdmissionServiceDeps = {
  runStore: RunStore
  inputAttemptStore: InputAttemptStore
  inputAdmissionStore: InputAdmissionStore
  inputApplicationStore: InputApplicationStore
  inputQueueStore: InputQueueStore
  sessionAdmissionSequenceStore: SessionAdmissionSequenceStore

  runtimeResolver?: RuntimeResolver
  launchRoleScopedRun?: LaunchRoleScopedRun
  hrcClient?: AcpHrcClient

  authorize?: InputAdmissionAuthorizer
}
```

### New-work algorithm

```ts
async function admitNewWork(input) {
  // Transaction 1:
  // 1. Dedupe by {scopeRef, laneRef, idempotencyKey}.
  // 2. If replay, return existing originalAdmission + currentState.
  // 3. Create InputAttempt.
  // 4. Reserve per-session admission seq.
  // 5. Check same-session ACP busy state.
  // 6. Create Run(status='pending' or 'queued').
  // 7. Associate InputAttempt -> Run.
  // 8. Create InputAdmission.
  // 9. If busy, create InputQueue row.

  // Outside transaction:
  // 10. If status='pending' and dispatch=true, call launcher.
  // 11. Finalize run/admission current state.
}
```

Busy should mean any of:

```text
same SessionRef has ACP run status pending/running
same SessionRef has queue item queued/leased/dispatching
HRC reports an active runtime/run for that SessionRef
```

The ACP state check is primary. HRC state is advisory confirmation.

Do not hold a SQLite transaction open while calling HRC or `launchRoleScopedRun`.

The linearization point is the transaction that creates the `InputAttempt`, reserves the session sequence, and creates either a `pending` or `queued` run. A second request for the same `{scopeRef, laneRef}` must observe the first as `pending` before the first HRC dispatch has started.

In SQLite, use the existing transaction wrapper, but ensure the transaction begins with write intent. The point is to make sequence reservation and busy-state observation atomic per session.

### Active-run contribution algorithm

Only implement after queue-only admission works.

```ts
async function admitContribution(input) {
  // Transaction 1:
  // 1. Dedupe.
  // 2. Create InputAttempt.
  // 3. Resolve target active ACP run if known.
  // 4. Create InputApplication(status='pending').
  // 5. Create InputAdmission(kind='admission_pending').

  // Outside transaction:
  // 6. Call HRC active-run contribution endpoint with:
  //      inputAttemptId
  //      inputApplicationId
  //      idempotencyKey
  //      selector/fence
  //      expected active HRC run id

  // Transaction 2:
  // 7. Finalize as:
  //      accepted_in_flight
  //      rejected + fallback queue
  //      rejected
  //      admission_pending
}
```

Critical rule:

```text
transport timeout / ambiguous HRC result -> admission_pending
```

Do not fallback to queue after ambiguity. HRC may already have accepted the input.

### Control algorithm

For:

```ts
{ kind: 'control_active_run', action: 'interrupt' | 'cancel' | 'pause' }
```

route to explicit HRC control semantics. Never treat control as text input, never queue it as work.

## 6. Replace current handler logic

Patch all current input producers to go through `InputAdmissionService`.

Primary:

```text
packages/acp-server/src/handlers/inputs.ts
packages/acp-server/src/handlers/interface-messages.ts
```

Secondary but important:

```text
packages/acp-server/src/handlers/coordination-messages.ts
packages/acp-server/src/integration/wake-dispatcher.ts
packages/acp-server/src/handlers/admin-jobs.ts
packages/acp-server/src/jobs/dispatch-step.ts
```

For `/v1/inputs`, preserve backward-compatible fields for default new work:

```json
{
  "inputAttempt": {},
  "run": {},
  "admission": {
    "kind": "started_run",
    "inputAttemptId": "...",
    "runId": "..."
  },
  "currentState": {}
}
```

For queued work:

```json
{
  "inputAttempt": {},
  "run": {
    "runId": "...",
    "status": "queued"
  },
  "admission": {
    "kind": "queued_run",
    "queueItemId": "...",
    "runId": "..."
  },
  "currentState": {
    "queueStatus": "queued"
  }
}
```

For active-run contribution:

```json
{
  "inputAttempt": {},
  "targetRun": {},
  "admission": {
    "kind": "accepted_in_flight",
    "inputApplicationId": "..."
  },
  "currentState": {
    "applicationStatus": "accepted"
  }
}
```

Old clients such as:

```text
packages/acp-cli/src/commands/send.ts
```

assume `response.run.runId`. That remains true for default `new_work`. Future CLI contribution flags must handle the no-new-run response shape explicitly.

### Preserve `dispatch:false`

Current tests expect `dispatch:false` to create a pending run but not call the launcher. Preserve that behavior through admission:

```text
dispatch:false
  -> create InputAttempt
  -> create Run(status='pending')
  -> create InputAdmission(kind='started_run' or 'admitted_run'; prefer started_run only if compatible)
  -> do not call launcher
```

The cleanest API distinction would be `admitted_run`, but the accepted proposal did not require it. For compatibility, keep `run.status = pending` and include `currentState.dispatchHeld = true`.

Do not bypass admission just because dispatch is false.

### Interface messages

`/v1/interface/messages` currently writes a human conversation turn and dispatches. Keep writing the human turn immediately, but make it idempotent with admission.

Use the request `idempotencyKey` or source `messageRef` to prevent duplicate human turns on retry.

For queued interface messages, preserve source metadata so later assistant delivery still correlates to the right gateway/thread.

### Attachments

For queued work, materialize stable attachment references at admission time. Do not depend on later availability of gateway attachment URLs.

For active-run contribution, reject or fallback unless HRC capability explicitly says attachments are supported.

## 7. Add input queue dispatcher

Add:

```text
packages/acp-server/src/integration/input-queue-dispatcher.ts
```

Wire it in:

```text
packages/acp-server/src/cli.ts
```

near the existing wake/interface dispatchers.

Do not merge this with `interface-run-dispatcher`. The existing interface dispatcher should keep reconciling assistant deliveries. It should not own admission, queue leasing, or run selection.

Queue dispatcher behavior:

```text
1. Poll queue items ordered by scope_ref, lane_ref, seq.
2. For each SessionRef, lease only the head queued item.
3. Skip if same SessionRef has pending/running ACP run.
4. Skip if HRC reports active run for same SessionRef.
5. Mark queue item dispatching.
6. Mark run pending.
7. Resolve launch intent.
8. Capture dispatch fence according to resetPolicy.
9. Call launchRoleScopedRun.
10. Mark queue item running/completed/failed as appropriate.
```

Reset policy defaults:

```text
ordinary new_work           -> follow_latest
contribution fallback queue -> expire_on_generation_change
explicit pinned input       -> pin_generation
```

On HRC `runtime_busy`:

```text
do not fail the run
release/requeue with backoff
preserve FIFO position
```

On fence mismatch:

```text
follow_latest              -> re-resolve latest and retry
expire_on_generation_change -> expire queue item
pin_generation              -> expire/fail explicitly
```

Important hidden risk: HRC dispatch itself is not fully idempotent by ACP run ID today. `real-launcher.ts` passes `ACP_RUN_ID` and `ACP_INPUT_ATTEMPT_ID` through environment, but HRC does not appear to persist those as unique dispatch correlation keys.

So before enabling aggressive retry after launch timeout, add one of:

```text
A. HRC dispatch correlation keyed by ACP run ID, or
B. queue item state dispatch_pending + reconciliation from HRC events.
```

Do not blindly retry ambiguous HRC dispatch. That can duplicate provider work.

## 8. Add HRC contribution as a new API

Keep legacy:

```text
POST /v1/in-flight-input
```

for compatibility, but do not make ACP depend on it.

Add new contracts in:

```text
packages/hrc-core/src/contracts.ts
packages/hrc-core/src/http-contracts.ts
packages/hrc-sdk/src/types.ts
packages/hrc-sdk/src/client.ts
```

Suggested request:

```ts
export type HrcActiveRunContributionRequest = {
  selector: {
    sessionRef?: {
      scopeRef: string
      laneRef: string
    }
    hostSessionId?: string
    runtimeId?: string
  }

  expectedRunId?: string

  fences?: {
    expectedHostSessionId?: string
    expectedGeneration?: number
    followLatest?: boolean
  }

  inputAttemptId: string
  inputApplicationId: string
  idempotencyKey?: string

  prompt: string
  inputType?: 'human' | 'system' | 'tool'
  semantics?: 'append_context' | 'interrupt_and_continue'
}
```

Suggested response:

```ts
export type HrcActiveRunContributionResponse = {
  status: 'accepted' | 'duplicate' | 'rejected' | 'pending'
  inputApplicationId: string

  hostSessionId?: string
  generation?: number
  runtimeId?: string
  runId?: string

  capability?: ActiveRunContributionCapability
  pendingTurns?: number

  errorCode?: string
  errorMessage?: string
}
```

Add richer capability:

```ts
export type ActiveRunContributionCapability = {
  supported: boolean

  deliverySemantics?:
    | 'same_turn_append'
    | 'interrupting_steer'
    | 'next_iteration'
    | 'sequential_followup'

  ackSemantics?: 'accepted_only' | 'observed_applied'
  ordering?: 'fifo' | 'provider_defined'
  maxPending?: number
  supportsAttachments?: boolean
  canInterruptTools?: boolean
}
```

Keep legacy boolean as projection only:

```ts
supportsInFlightInput = activeRunContribution.supported
```

ACP admission must use the rich capability object, not the boolean.

## 9. Add HRC delivery ledger

HRC store currently lives in:

```text
packages/hrc-store-sqlite/src/migrations.ts
packages/hrc-store-sqlite/src/repositories.ts
```

Add migration:

```sql
CREATE TABLE active_input_deliveries (
  input_application_id TEXT PRIMARY KEY,
  input_attempt_id TEXT NOT NULL,
  idempotency_key TEXT,
  host_session_id TEXT,
  generation INTEGER,
  runtime_id TEXT,
  run_id TEXT,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Add repository methods:

```ts
createPending(...)
getByInputApplicationId(...)
markAccepted(...)
markRejected(...)
markAmbiguous(...)
markFailed(...)
```

New HRC handler behavior:

```text
1. Resolve selector to current runtime.
2. Validate fence.
3. Require runtime.activeRunId.
4. If expectedRunId provided, require match.
5. Check active-run contribution capability.
6. Check ledger by inputApplicationId.
7. If already accepted, return duplicate/same accepted response.
8. Insert pending ledger row before provider call.
9. Call provider contribution method.
10. Mark accepted/rejected/pending/ambiguous.
11. Emit correlation-rich lifecycle event.
```

Do not preserve the old behavior where “latest run matches but no active run” can still return accepted. For the new API:

```text
no active run -> rejected
```

Add reconciliation endpoint:

```text
GET /v1/active-run-contributions/:inputApplicationId
```

ACP needs this for `admission_pending` recovery after timeout.

## 10. Provider implementation: enable conservatively

Current AgentSpaces in-flight behavior is in:

```text
packages/agent-spaces/src/client.ts
packages/agent-spaces/src/run-tracker.ts
packages/agent-spaces/src/types.ts
```

The current behavior appends a synthetic user message and chains `session.sendPrompt(...)`. That is useful, but it is not guaranteed same-turn steering.

Advertise it as:

```ts
{
  supported: true,
  deliverySemantics: 'sequential_followup',
  ackSemantics: 'accepted_only',
  ordering: 'fifo',
  supportsAttachments: false
}
```

Add `inputApplicationId` and `idempotencyKey` to AgentSpaces contribution requests. Store accepted application IDs in the active run context so retries do not enqueue duplicate prompts.

Do not enable Codex first. Codex app-server is RPC-shaped, but current Codex metadata reports:

```ts
supportsInFlightInput: false
supportsInterrupt: false
```

Treat Codex as queue-only until a smoke test proves active-run contribution semantics.

Also remove provider-name shortcuts such as “Anthropic SDK means in-flight supported.” Capability must come from runtime metadata/provider implementation plus smoke tests, not provider name.

## 11. Reset, cancel, interrupt, authorization

Patch reset:

```text
packages/acp-server/src/handlers/sessions-reset.ts
```

On reset/clear-context:

```text
follow_latest queue items:
  remain queued

expire_on_generation_change:
  become expired

pin_generation:
  become expired unless same generation remains valid

pending input applications:
  become failed/ambiguous depending on HRC ledger state
```

Patch cancellation:

```text
packages/acp-server/src/handlers/runs-cancel.ts
```

Add behavior:

```text
queued run cancellation:
  cancel queue item and run

pending contribution cancellation:
  mark input_application cancelled/failed

running run cancellation:
  existing HRC interrupt/cancel path
```

Patch interrupt/control:

```text
packages/acp-server/src/handlers/sessions-interrupt.ts
```

Do not encode interrupt as text. Route `InputIntent.kind = 'control_active_run'` to explicit HRC control operations.

Patch authz:

```text
packages/acp-server/src/routing/mutating-routes.ts
packages/acp-server/src/routing/actor-and-authz.ts
```

Add intent-level checks inside `InputAdmissionService`:

```text
inputs.create                 ordinary new_work
inputs.queue                  queue future work
inputs.contribute_active_run  active-run contribution
inputs.control_active_run     interrupt/cancel/pause
```

Do not let every gateway user who can post in a bound channel steer an active run.

## 12. Ops/dashboard/events

Current ops projection has legacy `inflight.*` concepts and `supportsInFlightInput` fields. Add ACP admission events instead of overloading HRC events.

Suggested ACP event kinds:

```text
input.admitted
input.queued
input.dispatching
input.started
input.completed
input.rejected
input.application.pending
input.application.accepted
input.application.failed
input.application.ambiguous
input.queue.expired
```

Patch:

```text
packages/acp-server/src/handlers/ops-dashboard-events.ts
packages/acp-server/src/handlers/ops-dashboard-snapshot.ts
packages/acp-ops-projection/src/index.ts
packages/acp-ops-web/src/api/snapshot.ts
```

Dashboard labels should distinguish:

```text
Queued work
Contribution pending
Contribution accepted
Contribution ambiguous
Unsupported contribution fallback queued
```

Avoid “steered” unless capability says `ackSemantics = 'observed_applied'`.

## 13. Tests

Start with queue-only tests. Do not begin with provider contribution.

### ACP state/store tests

Targets:

```text
packages/acp-state-store
packages/acp-server/src/domain/__tests__
```

Cases:

```text
input_attempts.run_id may be null
run status queued persists through SQLite
idempotent input returns original admission
currentState changes independently from originalAdmission
per-session FIFO seq allocation is stable
queue item lease/release/complete works
reset policies expire or retain queued items correctly
```

### ACP route tests

Targets:

```text
packages/acp-server/test/inputs.test.ts
packages/acp-server/test/inputs-dispatch.test.ts
packages/acp-server/test/interface-messages.test.ts
packages/acp-server/test/dispatch-fence.test.ts
```

Cases:

```text
idle /v1/inputs creates pending/running run and admission.kind=started_run
busy /v1/inputs returns queued_run, not failed run
duplicate idempotency key returns same original admission and no redispatch
dispatch:false creates pending run and admission but does not launch
interface retry creates only one human turn
queued interface message preserves source metadata
queued dispatch later produces normal assistant delivery
```

### Queue dispatcher tests

Cases:

```text
does not dispatch second queued item while first run is pending/running
leases only head item per SessionRef
handles runtime_busy by requeueing with backoff
respects follow_latest / pin_generation / expire_on_generation_change
does not duplicate launch on idempotent replay
does not blindly retry ambiguous HRC dispatch
```

### HRC contribution tests

Targets:

```text
packages/hrc-server/src/__tests__/server-inflight.test.ts
```

Add new tests rather than only patching legacy in-flight tests:

```text
new endpoint requires inputApplicationId
duplicate inputApplicationId does not call provider twice
no active run rejects
run mismatch rejects
unsupported runtime rejects
ambiguous delivery is queryable from ledger
legacy /v1/in-flight-input remains compatible but is not ACP path
```

### AgentSpaces tests

Targets:

```text
packages/agent-spaces
```

Cases:

```text
queueInFlightInput dedupes by inputApplicationId
accepted_only does not claim applied
outstanding turn count remains correct
rejected when no active run context exists
```

### E2E scenario

Targets:

```text
packages/acp-e2e
integration-tests
```

Critical flow:

```text
1. Post first message to a SessionRef.
2. Before it completes, post second ordinary message.
3. Assert first is pending/running.
4. Assert second is queued_run.
5. Complete first.
6. Assert second dispatches after first.
7. Assert assistant delivery correlation is correct.
8. Assert no duplicate input or duplicate run.
```

Run sequence:

```bash
bun run --filter acp-core typecheck
bun run --filter acp-state-store test
bun run --filter acp-server test
bun run --filter hrc-core typecheck
bun run --filter hrc-sdk test
bun run --filter hrc-server test
bun run --filter agent-spaces test
bun run typecheck
bun run test:fast
```

## 14. Recommended implementation order

### Phase A — queue-only ACP admission

Implement:

```text
core types
state migrations
repositories
InputAdmissionService for new_work only
run status queued
input_attempts.run_id nullable
```

Behavior:

```text
idle -> pending run + dispatch
busy -> queued run
```

Do not enable active-run contribution yet.

### Phase B — route all input producers through admission

Patch:

```text
/v1/inputs
/v1/interface/messages
coordination messages
wake dispatcher
admin jobs
flow-step dispatch
```

Keep backward-compatible `response.run` for ordinary new work.

### Phase C — queue dispatcher

Add the dispatcher and leasing model. Make HRC `runtime_busy` requeue instead of failing.

This is where the real product bug gets fixed.

### Phase D — HRC contribution contracts and ledger

Add:

```text
new active-run contribution endpoint
rich capability type
HRC ledger
SDK client method
reconciliation endpoint
```

Keep providers disabled.

### Phase E — provider contribution behind feature flag

Enable AgentSpaces only, with conservative semantics:

```text
deliverySemantics = sequential_followup
ackSemantics = accepted_only
```

Do not enable Codex or Claude until smoke tests prove behavior.

### Phase F — ACP contribution intent

Enable:

```ts
{ kind: 'contribute_to_active_run' }
```

Only after HRC contribution is idempotent, queryable, and capability-gated.

Ambiguous HRC result returns:

```text
admission_pending
```

### Phase G — policy and UX surfaces

Patch:

```text
reset
cancel
interrupt/control
authz
ops dashboard
CLI
Discord gateway behavior
mobile behavior if present
```

## Main pitfalls

The largest correctness risk is duplicate semantic input after timeout. This applies both to active-run contribution and queued run dispatch. Any retryable HRC call needs durable correlation and reconciliation.

The second risk is accidentally making contribution the default busy behavior. Ordinary input should queue unless the caller explicitly asks to contribute to the active run.

The third risk is treating provider acceptance as model application. AgentSpaces can enqueue another provider prompt, but that is not same-turn steering. Surface it as `accepted_in_flight` with `ackSemantics = accepted_only`.

The fourth risk is incomplete migration of input producers. `/v1/inputs` and `/v1/interface/messages` are obvious, but wake dispatch, coordination-message dispatch, admin jobs, flow steps, CLI assumptions, Discord gateway assumptions, and mobile ingress all share the old run-creation model.

The fifth risk is letting HRC become the queue authority. ACP owns admission, FIFO, idempotency, and durable input state. HRC reports runtime/run facts and performs delivery; it should not decide ACP ordering.

## 15. Current status for continuation

Updated 2026-05-07 post-execution (~17:35 UTC). All four T-01379 children are committed and closed. The coordinator-side e2e went through six unsuccessful Discord-render takes before the user pushed back ("you are not done until I can properly steer an agent in discord") — at which point the gateway-discord ingress was discovered to have no contribution path at all. A `/steer ` keyword prefix was added to gateway-discord as a placeholder to demonstrate the round-trip; the final take (`proper-steer-123114`) successfully rendered the steered answer in Discord. T-01379 parent stays open until lherron decides on the Discord steering ingress design (the keyword is a placeholder, not a real design — see "Discord steering ingress: open question" below) plus the existing deprecation/push/PR decisions.

This section is the live operational state. Everything above (sections 0–14 + Main pitfalls) is the unchanged design spec.

### Branch and worktree

- Branch: `feat-input-admission`
- HEAD: `297a673` (T-01382 reconciliation flow)
- Working tree NOT fully clean: `packages/gateway-discord/src/app.ts` and `packages/gateway-discord/src/hrc-event-adapter.ts` have uncommitted edits from the e2e validation (the `/steer ` placeholder ingress + a debugging-era no-op `sdk.*` case in the adapter). Both are pending the Discord steering design decision before commit. Untracked: this `STEERING_ORIGINAL_IMPL.md` and its `STEERING_BACKUP_IMPL.md` sibling.
- Substrate baseline: `5818544` (Phase A–D substrate, ~2000 lines)

Working tree clean — only this `STEERING_ORIGINAL_IMPL.md` and `STEERING_BACKUP_IMPL.md` are untracked, by design.

Worktree-side artifacts:
- Sparky agent profile at `~/praesidium/var/agents/sparky/agent-profile.toml` + `SOUL.md` (smoke-only, `harness = "agent-sdk"`, `role = "smoke"`; NOT in agent-defaults registry per cody's constraint)
- This file's backup at `STEERING_BACKUP_IMPL.md`
- `INGRESS_AUDIT.md` from T-A's Phase B audit recap (committed as part of `279d6cd`)

### Phase ledger (T-01379 children) — all closed

| Task | Phase | State | Commit | Notes |
|---|---|---|---|---|
| T-01380 | T-A ledger hardening + Phase B audit recap | ✅ completed | `fa2faa0` | Smokey reds at `279d6cd`; larry green at `fa2faa0` (input-admission-service keeps admission_pending on HRC transport error) |
| T-01381 | T-B real virtu smoke + AgentSpaces SDK provider proof | ✅ completed | `eacc073` | Smokey reds at `8c47b9e`; larry green at `eacc073` after fixing the placement-SDK in-flight-map registration + bounded retry; smoke evidence in C-02451/C-02452/C-02453 |
| T-01382 | T-C admission_pending operator reconciliation flow | ✅ completed | `297a673` | Smokey reds at `311dbd9`; larry green at `297a673` (576 insertions: new admin CLI + HTTP route + reconcileFromHrcLedger store method); evidence in C-02454; smokey verified locally on 297a673 (#1501) |
| T-01383 | T-D UX labels | ✅ completed | `a02aef9` | Smokey reds at `d3d70bb`; curly green at `a02aef9` (centralized label map at `packages/acp-ops-projection/src/admission-labels.ts`) |

Coordinator parent: **T-01379** (Steering: Phase E proper-steering coordination). Stays open pending lherron's call on three remaining post-execution items: (a) `/v1/in-flight-input` deprecation docs (T-E follow-up, deferred per cody), (b) push `feat-input-admission` to remote / open PR, (c) close T-01379 itself.

Follow-up wrkq tasks filed during this work (resilience + ergonomics, NOT blocking T-01379):
- **T-01384** — agent-spaces/hrc-monitor-wait-resilience: three monitor-wait fixes (turn-completed condition surfacing turn body, anchor `--until response` to `from.sessionRef`, auto-reconnect across HRC restarts). Filed during T-01381 coordination.
- **T-01385** — agent-spaces/hrc-resume-command: `hrc resume` sugar that auto-uses the latest generation's continuation id for recovery. Filed during T-01381 coordination.
- **T-01386** — agent-spaces/gateway-discord-progress-watchdog: gateway-discord live-progress watchdog fires too aggressively for SDK runs whose first output is delayed by a Bash tool call (e.g. `sleep 30`). Replaces the live progress notice with "⚠️ Agent invocation did not start producing progress" within ~1s, even though the model's actual outputs land 30+ seconds later (verified via HRC `sdk.message` events). Filed during the coordinator e2e validation pass after multiple steering tests had their visible Discord output overwritten by the watchdog.

### What's done (verified on disk)

#### T-A (T-01380) at `fa2faa0`
- HRC ambiguous-delivery ledger tests (server-inflight.test.ts:504, :580 covering ambiguous-on-throw, capability-gated-by-sdk-transport, no_active_run rejection, run_mismatch rejection, feature-gate-disabled rejection).
- ACP admission_pending recovery test (input-admission-queue.test.ts:621 covering transport-error → admission_pending + idempotent replay without queue fallback).
- Phase B ingress audit recap at `INGRESS_AUDIT.md`. Confirmed all input ingress paths route through `InputAdmissionService.admit`: `inputs.ts:139`, `coordination-messages.ts:227`, `interface-messages.ts:178`, `cli.ts:486` (smoke harness). Wake dispatcher uses admitInput shim (cli.ts:485). Recent Discord live-progress commits (3eb6dc5, bebcda2, 573bb3f) are read-side only.
- Implementation: `input-admission-service.ts` keeps `InputApplication.status='pending'` on HRC transport errors so reconciliation owns recovery, instead of marking failed and falling back to queue.
- Validation: 281/281 hrc-server, 384/384 acp-server, full lint+typecheck.

#### T-D (T-01383) at `a02aef9`
- Centralized label map at `packages/acp-ops-projection/src/admission-labels.ts` (NEW, 93 lines).
- Cody-mandated wording: 'Contribution accepted' / 'Contribution pending' / 'Contribution ambiguous' / 'Unsupported contribution fallback queued' / 'Queued'. Never 'steered' or 'applied'.
- Wired through: `acp-cli/send.ts`, `acp-ops-projection/index.ts`, `acp-ops-web/snapshot.ts`, `acp-server/handlers/ops-dashboard-shared.ts`, `gateway-discord/hrc-event-adapter.ts`.
- gateway-discord previously DROPPED `input.application.accepted` events; now renders them as 'Contribution accepted' notices.
- Validation: 149 tests across 4 packages, all typechecks pass.

#### T-B (T-01381) — currently uncommitted

Larry's prior session (rt-d2d41824, headless transport) completed:
- HRC adapter fix: shared AgentSpaces client between `runTurnNonInteractive` and `queueInFlightInput` so an active SDK run and contribution delivery share the same in-process in-flight map.
- Cody's predicate fix at `packages/hrc-server/src/index.ts:1808-1812`:
  ```ts
  const tmuxAvailableAndIdle =
    liveTmuxRuntime &&
    liveTmuxRuntime.transport === 'tmux' &&    // NEW guard
    liveTmuxRuntime.tmuxJson !== undefined &&  // NEW guard
    !isRuntimeUnavailableStatus(liveTmuxRuntime.status) &&
    liveTmuxRuntime.activeRunId === undefined
  ```
  Prevents idle SDK runtimes from falling through to tmux dispatch path. Required to keep busy-default FIFO smoke authoritative.
- New test file: `packages/hrc-server/src/__tests__/server-sdk-dispatch.test.ts` covering the predicate fix.
- ACP launcher fix: `packages/acp-server/src/real-launcher.ts` now preserves `harness="agent-sdk"` / `claude-agent-sdk` intent from agent-profile.toml so ACP sends HRC an SDK dispatch intent instead of defaulting to headless. Cody confirmed real-launcher.ts is the right minimal seam (ACP/Discord stay intent/admission-oriented; the launcher is where placement + agent-profile become an HRC runtime intent).
- Sparky one-off agent profile at `~/praesidium/var/agents/sparky/agent-profile.toml` with `harness = "agent-sdk"`, `role = "smoke"`. NOT in agent-defaults registry per cody's constraint. Smoke-only.
- `bun.lock` updated by `just install` during smoke setup (include in eventual commit).

Validation prior to live smoke: 15/15 hrc-server inflight, 10/10 acp-server queue, agent-spaces test (174 pass), full lint + typecheck + test:fast (1858 pass).

Capability metadata evidence (cody requirement, partially satisfied): `/tmp/t01381-hrc-runtimes-sparky-busy.json` shows sparky comes up with `transport: "sdk"`, `harness: "agent-sdk"`, `provider: "anthropic"`, `supportsInflightInput: true`, `frontend: "agent-sdk"`. ✓ The capability path is proven end-to-end; the runtime profile is the right shape.

### Coordinator e2e validation results (2026-05-07 ~16:20–17:35 UTC)

After all four children landed, clod ran the coordinator-side e2e on canonical paths. Several iterations were needed because the user's "you are not done until I can properly steer an agent in discord" requirement exposed gaps that purely-internal evidence didn't.

**What's solidly proven (HRC/admission layer):**

1. ACP `accepted_in_flight` admission with cody-locked capability: multiple successful captures (`iap_c302134a72bd`, `iap_3aa2d1b5b8ac`, `iap_1994a0a2f779`, `iap_682d68bf03a8`, `iap_8c1d564c9793`, `iap_ed32eb6fb807`) all show `{status:accepted, capability:{supported:true, deliverySemantics:"sequential_followup", ackSemantics:"accepted_only", ordering:"fifo", supportsAttachments:false}, pendingTurns:2}` against busy SDK runtimes with `transport=sdk, supportsInflightInput=true, activeRunId set`.
2. **Mid-flight delivery during active tool call**: HRC `state.sqlite` shows `sdk.inflight_delivered` events arriving between `sdk.tool_call` and `sdk.tool_result` markers — provably during the bash sleep window, not after.
3. **Idempotent replay**: same idempotency key returns same `inputApplicationId`, `deliveryAttempts` unchanged, no second provider call enqueued.
4. **Busy-default regression** (cody's non-negotiable): 2 ordinary inputs (no `--intent`) against busy sparky scope queue at `seq=2` and `seq=3`; contribution does NOT consume queue seq.
5. **Reconcile CLI on live ACP**: `acp admin contributions reconcile` works for `--all-pending` (discovered 2 real stale rows in production state and consulted HRC ledger), `--input-application-id` (idempotent on accepted), and missing ID (404).
6. **Flag-off rejection**: with `HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED` unset, contribution returns `admission.kind=rejected, lastErrorCode=active_run_contribution_disabled`. Flag check fires before active-run check.

**What was NOT initially proven and required follow-up work:**

The first six steering takes (sparky and cody bindings, scopes ending `-111913`, `-steering-113314`, `-steer-113736`, `-112820 (cody)`, `-steer-final-120511`, `-steer-fix-120955`) all had the contribution mechanism succeed at the HRC/ledger layer but the **user-visible Discord output remained broken or empty**. Two layered failures contributed:

- **gateway-discord live-progress watchdog** (filed as **T-01386**): replaces the "⏳ Processing" notice with "⚠️ Agent invocation did not start producing progress" or "Could not reach ACP: timed out" within ~1s when no early model output arrives. Bash-sleep prompts always tripped it.
- **Operator-induced HRC restarts mid-flight** (operator error): clod's flag-off cleanup restarted HRC while sparky's session was still active; gateway then posted "Agent invocation failed: socket connection closed unexpectedly" because the runtime died mid-flush. This was avoidable, not a feature bug.
- **No Discord-side steering channel**: every take used `acp send --intent contribute` from the coordinator's shell, which is API-only steering. The user correctly pointed out this didn't actually prove Discord steering — the contribution prompt never went through Discord.

**The actual proof of Discord-visible steering** (final take, scope `agent:sparky:project:agent-spaces:task:proper-steer-123114`, 2026-05-07 17:31 UTC):

Two messages went via virtu/Discord (NO API-side steering):
```
17:31:21  virtu  →  Discord:  "Please slowly write a short story (about 80 words)
                              about a cat learning to use a computer. Begin with:
                              TITLE_123114: ... End with: END_123114."
17:31:23  virtu  →  Discord:  "/steer Stop the story right now and just answer
                              this question instead: What is 7 plus 8? Reply with
                              only the digit."
```

The gateway-discord adapter (modified in this work — see "Discord steering ingress: open question" below) detected the `/steer` prefix on the second message, stripped it, and posted to `/v1/inputs` with `intent={kind:'contribute_to_active_run', fallback:'queue'}`. Result:

| Source | Intent | Admission |
|---|---|---|
| original story prompt | `new_work` | `started_run` |
| `/steer ...` Discord message | `contribute_to_active_run` | **`accepted_in_flight`** |

Model timeline:
```
17:31:21.906  user (Discord):     story prompt
17:31:24.268  user (contribution): "Stop the story... What is 7 plus 8?"
17:31:31.117  assistant:           "TITLE_123114: Whiskers watched her human..."
17:31:33.115  assistant:           "15"   ← steered answer
```

Discord rendered (final state, gateway uses single-message-edit semantics so only the latest assistant turn is visible):
```
sparky: 15
```

The "15" is the smoking gun: it does not appear anywhere in the original story prompt; it can only be there if the `/steer` Discord message reached the model and changed its behavior. End-to-end Discord steering proven.

### Discord steering ingress: open question (NOT properly designed yet)

The current implementation requires a magic `/steer ` keyword prefix on Discord messages. **This is a placeholder, not the intended design.** lherron flagged that we should not require a keyword. Open question for whoever picks this up:

How should a Discord-bound agent be steered without a magic prefix? Constraints:

- **Cody's lock stands**: ordinary busy input must continue to default to `queued_run`. We cannot blanket-promote any-busy-message to `contribute_to_active_run`.
- **Discord-native UX**: ordinary message senders (humans, virtu) should not have to memorize gateway-specific syntax.
- **Channel isolation**: if a separate "steering channel" or thread were the answer, it would need to be a per-binding configuration (binding kind: `new_work_only` vs `contribute_default` vs `mention_to_steer`).

Possible designs to consider:

1. **Reply-to inference**: a Discord reply to the agent's last message during a busy turn auto-promotes to contribute. Risk: humans replying to ack/discuss the agent's last message would unintentionally steer.
2. **Mention-based**: `@steer message` as Discord mention syntax. Slightly less keyword-y than `/steer ` but still keyword-shaped.
3. **Per-binding default-intent**: extend `interface_bindings` schema with a `default_input_intent` column (values: `new_work`, `contribute_when_busy`). Steering channels opt in; ordinary chat channels stay queue-default.
4. **Slash-command** (Discord native): real Discord slash command `/steer` registered with the bot, which is more discoverable than the text-prefix implemented here, but still keyword-shaped.
5. **Edit-message-as-steer**: editing the most recent virtu/human message during a busy turn promotes to contribute. Probably too magical.

The current `/steer ` text prefix is the cheapest hack to demonstrate the round-trip (and was needed for the user's acceptance test). The committed code path (`packages/gateway-discord/src/app.ts` `handleMessageCreate`, the `steerMatch` branch) should be revisited and replaced with a proper design before any real Discord users see it. Filing this as a follow-up rather than locking the placeholder in.

### Other follow-ups discovered during e2e

- **T-01386** — gateway-discord progress-watchdog over-aggression (filed)
- **Gateway binding-cache staleness** (NOT yet filed): the gateway loads `interface_bindings` at startup and never refreshes when the DB is updated by `acp admin interface binding set`. Until this is fixed, the operator must restart acp-server AFTER changing a binding to flush the cache. Workaround for the e2e: bind first, then `launchctl kickstart -k com.praesidium.acp-server`, then test.
- **Single-message-edit Discord render** (NOT yet filed): when a session emits multiple assistant turns (original task + contribution-applied), the gateway-discord render edits a single Discord message in place, so only the LATEST assistant turn is visible. Multi-turn sequences lose intermediate output. For steering UX this matters: users see the steered answer but not what the agent was doing before the steer.
- **Cleanup ordering for flag-off tests**: ALWAYS unset the flag and restart HRC AFTER any active SDK session has fully drained. Restarting mid-flight surfaces as "socket connection closed unexpectedly" in Discord and looks like a feature failure.

### Cleanup state (verified)

- `HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED` unset (re-enabled during e2e, planned for unset in final cleanup)
- Discord smoke binding to be restored to `agent:cody:project:agent-spaces:task:discord-chat` after `/steer` follow-up decision
- Working tree dirty: gateway-discord changes (`/steer ` prefix in `app.ts`, no-op `sdk.*` cases in `hrc-event-adapter.ts`) on disk uncommitted; should be committed only after the `/steer` design open question is resolved or explicitly accepted as a placeholder by lherron.

### Cody's hard prerequisites (locked from T-01379 consult)

1. ✅ AgentSpaces SDK is the right first-slice target with `deliverySemantics='sequential_followup'` and `ackSemantics='accepted_only'`. Locked behind `HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED=1`. Do NOT enable Codex, Claude, or tmux contribution paths.
2. ✅ Capability source-of-truth via runtime/provider metadata, not provider-name shortcuts. Sparky proves this via `frontend: "agent-sdk"` + `supportsInflightInput: true` from runtime metadata.
3. ✅ Ordinary busy input must remain queued new_work (regression check is Case 4).
4. ✅ `accepted_in_flight` means delivery-layer accepted only; never 'steered' or 'applied'.
5. 🔄 Duplicate inputApplicationId/idempotency must be proven not to enqueue a second AgentSpaces prompt (Case 2).
6. 🔄 Ambiguous/timeout delivery must remain queryable/reconcilable; no blind retry that can duplicate provider work (T-A handles this; T-C will exercise reconciliation).
7. 🔄 Run/generation fencing must reject stale or mismatched contribution attempts (units pass; live smoke pending).
8. 🔄 Real smoke must run after installed binaries/services are refreshed, not against stale local code (`just install` already done).

Cody's specific evidence requirements for T-01381 close — all ✅:
- ✅ Test assertion proving idle SDK runtime does not fall through to tmux dispatch (new `server-sdk-dispatch.test.ts`).
- ✅ Real smoke evidence showing the contribution was sent while HRC reported `transport='sdk'`, `supportsInflightInput=true`, AND `activeRunId` set. Larry's T-01381 smoke captured this in C-02451; the coordinator e2e re-verified it on take-3 with sdk.inflight_delivered timestamped 16:37:54.775 against runtime in `transport=sdk, supportsInflightInput=true, activeRunId=run-33e3eea1-...`

### Coordination lessons learned (for the next coordinator)

The prior session's pain points (each filed as wrkq tasks T-01384/T-01385 for resilience improvements):

1. **Headless agents end turns silently** (T-01384 fix 1): when an agent emits a final `turn.message` but doesn't call `hrcchat dm`, monitor wait returns `idle_no_response` with no body. The operator is blind to the agent's last word. Workaround until T-01384 lands: peek with `hrc monitor watch msg:<id> --json | grep turn.message` after each idle, or just nudge the agent again with an explicit "End your turn by sending hrcchat dm to clod@agent-spaces" instruction. The new larry session is on **tmux** transport which should not exhibit this, but watch for it.

2. **Self-DM false positive on `--until response`** (T-01384 fix 2): outbound `--reply-to` carries `phase: "response"`, which the monitor matches as a response. Workaround until T-01384 lands: prefer `seq:<larry-message>` instead of `seq:<my-message>`, or use `--until idle` with the session selector.

3. **HRC restart breaks every active wait** (T-01384 fix 3): any smoke that includes `hrc server restart --force` kills in-flight monitor waits with infra error 1. Workaround: re-arm waits after the restart settles.

4. **Shared worktree with parallel impl agents → trampling** (memory-encoded): never run T-B and T-D in parallel on the same `feat-*` branch. Sequential is the correct mode. The prior coordinator wasted ~30 min recovering from a 3-agent stash collision (curly's T-D + larry's T-B + smokey's T-C scaffolding all stashed together; reset cleared everything; larry's HRC fix preserved as patch and reapplied). Strict rules now in every dispatch: NEVER `git stash`, `git reset --hard`, or `git checkout -- <file>`.

5. **`just install` must be run on the operator's worktree before live smoke** (per spec section 13). Otherwise launchd-managed `acp`/`hrc` binaries resolve stale package output even when local tests pass. Already done for current state.

6. **`hrc resume` would help** (T-01385): when an agent runtime gets interrupted (HRC restart, hung turn), `hrc resume <handle>` should auto-look-up the latest generation's continuation id. Currently the operator has to spelunk the state DB.

7. **Force-restart authorized for HRC**: the user authorized `hrc server restart --force` even when the clod runtime is in-flight, because the coordinator's tmux session survives daemon restart. Keep that authorization scope unless the user explicitly revokes.

### Suggested entry sequence for a fresh coordinator session (post-execution)

1. `wrkq cat T-01379` (this coordination parent — still open pending lherron's call)
2. `wrkq cat T-01380 T-01381 T-01382 T-01383` (all children should show state=completed)
3. `git log --oneline main..HEAD` — should show 8 commits ahead (substrate + 4 phase commits + smokey reds)
4. `git status --short` — expect modifications in `packages/gateway-discord/src/{app.ts,hrc-event-adapter.ts}` (the `/steer ` placeholder + a no-op `sdk.*` adapter case from a debugging detour). These are uncommitted pending the Discord steering design decision.
5. `stackctl status dev --brief` — HRC + ACP should be healthy; taskboard down is baseline
6. `launchctl asuser $(id -u) launchctl getenv HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED` — should be empty (cleanup verified)
7. `acp admin interface binding list --json | jq '.bindings[] | select(.conversationRef == "channel:1501224513390772224")'` — should show one active binding pointing at `agent:cody:project:agent-spaces:task:discord-chat` (canonical state restored)
8. Read this section's "Coordinator e2e validation results" subsection above for the actual outcome (multi-take), and the "Discord steering ingress: open question" subsection for the design decision still pending.

Remaining decisions for lherron (not for the next coordinator to make alone):
- **Discord steering ingress design** (NEW, blocks committing the `/steer ` change): pick from the 5 design options or accept the keyword as a placeholder. See "Discord steering ingress: open question" above.
- `/v1/in-flight-input` legacy compatibility deprecation — deferred per cody as T-E follow-up
- Push `feat-input-admission` to remote and open a PR (or merge directly) — deferred until Discord ingress design is settled, otherwise the `/steer ` placeholder ships in the PR
- Close T-01379 (parent) once the above are decided

If lherron asks for the e2e smoke to be re-run: bind the smoke channel BEFORE restarting acp-server (gateway binding-cache staleness — see follow-ups). Don't restart HRC mid-flight (kills sparky's session and surfaces in Discord as "socket connection closed unexpectedly"). Use the take-3 prompt template (model emits a token first to satisfy the gateway watchdog, then bash sleep, then late tokens) until T-01386 fixes the watchdog.

### Key paths reference

- Coordinator parent task: T-01379 (`wrkq cat T-01379`)
- Active branch: `feat-input-admission`
- Spec source: this file (`STEERING_ORIGINAL_IMPL.md`); backup at `STEERING_BACKUP_IMPL.md`
- Substrate baseline commit: `5818544`
- Smokey reds:
  - T-01380: `279d6cd`
  - T-01381: `8c47b9e`
  - T-01382: `311dbd9`
  - T-01383: `d3d70bb`
- Green commits:
  - T-01380: `fa2faa0`
  - T-01381: `eacc073`
  - T-01382: `297a673`
  - T-01383: `a02aef9`
- Coordinator e2e evidence files (in `/tmp/`):
  - `final-e2e-take3-events.txt` — extracted SDK message timeline showing contribution-during-tool_call delivery
  - `final-e2e-take3-ledger.json` — HRC ledger row for `iap_1994a0a2f779`
  - `final-e2e-take2-ledger.json`, `final-e2e-take2-contrib.json` — earlier take with same shape
  - `final-e2e-contrib.json`, `final-e2e-contrib-ledger.json` — first sparky scope contribution
  - `final-e2e-contrib-replay.json` — idempotent replay
  - `final-e2e-ordinary1.json`, `final-e2e-ordinary2.json` — busy-default regression evidence (seq 2/3)
  - `final-e2e-reconcile-all.json`, `final-e2e-reconcile-single.json`, `final-e2e-reconcile-missing.json` — reconcile CLI three-path evidence
  - `final-e2e-flagoff.json` — flag-off rejection
- Live smoke channel: `1501224513390772224` (gateway `acp-discord-smoke`)
- Smoke channel default binding (verified restored): scope `agent:cody:project:agent-spaces:task:discord-chat`, lane `main`
- Sparky profile: `~/praesidium/var/agents/sparky/agent-profile.toml` + `SOUL.md` — kept on disk (smoke-only, NOT in agent-defaults registry); useful for future SDK-frontend smoke runs.

### Constraints (still in force from cody T-01379)

- AgentSpaces SDK / agent-sdk frontend / Anthropic provider only. Do NOT enable Codex, Claude (tmux/headless), or tmux contribution paths.
- Capability gating must remain runtime-metadata-driven (`transport==='sdk' && supportsInflightInput`); no provider-name shortcuts.
- Ordinary busy input must continue to default to queued new_work. **This lock is in tension with the open Discord steering UX question** — see "Discord steering ingress: open question" above. The temporary `/steer ` keyword prefix preserves the lock by requiring an explicit signal, but the permanent design must reconcile "no keyword required" with "ordinary busy input still queues."
- `accepted_in_flight` means delivery-layer accepted only; never 'steered' or 'applied'.
- Duplicate `inputApplicationId` must not enqueue a second AgentSpaces prompt.
- Ambiguous/timeout delivery is queryable/reconcilable; no blind retry.
- `/v1/in-flight-input` legacy compatibility retained; deprecation deferred to T-E follow-up.
- Sparky is smoke-only, NOT in agent-defaults registry.
- Real-provider-only acceptance for smoke; if Anthropic creds prevent a busy run, mark BLOCKED rather than substituting synthetic.
- Wording: "AgentSpaces SDK / agent-sdk frontend / Anthropic provider"; "accepted_in_flight" / "Contribution accepted"; never "steered" / "applied" / "Claude steering".
- Strict rules across all dispatches: NEVER `git stash`, `git reset --hard`, `git checkout -- <file>` on shared worktree; NEVER `just install` without authorization; if encountering uncommitted work you didn't make, STOP and DM coordinator.
