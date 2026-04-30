# Refactor Notes: harness-claude

## Purpose

`packages/harness-claude` provides the Claude-facing harness implementation for Agent Spaces. It materializes spaces into Claude plugin artifacts, composes those artifacts into runnable target bundles, builds Claude CLI invocations, registers the Claude and Claude Agent SDK harnesses, and exposes an in-process Agent SDK session implementation that maps SDK messages, tool events, permissions, and lifecycle state into the shared `spaces-runtime` session contracts.

## Public Surface

The package is published internally as `spaces-harness-claude` and exports three entry points from `package.json`: `.`, `./claude`, and `./agent-sdk`.

The root entry point `src/index.ts` exports `ClaudeAdapter`, `claudeAdapter`, `ClaudeAgentSdkAdapter`, `claudeAgentSdkAdapter`, everything from `src/claude/index.ts`, everything from `src/agent-sdk/index.ts`, and `register`.

The harness adapter surface is centered on `ClaudeAdapter` in `src/adapters/claude-adapter.ts`. It implements the `HarnessAdapter` contract with detection, space validation, space materialization, target composition, run argument generation, target bundle loading, run environment construction, default run option resolution, and target output path resolution. `ClaudeAgentSdkAdapter` in `src/adapters/claude-agent-sdk-adapter.ts` delegates most behavior to `ClaudeAdapter` while changing the harness id and output path to `claude-agent-sdk`.

The Claude CLI helper entry point `src/claude/index.ts` exports detection helpers (`detectClaude`, `findClaudeBinary`, `getClaudePath`, `clearClaudeCache`, `ClaudeInfo`), invocation helpers (`invokeClaude`, `invokeClaudeOrThrow`, `runClaudePrompt`, `spawnClaude`, `buildClaudeArgs`, `formatClaudeCommand`, `getClaudeCommand`, and related option/result types), and plugin validation helpers (`validatePlugin`, `validatePlugins`, `checkPluginNameCollisions`, `validatePluginsWithCollisionCheck`, `PluginValidationResult`).

The Agent SDK entry point `src/agent-sdk/index.ts` exports `AgentSession`, `AgentSessionConfig`, `AgentSessionState`, `PromptQueue`, `SDKUserMessage`, `HooksBridge`, `processSDKMessage`, hook/permission types, and re-exports `createSdkMcpServer`, `query`, and `tool` from `@anthropic-ai/claude-agent-sdk`.

`src/register.ts` exposes `register(reg)`, which registers both Claude harness adapters in a `HarnessRegistry` and registers the `agent-sdk` session kind in a `SessionRegistry`.

No HTTP routes or standalone CLI commands are defined in this package. It is invoked by higher-level runtime and CLI packages.

## Internal Structure

`src/adapters/claude-adapter.ts` is the primary harness implementation. It detects Claude with `detectClaude`, validates plugin naming, materializes plugin directories by calling `spaces-config` materialization helpers, converts `hooks.toml` to Claude `hooks.json`, copies `permissions.toml`, composes ordered plugin bundles under `plugins/<NNN-spaceId>`, merges MCP and settings configuration, installs `assets/statusline.sh`, builds Claude run arguments, loads existing bundles, and derives default run options from project manifests.

`src/adapters/claude-agent-sdk-adapter.ts` is a thin adapter wrapper that delegates to `claudeAdapter` for detection, validation, materialization, composition, run arguments, bundle loading, run environment, and defaults, while returning `claude-agent-sdk` paths and bundle ids.

`src/claude/detect.ts` finds the Claude binary via `ASP_CLAUDE_PATH`, `PATH`, and common install paths, runs `claude --version`, probes `claude --help` for `--plugin-dir` and `--mcp-config`, and caches the result. `src/claude/invoke.ts` builds argv arrays, formats copy-pasteable shell commands, invokes Claude with Bun subprocesses, supports captured output and timeouts, and offers prompt and spawn conveniences. `src/claude/validate.ts` validates materialized plugin directories, plugin metadata, component paths, hooks JSON, and plugin-name collisions.

`src/agent-sdk/agent-session.ts` owns the long-lived SDK query, prompt queue, lifecycle state, turn tracking, stop/interrupt behavior, metadata snapshots, SDK session id capture, message event emission, tool execution event emission, subagent context tracking, content normalization, and hook stop/session-end events. `src/agent-sdk/hooks-bridge.ts` bridges SDK permission callbacks and SDK tool messages into the host hook event bus. `src/agent-sdk/prompt-queue.ts` implements the async iterable prompt queue consumed by the SDK.

`assets/statusline.sh` is copied into composed Claude targets and referenced from generated settings as the Claude status line command.

## Dependencies

Production dependencies are `@anthropic-ai/claude-agent-sdk`, `spaces-config`, and `spaces-runtime`. The package also uses Bun APIs and Node built-ins including `fs/promises`, `path`, `url`, `crypto`, and `os`.

Test and build dependencies are `bun:test`, `@types/bun`, and `typescript`. Tests use temporary directories and mock Claude shell scripts rather than a real Claude installation.

## Test Coverage

There are 100 tests across six test files:

- `src/adapters/claude-adapter.test.ts` covers adapter identity, detection with a mock binary, space validation, materialization, hook and permission handling during materialization, target composition, statusline installation, run argument generation, run environment, defaults, and target output paths.
- `src/adapters/claude-agent-sdk-adapter.test.ts` covers SDK adapter detection, identity, registry registration, output path, and run argument delegation.
- `src/agent-sdk/agent-session.getMetadata.test.ts` covers metadata shape and pre-start state/capability fields.
- `src/claude/invoke.test.ts` covers argument building, shell formatting, command resolution, captured invocation, environment and cwd handling, non-zero exits, prompt invocation, and subprocess spawning.
- `src/claude/validate.test.ts` covers missing plugin directories, missing plugin metadata, plugin name validation, valid plugin metadata, and collision checks.
- `src/claude/detect.test.ts` is named for detection but only repeats a subset of `buildClaudeArgs` coverage from `invoke.test.ts`.

Main gaps: `AgentSession` runtime message streaming, interrupt/stop races, permission decisions, hook bridge behavior, tool/subagent event correlation, and SDK resume/session-id capture have little or no direct test coverage. `HooksBridge` and `PromptQueue` have no dedicated test files. `detect.ts` binary search, version parsing, flag probing, cache invalidation, and error paths are not directly covered despite the `detect.test.ts` filename.

## Recommended Refactors and Reductions

1. Remove or repurpose `src/claude/detect.test.ts`. Its seven tests exercise `buildClaudeArgs` from `src/claude/invoke.ts`, duplicating cases already covered in `src/claude/invoke.test.ts`; it does not test `detectClaude`, `findClaudeBinary`, `supportsFlag`, or cache behavior.

2. Delete the unused `_COMPONENT_DIRS` constant in `src/claude/validate.ts`. The validator explicitly enumerates `commands`, `agents`, `skills`, and `hooks` in `validateComponentPaths`, and `_COMPONENT_DIRS` is not referenced.

3. Extract SDK content and tool-result normalization shared by `src/agent-sdk/agent-session.ts` and `src/agent-sdk/hooks-bridge.ts`. Both files define separate `resolveToolUseId` and `normalizeToolResultBlocks` implementations, and both translate `resource_link`, `resource`, `media_ref`, image, text, `tool_use`, and `tool_result` blocks. A shared mapper would reduce drift between unified session events and hook events.

4. Split `src/agent-sdk/agent-session.ts` into lifecycle/session control and SDK-message translation modules. At 958 lines, `AgentSession` currently mixes query startup, prompt queue interaction, stop/interrupt teardown, metadata, turn bookkeeping, hook stop emission, subagent context tracking, message mapping, tool execution mapping, and content normalization. The `handleSdkMessage`, `handleToolBlocks`, `processToolUseBlock`, `processToolResultBlock`, and mapping helpers are a clear extraction boundary.

5. Surface statusline installation failures from `ClaudeAdapter.composeTarget`. The `try/catch` around `assets/statusline.sh` copying and settings patching silently ignores any read/write/chmod failure, so composed targets can differ from expected settings without a warning. Add a `LockWarning` entry when the best-effort install fails.

6. Harden `assets/statusline.sh` or document its runtime dependency. The script assumes `jq` is available and valid JSON is always passed on stdin; because `ClaudeAdapter.composeTarget` installs it into every Claude target's settings, machines without `jq` will get a failing statusline command. A small guard that exits cleanly when `jq` is missing would make target composition less environment-sensitive.

