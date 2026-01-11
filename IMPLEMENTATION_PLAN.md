# Implementation Plan: Agent Spaces v2

**Status:** Core implementation complete. All 505 tests passing, 0 lint warnings.

**Latest Tag:** v0.0.60

---

## Completed Work

### Lint Refactoring (v0.0.53 - v0.0.57)
All cognitive complexity warnings eliminated (62 → 0):
- Created shared CLI helpers in `packages/cli/src/helpers.ts`
- Refactored all CLI commands, validators, and engine modules
- Configured Biome test file overrides for `noExplicitAny`

### W203-W207 Lint Warning Tests (v0.0.59)
Added integration tests for all hook-related lint warnings:
- W203 `hook-path-no-plugin-root`: Hook path with relative `..` references
- W204 `invalid-hooks-config`: hooks/ exists but hooks.json missing/invalid
- W205 `plugin-name-collision`: Two spaces produce same plugin name
- W206 `non-executable-hook-script`: Hook script not executable
- W207 `invalid-plugin-structure`: Component dirs inside `.claude-plugin/`

**Bug fixes:**
- Fixed materializer's `validateHooks` to handle invalid hooks.json gracefully
- Fixed lint rules W203, W206 to check for valid hooks array before iterating

---

## Current Priorities: Integration Test Coverage Gaps

Based on spec analysis, the following test gaps should be addressed:

### Priority 1: Critical for MVP

- [x] **W203-W207 Lint Warning Tests** (COMPLETE)

- [x] **MCP Config Generation Tests** (COMPLETE)
  - Added 4 test fixtures: mcp-server-a, mcp-server-b, mcp-collision-a, mcp-collision-b
  - 7 integration tests in `mcp.test.ts` covering:
    - MCP config composition from multiple spaces
    - `--mcp-config` flag passed to Claude
    - Later spaces override earlier MCP server definitions
    - Mixed spaces with/without MCP configs
  - Note: `--strict-mcp-config` not implemented in spec

- [x] **Global Mode Tests (`asp run` outside projects)** (COMPLETE)
  - Added 15 tests covering `runGlobalSpace` and `runLocalSpace` functions
  - Tests for running spaces outside project context
  - Global lock file creation (`$ASP_HOME/global-lock.json`)
  - Dev-mode path runs (`asp run ./my-space`)

- [ ] **Semver/Git Pin Selector Tests**
  - Semver range resolution (`^1.2.0`, `~1.2.3`)
  - Git pin resolution (`git:<commitSha>`)
  - Currently only dist-tags (`@stable`, `@latest`) are tested

- [ ] **Complete `asp doctor` Tests**
  - Claude binary existence check
  - Registry reachability check
  - Cache permissions check
  - Currently only tests ASP_HOME and project existence

### Priority 2: Important

- [ ] **`asp repo gc` Tests**
  - Repository-level garbage collection
  - Git gc execution
  - Orphan pruning

- [ ] **Per-target Claude/Resolver Options Tests**
  - `[targets.backend.claude]` model/permission_mode overrides
  - `[targets.backend.resolver]` locked/allow_dirty options

- [ ] **CLI `--json` Output Format Tests**
  - Test JSON output for `asp diff --json`
  - Test JSON output for `asp list --json`
  - Currently tested via API, not CLI invocation

- [ ] **Error Case Tests**
  - Lock file corruption handling
  - Missing registry scenarios
  - Permission errors
  - Network failures during resolution

### Priority 3: Nice to Have

- [ ] **Complex Dependency Scenarios**
  - Diamond dependency patterns
  - Large composition scenarios (10+ spaces)
  - Upgrade conflicts

- [ ] **Performance Benchmarks**
  - Resolution time benchmarks
  - Materialization throughput

---

## Optional/Future Features (Not in Scope for MVP)

- `asp ui` command - Repository management UI
- `asp space` namespace - Authoring helpers
- TypeScript hook compilation

---

## Test Summary

| Package | Tests | Status |
|---------|-------|--------|
| core | 209 | ✅ |
| resolver | 51 | ✅ |
| store | 40 | ✅ |
| lint | 44 | ✅ |
| git | 23 | ✅ |
| claude | 35 | ✅ |
| cli | 1 | ✅ |
| engine | 1 | ✅ |
| materializer | 19 | ✅ |
| integration-tests | 82 | ✅ |
| **Total** | **505** | **✅** |

---

## Verification Commands

```bash
bun run build     # Build all packages
bun run test      # Run all tests
bun run lint      # Check lint
bun run typecheck # Type check
```
