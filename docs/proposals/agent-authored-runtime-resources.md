# Agent-Authored Runtime Resources

Status: approved by Daedalus; event-hooks folded into T-04867 and T-04868

## Thesis

Praesidium should let an agent directory declare the runtime resources it wants:
scheduled jobs, external-channel bindings, typed agent tools, and eventually
sandbox/workspace policies. Those files should not replace the existing
centralized stores. ASP should read and canonicalize those files into a
deterministic desired-state plan. ACP should validate that plan, record
provenance, expose apply/status, and mutate the operational stores that already
own leases, routing, delivery, idempotency, and history.

The design goal is to make `~/praesidium/var/agents/<agent>/` readable as the
agent's authored contract without moving mutable runtime state back into files.

## Why Now

Vercel's Eve shape makes an agent inspectable as one filesystem app:
instructions, tools, skills, channels, schedules, sandbox, subagents, and evals
live near each other. Praesidium already has stronger local runtime primitives:
HRC sessions, ACP gateways, wrkq tasks, hrcchat, spaces, harness abstraction,
event stores, and real e2e validation. What it lacks is the same clean authored
surface.

Today, the operator can inspect Cody's `SOUL.md`, `agent-profile.toml`,
`context-template.toml`, local `skills/`, and composed spaces. But an agent's
Discord bindings and jobs are in ACP operational stores, and the relationship
between those rows and the agent's authored identity is implicit. That makes the
system harder to audit, harder to migrate, and easier to drift.

## Current State

### ASP agent homes

Agent homes live under `~/praesidium/var/agents/<agent>/`.

Known authored files and directories include:

- `SOUL.md`
- `agent-profile.toml`
- `context-template.toml`
- `skills/`
- `commands/`
- `tools/bin`
- `spaces/` for agent-local spaces in some agents
- `memory/` for curated agent notes

ASP already detects agent-local `skills/`, `commands/`, and `tools/bin`.
Skills and commands become a synthetic plugin. Tools are exposed through PATH
with `ASP_AGENT_*` state/cache/log/project directories.

### ACP scheduled jobs

`acp-jobs-store` owns job records, schedule denormalization, due-time indexes,
event triggers, job runs, leases, flow step runs, retries, event match outcomes,
resolved action snapshots, and event-inbox idempotency. The `jobs` table
includes identity and target fields such as
`project_id`, `agent_id`, `scope_ref`, `lane_ref`, `trigger_kind`,
`trigger_json`, `schedule_cron`, `input_json`, `flow_json`, `disabled`,
`last_fire_at`, and `next_fire_at`.

Those rows are the correct operational representation because a scheduler needs
fast due queries, atomic claim/update semantics, and durable run history.

### ACP interface bindings

`acp-interface-store` owns interface bindings, inbound message source
idempotency, delivery requests, outbound attachments, and last delivery context.
The active binding lookup is unique on `(gateway_id, conversation_ref,
thread_ref)` and resolves to structured scope fields: `project_id`, `agent_id`,
optional `task_id`, optional `role_name`, and `lane_ref`.

Those rows are the correct operational representation because gateway-discord
needs fast routing and delivery bookkeeping independent of source-file access.

## Proposed Model

Introduce an agent-authored resource layer:

```text
var/agents/<agent>/
  schedules/
    *.toml
  channels/
    *.toml
  event-hooks/
    *.toml
  tools/
    bin/
    definitions/
      *.toml | *.json
  sandbox/
    default.toml
  evals/
    *.toml | *.md
```

Initial scope should implement `schedules/`, `channels/`, and `event-hooks/`.
The other directories are reserved vocabulary so the model is extensible, but
they should not be partially implemented in the first cut.

### Canonical Nouns

Agent resource:

An authored file under an agent root that declares desired runtime capability.
It has a stable resource name, kind, source-owner scope, source path, source
hash, and canonical desired projection hash.

Managed projection:

A row in an operational store that was created or updated from an agent
resource. The operational row remains lean; ACP-owned provenance linking it back
to the source file and canonical desired shape lives in companion tables inside
the owning store DB.

Operational state:

Mutable runtime fields owned only by ACP/HRC stores. Examples: `next_fire_at`,
`last_fire_at`, job run leases, delivery request status, gateway message refs,
message-source idempotency records, and last delivery context.

Reconciler:

The ACP apply/status component that validates desired projections and applies
create/update/disable operations through store APIs. ASP only compiles and
submits deterministic desired state.

Drift:

A mismatch between a live operational row and the canonical desired projection
recorded for its source resource. Source hash alone is not enough: the source
file may be unchanged while a generic ACP admin command changed the live row.

Adoption:

An explicit operator action that converts an existing manual store row into a
managed projection for a source file.

## Ownership Rules

1. Source files own desired config only.
2. ACP stores own operational state only.
3. Reconciliation is one-way: files compile into stores. Runtime mutations never
   edit source files.
4. Managed projections must carry ACP-owned provenance in the same store DB as
   the row they manage.
5. Manual rows remain valid and unmanaged; they have no provenance row.
6. Reconcile must fail on collisions unless adoption is explicit and proves the
   intended current live row.
7. File deletion disables managed projections by default, preserving runtime
   history. Archive/prune is a later explicit retention operation.
8. Store APIs remain the execution boundary. The compiler should not write ACP
   SQLite directly.
9. V1 resources are same-owner only: an agent-authored resource may target the
   same agent/project/lane as the source owner, unless ACP later implements an
   explicit delegation mechanism.

## Provenance Contract

Each managed operational row needs provenance, but that provenance should not
widen hot operational tables. Use companion tables in the owning ACP store DBs:

- `acp-jobs.db` owns scheduled-job and event-hook provenance transactionally
  with `jobs`.
- `acp-interface.db` owns interface-binding provenance transactionally with
  `interface_bindings`.

Do not introduce one central cross-store provenance table for v1. A single
logical apply may touch both stores, but each store must atomically update its
own operational row plus its own provenance row.

Recommended per-store companion table shape:

```ts
type ManagedResourceProjection = {
  projectionId: string
  resourceKind: 'scheduled-job' | 'event-hook' | 'interface-binding'
  projectionTable: 'jobs' | 'interface_bindings'
  projectionPk: string
  sourceOwnerScopeRef: string
  resourceName: string
  sourcePath: string
  sourceHash: string
  desiredProjectionHash: string
  desiredJson: Record<string, unknown>
  sourceVersion: 1
  managedBy: 'agent-directory'
  origin: 'created' | 'adopted'
  lastReconciledAt: string
  createdAt: string
  updatedAt: string
}
```

`resourceName` is stable within a source owner scope. `sourcePath` is relative
to the agent root. `sourceHash` is computed from normalized parsed content, not
raw TOML bytes, so formatting-only changes do not churn projections.
`desiredProjectionHash` is computed from the canonical ACP projection shape that
apply intends to enforce. `desiredJson` is optional if the hash can always be
recomputed from stored source metadata, but storing the canonical desired JSON
makes drift reports explainable.

Required uniqueness:

- `(managed_by, source_owner_scope_ref, resource_kind, resource_name)`
- `(projection_table, projection_pk)`

`adopted` is an origin/action state, not a drift policy. Manual rows have no
provenance record.

## Schedule Resources

Example:

```toml
schema = 1
name = "daily-triage"
title = "Daily triage"
enabled = true

[target]
project = "agent-spaces"
agent = "cody"
lane = "main"
task = "primary"

[trigger]
kind = "schedule"
cron = "0 8 * * 1-5"
windowStart = "08:00"
windowEnd = "18:00"

[input]
content = "Review new inbox tasks and summarize the highest-risk platform work."
```

Compilation result:

- ACP job slug: stable and namespaced, derived from source owner agent plus
  resource `name`, or ACP-generated with provenance as the resource identity
- `projectId`, `agentId`, `scopeRef`, `laneRef`: from `[target]`
- `trigger`: schedule trigger
- `schedule`: current ACP schedule fields only: `cron`, `windowStart`,
  `windowEnd`, `windowMinutes`
- `input`: job input template
- `disabled`: inverse of `enabled`
- provenance: source path, source hash, desired projection hash, desired JSON

The job store still derives `schedule_cron`, `schedule_json`, and
`next_fire_at`. Reconcile must not set or reset `last_fire_at` except through
existing job update behavior. Job run history remains attached to the same job
when the source file changes.

V1 must not publish `timezone` semantics. ACP cron evaluation is currently
UTC-only and current trigger validation does not provide timezone behavior.
Either implement timezone support in ACP first or reject `timezone` as an
unsupported v1 field.

Deletion policy:

- If the source file disappears, disable the job by default.
- Archive/prune is a later explicit retention operation, not part of default
  reconcile.
- Never delete job runs, event-inbox records, leases/history, delivery-adjacent
  runtime facts, or other scheduler-owned operational state.

## Event Hook Resources

Use `event-hooks/`, not bare `hooks/`. Bare `hooks/` is reserved because it is
already overloaded with harness and shell hook concepts.

An event hook is an authored desired subscription that compiles to one managed
ACP event-triggered job. The resource kind is `event-hook`; the ACP projection
is a `jobs` row with `trigger.kind = 'event'`. Do not introduce a second hook
engine.

Example:

```toml
schema = 1
name = "wrkq-needs-smoketest"
title = "Smokey handles wrkq needs_smoketest"
enabled = true

[event]
source = "wrkq"

[match]
event = ["updated", "transitioned"]
project_scope_id = "agent-spaces"
kind = "task"

[match.transition]
to = "needs_smoketest"

[target]
project = "{{ project_scope_id }}"
agent = "smokey"
lane = "main"
task = "{{ticket_id}}"

[input]
content = "Run the smoke-test workflow for {{ticket_id}}."

[originPolicy]
agent = "deny"

[cooldown]
seconds = 300
```

The file must live under the source-owner/target agent root. In v1,
`var/agents/smokey/event-hooks/wrkq-needs-smoketest.toml` may target Smokey;
Cody's agent root must not declare a cross-agent event hook to Smokey.
Cross-agent authored subscriptions require a later ACP delegation model.

Target policy:

- Generic ACP events use static targets only.
- For `source = "wrkq"`, target templating is limited to source-allowlisted
  structural fields derived from the canonical ACP event:
  `project_scope_id` for project and `ticket_id` for task.
- Lane is static in v1.
- Do not allow `payload.*`, title, labels, container path, or arbitrary fields
  into scope, task, role, or lane.
- All target expansion must fail closed and then pass SessionRef normalization
  before ACP mints a run.

Runtime ownership:

- Source files own only match, target, and input policy.
- ACP owns webhook ingest, `event_inbox`, event/job match outcomes, origin
  policy, cooldown enforcement, resolved action snapshots, job runs, dispatch,
  audit, provenance, drift, and deletion semantics.
- Reconcile may create/update/disable the managed job projection and
  provenance. It must never mutate event inbox rows, event-job outcome rows, job
  runs, leases, resolved snapshots, or webhook history.

Safety defaults:

- `originPolicy.agent` defaults to `deny`.
- A hook must declare an explicit cooldown, or ACP must apply a conservative
  default.
- Authored cooldown syntax may be TOML-shaped, but the compiled ACP job
  projection must contain ACP's canonical `EventTrigger.cooldown` duration
  value, or an ACP-defined conservative default. Do not emit `[cooldown]` as an
  untyped object in the job trigger.
- Malformed cooldowns fail validation before apply.
- Future `originPolicy.agent = "allow"` requires separate architecture review;
  it must not become an accidental field pass-through.
- `/v1/webhooks/events` is loopback-trusted, not internet-safe. Event hooks are
  not external integrations until source authentication/signing exists.

## Channel Resources

Example:

```toml
schema = 1
name = "discord-smoke"
enabled = true

[gateway]
id = "acp-discord-smoke"
type = "discord"

[conversation]
ref = "channel:1501224513390772224"

[target]
project = "agent-spaces"
agent = "cody"
lane = "main"
task = "primary"
```

Compilation result:

- ACP interface binding lookup: `gatewayId`, `conversationRef`, optional
  `threadRef`
- Routing fields: `scopeRef`, `laneRef`, `projectId`, `agentId`, optional
  `taskId`, optional `roleName`
- `status`: active or disabled
- provenance: source path, source hash, desired projection hash, desired JSON

The interface store still owns message sources, delivery requests, outbound
attachments, delivery status, and last delivery context.

Deletion policy:

- If the source file disappears, disable the binding.
- Preserve delivery history and message-source idempotency rows.
- Preserve delivery requests and last-delivery context.
- Manual re-enablement of a managed disabled binding without source should be
  reported as drift.

Collision policy:

- If another active binding already owns the same lookup tuple, reconcile fails.
- If the existing binding is unmanaged, adoption requires an explicit command.
- If the existing binding is managed from a different source, reconcile fails
  with both source refs.
- Managed apply must not reuse generic interface binding setter semantics
  blindly. The existing generic setter upserts by lookup; managed apply must
  fail closed on unmanaged or differently managed lookup collisions.
- Adoption must name the live row id and prove the current fingerprint or
  `updatedAt` value so a stale adoption cannot race an operator edit.

## Reconcile Surface

Add an explicit apply flow rather than implicit runtime mutation:

```text
asp resources plan <agent> --project <project>
asp resources apply <agent> --project <project>
asp resources status <agent> --project <project>
```

Under the hood, `asp resources apply` should call ACP admin APIs. It should not
import ACP store packages into ASP or write ACP SQLite files directly.

ACP should expose narrowly scoped apply endpoints or CLI commands. The primary
mutation surface belongs in ACP because ACP owns the invariant at the store
boundary:

```text
acp admin managed-resource plan --owner agent:cody:project:agent-spaces --body-file -
acp admin managed-resource apply --owner agent:cody:project:agent-spaces --body-file -
acp admin managed-resource status --owner agent:cody:project:agent-spaces
```

The payload should contain compiled desired projections, not arbitrary SQL-ish
patches. ACP owns validation against store constraints.

A single logical apply can include schedules, event hooks, and channels, but v1
cannot assume cross-DB atomicity between `acp-jobs.db` and
`acp-interface.db`. Batch apply must report per-resource outcomes and be
idempotent on retry. If ACP later adds an operation ledger, that ledger can
strengthen batch recovery, but store-local provenance remains per owning DB.

## Lifecycle

Authored:

The file exists and parses.

Planned:

The compiler resolved source-owner scope, target scope, gateway identifiers,
schedule trigger, canonical source hash, and canonical desired projection hash.

Applied:

ACP created or updated the operational row and recorded provenance in the same
store transaction.

Drifted:

The live operational row no longer matches the canonical desired projection
hash/JSON recorded for the source resource.

Disabled:

The source says `enabled = false` or the source file disappeared under the
default deletion policy.

Adopted:

An existing manual row has been explicitly linked to a source file.

Archived:

A formerly managed projection has been retired by explicit retention/prune
operation, preserving history.

## Failure Modes

Invalid source file:

Plan fails before any ACP mutation. Errors point to source path and field.

Missing gateway:

Plan may succeed with warning, but apply fails unless ACP can validate the
gateway. Prefer fail at apply because gateways are runtime-owned.

Binding collision:

Apply fails without mutation and reports both desired source and existing row.
This must be enforced by the managed-resource path, because generic interface
binding creation currently uses lookup upsert semantics.

Schedule update during due claim:

ACP store update remains transactional. Reconcile only touches job config. The
scheduler retains existing claim-and-lease semantics.

Operator break-glass edit:

If a managed row is edited through ACP admin commands, status reports drift.
Depending on policy, apply either restores source state or fails and asks for
manual detachment. Same-source apply must never silently adopt break-glass
changes as the new desired state.

Agent rename:

Managed rows are tied to source owner scope. Rename is a migration: create new
source owner, adopt or transfer projections, then disable old owner.

## Implementation Plan

Phase 1: Read-only compiler and plan output in ASP.

- Add schema and parser for `schedules/*.toml`, `channels/*.toml`, and
  `event-hooks/*.toml`.
- Resolve source-owner scope and same-owner target scope using existing
  agent/profile/project context.
- Generate a stable normalized source hash and desired projection hash.
- Reject unsupported v1 fields, including `timezone`; reject cross-owner
  targets.
- For event hooks, reject bare `hooks/`, reject generic-event target templates,
  allow only wrkq source-allowlisted structural templates for `project_scope_id`
  and `ticket_id`, reject payload-derived or arbitrary structural templates,
  and canonicalize authored cooldown into ACP's `EventTrigger.cooldown` duration
  value or a declared ACP conservative default.
- Add `asp resources plan` with machine-readable JSON and human summary.
- No ACP mutations yet.

Phase 2: ACP managed-resource apply surface.

- Add companion provenance tables in `acp-jobs.db` and `acp-interface.db`.
- Add apply APIs for scheduled jobs, event hooks, and interface bindings.
- Reuse existing job and binding repos for store writes, but wrap them in
  managed-resource collision/adoption checks rather than generic upsert
  semantics.
- Implement collision, adoption-required, disable-on-missing, and drift status.
- Add required provenance uniqueness on source identity and projection row.
- Adoption requires explicit live row id plus current fingerprint/updatedAt so a
  stale adoption cannot race an operator edit.
- Event hooks compile to managed `jobs` rows with `trigger.kind = 'event'`;
  reuse ACP's existing event-job substrate rather than adding a second hook
  engine.
- Event-hook apply validates that `trigger.cooldown` is ACP's canonical
  `EventTrigger.cooldown` duration value or an ACP-defined conservative default,
  never an untyped authored TOML object.
- Event-hook apply/status must preserve webhook ingest, `event_inbox`,
  event-job match outcomes, cooldown enforcement, leases, resolved action
  snapshots, job runs, dispatch, audit, and webhook history.
- Return per-resource outcomes for mixed schedule/event-hook/channel batches.

Phase 3: ASP apply/status integration.

- Wire `asp resources apply/status` to ACP admin surface.
- Add dry-run and diff output.
- Ensure plan/apply does not cross repo boundaries by direct imports.

Phase 4: operational validation.

- Create one schedule resource, one event hook resource, and one Discord binding
  resource for a low-risk agent/gateway.
- Run `just install`, restart ACP once, and validate through live ACP CLI and
  Discord route where applicable.
- Confirm history survives disable/re-enable.
- Validate one real wrkq transition to `needs_smoketest`, with event inbox,
  match, job-run evidence, and the admitted Smokey turn on the expected
  ScopeRef/lane.

Phase 5: reserve but do not implement typed tools/sandbox/evals.

- Document reserved directories and future compiler extension points.
- Do not ship partially functional directories that imply unsupported behavior.

## Required Tests

ASP compiler fixture tests:

- Deterministic plan JSON from schedule, channel, and event-hook fixtures.
- Stable normalized source hash across TOML formatting/comment changes.
- Stable desired projection hash for semantically identical resources.
- Rejection of unsupported or unknown v1 fields, including `timezone`.
- Rejection of cross-owner targets in v1.
- Rejection of bare `hooks/`.
- Static target enforcement for generic ACP event hooks.
- For wrkq event hooks, allow only structural templates for `project_scope_id`
  and `ticket_id`.
- Rejection of payload-derived structural templates such as `payload.*`, title,
  labels, container path, or arbitrary fields.
- Canonical cooldown projection to ACP's `EventTrigger.cooldown` duration value
  or ACP-defined conservative default.
- Rejection of malformed cooldowns before apply.

ACP apply tests:

- Create managed scheduled-job projection and companion provenance in the same
  store transaction.
- Create managed event-hook projection as a `jobs` row with
  `trigger.kind = 'event'` and companion provenance in the same store
  transaction.
- Create managed interface-binding projection and companion provenance in the
  same store transaction.
- Re-apply identical desired state idempotently without duplicate operational
  rows or provenance rows.
- Preserve stable job/binding identity across source edits that update desired
  config.

Collision and adoption tests:

- Unmanaged job slug collision fails closed.
- Unmanaged binding lookup collision fails closed.
- Managed-from-other-source collision reports both source refs.
- Explicit adoption succeeds only with the current row id plus current
  fingerprint or `updatedAt`.
- Explicit adoption fails when stale.

Drift tests:

- Mutate a managed job through existing generic admin paths; status detects
  desired-shape drift.
- Mutate a managed binding through existing generic admin paths; status detects
  desired-shape drift.
- Apply follows the documented policy without silently treating break-glass
  state as the new desired state.

Deletion tests:

- Missing schedule source disables the managed job and preserves job runs.
- Missing event-hook source disables the managed event-triggered job and
  preserves `event_inbox`, event-job match outcomes, resolved snapshots, and job
  runs.
- Missing channel source disables the managed binding and preserves delivery
  requests, message-source idempotency, and last-delivery context.
- Re-adding the source reuses or relinks the prior projection according to the
  stated identity rule.

Event runtime tests:

- Webhook ingest writes `event_inbox`.
- Matching event hook records event/job outcome.
- Origin agent is blocked by default.
- Cooldown suppresses repeated target mints.
- Event-triggered jobs reject untyped cooldown objects and accept only canonical
  cooldown duration values/defaults.
- Resolved scope/input snapshots are used for dispatch.
- Bad or missing template values fail closed and record `template_error`, not a
  malformed dispatch.

Mixed-store apply tests:

- A schedule plus event-hook plus channel batch where one store operation fails
  returns machine-readable per-resource outcomes.
- Retrying the same batch converges without duplicate rows.
- If ACP adds an operation ledger, tests prove the ledger gives stronger
  recovery than per-resource retry.

Live validation:

- Run real installed `asp resources plan`.
- Run ACP managed-resource apply/status against real config.
- Exercise one schedule through the installed job path.
- Exercise one real wrkq transition to `needs_smoketest`, with event
  inbox/match/job-run evidence and the admitted Smokey turn on the expected
  ScopeRef/lane.
- Validate one Discord binding through a real Discord route with delivery and
  history evidence.

## Acceptance Criteria

1. Agent directories can declare schedule, channel, and event-hook resources in
   stable, documented file formats.
2. ASP can produce a deterministic plan from those files without mutating ACP.
3. ACP can apply compiled desired state into existing job/interface stores with
   explicit per-store provenance.
4. Existing runtime stores remain authoritative for mutable operational state.
5. Managed rows report source path, source hash, desired projection hash,
   source owner, and drift status.
6. Collisions fail closed and adoption is explicit.
7. Deleting a source file disables managed projections without deleting
   run/delivery history; archive/prune is explicit and later.
8. The design preserves repo boundaries: ASP compiles desired resources; ACP
   validates and mutates ACP stores.
9. Live validation covers at least one schedule, one event hook driven by a real
   wrkq transition, and one Discord binding using real installed commands and,
   for gateway behavior, real Discord route evidence.
10. V1 rejects unsupported fields such as `timezone`, rejects bare `hooks/`, and
    rejects unsafe event-hook target templates.
11. Mixed schedule/event-hook/channel apply failures are machine-readable and
    converge on retry, unless ACP adds an operation ledger with stronger batch
    semantics.

## Out of Scope

- Replacing ACP jobs or interface stores with files.
- Moving delivery history, message idempotency, leases, or run history into
  agent directories.
- General plugin marketplace packaging for resources.
- Typed model-callable tool definitions in the first implementation.
- A GUI editor.
- Automatic cross-agent adoption or rename migration.
- Cross-agent or cross-project authored targets in v1.
- Timezone-aware cron semantics unless ACP implements and tests them first.
- Bare `hooks/`; v1 uses `event-hooks/`.
- A second hook engine separate from ACP event-triggered jobs.
- External integration/authentication management such as `connections/`.
- Policies, sandbox, tools/definitions, subagents, evals, observability, and
  session-defaults beyond reserved vocabulary/backlog.
- `originPolicy.agent = "allow"` without separate review.

## Open Questions

1. Should `asp resources apply` be the primary operator command, or should ACP
   own the primary command and ASP only emit plan JSON?
2. What is the correct default owner scope for resources that target a project
   but not a task?
3. Should same-owner v1 use task `primary` by default, or require every resource
   to spell out task/role explicitly?
4. Should ACP add an operation ledger for mixed-store apply batches, or is
   per-resource idempotent retry sufficient for v1?
5. Should ACP define the default event-hook cooldown globally, or should the ASP
   compiler require every event hook to declare one explicitly?

## Architecture Review Notes

Daedalus approved the base proposal in hrcchat #8329, approved folding event
hooks into the same split in hrcchat #8338, and acknowledged the cooldown
canonicalization constraint in #8340. No architecture blockers remain if the
event-hook constraints below are preserved. The approved invariant:

Agent-directory resource files are declarative desired state only. ASP may
parse, canonicalize, hash, and plan; ACP alone validates, records per-store
provenance, applies status/mutation through store APIs, and preserves
operational history. For each managed resource, one source-owner/resource
identity maps to one ACP operational projection row with atomic same-store
provenance; reconcile never writes runtime facts such as leases, job runs,
delivery history, message-source idempotency, last-delivery context, or
`last_fire_at`.

Required changes incorporated from the conditional review:

- Per-store companion provenance tables, not hot-table columns or one central
  cross-store table.
- Provenance tracks both source hash and canonical desired projection
  hash/JSON.
- Source owner and target are distinct concepts; v1 is same-owner only.
- Managed apply must not reuse generic binding upsert semantics.
- Missing source defaults to disable-only; prune/archive is explicit later.
- `timezone` is removed from v1 schedule resources because ACP cron evaluation
  is currently UTC-only.
- Work should be split by ownership: `agent-spaces` for read-only compiler/plan;
  `agent-control-plane` for provenance/apply/status/store invariants.
- Event hooks are folded into the same split under Daedalus #8338:
  `event-hooks/`, resource kind `event-hook`, ACP projection as a `jobs` row
  with `trigger.kind = 'event'`, and no second hook engine.

Residual implementation risks:

- `asp resources apply` must remain only a wrapper over ACP; ACP is the mutation
  authority.
- Generic admin break-glass edits remain possible, so status must surface drift
  and apply must not silently bless drift as desired state.
- Cooldown representation can drift between authored TOML and ACP EventTrigger;
  ASP must canonicalize it and ACP must validate the final projection.
- Operation ledger versus per-resource retry remains an implementation choice,
  provided mixed-store failures are machine-readable and retry converges.
- Event-hook target templating can become a privilege/routing bug. V1 must stay
  same-owner, use static generic targets, and allow only wrkq structural
  templates for `project_scope_id` and `ticket_id`.
- Event hooks can create loops or storms. `originPolicy.agent` defaults to
  `deny`, and hooks require either an explicit cooldown or an ACP-defined
  conservative default.
- `/v1/webhooks/events` is loopback-trusted, not internet-safe; event hooks must
  not be presented as external integrations until source auth/signing exists.

## Split Work Items

- `agent-spaces` T-04867: Phase 1 read-only compiler and
  `asp resources plan` for schedules, channels, and event hooks.
- `agent-control-plane` T-04868: companion provenance tables,
  managed-resource apply/status, event-triggered job projection,
  collision/adoption/deletion semantics, and live validation.
- `agents`: sample resource files only after both schema and apply path land.
