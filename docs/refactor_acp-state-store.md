# acp-state-store Refactor Notes

## Purpose

`acp-state-store` owns the durable SQLite state layer for ACP server runs, input attempts, and transition outbox records. It opens and migrates an ACP state database, exposes repository classes around the three tables, and normalizes persisted rows back into ACP domain types from `acp-core` and `agent-scope`.

## Public Surface

The package export is `.` via `src/index.ts`; there are no HTTP routes or CLI commands in this package.

- `openAcpStateStore(options: OpenAcpStateStoreOptions): AcpStateStore` opens a SQLite database at `dbPath`, creates schema, runs legacy migrations, and returns repositories plus `runInTransaction` and `close`.
- `AcpStateStore` exposes `sqlite`, `runs`, `inputAttempts`, `transitionOutbox`, `runInTransaction(fn)`, and `close()`.
- `RunRepo` exposes `createRun`, `getRun`, `listRuns`, `listRunsForSession`, `updateRun`, and `setDispatchFence`.
- `InputAttemptRepo` exposes `createAttempt`, including idempotency-key conflict handling through `InputAttemptConflictError`.
- `TransitionOutboxRepo` exposes `append`, `leaseNext`, `markErrored`, `markDelivered`, and `get`.
- Exported types include `DispatchFence`, `StoredRun`, `UpdateRunInput`, `StoredInputAttempt`, `InputAttemptCreateResult`, `TransitionOutboxStatus`, `TransitionOutboxRecord`, and `AppendTransitionOutboxInput`.

## Internal Structure

- `src/open-store.ts` defines `OpenAcpStateStoreOptions`, `AcpStateStore`, schema initialization, WAL/foreign-key/busy-timeout pragmas, legacy actor-column migrations, repository construction, transaction wrapping, and close behavior.
- `src/sqlite.ts` defines the local SQLite abstraction. Under Bun it wraps `bun:sqlite`; otherwise it dynamically imports `better-sqlite3`.
- `src/types.ts` extends ACP domain types with store-specific run, input-attempt, dispatch-fence, and transition-outbox types, plus `InputAttemptConflictError`.
- `src/repos/run-repo.ts` maps `runs` rows to `StoredRun`, creates run IDs, persists run updates, stores dispatch fences in both JSON and queryable legacy columns, and lists runs globally or by session.
- `src/repos/input-attempt-repo.ts` creates idempotent input attempts, normalizes legacy `{ agentId }` actor input, computes stable fingerprints, creates the paired run, and supports legacy `actor_agent_id` columns.
- `src/repos/transition-outbox-repo.ts` appends transition events, leases pending or leased events for delivery retry, marks delivery state, and maps payload JSON back to records.
- `src/repos/shared.ts` contains repository context and row mapping helpers for optional strings/numbers/booleans and JSON object parsing.
- `test/smoke.test.ts` validates in-memory store construction and actor-stamped run/input/outbox creation.
- `test/migration.test.ts` builds a legacy SQLite fixture and verifies actor-column migration/backfill plus writes against the migrated input-attempt table.

## Dependencies

Production dependencies:

- `acp-core`: source of `Actor`, `InputAttempt`, and `Run` domain types.
- `agent-scope`: source of `SessionRef`.
- `better-sqlite3`: Node fallback SQLite implementation loaded when Bun is unavailable.
- Node built-ins: `node:crypto`, `node:fs`, and `node:path`.
- Bun runtime, when available: `bun:sqlite` is preferred by `src/sqlite.ts`.

Test and build dependencies:

- `bun test` / `bun:test` and `bun:sqlite` for package tests and migration fixture setup.
- Node built-ins `node:fs`, `node:os`, and `node:path` in tests.
- `@types/better-sqlite3`, `@types/bun`, and `typescript` for typing and build.

## Test Coverage

There are 2 package test files and 2 test cases.

- Covered: opening an in-memory store, creating actor-stamped run/input/outbox records, opening a legacy database, adding actor columns, backfilling legacy actors, preserving the legacy `actor_agent_id` column, and writing new input attempts after migration.
- Covered in downstream `acp-server` tests: SQLite run persistence, input-attempt persistence, and transition-outbox behavior through `openAcpStateStore`.
- Gaps: `RunRepo.updateRun`, `RunRepo.setDispatchFence`, `RunRepo.listRuns`, `RunRepo.listRunsForSession`, `TransitionOutboxRepo.leaseNext`, `markErrored`, `markDelivered`, and idempotency conflict handling are not directly covered by this package's own tests.
- Gaps: `src/sqlite.ts` has no Node fallback test that exercises the `better-sqlite3` path when Bun is unavailable.
- Gaps: test files are excluded from `packages/acp-state-store/tsconfig.json`; `test/smoke.test.ts` passes a `createdAt` property to `transitionOutbox.append` even though `AppendTransitionOutboxInput` does not declare it.

## Recommended Refactors and Reductions

1. Extract the repeated `runs` SELECT projection in `src/repos/run-repo.ts` into a shared constant or query builder used by `getRun`, `listRuns`, and `listRunsForSession`. The current duplicated column list spans every persisted run field and can drift from `RunRow`, `mapRunRow`, or `open-store.ts` schema changes.

2. Parse metadata once in `mapInputAttemptRow` in `src/repos/input-attempt-repo.ts`. The current conditional calls `parseJsonRecord(row.metadata_json)` twice, which is unnecessary work and creates two separate parse failure points for one row.

3. Clarify or reduce the unused terminal outbox state in `src/types.ts` and `src/repos/transition-outbox-repo.ts`. `TransitionOutboxStatus` and the schema allow `'failed'`, but `TransitionOutboxRepo` never writes that status; `markErrored` keeps records in `'leased'`. Either add the missing failure transition or remove `'failed'` from the exposed status and schema check.

4. Pull actor-column migration backfill into a shared helper in `src/open-store.ts`. `migrateRunsActorColumns`, `migrateInputAttemptsActorColumns`, and `migrateTransitionOutboxActorColumns` all add `actor_kind`, `actor_id`, and `actor_display_name` and then perform similar default backfills; only the input-attempt legacy `actor_agent_id` branch is distinct.

5. Isolate the legacy `actor_agent_id` compatibility branch in `InputAttemptRepo.createAttempt`. The constructor-level `hasLegacyActorAgentIdColumn` check is necessary for migrated databases, but the two INSERT statements in `src/repos/input-attempt-repo.ts` duplicate almost every value; a small insert helper would keep future input-attempt columns from needing two manual edits.

6. Add typechecking for package tests or remove the stale `createdAt` argument in `test/smoke.test.ts`. Because `packages/acp-state-store/tsconfig.json` excludes `test`, this mismatch with `AppendTransitionOutboxInput` is invisible to the package typecheck.
