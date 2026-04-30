# Refactor notes: `wrkq-lib`

## Purpose

`wrkq-lib` is a thin TypeScript persistence layer over an existing wrkq SQLite database for ACP task workflows. It does not own migrations or DDL; instead, it opens a pre-migrated `wrkq.db`, validates the tables and ACP-related task columns it needs, lazily resolves ACP actors into wrkq actor rows, and exposes repository implementations for ACP tasks, evidence, role assignments, and transition logs.

## Public surface

The package exports a single ESM entry point from `src/index.ts`. Public functions and types are `openWrkqStore(options)`, `assertWrkqSchemaPresent(sqlite, dbPath)`, `OpenWrkqStoreOptions`, and `WrkqStore`. `openWrkqStore` returns a store with `sqlite`, `taskRepo`, `evidenceRepo`, `roleAssignmentRepo`, `transitionLogRepo`, `runInTransaction(fn)`, and `close()`.

The exported classes are `ActorResolver`, `TaskRepo`, `EvidenceRepo`, `RoleAssignmentRepo`, and `TransitionLogRepo`. The repositories implement the `acp-core` store contracts for `TaskStore`, `EvidenceStore`, `RoleAssignmentStore`, and `TransitionLogStore`.

The exported errors are `WrkqSchemaMissingError`, `WrkqTaskNotFoundError`, `WrkqProjectNotFoundError`, and `VersionConflictError`. `acp-server` maps these errors to HTTP responses, while `acp-cli` and server startup code use `WrkqSchemaMissingError` to report schema setup problems.

There are no HTTP routes or CLI commands in this package. HTTP routing lives in `packages/acp-server`, and CLI behavior lives in `packages/acp-cli`.

## Internal structure

- `src/open-store.ts` validates the wrkq schema, opens SQLite with foreign keys, WAL, and a busy timeout, constructs the shared repository context, and wires the four repository instances into a `WrkqStore`.
- `src/sqlite.ts` provides a narrow SQLite abstraction. Under Bun it wraps `bun:sqlite`; otherwise it imports `better-sqlite3`.
- `src/actor-resolver.ts` resolves ACP actor identities to wrkq actor UUIDs, caches by `agentId`, and lazily creates missing `actors` rows with generated `A-00000`-style IDs.
- `src/repos/task-repo.ts` creates, loads, and updates tasks, translates ACP lifecycle state to wrkq state, stores ACP task kind in `tasks.meta.acp.kind`, updates role assignments, and enforces optimistic concurrency through `etag`.
- `src/repos/evidence-repo.ts` lists evidence by task and appends evidence items, defaulting the producer to the store actor when evidence does not specify one.
- `src/repos/role-assignment-repo.ts` reads and replaces a task's role map.
- `src/repos/transition-log-repo.ts` appends and lists transition records, stores ACP transition metadata in `task_transitions.meta`, and links transitions to matching direct or waived evidence item UUIDs.
- `src/repos/shared.ts` contains shared project/task lookup helpers, role-map loading/replacement, and task slug derivation.
- `src/mapping/*.ts` converts between wrkq SQL rows/write records and `acp-core` models for tasks, evidence, role assignments, and transitions.
- `src/json.ts` provides stable JSON stringification and typed JSON parsing helpers.

## Dependencies

Production dependencies are `acp-core` for ACP model and store contracts and `better-sqlite3` for non-Bun SQLite runtime support. At runtime under Bun, `src/sqlite.ts` uses `bun:sqlite` instead of `better-sqlite3`; `src/open-store.ts` also uses Node `fs.existsSync`.

Test and development dependencies are `@types/better-sqlite3`, `@types/bun`, and `typescript`. Tests use `bun:test`, `bun:sqlite`, Node `crypto`, `fs`, `os`, and `path`, `better-sqlite3`, the local `acp-core` transition helpers, and a schema dump from the sibling wrkq checkout.

## Test coverage

There are 21 Bun tests:

- `test/task-repo.test.ts`: 7 tests for task create/read/update, missing task reads, stale-version conflicts, non-ACP wrkq states, non-preset tasks, and missing schema failure.
- `test/evidence-repo.test.ts`: 4 tests for default producers, metadata round-tripping, ordering, and missing-task writes.
- `test/role-assignment-repo.test.ts`: 4 tests for missing tasks, empty maps, set/get behavior, and replace-all semantics.
- `test/transition-log-repo.test.ts`: 4 tests for transition round-tripping, evidence UUID linking, ordering, and missing-task writes.
- `test/integration.test.ts`: 2 tests for cross-repository round trips, optimistic concurrency, and compatibility with `acp-core` transition validation.

Coverage is strong for the repository happy paths and major error cases. Gaps remain around `runInTransaction()`, actor cache behavior after an existing actor row changes, concurrent actor/evidence ID allocation, malformed JSON payloads in `meta`, `openWrkqStore` on a missing database path, and direct coverage for the unused role-assignment mapper file.

## Recommended refactors and reductions

1. Remove or reuse `src/mapping/role-assignment-row.ts`. `mapRoleAssignmentRows()` is not imported by any source or test file, while `src/repos/shared.ts` defines its own `RoleAssignmentRow` and repeats the same reduce logic in `loadRoleMap()`. Either delete the mapping file or make `loadRoleMap()` call it so there is one role-row mapper.

2. Extract a small `getTaskUuidForRead()` helper for repository read paths. `EvidenceRepo.listEvidence()`, `RoleAssignmentRepo.getRoleMap()`, and `TransitionLogRepo.listTransitions()` each run a local `SELECT uuid FROM tasks WHERE id = ?` and return an empty result on missing tasks. Keeping that read-missing semantic in one helper would reduce duplicated SQL while leaving `requireTaskLookup()` for write paths that should throw.

3. Centralize generated wrkq ID allocation. `ActorResolver.resolveActorUuid()` computes the next `A-00000` actor ID, while `EvidenceRepo.appendEvidence()` computes the next `EV-00000` evidence ID with the same `MAX(CAST(substr(...))) + 1` pattern. A shared helper would reduce duplicated SQL and make it easier to add a single retry path if a unique constraint race occurs.

4. Replace the absolute schema dump path in `test/fixtures/seed-wrkq-db.ts`. The fixture currently reads `/Users/lherron/praesidium/wrkq/schema_dump.sql`, which ties package tests to one local checkout layout. Resolving from an environment variable or from the repo root would keep the same real-schema coverage without baking a user-specific path into the package.
