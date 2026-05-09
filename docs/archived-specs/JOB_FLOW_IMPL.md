# JobFlow Implementation Handoff

This document maps the planned JobFlow spec to the current `agent-spaces`
implementation so the implementation team can start without re-discovering the
existing job surfaces.

Full spec: [`../acp-spec/spec/orchestration/JOB_FLOW.md`](../acp-spec/spec/orchestration/JOB_FLOW.md)

Status: **MVP implemented (2026-04-28)**. Steps 1–11 of the original
implementation order are merged. The flow pipeline is exercised end-to-end by
the focused e2e in `packages/acp-e2e/test/jobflow-mvp.test.ts` against a fake
launcher.

Implementation tasks (all closed):

| Phase | Task    | Scope |
|-------|---------|-------|
| P1    | T-01305 | Public JobFlow types, reusable validator, status mapper, `flow_json` migration, `job_step_runs` table + store APIs |
| P2    | T-01306 | Server flow round-trip on POST/PATCH/GET `/v1/admin/jobs`; new POST `/v1/admin/jobs/validate` |
| P3    | T-01307 | Deterministic step idempotency dispatch helper (`buildStepIdempotencyKey`, `dispatchStepThroughInputs`) |
| P4    | T-01308 | HRC final-output reader (`getRunFinalAssistantText`), result-block parser, expectation evaluator |
| P5    | T-01309 | Manual-run flow engine (`advanceJobFlow`); nonblocking `handleRunAdminJob` flow branch |
| P6    | T-01310 | `GET /v1/job-runs/:jobRunId` returns `steps[]` for flow jobs with API-edge status mapping |
| P7    | T-01311 | Scheduler branches flow jobs into `advanceJobFlow` via `advanceFlowJobRun` seam |
| P8    | T-01312 | CLI `--in` JSON import for `acp job validate / create / patch` (client-side `inputFile` resolution) |
| P9    | T-01313 | CLI `acp job run --wait`, `acp job-run wait`, `acp job-run show --steps/--results` |
| P10   | T-01314 | Focused e2e: two-step happy path + missing-required-field → onFailure (fake launcher) |

Architectural decisions (frozen in T-01304/C-02383):

- **Q1 final-output source:** HRC persisted event log via
  `packages/acp-server/src/jobs/run-final-output.ts` (headless: `events` table
  through `toUnifiedAssistantMessageEndFromRawEvents`; interactive: `hrc_events`
  via `readAssistantMessageAfterSeq`). Not `acp-conversation`, not interface
  deliveries.
- **Q2 status mapping:** persistence retains internal strings
  (`pending|claimed|dispatched|succeeded|failed|skipped`); flow API responses
  map at the edge (`mapJobRunStatusForFlowResponse`: pending→queued,
  claimed/dispatched→running, succeeded/failed passthrough). Legacy
  single-turn responses unchanged.
- **Q3 inputFile:** server rejects unresolved `inputFile`; CLI resolves
  relative to the imported job file and inlines as `step.input`.
- **Q4 `--in` format:** JSON-only for the first slice. No YAML dependency.
- **Q5 manual `/run` lifetime:** nonblocking. Returns 202 with current
  `jobRun + steps[]`; clients poll `GET /v1/job-runs/:jobRunId` via
  `acp job-run wait` or `acp job run --wait`.

## Current Implementation Snapshot

The repo already has a narrow single-turn scheduled job stack:

- Store package: `packages/acp-jobs-store`
- Server handlers: `packages/acp-server/src/handlers/admin-jobs.ts` and
  `packages/acp-server/src/handlers/job-runs.ts`
- Routes: `packages/acp-server/src/routing/exact-routes.ts` and
  `packages/acp-server/src/routing/param-routes.ts`
- CLI commands: `packages/acp-cli/src/commands/job.ts`,
  `packages/acp-cli/src/commands/job-run.ts`, and command registration in
  `packages/acp-cli/src/cli.ts`
- Runtime dispatch seam: `dispatchJobRunThroughInputs()` in
  `packages/acp-server/src/handlers/admin-jobs.ts`
- Scheduler: `packages/acp-jobs-store/src/scheduler.ts`
- Core public types: `packages/acp-core/src/models/job.ts`
- State stores for normal `InputAttempt + Run`: `packages/acp-state-store` plus
  in-memory fallbacks under `packages/acp-server/src/domain`

The current model is:

```text
Job
  -> JobRun
      -> InputAttempt
      -> Run
```

Current job records contain `projectId`, `agentId`, `scopeRef`, `laneRef`,
`schedule`, `input`, `disabled`, `lastFireAt`, and `nextFireAt`.

Current job-run records contain `jobRunId`, `jobId`, `triggeredAt`,
`triggeredBy`, `status`, optional `inputAttemptId`, optional `runId`, error
fields, lease fields, and timestamps.

The current scheduler claims due jobs and, when given `dispatchThroughInputs`,
dispatches exactly one `input.content` through `/v1/inputs`.

## Current API and CLI Behavior

Implemented HTTP surfaces:

```text
POST  /v1/admin/jobs
GET   /v1/admin/jobs
GET   /v1/admin/jobs/:jobId
PATCH /v1/admin/jobs/:jobId
POST  /v1/admin/jobs/:jobId/run
GET   /v1/jobs/:jobId/runs
GET   /v1/job-runs/:jobRunId
```

Implemented CLI surfaces:

```bash
acp job create --project ... --agent ... --scope-ref ... --cron ... --input '{"content":"..."}'
acp job list
acp job show --job ...
acp job patch --job ... [--cron ...] [--input ...] [--enabled|--disabled]
acp job run --job ...
acp job-run list --job ...
acp job-run show --job-run ...
```

Important current behavior:

- `POST /v1/admin/jobs` requires `agentId`, `projectId`, `scopeRef`,
  `schedule.cron`, and `input`.
- `input` is just a JSON object; dispatch requires `input.content` to be a
  non-empty string.
- Cron validation is in `packages/acp-jobs-store/src/cron.ts`.
- `dispatchJobRunThroughInputs()` calls `handleCreateInput()` directly with:

```json
{
  "sessionRef": { "scopeRef": "...", "laneRef": "..." },
  "idempotencyKey": "<jobRunId>",
  "content": "...",
  "meta": {
    "source": {
      "kind": "job",
      "jobId": "...",
      "jobRunId": "..."
    }
  }
}
```

- `/v1/inputs` creates a normal `InputAttempt + Run` and, when a launcher is
  configured, dispatches through `launchRoleScopedRun`.
- Persistent ACP state is available through `openAcpStateStore()`; in tests, the
  server usually uses in-memory stores.
- The in-process jobs scheduler is enabled only when `ACP_SCHEDULER_ENABLED` is
  `1` or `true`.

## Spec-to-Actual Gap

JobFlow MVP in the spec requires:

- `Job.flow.sequence`
- optional `Job.flow.onFailure`
- durable `JobStepRun` records under one `JobRun`
- each agent-executing step creates its own normal `InputAttempt + Run`
- step expectation evaluation after the underlying `Run` becomes terminal
- shallow result-block parsing with `expect.resultBlock`, `require`, and
  `equals`
- sequence stop on first failed step
- optional failure path after sequence failure
- `GET /job-runs/{jobRunId}` exposing `steps[]` for flow jobs
- deterministic step idempotency keys
- legacy single-turn jobs preserved

None of those flow-specific pieces exists yet. The current store has no
`flow_json`, no `job_step_runs` table, no step orchestration engine, no result
block parser, no job-run waiter, and no flow-aware CLI.

## Recommended MVP Scope

Implement this first:

1. Accept and store `flow.sequence` plus optional `flow.onFailure` on jobs.
2. Add `POST /v1/admin/jobs/validate`.
3. Support manual flow execution through `POST /v1/admin/jobs/:jobId/run`.
4. Add durable `JobStepRun` storage.
5. Dispatch each step through `/v1/inputs`.
6. Reconcile terminal `Run` status into step status.
7. Parse and evaluate shallow `expect` gates.
8. Return `steps[]` from `GET /v1/job-runs/:jobRunId` for flow jobs.
9. Add CLI import/validation and step inspection.
10. Keep the existing single-turn job path working unchanged.

Defer these unless the implementation team explicitly chooses a larger slice:

- `GET /v1/job-runs/:jobRunId/events`
- `POST /v1/job-runs/:jobRunId/cancel`
- `acp job-run events`
- `acp job-run cancel`
- step-level retry commands
- graph/DAG execution
- per-step target overrides
- task-evidence steps

## Data Model Changes

Add ACP core types in `packages/acp-core/src/models/job.ts` or a neighboring
model file:

```ts
export type JobFlow = {
  sequence: JobFlowStep[]
  onFailure?: JobFlowStep[] | undefined
}

export type JobFlowStep = {
  id: string
  input?: string | undefined
  inputFile?: string | undefined
  timeout?: string | undefined
  expect?: StepExpectation | undefined
}

export type StepExpectation = {
  outcome?: 'succeeded' | 'failed' | 'cancelled' | undefined
  resultBlock?: string | undefined
  require?: string[] | undefined
  equals?: Readonly<Record<string, string | number | boolean | null>> | undefined
}

export type JobStepRunPhase = 'sequence' | 'onFailure'
export type JobStepRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export type JobStepRun = {
  jobRunId: string
  stepId: string
  phase: JobStepRunPhase
  status: JobStepRunStatus
  attempt: number
  inputAttemptId?: string | undefined
  runId?: string | undefined
  resultBlock?: string | undefined
  result?: Readonly<Record<string, unknown>> | undefined
  error?: { code: string; message: string } | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
}
```

For the store, add migration `003_job_flow` in
`packages/acp-jobs-store/src/open-store.ts`:

```sql
ALTER TABLE jobs ADD COLUMN flow_json TEXT;

CREATE TABLE IF NOT EXISTS job_step_runs (
  job_run_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  step_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  input_attempt_id TEXT,
  run_id TEXT,
  result_block TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_run_id, phase, step_id, attempt),
  FOREIGN KEY (job_run_id) REFERENCES job_runs(job_run_id)
);

CREATE INDEX IF NOT EXISTS job_step_runs_job_run_idx
  ON job_step_runs (job_run_id, phase, created_at, step_id);

CREATE INDEX IF NOT EXISTS job_step_runs_run_id_idx
  ON job_step_runs (run_id)
  WHERE run_id IS NOT NULL;
```

Exact enum strings should follow the spec for flow records:

- `JobRun.status`: use `running`, `succeeded`, `failed`, `cancelled` for flow
  runs if possible. If changing existing status strings is too disruptive, map
  current `claimed`/`dispatched` to API-level `running` for flow responses.
- `JobStepRun.status`: use the spec strings exactly.
- `JobStepRun.phase`: `sequence` or `onFailure`.

Keep existing single-turn fields:

- `job_runs.input_attempt_id`
- `job_runs.run_id`

For flow jobs, leave these unset or treat them as legacy compatibility fields.
Clients should use `jobRun.steps[].runId`.

## Validation Contract

Implement validation in a reusable module, likely
`packages/acp-jobs-store/src/flow-validation.ts` or
`packages/acp-server/src/jobs/flow-validation.ts`.

`POST /v1/admin/jobs/validate` should validate without creating or updating.

Reject:

- duplicate step ids across `sequence` and `onFailure`
- empty or missing `flow.sequence`
- both `input` and `inputFile` missing from a step
- both `input` and `inputFile` present on a step unless the team explicitly
  defines precedence
- unsupported `expect` fields
- `expect.require` entries that are not non-empty top-level field names
- `expect.equals` keys that are not top-level field names
- `expect.equals` values that are not scalar string/number/boolean/null
- unsupported `expect.outcome`
- invalid cron syntax
- invalid timeout strings
- any shape that cannot be reduced to ACP turns

Recommended validation response:

```json
{
  "valid": false,
  "errors": [
    {
      "code": "duplicate_step_id",
      "path": "flow.sequence[1].id",
      "message": "duplicate step id: work"
    }
  ]
}
```

Creation and patch routes should reuse the same validator and reject invalid
flow payloads with the existing error response machinery.

## Prompt/Input Handling

The spec allows `input` or `inputFile` per step. Current server dispatch only
accepts direct `content`.

Recommended MVP:

- API storage should store rendered prompt content, not a client-local path.
- CLI `--in ./job.yaml` may resolve `inputFile` relative to the YAML file and
  send `flow.sequence[].input`.
- Server should reject unresolved `inputFile` unless a clear server-side project
  workspace contract is implemented in the same slice.
- Keep existing legacy `input.content` jobs supported.

This avoids execution depending on a path that exists only on the CLI machine.

## Flow Engine Design

Add a small orchestration module rather than embedding flow logic in HTTP
handlers:

```text
packages/acp-jobs-store/src/flow-engine.ts
or
packages/acp-server/src/jobs/flow-engine.ts
```

Recommended server-side responsibilities:

1. Create a `JobRun` with flow-aware `running`/current active status.
2. Insert pending `JobStepRun` rows for all `sequence` steps.
3. Run `sequence` in order.
4. For each step, dispatch through `/v1/inputs`.
5. Store `inputAttemptId`, `runId`, and `startedAt` on the step.
6. Wait for or reconcile the underlying `Run` to terminal state.
7. Evaluate `expect`.
8. Mark step succeeded/failed/cancelled.
9. Skip remaining sequence steps after first failure.
10. If a sequence step failed and `onFailure` exists, insert/run those steps in
    order.
11. Mark `JobRun` succeeded only when all sequence steps succeed.
12. Keep `JobRun` failed even when all `onFailure` steps succeed.

The first slice can run synchronously inside manual `POST /run` if launchers in
tests make terminal runs available immediately. For real scheduled runs, do not
block an HTTP request indefinitely. Prefer a resumable worker/tick function that
can advance one step at a time.

Recommended function shape:

```ts
type RunFlowJobInput = {
  deps: ResolvedAcpServerDeps
  job: JobRecord
  jobRun: JobRunRecord
  now?: string | undefined
  actor?: Actor | undefined
}

async function advanceJobFlow(input: RunFlowJobInput): Promise<JobRunRecord>
```

## Run Terminal Reconciliation

Current `Run.status` is separate from `JobRun.status`. `dispatchJobRunThroughInputs`
only records that a run was dispatched.

JobFlow needs a way to observe terminal runs:

- `pending` and `running` are not terminal.
- Current run model uses `completed`, `failed`, and `cancelled`.
- JobFlow spec names successful outcome `succeeded`.

Recommended mapping:

```text
expect.outcome=succeeded  -> Run.status=completed
expect.outcome=failed     -> Run.status=failed
expect.outcome=cancelled  -> Run.status=cancelled
```

For manual tests, launch fakes can update `runStore` to terminal immediately.
For production, implement one of:

- a polling/advance loop that checks `runStore.getRun(runId)`
- a callback from the launcher/session event stream into the flow engine
- scheduler advancement that claims active flow steps and reconciles run status

Do not mark a step succeeded at dispatch time.

## Step Idempotency Keys

Current single-turn jobs use `jobRunId` as the `/v1/inputs` idempotency key.
Flow jobs must use deterministic step keys:

```text
jobrun:{jobRunId}:phase:{sequence|onFailure}:step:{stepId}:attempt:{attempt}
```

Pass that key into `/v1/inputs`. Preserve the current single-turn `jobRunId`
behavior for legacy jobs.

## Result Block Parsing

Add a small parser module with focused tests. Suggested path:

```text
packages/acp-server/src/jobs/result-block.ts
```

The parser needs to extract a named JSON object block from the final agent
output. The repo currently stores prompt content in `Run.metadata.content`, but
the final assistant output source must be confirmed before implementation. Good
candidate surfaces to inspect are:

- `packages/acp-server/src/delivery/interface-response-capture.ts`
- `packages/acp-conversation`
- HRC session event replay through `/v1/sessions/:sessionId/events`

Define exact parsing rules before coding the parser:

- name line followed by JSON object
- optional fenced JSON support or no fenced JSON support
- duplicate block behavior
- trailing text behavior after the JSON object
- malformed JSON error behavior

Recommended stable error codes from the spec:

```text
run_outcome_mismatch
result_block_missing
result_block_parse_failed
required_result_field_missing
result_field_mismatch
```

MVP expectation evaluation:

- `require`: top-level field must exist in parsed object.
- `equals`: top-level scalar equality only.
- No nested paths.
- No arrays.
- No operators.
- No inline schemas.

## API Changes

Add exact route:

```text
POST /v1/admin/jobs/validate
```

Extend existing routes:

```text
POST  /v1/admin/jobs
PATCH /v1/admin/jobs/:jobId
POST  /v1/admin/jobs/:jobId/run
GET   /v1/admin/jobs/:jobId
GET   /v1/job-runs/:jobRunId
```

Response expectations:

- Legacy jobs keep current response shape, including direct `jobRun.runId`.
- Flow jobs return `job.flow`.
- Flow job-runs return `jobRun.steps[]`.
- Each step includes `stepId`, `phase`, `status`, `attempt`, optional
  `inputAttemptId`, optional `runId`, optional parsed `result`, and optional
  `error`.

Planned/deferred routes from the spec may be stubbed later, but do not need to
land in the first implementation slice:

```text
GET  /v1/job-runs/:jobRunId/steps
GET  /v1/job-runs/:jobRunId/events
POST /v1/job-runs/:jobRunId/cancel
```

## CLI Changes

Add command registration in `packages/acp-cli/src/cli.ts`:

```bash
acp job validate --in ./job.yaml
acp job create --in ./job.yaml
acp job patch --job job_id --in ./job.yaml
acp job run --job job_id --wait
acp job-run show --job-run jrun_id --steps
acp job-run show --job-run jrun_id --results
acp job-run wait --job-run jrun_id --until terminal
```

Implementation notes:

- `--in` should support JSON first if YAML dependencies are not already present.
  If YAML is required, add the dependency deliberately and update package
  metadata.
- If supporting `inputFile`, resolve it on the CLI side and send prompt content.
- Table output should avoid dumping full prompt/result objects by default.
- JSON output should preserve full stored objects.

## Scheduler Changes

`packages/acp-jobs-store/src/scheduler.ts` currently dispatches a claimed job
immediately as one input.

For flow jobs:

- Scheduler should create/claim a `JobRun` as it does today.
- If `job.flow` exists, pass the run to the flow engine instead of direct
  `input.content` dispatch.
- The scheduler should not treat dispatch as success.
- Recovery should be resumable from persisted `job_step_runs`.
- Keep the current single-turn path for jobs without `flow`.

Concurrency and misfire policy are not implemented as spec-level knobs today.
The current scheduler effectively prevents duplicate claims at the same clock
instant by advancing `last_fire_at`/`next_fire_at`. Do not introduce richer
policy semantics in the JobFlow MVP unless explicitly requested.

## Tests to Add or Update

Store package:

- `packages/acp-jobs-store/src/__tests__/jobs-store.test.ts`
  - creates job with `flow.sequence`
  - rejects duplicate step ids through validator
  - preserves legacy `input.content` jobs
- `packages/acp-jobs-store/src/__tests__/job-runs-store.test.ts`
  - inserts/list/gets `JobStepRun` records
  - returns steps ordered by phase and sequence order
- new flow validation tests
- new result-block parser tests if parser lives in this package

Server package:

- `packages/acp-server/test/admin-jobs.test.ts`
  - `POST /v1/admin/jobs/validate`
  - create/show flow job
  - manual flow run creates one `InputAttempt + Run` per step
  - expectation success advances to closeout
  - expectation failure skips remaining sequence steps
  - `onFailure` runs after failed sequence step
  - `GET /v1/job-runs/:jobRunId` includes `steps[]`
  - legacy manual run still returns direct `inputAttemptId` and `runId`
- scheduler test showing due flow job creates/advances step runs without
  regressing current hourly scheduler tests.

CLI package:

- `packages/acp-cli` tests for `job validate --in`, `job create --in`,
  `job run --wait`, and `job-run show --steps`.
- Existing `job create --input` tests should continue passing.

E2E:

- Add one e2e path that creates a flow job, triggers it, observes two steps, and
  verifies `GET /v1/job-runs/:jobRunId` shows parsed result/error state.
- Use a fake launcher that writes terminal run state and final output
  deterministically. Do not rely on a real model for the first acceptance test.

Suggested validation commands after implementation:

```bash
bun run --filter acp-jobs-store test
bun run --filter acp-server test
bun run --filter acp-cli test
bun run --filter acp-jobs-store typecheck
bun run --filter acp-server typecheck
bun run --filter acp-cli typecheck
```

Then run the focused e2e test added for JobFlow. A full `bun run test` is useful
after the focused slice is green, but it is not necessary for every small
iteration.

## Implementation Order

Recommended order:

1. Add JobFlow/core types and validation helpers.
2. Add `flow_json` and `job_step_runs` migration/store APIs.
3. Extend create/patch/show jobs to round-trip `flow`.
4. Add `POST /v1/admin/jobs/validate`.
5. Add step idempotency dispatch helper.
6. Add result-block parser and expectation evaluator.
7. Add flow engine for manual run path.
8. Extend `GET /v1/job-runs/:jobRunId` with `steps[]`.
9. Teach scheduler to branch flow jobs into the flow engine.
10. Add CLI `--in`, `validate`, `--wait`, `--steps`, and `--results`.
11. Add focused e2e.

## Compatibility Rules

Do not break:

- existing `acp job create --input '{"content":"..."}'`
- existing single-turn `POST /v1/admin/jobs/:jobId/run`
- existing `jobRun.inputAttemptId` and `jobRun.runId` for legacy jobs
- existing cron validation and hourly scheduler behavior
- actor stamping tests for job and job-run creation
- idempotent `/v1/inputs` behavior

## Open Implementation Questions (resolved 2026-04-27)

All five resolved as part of T-01304 (architect review). See the "Status"
block at the top of this document for the locked decisions and the
justifying file paths/symbols.

The full behavior target remains the spec linked at the top:
[`../acp-spec/spec/orchestration/JOB_FLOW.md`](../acp-spec/spec/orchestration/JOB_FLOW.md).

## Phase 12: Live Manual Validation Plan

The MVP is automated-test-green and the dispatch surface was smoked once
end-to-end against a real ACP server (validate happy/dup/missing-inputFile,
flow create round-trip, manual `/run` returning 202 with `work=running` +
`closeout=pending`, `acp job-run show --steps`). The items below were **not**
exercised live and need a manual validation pass before the slice is "done
done".

For each item, the goal is: confirm behavior against the running ACP server
using the linked `acp` CLI, with a fake or fast-terminal launcher attached so
underlying ACP `Run` records reach terminal state quickly. The e2e test
(`packages/acp-e2e/test/jobflow-mvp.test.ts`) uses a `fakeLauncher` —
re-using that launcher in a manual harness is the cleanest path.

### 12.1 Terminal-step transitions on the live engine

- [ ] Trigger a flow job whose first step's underlying `Run` reaches `completed`.
      Confirm `JobStepRun.status` flips from `running` → `succeeded`.
- [ ] Confirm second sequence step then dispatches automatically (engine advances
      after reconciling first step terminal).
- [ ] Confirm `JobRun.status` (mapped) becomes `succeeded` once all sequence
      steps succeed.

### 12.2 Result-block parsing on real assistant output

- [ ] Have a launcher emit a final assistant message containing a named result
      block (e.g. `WORK_RESULT { ... }`). Confirm `JobStepRun.result` is
      populated with the parsed object.
- [ ] Multiple distinct named blocks: confirm parser picks the requested one.
- [ ] Duplicate of the same block: confirm last occurrence wins (per
      `result-block.ts` header rules).
- [ ] Trailing text after the JSON object's closing brace: confirm tolerated.

### 12.3 Expectation evaluation error codes

- [ ] `expect.outcome` mismatch (Run failed but expect succeeded) →
      `JobStepRun.error.code = "run_outcome_mismatch"`.
- [ ] Result block missing → `result_block_missing`.
- [ ] Malformed JSON inside the block → `result_block_parse_failed`.
- [ ] `require` field missing → `required_result_field_missing`.
- [ ] `equals` mismatch → `result_field_mismatch`.

### 12.4 Sequence-failure → onFailure path

- [ ] First sequence step fails (e.g. missing required field). Confirm
      remaining sequence steps move to `skipped`.
- [ ] Configured `flow.onFailure` steps run after the sequence failure.
- [ ] Successful `onFailure` does **not** flip `JobRun.status` to `succeeded`
      (final state remains `failed`).

### 12.5 Scheduler-driven flow execution

- [ ] Set `ACP_SCHEDULER_ENABLED=1` and create an enabled flow job with a
      cron that fires soon. Confirm the scheduler tick:
      a. claims the JobRun
      b. routes through `advanceFlowJobRun` (not `dispatchThroughInputs`)
      c. populates `job_step_runs` rows
- [ ] Kill the server mid-flow; restart; confirm the next scheduler tick
      resumes the partially-advanced flow without re-dispatching steps that
      already have runIds.

### 12.6 CLI polling commands

- [ ] `acp job run --job <id> --wait` against a flow job that terminates
      successfully — exits with mapped `succeeded` status payload.
- [ ] `acp job-run wait --job-run <jrun>` polls and returns once terminal.
- [ ] `acp job-run wait --timeout 5s` against a flow that never terminates —
      returns with `timedOut: true`.
- [ ] `acp job-run show --job-run <jrun> --results` renders the parsed
      result objects per step.

### 12.7 Idempotency under retry

- [ ] Crash mid-flow before the second step dispatches. Confirm the next
      `advanceJobFlow` call (manual `/run` or scheduler tick) does **not**
      create a duplicate `InputAttempt` for the first step (idempotency key
      `jobrun:{jobRunId}:phase:sequence:step:{stepId}:attempt:1` dedupes).

### 12.8 Legacy regression (smoke)

- [ ] Existing `acp job create --input '{"content":"..."}'` (no flow) still
      creates a job; manual `/run` returns 202 with the **legacy** response
      shape (direct `jobRun.runId` / `inputAttemptId`, internal status
      strings, no `steps[]`).
- [ ] Existing hourly scheduler job still fires at minute 0 of the hour
      (T-01258 / acp-fix-hourly-scheduler regression).

Verification environment notes:

- The launchd-managed `com.praesidium.acp-server` is currently flapping
  (separate, pre-existing issue). For manual validation, prefer
  `bun run packages/acp-server/src/cli.ts` after exporting the
  `ACP_*_DB_PATH` env vars (see the launchd plist for the canonical set).
- The fake launcher fixture used by P10 is at
  `packages/acp-e2e/test/jobflow-mvp.test.ts` — reusing or adapting it for
  the manual harness avoids waiting on real model latency.
