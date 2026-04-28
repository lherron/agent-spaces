# JobFlow OS Exec + Exit-Status Branching Plan

Hand-off document for adding native OS process execution to JobFlow. This plan
assumes the current JobFlow MVP from `JOB_FLOW_IMPL.md` is present and that
`JOB_E2E_PLAN.md` Phase 0 is being implemented in parallel.

## Goal

Allow JobFlow steps to run local commands/scripts directly as workflow work,
without asking an agent to run the command inside an agent turn. The flow engine
should be able to branch based on process exit status.

This should be an explicit second step kind, not an overload of the existing
agent prompt step.

## Current Context

- Working directory: `/Users/lherron/praesidium/agent-spaces`
- Existing JobFlow supports ordered `sequence` plus optional `onFailure`.
- Existing step execution is agent-turn only:
  - step contains `input` or `inputFile`
  - flow engine dispatches through `/v1/inputs`
  - each step creates a normal `InputAttempt + Run`
  - terminal `Run.status` is reconciled into `JobStepRun.status`
- Existing durable step table is generic enough for an MVP:
  - `job_step_runs.result_json` can hold exec results
  - `job_step_runs.error_code` / `error_message` can hold launch, timeout, or
    policy errors
  - `job_step_runs.input_attempt_id` / `run_id` can remain unset for exec steps
- `JOB_E2E_PLAN.md` Phase 0 adds `JobFlowStep.fresh?: boolean` for agent
  continuation isolation.

## Phase 0 Compatibility Check

`JOB_E2E_PLAN.md` Phase 0 does **not** change this proposal.

Phase 0 adds `fresh: true` semantics for agent steps:

- before dispatching an agent step through `/v1/inputs`
- call HRC `rotateSessionGeneration({ sessionRef })`
- then create a fresh agent turn

Exec steps do not use HRC continuation or `/v1/inputs`, so there is nothing to
rotate. The exec implementation should preserve the `fresh` field as valid step
metadata for compatibility, but it should only have behavior on agent steps.

Recommended rule:

- `fresh` is accepted on all steps because Phase 0 already adds it broadly
- `fresh` is actionable only when `kind` is omitted or `kind === "agent"`
- optional future cleanup can make the validator warn on `fresh` for exec, but
  do not reject it in the MVP

## Proposed Step Shape

Move from a single structural step shape to a discriminated union. Preserve
existing jobs by making omitted `kind` mean `agent`.

```ts
export type JobFlow = {
  sequence: JobFlowStep[]
  onFailure?: JobFlowStep[] | undefined
}

export type JobFlowStep = AgentFlowStep | ExecFlowStep

export type FlowNext = string | 'continue' | 'succeed' | 'fail'

export type BaseFlowStep = {
  id: string
  kind?: 'agent' | 'exec' | undefined
  timeout?: string | undefined
  fresh?: boolean | undefined
  next?: FlowNext | undefined
}

export type AgentFlowStep = BaseFlowStep & {
  kind?: 'agent' | undefined
  input?: string | undefined
  inputFile?: string | undefined
  expect?: StepExpectation | undefined
}

export type ExecFlowStep = BaseFlowStep & {
  kind: 'exec'
  exec: {
    argv: string[]
    cwd?: string | undefined
    env?: Readonly<Record<string, string>> | undefined
    timeout?: string | undefined
    maxOutputBytes?: number | undefined
  }
  branches?: {
    exitCode?: Readonly<Record<string, FlowNext>> | undefined
    default?: FlowNext | undefined
  } | undefined
}
```

Notes:

- `step.timeout` remains supported as a common timeout. For exec, prefer
  `exec.timeout` when both are present; validation can reject both later if that
  ambiguity becomes painful.
- `next` is useful for both agent and exec steps.
- `branches` is exec-specific in the MVP.
- Branch targets refer to step ids in the same phase, or terminal tokens:
  `continue`, `succeed`, `fail`.

## Example Job

```yaml
input:
  content: "(unused - flow takes over)"
flow:
  sequence:
    - id: typecheck
      kind: exec
      exec:
        argv: ["bun", "run", "typecheck"]
        cwd: "/Users/lherron/praesidium/agent-spaces"
        timeout: "PT2M"
      branches:
        exitCode:
          "0": test
        default: report_typecheck_failure

    - id: report_typecheck_failure
      kind: agent
      fresh: true
      input: |
        Typecheck failed in the previous JobFlow exec step.
        Inspect the job-run step result, summarize the failure, and propose the
        smallest fix. Do not edit files in this reporting step.
      next: fail

    - id: test
      kind: exec
      exec:
        argv: ["bun", "run", "test"]
        cwd: "/Users/lherron/praesidium/agent-spaces"
        timeout: "PT5M"
      branches:
        exitCode:
          "0": succeed
        default: fail
```

## Exec Result Shape

Store this object in `job_step_runs.result_json`:

```ts
export type ExecStepResult = {
  kind: 'exec'
  argv: string[]
  cwd: string
  exitCode: number | null
  signal?: string | undefined
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  durationMs: number
  startedAt: string
  completedAt: string
}
```

Status mapping:

- process exits with code `0`: `JobStepRun.status = "succeeded"` unless a branch
  explicitly routes elsewhere
- process exits with non-zero code: `JobStepRun.status = "failed"` unless a
  branch explicitly handles that code or `default`
- timeout: `JobStepRun.status = "failed"`, `error.code = "exec_timeout"`
- spawn/policy failure: `JobStepRun.status = "failed"`, error code describes the
  failure
- signal termination: `JobStepRun.status = "failed"`, with `signal` captured

Important: a handled non-zero exit can still leave the step status as `failed`
while the workflow continues to the branch target. That gives the operator the
truth about the command while still supporting conditional flow. If this makes
the UI too noisy, add `branches.exitCode["1"].status = "succeeded"` later.

## Branch Semantics

The current `advancePhase()` iterates linearly. Replace that with a phase-local
program counter.

Default behavior when no explicit branch or `next` applies:

- agent step succeeded: continue to next step
- agent step failed/cancelled: fail the phase
- exec exit `0`: continue to next step
- exec non-zero: fail the phase
- exec timeout/spawn failure: fail the phase

Resolution order:

1. If exec step has `branches.exitCode[String(exitCode)]`, use it.
2. Else if exec step has `branches.default`, use it.
3. Else if step has `next`, use it.
4. Else use default behavior above.

`FlowNext` meanings:

- `continue`: next step in the current phase
- `succeed`: current phase succeeds immediately
- `fail`: current phase fails immediately
- `<step-id>`: jump to that step id in the same phase

For MVP, branch targets should not cross from `sequence` into `onFailure`. The
existing `onFailure` behavior remains: it runs only after the main sequence
phase fails.

## Validation Rules

Extend `packages/acp-jobs-store/src/flow-validation.ts`.

Preserve existing validation:

- duplicate ids rejected across `sequence` and `onFailure`
- `sequence` required and non-empty
- agent steps require exactly one of `input` or `inputFile`
- unresolved server-side `inputFile` rejected unless explicitly allowed
- expectation validation unchanged
- timeout validation unchanged

Add exec validation:

- `kind`, when present, must be `agent` or `exec`
- omitted `kind` is treated as `agent`
- `kind: "exec"` requires `exec` object
- `exec.argv` must be a non-empty string array
- reject empty argv entries
- reject shell string forms such as `command: "bun run test"` in MVP
- `exec.cwd`, when present, must be a non-empty string
- `exec.env`, when present, must be a string-to-string object
- `exec.timeout`, when present, must be a valid ISO 8601 duration
- `exec.maxOutputBytes`, when present, must be a positive integer under a
  server-defined max
- `branches.exitCode` keys must be integer strings in the process exit code
  range, normally `0..255`
- branch values must be `continue`, `succeed`, `fail`, or a known step id in the
  same phase
- `next`, when present, must follow the same target rules
- reject cycles in MVP

Cycle handling:

- Build a phase-local graph from implicit default edges, `next`, and branch
  edges.
- Reject cycles initially. This prevents accidental infinite repair loops.
- Add bounded loops later with explicit policy, e.g. `maxVisits`.

## Security Model

Gate the feature behind an environment variable:

```text
ACP_JOB_FLOW_EXEC_ENABLED=1
```

MVP restrictions:

- no implicit shell
- no command interpolation
- use argv arrays only
- cwd must resolve under an allowed project root unless an explicit server admin
  allowlist says otherwise
- timeout required by step or supplied by server default
- hard maximum timeout, for example 15 minutes
- stdout/stderr capture capped, for example 64 KiB each by default
- env is explicit and additive; do not inherit arbitrary process env by default
- always include a minimal safe baseline env, such as `PATH`, only if needed
- never log secrets from env values

Recommended server config:

```ts
type JobExecPolicy = {
  enabled: boolean
  allowedCwdRoots: string[]
  defaultTimeoutMs: number
  maxTimeoutMs: number
  defaultMaxOutputBytes: number
  maxOutputBytes: number
  inheritEnvAllowlist: string[]
}
```

Put policy in server deps so tests can inject a permissive local policy without
changing production defaults.

## Engine Design

Add:

```text
packages/acp-server/src/jobs/exec-step.ts
```

Responsibilities:

- validate runtime policy
- resolve cwd
- spawn process
- enforce timeout
- capture stdout/stderr with byte caps
- return `ExecStepResult`
- never use a shell

Suggested function:

```ts
export type RunExecStepInput = {
  step: ExecFlowStep
  defaultCwd: string
  policy: JobExecPolicy
  now?: () => Date
}

export async function runExecStep(input: RunExecStepInput): Promise<ExecStepResult>
```

Change `flow-engine.ts`:

- keep agent dispatch in the existing path
- add step-kind dispatch:
  - agent: current `/v1/inputs` behavior
  - exec: `runExecStep()`, then update `job_step_runs`
- replace linear `for` loop with a phase runner using a current step id
- keep `ensureStepRows()` phase setup unchanged
- keep `onFailure` invocation unchanged

`fresh` behavior stays in the agent dispatch path only.

## Store and API

No migration is required for MVP.

Use existing columns:

- `result_json`: serialized `ExecStepResult`
- `error_code`: `exec_timeout`, `exec_spawn_failed`, `exec_policy_denied`, etc.
- `error_message`: short human-readable detail
- `started_at` / `completed_at`: actual exec timing
- `input_attempt_id` / `run_id`: unset for exec

API response:

- `GET /v1/job-runs/:jobRunId` already exposes `steps[]`.
- Preserve full `result` in JSON output.
- CLI table output should summarize exec results:
  - step id
  - status
  - exit code
  - duration
  - stdout/stderr truncated flags

Potential later migration:

- add indexed `step_kind`, `exit_code`, `duration_ms` columns if dashboard
  filtering or reporting needs them.

## CLI Shape

No new command is required to create exec jobs if `acp job create --in` already
accepts arbitrary JSON/YAML flow definitions.

Update display:

```bash
acp job-run show --job-run <id> --steps
acp job-run show --job-run <id> --steps --results
```

For `--results`, include captured stdout/stderr in JSON output. For table or
human output, truncate aggressively and tell the user when the stored result is
larger.

## Tests

Unit tests:

- validator accepts legacy agent step without `kind`
- validator accepts minimal exec step
- validator rejects shell string shape
- validator rejects empty argv
- validator rejects invalid branch target
- validator rejects cycle
- validator accepts `fresh` on existing agent steps
- validator does not reject `fresh` on exec steps
- `runExecStep()` captures stdout, stderr, exit code
- `runExecStep()` handles non-zero exit
- `runExecStep()` enforces timeout
- `runExecStep()` truncates output
- `runExecStep()` denies execution when feature flag/policy disabled

Flow engine tests:

- exec `0` continues to next step
- exec non-zero fails sequence without branch
- exec non-zero branches to a named step
- branch to `succeed` marks job run succeeded
- branch to `fail` marks job run failed
- exec step leaves `inputAttemptId` and `runId` unset
- agent step with `fresh: true` still rotates generation before dispatch

E2E:

- create a disabled flow job with:
  - exec step that calls a small fixture executable/script without shell
    expansion
  - branch to success
- run manually with `acp job run --job <id> --wait`
- inspect with `acp job-run show --steps --results`
- assert exit code and captured output are visible

Use a fixture script for e2e so the product feature still rejects shell strings
in normal job specs.

## Implementation Phases

### Phase 1: Types and Validation

- update `packages/acp-core/src/models/job.ts`
- export new types from `packages/acp-core/src/index.ts`
- update `packages/acp-jobs-store/src/flow-validation.ts`
- add focused validator tests

### Phase 2: Exec Runner

- add `packages/acp-server/src/jobs/exec-step.ts`
- add policy type in server deps/config
- implement spawn, timeout, output caps
- add unit tests

### Phase 3: Flow Engine Integration

- split current step execution into `advanceAgentStep()` and `advanceExecStep()`
- replace linear phase loop with branch-aware phase runner
- store exec result in `result_json`
- preserve current `onFailure` behavior
- preserve current agent-step behavior, including Phase 0 `fresh`

### Phase 4: CLI/API Display

- ensure job-run JSON includes exec `result`
- improve CLI table summary for exec steps
- keep full stdout/stderr out of default human output

### Phase 5: E2E

- add one minimal exec branch e2e
- run package tests:
  - `bun run --filter acp-core test`
  - `bun run --filter acp-jobs-store test`
  - `bun run --filter acp-server test`
  - focused `packages/acp-e2e` jobflow test

## Open Questions

1. Should non-zero-but-handled exec steps display as `failed` or `succeeded`?
   This plan keeps them `failed` for truthfulness and lets the flow continue.
2. Should branch cycles be allowed with `maxVisits`? This plan rejects cycles in
   MVP.
3. Should exec cwd default to the project root, ACP server cwd, or job scope
   root? This plan recommends explicit cwd or server-injected project root.
4. Should env inherit `PATH` by default? This plan recommends an allowlist.
5. Should exec steps be available to scheduled jobs in production by default?
   This plan says no; require `ACP_JOB_FLOW_EXEC_ENABLED=1`.

## Non-Goals

- DAG/parallel execution
- cross-phase branch targets
- shell command strings
- retry policy
- streaming stdout/stderr events
- interactive processes
- long-running daemon supervision
- secret management beyond env allowlisting

## Recommended MVP Acceptance

- Existing agent-only JobFlow tests still pass.
- A flow can run an exec step and persist stdout/stderr/exit code.
- Exit code `0` can branch to `succeed`.
- Exit code `1` can branch to a named agent step.
- Without a branch, non-zero exit fails the sequence and triggers existing
  `onFailure`.
- Exec feature is disabled unless explicitly enabled by server policy.
- Phase 0 `fresh` behavior remains unchanged for agent steps.
