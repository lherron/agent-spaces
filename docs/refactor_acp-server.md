# Refactor notes: acp-server

## Purpose

`acp-server` is the Bun HTTP server for the ACP control plane. It exposes routes for tasks, task transitions, inputs, coordination messages, interface delivery, admin state, jobs, sessions, runtime resolution, and the ops session dashboard, while adapting those HTTP operations onto `wrkq-lib`, `coordination-substrate`, ACP state/interface/admin/job stores, and HRC launch/session APIs.

## Public surface

The package entrypoint is `src/index.ts`. It exports `createAcpServer`, the `AcpServer` type, CLI helpers (`parseCliArgs`, `resolveCliOptions`, `formatStartupLine`, `renderAcpServerHelp`, `startAcpServeBin`), dependency types from `src/deps.ts`, in-memory stores from `src/domain/input-attempt-store.ts` and `src/domain/run-store.ts`, launch helpers from `src/launch-role-scoped.ts`, and `exactRouteKey`.

The CLI binary is `acp-server` (`src/cli.ts`). It accepts `--wrkq-db-path`, `--coord-db-path`, `--interface-db-path`, `--state-db-path`, `--admin-db-path`, `--jobs-db-path`, `--conversation-db-path`, `--host`, `--port`, `--actor`, and `--help`. Environment variables include `ACP_WRKQ_DB_PATH`, `WRKQ_DB_PATH`, `ACP_COORD_DB_PATH`, `ACP_INTERFACE_DB_PATH`, `ACP_STATE_DB_PATH`, `ACP_ADMIN_DB_PATH`, `ACP_JOBS_DB_PATH`, `ACP_CONVERSATION_DB_PATH`, `ACP_SCHEDULER_ENABLED`, `ACP_HOST`, `ACP_PORT`, `ACP_ACTOR`, `ACP_REAL_HRC_LAUNCHER`, `ACP_DEV_ECHO_LAUNCHER`, and `ACP_DEV_FLOW_LAUNCHER`.

HTTP exact routes from `src/routing/exact-routes.ts`:

- `POST /v1/interface/bindings`
- `GET /v1/interface/bindings`
- `POST /v1/interface/messages`
- `POST /v1/tasks`
- `POST /v1/inputs`
- `POST /v1/messages` (deprecated; returns `route_moved`)
- `POST /v1/admin/agents`
- `GET /v1/admin/agents`
- `POST /v1/admin/projects`
- `GET /v1/admin/projects`
- `POST /v1/admin/memberships`
- `GET /v1/admin/memberships`
- `POST /v1/admin/interface-identities`
- `GET /v1/admin/interface-identities`
- `POST /v1/admin/system-events`
- `GET /v1/admin/system-events`
- `POST /v1/admin/jobs`
- `POST /v1/admin/jobs/validate`
- `GET /v1/admin/jobs`
- `GET /v1/conversation/threads`
- `POST /v1/coordination/messages`
- `GET /v1/gateway/deliveries`
- `GET /v1/ops/session-dashboard/snapshot`
- `GET /v1/ops/session-dashboard/events`
- `POST /v1/runtime/resolve`
- `POST /v1/sessions/launch`
- `POST /v1/sessions/resolve`
- `GET /v1/sessions`
- `POST /v1/sessions/reset`

Parameterized routes from `src/routing/param-routes.ts`:

- `GET /v1/gateway/:gatewayId/deliveries/stream`
- `POST /v1/gateway/deliveries/:deliveryRequestId/ack`
- `POST /v1/gateway/deliveries/:deliveryRequestId/fail`
- `POST /v1/gateway/deliveries/:deliveryRequestId/requeue`
- `GET /v1/admin/agents/:agentId`
- `PATCH /v1/admin/agents/:agentId`
- `PUT /v1/admin/agents/:agentId/heartbeat`
- `POST /v1/admin/agents/:agentId/heartbeat/wake`
- `GET /v1/admin/projects/:projectId`
- `POST /v1/admin/projects/:projectId/default-agent`
- `GET /v1/admin/projects/:projectId/memberships`
- `GET /v1/admin/jobs/:jobId`
- `PATCH /v1/admin/jobs/:jobId`
- `POST /v1/admin/jobs/:jobId/run`
- `GET /v1/jobs/:jobId/runs`
- `GET /v1/job-runs/:jobRunId`
- `GET /v1/conversation/threads/:threadId`
- `GET /v1/conversation/threads/:threadId/turns`
- `GET /v1/tasks/:taskId`
- `POST /v1/tasks/:taskId/evidence`
- `POST /v1/tasks/:taskId/promote`
- `POST /v1/tasks/:taskId/transitions`
- `GET /v1/tasks/:taskId/transitions`
- `GET /v1/runs/:runId`
- `GET /v1/runs/:runId/outbound-attachments`
- `POST /v1/runs/:runId/outbound-attachments`
- `POST /v1/runs/:runId/cancel`
- `GET /v1/sessions/:sessionId`
- `GET /v1/sessions/:sessionId/runs`
- `POST /v1/sessions/:sessionId/interrupt`
- `GET /v1/sessions/:sessionId/capture`
- `GET /v1/sessions/:sessionId/attach-command`
- `GET /v1/sessions/:sessionId/events`

## Internal structure

- `src/create-acp-server.ts` builds the request handler, resolves dependency defaults, matches exact and parameterized routes, and normalizes thrown errors through `src/http.ts`.
- `src/deps.ts` defines the dependency injection contract and default in-memory or SQLite-backed stores.
- `src/http.ts`, `src/parsers/*`, and `src/handlers/shared.ts` provide response helpers, request parsing, actor extraction, and common task/session parsing.
- `src/routing/*` owns route registration, parameter matching, and mutating-route actor/authz wrapping.
- `src/handlers/*` contains route handlers for admin resources, jobs, tasks, runs, sessions, interface messages/bindings, gateway deliveries, coordination messages, ops dashboard endpoints, and conversation routes.
- `src/domain/*` contains in-memory input-attempt and run stores used when no persistent ACP state store is injected.
- `src/jobs/*` implements job run dispatch, flow advancement, exec-step policy/execution, result block parsing, and final assistant-output extraction.
- `src/integration/*` handles transition outbox reconciliation, tester handoff command construction, and wake dispatching from coordination wake records.
- `src/delivery/*` turns completed assistant events into visible delivery requests and captures interface responses.
- `src/attachments.ts` resolves URL/file attachments into local media state and utility helpers for filenames/content types.
- `src/real-launcher.ts`, `src/dev-flow-launcher.ts`, `src/echo-launcher.ts`, and `src/launch-role-scoped.ts` adapt ACP runs to HRC, test/dev launchers, and task-context-aware launch intent construction.
- `test/fixtures/wired-server.ts` wires in-memory stores for most HTTP tests.

## Dependencies

Production dependencies are workspace packages: `acp-admin-store`, `acp-conversation`, `acp-core`, `acp-ops-projection`, `acp-interface-store`, `acp-jobs-store`, `acp-state-store`, `agent-scope`, `coordination-substrate`, `hrc-core`, `hrc-sdk`, `spaces-config`, `spaces-runtime`, and `wrkq-lib`.

Test/build dependencies are `@types/bun` and `typescript`; tests run with Bun's built-in `bun test` runner and the same workspace packages used by production code.

## Test coverage

There are 65 `*.test.ts` files and 71 `describe` blocks across `test/` and `src/domain/__tests__/`. Coverage is broad: CLI option parsing and startup, route scaffolds, task lifecycle, task promotion/transition/evidence, input idempotency and dispatch, actor stamping, authorization hooks, admin agents/projects/memberships/interface identities/system events/jobs, scheduler wiring, job flow execution and result-block handling, gateway delivery controls, interface bindings/messages/response capture, outbound attachments, conversations, sessions, runtime resolution, real launcher behavior, wake dispatching, transition outbox, and ops dashboard snapshot/events.

Notable gaps are production-level integration coverage with a live HRC socket, live filesystem/media state cleanup around attachment downloads, and authorization coverage for mutating task/run routes that are not listed in `src/routing/mutating-routes.ts`.

## Recommended refactors and reductions

1. Remove or reuse the dead pending handler in `src/handlers/pending-p1-impl.ts`. `handlePendingP1Impl` is exported but not imported anywhere; the three live pending responses are inlined in `src/handlers/conversation-threads.ts` and `src/handlers/conversation-turns.ts`. Either delete the unused file or route all pending conversation responses through that helper.

2. Extract an input-dispatch service from `src/handlers/inputs.ts`. Both `dispatchJobRunThroughInputs` in `src/handlers/admin-jobs.ts` and `dispatchStepThroughInputs` in `src/jobs/dispatch-step.ts` construct synthetic `Request` objects and call the HTTP handler directly. A shared function that accepts parsed session/content/metadata would reduce handler coupling and duplicate response parsing.

3. Split `src/real-launcher.ts` by responsibility. At 826 lines it combines intent normalization, HRC client dispatch, tmux delivery, polling, SQLite event readers, raw event translation, and run-store mutation. The exported helpers `listRawRunEvents`, `readLatestAssistantMessageSeq`, and `readAssistantMessageAfterSeq` can move to an HRC event-reader module, leaving `createRealLauncher` focused on launch orchestration.

4. Consolidate job-store guard and flow dispatch boundaries. `requireJobsStore` exists separately in `src/handlers/admin-jobs.ts` and `src/jobs/flow-engine.ts`, while legacy job dispatch lives in the admin route handler and flow step dispatch lives in `src/jobs/dispatch-step.ts`. Moving store guards and both dispatch helpers under `src/jobs/` would make `src/handlers/admin-jobs.ts` thinner and reduce the route layer's ownership of job execution internals.
