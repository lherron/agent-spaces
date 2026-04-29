# Refactor Notes: acp-admin-store

## Purpose

`acp-admin-store` provides the SQLite-backed persistence layer for ACP administration data: agents, projects, project memberships, interface identity links, system events, and agent heartbeats. It exposes a single aggregate `AdminStore` plus section-specific store handles, supports in-memory operation for tests/default server wiring, and owns the local schema migrations needed by `acp-server` when `--admin-db-path` is supplied.

## Public Surface

The package exports only `.` via `packages/acp-admin-store/src/index.ts`. Its primary entry points are `openSqliteAdminStore(options)` and `createInMemoryAdminStore()`, both returning `AdminStore` with `sqlite`, migration metadata, section stores, `runInTransaction`, and `close`.

Section helpers wrap the same underlying admin store shape: `openSqliteAgentsStore`, `createInMemoryAgentsStore`, `openSqliteProjectsStore`, `createInMemoryProjectsStore`, `openSqliteMembershipsStore`, `createInMemoryMembershipsStore`, `openSqliteInterfaceIdentitiesStore`, `createInMemoryInterfaceIdentitiesStore`, `openSqliteSystemEventsStore`, `createInMemorySystemEventsStore`, `openSqliteHeartbeatsStore`, and `createInMemoryHeartbeatsStore`.

The exported store interfaces and inputs live in `src/open-store.ts`: `AdminStore`, `AgentsStore`, `ProjectsStore`, `MembershipsStore`, `InterfaceIdentitiesStore`, `SystemEventsStore`, `HeartbeatsStore`, `OpenSqliteAdminStoreOptions`, `AdminStoreMigration`, and `UpsertHeartbeatInput`. The package reuses admin record types from `acp-core`, including `AdminAgent`, `AdminProject`, `AdminMembership`, `InterfaceIdentity`, `SystemEvent`, `AgentHeartbeat`, `Actor`, and related status/role unions.

Migration and heartbeat utilities are public: `adminStoreMigrations`, `listAppliedAdminStoreMigrations`, `runAdminStoreMigrations`, `STALE_HEARTBEAT_THRESHOLD_MS`, `checkStaleHeartbeats`, `STALE_HEARTBEAT_EVENT_KIND`, and `StaleHeartbeatCheckResult`. SQLite portability types and the selected constructor are also public as `SqliteDatabase`, `AdminSqliteDatabase`, `AdminSqliteDatabaseConstructor`, `AdminSqliteRunResult`, and `AdminSqliteStatement`.

There are no HTTP routes or CLI commands in this package. `acp-server` consumes it directly: `src/deps.ts` defaults to `createInMemoryAdminStore()`, while `src/cli.ts` uses `openSqliteAdminStore({ dbPath })` when `--admin-db-path` is present.

## Internal Structure

`src/open-store.ts` is the main implementation. It defines row types, input and store interfaces, four migrations, SQLite setup, actor stamp serialization, row-to-domain mappers, concrete section stores, aggregate store creation, migration runners, and section-specific open/create helpers.

`src/sqlite.ts` abstracts over Bun and Node SQLite runtimes. Under Bun it dynamically imports `bun:sqlite` and wraps statements/results behind the local `SqliteDatabase` and `SqliteStatement` interfaces; otherwise it loads `better-sqlite3`.

`src/heartbeat-stale.ts` implements stale heartbeat detection. It computes a threshold, reads stale heartbeats, marks them stale through raw SQL on `store.sqlite`, resolves a project either from options or by scanning memberships, and appends `agent.heartbeat.stale` system events.

`src/index.ts` is a re-export barrel. `src/__tests__/*.test.ts` contains acceptance coverage for each section store plus placement metadata, heartbeat target persistence, and stale heartbeat detection. `test/smoke.test.ts` checks package construction through the source entry point.

## Dependencies

Production dependencies are `acp-core` for shared admin/domain types and `better-sqlite3` for non-Bun SQLite operation. Bun runtime operation uses `bun:sqlite` through the dynamic import in `src/sqlite.ts`, so it is not declared as a package dependency.

Test and build dependencies are Bun's built-in `bun:test`, `@types/bun`, `@types/better-sqlite3`, and `typescript`. The package is private, emits `dist`, and exposes TypeScript source to Bun through the `exports["."].bun` condition.

## Test Coverage

I counted 50 tests across 9 test files: agents store (4), projects store (4), memberships store (3), interface identities store (4), system events store (3), heartbeats and stale detection (12), placement metadata (12), heartbeat target persistence (7), and smoke construction (1).

Coverage is strongest for CRUD/upsert semantics, ordering, optional field omission, duplicate idempotency, in-memory operation, `:memory:` SQLite operation, stale heartbeat event emission, and migration-visible placement/target fields. Gaps: there is no test that opens a real filesystem database path and reopens it to prove persistence across handles; no test covers `runInTransaction` rollback behavior; no test exercises the Node/`better-sqlite3` branch of `src/sqlite.ts`; and no migration test starts from a database at migration 001 or 002 before applying later migrations.

## Recommended Refactors and Reductions

1. Split `src/open-store.ts` by responsibility. At 1,204 lines it combines schema migrations, row definitions, mapper functions, all store implementations, and factory helpers. A low-risk split would move migrations, mappers, and each section store into focused modules while keeping `src/index.ts` exports unchanged.

2. Remove the duplicate post-insert lookup in `createMembershipsStore.add` (`src/open-store.ts:726-741`). The same `SELECT project_id, agent_id, role, created_at, actor_stamp` statement is prepared and executed twice; selecting once into a local row and checking it would reduce work and simplify the error path.

3. Add a membership lookup path for stale heartbeat project resolution. `checkStaleHeartbeats` (`src/heartbeat-stale.ts:47-58`) currently lists every project and calls `memberships.listByProject` until it finds each stale agent. A store method or internal query keyed by `agent_id` would avoid repeated project scans and make the lookup boundary explicit.

4. Make later migrations resilient to partially migrated databases. Migrations `003_placement_metadata` and `004_heartbeat_target` use unconditional `ALTER TABLE ... ADD COLUMN` statements (`src/open-store.ts:290-300`), while `runAdminStoreMigrations` records a migration only after `sqlite.exec` succeeds (`src/open-store.ts:1087-1092`). A database with the column already present but the migration row missing will fail instead of converging; guarded migration helpers or column introspection would reduce recovery friction.

5. Consolidate repeated column-list SQL. Agent, project, membership, identity, event, and heartbeat queries repeat their select column lists across `create`, `get`, `list`, and helper paths in `src/open-store.ts`. Local constants per table would reduce drift risk when schema fields are added, especially around `home_dir`, `root_dir`, `target_scope_ref`, and `target_lane_ref`.
