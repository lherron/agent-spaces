# Agent Spaces v2 Implementation Plan

## Current Status

**Completed**: 100% (all 9 packages + manager space + integration tests)

### Packages Status

| Package | Status | Notes |
|---------|--------|-------|
| core | COMPLETE | Types, schemas, config parsers, errors, locks, atomic ops |
| git | COMPLETE | exec (safe git command execution), tags (tag operations for versioning), show (file content at commit), tree (ls-tree for integrity hashing), archive (extraction), repo (clone/fetch/status operations) |
| claude | COMPLETE | detect (find binary, query version, detect flags), invoke (safe subprocess with plugin-dir and mcp-config flags), validate (plugin validation) |
| resolver | COMPLETE | ref-parser, dist-tags, git-tags, selector (resolution), closure (DFS postorder), integrity, lock-generator, validator |
| store | COMPLETE | paths (ASP_HOME), snapshot (extraction/storage), cache (plugin cache), gc (garbage collection) |
| materializer | COMPLETE | plugin-json, link-components, hooks-builder, mcp-composer, materialize orchestration |
| lint | COMPLETE | W201-W206 rules, reporter, 30 tests |
| engine | COMPLETE | resolve, install, build, run, explain orchestration |
| cli | COMPLETE | All commands implemented: run, install, build, explain, lint, list, doctor, gc, add, remove, upgrade, diff, repo/* |
| manager-space | COMPLETE | space.toml, 8 commands, 1 skill, 1 agent |
| integration-tests | COMPLETE | 27 passing tests, 0 skipped |

---

## Priority 1: Foundation (Blocks Everything)

### packages/git - Git Operations Wrapper (COMPLETE)
- [x] `src/exec.ts` - Safe exec helper using argv arrays (no shell interpolation)
- [x] `src/tags.ts` - List tags matching pattern, create immutable semver tags
- [x] `src/show.ts` - Read file contents at specific commit (`git show`)
- [x] `src/archive.ts` - Extract directory tree at commit
- [x] `src/tree.ts` - List tree entries (path, mode, blob OID) for integrity hashing
- [x] `src/repo.ts` - Clone, fetch, init, status, remote operations
- [x] `src/index.ts` - Public exports
- [x] `package.json` - Package setup
- [x] Unit tests for all operations

### packages/claude - Claude CLI Wrapper (COMPLETE)
- [x] `src/detect.ts` - Find claude binary, query version, detect supported flags
- [x] `src/invoke.ts` - Spawn claude safely using argv array (no shell)
- [x] `src/validate.ts` - Optional plugin validation (if Claude supports it)
- [x] `src/index.ts` - Public exports
- [x] `package.json` - Package setup
- [x] Support `ASP_CLAUDE_PATH` env override for testing

---

## Priority 2: Resolution Engine (COMPLETE)

### packages/resolver - Space Resolution (COMPLETE)
- [x] `src/ref-parser.ts` - Parse `space:<id>@<selector>` (wraps core functions)
- [x] `src/dist-tags.ts` - Read committed `registry/dist-tags.json` for channel resolution
- [x] `src/git-tags.ts` - Query git tags for semver resolution (`space/<id>/v*`)
- [x] `src/selector.ts` - Resolve dist-tag, semver range, or git pin to commit SHA
- [x] `src/manifest.ts` - Read space.toml from git at specific commits
- [x] `src/closure.ts` - Dependency closure via ordered DFS postorder traversal
- [x] `src/integrity.ts` - Compute content integrity and env hashes
- [x] `src/lock-generator.ts` - Generate/update `asp-lock.json`
- [x] `src/validator.ts` - Cycle detection, missing deps, invalid refs (ERRORS only)
- [x] `src/index.ts` - Public exports
- [x] `package.json` - Package setup with semver dependency
- [x] Unit tests for resolution algorithm (48 tests)
- Note: closure.ts has comprehensive unit tests (17 tests for cycle detection, diamond dependencies, DFS postorder, and helper functions)

---

## Priority 3: Content-Addressed Storage (COMPLETE)

### packages/store - Space Snapshots (COMPLETE)
- [x] `src/paths.ts` - ASP_HOME resolution, path builders for store/cache/repo, PathResolver class
- [x] `src/snapshot.ts` - Extract space at commit into store with metadata, verify integrity
- [x] `src/cache.ts` - Plugin cache management, cache key computation, pruning
- [x] `src/gc.ts` - Garbage collection for store and cache based on lock file reachability
- [x] `src/index.ts` - Public exports
- [x] `package.json` - Package setup
- [x] Unit tests for paths, cache, and gc (22 tests)
- Note: Integrity hashing is in resolver package; store uses it for verification

---

## Priority 4: Plugin Materialization (COMPLETE)

### packages/materializer - Plugin Directory Generation (COMPLETE)
- [x] `src/plugin-json.ts` - Generate `.claude-plugin/plugin.json` from space manifest
- [x] `src/link-components.ts` - Hardlink components (commands, skills, agents, hooks, scripts, mcp)
- [x] `src/hooks-builder.ts` - Validate hooks.json, ensure scripts executable
- [x] `src/mcp-composer.ts` - Compose MCP config from spaces with collision detection
- [x] `src/materialize.ts` - Orchestration with cache support
- [x] `src/index.ts` - Public exports
- [x] `package.json` - Package setup
- [x] Unit tests for materialization (19 tests)
- Note: Cache management reuses store package; copy fallback via core's linkOrCopy

---

## Priority 5: Linting Rules (COMPLETE)

### packages/lint - Warning Detection (COMPLETE)
- [x] `src/rules/W201-command-collision.ts` - Same command in multiple spaces
- [x] `src/rules/W202-agent-command-namespace.ts` - Agent doc references unqualified `/command` provided by plugin space
- [x] `src/rules/W203-hook-path-no-plugin-root.ts` - Hook path missing `${CLAUDE_PLUGIN_ROOT}`
- [x] `src/rules/W204-invalid-hooks-config.ts` - hooks/ exists but hooks.json missing/invalid
- [x] `src/rules/W205-plugin-name-collision.ts` - Two spaces produce same plugin name
- [x] `src/rules/W206-non-executable-hook-script.ts` - Hook script not executable
- [x] `src/rules/W207-invalid-plugin-structure.ts` - Component directories nested inside .claude-plugin/
- [x] `src/reporter.ts` - Warning output formatter
- [x] `src/index.ts` - Public exports
- [x] `package.json` - Package setup
- [x] Unit tests for each rule (44 tests)

---

## Priority 6: Orchestration Engine (COMPLETE)

### packages/engine - High-Level Orchestration (COMPLETE)
- [x] `src/resolve.ts` - High-level resolution entrypoints (resolveTarget, resolveTargets, loadProjectManifest, loadLockFileIfExists, getRegistryPath, getSpacesInOrder)
- [x] `src/install.ts` - Lock/store orchestration (install, installNeeded, ensureRegistry, populateStore, writeLockFile)
- [x] `src/build.ts` - Materialization orchestration (build, buildAll with lint integration)
- [x] `src/run.ts` - Claude launch orchestration (run, runWithPrompt, runInteractive)
- [x] `src/explain.ts` - Debug/explain output (explain, formatExplainText, formatExplainJson)
- [x] `src/index.ts` - Public exports
- [x] `package.json` - Package setup
- [x] Integration tests via integration-tests/

---

## Priority 7: CLI Commands (COMPLETE)

### packages/cli - Command Line Interface (COMPLETE)
**Priority A - Core Commands**:
- [x] `src/index.ts` - Entry point, Commander.js setup
- [x] `src/commands/run.ts` - Run target/space/path (most critical)
- [x] `src/commands/install.ts` - Generate/update lock + populate store
- [x] `src/commands/build.ts` - Materialize without launching Claude

**Priority B - Management Commands**:
- [x] `src/commands/explain.ts` - Print resolved graph, pins, load order, warnings
- [x] `src/commands/add.ts` - Add space ref to target in asp-targets.toml
- [x] `src/commands/remove.ts` - Remove space from target
- [x] `src/commands/upgrade.ts` - Update lock pins per selectors

**Priority C - Utility Commands**:
- [x] `src/commands/diff.ts` - Show pending lock changes without writing
- [x] `src/commands/lint.ts` - Validate targets/spaces, emit warnings (includes W301 lock-missing info)
- [x] `src/commands/list.ts` - List targets, resolved spaces, cached envs
- [x] `src/commands/doctor.ts` - Check claude, registry, cache permissions, registry remote reachability
- [x] `src/commands/gc.ts` - Prune store/cache based on reachability

**Priority D - Repo Commands**:
- [x] `src/commands/repo/init.ts` - Create/clone registry, install manager space
- [x] `src/commands/repo/status.ts` - Show registry repo status
- [x] `src/commands/repo/publish.ts` - Create git tag, update dist-tags.json
- [x] `src/commands/repo/tags.ts` - List tags for a space

- [x] `package.json` - Package setup with bin entry
- [x] Integration tests via integration-tests/

---

## Priority 8: Manager Space (COMPLETE)

### spaces/agent-spaces-manager - Built-in Management Space (COMPLETE)
- [x] `space.toml` - Space manifest with id, version, description, plugin metadata
- [x] `commands/help.md` - Show available asp commands and manager space commands
- [x] `commands/create-space.md` - Scaffold new space with correct layout
- [x] `commands/add-skill.md` - Add skill with best-practice template
- [x] `commands/add-command.md` - Add command with template
- [x] `commands/add-hook.md` - Add hook with validation, ${CLAUDE_PLUGIN_ROOT} guidance
- [x] `commands/bump-version.md` - Update version in space.toml (major/minor/patch)
- [x] `commands/publish.md` - Run asp repo publish with dist-tag support
- [x] `commands/update-project-targets.md` - Help update project asp-targets.toml
- [x] `skills/space-authoring/SKILL.md` - Comprehensive guide for creating spaces
- [x] `agents/manager.md` - Coordinator agent for repo + project workflows

---

## Priority 9: Integration Tests (COMPLETE)

### integration-tests/ - End-to-End Testing (COMPLETE)
- [x] `fixtures/sample-registry/` - Mock git registry with spaces + dist-tags.json
- [x] `fixtures/sample-project/` - Mock project with asp-targets.toml
- [x] `fixtures/claude-shim/` - Test shim for Claude (records argv, validates plugins)
- [x] `tests/install.test.ts` - Test resolution + lock generation (6 tests)
- [x] `tests/build.test.ts` - Test materialization without Claude (6 tests)
- [x] `tests/run.test.ts` - Test asp run with claude shim (5 tests)
- [x] `tests/lint.test.ts` - Test warning detection (3 tests)
- [x] `tests/repo.test.ts` - Test repo commands (8 tests): repo init, repo publish, repo status, and repo tags
- [x] `tests/management.test.ts` - Test add, remove, upgrade commands (8 tests)
- [x] `tests/utility.test.ts` - Test diff, explain, list, doctor, gc commands (18 tests)

**Test Summary**: 54 passing integration tests, 0 skipped

---

## Bug Fixes Applied

- Engine path handling in resolve.ts, build.ts, explain.ts
- Core package test linting and type assertions
- W202 lint rule assignment-in-expression and gc.test.ts SHA format
- CLI entry point (bin/asp.js) to properly call main()
- Added comprehensive closure.test.ts for cycle detection and DFS postorder verification

---

## Bug Fixes Applied (v0.0.27)

- Added W301 "lock-missing" warning code per spec
- Added W205 plugin name collision warnings to lock file generation
- Lock files now include warnings in targetEntry per spec
- Added lock-generator.test.ts with 3 tests for W205 warnings
- Added W301 integration test in build.test.ts

---

## Features Added (v0.0.29)

### Global Mode for `asp run`
- **Syntax**: `asp run space:id@selector`
- Run spaces directly from the registry without requiring a project
- Creates an ephemeral target, resolves dependencies, and launches Claude
- Useful for quickly trying out spaces or running standalone tools

### Dev Mode for `asp run`
- **Syntax**: `asp run ./path/to/space`
- Run local space directories directly for development and testing
- Bypasses registry resolution to use the space from the local filesystem
- Enables rapid iteration when authoring new spaces

---

## Known Issues

### Lint Configuration
- Biome's `useLiteralKeys` rule is disabled to avoid conflicts with TypeScript strict mode
- Lint status: 0 errors, 67 warnings remaining
- Warnings are acceptable complexity warnings and noNonNullAssertion warnings

### Integration Test Issues
- All integration tests passing. Previously skipped "exits with claude exit code" test is now fixed by adding `env` option to RunOptions to pass env vars to subprocess.

### Version Tags
- Current git tag is `v0.0.29`

### Test Coverage
- Total tests: 469 passing (415 package tests + 54 integration tests)
- Added tests for critical modules: atomic.ts (26), locks.ts (18), snapshot.ts (18), invoke.ts (21)
- Added config parser tests: lock-json.ts (39), space-toml.ts (33), targets-toml.ts (30)
- Fixed proper-lockfile error handling in locks.ts

### Outstanding TODOs
- [x] `packages/cli/src/commands/upgrade.ts` - Filter space by ID in upgrade command (implemented via `pinnedSpaces` in resolver and `upgradeSpaceIds` in engine)
- [x] `packages/core/src/index.test.ts` - Unit tests for core modules (60 tests for refs and errors)
- [x] Added tests for core/atomic.ts, core/locks.ts, store/snapshot.ts, claude/invoke.ts
- [x] Added tests for core config parsers: lock-json.ts, space-toml.ts, targets-toml.ts
- [x] W301 lock-missing warning implemented
- [x] Warnings now stored in lock file during resolution (W205)
- [x] CLI commands integration tests: add, remove, upgrade, diff, explain, list, doctor, gc (26 new tests)

---

## Implementation Notes

### Key Algorithms

**Dependency Closure (DFS Postorder)**:
```
visit(space):
  if visited: return
  mark visited
  for dep in space.deps.spaces (declared order):
    resolve dep -> spaceKey
    visit(resolved)
  append(space) to loadOrder

for root in compose (order):
  resolve root -> spaceKey
  visit(resolved)

return loadOrder
```

**Integrity Hash**:
```
sha256("v1\0" + for each entry (sorted by path):
  path + "\0" + kind + "\0" + perEntryHash + "\0" + mode + "\n")
```

**Environment Hash**:
```
sha256("env-v1\0" + for each spaceKey in loadOrder:
  spaceKey + "\0" + integrity + "\0" + pluginName + "\n")
```

**Plugin Cache Key**:
```
sha256("materializer-v1\0" + spaceIntegrity + "\0" + pluginName + "\0" + pluginVersion + "\n")
```

### Runtime Contract

```bash
asp run <target>
# becomes:
claude --plugin-dir <space1> --plugin-dir <space2> ... [--mcp-config <path>]
```

### Environment Variables

- `ASP_HOME` - Override default `~/.asp` location
- `ASP_CLAUDE_PATH` - Override claude binary location (for testing)
- `RUN_REAL_CLAUDE` - Enable real Claude integration tests

---

## Verification Checklist

After implementation, verify end-to-end.

**Note**: All items below are implemented and working. Items marked with [ ] require manual end-to-end verification by a human to confirm real-world behavior. Items marked with [x] have been verified via integration tests.

1. [x] `asp install` - Generates asp-lock.json (verified via integration tests)
2. [ ] `asp repo init` - Creates ~/.asp/repo, installs manager space
3. [ ] Create and publish a space with `asp repo publish`
4. [ ] Create project with asp-targets.toml
5. [x] `asp add/remove` - Modify targets (verified via integration tests in management.test.ts)
6. [x] `asp run <target>` - Launches Claude with correct plugins (verified via integration tests with claude shim)
7. [x] `asp build <target> --output ./plugins` - Materializes without Claude (verified via integration tests)
8. [x] `asp explain <target>` - Shows load order, pins, warnings (verified via integration tests in utility.test.ts)
9. [x] `asp lint` - Detects collisions and issues (verified via integration tests)
10. [x] `asp gc` - Prunes unreferenced cache entries (verified via integration tests in utility.test.ts)
11. [x] `asp upgrade` - Updates lock file (verified via integration tests in management.test.ts)
12. [x] `asp diff` - Shows pending lock changes (verified via integration tests in utility.test.ts)
13. [x] `asp list` - Lists targets (verified via integration tests in utility.test.ts)
14. [x] `asp doctor` - Health checks (verified via integration tests in utility.test.ts)
