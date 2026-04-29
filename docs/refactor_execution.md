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

1. Split `src/run.ts` into focused modules. The file is 1,536 lines and mixes model planning, agent profile loading, install decisions, prompt materialization, process spawning, global/local materialization, and result construction. Good extraction seams already exist around `planProjectTargetRuntime`, `executeHarnessRun`, agent-profile helpers, and global/local space materialization.

2. Remove or rewire the currently inert lint-warning path in `src/run.ts`. `printWarnings` is defined at lines 677-690, but `run` creates `const warnings: LintWarning[] = []` at line 995 and immediately prints that empty array. Either connect real lint warnings from install/materialization results or remove the dead branch so callers do not infer that lint warnings are being propagated.

3. Consolidate prompt display rendering in `src/run.ts` with `src/prompt-display.ts`. `executeHarnessRun` manually builds prompt display lines at lines 570-632 while `displayPrompts` implements similar rendering at lines 183-289 of `src/prompt-display.ts`. Keeping both paths means prompt budgets, command labels, paging, and output stream behavior can drift.

4. Extract the repeated run-option assembly and execution tail used by `runGlobalSpace` and `runLocalSpace`. The `cliRunOptions`, `mergeDefined`, non-interactive prompt guard, `executeHarnessRun`, cleanup, and `RunResult` construction blocks at lines 1341-1389 and 1467-1524 are nearly identical. A shared helper would reduce duplicated launch logic and make option additions less error-prone.

5. Replace source-inspection tests in `src/run.test.ts` with behavior tests. The tests at lines 217-247 and 340-348 assert that `run.ts` contains particular strings rather than validating runtime behavior. These should become adapter-stub or helper-level tests for prompt threading, placement planning, project-target planning, and agent-local component materialization.
