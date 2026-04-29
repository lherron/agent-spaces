# acp-cli Refactor Notes

## Purpose

`acp-cli` is the user-facing ACP operator command line interface. It exposes task workflow, governance, runtime/session, coordination, scheduled job, delivery, thread, attachment, heartbeat, and local ACP server lifecycle operations as thin commands over `acp-server`, while keeping output formatting and CLI-specific validation local to the package.

## Public surface

The package binary is `acp`, pointing at `src/cli.ts`. The package export in `src/index.ts` exposes `main`, `normalizeScopeInput`, `DEFAULT_ACP_SERVER_URL`, `AcpClientHttpError`, `AcpClientTransportError`, `createHttpClient`, and HTTP client response/client types including `AcpClient`, `FetchLike`, `GetTaskResponse`, `TaskPromoteResponse`, `TaskTransitionResponse`, `ListTaskTransitionsResponse`, and `TaskContext`.

The Commander tree in `src/cli.ts` registers these command groups:

- `acp task create|show|promote|evidence add|transition|transitions`
- `acp admin interface binding list|set|disable`
- `acp agent create|list|show|patch`
- `acp project create|list|show|default-agent`
- `acp membership add|list`
- `acp interface identity register`
- `acp system-event push|list`
- `acp runtime resolve`
- `acp session resolve|list|show|runs|reset|interrupt|capture|attach-command`
- `acp run show|cancel|attachment add|attachment list|attachment clear`
- `acp send`
- `acp tail`
- `acp render`
- `acp message send|broadcast`
- `acp job validate|create|list|show|patch|run`
- `acp job-run list|show|wait`
- `acp heartbeat set|wake`
- `acp delivery retry|list-failed`
- `acp thread list|show|turns`
- `acp server start|serve|stop|restart|status|health`

The typed `AcpClient` in `src/http-client.ts` covers task workflow routes, interface bindings, governance agents/projects/memberships, interface identities, system events, and heartbeat routes. Runtime, session, run, send, render, tail, message, job, delivery, and thread commands use the raw requester helpers from `src/commands/shared.ts` or direct `fetch` calls.

## Internal structure

- `src/cli.ts` builds the Commander command tree, translates Commander options back into the legacy handler `args` shape, dispatches handlers, and owns top-level error conversion through `exitWithError`.
- `src/cli-runtime.ts` defines command output shapes, usage/server error classes, stdout/stderr writers, and user-facing error rendering for transport and HTTP failures.
- `src/http-client.ts` is the typed JSON client for the older task/governance/admin surface and defines the shared HTTP error classes.
- `src/commands/options.ts` is the legacy parser still used by handler modules after Commander normalizes the outer command tree.
- `src/commands/shared.ts` resolves environment/defaults, creates typed or raw ACP clients, applies actor headers, and renders JSON/table output decisions.
- `src/commands/session-shared.ts` and `src/scope-input.ts` normalize scope/session handles and resolve semantic session refs to concrete session ids.
- `src/commands/task-*.ts`, `agent.ts`, `project.ts`, `membership.ts`, `interface-identity.ts`, `system-event.ts`, and `admin-interface-binding-*.ts` implement the typed-client-backed workflow and governance commands.
- `src/commands/runtime.ts`, `session.ts`, `run.ts`, `send.ts`, `tail.ts`, `render.ts`, `message.ts`, `job.ts`, `job-run.ts`, `delivery.ts`, `thread.ts`, and `heartbeat.ts` implement newer raw endpoint-backed command surfaces.
- `src/commands/job-file-loader.ts` loads job JSON and inlines step `inputFile` content; `src/commands/poll.ts` contains reusable polling loops for runs and job runs.
- `src/server-runtime.ts` manages local ACP server lifecycle, pid/log paths, launchd integration, daemonization, foreground startup, in-process Discord gateway startup, status, health, and stop/restart behavior.
- `src/output/*.ts`, `src/print.ts`, and `src/roles.ts` contain focused renderers, JSON printing, table formatting, replay reduction, and role normalization.

## Dependencies

Production dependencies are `acp-core` for task/admin domain types, `acp-server` for local server startup, `cli-kit` for Commander repeatable option support, `commander` for command registration and help generation, `gateway-discord` for the `acp server` in-process Discord gateway, and `wrkq-lib` for server startup error handling. Test/development dependencies are `@types/bun`, `coordination-substrate`, and `typescript`; tests also exercise workspace packages such as `acp-server` and `wrkq-lib` through source imports.

## Test coverage

I counted 126 `test(...)` cases across `src/__tests__` and `test`. Coverage includes CLI smoke behavior, task workflow commands, admin interface bindings, runtime/session/run/send/render/tail surfaces, coordination/message/job/delivery/thread surfaces, job file loading, job-run polling and table rendering, duration parsing, scope input normalization, replay reducer streaming, server runtime status/help behavior, and one in-process ACP server integration path for the task commands.

Gaps: `src/server-runtime.ts` has limited coverage relative to its size and platform/process responsibilities; launchd, daemonize, foreground Discord gateway startup, stop/restart signal paths, Consul token fallback, and schema-missing handling are hard to exercise from the current tests. `src/http-client.ts` route methods are mostly tested indirectly through handlers, not through focused client tests for URL encoding, error bodies, and actor header behavior. The Commander-to-legacy bridge in `src/cli.ts` is covered by smoke/help paths, but not exhaustively for every command's repeatable option and positional handling. Several raw command modules use broad `Record<string, unknown>` response shapes, so tests assert paths and selected fields but do not catch response contract drift comprehensively.

## Recommended Refactors and Reductions

1. Remove the accidental duplicate statements in `src/server-runtime.ts`: `execProcess` has two consecutive `return { stdout, stderr, exitCode }` statements, and `stopServerProcess` calls `await unlink(paths.pidPath)` twice in the stale-pid branch. These are dead code/duplicate side effects with no behavioral value.

2. Split `src/server-runtime.ts` by responsibility before it grows further. The file currently mixes argument parsing (`stripLifecycleArgs`, `resolveServerMode`), status probing (`collectAcpServerStatus`, `isTcpResponsive`), launchd control (`detectLaunchdOwner`, `launchctlKickstart`), Discord token/gateway startup (`resolveDiscordToken`, `startGatewayInProcess`), and daemon process management (`daemonizeAndWait`, `stopServerProcess`, `serverForeground`). Separating lifecycle, platform integration, and gateway startup would make the high-risk process code easier to test.

3. Consolidate duplicate HTTP request/error parsing between `src/http-client.ts`, `src/commands/shared.ts`, `src/commands/run.ts`, `src/commands/tail.ts`, and `src/commands/render.ts`. Each currently trims server URLs, parses response text as JSON-or-string, applies actor headers, wraps transport errors, and throws `AcpClientHttpError` in slightly different forms. A single low-level request helper that supports JSON, text, stream, and multipart callers would reduce drift.

4. Remove the legacy handler parser boundary left after the Commander migration. `src/cli.ts` reconstructs synthetic `args` with `legacyArgs`, then each handler reparses them through `src/commands/options.ts`. That keeps two CLI parsing layers alive and makes command behavior depend on both Commander option definitions and handler specs. A gradual refactor can pass a typed options object into handlers for one command group at a time, starting with smaller groups such as `heartbeat`, `thread`, or `admin-interface-binding`.

5. Extract repeated role-map and task evidence construction helpers. `src/commands/task-create.ts` and `src/commands/task-promote.ts` each define a local `parseRoleMap` with duplicate duplicate-role and implementer-required logic, while `src/commands/task-evidence-add.ts` and `src/commands/task-transition.ts` separately construct `EvidenceItem` shapes for produced evidence and waiver evidence. Moving those to a small task workflow helper would reduce command-local policy duplication.

6. Unify table/render ownership for raw command modules. `src/commands/job-run.ts`, `src/commands/session.ts`, `src/commands/run.ts`, `src/commands/message.ts`, `src/commands/delivery.ts`, and `src/commands/thread.ts` define local table renderers and response `Record<string, unknown>` projections inline. Moving stable renderers to `src/output/` would make handlers smaller and align newer raw commands with the existing `task-render`, `transitions-render`, `interface-binding-render`, and `replay-reducer` modules.
