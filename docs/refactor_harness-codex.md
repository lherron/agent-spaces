# Refactor Notes: harness-codex

## Purpose

`packages/harness-codex` implements the OpenAI Codex harness integration for Agent Spaces. It materializes space artifacts into a Codex-compatible `codex.home`, composes target-level Codex configuration, builds Codex CLI arguments and environment, detects usable Codex CLI binaries, and provides a `CodexSession` wrapper over `codex app-server` JSON-RPC for unified session streaming, approvals, resume metadata, and attachment handling.

## Public surface

The package is published as `spaces-harness-codex` with two package exports:

- `spaces-harness-codex` from `src/index.ts`
- `spaces-harness-codex/codex-session` from `src/codex-session/index.ts`

Exported symbols from `src/index.ts`:

- `CodexAdapter`
- `codexAdapter`
- `applyPraesidiumContextToCodexHome`
- everything exported by `src/codex-session/index.ts`
- `register`

Exported symbols from `src/codex-session/index.ts`:

- `CodexSession`
- `CodexSessionConfig`
- `CodexApprovalPolicy`
- `CodexSandboxMode`

Other exported module-local symbols:

- `src/codex-session/types.ts`: `CodexTurnArtifacts` is exported for internal type sharing.
- `src/codex-session/rpc-client.ts`: `JsonRpcId`, `JsonRpcRequest`, `JsonRpcNotification`, `JsonRpcResponse`, `JsonRpcMessage`, and `CodexRpcClient` are exported for the session implementation, but this file is not exposed in `package.json` exports.

No HTTP routes or CLI commands are defined in this package. The run-facing CLI behavior is exposed through the `HarnessAdapter` methods on `CodexAdapter`, especially `detect`, `materializeSpace`, `composeTarget`, `buildRunArgs`, `getRunEnv`, `loadTargetBundle`, and `getDefaultRunOptions`.

Observed consumers:

- `packages/execution/src/harness/index.ts` imports and registers `codexAdapter`.
- `packages/execution/src/run-codex.ts` imports `applyPraesidiumContextToCodexHome`.
- `packages/execution/src/index.ts` re-exports only the `CodexSessionConfig` type from `spaces-harness-codex/codex-session`.
- `packages/agent-spaces/src/__tests__/pre-hrc-cleanup.test.ts` imports `CodexSession` directly from `spaces-harness-codex/codex-session` in a runtime regression test.
- `packages/cli/scripts/prepack.ts` and `packages/cli/scripts/postpack.ts` include `spaces-harness-codex` in CLI package staging.

## Internal structure

- `src/index.ts` is the top-level package barrel for the adapter, session surface, and `register`.
- `src/register.ts` registers `codexAdapter` and a `CodexSession` factory with runtime registries. It maps runtime session options into `CodexSessionConfig`, including `continuationKey` to `resumeThreadId`.
- `src/adapters/codex-adapter.ts` contains most of the package logic: Codex constants, file helpers, config merging, `AGENTS.md` composition, Praesidium context injection, Codex CLI detection, space materialization, target composition, run argument generation, bundle loading, runtime environment generation, and default run option extraction.
- `src/codex-session/types.ts` defines Codex session config, approval/sandbox unions, and turn artifact payloads.
- `src/codex-session/rpc-client.ts` implements newline-delimited JSON-RPC over a Codex app-server child process, including pending request tracking, response dispatch, request replies, notification callbacks, close handling, and process error propagation.
- `src/codex-session/codex-session.ts` implements the `UnifiedSession` adapter over `CodexRpcClient`. It starts or resumes Codex threads, sends prompts, maps Codex notifications into unified events, handles approval requests, records optional JSON-RPC event streams, exposes metadata, and converts URL/file attachments into Codex input items.
- `src/codex-session/index.ts` is the subpath barrel for session consumers.

## Dependencies

Production dependencies from `package.json`:

- `@iarna/toml`: serializes and parses Codex TOML config in adapter tests and composition.
- `spaces-config`: provides harness adapter contracts, compose/materialize types, MCP composition, Codex option resolution, and copy/link utilities.
- `spaces-runtime`: provides harness/session registries, unified session contracts, events, permissions, and tool result types.

Runtime platform dependencies:

- Node built-ins: `child_process`, `crypto`, `fs`, `fs/promises`, `os`, `path`, `events`, and `readline`.
- Bun APIs are used opportunistically in `runCommand` when `globalThis.Bun` is available, and package scripts run through Bun.

Test/dev dependencies:

- `bun:test`
- `typescript`
- `@types/bun`
- `@iarna/toml` is also used directly in adapter tests.

## Test coverage

The package has 4 test files with 37 test cases:

- `src/adapters/codex-adapter.test.ts`: Codex CLI detection, space materialization, target composition, run args, defaults, runtime env, and Praesidium context injection.
- `src/adapters/codex-adapter.model-reasoning-effort.test.ts`: focused coverage for `model_reasoning_effort` composition and CLI override behavior.
- `src/codex-session/codex-session.test.ts`: app-server event streaming, approval replies, local image attachment input, and error notification propagation using executable shims.
- `src/codex-session/codex-session.getMetadata.test.ts`: metadata shape and capability flags.

Coverage gaps:

- `CodexRpcClient` has no direct unit tests for malformed JSON, unexpected response IDs, rejected JSON-RPC errors, stdin backpressure, unhandled requests, or process exit rejection behavior.
- `CodexSession` does not test file-change approval requests, MCP tool call events, web search events, image view events, turn diff/plan artifacts, oversized image rejection, URL image attachments, non-image attachment fallback text, resume-thread startup payloads, or event recording to `eventsOutputPath`.
- `CodexAdapter.loadTargetBundle` and `validateSpace` are not directly covered.
- `buildRunArgs` does not cover resume-mode argument shapes, `yolo` overrides, image attachment CLI flags, profile handling, approval policy differences between exec and interactive modes, or `exec resume` sandbox override behavior.

## Recommended refactors and reductions

1. Split `src/adapters/codex-adapter.ts` by responsibility. At 976 lines, `CodexAdapter` mixes binary discovery (`codexCommandCandidates`, `runCommand`, `detect`), materialization (`materializeSpace`), target composition (`composeTarget`, `buildCodexConfig`, `buildAgentsMarkdown`), runtime arg/env helpers (`buildRunArgs`, `getRunEnv`, `getDefaultRunOptions`), and Praesidium context mutation (`applyPraesidiumContextToCodexHome`). Extracting discovery, config composition, and Praesidium context helpers would reduce the adapter class to the harness contract and make the untested helper behavior easier to isolate.

2. Split `src/codex-session/codex-session.ts` into session lifecycle, notification mapping, approval handling, and attachment conversion modules. The file is 775 lines and includes the large `CodexThreadItem` union, notification payload interfaces, lifecycle methods, event conversion switches, approval request handling, and `buildUserInputs`. The event mapping in `handleItemStarted` and `handleItemCompleted` is a clear extraction target because it is mostly deterministic conversion from Codex item shapes to `UnifiedSessionEvent` payloads.

3. Consolidate duplicated `model_reasoning_effort` tests. `src/adapters/codex-adapter.test.ts` already verifies `composeTarget` writes `model_reasoning_effort` and `buildRunArgs` emits `-c model_reasoning_effort="high"`, while `src/adapters/codex-adapter.model-reasoning-effort.test.ts` repeats the same behavior in more detail. Keep the edge cases from the focused file, but remove duplicate assertions from the general adapter test or fold the focused file into the adapter suite.

4. Remove or quarantine stale RED-test commentary in green tests. `src/adapters/codex-adapter.model-reasoning-effort.test.ts` and `src/codex-session/codex-session.getMetadata.test.ts` still describe themselves as RED tests tied to historical task IDs even though the implementation now passes these behaviors. This makes current coverage harder to scan; convert those headers into neutral behavior descriptions or move task history to commit notes.

5. Reassess the exported `register` function in `src/register.ts`. Current execution startup in `packages/execution/src/harness/index.ts` registers `codexAdapter` directly and comments that the Codex session factory was removed from the execution registry path. A repository search found no current import of `register` outside this package. If no external private consumer relies on it, dropping `register` from `src/index.ts` and deleting `src/register.ts` would remove an outdated session-registry path; otherwise mark it explicitly as legacy and add a focused test for its option mapping.
