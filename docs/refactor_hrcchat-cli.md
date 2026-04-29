# hrcchat-cli Refactor Notes

## Purpose

`packages/hrcchat-cli` provides the `hrcchat` command-line interface for semantic directed messaging in the HRC runtime. It resolves human, system, and agent target addresses; sends durable DMs; materializes target sessions; delivers literal input to live runtimes; queries durable message history; captures live runtime output; and prints runtime/target diagnostics through the `hrc-sdk` client.

## Public Surface

The package is private and exposes a single bin entry in `package.json`: `hrcchat` -> `./src/main.ts`. The Commander command tree in `src/main.ts` registers these CLI commands:

- `hrcchat info`
- `hrcchat who [--discover] [--all-projects]`
- `hrcchat summon <target>`
- `hrcchat dm <target> [message] [--respond-to <kind>] [--reply-to <id>] [--mode <mode>] [--file <path>]`
- `hrcchat send <target> [message] [--enter|--no-enter] [--file <path>]`
- `hrcchat show <seq-or-id>`
- `hrcchat messages [target] [--to <address>] [--responses-to <address>] [--from <address>] [--thread <id>] [--after <seq>] [--limit <n>]`
- `hrcchat peek <target> [--lines <n>]`
- `hrcchat doctor [target]`

Global options are `--json` from `cli-kit` and `--project <id>` from `src/main.ts`. There are no HTTP routes in this package; HTTP access is delegated to `HrcClient`.

Although no library entry point is declared, command modules export handler functions and option types for internal tests and reuse: `cmdDm`, `cmdDoctor`, `cmdInfo`, `cmdMessages`, `cmdPeek`, `cmdSend`, `cmdShow`, `cmdSummon`, `cmdWho`, plus their option types. Shared exported helpers are `resolveTargetToSessionRef`, `resolveAddress`, `resolveCallerAddress`, `resolveProjectId`, `formatAddress`, `printJson`, `printJsonLine`, and `resolveRuntimeIntentForTarget`. `src/commands/dm.ts` also exports the `DmHandoffEnvelope` type.

## Internal Structure

- `src/main.ts` loads `.env.local`, creates an `HrcClient` with `discoverSocket()`, configures Commander, wires global options into command handlers, and maps Commander, CLI usage, HRC domain, and unknown errors to process exits.
- `src/commands/dm.ts` consumes the message body, resolves `from`, `to`, `respondTo`, optional runtime intent, calls `client.semanticDm()`, and prints either a human reply or a compact JSON monitor handoff envelope.
- `src/commands/summon.ts` resolves the target session and runtime intent, calls `client.ensureTarget()`, and renders target state/capabilities.
- `src/commands/send.ts` sends literal text to a resolved session through `client.deliverLiteralBySelector()`.
- `src/commands/messages.ts` builds `HrcMessageFilter` values for message history queries, tails newest messages by requesting descending order, reverses them for display, and renders one-line previews.
- `src/commands/show.ts` fetches one message by sequence or scans a bounded result set for a message ID, then renders the full body.
- `src/commands/peek.ts` captures recent live output with `client.captureBySelector()`.
- `src/commands/who.ts` lists visible or discoverable targets, optionally scoped by project.
- `src/commands/doctor.ts` checks daemon health, API status, tmux capability, optional target lookup, target DM readiness, and runtime binding.
- `src/commands/info.ts` stores the static help/about text.
- `src/normalize.ts` converts handles and entity names into `HrcMessageAddress` values, infers project context for bare agent targets, resolves caller identity from `HRC_SESSION_REF`, and formats session refs back into handles.
- `src/resolve-intent.ts` builds `HrcRuntimeIntent` values from agent placement paths, project targets, agent profiles, priming prompts, bundle refs, and harness provider resolution.
- `src/print.ts` centralizes JSON output formatting.
- `src/__tests__/normalize.test.ts` covers target/session normalization and caller identity resolution.
- `src/__tests__/smoke.test.ts` covers CLI info behavior, `dm` JSON envelopes, monitor selector compatibility, runtime/turn ID fallbacks, multi-line JSON output, and several usage errors.

## Dependencies

Production dependencies:

- `agent-scope`: handle parsing, scope resolution, and session handle formatting.
- `cli-kit`: JSON option wiring, CLI usage errors, error exits, and body consumption.
- `commander`: command tree and argument/option parsing.
- `hrc-core`: message, filter, runtime intent, selector, and domain error contracts.
- `hrc-sdk`: socket discovery and HRC client methods.
- `spaces-config`: project inference, agent roots, target/profile parsing, placement paths, priming prompt resolution, bundle refs, and harness provider resolution.

Test and build dependencies:

- `bun:test`: unit and smoke test runner.
- `@types/bun`: Bun runtime types.
- `typescript`: package build and typecheck.

## Test Coverage

The package has 2 test files and 20 passing tests:

- `normalize.test.ts`: 7 tests for handle-to-session-ref conversion, non-main lane formatting, `HRC_SESSION_REF` caller identity, legacy lane normalization, and human fallback.
- `smoke.test.ts`: 13 tests for `info`, direct `cmdDm` handling, `dm --json` handoff fields, selector compatibility, runtime/turn ID fallbacks, one-line JSON output for multi-line bodies, removed `--wait`, unknown commands, and missing arguments.

Verified during this sweep with `bun test packages/hrcchat-cli/src/__tests__`: 20 pass, 0 fail.

Coverage gaps:

- No tests for `who`, `summon`, `send`, `messages`, `show`, `peek`, or `doctor` command behavior.
- No tests for `resolveRuntimeIntentForTarget()` success/fallback paths around `ASP_AGENTS_ROOT`, missing agent roots, project targets, malformed profiles, or provider resolution.
- No tests for numeric option validation in `messages --after/--limit` or `peek --lines`.
- No tests proving `--project` affects target resolution outside `who`.

## Recommended Refactors and Reductions

1. Wire or remove the unused `--project` path for most commands. `src/main.ts` defines `--project` globally and passes it to `cmdDm`, but `src/commands/dm.ts` never reads `DmOptions.project`, while `send`, `summon`, `peek`, and `doctor` do not receive the option at all. `src/normalize.ts` resolves project from `ASP_PROJECT`/cwd, not from command options. Either thread explicit project into target/session resolution or limit the global option to `who`.

2. Extract the Commander setup from `src/main.ts`. The file mixes dotenv loading, client construction, command registration, and process-level error handling in 227 lines. A small `createProgram({ createClient })` helper would let tests exercise parser behavior without spawning `bun src/main.ts`, and would keep `import.meta.main` limited to environment loading plus exit mapping.

3. Add shared numeric option parsing for command handlers. `src/commands/messages.ts` uses `Number.parseInt()` for `--after` and `--limit`, and `src/commands/peek.ts` does the same for `--lines`; neither checks `Number.isFinite()` or positive bounds before sending requests to `HrcClient`. A helper in `cli-kit` or this package would remove duplicated parsing and make invalid flags fail as `CliUsageError`.

4. Replace client-side message ID scanning in `src/commands/show.ts`. Non-numeric IDs call `client.listMessages({ afterSeq: 0, limit: 1000 })` and search locally. That hard-coded cap can miss older messages and puts lookup policy in the CLI. Prefer an SDK method or server filter for exact `messageId`, then keep `cmdShow()` as display logic.

5. Narrow the silent fallback in `src/resolve-intent.ts`. `resolveProviderFromAgent()` catches every profile/target parsing error and falls back to the project target harness or Anthropic. That can hide malformed `agent-profile.toml` or priming prompt resolution issues while still auto-summoning. Catch only expected absence/compatibility cases or surface a `CliUsageError` with the profile path.

6. Update stale local documentation. `packages/hrcchat-cli/CHANGELOG.md` says all 12 verbs, including `watch`, `wait`, and `status`, are unchanged, while `src/main.ts` currently registers 9 commands and `src/commands/info.ts` points users to `hrc monitor` for watch/wait. `packages/hrcchat-cli/HRCCHAT_STATUS.md` also describes the removed `src/cli-args.ts` and only 7 command modules. Keeping those files aligned with the Commander migration would reduce confusion during future CLI work.
