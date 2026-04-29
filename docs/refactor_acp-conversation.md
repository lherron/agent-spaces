# acp-conversation Refactor Notes

## Purpose

`acp-conversation` provides the optional SQLite-backed conversation history store for ACP. It records external conversation threads, human and assistant turns, render state transitions, actor stamps, and correlation links back to input attempts, runs, tasks, handoffs, delivery requests, and coordination events. The package is currently consumed by `acp-server` when `--conversation-db-path` or `ACP_CONVERSATION_DB_PATH` enables conversation persistence.

## Public Surface

The package exports a single module from `src/index.ts`.

- Store constructors and migration helpers: `openSqliteConversationStore`, `createInMemoryConversationStore`, `runConversationStoreMigrations`, `listAppliedConversationStoreMigrations`, `conversationStoreMigrations`.
- Store and data types: `ConversationStore`, `ConversationStoreMigration`, `ConversationThread`, `StoredConversationTurn`, `ConversationTurnLinks`, `ConversationAudience`, `OpenSqliteConversationStoreOptions`.
- SQLite adapter surface: default export alias `SqliteDatabase` plus type aliases `ConversationSqliteDatabase`, `ConversationSqliteDatabaseConstructor`, `ConversationSqliteRunResult`, and `ConversationSqliteStatement`.

`ConversationStore` exposes these runtime operations:

- `runInTransaction(fn)` and `close()`.
- Thread operations: `createOrGetThread`, `getThread`, `listThreads`.
- Turn operations: `createTurn`, `updateRenderState`, `attachLinks`, `listTurns`, `findTurnByLink`.

The package does not define HTTP routes or CLI commands directly. `acp-server` wires it into the server in `packages/acp-server/src/cli.ts` and exposes it through `GET /v1/conversation/threads`, `GET /v1/conversation/threads/:threadId`, and `GET /v1/conversation/threads/:threadId/turns`.

## Internal Structure

- `src/index.ts` is a barrel export for store constructors, public types, migration constants, and the SQLite adapter.
- `src/open-store.ts` contains the schema migrations, SQLite database initialization, row types, row-to-domain mappers, render-state transition rules, and the full `ConversationStore` implementation.
- `src/sqlite.ts` abstracts over Bun's built-in `bun:sqlite` at runtime and falls back to `better-sqlite3` outside Bun. It normalizes statement and database method shapes behind local interfaces.
- `src/__tests__/threads-store.test.ts` covers thread idempotency, thread lookup, project filtering, and exact `SessionRef` filtering.
- `src/__tests__/turns-store.test.ts` covers turn ordering, `since` and `limit` list options, post-create link attachment, and legal render-state transitions.
- `test/smoke.test.ts` verifies an in-memory store can be created and migrated.
- `tsconfig.json` builds only `src/**/*` to `dist` and excludes test files.

## Dependencies

Production dependencies:

- `acp-core`: provides `Actor` and `ConversationTurnRenderState` types.
- `agent-scope`: provides `SessionRef` and `normalizeSessionRef`.
- `better-sqlite3`: Node runtime fallback in `src/sqlite.ts` when Bun is unavailable.

Runtime platform dependency:

- Bun is preferred when available through dynamic import of `bun:sqlite`; this is not listed in `dependencies` because it is a runtime provider rather than an npm package.

Development and test dependencies:

- `@types/better-sqlite3` for the Node fallback adapter types.
- `@types/bun` for Bun and `bun:test` globals.
- `typescript` for package compilation.
- Bun's built-in test runner is used by the package `test` script.

## Test Coverage

Current package coverage is 6 tests across 3 files, with 44 expectations. `bun run --filter acp-conversation test` passed.

Covered behavior includes in-memory construction and migration bookkeeping, idempotent thread creation by `(gatewayId, conversationRef, threadRef)`, `getThread`, `listThreads` filters by `projectId` and `sessionRef`, turn ordering by `sentAt`, `since` and `limit` options, link attachment, and core render-state transition rules.

Coverage gaps:

- `openSqliteConversationStore` with a real file path is not tested, including directory creation, WAL setup, reopening a migrated database, and migration idempotency across process lifetimes.
- `runInTransaction` is not tested for rollback behavior.
- `findTurnByLink` is not directly tested in this package, even though `acp-server` ack/fail delivery handlers depend on it.
- `attachLinks` is not tested for merge-only no-overwrite behavior.
- Failure reasons passed to `updateRenderState(..., 'failed', { failureReason })` are not tested.
- The schema allows orphaned turns because `conversation_turns.threadId` has no foreign key constraint, and there is no test documenting whether that is intentional.

## Recommended Refactors and Reductions

1. Split `src/open-store.ts` by responsibility. At 560 lines it currently combines migrations, SQLite setup, row mapping, transition validation, and both thread and turn repositories. Reasonable extraction points are schema/migration helpers around `conversationStoreMigrations`, row mappers `threadRowToThread` and `turnRowToTurn`, and method groups for thread and turn operations. This would reduce the blast radius of future schema changes.

2. Add or explicitly reject a foreign key for `conversation_turns.threadId` in `src/open-store.ts`. `createSqliteDatabase` enables `PRAGMA foreign_keys = ON`, but migration `002_conversation_threads_and_turns` does not declare `FOREIGN KEY (threadId) REFERENCES conversation_threads(threadId)`. That makes the pragma misleading and allows `createTurn` to persist turns for nonexistent threads.

3. Replace the raw-column `field` parameter in `findTurnByLink` with an internal map. The public type limits `field` to `'linksRunId' | 'linksDeliveryRequestId'`, but the implementation still interpolates it into SQL in `src/open-store.ts`. A map such as `{ runId: 'linksRunId', deliveryRequestId: 'linksDeliveryRequestId' }` would make the boundary clearer and avoid spreading column names into callers.

4. Remove duplicated test-local public types in `src/__tests__/threads-store.test.ts` and `src/__tests__/turns-store.test.ts`. These files redeclare `ConversationAudience`, `ConversationThread`, `ConversationTurnLinks`, and `StoredConversationTurn` even though the package exports them from `src/index.ts`. Importing the public types would reduce drift between tests and the real API.

5. Reassess the SQLite adapter exports in `src/index.ts`. `SqliteDatabase` and the `ConversationSqlite*` type aliases appear to be exported only for external escape hatches; repo usage found no consumers outside `acp-conversation`. If no downstream package needs them, keep `src/sqlite.ts` internal and expose only `ConversationStore.sqlite` through its existing structural type.

6. Add focused tests before changing delivery-linked behavior. `packages/acp-server/src/handlers/gateway-deliveries-ack.ts` and `packages/acp-server/src/handlers/gateway-deliveries-fail.ts` rely on `findTurnByLink('linksDeliveryRequestId', ...)` and `updateRenderState`. Package-level tests for `findTurnByLink`, failed-state `failureReason`, and invalid terminal transitions would protect that integration without needing to exercise the whole server.
