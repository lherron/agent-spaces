# coordination-substrate Refactor Notes

## Purpose

`coordination-substrate` is a private Bun/TypeScript package that provides a SQLite-backed coordination ledger for ACP handoffs, wake requests, local dispatch stubs, and event timelines. It owns durable storage for append-only coordination events plus mutable read-model tables for current handoff and wake state, with project-scoped sequence ordering and canonical session references supplied by `agent-scope`.

## Public Surface

The package exports a single module entry point from `src/index.ts`.

- Store lifecycle and migrations: `openCoordinationStore`, `createCoordinationDatabase`, `runMigrations`, `listAppliedMigrations`, `readSchemaSql`, and the `CoordinationStore` type from `src/storage/open-store.ts`.
- Event write API: `appendEvent`, `AppendEventCommand`, and `AppendEventResult` from `src/commands/append-event.ts`.
- Handoff state APIs: `acceptHandoff`, `completeHandoff`, `cancelHandoff`, plus their command types from `src/commands/*handoff.ts`.
- Wake state APIs: `leaseWake`, `consumeWake`, `cancelWake`, plus their command types from `src/commands/*wake.ts`.
- Query APIs: `listEvents`, `listEventLinks`, `listOpenHandoffs`, and `listPendingWakes` from `src/queries/*.ts`.
- Domain types: `CoordinationEvent`, `CoordinationEventInput`, `CoordinationEventKind`, `CoordinationEventLinks`, `CoordinationEventSource`, `Handoff`, `HandoffInput`, `HandoffKind`, `HandoffState`, `WakeRequest`, `WakeRequestInput`, `WakeRequestState`, `LocalDispatchAttempt`, and `ParticipantRef`.
- Session helpers: `canonicalizeSessionRef`, `formatCanonicalSessionRef`, `parseCanonicalSessionRef`, and `isCanonicalSessionRef` from `src/util/session-ref.ts`.
- HTTP routes: none in this package. `acp-server` consumes it to implement routes such as `POST /v1/coordination/messages`.
- CLI commands: none in this package. `acp-cli` depends on it for integration tests and calls the server-facing coordination surface.

## Internal Structure

- `src/commands/append-event.ts` is the main write path. It normalizes the project ID, handles idempotency by `(projectId, idempotencyKey)`, creates the per-project sequence, inserts the event row, event links, participants, optional handoff, optional wake request, and optional local dispatch attempt rows in one transaction.
- `src/commands/accept-handoff.ts`, `complete-handoff.ts`, and `cancel-handoff.ts` update current handoff state from `open` to `accepted`, from `accepted` to `completed`, or from `open`/`accepted` to `cancelled`.
- `src/commands/lease-wake.ts`, `consume-wake.ts`, and `cancel-wake.ts` update wake request state from queued or leased states.
- `src/queries/timeline.ts` builds the project-scoped event timeline with filters for sequence ranges, semantic session, task/run/session links, conversation thread, participant, and limit.
- `src/queries/links.ts` returns link-oriented event records for task, run, session, and conversation-thread queries.
- `src/queries/handoffs.ts` returns currently open handoffs filtered by project, task, target participant, or target session.
- `src/queries/wakes.ts` returns queued or leased wake requests filtered by project and optionally canonical session.
- `src/storage/open-store.ts` opens `bun:sqlite`, enables WAL, foreign keys, and a busy timeout, then applies the migration set.
- `src/storage/records.ts` holds row types, hydration helpers, and internal point-lookups for events, handoffs, wakes, and local dispatch attempts.
- `src/storage/schema.sql` and `src/storage/migrations/001_initial.sql` define the same tables and indexes: coordination events, event participants, event links, handoffs, wake requests, local dispatch attempts, projection cursors, project sequence counters, and supporting indexes.
- `src/types/*.ts` define the persisted domain model and input variants.
- `src/util/json.ts`, `sequence.ts`, `session-ref.ts`, and `ulid.ts` provide stable JSON stringification, project-local sequence counters, canonical session formatting/parsing, and ULID generation.

## Dependencies

- Production dependencies: `agent-scope` for `SessionRef` and `normalizeSessionRef`; Bun runtime modules `bun:sqlite`; Node built-ins `node:fs`, `node:path`, `node:url`, and `node:crypto`.
- Test and build dependencies: Bun's built-in `bun:test`, `@types/bun`, and `typescript`.
- Consumers found in the monorepo: `acp-server`, `acp-cli`, and `acp-e2e` depend on or import this package directly.

## Test Coverage

The package has 11 contract test files with 11 test cases under `test/contract`, plus `test/fixtures/tmp-store.ts`. Covered behavior includes canonical wake session triggering, append-only event history, separation of source metadata from semantic session links, projection rebuildability from public reads, project isolation, idempotent event writes, open handoff visibility, HAL read-model derivation, ACP delivery boundaries, replay ordering, and conversation correlation.

Coverage gaps I found: migration application and asset resolution in `src/storage/open-store.ts` are not tested directly; `acceptHandoff`, `completeHandoff`, and `leaseWake` have no direct state-transition tests; duplicate `WakeRequestInput.dedupeKey` handling is not covered; `localRecipients` without a `wake` is not covered even though `appendEvent` allows it; and `readSchemaSql` is exported but not exercised.

## Recommended Refactors and Reductions

1. Remove or generate the duplicated schema copy in `src/storage/schema.sql` and `src/storage/migrations/001_initial.sql`. The two files currently contain the same DDL, while `runMigrations` only executes the migration file and `readSchemaSql` only reads `schema.sql`; keeping both as hand-maintained sources creates drift risk without an obvious runtime need.

2. Clarify or remove `projection_cursors` in `src/storage/schema.sql` and `src/storage/migrations/001_initial.sql`. No source or test file references `projection_cursors`, so it is currently dead schema inside this package.

3. Split `appendEvent` in `src/commands/append-event.ts` into smaller private insert helpers. The current 327-line file mixes idempotency lookup, event insertion, link insertion, participant insertion, handoff insertion, wake insertion, local dispatch insertion, and result hydration, which makes the central write path harder to review and test in isolation.

4. Resolve the unused actor fields in handoff transition command types. `AcceptHandoffCommand.by`, `CompleteHandoffCommand.by`, and `CancelHandoffCommand.by` are accepted in `src/commands/*handoff.ts` but never recorded, validated, or returned; either persist transition actors in an event/audit row or remove those command fields from the public API.

5. Make wake dedupe behavior explicit in `appendEvent`. `WakeRequestInput.dedupeKey` is stored and has a unique index in `src/storage/schema.sql`, but `src/commands/append-event.ts` does not check for an existing wake by dedupe key the way it checks `idempotencyKey`, so duplicate wake dedupe requests surface as SQLite constraint failures instead of a stable command result.

6. Tighten the local dispatch attempt boundary in `appendEvent`. `localRecipients` can be supplied without `wake`, which inserts `local_dispatch_attempts.wake_id = NULL`; those rows have no public query API and `buildExistingResult` only rehydrates dispatch attempts when a wake exists, so idempotent retries lose that portion of the returned result.
