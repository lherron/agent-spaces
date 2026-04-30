# Refactor Notes: harness-pi-sdk

## Purpose

`packages/harness-pi-sdk` implements the Pi SDK integration for Agent Spaces. It provides the `pi-sdk` harness adapter that materializes space artifacts, composes Pi SDK bundle manifests, builds runner arguments and environment, and exposes a `PiSession` implementation plus bundle-loading helpers for consumers that need to run Pi through the SDK instead of the Pi CLI.

## Public surface

The package is published as `spaces-harness-pi-sdk` with four package exports:

- `spaces-harness-pi-sdk`, from `src/index.ts`
- `spaces-harness-pi-sdk/adapter`, from `src/adapters/pi-sdk-adapter.ts`
- `spaces-harness-pi-sdk/register`, from `src/register.ts`
- `spaces-harness-pi-sdk/pi-session`, from `src/pi-session/index.ts`

Exported symbols from the root barrel:

- `PiSdkAdapter`
- `piSdkAdapter`
- `register`
- Everything re-exported by `src/pi-session/index.ts`

Exported symbols from `src/pi-session/index.ts`:

- `PiSession`
- `createPermissionHook`
- `loadPiSdkBundle`
- Re-exported Pi SDK runtime values: `AuthStorage`, `ModelRegistry`, `createCodingTools`, `createEventBus`, `createExtensionRuntime`, `discoverAndLoadExtensions`, `loadSkills`, and `SettingsManager`
- Types: `HookPermissionResponse`, `PiAgentSessionEvent`, `PiHookEventBusAdapter`, `PiSessionConfig`, `PiSessionStartOptions`, `PiSessionState`, `ExtensionAPI`, `ExtensionFactory`, `Skill`, `ToolDefinition`, `LoadPiSdkBundleOptions`, `PiSdkBundleHookEntry`, `PiSdkBundleLoadResult`, `PiSdkBundleManifest`, and `PiSdkContextFile`

Exported symbols from `src/adapters/pi-sdk-adapter.ts`:

- `PiSdkAdapter`
- `piSdkAdapter`

Exported symbols from `src/register.ts`:

- `register(reg)`, which registers `piSdkAdapter` with a `HarnessRegistry` and registers a `pi` session factory with a `SessionRegistry`.

`src/adapters/pi-bundle.ts` exports `PiBundleError`, `ExtensionBuildOptions`, `bundleExtension`, and `discoverExtensions`, but those are not exposed through the package export map. No HTTP routes or package-owned CLI commands are defined. The standalone runner in `src/pi-sdk/pi-sdk/runner.ts` is invoked through `PiSdkAdapter.buildRunArgs`, not through a package `bin`.

Observed consumers:

- `packages/execution/src/harness/index.ts` imports and registers `piSdkAdapter` from `spaces-harness-pi-sdk/adapter`.
- `packages/execution/src/pi-session/index.ts` re-exports Pi session types from `spaces-harness-pi-sdk/pi-session`.
- `packages/agent-spaces/src/client.ts` imports `PiSession` and `loadPiSdkBundle` from `spaces-harness-pi-sdk/pi-session`.
- CLI prepack/postpack scripts include `spaces-harness-pi-sdk`, `spaces-harness-pi-sdk/adapter`, and `spaces-harness-pi-sdk/pi-session` in the bundled CLI package.

## Internal structure

- `src/index.ts` is the root barrel for the adapter, Pi session API, and registration helper.
- `src/register.ts` wires the SDK adapter and a `pi` `PiSession` factory into runtime registries.
- `src/adapters/pi-sdk-adapter.ts` contains the `HarnessAdapter` implementation: SDK detection, space materialization, extension bundling, target composition, hook and context manifest generation, auth symlink/settings generation, run argument construction, bundle reloading, run environment generation, and default model declarations.
- `src/adapters/pi-bundle.ts` bundles individual Pi extensions with `bun build` and discovers `.ts` or `.js` extension files under a snapshot `extensions/` directory.
- `src/pi-session/bundle.ts` loads a composed `bundle.json`, imports bundled extension factories, builds hook extensions, reads context files, and loads skills for direct SDK sessions.
- `src/pi-session/pi-session.ts` implements `UnifiedSession` around `@mariozechner/pi-coding-agent`, including auth/model/session setup, prompt dispatch, event subscription, hook event emission, metadata, and Pi-to-unified event/content mapping.
- `src/pi-session/permission-hook.ts` creates a Pi SDK extension that bridges `tool_call` events to either a `PermissionHandler` or a `PiHookEventBusAdapter`.
- `src/pi-session/types.ts` defines Pi session state, config, start options, event, and hook bus types.
- `src/pi-sdk/pi-sdk/runner.ts` is a bundled runner entrypoint that parses adapter-built arguments, loads the Pi SDK, loads bundle extensions/hooks/skills/context, creates an agent session, and runs either interactive or print mode.
- `src/adapters/pi-sdk-adapter.test.ts` covers target composition, run argument model defaults/custom values, and model ID format regression checks.
- `src/pi-session/pi-session.getMetadata.test.ts` covers `PiSession.getMetadata`.
- `package.json` defines the package name, export map, scripts, and dependencies.
- `tsconfig.json` extends the repo config, emits `dist`, and excludes tests from package builds.

## Dependencies

Production dependencies from `package.json`:

- `@mariozechner/pi-coding-agent`: Pi SDK session creation, model/auth storage, extension APIs, skill loading, interactive mode, and print mode.
- `spaces-config`: harness adapter contracts, materialization/compose types, `AspError`, instruction constants, hook parsing, copy/link helpers, and lock warning types.
- `spaces-runtime`: `UnifiedSession`, session registries, session metadata/event/content types, and permission handler types.

Runtime platform dependencies:

- Node built-ins: `node:child_process`, `node:fs`, `node:fs/promises`, `node:os`, `node:path`, and `node:url`.
- Bun APIs: `Bun.spawn` for extension bundling and `bun test` for tests.
- Optional environment/config paths: `ASP_PI_SDK_ROOT`, `PI_CODING_AGENT_DIR`, and `~/.pi/agent/{auth.json,oauth.json,models.json}`.

Test/dev dependencies:

- `bun:test`
- `@types/bun`
- `typescript`

## Test coverage

The package has 2 test files with 11 test cases:

- `src/adapters/pi-sdk-adapter.test.ts`: 5 tests covering `composeTarget` extension/context ordering, default and custom `buildRunArgs` model values, and slash-separated `openai-codex/...` model ID regression checks.
- `src/pi-session/pi-session.getMetadata.test.ts`: 6 tests covering metadata shape, capability flags, session identity, state, absent native identity and pid, and `lastActivityAt`.

Coverage gaps:

- `PiSdkAdapter.detect`, `materializeSpace`, `loadTargetBundle`, `getRunEnv`, hook manifest generation, settings generation, auth symlink creation, `bundleExtension`, and `discoverExtensions` are not directly tested.
- `src/pi-sdk/pi-sdk/runner.ts` has no direct tests, including argument parsing, bundle loading, hook extension loading, skill/context loading, print mode invocation, and model parsing.
- `loadPiSdkBundle` in `src/pi-session/bundle.ts` is not directly tested, even though it is an observed runtime entrypoint for `packages/agent-spaces/src/client.ts`.
- `PiSession.start`, `sendPrompt`, `stop`, event mapping, hook emission, auth path selection, model selection, and permission integration are not tested.
- `register` and `createPermissionHook` have no direct tests.

Manual smoke test run during this sweep:

- `bun run --filter spaces-harness-pi-sdk test`: 11 pass, 0 fail.

## Recommended refactors and reductions

1. Fix and centralize Pi SDK model ID parsing. `PiSdkAdapter.models` and `buildRunArgs` pass slash-form model IDs such as `openai-codex/gpt-5.5` (`src/adapters/pi-sdk-adapter.ts`), but the standalone runner still parses `args.model` with `split(':')` and throws `Model must be specified as provider:model` (`src/pi-sdk/pi-sdk/runner.ts`). Move model parsing into one helper used by both the adapter/session path and runner, then add a runner-level regression test for the default slash-form model.

2. Remove the duplicated bundle/hook loader implementation between `src/pi-session/bundle.ts` and `src/pi-sdk/pi-sdk/runner.ts`. Both files define the same bundle manifest shapes, `loadBundle`, `resolveHookScriptPath`, `runHookScript`, and hook extension event wiring. Extract shared bundle loading and hook extension construction into a module that both direct sessions and the standalone runner can use.

3. Either wire or remove unused `PiSessionConfig` and `PiSessionStartOptions` fields. `src/pi-session/types.ts` accepts `systemPrompt`, `additionalExtensionPaths`, `extensions`, `skills`, and `contextFiles`, and `PiSessionStartOptions` accepts `skills`, `extensions`, and `contextFiles`, but `PiSession.start` only reads `agentDir`, `globalAgentDir`, auth/model/session settings, and never passes those extension/skill/context/system-prompt values into `createAgentSession`. That creates a public contract that appears supported but is currently ignored.

4. Split `src/adapters/pi-sdk-adapter.ts` by responsibility. At 704 lines, it mixes SDK detection, extension bundling, materialization, target composition, hook path resolution, auth/settings generation, run-argument construction, bundle reloading, and environment generation. Extracting hook/context composition and runner argument construction would reduce the adapter to harness-contract orchestration and make the untested paths easier to cover.

5. Replace repeated bundle manifest type definitions with one shared exported type source. `PiSdkBundleManifest`, extension entries, context entries, and hook entries are separately declared in `src/adapters/pi-sdk-adapter.ts`, `src/pi-session/bundle.ts`, and `src/pi-sdk/pi-sdk/runner.ts`. A shared `src/pi-session/bundle-types.ts` or equivalent would prevent drift between the manifest writer, direct loader, and standalone runner.
