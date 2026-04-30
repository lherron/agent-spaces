# hrc-cli Refactor Notes

## Purpose

`hrc-cli` is the operator-facing command line interface for the HRC local runtime control plane. It is a Bun executable named `hrc` that wraps `hrc-sdk`, `hrc-core`, `hrc-server`, `hrc-store-sqlite`, and agent-space placement/config helpers to start and stop the daemon, resolve sessions, manage live runtimes, attach to tmux/headless harnesses, inspect monitor state, and bridge text or surface bindings into running sessions.

## Public Surface

The package exposes one binary, `hrc`, from `packages/hrc-cli/src/cli.ts`. Its user-facing command tree includes `info`, `server start|serve|stop|restart|status|tmux status|tmux kill`, `monitor show|watch|wait`, `session resolve|list|get|clear-context|drop-continuation`, `runtime ensure|list|inspect|sweep|capture|interrupt|terminate|adopt`, `launch list`, top-level `start`, `run`, `attach`, `capture`, `turn send`, `inflight send`, `surface bind|unbind|list`, and `bridge target|deliver-text|register|deliver|list|close`. There are no HTTP routes in this package; it reaches the daemon through `HrcClient` over the discovered Unix socket and reads monitor state directly from the HRC SQLite store in the monitor commands.

The TypeScript exports currently used by tests or sibling modules are `main`, `harnessStringToHarnessId`, `resolveAgentHarness`, `selectLatestUsableRuntime`, and `attachOpenAiRuntime` from `src/cli.ts`; server lifecycle helpers such as `collectServerRuntimeStatus`, `daemonizeAndWait`, `stopServerProcess`, `collectTmuxStatus`, `detectLaunchdOwner`, and `launchctlKickstart` from `src/cli-runtime.ts`; monitor entry points and renderer helpers from `src/monitor-show.ts`, `src/monitor-watch.ts`, `src/monitor-wait.ts`, and `src/monitor-render.ts`; `printJson` from `src/print.ts`; and the small `fatal`/`hasFlag` helpers from `src/runtime-args.ts`.

## Internal Structure

- `src/cli.ts` is the main binary and largest file. It loads `.env.local`, defines legacy argv helpers for Commander migration, resolves managed agent scopes, builds runtime intents, implements most command handlers, builds the Commander command tree, normalizes errors, and exports the testable `main()` entry point.
- `src/cli-runtime.ts` contains daemon and tmux lifecycle support: path resolution, PID/socket probes, launchd ownership detection, daemonization, shutdown, status formatting, and tmux status collection.
- `src/monitor-show.ts` implements point-in-time monitor snapshots. It calls daemon status APIs, lists runtimes/messages, reads lifecycle events from SQLite, builds an `HrcMonitorState`, and renders human or JSON output.
- `src/monitor-watch.ts` implements finite replay, follow polling, condition-based watch mode, argv parsing for watch-specific flags, live monitor state loading, and event writer selection.
- `src/monitor-wait.ts` implements monitor condition waiting, fixture-state injection for tests, polling database reads, final event normalization, and JSON/text final-event output.
- `src/monitor-render.ts` owns monitor output formats. It provides JSON/compact/verbose/tree renderers, converts raw monitor records into lifecycle-shaped events, pairs tool calls with results, and formats tool/message bodies.
- `src/print.ts` is a shared pretty JSON helper. `src/runtime-args.ts` is a small helper module used by `cli-runtime.ts`.
- `CHANGELOG.md` records the Commander migration. `MONITOR_REMOVAL_AUDIT.md` records the legacy status/events removal blast-radius audit. `global-lock.json` is an ASP lock artifact and does not participate in runtime behavior.

## Dependencies

Production dependencies are `agent-scope`, `chalk`, `cli-kit`, `commander`, `hrc-core`, `hrc-events`, `hrc-sdk`, `hrc-server`, `hrc-store-sqlite`, `spaces-config`, and `spaces-execution`. The CLI uses Bun runtime APIs directly for spawning, subprocess output capture, sleeping, and file reads in several paths. Test/dev dependencies are `@types/bun` and `typescript`; tests also exercise real workspace packages such as `hrc-server` and `hrc-store-sqlite`.

## Test Coverage

The package has 7 test files with 143 `it`/`test` cases: broad CLI behavior in `src/__tests__/cli.test.ts`, monitor watch acceptance and renderer behavior in `monitor-watch.test.ts`, monitor wait acceptance in `monitor-wait.acceptance.test.ts`, monitor show acceptance in `monitor-show.test.ts`, server launchd integration in `launchd.test.ts`, harness intent resolution in `cli-intent.test.ts`, and a smaller smoke fixture suite in `smoke.test.ts`. Coverage is strong for help output, error routing, JSON shape, server status diagnostics, runtime/session operations, monitor replay/follow/wait semantics, and dry-run/start/run/attach paths. The remaining gaps are mostly integration-style: several daemon lifecycle tests are gated behind `HRC_RUN_DAEMON_LIFECYCLE_TESTS`, launchd behavior is platform-conditional, and the bridge/surface/runtime command registrations are more thoroughly smoke-tested than end-to-end exercised across every error path.

## Recommended Refactors and Reductions

1. Split `src/cli.ts` by command group. The file is 3,053 lines and mixes `.env.local` loading, Commander declarations, legacy argv reconstruction, managed-scope intent building, daemon/session/runtime/bridge handlers, and error normalization. The obvious extraction points are the handler groups starting around `cmdServerStart`, `cmdRuntimeList`, `cmdRun`, `cmdAttach`, and the Commander tree in `buildProgram`; moving those into `commands/server.ts`, `commands/runtime.ts`, `commands/managed.ts`, and `program.ts` would reduce merge conflicts without changing behavior.

2. Retire or isolate the Commander-to-legacy argv bridge once command handlers accept typed options. `toLegacyArgv` and `toLegacyArgvForScopeCommand` in `src/cli.ts` still reconstruct string arrays after Commander has parsed options, including raw argv scans for negated flags. That makes registrations such as `runtime terminate`, top-level `start`, and top-level `run` carry migration-specific glue in every action. Typed handler inputs would remove this transitional layer and shrink the command declarations.

3. Consolidate monitor state loading. `src/monitor-show.ts` has `buildMonitorState`, `readMessages`, and `readEvents`; `src/monitor-watch.ts` has `buildLiveMonitorState` and `loadMessages`; `src/monitor-wait.ts` has `readLiveMonitorState`, message response synthesis, and runtime/session normalization. These functions all assemble `HrcMonitorState` from the daemon, SDK, and SQLite in slightly different shapes. A shared `monitor-state.ts` module would remove duplicated database reads and reduce the risk that `monitor show`, `monitor watch`, and `monitor wait` disagree on event/session normalization.

4. Centralize monitor condition validation. `VALID_CONDITIONS`, `MSG_REQUIRED_CONDITIONS`, `POLL_MS`, selector parsing, and response/response-or-idle selector rules are duplicated in `src/monitor-watch.ts` and `src/monitor-wait.ts`. Moving those constants and validation helpers beside the condition engine would make future condition additions a single-file change.

5. Reduce duplicated test harness helpers. `src/__tests__/cli.test.ts`, `smoke.test.ts`, `monitor-show.test.ts`, and `monitor-wait.acceptance.test.ts` each define their own `CliExit`, stdout/stderr capture, env restoration, and `runCli` helpers. A local `src/__tests__/helpers/run-cli.ts` could preserve the same behavior while cutting repeated code and making future process-exit/error-output expectations easier to update consistently.
