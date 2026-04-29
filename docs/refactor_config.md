# Refactor Notes: config

## Purpose

`packages/config` is the config-time library published as `spaces-config`. It owns Agent Spaces manifest parsing, schema validation, target resolution, lock generation, git-backed space reads, content-addressed snapshot/cache paths, materialization helpers, lint rules, and high-level orchestration used by the CLI and execution package before a harness process is launched.

## Public surface

The package exports ESM entry points from `package.json`: `spaces-config`, `spaces-config/core`, `spaces-config/git`, `spaces-config/resolver`, `spaces-config/store`, `spaces-config/materializer`, `spaces-config/lint`, and `spaces-config/schemas/*`. There are no HTTP routes and no direct CLI commands in this package; CLI-facing workflows are exported as library calls from `src/orchestration/index.ts` and wrapped by `packages/execution` and `packages/cli`.

The root `src/index.ts` re-exports core types and helpers; a `git` namespace plus common git helpers such as `gitExec`, `showFile`, `extractTree`, `cloneRepo`, `getStatus`, `createTag`, `commit`, and `add`; a `resolver` namespace plus resolver helpers such as `parseSpaceRef`, `resolveSpaceRef`, `computeClosure`, `generateLockFileForTarget`, `resolvePlacement`, `resolveSpaceComposition`, and `validateAgentRoot`; store helpers; materializer helpers; lint helpers as `lintSpaces`, `formatLintText`, and `formatLintJson`; and orchestration APIs `resolveTarget`, `install`, `materializeFromRefs`, `build`, and `explain`.

Important submodule surfaces are:

- `src/core/index.ts`: branded refs, manifest/lock/target types, JSON schema validators, `parseSpaceToml`, `parseTargetsToml`, `parseAgentProfile`, `validateTarget`, error classes, `withProjectLock`, model constants, and atomic file helpers.
- `src/git/index.ts`: safe argv-based git execution, tags, show/tree/archive operations, and repository mutations/status helpers.
- `src/resolver/index.ts`: ref parsing, dist-tag and semver resolution, closure computation, integrity hashing, lock generation, structural validators, root-relative ref resolution, space composition, placement resolution, and agent-root validation.
- `src/store/index.ts`: `ASP_HOME` path resolution, agent placement paths, snapshots, plugin cache, and garbage collection.
- `src/materializer/index.ts`: plugin JSON generation, component linking, legacy hooks JSON validation, canonical `hooks.toml`, MCP/settings composition, canonical `permissions.toml`, and legacy plugin materialization.
- `src/lint/index.ts`: lint warning types/reporters and rules W201-W207 plus E208.
- `src/orchestration/index.ts`: high-level resolve/install/materialize/build/explain workflows.

## Internal structure

`src/core` is the foundation layer. `core/types` defines branded refs, space manifests, project targets, locks, harness catalog types, placement types, and agent-profile types. `core/config` parses `space.toml`, `asp-targets.toml`, `agent-profile.toml`, lock JSON, and `asp_modules` paths. `core/schemas` compiles AJV validators from JSON schema files. `core/merge` merges agent profile and project target settings. `core/errors`, `core/locks`, and `core/atomic` provide common operational primitives.

`src/git` wraps system `git` through `spawn` and small typed helpers for tags, repository status/mutations, file reads, tree listing, and archive extraction. `src/resolver` turns refs into locked space graphs: `selector.ts`, `git-tags.ts`, and `dist-tags.ts` resolve versions; `manifest.ts` reads `space.toml`; `closure.ts` computes dependency order and enforces local-space edge rules; `integrity.ts` hashes content; `lock-generator.ts` builds lock files; `placement-resolver.ts`, `space-composition.ts`, and `root-relative-refs.ts` handle agent/project placement.

`src/store` manages `ASP_HOME` layout, project marker discovery, snapshots, plugin cache metadata, and GC. `src/materializer` links snapshot components into plugin artifacts, translates hooks and permissions, composes MCP/settings output, and still contains the older Claude-oriented `materializeSpace` pipeline. `src/lint` reads materialized plugin directories and emits command, hook, plugin, structure, and skill-frontmatter warnings. `src/orchestration` wires the layers together for resolve, install, build, materialize-from-refs, and explain workflows. `src/__fixtures__` and `src/test-support` hold v2 placement fixtures.

## Dependencies

Production dependencies from `package.json` are `@iarna/toml` for TOML parsing and serialization, `ajv` plus `ajv-formats` for JSON schema validation, `proper-lockfile` for project/store locks, and `semver` for version selector resolution. Runtime also shells out to system `git` and `tar` through Node `child_process`, so those binaries are operational dependencies even though they are not npm packages.

Test/dev dependencies are `@types/proper-lockfile`, `@types/semver`, `@types/bun`, and `typescript`. Tests use Bun's built-in test runner, Node filesystem/tempdir APIs, and local fixtures under `src/__fixtures__/v2`.

## Test coverage

There are 51 `*.test.ts` files under `src`, covering parser/schema behavior, refs, harness types, locks, atomic writes, git exec/repo/tree helpers, resolver closure/integrity/lock generation/validation, store paths/cache/snapshot/GC, materializer hooks/MCP/permissions/plugin/linking, lint rules/reporting, orchestration install/materialize-from-refs/default manifest loading, and placement/profile fixtures.

Notable gaps: `src/orchestration/build.ts` has no package-local test despite being exported and used through `packages/execution`; `src/orchestration/explain.ts` has no direct test despite its broad formatter/content-reading behavior; `src/store/cache.test.ts` only covers `computePluginCacheKey` and does not cover `computeHarnessPluginCacheKey`; `src/git/archive.ts` has no direct test for the `git archive | tar` pipeline; and `src/resolver/placement-resolver.ts` is covered indirectly by placement fixture tests but its sync file-loading helpers are not isolated.

## Recommended Refactors and Reductions

1. Use the harness-aware cache key in the install path. `src/store/cache.ts` defines `computeHarnessPluginCacheKey` specifically to include harness ID/version, but `src/orchestration/install.ts` still imports and calls `computePluginCacheKey` when materializing through harness adapters. That can reuse the same cache directory for Claude, Pi, and Codex transforms of the same space. Switch `materializeTarget` to a harness-aware key and add tests beside `src/store/cache.test.ts` and `src/orchestration/install.test.ts`.

2. Bring `build` onto the adapter path or retire the legacy materializer path. `src/orchestration/build.ts` accepts `harness` and `adapter`, and `packages/execution/src/index.ts` resolves an adapter before calling it, but `build` ignores `options.adapter` and calls `materializeSpaces` from `src/materializer/materialize.ts`, which generates Claude hooks and uses the legacy cache key. This overlaps with the newer adapter-driven `install.materializeTarget` path and makes non-Claude builds easy to mis-materialize.

3. Reduce duplicated TOML parsing in placement resolution. `src/resolver/placement-resolver.ts` reads `agent-profile.toml` three different ways: `loadAgentProfile` uses `parseAgentProfile`, `loadAgentDefaultSpaces` parses TOML directly, and `loadProfileTargets` uses CommonJS `require('@iarna/toml')` inside an ESM file. It also partially parses `asp-targets.toml` in `loadProjectTargetOptional` before validating with `parseTargetsToml`. Route these helpers through `parseAgentProfile` and `parseTargetsToml` so unknown keys and schema-version behavior stay consistent.

4. Consolidate filesystem component scanning. Similar helper logic appears in `src/orchestration/materialize-refs.ts` (`discoverSkills`, `detectCommandConflicts`, `findSkillFiles`), `src/orchestration/explain.ts` (`listComponentFiles`, `listSkills`, `getAvailableComponents`), and lint rules W201/W202/E208. A shared component scanner would remove duplicated `readdir`/`stat` walks and keep command/skill naming rules consistent across lint, explain, and runtime materialization.

5. Clarify the two validator surfaces. `src/core/schemas/index.ts` exports AJV validators named `validateSpaceManifest`, `validateProjectManifest`, and `validateLockFile`, while `src/resolver/validator.ts` exports structural validators with the same names but different return shapes and error codes. The root export avoids direct conflicts by exporting resolver as a namespace, but submodule users can easily pick the wrong one. Rename or namespace the structural validators, for example `validateResolvedSpaceManifest` or `validateClosureLockFile`.

6. Make lock harness entries reflect the selected harnesses. `src/resolver/lock-generator.ts` hard-codes `DEFAULT_HARNESSES = ['claude']` and writes only a Claude harness entry even though `core/types/harness.ts` defines Claude, Claude SDK, Pi, Pi SDK, and Codex and install/build accept `HarnessId`. Either pass requested harness IDs into lock generation or remove the stale per-harness field until it is populated by the selected harness path.

7. Shrink the broad explain module. `src/orchestration/explain.ts` is 825 lines and mixes lock reading, snapshot probing, hooks/MCP/settings extraction, component scanning, lint execution, result shaping, and text/JSON formatting. Split content readers and formatters out of the orchestration entry point so `explain()` can be tested as data assembly and `formatExplainText()` can be tested independently.

8. Deprecate or hide old store/materializer names more aggressively. `src/store/paths.ts` still exports deprecated `getStorePath` and `PathResolver.store` aliases for snapshots, and `src/materializer/materialize.ts` remains publicly exported while adapter materialization is the main path. If external compatibility permits, move these behind a legacy namespace or document a removal target; otherwise they will keep attracting new callers.
