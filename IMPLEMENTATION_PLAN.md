# Agent Spaces v2 Implementation Plan

## Current Status

**Completed**: ~55% (5 of 9 packages fully implemented)

### Packages Status

| Package | Status | Notes |
|---------|--------|-------|
| core | COMPLETE | Types, schemas, config parsers, errors, locks, atomic ops |
| git | COMPLETE | exec (safe git command execution), tags (tag operations for versioning), show (file content at commit), tree (ls-tree for integrity hashing), archive (extraction), repo (clone/fetch/status operations) |
| claude | COMPLETE | detect (find binary, query version, detect flags), invoke (safe subprocess with plugin-dir and mcp-config flags), validate (plugin validation) |
| resolver | COMPLETE | ref-parser, dist-tags, git-tags, selector (resolution), closure (DFS postorder), integrity, lock-generator, validator |
| store | COMPLETE | paths (ASP_HOME), snapshot (extraction/storage), cache (plugin cache), gc (garbage collection) |
| materializer | NOT STARTED | Blocks engine |
| engine | NOT STARTED | Blocks CLI |
| lint | NOT STARTED | Blocks engine, CLI |
| cli | NOT STARTED | Final integration layer |

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
- [x] Unit tests for resolution algorithm (31 tests)

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

## Priority 4: Plugin Materialization

### packages/materializer - Plugin Directory Generation
- [ ] `src/plugin-json.ts` - Generate `.claude-plugin/plugin.json` from space.toml
- [ ] `src/link-components.ts` - Hardlink components from store snapshot
- [ ] `src/copy-components.ts` - Fallback copier for cross-device scenarios
- [ ] `src/hooks-builder.ts` - Validate hooks.json, ensure scripts exist/executable
- [ ] `src/mcp-composer.ts` - Compose MCP config from spaces (passthrough only)
- [ ] `src/cache.ts` - Cache lookup by pluginCacheKey
- [ ] `src/index.ts` - Public exports
- [ ] `package.json` - Package setup
- [ ] Unit tests for materialization

---

## Priority 5: Linting Rules

### packages/lint - Warning Detection
- [ ] `src/rules/W201-command-collision.ts` - Same command in multiple spaces
- [ ] `src/rules/W203-hook-path-no-plugin-root.ts` - Hook path missing `${CLAUDE_PLUGIN_ROOT}`
- [ ] `src/rules/W204-invalid-hooks-config.ts` - hooks/ exists but hooks.json missing/invalid
- [ ] `src/rules/W205-plugin-name-collision.ts` - Two spaces produce same plugin name
- [ ] `src/rules/W206-non-executable-hook-script.ts` - Hook script not executable
- [ ] `src/reporter.ts` - Warning output formatter
- [ ] `src/index.ts` - Public exports
- [ ] `package.json` - Package setup
- [ ] Unit tests for each rule

---

## Priority 6: Orchestration Engine

### packages/engine - High-Level Orchestration
- [ ] `src/resolve.ts` - High-level resolution entrypoints
- [ ] `src/install.ts` - Lock/store orchestration (parse targets, resolve, write lock, populate store)
- [ ] `src/build.ts` - Materialization orchestration (resolve, materialize to output dir)
- [ ] `src/run.ts` - Claude launch orchestration (resolve, materialize, invoke claude)
- [ ] `src/explain.ts` - Debug/explain output (human + JSON modes)
- [ ] `src/index.ts` - Public exports
- [ ] `package.json` - Package setup
- [ ] Integration tests with mocked git/claude

---

## Priority 7: CLI Commands

### packages/cli - Command Line Interface
**Priority A - Core Commands**:
- [ ] `src/index.ts` - Entry point, Commander.js setup
- [ ] `src/commands/run.ts` - Run target/space/path (most critical)
- [ ] `src/commands/install.ts` - Generate/update lock + populate store
- [ ] `src/commands/build.ts` - Materialize without launching Claude

**Priority B - Management Commands**:
- [ ] `src/commands/explain.ts` - Print resolved graph, pins, load order, warnings
- [ ] `src/commands/add.ts` - Add space ref to target in asp-targets.toml
- [ ] `src/commands/remove.ts` - Remove space from target
- [ ] `src/commands/upgrade.ts` - Update lock pins per selectors

**Priority C - Utility Commands**:
- [ ] `src/commands/diff.ts` - Show pending lock changes without writing
- [ ] `src/commands/lint.ts` - Validate targets/spaces, emit warnings
- [ ] `src/commands/list.ts` - List targets, resolved spaces, cached envs
- [ ] `src/commands/doctor.ts` - Check claude, registry, cache permissions
- [ ] `src/commands/gc.ts` - Prune store/cache based on reachability

**Priority D - Repo Commands**:
- [ ] `src/commands/repo/init.ts` - Create/clone registry, install manager space
- [ ] `src/commands/repo/status.ts` - Show registry repo status
- [ ] `src/commands/repo/publish.ts` - Create git tag, update dist-tags.json
- [ ] `src/commands/repo/tags.ts` - List tags for a space

- [ ] `package.json` - Package setup with bin entry
- [ ] Integration tests for each command

---

## Priority 8: Manager Space

### spaces/agent-spaces-manager - Built-in Management Space
- [ ] `space.toml` - Space manifest
- [ ] `commands/help.md` - Show available asp commands
- [ ] `commands/create-space.md` - Scaffold new space with correct layout
- [ ] `commands/add-skill.md` - Add skill with best-practice template
- [ ] `commands/add-command.md` - Add command with template
- [ ] `commands/add-hook.md` - Add hook with validation
- [ ] `commands/bump-version.md` - Update version in space.toml
- [ ] `commands/publish.md` - Run asp repo publish
- [ ] `commands/update-project-targets.md` - Help update project asp-targets.toml
- [ ] `skills/space-authoring/SKILL.md` - Guide for creating spaces
- [ ] `agents/manager.md` - Coordinator agent for repo + project workflows

---

## Priority 9: Integration Tests

### integration-tests/ - End-to-End Testing
- [ ] `fixtures/sample-registry/` - Mock git registry with spaces + dist-tags.json
- [ ] `fixtures/sample-project/` - Mock project with asp-targets.toml
- [ ] `fixtures/claude-shim/` - Test shim for Claude (records argv, validates plugins)
- [ ] `tests/install.test.ts` - Test resolution + lock generation
- [ ] `tests/run.test.ts` - Test asp run with claude shim
- [ ] `tests/run-real-claude.test.ts` - Optional real Claude e2e (RUN_REAL_CLAUDE=1)
- [ ] `tests/build.test.ts` - Test materialization without Claude
- [ ] `tests/repo-init.test.ts` - Test repo initialization
- [ ] `tests/lint.test.ts` - Test warning detection

---

## Known Issues & TODOs to Investigate

- [ ] Search for TODO comments in existing code
- [ ] Verify all core package exports are correct
- [ ] Add unit tests for packages/core (currently missing)
- [ ] Verify schema validation covers all edge cases
- [ ] Consider W202 (agent-command-namespace) rule mentioned in spec but not in plan

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

After implementation, verify end-to-end:

1. [ ] `asp repo init` - Creates ~/.asp/repo, installs manager space
2. [ ] Create and publish a space with `asp repo publish`
3. [ ] Create project with asp-targets.toml
4. [ ] `asp install` - Generates asp-lock.json
5. [ ] `asp add/remove` - Modify targets
6. [ ] `asp run <target>` - Launches Claude with correct plugins
7. [ ] `asp build <target> --output ./plugins` - Materializes without Claude
8. [ ] `asp explain <target>` - Shows load order, pins, warnings
9. [ ] `asp lint` - Detects collisions and issues
10. [ ] `asp gc` - Prunes unreferenced cache entries
