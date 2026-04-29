# Refactor Sweep: cli

## Purpose

`packages/cli` is the Bun/Commander command-line package that ships the `asp` binary for Agent Spaces. It translates user-facing commands into `spaces-config`, `spaces-execution`, `agent-spaces`, `agent-scope`, and `spaces-runtime` operations: project target setup, install/build/run workflows, registry and space management, placement-driven agent execution, context reminder resolution, and live-agent self-introspection.

## Public Surface

- Package: `@lherron/agent-spaces`, version `0.5.0`, ESM package with `asp` binary at `packages/cli/bin/asp.js`.
- Main export: `packages/cli/src/index.ts` exports `main()` and `findProjectRoot()`.
- Compatibility exports from package root: `./core`, `./resolver`, `./store`, `./materializer`, `./git`, and `./lint` re-export `spaces-config`; `./engine` and `./claude` re-export `spaces-execution`; `./runtime` re-exports `agent-spaces`.
- Prompt display export: `packages/cli/src/prompt-display.ts` re-exports `displayPrompts`, `displayCommand`, `formatDisplayCommand`, and `DisplayPromptOptions` from `spaces-execution`.
- CLI commands registered in `packages/cli/src/index.ts`: `run`, `init`, `install`, `build`, `describe`, `explain`, `lint`, `list`, `path`, `doctor`, `gc`, `add`, `remove`, `upgrade`, `diff`, `harnesses`, `resolve-reminder`, `self`, `repo`, `spaces`, and `agent`.
- `asp run <target> [prompt]`: supports project targets, global `space:id@selector` refs, and local space directories, with harness/model/settings/resume/dry-run/print-command options.
- `asp agent <scope> <mode> [prompt]`: placement-driven execution for `query`, `heartbeat`, `task`, `maintenance`, and `resolve`, with bundle selection, continuation, attachments, env injection, and process invocation dry-run support.
- `asp self inspect|paths|prompt|explain`: live-runtime introspection based on `HRC_LAUNCH_FILE`, `ASP_PLUGIN_ROOT`, context templates, and agent roots.
- `asp repo init|status|publish|tags|gc`: local registry initialization, status, version tagging, dist-tag updates, and repository/store cleanup.
- `asp spaces init|list`: registry space scaffolding and listing.
- No HTTP routes are defined in this package.

## Internal Structure

- `bin/asp.js`: executable launcher that prefers `src/index.ts` in development unless `ASP_USE_DIST=1`, then falls back to `dist/index.js`.
- `src/index.ts`: program construction, command registration, top-level Commander/cli-kit/AspError normalization, and one copy of `findProjectRoot()`.
- `src/helpers.ts`: common project context resolution, shared `exitWithAspError()`, doctor status formatting, and invocation stdout/stderr logging.
- `src/ui.ts`: terminal color, symbol, spinner, command-block, target-block, path, and duration formatting helpers used most heavily by `install`.
- `src/commands/run.ts`: primary launch workflow, including run-mode detection, settings inheritance mapping, harness validation, and three duplicated option builders for project/global/dev runs.
- `src/commands/agent/index.ts` and `src/commands/agent/shared.ts`: placement bundle selection, scope/lane normalization, harness frontend/provider normalization, prompt/env parsing, dry-run output, process spawning, and SDK turn execution.
- `src/commands/self/lib.ts`: shared live-agent context resolution, launch artifact parsing, prompt extraction, context-template diagnostics, path classification, and byte/character counting.
- `src/commands/self/*.ts`: presentation and option handling for self-inspection, path enumeration, prompt dumps, and diagnostic explanations.
- `src/commands/repo/*.ts`: registry init/status/publish/tag/gc operations; `manager-space-content.ts` embeds the full built-in manager space as TypeScript string constants.
- `src/commands/spaces/*.ts`: space scaffolding and registry listing.
- `src/commands/add.ts`, `remove.ts`, `init.ts`, `install.ts`, `build.ts`, `upgrade.ts`, `diff.ts`, `explain.ts`, `lint.ts`, `list.ts`, `path.ts`, `doctor.ts`, `gc.ts`, `harnesses.ts`, and `describe.ts`: one-file command handlers around lower-level config/execution APIs.
- `scripts/prepack.ts`, `scripts/postpack.ts`, and `scripts/smoke-test-pack.ts`: package preparation and smoke testing scripts for bundled dependencies and published-package validation.

## Dependencies

- Production dependencies from `package.json`: `@anthropic-ai/claude-agent-sdk`, `@iarna/toml`, `@mariozechner/pi-coding-agent`, `ajv`, `ajv-formats`, `chalk`, `cli-kit`, `commander`, `figures`, `ora`, `proper-lockfile`, and `semver`.
- Workspace/runtime production dependencies used through imports and optional/bundled package exports: `agent-scope`, `agent-spaces`, `spaces-config`, `spaces-execution`, `spaces-runtime`, `spaces-harness-claude`, `spaces-harness-codex`, `spaces-harness-pi`, and `spaces-harness-pi-sdk`.
- Test/dev dependencies: Bun's test runner via `bun test`, `@types/bun`, and `typescript`.

## Test Coverage

I found 13 test/helper files under `src`, with 121 `test(...)` cases across 12 actual test files. Coverage is strongest for `asp agent` placement flows, scope/session-handle parsing, `asp run --model-reasoning-effort`, context-template reminder behavior, and the `asp self` helpers/CLI. The broad management commands are mostly untested in this package: `repo init/status/publish/tags/gc`, `spaces init/list`, `add`, `remove`, `upgrade`, `diff`, `doctor`, `harnesses`, `gc`, `path`, `describe`, and much of `install`/`build` have little or no direct CLI-level test coverage here. I did not run tests because this sweep only added documentation.

## Recommended Refactors and Reductions

1. Deduplicate project-root discovery. `findProjectRoot()` exists in both `src/index.ts` and `src/lib.ts`, and the `src/index.ts` version calls `Bun.file(targetsPath).exists()` twice before using the result. Keep one implementation in a side-effect-free module and import it from both CLI and tests.

2. Move the embedded manager space out of TypeScript code. `src/commands/repo/manager-space-content.ts` is 1,425 lines and mostly static Markdown/TOML string content, while `repo/init.ts` only needs `getManagerSpaceFiles()`. Store those files as package assets or fixtures and have `getManagerSpaceFiles()` read/return them, reducing TypeScript parse/build noise and making the manager space reviewable as normal files.

3. Centralize harness validation and command error exits. `build.ts`, `run.ts`, `install.ts`, and `explain.ts` each validate harnesses locally; many command handlers still print errors and call `process.exit()` directly (`add.ts`, `install.ts`, `explain.ts`, `gc.ts`, `harnesses.ts`, `path.ts`, `repo/status.ts`, `spaces/init.ts`, `spaces/list.ts`). Use a shared `validateHarnessOption()` plus `CliUsageError`/`exitWithAspError()` so JSON/error formatting and exit behavior stay consistent.

4. Collapse repeated `asp run` option plumbing. `runProjectMode()`, `runGlobalMode()`, and `runDevMode()` in `src/commands/run.ts` each build nearly identical option objects for warnings, extra args, dry-run, refresh, permission, settings, harness, model, continuation, remote control, session name, and prompt paging. Extract a common `buildExecutionRunOptions()` and pass only mode-specific fields to reduce drift.

5. Share self-introspection prompt/template assembly. `src/commands/self/prompt.ts` and `src/commands/self/explain.ts` both resolve template source, run `resolveSelfTemplateContext()`, call `resolveContextTemplateDetailed()`, inspect bundle prompt/reminder files, and compute section diagnostics. Move that into focused helpers in `self/lib.ts` so `prompt` and `explain` render different views of the same computed payload instead of maintaining parallel logic.
