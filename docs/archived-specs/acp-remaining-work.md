# ACP Workflow Remaining Work

Date: 2026-05-10

This is a handoff note for a new session. It summarizes the current ACP
workflow implementation state against `acp-workflows-implementation-execution-brief.md`.

## Current Status

The last scoped goal was completed:

- Implemented bounded workflow supervision start/resume before creating the new
  supervisor agent.
- Added top-level `acp supervise` and nested `acp workflow supervise`.
- Created the new `supervisor` agent under
  `/Users/lherron/praesidium/var/agents/supervisor`.
- Studied `/Users/lherron/agents/AGENT_ONBOARDING.md` before creating that agent.

However, the full execution brief is not 100% complete across all listed
checkpoints A-J.

## Completed Work

### Durable Runtime

- `packages/acp-core/src/workflow/index.ts`
  - Workflow kernel supports durable snapshot hydrate/export.
  - Tasks pin workflow `{ id, version, hash }`.
  - Task state uses `open | active | waiting | closed`.
  - Transitions use `transitionId`, not `toPhase`.
  - Idempotency replay/conflict behavior exists for mutating workflow commands.
  - Supervisor run records were added.
  - Participant run records exist.
  - Workflow patch proposal records exist.
  - Supervisor control actions currently include:
    - `launch_participant_run`
    - `create_obligation`
    - `satisfy_obligation`
    - `propose_workflow_patch`

- `packages/acp-state-store`
  - Durable workflow tables include definitions, tasks, evidence, obligations,
    events, effects, supervisor runs, participant runs, anomalies, patch
    proposals, idempotency records, context hashes, and sequence metadata.
  - `workflow_supervisor_runs` table was added.
  - Snapshot save/load includes supervisor runs.

- `packages/acp-server`
  - `/v1/tasks` creates durable workflow tasks.
  - `/v1/tasks/:taskId/transitions` applies `transitionId` mutations.
  - `/v1/tasks/:taskId/actions` applies checked supervisor actions.
  - `/v1/tasks/:taskId/participant-context` exists.
  - `/v1/tasks/:taskId/supervisor-context` exists.
  - `/v1/workflow-supervisor-runs` starts/resumes bounded supervisor runs.
  - Legacy task evidence/promote/transition-list/`toPhase` routes are removed
    from the registered route surface.

- `packages/acp-cli`
  - `acp task create`, `task show`, and `task transition` target the workflow
    task API.
  - `acp workflow supervisor-context` exists.
  - `acp workflow action` exists.
  - `acp workflow supervise` exists.
  - `acp supervise` exists as a top-level alias.
  - Legacy task promote/evidence-add/transition-list commands were removed as
    breaking changes.

- Scenario/conformance assets:
  - `tests/conformance/acp-workflow/flow-presets-scenarios.test.ts`
  - `scripts/validate-scenarios.ts`
  - Scenario runbooks updated away from legacy route commands.

### Supervisor Agent

Created:

- `/Users/lherron/praesidium/var/agents/supervisor/SOUL.md`
- `/Users/lherron/praesidium/var/agents/supervisor/agent-profile.toml`
- `/Users/lherron/praesidium/var/agents/supervisor/HEARTBEAT.md`
- `/Users/lherron/praesidium/var/agents/supervisor/skills/acp-supervisor-workflow/SKILL.md`

The agent is configured as a Codex workflow supervisor and its local skill tells
it to:

- Use `acp supervise` or `acp workflow supervise`.
- Refresh supervisor context.
- Submit exactly one checked `acp workflow action` at a time.
- Avoid role impersonation.
- Treat durable workflow state as source of truth.

Dry-run validation passed:

```bash
asp run supervisor --dry-run
```

## Validation Already Run

Workflow-specific validation:

```bash
bun scripts/validate-scenarios.ts
bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts
bun test tests/conformance/acp-workflow
bun test packages/acp-cli/test/commands/task-workflow.test.ts
bun test packages/acp-server/test/workflow-tasks.test.ts
```

Package validation that passed:

```bash
bun run --filter acp-core build
bun run --filter acp-state-store build
bun run --filter acp-server build
bun run --filter acp-cli build
bun run --filter acp-core typecheck
bun run --filter acp-state-store typecheck
bun run --filter acp-server typecheck
bun run --filter acp-cli typecheck
bun run --filter acp-server test
bun run --filter acp-cli test
bun run --filter hrc-server test
bun run --filter @lherron/agent-spaces test
bun run typecheck
bun run build
bun run lint
```

Known lint caveat:

- `bun run lint` passed with one existing warning in
  `packages/gateway-discord/src/session-events-manager.ts` for cognitive
  complexity.

Canonical root test caveat:

- `bun run test` was run twice and did not complete cleanly because unrelated
  5s timeout tests fired under the broad package graph.
- The first timeout was in `hrc-server`; the exact test and full package passed
  on rerun.
- The second timeout was in `@lherron/agent-spaces`; the exact test and full
  package passed on rerun.
- Do not claim a clean root `bun run test` pass unless it is rerun and completes
  successfully.

Manual installed CLI smoke passed against a temporary source ACP server:

- `acp supervise` created task `T-D9904DF5` and supervisor run `supv_0002`.
- `acp workflow supervise` resumed it and returned `launch_participant_run`.
- Stale `contextHash` action rejected with `context_stale`.
- Valid `acp workflow action` launched participant role `owner` as `agent:cody`.
- `acp task show` reported 3 supervisor runs, 1 participant run, and 1 effect.

External validation:

- Clod validated all scenario artifacts through an independent Bun harness and
  through the repo-native conformance scenario test.
- Rex validated the stricter supervisor-agent path over the current source ACP
  HTTP surface with `agent:rex` satisfying an obligation.

## Remaining Work Against The Execution Brief

### Checkpoint E - Evidence, Obligations, Waiting Semantics

Incomplete:

- Standalone evidence attach API/CLI is not fully restored on the new workflow
  surface.
- Obligation waiver/cancel/expire APIs are not fully surfaced.
- Evidence works inline through transitions and `satisfy_obligation`, but the
  brief calls for explicit APIs/services/CLI paths for evidence and broader
  obligation lifecycle operations.

Likely next files:

- `packages/acp-core/src/workflow/index.ts`
- `packages/acp-server/src/handlers/workflow-tasks.ts`
- `packages/acp-server/src/routing/param-routes.ts`
- `packages/acp-cli/src/cli.ts`
- new `packages/acp-cli/src/commands/workflow-evidence-add.ts` or equivalent
- new tests in `packages/acp-cli/test/commands/task-workflow.test.ts`
- new tests in `packages/acp-server/test/workflow-tasks.test.ts`

### Checkpoint G - Participant Runtime Surface

Incomplete:

- No repo-native participant create/resume command like:

```bash
acp task run --workflow code_defect_fastlane@1 --project <id> --role implementer --agent <id> --goal "..."
acp task run --task <task-id> --role tester --agent <id> --resume
```

- Participant run records can be created by supervisor
  `launch_participant_run`, and participant context can be compiled, but there
  is no first-class participant runtime API/CLI surface matching the brief.

Need to implement:

- API endpoint for participant run create/resume.
- CLI command, likely `acp task run`.
- Role-scoped participant context returned from that surface.
- Tests that unauthorized actors cannot claim roles through request body.

Likely next files:

- `packages/acp-core/src/workflow/index.ts`
- `packages/acp-server/src/handlers/workflow-tasks.ts`
- `packages/acp-server/src/routing/exact-routes.ts`
- `packages/acp-cli/src/cli.ts`
- new `packages/acp-cli/src/commands/task-run.ts`
- `packages/acp-cli/test/commands/task-workflow.test.ts`
- `packages/acp-server/test/workflow-tasks.test.ts`

### Checkpoint H - Supervisor Runtime Surface

Partially complete.

Done:

- `acp workflow supervise`
- `acp supervise`
- Durable supervisor runs
- `SupervisorContext`
- one-action-at-a-time enforcement
- capability checks for implemented actions

Missing supervisor action types from the brief:

- `AttachEvidence`
- `ApplyTransition`
- `Escalate`
- `PauseSupervision`

Already implemented action types:

- `LaunchParticipantRun`
- `CreateObligation`
- `SatisfyObligation`
- `ProposeWorkflowPatch`

Need to decide command encoding for missing actions. Current CLI takes typed JSON
through `acp workflow action --action '<json>'`, so adding actions is mostly
kernel/server semantics plus context command templates and tests.

Likely next files:

- `packages/acp-core/src/workflow/index.ts`
- `packages/acp-server/src/handlers/workflow-tasks.ts`
- `packages/acp-cli/src/commands/workflow-action.ts`
- `tests/conformance/acp-workflow/workflow-kernel.conformance.test.ts`
- `packages/acp-server/test/workflow-tasks.test.ts`

### Checkpoint I - Workflow Patch Proposal Loop

Partially complete.

Done:

- Durable `WorkflowPatchProposal` storage exists.
- `propose_workflow_patch` supervisor action creates anomaly and proposal.
- Active workflow definitions remain immutable.
- Existing tasks remain pinned.

Incomplete:

- No dedicated patch proposal API/CLI list/read surface.
- Validation does not yet cover full patch proposal create/list/read API/CLI.

Need to implement:

- API endpoint(s) for list/read patch proposals.
- CLI command(s), naming to follow repo conventions.
- Tests for create/list/read.

Likely next files:

- `packages/acp-server/src/handlers/workflow-tasks.ts` or a new handler
- `packages/acp-server/src/routing/exact-routes.ts` / `param-routes.ts`
- `packages/acp-cli/src/cli.ts`
- new CLI command file for workflow patch proposals
- server and CLI tests

### Checkpoint J - Docs And Examples

Partially complete.

Updated docs:

- `docs/acp-workflow-verification.md`
- `acp-workflow-checkpoints-validation.md`
- `packages/acp-server/README.md`

Still needed after remaining implementation:

- Document participant runtime surface once `acp task run` exists.
- Document standalone evidence/obligation lifecycle commands once they exist.
- Document patch proposal list/read commands once they exist.
- Add runnable examples or clearly mark illustrative examples.

## Stop Condition Still Not Fully Met

The brief's stop condition is not fully satisfied because:

1. Participant runtime create/resume surface is missing.
2. Some supervisor actions from the required list are missing.
3. Evidence attach and broader obligation lifecycle APIs are incomplete.
4. Patch proposal list/read API/CLI surface is missing.
5. Canonical `bun run test` has not completed cleanly in this session.

## Important User Direction

- Treat legacy route removal as breaking changes.
- Do not preserve legacy task workflow routes just for compatibility.
- `acp supervise` must exist before creating or relying on the new supervisor
  agent. This has been done.
- Final validation must include external scenario validation via
  `hrcchat dm clod@agent-spaces`; this has been done for scenario artifacts.
- Be precise when saying "done": the scoped goal is done, but the full
  execution brief is not 100% complete yet.

## Useful Inspection Commands

```bash
rg -n "task run|workflow-supervisor-runs|workflow supervise|program.command\\('supervise'|SupervisorRunRecord|startSupervisorRun|listSupervisorRuns" \
  packages/acp-core/src/workflow/index.ts \
  packages/acp-server/src/handlers/workflow-tasks.ts \
  packages/acp-server/src/routing/exact-routes.ts \
  packages/acp-cli/src/cli.ts \
  packages/acp-cli/src/commands/workflow-supervise.ts \
  packages/acp-state-store/src/open-store.ts \
  packages/acp-state-store/src/repos/workflow-runtime-repo.ts

rg -n "launch_participant_run|create_obligation|satisfy_obligation|propose_workflow_patch|pause|escalate|attach_evidence|apply_transition" \
  packages/acp-core/src/workflow/index.ts \
  packages/acp-cli/src \
  packages/acp-server/src

find /Users/lherron/praesidium/var/agents/supervisor -maxdepth 3 -type f | sort
```

## Current Dirty Worktree Note

The repo already has many workflow-related modified/deleted/untracked files from
this implementation sequence. Do not blindly revert anything.

The agents repo also has unrelated dirty files:

- `AGENT_MOTD.md`
- `agent-minder/skills/agent-config-schema/SKILL.md`
- `agent-minder/skills/interview-questions/SKILL.md`
- `agent-minder/skills/onboard-agent/SKILL.md`
- untracked `ariadne/`
- untracked `sparky/var/`

The new supervisor agent is the relevant untracked directory:

- `/Users/lherron/praesidium/var/agents/supervisor/`
