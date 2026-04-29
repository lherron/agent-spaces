# acp-jobs-store Refactor Notes

## Purpose

`acp-jobs-store` is the SQLite persistence and scheduling support package for ACP jobs. It owns durable job definitions, job run records, flow step run records, migration application, cron next-fire calculation, scheduler ticking, flow validation, and a small SQLite compatibility layer that lets the same store run on Bun's `bun:sqlite` or `better-sqlite3`.

## Public surface

The package exports one module entrypoint, `.` from `src/index.ts`; it does not define HTTP routes or CLI commands. Store construction and migrations are exposed through `createInMemoryJobsStore`, `openSqliteJobsStore`, `jobsStoreMigrations`, `runJobsStoreMigrations`, and `listAppliedJobsStoreMigrations`. The main `JobsStore` surface exposes nested APIs under `jobs`, `jobRuns`, and `jobStepRuns`, plus root aliases including `createJob`, `listJobs`, `getJob`, `updateJob`, `archiveJob`, `appendJobRun`, `listJobRuns`, `getJobRun`, `updateJobRun`, `claimDueJobRuns`, `insertJobStepRuns`, `updateJobStepRun`, `listJobStepRuns`, `getJobStepRun`, `createJobRun`, `claimDueJobs`, `listInflightFlowJobRuns`, `runInTransaction`, and `close`.

Scheduling exports are `createJobsScheduler`, `tickJobsScheduler`, `DispatchThroughInputs`, `AdvanceFlowJobRun`, and `ScheduledRun`. Cron exports are `isValidCron` and `nextFireAfter`. Flow helpers are `mapJobRunStatusForFlowResponse`, `validateJobFlow`, `validateJobFlowJob`, and `assertValidJobFlow`. The package also exports record/input/status types such as `JobRecord`, `JobRunRecord`, `JobStepRunRecord`, `JobSchedule`, `JobInputTemplate`, `JobRunStatus`, `JobRunTrigger`, and SQLite adapter types via `SqliteDatabase`/`JobsSqliteDatabase`.

## Internal structure

`src/open-store.ts` is the core implementation. It defines migrations for `jobs`, `job_runs`, and `job_step_runs`; converts SQLite rows into public records; validates cron schedules; opens SQLite with WAL, foreign keys, and busy timeout; and implements all CRUD, claim, flow step, transaction, and close methods.

`src/scheduler.ts` contains the scheduler tick path. It claims due jobs through `JobsStore.claimDueJobs`, optionally dispatches legacy prompt jobs through `dispatchThroughInputs`, advances flow jobs through `advanceFlowJobRun`, marks failures on thrown dispatch or flow-advance errors, and resumes already claimed/dispatched flow runs through `listInflightFlowJobRuns`.

`src/cron.ts` is a local five-field cron parser and next-fire scanner. It supports `*`, `*/n`, ranges with optional steps, comma lists, numeric bounds, UTC matching, and a five-year minute-by-minute search cap.

`src/flow-validation.ts` validates `JobFlow` objects from `acp-core`: required non-empty `sequence`, unique step ids across phases, agent and exec step shapes, input versus inputFile rules, expectations, ISO durations, exec argv/env/cwd/output limits, branch targets, and phase-local cycle detection.

`src/flow-status.ts` maps internal run statuses to the smaller flow response status vocabulary. `src/sqlite.ts` abstracts Bun SQLite and `better-sqlite3` behind the local `SqliteDatabase` interface. `src/index.ts` re-exports the package surface.

## Dependencies

Production dependency declared in `package.json`: `better-sqlite3`. The source also imports `acp-core` types in `src/open-store.ts` and `src/flow-validation.ts`, but `acp-core` is not declared in this package's dependencies or devDependencies.

Test and build dependencies declared in `package.json`: `@types/better-sqlite3`, `@types/bun`, and `typescript`. Tests use Bun's built-in `bun:test` runner and also import `acp-core` types in `src/__tests__/flow-validation.test.ts`.

## Test coverage

The package has 34 passing tests across 9 files, verified with `bun run --filter acp-jobs-store test`. Coverage includes smoke construction, jobs CRUD and archive behavior, migrations and schema shape, job-run append/list/get/claim flows, job step run insert/update/list order, scheduler idempotency, catch-up policy, hourly minute-zero behavior, flow scheduler dispatch branching, in-flight flow resume behavior, flow validation, and flow response status mapping.

Current gaps: tests exercise in-memory SQLite only, so on-disk open behavior and migration upgrades from older real databases are not directly covered. Claim contention is tested for idempotency in one store, but not across multiple SQLite connections/processes. `src/cron.ts` is covered through scheduler tests and flow validation, but it has no direct table-driven tests for comma lists, ranges, stepped ranges, invalid bounds, and the five-year no-match cap.

## Recommended Refactors and Reductions

1. Split the oversized `src/open-store.ts` into narrower modules. `jobsStoreMigrations`, row converters such as `toJobRecord`/`toJobRunRecord`/`toJobStepRunRecord`, SQLite opening, and the `openSqliteJobsStore` method closures currently share one 1379-line file, which makes unrelated changes collide and hides the store API flow.

2. Declare the direct `acp-core` type dependency in `packages/acp-jobs-store/package.json`. `src/open-store.ts`, `src/flow-validation.ts`, and `src/__tests__/flow-validation.test.ts` depend on `Actor`, `JobFlow`, `JobStepRunPhase`, `JobStepRunStatus`, `FlowNext`, `JobFlowStep`, and `StepExpectation`; relying on workspace-level availability makes the package boundary unclear.

3. Remove compatibility probing from tests now that `src/index.ts` has a stable surface. `resolveJobsCrud` appears in `src/__tests__/jobs-store.test.ts`, `src/__tests__/scheduler-tick.test.ts`, and `src/__tests__/scheduler-catch-up.test.ts`; `resolveTick` is duplicated in the two scheduler tests; `resolveJobRunsApi` probes obsolete aliases in `src/__tests__/job-runs-store.test.ts`. Calling the typed public methods directly would reduce test-only indirection.

4. Extract shared actor/timestamp/nullable-patch helpers in `src/open-store.ts`. `createJob`, `updateJob`, `appendJobRun`, `updateJobRun`, `updateJobStepRun`, and `claimDueJobs` repeat the same `new Date().toISOString()`, `actorToStamp`, `resolveActor`, and `"field" in patch ? value ?? null : existing` patterns.

5. Add direct cron parser tests before changing scheduler timing logic. `src/cron.ts` has independent parsing behavior, but current coverage reaches it mostly through scheduler tests and one invalid-cron flow validation assertion; a table-driven `cron.test.ts` would make reductions in `parseFieldPart`, `parseField`, and `nextFireAfter` safer.
