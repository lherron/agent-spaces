# Refactor Notes: execution

## Purpose

`spaces-execution` is the run-time orchestration layer for Agent Spaces. It sits between config-time materialization (`spaces-config`), session contracts (`spaces-runtime`), and harness-specific packages, then exposes helpers for installing/building targets, launching project and ad-hoc spaces, preparing persistent Codex homes, rendering prompt previews, and accessing registered harness adapters.

## Public Surface

The root package export in `src/index.ts` exposes:

- Claude CLI and Agent SDK helpers via `./claude/index.ts` and `./agent-sdk/index.ts`, both re-exported from `spaces-harness-claude`.
- Session types and helpers from `spaces-runtime/session`.
- Codex and Pi SDK session types, intentionally as type-only exports for Pi SDK runtime objects.
- Harness registry and adapter exports from `./harness/index.ts`, including `harnessRegistry`, `sessionRegistry`, `HarnessRegistry`, `SessionRegistry`, adapter classes and singleton adapters for Claude, Claude Agent SDK, Codex, Pi, and Pi SDK, plus harness config types from `spaces-config`.
- Run helpers from `src/run.ts`: `run`, `runWithPrompt`, `runInteractive`, `runGlobalSpace`, `runLocalSpace`, `isSpaceReference`, `detectAgentLocalComponents`, `planPlacementRuntime`, `resolveAgentRunDefaults`, and the related option/result types.
- Codex runtime helpers re-exported through `src/run.ts`: `ensureCodexProjectTrust`, `getProjectCodexRuntimeHomePath`, `migrateLegacyProjectCodexRuntimeHome`, and `prepareCodexRuntimeHome`.
- Install/build wrappers in `src/index.ts`: `install`, `materializeTarget`, `materializeFromRefs`, `build`, and `buildAll`. These resolve the configured harness adapter automatically before delegating to `spaces-config`.
- Prompt display utilities from `src/prompt-display.ts`: `displayPrompts`, `displayCommand`, `formatDisplayCommand`, `renderSection`, and `renderKeyValueSection`.
- Terminal pager utility `paginate`.

There are no HTTP routes and no CLI commands defined in this package. The CLI packages consume this package to implement commands such as `asp run`, `asp build`, `asp install`, and harness inspection.

## Internal Structure

- `src/index.ts`: public barrel. It wires config package operations to `harnessRegistry` and re-exports run, harness, session, Claude, Codex, Pi, pager, and prompt display APIs.
- `src/run.ts`: main orchestration file. It plans target runtime defaults, reads agent profiles, detects harnesses, installs or materializes targets when needed, materializes system prompts, executes harness commands, and implements project, global registry, and local space run modes.
- `src/run-codex.ts`: Codex runtime-home preparation. It computes stable Codex home paths, migrates legacy project runtimes out of `asp_modules`, syncs managed template files into the persistent runtime, applies Praesidium context, marks projects as trusted in Codex config, writes `.asp-runtime.json`, and injects `codexHomeDir` into run options.
- `src/harness/index.ts`: harness registry setup. It registers Claude, Pi, Pi SDK, and Codex adapters and exposes adapter classes, detection helpers, registry classes, registry singletons, and harness types.
- `src/prompt-display.ts`: shared terminal rendering for system prompts, reminders, priming prompts, prompt budgets, key-value metadata sections, and display-safe harness commands.
- `src/pager.ts`: small TTY pager used when prompt output should pause one screen at a time.
- `src/claude/index.ts`: compatibility re-export of `spaces-harness-claude/claude`.
- `src/agent-sdk/index.ts`: compatibility re-export of `spaces-harness-claude/agent-sdk`.
- `src/pi-session/index.ts`: type-only compatibility re-export of Pi SDK session and bundle types to avoid loading the Pi SDK barrel at startup.
- `src/run.test.ts`: package-local Bun tests covering helper behavior, Codex runtime-home handling, agent-profile default resolution, agent-local component detection, and several source-level regression gates.
- `tsconfig.json`: composite TypeScript build config that emits `dist` from `src` and excludes test files.

## Dependencies

Production dependencies:

- `chalk`: terminal color formatting for command and prompt display.
- `spaces-config`: manifest, lockfile, registry, materialization, harness types, path resolution, agent profile parsing, and install/build functions.
- `spaces-runtime`: session interfaces, context template discovery/materialization, and registry classes.
- `spaces-harness-claude`: Claude CLI and Claude Agent SDK adapters and helper re-exports.
- `spaces-harness-pi`: Pi adapter, Pi binary detection, extension discovery, hook bridge generation, and related types.
- `spaces-harness-pi-sdk`: Pi SDK adapter plus type-only session/bundle exports.
- `spaces-harness-codex`: Codex adapter, Codex session config type, and Codex home Praesidium-context application.

Test and build dependencies:

- `@types/bun`: Bun runtime and test typings.
- `typescript`: package typecheck and build.
- Bun's built-in `bun:test`, used by `src/run.test.ts`.

## Test Coverage

Package-local coverage is one Bun test file, `src/run.test.ts`, with 29 test cases. The tests cover:

- `isSpaceReference`.
- Codex trust config insertion and stable runtime path generation.
- Legacy Codex runtime migration.
- Codex runtime-home sync behavior, state preservation, trust entry writing, and runtime metadata.
- Source-level gates for system prompt threading, placement planner exports, and project-target runtime planner integration.
- `detectAgentLocalComponents`.
- `resolveAgentRunDefaults` behavior for yolo, model, harness-specific defaults, identity harness, compose merging, target harness precedence, and missing profiles.

Gaps:

- `run`, `runWithPrompt`, and `runInteractive` do not have package-local behavioral tests that stub a harness adapter and verify install decisions, prompt merging, warning handling, dry-run command construction, or non-interactive prompt validation.
- `runGlobalSpace` and `runLocalSpace` have integration coverage elsewhere in the repo, but this package does not locally test cleanup behavior, unsupported harness rejection, persisted global locks, or local synthetic lock output.
- `prompt-display.ts` and `pager.ts` have no direct tests for command elision, prompt budget rendering, non-TTY output, or keypress behavior.
- Several tests inspect source text instead of exercising behavior, so they can pass while the behavior regresses.

## Recommended Refactors and Reductions

Status: **Done** — all five recommendations shipped in PR #2 (commit `f8905dc`, branch `refactor-execution-package`, merged 2026-04-29).

1. **Split `src/run.ts` into focused modules.** ✅ Done. `run.ts` went from 1,536 lines to 303 lines and now contains only `run`, `runWithPrompt`, `runInteractive`, `isSpaceReference`, and re-exports. Sub-modules under `src/run/`:
   - `run/types.ts` — `RunOptions`, `RunResult`, `RunInvocationResult`, `GlobalRunOptions`
   - `run/util.ts` — `shellQuote`, `formatCommand`, `formatEnvPrefix`, `mergeDefined`, `combinePrompts`, `resolveInteractive`, `pathExists`, `composeArraysMatch`, `createTempDir`, `cleanupTempDir`
   - `run/agent-profile.ts` — `LoadedAgentProfile`, `detectAgentLocalComponents`, `loadAgentProfileForRun`, `resolveProfileHarnessForRun`, `resolveAgentPrimingPromptForRun`, `resolveAgentRunDefaultsFromProfile`, `resolveAgentRunDefaults`
   - `run/placement-plan.ts` — `parsePlacementRuntimeModelId`, `resolvePlacementRuntimeModel`, `buildSyntheticRunManifest`, `planProjectTargetRuntime`, `planPlacementRuntime` (and the related public types)
   - `run/execute.ts` — `executeHarnessCommand`, `executeHarnessRun`, `ExecuteHarnessResult`, `MaterializedPromptResult`
   - `run/space-launch.ts` — `runGlobalSpace`, `runLocalSpace`, `executeSpaceRun`, `persistGlobalLock`
   Public surface (re-exports through `run.ts` and `spaces-execution`) is unchanged.

2. **Remove the inert lint-warning path.** ✅ Done. Removed `printWarnings()`, the `warnings: LintWarning[] = []` allocation, the `LintWarning` import, the `printWarnings` field on `RunOptions` and `GlobalRunOptions`, and the unused `--no-warnings` CLI flag (with its three call sites in `packages/cli/src/commands/run.ts`). The `BuildResult.warnings` field is still set (always to `[]`) since downstream consumers depend on the type shape.

3. **Consolidate prompt display rendering.** ✅ Done. The inline rendering block in `executeHarnessRun` (formerly run.ts:570-632) was replaced with a single call to `displayPrompts({ systemPrompt, systemPromptMode, reminderContent, primingPrompt, command, showCommand: true, pagePrompts })`. Live runs and dry-run mode now share the same budget, command label (`── command ──` style), paging logic, and output stream as `asp run --dry-run` and `hrc launch exec`. Net delta: ~95 lines removed and the `chalk` import is no longer needed in `run.ts`.

4. **Extract the repeated run-option assembly used by `runGlobalSpace` and `runLocalSpace`.** ✅ Done. Both functions now delegate to `executeSpaceRun({ adapter, detection, bundle, options, aspHome, defaultCwd, tempDir, lock })`, which builds `cliRunOptions` from `GlobalRunOptions`, applies `mergeDefined` defaults, enforces the non-interactive prompt guard, calls `executeHarnessRun`, runs cleanup, and assembles the `RunResult`. The two call sites differ only in `defaultCwd` (`process.cwd()` vs `spacePath`) and `lock` (real lock vs synthetic).

5. **Replace source-inspection tests with behavior tests.** ✅ Done. The four source-grep tests in `src/run.test.ts` were rewritten:
   - **T-01097** (placement runtime planner) — now exercises `planPlacementRuntime` directly: verifies it resolves frontend/harness/cwd/runOptions, returns the model resolution discriminated union, and throws on unknown frontends.
   - **T-01099** (project-target runtime planner) — now calls `planProjectTargetRuntime` with a synthetic manifest and asserts the resolved harness adapter, target, and `defaultPrompt`. Adds a behaviour test for `combinePrompts` covering all four input combinations.
   - **T-01016** (system prompt threading) — converted to a structural test that constructs a `RunResult` literal with `systemPromptMode`/`reminderContent`/`maxChars`. Removing any of these fields fails the test at typecheck time.
   - **T-01067** (agent-local component threading) — replaced the source-grep on `run.ts` with a behaviour test that verifies the `detectAgentLocalComponents` return type matches what `run()` threads into `materializeFromRefs` (asserts `agentRoot`, `hasSkills`, `hasCommands`, `skillsDir`, `commandsDir`).
   - The unrelated source-extraction test in `packages/agent-spaces/src/__tests__/phase4-harness-adapter-integration.test.ts` was updated to read `run/placement-plan.ts` (where `planPlacementRuntime` now lives).
   Test count went from 29 → 32. Verification: full `bun run test:fast` (1,845/1,845) and per-package suites for `spaces-execution`, `@lherron/agent-spaces`, `hrc-server`, `hrc-cli` all pass.
