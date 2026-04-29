# cli-kit Refactor Notes

## Purpose

`cli-kit` is the shared Commander helper and CLI validation package for the monorepo. It centralizes small cross-CLI behaviors such as common options, usage errors, repeatable flag collection, typed parser helpers, stdin/file body consumption, dependency injection for Commander actions, and consistent stderr/exit handling so command packages do not each carry their own ad hoc implementations.

## Public Surface

The package exports a single module from `packages/cli-kit/src/index.ts` via `package.json` export `"."`, with Bun resolving directly to source and other importers resolving to built `dist`.

- `BuildDeps<D>`: factory type used by `withDeps`.
- `CliUsageError`: usage-error class intended to map to exit code 2 through `exitWithError`.
- `attachJsonOption(cmd)`: adds a global `--json` Commander option.
- `attachServerOption(cmd, defaultUrl?)`: adds `--server <url>`, optionally with a default.
- `attachActorOption(cmd)`: adds `--actor <agentId>`.
- `repeatable(parse?)`: Commander option accumulator for repeated flags.
- `withDeps(handler, buildDeps)`: Commander action wrapper that extracts positionals and `command.opts()`, then injects dependency state.
- `parseDuration(input)`: parses integer durations with required `ms`, `s`, `m`, or `h` suffixes into milliseconds.
- `parseJsonObject(flag, raw)`: parses a JSON object and rejects invalid JSON, arrays, null, and primitives.
- `parseCommaList(raw, flag)`: parses a non-empty comma-separated string list.
- `parseIntegerValue(flag, raw, { min })`: parses an integer-like value and enforces a lower bound.
- `consumeBody({ positional, file })`: reads body text from `--file`, `-` stdin, or an inline positional value.
- `exitWithError(err, { json, binName })`: writes a text or JSON error envelope to stderr and exits 2 for `CliUsageError`, 1 otherwise.

There are no HTTP routes and no CLI commands in this package; it is a library consumed by `acp-cli`, `hrc-cli`, `hrcchat-cli`, and `cli`.

## Internal Structure

- `packages/cli-kit/src/index.ts`: all runtime code and exported symbols. The file is intentionally small, but mixes Commander helpers, parser utilities, body I/O, and process-exiting error handling.
- `packages/cli-kit/src/index.test.ts`: Bun tests for the exported helpers. It includes Commander option smoke tests, parser tests, body file consumption, `process.exit`/stderr capture for `exitWithError`, and a Commander `exitOverride` smoke case.
- `packages/cli-kit/package.json`: package metadata, exports, build/typecheck/test scripts, and dependencies.
- `packages/cli-kit/tsconfig.json`: composite TypeScript config that builds `src` into `dist` and excludes tests from emitted output.
- `packages/cli-kit/CHANGELOG.md`: initial-release notes describing extraction of shared CLI helpers during the Commander CLI upgrade.

Generated `dist`, `tsconfig.tsbuildinfo`, and local `node_modules` are build/install artifacts rather than source structure.

## Dependencies

Production dependency:

- `commander`: used for `Command` option helpers and the `withDeps` action wrapper.

Development dependencies:

- `@types/bun`: Bun test/runtime types.
- `typescript`: package build and typecheck.

Runtime Node/Bun built-ins used directly:

- `node:fs` for `readFileSync` in `consumeBody`.
- `process.stderr` and `process.exit` in `exitWithError`.

Workspace consumers observed:

- `packages/acp-cli/src/cli.ts` imports `repeatable`, but still uses local runtime/parser helpers elsewhere.
- `packages/hrc-cli/src/cli.ts`, `monitor-wait.ts`, `monitor-watch.ts`, and `monitor-show.ts` import `CliUsageError`, `exitWithError`, `parseIntegerValue`, and `parseDuration`.
- `packages/hrcchat-cli/src/main.ts` imports `CliUsageError`, `attachJsonOption`, and `exitWithError`; `commands/dm.ts` and `commands/send.ts` import `consumeBody`.
- `packages/cli/src/index.ts` and `packages/cli/src/helpers.ts` import `CliUsageError` and `exitWithError`.

## Test Coverage

`packages/cli-kit/src/index.test.ts` contains 15 Bun tests. Coverage includes the three Commander option helpers, `repeatable`, `withDeps`, successful and failing parser paths for duration/JSON/list/integer values, file and positional body reads, text and JSON `exitWithError` envelopes, and a Commander unknown-option smoke test.

Gaps:

- `consumeBody` does not test the `positional === '-'` stdin path.
- `parseIntegerValue` does not test malformed numeric strings such as `1abc`, decimals, whitespace, or negative values.
- `parseDuration` only tests one invalid string and does not cover zero values, large values, or unsupported-but-close suffixes.
- `withDeps` does not test Commander actions with no trailing command object, even though the implementation accepts that shape.

## Recommended Refactors and Reductions

1. Remove or adopt unused option/action helpers. `attachServerOption`, `attachActorOption`, and `withDeps` are exported from `packages/cli-kit/src/index.ts`, but the monorepo usage scan found them only in `packages/cli-kit/src/index.test.ts` and `packages/cli-kit/CHANGELOG.md`. Either migrate a concrete CLI to use them or drop them from the public surface to avoid carrying unclaimed abstractions.

2. Consolidate duplicated parsers in `acp-cli`. `packages/acp-cli/src/commands/options.ts` defines `parseIntegerValue`, `parseJsonObject`, and `parseCommaList` with the same behavior as `packages/cli-kit/src/index.ts`. Moving those command modules to the `cli-kit` helpers would reduce duplicate validation logic and make parser behavior easier to audit.

3. Decide whether `acp-cli` should keep a bespoke error runtime. `packages/acp-cli/src/cli-runtime.ts` defines its own `CliUsageError` and `exitWithError`, while `packages/cli-kit/src/index.ts` provides package-level versions already used by `hrc-cli`, `hrcchat-cli`, and `cli`. If `acp-cli` needs the HTTP-specific branches in `cli-runtime.ts`, keep those but consider importing `CliUsageError` from `cli-kit` so usage-error identity is consistent across CLI packages.

4. Tighten integer parsing. `packages/cli-kit/src/index.ts` uses `Number.parseInt(raw, 10)` in `parseIntegerValue`, which accepts prefix integers such as `1abc`; the duration parser in the same file uses a full-string regex. Replace this with a full integer match before parsing so CLI validation rejects malformed values consistently.
