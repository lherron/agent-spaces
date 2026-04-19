# ACP Minimal — Defect Workflow MVP

A self-contained briefing for a fresh Claude Opus instance picking up this work.
Everything needed to execute should be in this document or linked from it.

---

## 1. Purpose

Build the minimum ACP surface needed for the `code_defect_fastlane` workflow
(riskClass=medium) to run end-to-end against real agents, with wrkq as the
authoritative Task store. This is a *greenfield* implementation inside this
repo, not a port of the existing `agent-control-plane` prototype.

The existing `/Users/lherron/praesidium/agent-control-plane` repo is to be
treated as archived / read-only. It was a prototype for replicating scenarios;
it accumulated drift (`personaId` residue, in-memory admin store, missing
`/evidence` endpoint — see `../agent-control-plane/acp-spec-drift.md`). Cherry
pick cleanly from it; do not try to migrate it.

## 2. Target workflow

**Preset:** `code_defect_fastlane` version `1` at `riskClass=medium`.

**Phase graph:** `open → red → green → verified → completed`

**Roles:** `triager`, `implementer`, `tester` (required at medium-risk).

**Transition gates** (from
`../acp-spec/spec/orchestration/TASK_WORKFLOWS.md §5.2`):

| From → To | Allowed role | Required evidence |
|---|---|---|
| `open → red` | triager or implementer | `tdd_red_bundle` (repro + base build/version) |
| `red → green` | implementer | `tdd_green_bundle` (fix ref + now-passing test) |
| `green → verified` | **tester** (required at medium-risk; SoD: `disallowSameAgentAsRoles: ["implementer"]`) | `qa_bundle` (smoke + build_ref) |
| `verified → completed` | owner or implementer (policy) | merge/deploy ref |

**End-to-end scenario the MVP must support:**

1. User runs `wrkq touch --project <p> inbox/bug -t "Title"` → creates a Task.
2. Task is promoted to preset-driven: `workflowPreset=code_defect_fastlane`,
   `presetVersion=1`, `riskClass=medium`, role map assigns distinct agents as
   `implementer` and `tester`.
3. Implementer session opens with role-scoped ScopeRef
   `agent:<impl>:project:<p>:task:<t>:role:implementer`, lane `main`. Agent
   sees a GuidancePacket (current phase, required evidence, hints).
4. Implementer produces a repro → attaches `tdd_red_bundle` evidence →
   transitions `open → red`.
5. Implementer writes fix → attaches `tdd_green_bundle` → transitions
   `red → green`.
6. ACP appends a `CoordinationEvent(kind=handoff.declared)`, opens a
   `Handoff(from=implementer, to=tester)`, and enqueues a `WakeRequest`
   targeting the tester's SessionRef — all in one transaction.
7. Tester wakes with role-scoped ScopeRef
   `agent:<test>:project:<p>:task:<t>:role:tester` → verifies → attaches
   `qa_bundle` → transitions `green → verified`. SoD validator rejects if
   `actor.agentId == roleMap.implementer`.
8. Transition `verified → completed` closes the task; merge/deploy ref
   attached as evidence.

This is the smallest cut where the system demonstrates role-scoped
separation-of-duties, transactional handoff, and evidence-gated transitions
against real runtime execution.

## 3. Repo context

- **Monorepo:** `/Users/lherron/praesidium/agent-spaces` to be renamed
  `praesidium-runtime`. Agent-spaces no longer describes its scope — it now
  houses ASP, HRC, ACP, coordination substrate, and (eventually) conversation
  surface.
- **Rename steps:** directory rename, update `package.json` name,
  `asp-lock.json`, `asp-targets.toml`, any internal references, and any
  Justfile/CI paths. `AGENTS.md` should enumerate the planes and their
  authority seams.
- **Archived:** `/Users/lherron/praesidium/agent-control-plane` — read-only;
  used as a scenario-replay reference and a source of lift-able components
  (see §7).
- **wrkq is authoritative** for Task persistence. Its schema is fixed; TS is
  a consumer, never an owner. Schema migrations stay in wrkq's Go code.
  wrkq repo: `/Users/lherron/praesidium/wrkq`
  (`schema_dump.sql`, `WRKQ_STATE_MACHINE_SPEC.md`).

## 4. Spec sources of truth

Read these from `/Users/lherron/praesidium/acp-spec/spec/`:

- `foundations/CONCEPTS.md` — canonical entity definitions
- `foundations/MENTAL_MODEL.md` — authority boundaries
- `contracts/AGENT_SCOPE.md` — ScopeRef/LaneRef/SessionRef grammar
- `contracts/SESSION_EVENTS.md` — streaming/replay contract
- `orchestration/TASK_WORKFLOWS.md` — **primary spec for this work**
  - §2.2 defect preset definition
  - §3 roles + SoD
  - §4 evidence model
  - §5.2 defect transition gates
  - §6 TransitionPolicy validator
  - §6.4 GuidancePacket shape
  - §7.2 dry-run walkthrough
- `orchestration/COORDINATION_SUBSTRATE.md` — required because medium-risk
  triggers implementer → tester handoff
  - §6 entity shapes (CoordinationEvent, Handoff, WakeRequest)
  - §8.1 appendEvent transactional command
- `orchestration/API.md` — HTTP surface for `/tasks`, `/inputs`, `/runs`,
  `/messages`
- `orchestration/CLI.md` — user-facing command shapes
- `runtime/AGENT_SPACES.md` — ASP materialization
- `runtime/HRC.md` / `runtime/HRC_DETAIL.md` — runtime control seam

Entity poster for visual overview:
`/Users/lherron/praesidium/acp-spec/plates/01-entities.tsx`.

## 5. Minimum entities

### Shared upstream (already implemented in this repo)

- `ScopeRef`, `LaneRef`, `SessionRef` — `packages/agent-scope`.
  Already parses `agent:<id>:project:<pid>:task:<tid>:role:<role>` ancestry
  correctly (`packages/agent-scope/src/scope-ref.ts:48-174`). No work needed.

### ACP · Identity & placement (new)

- **Agent** — id + agentRoot only; SOUL.md/HEARTBEAT.md stubs acceptable for
  MVP.
- **Project** — id + rootDir.
- **Membership** — agent × project. Simplified authz: any member may hold
  any role.
- **RuntimePlacement** — already in repo; extend to accept task/role scope
  segments in placement resolution.

### ACP · Dynamic execution (new)

- **Session** — ACP projection of live conversation, keyed by SessionRef.
- **InputAttempt** — idempotent dispatch record.
- **Run** — execution record with dispatch fence (sessionId, generation).

### ACP · Workflow (new, persisted in wrkq via wrkq-lib)

- **Task** — fields: `taskId`, `projectId`, `kind`, `workflowPreset`,
  `presetVersion`, `phase`, `riskClass`, `lifecycleState`, `version`,
  role map.

### Workflow machinery (new, spec TASK_WORKFLOWS.md)

- **WorkflowPreset** — catalog entry for `code_defect_fastlane.v1`.
  Immutable. Carries phaseGraph, TransitionPolicy, guidance templates.
- **TransitionPolicy** — eight-step validator from §6.6.
- **EvidenceItem** — `{kind, ref, contentHash?, producedBy:{agentId,role},
  timestamp, build?:{id,version,env}}` per §4.1.
- **RoleMap** — `task_role_assignments(task_uuid, role, actor_uuid,
  assigned_at)` in wrkq schema-compatible shape.
- **GuidancePacket** — §6.4 packet injected into the run via
  RunScaffoldPacket.

### Coordination substrate (new, required because of tester handoff)

- **CoordinationEvent** — immutable ledger row. For MVP we need at least
  `kind ∈ {"handoff.declared", "attention.requested"}`.
- **Handoff** — first-class record with
  `kind ∈ {"review", "tool-wait", "human-wait"}` (use `"review"` for
  tester); states `open | accepted | completed | cancelled`.
- **WakeRequest** — keyed by canonical SessionRef; states
  `queued | leased | consumed | cancelled | expired`.
- Transactional `appendEvent` command (§8.1) — event + handoff + wake
  written atomically.

### HRC (already implemented)

- `HrcContinuityRecord`, `hostSessionId`, `generation`, `HrcSessionRecord`,
  `HrcLaunchRecord`, `hrc-launch` — present in
  `packages/hrc-core`, `packages/hrc-server`. No new work.

### ASP (already implemented; one extension needed)

- `agentRoot`, `SOUL.md`, `HEARTBEAT.md`, `agent-profile.toml` — scaffolds OK
- `space:agent:`, `space:project:`, `RuntimeBundleRef`, `ResolvedInstruction`,
  `ResolvedSpace`, `ResolvedRuntimeBundle`, `InvocationSpec` — all present
- **`RunScaffoldPacket`** — plumbing exists; **needs to carry the
  GuidancePacket**. Required changes:
  - `packages/config/src/resolver/placement-resolver.ts` — read
    `correlation.sessionRef`, look up task phase via wrkq-lib, compose
    GuidancePacket.
  - `packages/runtime/src/system-prompt.ts` — accept packet and compose into
    system prompt.
  - `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts` —
    `buildHrcCorrelationEnv()` adds `HRC_TASK_ID`, `HRC_TASK_PHASE`,
    `HRC_TASK_ROLE`.

### Deferred (explicitly out of scope for this MVP)

- `DeliveryRequest` — outputs go to stdout + task evidence; gateway delivery
  later.
- `Job` / `JobRun` — defects are not scheduled.
- `ConversationThread` / `ConversationTurn` — CLI + wrkq views serve as the
  human surface for MVP.
- `InterfaceIdentity` / `Binding` — no gateway ingress; intake is
  `wrkq touch inbox/bug`.
- `Waiver` — no break-glass until a real incident demands it.
- `code_feature_tdd` preset — defect fastlane is the only preset in the MVP
  catalog. The escalation rule ("auth/security/billing/data migrations →
  auto-escalate to `code_feature_tdd`") can stub-error until that preset
  lands.

## 6. Architectural decisions already made

1. **Greenfield in this repo**; do not uplift the old ACP.
2. **Monorepo rename:** `agent-spaces` → `praesidium-runtime`.
3. **wrkq-lib is a TypeScript library over wrkq's SQLite file** — direct
   DB access. No daemon, no RPC, no wrkq CLI subprocess. Schema migrations
   remain in wrkq's Go code; TS never writes DDL.
4. **Task is persisted in wrkq.** All new task-related tables
   (`task_role_assignments`, `evidence_items`, `waivers`, `task_transitions`)
   must be proposed as wrkq schema additions — they live in wrkq's repo,
   not here. Coordinate with wrkq owner before adding.
5. **Preset catalog lives in TS** (`packages/acp-core/src/presets/`), not in
   wrkq. Presets are code, not data. Pinned per task via
   `workflowPreset` + `presetVersion` fields on the task row.
6. **Coordination substrate is SQLite-backed** (a separate file from wrkq's
   SQLite; or a separate schema namespace in the same file — decide based on
   lock-contention preference). Transactionally linked to wrkq only through
   `links.taskId` — no cross-database foreign keys.
7. **SoD enforcement is mandatory for MVP.** The `green → verified`
   validator must compare `actor.agentId` against the recorded implementer
   in the role map and reject identity.
8. **Medium-risk is the MVP default** for defect fastlane. Low-risk
   self-verify works too but is not the demo path.
9. **ASP role overlays are deferred.** Role-specific SOUL.md swaps are not
   in scope for MVP. The GuidancePacket carries role-specific agentHints,
   which is sufficient.

## 7. New packages to build

```
praesidium-runtime/
  packages/
    wrkq-lib/                   # TS over wrkq SQLite
    acp-core/                   # preset catalog, validator, models
    acp-server/                 # HTTP surface
    acp-cli/                    # user-facing CLI (or fold into packages/cli)
    coordination-substrate/     # event ledger + handoffs + wake queue
    conversation-surface/       # stub only for MVP
```

### 7.1 `packages/wrkq-lib`

Scope: open wrkq's SQLite file at a path provided by caller. Provide typed
reads and writes for:
- `tasks` (existing schema + new fields: `workflow_preset`,
  `preset_version`, `phase`, `risk_class` — **coordinate schema changes
  with wrkq owner**)
- `task_role_assignments` (new)
- `evidence_items` (new)
- `task_transitions` (new; audit log)
- `comments`, `attachments`, `actors` (existing, read-only for MVP)

Non-goals: no schema migrations, no business logic, no validation beyond DB
constraints. Thin data layer.

Shape: export typed repository classes (`TaskRepo`, `EvidenceRepo`,
`RoleAssignmentRepo`, `TransitionLogRepo`) with explicit methods. No ORM.
Use `better-sqlite3` or equivalent.

### 7.2 `packages/acp-core`

Contains:
- `src/presets/code_defect_fastlane.v1.ts` — preset definition: phaseGraph,
  `TransitionPolicy` rules with `allowedRoles`, `disallowSameAgentAsRoles`,
  `requiredEvidenceKinds`, `waiverKinds`, plus `guidance` per phase.
- `src/presets/registry.ts` — `getPreset(presetId, version): Preset`.
  Immutable.
- `src/validators/transition-policy.ts` — eight-step validator from §6.6.
- `src/models/` — `Task`, `EvidenceItem`, `RoleMap`, `GuidancePacket`,
  `InputAttempt`, `Run`, `Session` types and pure functions.
- `src/wrkq-client.ts` — wraps `wrkq-lib` with ACP semantics (e.g., ensures
  `version` bumping on updates).
- `src/guidance.ts` — derive GuidancePacket from preset + current
  task state.

Depends on: `packages/wrkq-lib`, `packages/agent-scope`.

### 7.3 `packages/acp-server`

HTTP endpoints (match `../acp-spec/spec/orchestration/API.md`):
- `POST /v1/tasks` — accepts `workflowPreset`, `presetVersion`,
  `riskClass`, role map
- `GET /v1/tasks/:taskId` — returns task + current GuidancePacket
- `POST /v1/tasks/:taskId/transitions` — runs TransitionPolicy validator
- `GET /v1/tasks/:taskId/transitions` — audit log
- `POST /v1/tasks/:taskId/evidence` — attach without transitioning
- `POST /v1/inputs` — idempotent input attempt
- `GET /v1/runs/:runId`
- `POST /v1/messages` — append CoordinationEvent + optional handoff/wake
  (via `coordination-substrate`)
- `POST /v1/runtime/resolve` — SessionRef → RuntimePlacement
- `POST /v1/sessions/resolve` — SessionRef → concrete sessionId (delegates
  to HRC)

Server framework: follow existing agent-spaces style (Hono? Fastify? check
what `hrc-server` uses and match).

### 7.4 `packages/acp-cli`

User-facing commands (cherry-pick shape from old ACP):
- `acp task create --preset code_defect_fastlane --preset-version 1
  --risk-class medium --project <p> --role implementer:<a>
  --role tester:<a>`
- `acp task show --task <t>` — renders GuidancePacket
- `acp task evidence add --task <t> --kind <k> --ref <r>
  [--build-ref <b>]`
- `acp task transition --task <t> --to <phase> --actor-role <r>
  --expected-version <n> --evidence <ref>[,...]`
- `acp task transitions --task <t>` — audit log

### 7.5 `packages/coordination-substrate`

SQLite-backed per `COORDINATION_SUBSTRATE.md §5-7`.

Tables:
- `coordination_events` — append-only
- `coordination_event_participants`
- `handoffs`
- `wake_requests`
- `local_dispatch_attempts` — minimal for MVP (no-op acceptable)
- `projection_cursors`
- `coordination_event_links` (taskId, runId, sessionId)

Commands:
- `appendEvent(cmd)` — transactional event + optional handoff + optional
  wake + optional local dispatch
- `listPendingWakes(sessionRef)`, `leaseWake`, `consumeWake`
- `listOpenHandoffs(filter)`, `acceptHandoff`, `completeHandoff`

**Hard rule (§8.2):** wake requests must carry a canonical SessionRef.
Reject callers that supply only agentId / projectId / transport metadata.

### 7.6 `packages/conversation-surface`

Stub only for MVP. Export interface types so `coordination-substrate` can
link to `conversationThreadId` / `conversationTurnId` without being blocked
by a missing dependency. No UI, no storage.

## 8. Components to lift from old ACP

From `/Users/lherron/praesidium/agent-control-plane`:

- `packages/acp-cli/src/scope-input.ts` — role-scoped ScopeRef parsing and
  normalization. Works correctly; port as-is.
- `packages/control-plane/src/acp/task-core.test.ts` — 6 semantic contracts
  (task CRUD with version 0; versioned transitions; version conflict
  detection; evidence requirement for preset tasks; preset immutability;
  transition history). Port as regression tests against the new
  implementation.
- `packages/acp-cli/src/acp.ts:249-296` — task subcommand skeleton structure
  (not the implementation).
- `TaskRecord` field shape from
  `packages/control-plane/src/acp/task-store.ts` — field list is spec-aligned;
  port the type, reimplement the store against wrkq-lib.

## 9. Components to leave behind

- `packages/acp/src/admin-store.ts`, `packages/control-plane/src/acp/admin-store.ts`
  — `personaId`-driven, in-memory, no agent-home integration.
- Any in-memory `TaskStore` — replaced by wrkq-backed client.
- `packages/session-agent-spaces` — the cross-repo bridge collapses when the
  planes share a repo.
- Gateway / delivery worker code — deferred for MVP.

## 10. Work sequencing

Each step should be a mergeable unit.

1. **Rename repo.** `agent-spaces` → `praesidium-runtime`. Update internal
   refs. Update `AGENTS.md` with the three-plane narrative and seams.
   Archive `agent-control-plane` (add README pointer, mark read-only).
2. **Propose wrkq schema additions** to wrkq maintainer: `workflow_preset`,
   `preset_version`, `phase`, `risk_class` columns on `tasks`; new tables
   `task_role_assignments`, `evidence_items`, `task_transitions`. Do not
   proceed on wrkq-lib until schema is agreed and shipped in wrkq.
3. **`packages/wrkq-lib`**: thin TS layer over wrkq's SQLite. Repositories
   only. Unit-test against a temp SQLite file.
4. **`packages/acp-core` skeleton**: types + `code_defect_fastlane.v1` preset
   + preset registry + GuidancePacket derivation. Pure functions; no I/O.
   Port the 6 regression tests from the old ACP.
5. **TransitionPolicy validator**: eight-step algorithm from §6.6. Unit-test
   each rejection path (role mismatch, SoD violation, missing evidence,
   stale version, unknown transition). Include the SoD case where
   `actor.agentId == roleMap.implementer` for `green → verified`.
6. **`packages/coordination-substrate`**: SQLite storage + `appendEvent`
   transactional command + read-side queries. Contract tests from §13.
7. **`packages/acp-server` endpoints**: `/tasks`, `/tasks/:id/evidence`,
   `/tasks/:id/transitions`, `/inputs`, `/runs`, `/messages`,
   `/runtime/resolve`, `/sessions/resolve`. Wire TransitionPolicy to
   `/transitions`. Wire `appendEvent` to `/messages` when body requests
   handoff/trigger.
8. **GuidancePacket injection via ASP**:
   - Update `packages/config/src/resolver/placement-resolver.ts` to read
     `correlation.sessionRef.scopeRef`, detect `:task:<id>:role:<r>`,
     fetch phase + preset from ACP (over HTTP), compose GuidancePacket
     into a `RunScaffoldPacket`.
   - Update `packages/runtime/src/system-prompt.ts` to accept and render it.
   - Update `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts`
     `buildHrcCorrelationEnv()` to add `HRC_TASK_ID`, `HRC_TASK_PHASE`,
     `HRC_TASK_ROLE`.
9. **`packages/acp-cli`**: subcommands listed in §7.4.
10. **End-to-end integration test**: the §2 scenario as an automated
    test. Two distinct agent ids acting as implementer and tester. Assert
    SoD rejection when the same agent attempts both. Assert the
    implementer → tester handoff writes event + handoff + wake atomically.
    Assert GuidancePacket reaches the running agent's context.
11. **wrkq intake hook**: teach `wrkq touch inbox/bug` (or wrap at a new
    `acp task create-from-wrkq` layer) to set `workflow_preset`,
    `preset_version`, `risk_class=medium` on bug-kind tasks. Coordinate
    with wrkq owner on whether this lives in wrkq or in an ACP-side
    watcher.

## 11. Contract tests (from spec §13 COORDINATION_SUBSTRATE)

Must pass before the substrate is considered done:
1. Exact semantic triggering (SessionRef required for wake).
2. Append-only history (events are immutable).
3. Source / target / transcript separation.
4. Projection rebuildability.
5. Project isolation.
6. Idempotent writes.
7. Handoff visibility (queryable without text inference).
8. HAL read-model support (coordination slice derivable).
9. ACP delivery boundary preservation.
10. Replay ordering (stable per-project sequence).
11. Conversation correlation.

## 12. Open questions the executing agent must resolve

1. **wrkq schema coordination.** Who owns the schema change proposal? Is
   there an existing RFC flow in wrkq? Does wrkq prefer migrations as
   separate `.sql` files or embedded in Go? Read
   `../wrkq/WRKQ_STATE_MACHINE_SPEC.md` and `../wrkq/AGENTS.md`.
2. **SQLite file(s).** One file with multiple attached schemas, or one
   file per package (wrkq.db, coordination.db)? Default to the latter
   unless there's a strong reason to share.
3. **HTTP framework choice.** Match whatever `packages/hrc-server` uses —
   do not introduce a new one.
4. **ACP ↔ ASP call shape.** The placement resolver needs to fetch task
   phase/preset. Options: (a) direct wrkq-lib access from ASP (tightest),
   (b) HTTP call to `acp-server`, (c) shared `acp-core` lib dependency.
   Recommend (c) — ASP imports `acp-core` and reads wrkq via wrkq-lib.
   Avoids a network hop on the critical run path.
5. **Hub / membership authz model.** Spec mentions hubs, but MVP can
   skip hub authority entirely. Confirm with the user that
   membership-only authz is acceptable.
6. **Agent identity / actor.** How does the HTTP layer know which
   `agentId` is making a request? For MVP, accept it as a request header
   or body field — no auth boundary. Note the spec warning
   (`TASK_WORKFLOWS.md §6.2`) that ScopeRef is not an auth boundary.
7. **Renaming cost.** Confirm with user before renaming: touches CI,
   npm package names (`@lherron/agent-spaces`?), any publication steps,
   any external integrations.

## 13. Out-of-scope reminders

Do not, in this MVP:
- Implement `code_feature_tdd` preset (beyond stubbing as an escalation
  target).
- Build gateway ingress (Discord, email, etc.).
- Build a conversation-surface UI.
- Add scheduling (`Job` / `JobRun`).
- Implement waivers or break-glass flows.
- Migrate or port data from the old `agent-control-plane` repo.
- Do role-specific SOUL.md / HEARTBEAT.md overlays. The GuidancePacket
  carries role-specific agentHints, which is sufficient.
- Implement delivery (`DeliveryRequest`, `DeliveryTarget`). Outputs land
  in task evidence and stdout.

## 14. Definition of done

- `wrkq touch --project demo inbox/bug -t "Test defect"` creates a task
  that is then promoted (via ACP CLI or a wrkq intake hook) to
  `workflowPreset=code_defect_fastlane`, `presetVersion=1`,
  `riskClass=medium`, with distinct `implementer` and `tester` agent ids
  assigned.
- Running `acp task show --task <t>` renders a GuidancePacket with the
  current phase's objective, required evidence, and hints.
- Executing the full `open → red → green → verified → completed`
  sequence via the CLI succeeds with appropriate evidence attached at
  each gate.
- Attempting `green → verified` with the implementer's agentId is
  rejected with an SoD error.
- The `red → green` transition (when it declares a tester handoff)
  atomically writes one CoordinationEvent, one Handoff (state=open), and
  one WakeRequest (state=queued), all linked by `sourceEventId` /
  `taskId`.
- The tester's agent run (launched via HRC through ASP) receives a
  GuidancePacket in its system prompt context matching its current phase
  (`green`) and role (`tester`).
- The 6 regression tests ported from the old ACP pass.
- The 11 coordination-substrate contract tests pass.
- The end-to-end integration test in §10.10 passes.

---

**Start here:** read this file, `../acp-spec/spec/orchestration/TASK_WORKFLOWS.md`
(especially §2.2, §5.2, §6), and `../acp-spec/spec/orchestration/COORDINATION_SUBSTRATE.md`
(especially §5-8). Then resolve §12 open questions with the user before
writing code.
