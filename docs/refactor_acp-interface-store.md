# acp-interface-store Refactor Notes

## Purpose

`acp-interface-store` is the SQLite persistence layer for ACP interface delivery state. It stores external gateway bindings, inbound message idempotency records, outbound delivery requests, last successful delivery context per session, and outbound attachment state so ACP servers can route replies back to Discord or other gateways without coupling delivery logic to a specific transport.

## Public surface

The package exports one module entrypoint, `.` from `src/index.ts`; it does not define HTTP routes or CLI commands. Store construction is exposed through `openInterfaceStore(options)`, which returns an `InterfaceStore` with the raw `sqlite` adapter, `bindings`, `deliveries`, `lastDeliveryContext`, `deliveryTargets`, `messageSources`, `outboundAttachments`, `runInTransaction`, and `close`.

Concrete exported classes are `DeliveryTargetResolver`, `BindingRepo`, `DeliveryRequestRepo`, `LastDeliveryContextRepo`, `MessageSourceRepo`, and `OutboundAttachmentRepo`. Exported record and input types include `InterfaceBinding`, `InterfaceMessageSource`, `DeliveryRequest`, `OutboundAttachment`, `CreateOutboundAttachmentInput`, `EnqueueDeliveryRequestInput`, `DeliveryFailureInput`, `ListFailedDeliveryRequestsInput`, `RequeueDeliveryRequestResult`, `LastDeliveryRecord`, `FailedDeliveryRecord`, and `ResolveDeliveryTargetResult`.

`DeliveryTargetResolver.resolve` accepts `acp-core` delivery targets and resolves binding targets, last-delivery targets, and explicit gateway/conversation/thread destinations. `BindingRepo` creates, upserts, lists, resolves, and loads bindings. `DeliveryRequestRepo` enqueues, lists queued requests, leases the next request, acks or fails delivery, lists failures, gets by id, and requeues failed requests. `LastDeliveryContextRepo` records and reads last acked destinations. `MessageSourceRepo` records inbound message sources idempotently by `(gatewayId, messageRef)`. `OutboundAttachmentRepo` creates, lists, consumes, and fails outbound attachments.

## Internal structure

`src/open-store.ts` opens SQLite, initializes the schema, applies ad hoc compatibility migrations for `linked_failure_id`, actor columns, and `body_attachments_json`, enables WAL/foreign keys/busy timeout, creates repo instances, wires the `DeliveryTargetResolver`, and exposes the `InterfaceStore` transaction and close methods.

`src/sqlite.ts` is the SQLite compatibility adapter. It loads `bun:sqlite` when running under Bun and falls back to `better-sqlite3`, then normalizes statements, transactions, `exec`, `pragma`, and close behavior behind local `SqliteDatabase` interfaces.

`src/types.ts` defines all public store records, status unions, inputs, and resolver result shapes. `src/index.ts` re-exports the package surface.

`src/delivery-target-resolver.ts` contains target resolution. It validates explicit targets, looks up active binding destinations through `BindingRepo`, and reads last successful delivery context through `LastDeliveryContextRepo`.

`src/repos/binding-repo.ts` maps `interface_bindings` rows, preserves lookup uniqueness by gateway/conversation/thread, supports fallback from thread-specific lookups to conversation-level bindings, and filters list results.

`src/repos/delivery-request-repo.ts` maps `delivery_requests` rows, serializes `bodyAttachments` as JSON, leases queued rows, transitions queued or delivering rows to delivered/failed, marks consumed outbound attachments delivered on ack, and creates linked queued retries from failed rows.

`src/repos/last-delivery-context-repo.ts` normalizes `SessionRef` values from `agent-scope`, upserts the latest acked delivery per scope/lane, and currently no-ops failed delivery records. `src/repos/message-source-repo.ts` handles inbound idempotency records. `src/repos/outbound-attachment-repo.ts` manages the camelCase `outbound_attachments` table. `src/repos/shared.ts` holds the shared SQLite context and null-to-undefined helper.

## Dependencies

Production dependency declared in `package.json`: `better-sqlite3`. The source also imports `acp-core` types in `src/types.ts`, `src/delivery-target-resolver.ts`, and `src/repos/delivery-request-repo.ts`, and imports `agent-scope` in `src/repos/last-delivery-context-repo.ts`; neither workspace package is declared in `dependencies` or `devDependencies`.

Test and build dependencies declared in `package.json`: `@types/better-sqlite3`, `@types/bun`, and `typescript`. Tests use Bun's built-in `bun:test` runner and local temporary on-disk SQLite databases through `test/helpers.ts`.

## Test coverage

The package has 18 passing tests across 7 test suites, verified with `bun run --filter acp-interface-store test`. Coverage includes binding lookup fallback and filtering, delivery enqueue ordering/leasing/ack/fail, failed delivery requeue, delivery target resolution for binding/last/explicit targets, last delivery context canonicalization and timestamp precedence, message-source idempotency, outbound attachment schema creation, and outbound attachment creation/listing.

Current gaps: tests do not exercise `InterfaceStore.runInTransaction`, on-disk reopen/upgrade behavior from older schemas, attachment state transitions for `markConsumedForRun`, `markPendingFailedForRun`, or delivery ack from consumed to delivered, `DeliveryRequestRepo.listFailed`, malformed `body_attachments_json`, invalid schema status values, or concurrent leasing across multiple SQLite connections.

## Recommended Refactors and Reductions

1. Declare the direct workspace dependencies in `packages/acp-interface-store/package.json`. `src/types.ts`, `src/delivery-target-resolver.ts`, and `src/repos/delivery-request-repo.ts` import from `acp-core`, while `src/repos/last-delivery-context-repo.ts` imports from `agent-scope`; the package boundary currently depends on workspace hoisting rather than its own manifest.

2. Remove or wire the unused actor plumbing in `src/open-store.ts`. `OpenInterfaceStoreOptions.actor` is accepted but never read, and the compatibility migration adds actor columns to `interface_bindings`, `interface_message_sources`, and `last_delivery_context` even though `BindingRepo`, `MessageSourceRepo`, and `LastDeliveryContextRepo` do not insert, select, map, or expose those fields. `DeliveryRequestRepo` does use delivery actor fields, so the reduction should be table-specific rather than deleting all actor storage.

3. Remove or implement `LastDeliveryContextRepo.recordFailedDelivery`. The method in `src/repos/last-delivery-context-repo.ts` discards both arguments, `FailedDeliveryRecord` is exported from `src/types.ts`, and `test/last-delivery-context-store.test.ts` asserts that failures are ignored. If failures are intentionally irrelevant to last-context resolution, deleting the method and type would make that boundary explicit.

4. Narrow the public exports in `src/index.ts` to the store factory, store type, and data types that outside packages use. Repository classes such as `BindingRepo`, `DeliveryRequestRepo`, `LastDeliveryContextRepo`, `MessageSourceRepo`, and `OutboundAttachmentRepo` are implementation details of `openInterfaceStore`; current outside-package imports only use `openInterfaceStore`, `InterfaceStore`, `InterfaceBinding`, and `OutboundAttachment`. Removing unused repo class exports would reduce the supported API surface.

5. Extract repeated delivery request SQL in `src/repos/delivery-request-repo.ts`. The long `SELECT delivery_request_id, linked_failure_id, actor_kind, ...` projection is duplicated in `listQueuedForGateway`, `get`, and `listFailed`, and the same ordering appears in queue list and lease paths. A shared projection constant plus a small loader helper would reduce this 433-line repo without changing behavior.

6. Remove obsolete "future surface" casts from tests now that the methods exist. `test/delivery-requeue.test.ts`, `test/delivery-target-resolver.test.ts`, and `test/last-delivery-context-store.test.ts` define `FutureInterfaceStore`/`Future*` types and optional-call through methods that are now present on `InterfaceStore`; calling the exported typed surface directly would make tests catch accidental API removals.
