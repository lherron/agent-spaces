# ACP Workflow Implementation Execution Brief

This file is intended to be referenced from a short Codex `/goal` prompt. It assumes the in-memory workflow kernel and conformance suite already exist. The next phase is to turn those semantics into the durable ACP workflow runtime: storage, service boundaries, API/CLI surfaces, participant and supervisor contexts, effect outbox integration, and workflow-patch capture.

## 0. Operating principle

Do not make the workflow spec larger. Make the implementation faithful, durable, retry-safe, and agent-usable.

The core architecture is:

```text
WorkflowDefinition / preset
  immutable workflow contract and guidance

Task
  durable workflow instance pinned to one WorkflowDefinition version/hash

Kernel
  deterministic validator and event/effect producer

Participant Run
  role-scoped agent/harness execution using WorkContext

Supervisor Run
  workflow-scoped coordinator using SupervisorContext and checked control actions

EffectIntent outbox
  durable idempotent bridge to handoff/wake/coordination/runtime side effects

WorkflowPatchProposal
  artifact for improving presets after observed edge cases
```

The deterministic kernel enforces invariants. The supervisor handles runtime messiness by issuing checked actions. Presets are immutable `WorkflowDefinition`s, not special-case runtime handlers.

## 1. Read order

Codex should read these before editing:

1. `acp-workflows-checkpoints-validation.md`.
2. The final ACP workflow proposal/spec supplied by the user.
3. Existing conformance tests, fixtures, golden contexts, invariant docs, and the in-memory kernel.
4. Existing Task, Run, Job, InputAdmission, CoordinationSubstrate, HRC, preset, transition, evidence, role, persistence, API, CLI, and docs code.
5. `AGENTS.md`, repo scripts, schema/migration conventions, and CI config.

The conformance suite and checkpoint/validation file are the contract. Do not silently weaken them.

## 2. Non-negotiable invariants

### Workflow definitions

- Every durable Task pins `workflow: { id, version, hash }`.
- Existing presets must be materialized as immutable `WorkflowDefinition`s.
- Add or materialize `basic@1` for simple durable tasks.
- Runtime must not depend on mutable `latest` for an existing Task.
- There should be one workflow execution path for built-in presets, org workflows, local definitions, and generated definitions.

### Task state

Primary Task state should be:

```ts
state: {
  status: 'open' | 'active' | 'waiting' | 'closed'
  phase?: string | null
  outcome?: string | null
}
```

- `completed` and `cancelled` are not lifecycle states; they are closure outcomes.
- `blocked` is not a primary lifecycle state; use `waiting` plus open blocking `Obligation` or `Wait` records.
- If `state.status === 'waiting'`, the Task should have at least one open blocking obligation/wait unless the workflow explicitly allows non-blocking waiting.
- Resume from waiting requires blocking obligations to be satisfied, waived, expired, or cancelled.

### Transitions

- Apply transitions by `transitionId`, not `toPhase`.
- Transition validation must check: actor identity, role binding authorization, transition authority, SoD, evidence, obligations, child task joins where supported, risk/condition guards, expected version or context hash, and idempotency.
- Transition events are append-only. Do not mutate the ledger.
- A transition commit must atomically update the Task projection, append the TransitionEvent, record idempotency, and enqueue EffectIntents.

### Roles

Use compact role bindings:

```ts
type RoleBindings = Record<string, ActorRef | null>
```

The important fix is semantic authorization:

1. Resolve actor from run/session/auth context, not from a self-declared request body alone.
2. Resolve requested role.
3. Confirm role exists in the workflow definition.
4. Confirm actor is bound to that role, or role is unbound and auto-bind is explicitly allowed.
5. Confirm the transition/action allows that role or supervisor authority.
6. Enforce SoD.

The supervisor is not a magic workflow role. It is a control actor with explicit capabilities.

### Idempotency

Every mutating workflow command must have:

- `idempotencyKey`.
- Stable payload fingerprint.
- Actor/run identity.
- Expected version or context hash when mutating Task state.

Semantics:

```text
same key + same fingerprint       -> return original committed result
same key + different fingerprint  -> conflict
missing key                       -> reject for workflow mutations
stale expected version/hash       -> stable version/context conflict response
```

This must work across persistence boundaries and after restart.

### Effects

- Hardcoded handoff/wake behavior must move into durable `EffectIntent`s where practical.
- Effect delivery is idempotent and may be asynchronous/reconciled.
- Effect creation belongs in the same transaction as the transition or supervisor action that caused it.
- Effect delivery failure must not erase the transition event.

### Contexts

LLM agents and harnesses are primary users. They need structured context, not prose-only hints.

Participant context must include legal transitions, unavailable transitions with stable reason codes, current version/context hash, evidence, obligations, role, command templates, and idempotency guidance.

Supervisor context must include Task state, workflow summary, role bindings, open obligations, evidence, child tasks, participant runs, legal/unavailable transitions, anomalies, allowed control actions, exact command templates, idempotency guidance, and autonomy/budget data if available.

Contexts are snapshots, not authority. The kernel still validates every mutation.

## 3. Durable records to implement or wire

Implement these as first-class durable records, using repo conventions for models/schemas/repositories:

```text
WorkflowDefinition
Task
EvidenceArtifact
Obligation / Wait
TransitionEvent
EffectIntent
IdempotencyRecord
WorkflowPatchProposal
```

If the repo already has near-equivalent records, adapt them only if they can preserve the invariants above. Do not keep legacy names as primary workflow truth merely to reduce diff size.

Recommended minimum field intent:

```ts
type EvidenceArtifact = {
  id: string
  taskId: string
  kind: string
  producer: ActorRef
  runId?: string
  uri?: string
  contentHash?: string
  summary?: string
  payload?: unknown
  createdAt: string
}

type Obligation = {
  id: string
  taskId: string
  kind: string
  status: 'open' | 'satisfied' | 'waived' | 'expired' | 'cancelled'
  blocking: boolean
  owner?: ActorRef | RoleRef
  reason: string
  evidenceRefs?: string[]
  createdAt: string
  resolvedAt?: string
  resolution?: unknown
}

type TransitionEvent = {
  id: string
  taskId: string
  workflow: { id: string; version: number; hash: string }
  transitionId: string
  from: WorkState
  to: WorkState
  actor: ActorRef
  authority: unknown
  runId?: string
  evidenceRefs: string[]
  expectedVersion: number
  nextVersion: number
  idempotencyKey: string
  createdAt: string
}

type EffectIntent = {
  id: string
  taskId: string
  transitionEventId?: string
  source: 'transition' | 'supervisor_action' | 'system'
  kind: string
  payload: unknown
  status: 'pending' | 'delivered' | 'failed' | 'cancelled'
  idempotencyKey: string
  createdAt: string
}
```

## 4. Implementation sequence

Follow this sequence unless the repo structure makes a small reorder clearly better. Keep progress notes in `acp-workflows-checkpoints-validation.md`.

### Checkpoint A — inventory and alignment

- Locate in-memory kernel, conformance tests, fixtures, golden contexts, and any existing task-transition services.
- Map current persistence and API/CLI boundaries.
- Identify legacy fields and handlers: `workflowPreset`, `presetVersion`, `lifecycleState`, `toPhase`, hardcoded handoff/wake logic, role-map-only validation, non-idempotent task transitions.
- Record a short plan and file map in the validation file.

Validation:

- Run existing conformance tests before edits.
- Run the smallest repo-native type/build check to establish baseline.

### Checkpoint B — persistence and repository boundary

- Add schemas/migrations/models/repository interfaces for durable records.
- Add transaction boundary capable of atomic Task projection + ledger + idempotency + effects.
- Add idempotency repository with replay/conflict semantics.
- Keep in-memory adapters for tests if useful, but make durable adapters the runtime path.

Validation:

- Migration/schema checks.
- Repository unit tests for create/read/update/list.
- Restart/reload test proving records survive outside in-memory state.

### Checkpoint C — WorkflowDefinition registry and preset materialization

- Create immutable definition registry.
- Materialize existing presets into `WorkflowDefinition`s.
- Add `basic@1`.
- Compute/persist stable hashes.
- Update Task creation to pin `{ id, version, hash }`.
- Prevent active Tasks from following mutable latest definitions.

Validation:

- Registry tests for lookup by id/version/hash.
- Hash stability tests.
- Task creation tests for pinned workflow.
- Conformance fixtures load through registry.

### Checkpoint D — transition service integration

- Promote kernel transition application into service/API boundary.
- Replace `toPhase` mutation path with `transitionId` path.
- Enforce role authorization, SoD, evidence, obligations, child joins if present, risk guards, expected version/hash, and idempotency.
- Append `TransitionEvent` and enqueue effects atomically.
- Return stable rejection codes.
- Isolate legacy shims only if existing callers require them, and ensure shims call the new kernel path.

Validation:

- Transition success/failure tests.
- Idempotency replay and conflict tests.
- Version conflict tests.
- Rollback-on-failed-validation test proving no partial Task/event/effect write.
- Prior conformance tests still pass.

### Checkpoint E — evidence, obligations, and waiting semantics

- Add APIs/services/CLI paths for attaching evidence.
- Add obligation creation, satisfaction, waiver/cancel/expire where policy permits.
- Implement waiting semantics from obligations.
- Implement resume requirements.

Validation:

- Evidence requirement tests.
- Waiting-with-blocking-obligation tests.
- Resume-blocked-until-obligation-resolved tests.
- Missing evidence rejection code tests.

### Checkpoint F — EffectIntent outbox and coordination integration

- Move hardcoded handoff/wake behavior into effect templates/intents where practical.
- Add outbox reconciler/delivery hook using existing CoordinationSubstrate/HRC conventions.
- Ensure delivery idempotency and retry behavior.

Validation:

- Effect intent created in same transaction as transition/action.
- Duplicate delivery is deduped.
- Delivery failure leaves intent pending/failed without losing transition.
- Handoff/wake scenario works through outbox.

### Checkpoint G — participant runtime surface

- Expose participant task run/create/resume through repo-native API/CLI naming. Preferred shape is `acp task run`, not a full supervisor.
- Compile `WorkContext` for role-scoped agent execution.
- Include legal/unavailable transitions, evidence, obligations, command templates, expected version/context hash, and idempotency prefix.
- Ensure participant commands call kernel services.

Validation:

- Golden `WorkContext` tests.
- Participant scenario: create/resume Task, attach evidence, apply authorized transition, observe effects.
- Unauthorized role cannot transition by claiming role in request body.

### Checkpoint H — supervisor runtime surface

- Expose workflow supervision create/resume through repo-native API/CLI naming. Preferred shape is `acp workflow supervise`.
- Compile `SupervisorContext`.
- Implement one checked action at a time for available capabilities:
  - `LaunchParticipantRun` where feasible.
  - `AttachEvidence`.
  - `ApplyTransition`.
  - `CreateObligation`.
  - `SatisfyObligation`.
  - `ProposeWorkflowPatch`.
  - `Escalate` / `PauseSupervision`.
- Enforce supervisor capabilities separately from workflow roles.
- Do not implement an unbounded autonomous loop unless one already exists and can be bounded by budget and context refresh.

Validation:

- Golden `SupervisorContext` tests.
- One-action-at-a-time test.
- Supervisor cannot bypass SoD/evidence/role policy.
- Supervisor recovery scenario: missing evidence or failed participant produces obligation/retry/escalation/patch proposal rather than fake transition.

### Checkpoint I — workflow patch proposal loop

- Add durable `WorkflowPatchProposal` storage/API/CLI if not already done.
- Link patch proposals to anomalies, Task, base workflow id/version/hash, and rationale.
- Do not auto-mutate active workflow definitions.
- Do not auto-migrate active Tasks.

Validation:

- Patch proposal creation/list/read tests.
- Active workflow definition remains immutable.
- Existing Task remains pinned after patch proposal.

### Checkpoint J — docs and examples

Update docs/examples to cover:

- Presets as immutable `WorkflowDefinition`s.
- Participant vs supervisor runtime surfaces.
- Durable resume from Task state, not prior chat context.
- Idempotency semantics.
- Waiting/obligations replacing blocked.
- EffectIntent outbox for handoff/wake/coordination.
- Workflow patch proposals and explicit migration.
- Breaking changes from legacy fields.

Validation:

- Docs compile if applicable.
- Examples are runnable or clearly marked illustrative.

## 5. API/CLI guidance

Use repo conventions first. If names are not already established, prefer:

```bash
acp task run --workflow code_defect_fastlane@1 --project <id> --role implementer --agent <id> --goal "..."
acp task run --task <task-id> --role tester --agent <id> --resume

acp workflow supervise --workflow code_feature_tdd@1 --project <id> --goal "..." --supervisor agent:coordinator
acp workflow supervise --task <task-id> --supervisor agent:coordinator --resume
```

Participant mutations should support atomic evidence-plus-transition where possible:

```bash
acp task transition \
  --task <task-id> \
  --transition <transition-id> \
  --expected-version <n> \
  --from-run <run-id> \
  --evidence <kind>=<ref-or-json> \
  --idempotency-key <stable-key> \
  --json
```

Supervisor actions should be explicit and one-at-a-time:

```bash
acp workflow action \
  --task <task-id> \
  --action <action-kind> \
  --context-hash <hash> \
  --idempotency-key <stable-key> \
  --json
```

Do not build a broad scripting language for supervisor actions. The command should submit a typed checked action to the service.

## 6. Stable rejection/error codes

Use stable machine-readable codes for agent recovery. Suggested minimum:

```text
workflow_definition_not_found
workflow_hash_mismatch
task_not_found
invalid_state
transition_not_found
transition_not_available
role_not_defined
actor_not_bound_to_role
role_binding_required
sod_violation
missing_evidence
invalid_evidence
open_blocking_obligation
child_tasks_not_closed
risk_guard_failed
version_conflict
context_hash_conflict
idempotency_key_required
idempotency_conflict
capability_denied
supervisor_action_not_allowed
effect_delivery_failed
legacy_route_disabled
```

Agents should receive enough detail to choose a next legal action, but not enough authority to bypass the kernel.

## 7. What not to do

- Do not build BPMN, Temporal, Step Functions, or a general expression language.
- Do not create preset-specific transition handlers.
- Do not let `toPhase` remain the primary mutation interface.
- Do not let `lifecycleState`, `workflowPreset`, or `presetVersion` remain the durable source of truth.
- Do not preserve blocked as primary state.
- Do not trust a request-body role claim as authorization.
- Do not make the supervisor an omnipotent role.
- Do not auto-edit active WorkflowDefinitions.
- Do not auto-migrate active Tasks without an explicit migration event.
- Do not weaken conformance tests to make integration easier unless the supplied spec is demonstrably inconsistent; document any such case.

## 8. Verification matrix

At minimum, add or preserve tests for:

```text
conformance suite before/after integration
workflow registry hash stability
Task pins workflow id/version/hash
transitionId success path
transitionId unavailable path
role binding authorization
SoD violation
missing evidence rejection
evidence attach + transition
waiting + blocking obligation
resume after obligation resolution
idempotency replay
idempotency conflict
missing idempotency rejection
version/context conflict
rollback on validation failure
TransitionEvent append-only ledger
EffectIntent atomic creation
EffectIntent delivery dedupe
persistent restart/replay
ParticipantContext golden output
SupervisorContext golden output
participant end-to-end scenario
supervisor one-action scenario
supervisor cannot bypass evidence/SoD
workflow patch proposal does not mutate active definition
legacy route shim calls new kernel or is explicitly disabled
```

Run repo-native checks:

```text
build/typecheck
lint
unit tests
integration tests
schema/migration validation
docs/examples validation where available
```

If a canonical command is missing, document the unavailable command and run the closest repo-native substitute.

## 9. Progress log requirements

Append to `acp-workflows-checkpoints-validation.md` after each checkpoint:

```text
checkpoint name
files changed
commands run
pass/fail result
failures and whether they are new/pre-existing
blockers
deviations from this brief
next action
```

Keep this factual and short. The final Codex response should summarize, not replace, the validation file.

## 10. Stop condition

Stop only when:

1. Prior conformance still passes or justified spec-consistent updates are documented.
2. Durable persistence/service/API/CLI integration is implemented.
3. Participant and supervisor contexts are compiled and tested.
4. Idempotency, atomic mutation, obligations/waiting, role authorization, and effect outbox behavior are verified.
5. WorkflowPatchProposal capture exists and does not mutate active definitions.
6. Repo-native checks pass, or unrelated/pre-existing failures are documented with evidence.
7. `acp-workflows-checkpoints-validation.md` contains exact commands/results and caveats.
8. All scenarios in ./scenarios are executed successfully by external agent `hrcchat dm clod@agent-spaces`

If a truly blocking repo constraint prevents completion, document the smallest missing dependency, preserve all completed work, and leave the validation file with exact reproduction steps.
