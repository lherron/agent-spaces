# ACP workflow kernel and task/workflow ecosystem — consolidated proposal

## Executive position

The right architecture is a **small deterministic workflow kernel** plus an **adaptive supervisor layer**. The kernel should validate durable state mutations, evidence, role authority, obligations, idempotency, and effect production. The supervisor should coordinate the messy runtime world: launch participants, inspect results, retry/reroute, create waits, request human input, propose workflow patches, and keep the task moving when the preset does not yet model an edge case.

The most important correction from the earlier participant-run framing is this:

```text
Participant agent  = performs one role-scoped slice of work.
Supervisor agent   = coordinates and supervises the whole workflow instance.
Workflow kernel    = deterministic guardrail and ledger, not a brittle omniscient process engine.
```

Do not try to make every workflow preset deterministic enough to handle every runtime scenario. That turns presets into brittle programs and causes work to fail or park unnecessarily whenever reality diverges. Instead, make presets compact, immutable workflow contracts that define the intended path, hard safety gates, evidence contracts, role semantics, and supervisor affordances. The supervisor absorbs runtime variation and turns recurring anomalies into workflow patch proposals. Over time, common recovery paths move from supervisor judgment into workflow definitions, but the system remains usable before every edge case is encoded.

The target stack should be:

```text
ASP                 materializes a base agent/harness invocation
HRC                 manages runtime/session continuity and active input
ACP Run             records one execution attempt
ACP Task            records one durable workflow instance
Workflow Kernel     validates state/evidence/role/obligation mutations
Workflow Supervisor adaptive LLM controller over a Task
Participant Runs    role-scoped work attempts launched by user or supervisor
Coordination Plane   handoffs, wakes, and coordination events produced as effects
Conversation Plane   human-facing transcript/read model, not workflow truth
Job/JobRun           scheduled trigger surface, not a workflow engine
```

The durable artifact is not a larger preset catalog. It is:

```text
WorkflowDefinition + Task projection + append-only WorkflowEvent ledger
+ typed Evidence + typed Obligations/Waits/Handoffs
+ idempotent EffectIntent outbox
+ compiled SupervisorContext / ParticipantContext for LLM harnesses
```

## Confirmed source basis

This proposal consolidates the prior generated artifacts in this session:

- `acp-workflow-kernel-assessment.md`
- `acp-workflow-kernel-assessment-v2.md`
- `acp-run-workflow-proposal.md`
- `acp-workflow-supervisor-layer-proposal.md`

It also reflects the current uploaded source/spec shape:

- `acp-spec/spec/orchestration/TASK_WORKFLOWS.md`
- `acp-spec/spec/orchestration/JOB_FLOW.md`
- `acp-spec/spec/orchestration/INPUT_ADMISSION.md`
- `acp-spec/spec/orchestration/COORDINATION_SUBSTRATE.md`
- `agent-spaces` task/preset/transition/evidence/role-map implementation
- `wrkq` as proof-of-work for durable task ergonomics, not prescriptive workflow policy

## What should change boldly

### 1. Replace `lifecycleState` with a smaller, sharper state vector

Current model:

```ts
lifecycleState: 'open' | 'active' | 'blocked' | 'completed' | 'cancelled'
phase: string | null
resume?: { lifecycleState: string; phase: string | null }
```

Recommended breaking model:

```ts
type WorkState = {
  status: 'open' | 'active' | 'waiting' | 'closed'
  phase?: string | null
  outcome?: string | null
}
```

Rationale:

- `completed` and `cancelled` are both terminal closure states; they differ by `outcome`.
- `blocked` is not a state cause. It is a projection of open blocking obligations/waits.
- `resume` is too weak for real workflows. Real work can wait on approval, reviewer availability, CI, vendor response, deployment window, child tasks, legal review, budget signoff, or human clarification. Those must be first-class records, not a single pointer.

Recommended terminal outcomes should be workflow-defined but commonly include:

```text
success | cancelled | superseded | failed | abandoned | duplicate | out_of_scope
```

Do not make `failed` the default response to unmodeled runtime conditions. Most such cases should become `waiting + obligation`, `child task`, `human input requested`, `retry/reroute`, or `workflow patch proposal`.

### 2. Replace `workflowPreset/presetVersion` with pinned `workflow`

Current model:

```ts
workflowPreset?: string
presetVersion?: number
```

Recommended model:

```ts
workflow: {
  id: string
  version: number
  hash: string
}
```

A preset is just a packaged `WorkflowDefinition`. There should be no preset-specific runtime path. Built-in presets, org workflows, and file-defined workflows all compile into the same kernel model.

Durable tasks should never point to mutable `latest`. Creation may resolve `code_feature_tdd@latest`, but the Task stores the immutable `{ id, version, hash }`.

### 3. Replace `toPhase` transition APIs with `transitionId`

Current implementation is mostly `fromPhase -> toPhase`, with lifecycle computed afterward. That is exactly the wrong direction for agents: it encourages the model to infer workflow legality from names.

Recommended transition command:

```ts
type ApplyTransitionRequest = {
  taskId: string
  transitionId: string
  expectedTaskVersion: number
  contextHash?: string
  actor: ActorRef
  actingRole?: string
  evidenceRefs?: string[]
  inlineEvidence?: EvidenceInput[]
  waiverRefs?: string[]
  idempotencyKey: string
}
```

The agent should not say “move to phase green.” It should say “apply transition `implement_fix`,” using an exact command template compiled by ACP.

### 4. Eliminate preset-less durable workflow records

If work is durable, it should have a workflow. For generic tasks, define a tiny `basic.v1` workflow rather than allowing unvalidated lifecycle mutation.

```text
run-only       ephemeral helper work; no durable Task needed
basic.v1       durable generic Task with minimal validated transitions
custom/preset  durable governed workflow
```

This removes the current “validated generic lifecycle-only transitions are deferred” hole. The kernel always validates through a `WorkflowDefinition`; the smallest workflow is just very small.

### 5. Move handoff logic into transition/control effects

The current proof-of-work hardcodes tester handoff behavior after `red -> green` for non-low-risk work. Operationally useful, architecturally wrong.

Recommended pattern:

```yaml
transitions:
  implement_fix:
    from: { status: active, phase: red }
    to:   { status: active, phase: green }
    by: [implementer]
    requires:
      evidence: [commit_ref, regression_test]
    effects:
      - type: declare_handoff
        when: { riskAtLeast: medium, roleBound: tester }
        toRole: tester
        kind: review
      - type: wake_role_session
        when: { riskAtLeast: medium, roleBound: tester }
        role: tester
```

The kernel validates and records the transition. The effect outbox records the handoff/wake intent. The CoordinationSubstrate materializes the handoff and wake. Coordination should not own task lifecycle policy.

### 6. Make idempotency mandatory for all workflow mutations

LLM harnesses retry, lose tool output, partially fail, and resume from stale context. Workflow mutations must be safe under retries.

Rule:

```text
same idempotency key + same payload fingerprint      -> return original result
same idempotency key + different payload fingerprint -> conflict
missing idempotency key                              -> reject for mutating commands
```

This applies to task creation, transition application, evidence attachment, obligation creation/satisfaction, run launch, control actions, patch proposals, and effect intents. The current task transition handler parses an idempotency surface but generates a random transition event ID; that should be fixed before using the workflow layer as durable orchestration substrate.

## The workflow kernel

The kernel should be deliberately small. It is not a BPMN engine, not an arbitrary expression runtime, not a planner, and not a place to encode every recovery path.

It owns:

```text
1. WorkflowDefinition validation and publishing
2. Task creation pinned to immutable workflow version/hash
3. Transition validation and task state projection updates
4. Evidence attachment and evidence requirement checks
5. Role binding and SoD checks
6. Obligation/wait creation, satisfaction, and blocking semantics
7. Child task linkage and join conditions
8. Idempotent mutation ledger
9. EffectIntent outbox production
10. Compiled contexts for LLM harnesses
```

It does not own:

```text
1. LLM planning or adaptive recovery decisions
2. Harness transcript continuity
3. Human conversation rendering
4. Scheduling semantics beyond explicit effect intents
5. Arbitrary workflow programming
6. Provider/runtime internals
```

### Core data model

```ts
type ActorRef =
  | { kind: 'agent'; id: string }
  | { kind: 'human'; id: string }
  | { kind: 'service'; id: string }
  | { kind: 'group'; id: string }

type RoleBindings = Record<string, ActorRef | null>

type Task = {
  taskId: string
  projectId: string
  workflow: { id: string; version: number; hash: string }
  state: WorkState
  version: number

  goal: string
  risk?: 'low' | 'medium' | 'high' | string
  facts?: Record<string, unknown>

  roleBindings: RoleBindings
  supervisor?: SupervisorBinding

  createdAt: string
  updatedAt: string
}

type SupervisorBinding = {
  actor: ActorRef
  autonomy: 'observe' | 'recommend' | 'managed' | 'autonomous'
  capabilities: SupervisorCapabilities
}

type SupervisorCapabilities = {
  launchRuns?: boolean
  sendInputToRuns?: boolean
  bindUnboundRoles?: boolean
  createObligations?: boolean
  satisfyObligations?: boolean
  createChildTasks?: boolean
  applySupervisorTransitions?: boolean
  requestHumanInput?: boolean
  proposeWorkflowPatches?: boolean
  createWaivers?: boolean
  pauseSupervision?: boolean
}
```

This is intentionally not a heavy role system. The replacement for `RoleMap = Record<string, string>` is mostly semantic, not structural. The current role map is too lossy because it only stores string agent IDs and allows transition requests to assert a role. The required fix is:

```text
actor identity comes from run/session/auth context
requested role must exist in workflow definition
role must be bound to that actor, or be unbound and auto-bindable by policy
SoD checks compare ActorRefs, not role-name strings
```

The task only needs compact `roleBindings`. Rich org policy can live outside the kernel.

### WorkflowDefinition shape

```ts
type WorkflowDefinition = {
  id: string
  version: number
  hash: string
  kind: string

  initial: WorkState

  phases?: Record<string, PhaseSpec>
  outcomes?: Record<string, OutcomeSpec>

  roles: Record<string, RoleSpec>
  evidenceKinds: Record<string, EvidenceKindSpec>
  obligationKinds?: Record<string, ObligationKindSpec>

  transitions: Record<string, TransitionSpec>

  supervisor?: SupervisorSpec
}

type RoleSpec = {
  description?: string
  binding?: 'required' | 'optional' | 'autoBindOnFirstRun'
  mayBeSameAs?: string[]
  mustDifferFrom?: string[]
}

type EvidenceKindSpec = {
  description?: string
  schemaRef?: string
  requiredFields?: string[]
}

type ObligationKindSpec = {
  description?: string
  blockingDefault?: boolean
  ownerRoles?: string[]
  allowedSatisfactionEvidence?: string[]
}
```

Do not add inheritance, arbitrary expressions, embedded scripts, or preset-specific handlers at this layer. If a definition needs complex policy, add a small named built-in predicate or move the adaptation to the supervisor.

### TransitionSpec shape

```ts
type TransitionSpec = {
  id: string
  label?: string

  from: StatePattern
  to: StatePatch

  by?: string[]                 // role names allowed to perform role transitions
  supervisorBypass?: false      // default false; explicit if supervisor may apply

  when?: BuiltInCondition[]
  requires?: Requirement[]
  effects?: EffectTemplate[]

  guidance?: TransitionGuidance
}

type StatePattern = Partial<WorkState>
type StatePatch = Partial<WorkState>
```

Recommended built-in conditions and requirements should stay modest:

```ts
type BuiltInCondition =
  | { type: 'risk_at_least'; level: 'medium' | 'high' }
  | { type: 'risk_equals'; level: string }
  | { type: 'role_bound'; role: string }
  | { type: 'fact_equals'; path: string; value: unknown }
  | { type: 'no_open_blocking_obligations' }
  | { type: 'all_child_tasks_closed'; relation?: string }

type Requirement =
  | { type: 'evidence'; kinds: string[]; mode?: 'all' | 'any' }
  | { type: 'sod'; actingRole: string; notSameAs: string[] }
  | { type: 'obligation_satisfied'; kind?: string; obligationId?: string }
  | { type: 'approval'; role: string }
  | { type: 'waiver'; waiverKind: string }
```

This gives enough expressiveness for most governed workflows without becoming a general workflow language.

### EffectTemplate / EffectIntent

Effects are not side effects performed inline. They are durable intents emitted by kernel-approved transitions or supervisor control actions.

```ts
type EffectTemplate =
  | { type: 'declare_handoff'; toRole: string; kind: string; reason?: string; when?: BuiltInCondition[] }
  | { type: 'wake_role_session'; role: string; reason?: string; when?: BuiltInCondition[] }
  | { type: 'launch_participant_run'; role: string; promptRef?: string; when?: BuiltInCondition[] }
  | { type: 'create_obligation'; kind: string; ownerRole?: string; blocking?: boolean; when?: BuiltInCondition[] }
  | { type: 'start_timer'; duration: string; reason?: string; when?: BuiltInCondition[] }
  | { type: 'create_child_task'; workflow: string; relation: string; when?: BuiltInCondition[] }
```

Materialized intent:

```ts
type EffectIntent = {
  effectId: string
  taskId: string
  sourceEventId: string
  kind: string
  payload: Record<string, unknown>
  idempotencyKey: string
  state: 'pending' | 'leased' | 'delivered' | 'failed'
  createdAt: string
  updatedAt: string
}
```

The write order should be:

```text
validate command
-> append WorkflowEvent
-> update Task projection
-> append EffectIntent rows in same transaction
-> async reconciler materializes HRC/Coordination/Job effects
```

This mirrors the discipline already present in InputAdmission and CoordinationSubstrate: durable intent first, side effects second.

### WorkflowEvent ledger

The Task projection is useful for reads, but the audit trail should be append-only.

```ts
type WorkflowEvent = {
  eventId: string
  taskId: string
  workflow: { id: string; version: number; hash: string }
  type: string
  actor: ActorRef
  runId?: string
  supervisorRunId?: string
  participantRunId?: string
  observedTaskVersion: number
  nextTaskVersion?: number
  contextHash?: string
  idempotencyKey: string
  payload: Record<string, unknown>
  createdAt: string
}
```

Important event types:

```text
task.created
role.bound
role.unbound
evidence.attached
transition.applied
obligation.created
obligation.satisfied
obligation.cancelled
child_task.created
child_task.joined
participant_run.launched
participant_run.completed
supervisor.decision_recorded
workflow_patch.proposed
waiver.recorded
effect_intent.created
effect_intent.delivered
task.migrated_workflow
```

Do not store private chain-of-thought. Store action payloads, concise rationale summaries, context hashes, validation results, and effect outcomes.

## Presets as workflow definitions

Presets should interact with the kernel by compiling to `WorkflowDefinition`. They should not be special code paths.

A good preset has two sections:

```text
Hard contract:
  states/phases/outcomes
  roles and role binding policy
  evidence kinds
  obligation kinds
  transitions
  requirements and effects

Adaptive affordances:
  participant dispatch templates
  supervisor recovery preferences
  anomaly capture rules
  evidence templates
  patch proposal guidance
```

The hard contract is enforced. The adaptive affordances are guidance and context compilation inputs. This distinction is essential. If recovery guidance starts acting like hidden policy, agents will get inconsistent behavior.

### Minimal preset shape

```yaml
id: code_defect_fastlane
version: 1
kind: code_change
initial: { status: open, phase: red }

roles:
  implementer: { binding: required }
  tester: { binding: optional, mustDifferFrom: [implementer] }

evidenceKinds:
  failing_test: {}
  commit_ref: {}
  regression_test: {}
  verification_report: {}
  waiver: {}

obligationKinds:
  human_clarification: { blockingDefault: true }
  tester_review: { blockingDefault: true, ownerRoles: [tester] }

transitions:
  start:
    from: { status: open, phase: red }
    to:   { status: active, phase: red }
    by: [implementer]

  implement_fix:
    from: { status: active, phase: red }
    to:   { status: active, phase: green }
    by: [implementer]
    requires:
      - { type: evidence, kinds: [commit_ref, regression_test], mode: all }
    effects:
      - type: declare_handoff
        when: [{ type: risk_at_least, level: medium }, { type: role_bound, role: tester }]
        toRole: tester
        kind: review
      - type: wake_role_session
        when: [{ type: risk_at_least, level: medium }, { type: role_bound, role: tester }]
        role: tester

  verify:
    from: { status: active, phase: green }
    to:   { status: active, phase: verified }
    by: [tester]
    requires:
      - { type: evidence, kinds: [verification_report], mode: all }
      - { type: sod, actingRole: tester, notSameAs: [implementer] }

  close_success:
    from: { status: active, phase: verified }
    to:   { status: closed, outcome: success }
    by: [implementer]

supervisor:
  dispatch:
    implementer:
      promptRef: code-fix-implementer.v1
      expectedResult: implementation_result.v1
    tester:
      promptRef: defect-verifier.v1
      expectedResult: verification_result.v1

  recovery:
    onRunFailed:
      prefer: [refresh_context, retry_once, launch_alternate_actor, create_obligation]
    onMissingEvidence:
      prefer: [ask_same_role_for_evidence, request_human_input]
    onNoLegalTransition:
      prefer: [classify_anomaly, create_obligation, propose_workflow_patch]

  learning:
    capture:
      - no_legal_transition
      - repeated_run_failure
      - evidence_contract_ambiguous
      - role_unavailable
      - prompt_template_failed
```

This is enough. Resist adding procedural loops, arbitrary conditions, nested branches, or a full embedded planner. The supervisor supplies that adaptivity.

## Participant runs

A participant run is one actor operating as one workflow role.

```ts
type ParticipantRunLink = {
  runId: string
  kind: 'participant'
  taskId: string
  workflow: { id: string; version: number; hash: string }
  actor: ActorRef
  role: string
  parentSupervisorRunId?: string
  taskVersionAtStart: number
  contextHash: string
}
```

The participant’s job is to perform concrete work and either:

```text
1. attach evidence and apply an allowed transition,
2. attach partial evidence and report a specific blocker,
3. request clarification/handoff, or
4. fail with a structured reason.
```

The participant should not infer policy. It receives `ParticipantContext`.

```ts
type ParticipantContext = {
  schemaVersion: 1

  task: {
    id: string
    projectId: string
    workflow: { id: string; version: number; hash: string }
    state: WorkState
    version: number
    goal: string
    risk?: string
  }

  run: {
    id: string
    actor: ActorRef
    role: string
    sessionRef: SessionRef
    idempotencyPrefix: string
  }

  roleObjective: {
    current: string
    doneWhen: string[]
    avoid?: string[]
  }

  assignedObligations: ObligationSummary[]
  relevantEvidence: EvidenceSummary[]

  allowedTransitions: Array<{
    id: string
    label?: string
    to: Partial<WorkState>
    requiredEvidence: EvidenceRequirementSummary[]
    effectsPreview?: EffectPreview[]
    command: CommandTemplate
  }>

  unavailableTransitions: Array<{
    id: string
    reasonCode: string
    reason: string
    missingEvidenceKinds?: string[]
    blockingObligationIds?: string[]
  }>

  commands: {
    refreshContext: CommandTemplate
    attachEvidence: CommandTemplate
    applyTransition: CommandTemplate
    reportBlocker: CommandTemplate
  }
}
```

This context should be available as JSON on disk and summarized in the harness prompt. The JSON is the contract; prose is convenience.

Recommended CLI surface:

```bash
acp task run \
  --task task_... \
  --role implementer \
  --agent larry \
  --harness codex
```

or, if launching from a workflow definition:

```bash
acp workflow start \
  --workflow code_defect_fastlane@1 \
  --goal "Fix the checkout regression" \
  --bind implementer=agent:larry \
  --bind tester=agent:bob

acp task run --task task_... --role implementer --agent larry --harness codex
```

This participant surface is still needed. It is just not the top-level orchestrator.

## Workflow supervisor

The supervisor is a control-plane actor over the Task. It is not one of the workflow roles unless explicitly bound to such a role. It should not be an omnipotent bypass.

```ts
type SupervisorRunLink = {
  runId: string
  kind: 'workflow_supervisor'
  taskId: string
  supervisor: ActorRef
  autonomy: 'observe' | 'recommend' | 'managed' | 'autonomous'
  taskVersionAtStart: number
  contextHash: string
}
```

### Supervisor loop

```text
refresh SupervisorContext
-> choose one control action or a small safe bundle
-> submit action with contextHash, expectedTaskVersion when relevant, and idempotencyKey
-> ACP validates, records, and emits effect intents
-> wait/reconcile if needed
-> refresh context
-> repeat until task is closed, intentionally waiting, or supervision is paused
```

The supervisor is a reconciler: actual state plus desired outcome plus legal affordances gives the next action. It must be restartable from durable ACP state alone.

### SupervisorContext

```ts
type SupervisorContext = {
  schemaVersion: 1

  task: {
    id: string
    projectId: string
    workflow: { id: string; version: number; hash: string }
    state: WorkState
    version: number
    goal: string
    risk?: string
    facts?: Record<string, unknown>
  }

  supervisor: {
    runId: string
    actor: ActorRef
    autonomy: 'observe' | 'recommend' | 'managed' | 'autonomous'
    capabilities: SupervisorCapabilities
    idempotencyPrefix: string
  }

  roleBindings: RoleBindings

  activeParticipantRuns: ParticipantRunSummary[]
  recentParticipantRuns: ParticipantRunSummary[]
  evidence: EvidenceSummary[]
  obligations: ObligationSummary[]
  childTasks: ChildTaskSummary[]
  handoffs: HandoffSummary[]
  pendingEffects: EffectIntentSummary[]

  legalTransitionsByRole: Record<string, TransitionAffordance[]>
  supervisorTransitions: TransitionAffordance[]

  unavailableTransitions: Array<{
    id: string
    role?: string
    reasonCode: string
    reason: string
    remediation?: string[]
  }>

  allowedControlActions: ControlActionAffordance[]

  anomalies: WorkflowAnomalySummary[]

  commands: {
    refreshContext: CommandTemplate
    launchParticipantRun: CommandTemplate
    sendInputToRun: CommandTemplate
    createObligation: CommandTemplate
    satisfyObligation: CommandTemplate
    applyTransition: CommandTemplate
    createChildTask: CommandTemplate
    requestHumanInput: CommandTemplate
    proposeWorkflowPatch: CommandTemplate
    pauseSupervision: CommandTemplate
  }
}
```

Again, the context must be machine-readable first. Agents and harnesses should not scrape human task pages.

### Control actions

The supervisor should submit a small set of kernel-checked actions:

```ts
type WorkflowControlAction =
  | LaunchParticipantRun
  | SendInputToRun
  | WaitForCondition
  | AttachEvidence
  | ApplySupervisorTransition
  | CreateObligation
  | SatisfyObligation
  | CreateChildTask
  | RequestHumanInput
  | ProposeWorkflowPatch
  | Escalate
  | PauseSupervision
```

Important distinction:

```text
Role transition        performed by a role-bound participant actor.
Supervisor transition  administrative/control transition explicitly allowed by workflow/capability.
Control action         not necessarily a workflow phase transition; may launch work, create waits, request input, or propose patches.
```

The supervisor should usually cause role transitions by launching or prompting role-bound participant runs, not by pretending to be the implementer/tester/reviewer. If the system later needs “supervisor applies transition based on participant evidence,” model that explicitly as a distinct authority mode and require referenced evidence from the bound participant run. Do not sneak it in as an implicit bypass.

### Autonomy modes

```text
observe      supervisor only summarizes/reports; no mutation except maybe decision log
recommend   supervisor proposes next action; human/tool applies it
managed     supervisor may launch runs, create obligations, and request input; risky transitions need approval
autonomous  supervisor may use all granted capabilities within workflow policy and budgets
```

Autonomy is not a substitute for authorization. It gates which control actions are allowed, while the workflow kernel still enforces transition requirements.

### Failure and edge-case behavior

When the workflow hits a runtime edge, the supervisor should not mark the Task failed by default. It should classify and choose from safe recovery affordances:

```text
participant run failed       -> retry once, refresh context, launch alternate actor, create obligation
missing evidence             -> ask same role for evidence, launch evidence collection, request human input
no legal transition          -> classify anomaly, create obligation, propose workflow patch
role unavailable             -> bind eligible actor if allowed, request assignment, create waiting obligation
external dependency pending  -> create blocking obligation/wait, set status waiting if needed
ambiguous goal               -> request human input, attach clarification evidence
policy conflict              -> escalate, request waiver if allowed, propose workflow patch
repeated runtime failure     -> create child diagnostic task or pause supervision
```

This is how you avoid brittle deterministic presets while still retaining a deterministic audit trail.

Recommended supervisor CLI:

```bash
# Create Task and supervise it.
acp workflow supervise \
  --workflow code_feature_tdd@1 \
  --project demo \
  --goal "Implement checkout retry and release it" \
  --supervisor agent:coordinator \
  --autonomy managed \
  --harness codex

# Resume supervision over an existing Task.
acp workflow supervise \
  --task task_... \
  --supervisor agent:coordinator \
  --autonomy managed \
  --harness codex
```

Possible command taxonomy:

```text
acp workflow start       create a Task pinned to a workflow definition
acp workflow supervise   start/resume supervisor loop over a Task
acp task run             launch one role-scoped participant run
acp task transition      apply one validated transition
acp task evidence add    attach evidence
acp task obligation ...  manage typed obligations
acp workflow patch ...   inspect/review/publish workflow patch proposals
```

Avoid overloading singular `acp run` for both participant and supervisor. The semantic distinction matters.

## Preset evolution and learning

The supervisor can maintain and improve workflow presets, but it should not mutate active workflow definitions in place.

Recommended loop:

```text
edge case observed
-> supervisor records WorkflowAnomaly
-> active Task recovered via obligation / child task / human input / retry / waiver / pause
-> supervisor creates WorkflowPatchProposal
-> proposal is reviewed, tested, and replayed against historical cases
-> new immutable WorkflowDefinition version is published
-> existing Tasks migrate only via explicit task.migrated_workflow event
```

### WorkflowAnomaly

```ts
type WorkflowAnomaly = {
  anomalyId: string
  taskId: string
  workflow: { id: string; version: number; hash: string }
  supervisorRunId?: string
  category:
    | 'no_legal_transition'
    | 'missing_or_ambiguous_evidence_contract'
    | 'role_unavailable'
    | 'participant_repeated_failure'
    | 'prompt_template_failure'
    | 'external_dependency'
    | 'policy_conflict'
    | 'state_model_gap'
  stateAtObservation: WorkState
  taskVersion: number
  summary: string
  proposedRecovery?: string
  createdAt: string
}
```

### WorkflowPatchProposal

```ts
type WorkflowPatchProposal = {
  proposalId: string
  baseWorkflow: { id: string; version: number; hash: string }
  proposedVersion?: number
  sourceAnomalyIds: string[]
  patchKind:
    | 'add_transition'
    | 'change_requirement'
    | 'add_evidence_kind'
    | 'add_obligation_kind'
    | 'change_effect'
    | 'change_supervisor_guidance'
    | 'change_participant_template'
    | 'state_model_refinement'
  patch: unknown
  rationaleSummary: string
  replayExpectations?: Array<{
    historicalTaskId: string
    expectedBehavior: string
  }>
  status: 'proposed' | 'accepted' | 'rejected' | 'published'
  createdBy: ActorRef
  createdAt: string
}
```

This gives you the desired convergence property: early workflows rely more heavily on the supervisor; common edge cases become definitions, evidence contracts, and dispatch/recovery guidance; the supervisor remains for novel cases and quality control.

## Relationship to JobFlow, InputAdmission, Coordination, and conversation

### JobFlow

Keep JobFlow narrow. A Job can trigger a workflow supervision run or a participant run, but JobFlow should not become a DAG/workflow engine. Scheduling and workflow governance are separate concerns.

Examples:

```text
nightly job -> launches eval_campaign supervisor
cron trigger -> resumes waiting deployment workflow at release window
webhook job -> creates support_escalation Task and starts supervisor
```

### InputAdmission

InputAdmission already has the right discipline: canonical `SessionRef`, durable admission, idempotency, queued/active-run semantics, and no fake promises. Workflow commands should copy that pattern.

Use InputAdmission when the supervisor sends input to an active participant run:

```text
supervisor control action: send_input_to_run
-> ACP admission record keyed by participant SessionRef
-> HRC applies to active run if supported, or queues/rejects according to policy
-> result linked back to supervisor decision and Task
```

### CoordinationSubstrate

Coordination should own handoff/wake state, not workflow policy.

Workflow kernel emits:

```text
EffectIntent: declare handoff
EffectIntent: wake role session
```

Coordination materializes:

```text
CoordinationEvent
Handoff
WakeRequest
RingState slice
```

The workflow ledger remains the source of truth for why the effect was emitted.

### Conversation surface

Conversation is a human-facing projection. It can show supervisor summaries, participant outputs, obligations, handoffs, and patch proposals, but it should not become the workflow ledger.

Human-visible messages should link to workflow events, runs, evidence, and obligations. They should not define them.

## Non-code flows this model should handle

The proposed kernel/supervisor split is useful precisely because it does not bake in code workflow assumptions.

### Incident response

```text
phases: triage -> mitigate -> verify -> postmortem
roles: incident_commander, investigator, mitigator, verifier, comms
obligations: customer_update_due, vendor_response, rollback_window
supervisor behavior: launch investigator/mitigator, request human incident decisions, track timers, ensure postmortem evidence
```

### Research / investigation

```text
phases: question -> evidence_collection -> synthesis -> review -> archived
roles: researcher, reviewer
obligations: missing_source, hypothesis_clarification
supervisor behavior: spawn child research tasks, compare evidence, avoid premature closure
```

### Evaluation campaign

```text
phases: design -> run_eval -> analyze -> accept_or_reject -> archive
roles: eval_designer, runner, analyst, reviewer
obligations: dataset_access, budget_approval, flaky_run_diagnosis
supervisor behavior: schedule jobs, launch runners, create child tasks for failures, aggregate evidence
```

### Customer support escalation

```text
phases: intake -> reproduce -> diagnose -> resolve -> customer_confirmed
roles: support, engineer, customer_proxy
obligations: customer_response, logs_needed, fix_confirmation
supervisor behavior: request human/customer input, launch engineering participant, keep task waiting without failure
```

### Procurement / legal / approval workflow

```text
phases: request -> review -> negotiation -> approved -> executed
roles: requester, legal, finance, approver
obligations: contract_redlines, budget_approval, vendor_response
supervisor behavior: wait on humans, track obligations, avoid fake closure
```

These flows prove why `waiting + obligations`, child tasks, effects, and supervisor recovery are more important than a bigger phase graph.

## Agent/harness requirements

The primary user is an LLM agent inside a harness. Design everything around that.

### The harness needs exact affordances

Every context should include:

```text
current Task state and version
workflow id/version/hash
actor and role identity
allowed commands with full argument templates
legal transitions and why they are legal
unavailable transitions and stable rejection reasons
missing evidence / blocking obligations
idempotency prefix
context hash
expected version
```

### The harness needs durable restartability

A fresh harness with no transcript should be able to resume from:

```text
Task projection
WorkflowDefinition
WorkflowEvent ledger
Evidence
Obligations
Run summaries
Effect states
Supervisor/Participant context compiler
```

Transcript continuity is useful but must not be required for correctness.

### The harness needs stable rejection codes

Recommended core rejection codes:

```text
unknown_transition
state_mismatch
role_not_allowed
role_not_bound
authority_not_granted
sod_violation
missing_evidence
invalid_evidence
open_blocking_obligation
approval_required
waiver_required
version_conflict
context_stale
idempotency_conflict
workflow_definition_mismatch
effect_not_allowed
capability_not_granted
```

Each rejection should include remediation hints when safe:

```json
{
  "code": "missing_evidence",
  "transitionId": "verify",
  "missingEvidenceKinds": ["verification_report"],
  "suggestedActions": ["attach_evidence", "launch_participant_run:tester"]
}
```

### The harness needs atomic evidence-plus-transition

For agents, separate evidence attach then transition is sometimes brittle. Support both standalone evidence and atomic transition with inline/selected evidence.

```bash
acp task transition \
  --task "$ACP_TASK_ID" \
  --transition implement_fix \
  --expected-version 3 \
  --from-run "$ACP_RUN_ID" \
  --evidence commit_ref=git:commit:abc123 \
  --evidence-file regression_test=./test-result.json \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:transition:implement_fix:v3" \
  --json
```

## Recommended API surface

### Create Task

```http
POST /workflow-tasks
```

```ts
type CreateWorkflowTaskRequest = {
  workflow: { id: string; version: number } | { definition: WorkflowDefinition }
  projectId: string
  goal: string
  risk?: string
  initialFacts?: Record<string, unknown>
  roleBindings?: RoleBindings
  supervisor?: SupervisorBinding
  idempotencyKey: string
}
```

### Start/resume supervisor

```http
POST /workflow-supervisor-runs
```

```ts
type StartSupervisorRunRequest = {
  taskId?: string
  createTask?: CreateWorkflowTaskRequest
  supervisor: ActorRef
  autonomy: 'observe' | 'recommend' | 'managed' | 'autonomous'
  harness?: HrcHarnessIntent
  idempotencyKey: string
}
```

### Launch participant

```http
POST /workflow-participant-runs
```

```ts
type LaunchParticipantRunRequest = {
  taskId: string
  role: string
  actor: ActorRef
  parentSupervisorRunId?: string
  harness?: HrcHarnessIntent
  idempotencyKey: string
}
```

### Submit supervisor control action

```http
POST /workflow-control-actions
```

```ts
type SubmitControlActionRequest = {
  taskId: string
  supervisorRunId: string
  contextHash: string
  expectedTaskVersion?: number
  action: WorkflowControlAction
  idempotencyKey: string
}
```

### Apply transition

```http
POST /tasks/{taskId}/transitions
```

```ts
type ApplyTransitionRequest = {
  transitionId: string
  actor: ActorRef
  role?: string
  expectedTaskVersion: number
  contextHash?: string
  evidenceRefs?: string[]
  inlineEvidence?: EvidenceInput[]
  waiverRefs?: string[]
  runId?: string
  idempotencyKey: string
}
```

### Compile contexts

```http
GET /tasks/{taskId}/participant-context?role=implementer&runId=run_...
GET /tasks/{taskId}/supervisor-context?runId=run_...
```

Contexts should be recompiled on demand rather than persisted as truth. Persist their hash on runs/decisions/events.

## Implementation path

Recommended sequence:

1. **Introduce new state model**: `state.status`, `state.phase`, `state.outcome`; stop extending phase with lifecycle words.
2. **Introduce `WorkflowDefinition` registry**: convert existing presets into definitions; keep their behavior equivalent at first.
3. **Transition by `transitionId`**: deprecate `toPhase`; compile legal transitions into context.
4. **Mandatory idempotency**: implement workflow mutation idempotency with payload fingerprints.
5. **Role binding hardening**: replace string-only `RoleMap` with compact `RoleBindings`; validate actor/role binding from run/session/auth context.
6. **Evidence-plus-transition**: allow atomic evidence attachment and transition application.
7. **Obligations**: implement typed blocking/non-blocking obligations; replace `blocked/resume` semantics.
8. **EffectIntent outbox**: move hardcoded handoffs into definition-driven effects.
9. **ParticipantContext**: create machine-readable context and `acp task run` surface.
10. **SupervisorContext and control actions**: create `acp workflow supervise` and the supervisor loop.
11. **Anomalies and patch proposals**: let the supervisor capture edge cases and propose definition updates.
12. **Explicit migration**: add workflow version migration only after the new pinned model is stable.

## What to delete or avoid

Delete/avoid these early, even if it is a breaking change:

```text
- lifecycleState as a top-level string enum
- completed/cancelled as statuses instead of closure outcomes
- blocked + resume as the durable wait model
- transition requests by toPhase
- preset-specific transition handler branches
- hardcoded red->green tester handoff logic
- preset-less durable workflows
- self-declared role authority
- hidden policy in prompt text
- arbitrary expression languages inside WorkflowDefinition
- BPMN/DAG-style process engine ambitions in JobFlow
- using conversation transcript as workflow truth
```

## Final recommendation

Make the kernel smaller and more exact, not broader:

```text
WorkflowDefinition is the contract.
Task is the durable workflow instance.
WorkflowEvent is the audit trail.
Evidence and Obligations are first-class.
EffectIntent is the only side-effect boundary.
ParticipantContext and SupervisorContext are the agent-facing APIs.
Supervisor is adaptive control, not a role bypass.
Presets are immutable workflow definitions plus guidance, not special runtime code.
```

The spec should be bold about the breaking model change. Keeping `lifecycleState`, `toPhase`, `blocked/resume`, and preset-specific paths will create legacy debt exactly where ACP needs the strongest semantics.

The durable design is a narrow deterministic kernel surrounded by an LLM supervisor that can keep work moving under ambiguity. That division gives you adaptability now and a path to reduce supervisor discretion over time as recurring edge cases become better workflow definitions.
