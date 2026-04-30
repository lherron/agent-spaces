# Refactor Notes: harness-pi

## Purpose

`packages/harness-pi` implements the Pi CLI harness adapter for Agent Spaces. It detects a local Pi binary, materializes space snapshots into Pi-compatible artifacts, composes ordered artifacts into an `asp_modules/<target>/pi` bundle, generates bridge extensions for ASP hooks and HRC runtime events, builds Pi CLI arguments and environment variables, and registers the adapter with the runtime harness registry.

## Public surface

The package is published as `spaces-harness-pi` with one package export, `spaces-harness-pi`, resolved from `src/index.ts`.

Exported symbols from `src/index.ts`:

- `PiAdapter`
- `piAdapter`
- `detectPi`
- `clearPiCache`
- `findPiBinary`
- `bundleExtension`
- `discoverExtensions`
- `generateHookBridgeCode`
- `PiInfo`
- `ExtensionBuildOptions`
- `HookDefinition`
- `register`

Additional exported symbols in `src/adapters/pi-adapter.ts` that are not re-exported by the package barrel:

- `PiNotFoundError`
- `PiBundleError`
- `generateHrcEventsBridgeCode`

No HTTP routes or package-owned CLI commands are defined here. The user-facing CLI behavior is exposed through `PiAdapter` methods, especially `detect`, `materializeSpace`, `composeTarget`, `buildRunArgs`, `loadTargetBundle`, `getRunEnv`, and `getTargetOutputPath`.

Observed consumers:

- `packages/execution/src/harness/index.ts` re-exports Pi adapter utilities from `spaces-harness-pi` and calls `registerPi({ harnesses, sessions })`.
- `packages/execution/package.json`, `packages/cli/package.json`, and CLI prepack/postpack scripts include `spaces-harness-pi` as a workspace dependency or bundled package.
- `integration-tests/tests/harness.test.ts` covers `asp ... --harness pi --dry-run` at the integration layer.

## Internal structure

- `src/index.ts` is the public barrel for the adapter, helper utilities, bridge-generation API, and `register`.
- `src/register.ts` registers the singleton `piAdapter` with a `HarnessRegistry`; it accepts a `SessionRegistry` but does not register Pi sessions.
- `src/adapters/pi-adapter.ts` contains the whole implementation: Pi binary discovery, version/capability probing, extension bundling through `bun build`, extension discovery, hook script resolution, generated hook bridge code, generated HRC events bridge code, the `PiAdapter` class, target materialization and composition, lint-only permission warning collection, Pi run argument generation, bundle reloading, and run environment generation.
- `src/adapters/pi-adapter.test.ts` is the full package test suite, covering the adapter contract, detection helpers, bundling helpers, extension discovery, generated hook bridge code, run-argument construction, and error classes.
- `package.json` defines the package name, export map, build/typecheck/test scripts, and workspace dependencies.
- `tsconfig.json` extends the repo TypeScript config, emits `dist`, and excludes tests from package builds.

## Dependencies

Production dependencies from `package.json`:

- `spaces-config`: provides harness adapter contracts, compose/materialize types, model translation, warning codes, permissions conversion, hooks parsing, instruction linking, and copy/link helpers.
- `spaces-runtime`: provides `HarnessRegistry` and `SessionRegistry` types used by `register`.

Runtime platform dependencies:

- Node built-ins: `node:fs`, `node:fs/promises`, `node:os`, and `node:path`.
- Bun APIs: `Bun.spawn` for Pi detection and extension bundling, `Bun.file` in tests.
- External executables: `pi` or `PI_PATH` for detection, and `bun build` for extension bundling.

Test/dev dependencies:

- `bun:test`
- `@types/bun`
- `typescript`

## Test coverage

The package has 1 test file with 78 test cases:

- `src/adapters/pi-adapter.test.ts`: adapter identity, Pi detection, `validateSpace`, materialization of extensions/skills/hooks/scripts/permissions/instructions, target composition, hook bridge path rewriting, HRC events bridge generation, `buildRunArgs`, target output paths, binary lookup errors, extension bundling, extension discovery, hook bridge generation, and error classes.

Coverage gaps:

- `PiAdapter.loadTargetBundle` is not directly tested, including how it handles missing `extensions`, `skills`, `asp-hooks.bridge.js`, and `asp-hrc-events.bridge.js` files.
- `composeTarget` does not assert the generated `settings.json` contents from `inheritUser` and `inheritProject`, or the optional symlink from `~/.pi/agent/auth.json` to bundle-local `auth.json`.
- `generateHrcEventsBridgeCode` is only tested through substring checks on composed output; there is no focused test for the `session_start` special case that forwards `sessionId` and `sessionFile`.
- `buildRunArgs` does not cover missing `extensionsDir` behavior even though it calls `readdirSync(extensionsDir)` synchronously.
- `register` has no direct test proving it registers exactly `piAdapter` and intentionally does not register a session factory.

## Recommended refactors and reductions

1. Split `src/adapters/pi-adapter.ts` by responsibility. At 1,336 lines, it mixes binary detection (`findPiBinary`, `detectPi`), bundling (`bundleExtension`, `discoverExtensions`), bridge generation (`generateHookBridgeCode`, `generateHrcEventsBridgeCode`), artifact composition (`materializeSpace`, `composeTarget`), and runtime invocation (`buildRunArgs`, `getRunEnv`). Extracting detection, extension bundling, bridge generation, and argument construction would leave `PiAdapter` as the harness-contract coordinator and make each behavior easier to test independently.

2. Move generated bridge templates out of `pi-adapter.ts`. `generateHookBridgeCode` and `generateHrcEventsBridgeCode` build long JavaScript strings inline in `src/adapters/pi-adapter.ts`; the hook bridge alone spans event mapping, shell spawning, payload serialization, logging, and `pi.sendMessage` formatting. Extracting bridge generation into `src/adapters/pi-bridge-templates.ts` or equivalent would reduce the adapter file and isolate template-specific tests around event mapping and emitted code.

3. Remove the unused `_PI_COMPONENT_DIRS` constant in `src/adapters/pi-adapter.ts`. It is declared as `['extensions', 'skills', 'hooks', 'scripts', 'shared']` but is never read anywhere in the package, so it currently adds a misleading inventory of supported directories without enforcing or documenting behavior.

4. Consolidate repeated compose-test input construction in `src/adapters/pi-adapter.test.ts`. The `composeTarget` tests repeatedly inline the same `targetName`, `compose`, `roots`, `loadOrder`, `artifacts`, and `settingsInputs` object shapes across the extension, skills, hooks, warnings, and bridge tests. A small `createComposeInput(...)` helper would reduce duplicated setup while preserving the specific file fixtures each test needs.

5. Clarify the `register` surface in `src/register.ts`. The function accepts both `HarnessRegistry` and `SessionRegistry`, but only calls `reg.harnesses.register(piAdapter)`. Since `packages/execution/src/harness/index.ts` uses this function and no Pi session factory is registered here, either narrow the signature to the registry it actually uses or add a comment/test that the unused `sessions` parameter is intentional for parity with other harness `register` functions.
