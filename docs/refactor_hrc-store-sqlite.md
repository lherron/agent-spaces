# hrc-store-sqlite Refactor Notes

## Purpose

`hrc-store-sqlite` is the SQLite persistence package for Harness Runtime Controller state. It owns database opening, schema migrations, and repository access for continuities, sessions, app-managed sessions, app sessions, runtimes, runs, launches, legacy event envelopes, typed HRC lifecycle events, local bridges, surface bindings, runtime output buffers, and hrcchat messages. The package is intentionally storage-focused: callers get a single `HrcDatabase` facade backed by `bun:sqlite`, while record shapes and domain enums come from `hrc-core`.

## Public surface

The package export map points `.` at `src/index.ts` for Bun and `dist/index.js` for normal ESM imports. `src/index.ts` exports:

- `openHrcDatabase(dbPath)` from `src/database.ts`.
- Type `HrcDatabase` from `src/database.ts`.
- Types `AppManagedSessionRecord`, `AppManagedSessionFindOptions`, `EventAppendInput`, `HrcLifecycleEventInput`, and `HrcLifecycleQueryFilters` from `src/repositories.ts`.
- `MessageRepository` and type `MessageInsertInput` from `src/message-repository.ts`.

There are no HTTP routes and no CLI commands in this package. The operational public surface is the `HrcDatabase` object returned by `openHrcDatabase`, which exposes `sqlite`, `close()`, `migrations.applied`, and repository properties: `continuities`, `sessions`, `appManagedSessions`, `appSessions`, `runtimes`, `runs`, `launches`, `events`, `hrcEvents`, `localBridges`, `surfaceBindings`, `runtimeBuffers`, and `messages`.

## Internal structure

- `src/database.ts` creates the Bun SQLite database, creates parent directories for file-backed databases, enables WAL, foreign keys, and a 5000 ms busy timeout, runs migrations, and builds the `HrcDatabase` repository facade.
- `src/migrations.ts` defines `HrcMigration`, all schema migrations, legacy HRC event backfill logic, the shared event stream cursor, and `runMigrations` / `listAppliedMigrations`.
- `src/repositories.ts` contains most table repositories and row mappers: continuity/session ancestry, app sessions, app-managed sessions, runtimes, runs, launches, legacy `events`, typed `hrc_events`, local bridges, surface bindings, runtime buffers, JSON parsing helpers, boolean conversion helpers, SQL column lists, and dynamic update helpers.
- `src/message-repository.ts` contains the hrcchat message row mapper and `MessageRepository` methods for insert, lookup by id/sequence, filtered queries, max sequence, and execution patching.
- `src/index.ts` is the package-level export boundary.
- `src/__tests__/*.test.ts` are Bun tests that exercise opening, migrations, repositories, foreign-key behavior, JSON corruption handling, hrc lifecycle events, hrcchat messages, app/session registries, surface bindings, local bridges, runtime buffers, and WAL concurrent reads.

## Dependencies

Production dependencies are `hrc-core` plus Bun and Node built-ins used directly by source files: `bun:sqlite`, `node:fs`, and `node:path`. Test code additionally uses `bun:test`, `node:fs/promises`, `node:os`, and `node:path`. Package dev dependencies are `@types/bun` and `typescript`.

## Test coverage

There are 11 test files with 136 `it(...)` test cases. Coverage is strong for repository CRUD paths, migration application and upgrade/backfill paths, shared event stream ordering between `events` and `hrc_events`, foreign-key rejection, JSON parse crash guards in the main repository mappers, runtime buffer scoping by run, and SQLite WAL read concurrency.

Known gaps from the files read:

- `src/message-repository.ts` parses `metadata_json` with direct `JSON.parse` in `mapMessageRow`, unlike the guarded `parseJson` helper in `src/repositories.ts`; the message tests cover valid metadata but not corrupted message metadata.
- `MessageRepository.updateExecution` in `src/message-repository.ts` has coverage for a successful patch, but no test asserts behavior for unknown `messageId` or an empty patch.
- `createHrcDatabase` in `src/database.ts` handles `''` and `':memory:'` as ephemeral paths, but the tests only exercise file-backed database paths.

## Recommended refactors and reductions

1. Split `src/repositories.ts` by repository or table family. At 2,512 lines, it combines row types, mappers, SQL column constants, update helpers, and 11 repository classes (`ContinuityRepository`, `SessionRepository`, `AppSessionRepository`, `AppManagedSessionRepository`, `RuntimeRepository`, `RunRepository`, `LaunchRepository`, `EventRepository`, `HrcLifecycleEventRepository`, `LocalBridgeRepository`, `SurfaceBindingRepository`, `RuntimeBufferRepository`). Moving table-specific row types, mappers, and classes into focused files would reduce the largest maintenance hotspot without changing behavior.

2. Extract migration groups from `src/migrations.ts`. The file mixes base DDL migrations, incremental table/index migrations, shared stream cursor setup, and the `0009_backfill_legacy_hrc_events` transformation helpers (`parseLegacyEventJson`, `categoryForLegacyHrcEventKind`, `normalizeLegacyHrcPayload`). Keeping the migration list in one file but moving large migration bodies/backfill helpers into named modules would make migration ordering easier to review.

3. Reuse one guarded JSON parser for messages. `src/repositories.ts` has `parseJson` with corruption logging and non-throwing reads, while `src/message-repository.ts` uses direct `JSON.parse` for `metadata_json` in `mapMessageRow`. Sharing the guarded helper or adding the same behavior in `MessageRepository` would align message reads with the rest of the package.

4. Reduce repeated dynamic patch assembly. `RuntimeRepository.update`, `RunRepository.update`, `LaunchRepository.update`, `AppSessionRepository.update`, `AppManagedSessionRepository.update`, and `MessageRepository.updateExecution` all manually build `entries`/`sets` arrays from optional patch fields. A small typed helper for optional field-to-column mapping would remove duplicated branching while preserving each repository's explicit column map.

5. Clarify the package boundary for migration/test helpers. `createHrcDatabase` in `src/database.ts` and `phase1Migrations` in `src/migrations.ts` are not exported through `src/index.ts`, but tests import them directly for migration upgrade fixtures. If these are intended as package-private testing seams, keep them internal and document that in comments; if external tooling needs them, expose them intentionally through `src/index.ts`.

No obvious dead code or unused exported package symbols were found in the package files read.
