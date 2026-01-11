# Multi-Harness Implementation Plan

> **Status:** Phase 4.3 Complete
> **Spec:** specs/MULTI-HARNESS-SPEC-PROPOSED.md
> **Current Phase:** 4 - Full Multi-Harness

## Overview

This plan tracks the implementation of multi-harness support for Agent Spaces v2, enabling support for coding agents beyond Claude Code (initially Pi).

## Architecture Summary

The implementation follows a 4-phase migration path from the spec:

1. **Phase 1: Prepare** - Add HarnessAdapter interface, refactor Claude code, add CLI flags ✅
2. **Phase 2: Two-Phase Materialization** - Split materializeSpace() and composeTarget(), update output layout ✅
3. **Phase 3: Pi Support** - Add PiAdapter, extension bundling, hook bridge generation
4. **Phase 4: Full Multi-Harness** - AGENT.md support, hooks.toml, permissions.toml

---

## Phase 1: Prepare (No Breaking Changes) ✅

### 1.1 Add HarnessAdapter Interface and Types ✅
- [x] Create `packages/core/src/types/harness.ts` with:
  - `HarnessId` type (`"claude" | "pi"`)
  - `HarnessAdapter` interface
  - `HarnessDetection` interface
  - `MaterializeSpaceResult` interface
  - `ComposeTargetResult` interface
  - `ComposedTargetBundle` interface
  - `HarnessValidationResult` interface
- [x] Export from `packages/core/src/types/index.ts`

### 1.2 Create HarnessRegistry ✅
- [x] Create `packages/engine/src/harness/registry.ts`
- [x] Implement `HarnessRegistry` class with:
  - `register(adapter)` method
  - `get(id)` method
  - `getAll()` method
  - `detectAvailable()` method
  - `getAvailable()` method
- [x] Export singleton instance `harnessRegistry`

### 1.3 Refactor Claude Code into ClaudeAdapter ✅
- [x] Create `packages/engine/src/harness/claude-adapter.ts`
- [x] Implement `ClaudeAdapter` class:
  - `detect()` - wraps existing claude detection
  - `validateSpace()` - validates plugin name
  - `materializeSpace()` - wraps existing materialization
  - `composeTarget()` - wraps existing composition logic
  - `buildRunArgs()` - wraps existing arg building
  - `getTargetOutputPath()` - returns v2-compatible path (Phase 2 will add harness subdirectory)
- [x] Register ClaudeAdapter in registry on module load

### 1.4 Add Harness Section to space.toml Schema (Deferred to Phase 2)
- [ ] Update `packages/core/src/schemas/space.schema.json`:
  - Add optional `[harness]` section with `supports` array
  - Add optional `[deps.claude]` and `[deps.pi]` sections
  - Add optional `[claude]` and `[pi]` sections
- [ ] Update `SpaceManifest` type in `packages/core/src/types/space.ts`
- [ ] Update TOML parser if needed

### 1.5 Add `asp harnesses` Command ✅
- [x] Create `packages/cli/src/commands/harnesses.ts`
- [x] Implement command to list available harnesses with versions and capabilities
- [x] Register in CLI
- [x] Support `--json` output format

### 1.6 Add --harness Flag to CLI Commands ✅
- [x] Add `--harness` option to `run` command (default: "claude")
- [x] Add validation for harness ID (rejects unknown harnesses)
- [x] Phase 1 behavior: Only "claude" is supported; "pi" returns helpful error message
- [x] Add `--harness` option to `install` command (Phase 2)
- [x] Add `--harness` option to `build` command (Phase 2)
- [x] Add `--harness` option to `explain` command (Phase 2)

---

## Phase 2: Two-Phase Materialization

### 2.1 Split Materialization ✅
- [x] `ClaudeAdapter.materializeSpace()` wraps existing materialization
- [x] `ClaudeAdapter.composeTarget()` handles target assembly
- [x] Add `computeHarnessPluginCacheKey()` in `@agent-spaces/store/cache.ts`
- [x] Migrate engine (install.ts, build.ts, run.ts) to use harness adapters instead of direct materializer calls

### 2.2 Update Output Layout ✅
- [x] `ClaudeAdapter.getTargetOutputPath()` returns `asp_modules/<target>/claude`
- [x] Add harness-aware path helpers to core package:
  - `getHarnessOutputPath()`
  - `getHarnessPluginsPath()`
  - `getHarnessMcpConfigPath()`
  - `getHarnessSettingsPath()`
  - `harnessOutputExists()`
- [x] Migrate engine to use new harness-aware paths

### 2.3 Update Lock File ✅
- [x] Add `LockHarnessEntry` interface with `envHash` and `warnings` fields
- [x] Add `harnesses?: Record<string, LockHarnessEntry>` to `LockTargetEntry`
- [x] Update `lock.schema.json` with `harnessEntry` definition
- [x] Generate harness entries during resolution/materialization

---

## Phase 3: Pi Support ✅

### 3.1 Create PiAdapter ✅
- [x] Create `packages/engine/src/harness/pi-adapter.ts`
- [x] Implement Pi binary detection (PI_PATH env, PATH, ~/tools/pi-mono)
- [x] Implement space validation for Pi
- [x] Implement `detect()` with version and capability detection
- [x] Implement `validateSpace()` for Pi compatibility
- [x] Implement `materializeSpace()` for bundling extensions
- [x] Implement `composeTarget()` for assembling target bundles
- [x] Implement `buildRunArgs()` for Pi CLI invocation
- [x] Implement `getTargetOutputPath()` returning `asp_modules/<target>/pi`
- [x] Register PiAdapter in harness registry

### 3.2 Pi Extension Bundling ✅
- [x] Add Bun build integration for TypeScript extensions (`bundleExtension()`)
- [x] Add `extensions/` directory handling in materializer
- [x] Add tool namespacing (spaceId__toolName.js format)
- [x] Support build options (format, target, external) from manifest

### 3.3 Hook Bridge Generation ✅
- [x] Create hook bridge extension generator (`generateHookBridgeCode()`)
- [x] Map abstract events to Pi events (pre_tool_use → tool_call, etc.)
- [x] Generate `asp-hooks.bridge.js` during composition
- [x] Shell out to configured scripts with ASP_* environment variables

### 3.4 Pi-Specific Lint Rules ✅
- [x] W301: Hook marked blocking but event cannot block (implemented in composeTarget)
- [x] W302: Extension registers un-namespaced tool (code constant added; full AST analysis deferred)
- [x] W303: Tool name collision after namespacing (implemented in composeTarget)

---

## Phase 4: Full Multi-Harness

### 4.1 AGENT.md Support ✅
- [x] Support `AGENT.md` as harness-agnostic instructions
- [x] Claude materializer renames to `CLAUDE.md` in output
- [x] Pi uses directly (copies as `AGENT.md`)
- [x] Added `linkInstructionsFile()` helper in `packages/materializer/src/link-components.ts`
- [x] Added tests for instructions file handling (9 tests)

### 4.2 hooks.toml Support ✅
- [x] Parse `hooks.toml` as canonical hook declaration
- [x] Generate `hooks/hooks.json` for Claude
- [x] Generate hook bridge for Pi
- [x] Added `packages/materializer/src/hooks-toml.ts` with:
  - `CanonicalHookDefinition` type (harness-agnostic hook format)
  - `parseHooksToml()` - parses hooks.toml content
  - `readHooksToml()` - reads hooks.toml from hooks directory
  - `readHooksWithPrecedence()` - reads hooks.toml first, falls back to hooks.json
  - `toClaudeHooksConfig()` - converts canonical hooks to Claude format
  - `filterHooksForHarness()` - filters hooks for specific harness
  - `translateToClaudeEvent()` / `translateToPiEvent()` - event name mapping
- [x] Updated ClaudeAdapter to generate hooks.json from hooks.toml during materialization
- [x] Updated PiAdapter to use `readHooksWithPrecedence()` for hook bridge generation
- [x] Added 27 tests for hooks.toml parsing and generation

### 4.3 permissions.toml Support ✅
- [x] Parse granular permission definitions
- [x] Translate to Claude settings
- [x] Translate to Pi settings (best-effort)
- [x] Added `packages/materializer/src/permissions-toml.ts` with:
  - `CanonicalPermissions` type (harness-agnostic permission format)
  - `parsePermissionsToml()` - parses permissions.toml content
  - `readPermissionsToml()` - reads permissions.toml from space directory
  - `toClaudePermissions()` - translates to Claude format with enforcement levels
  - `toClaudeSettingsPermissions()` - converts to settings.json permissions format
  - `toPiPermissions()` - translates to Pi format (mostly lint_only)
  - `explainPermissions()` - generates human-readable explanation
- [x] Updated ClaudeAdapter to read permissions.toml and merge with settings during composition
- [x] Updated PiAdapter to read permissions.toml and generate W304 warnings for lint_only facets
- [x] Added W304 warning code: PI_PERMISSION_LINT_ONLY
- [x] Added 51 tests for permissions.toml parsing and translation

---

## Current Work

**Completed:** Phase 1 - Preparation complete with:
- HarnessAdapter interface and types
- HarnessRegistry with ClaudeAdapter registered
- `asp harnesses` command
- `--harness` flag on all CLI commands (run, install, build, explain)

**Completed:** Phase 2 - Two-Phase Materialization
- ClaudeAdapter output path now returns harness subdirectory (`asp_modules/<target>/claude`)
- Harness-aware cache key function added
- Lock file types and schema updated with harness entries
- Harness-aware path helpers added to core package
- Engine files (install.ts, build.ts, run.ts) migrated to use harness adapters
- `--harness` flag added to install, build, and explain commands
- Harness entries generated in lock file during resolution (with harness-specific envHash)
- Added `computeHarnessEnvHash()` function in resolver/integrity.ts

**Completed:** Phase 3 - Pi Support
- Created `packages/engine/src/harness/pi-adapter.ts` with full HarnessAdapter implementation
- Pi binary detection: PI_PATH env → PATH → ~/tools/pi-mono
- Extension bundling with Bun: bundles .ts/.js to namespaced .js files
- Hook bridge generation: creates asp-hooks.bridge.js that shells out to scripts
- Model translation: sonnet → claude-sonnet, opus → claude-opus, etc.
- Skills directory merging (Agent Skills standard - same as Claude)
- Pi-specific lint rules:
  - W301: Warning for blocking hooks that Pi cannot enforce
  - W302: Warning code constant added (full AST analysis deferred to future work)
  - W303: Extension file collision detection during composition
- Warning code cleanup: Renamed LOCK_MISSING from W301 to W101 to reserve W3xx for harness-specific warnings

**Completed:** Phase 4.1 - AGENT.md Support
- Added `linkInstructionsFile()` helper function in materializer
- ClaudeAdapter.materializeSpace() now links AGENT.md → CLAUDE.md (or CLAUDE.md → CLAUDE.md for legacy)
- PiAdapter.materializeSpace() now links AGENT.md → AGENT.md
- Backwards compatible: legacy CLAUDE.md still works for Claude-only spaces
- Added 9 tests for instructions file handling

**Completed:** Phase 4.2 - hooks.toml Support
- Created `packages/materializer/src/hooks-toml.ts` for parsing canonical hooks format
- hooks.toml is the harness-agnostic format, translated to harness-specific formats:
  - Claude: generates `hooks/hooks.json` with Claude event names (PreToolUse, PostToolUse, Stop)
  - Pi: reads via `readHooksWithPrecedence()` for hook bridge generation
- `readHooksWithPrecedence()` prefers hooks.toml over hooks.json for backwards compatibility
- Event mapping: pre_tool_use → PreToolUse (Claude) / tool_call (Pi), etc.
- harness-specific hooks: `harness = "pi"` or `harness = "claude"` field filters hooks
- Added 27 tests for hooks.toml parsing and generation

**Completed:** Phase 4.3 - permissions.toml Support
- Created `packages/materializer/src/permissions-toml.ts` for parsing permissions.toml
- permissions.toml is the harness-agnostic format with sections: [read], [write], [exec], [network], [deny]
- Enforcement levels classify how each harness handles permissions:
  - Claude: read/write/exec/deny → enforced; network → lint_only
  - Pi: exec → best_effort; everything else → lint_only
- ClaudeAdapter reads permissions.toml from artifacts and merges with settings during composition
- PiAdapter reads permissions.toml and generates W304 warnings for lint_only facets
- Added W304 warning code: PI_PERMISSION_LINT_ONLY
- Added 51 tests for permissions.toml parsing and translation

**Next:** Phase 5 - Multi-Harness Smoke Testing
- Create test fixtures for multi-harness configurations
- Manual smoke testing with actual harnesses

---

## Phase 5: Multi-Harness Smoke Testing

Manual smoke testing of multi-harness configurations using actual harnesses in non-interactive mode.

### 5.1 Test Fixtures Setup
- [ ] Create `integration-tests/fixtures/multi-harness/` directory
- [ ] Create Claude-only space (`claude-only/`) with commands, MCP, skills
- [ ] Create Pi-only space (`pi-only/`) with extensions, skills
- [ ] Create multi-harness space (`multi-harness/`) with AGENT.md, skills, hooks
- [ ] Create project with `asp-targets.toml` targeting all three spaces

### 5.2 Claude Harness Smoke Tests
Run each with `--dry-run` first, then with actual `claude` binary using `--print` (non-interactive):

- [ ] Basic Claude run: `asp run claude-target --harness claude --dry-run`
- [ ] Verify `--plugin-dir` flags point to `asp_modules/<target>/claude/plugins/`
- [ ] Verify `--mcp-config` points to composed `mcp.json`
- [ ] Verify `--settings` points to composed `settings.json`
- [ ] Test with `--inherit-project` / `--inherit-user` flags
- [ ] Test with explicit `--model` override
- [ ] Verify AGENT.md → CLAUDE.md renaming in output
- [ ] Run `asp explain <target> --harness claude` and verify output

Non-interactive execution (requires Claude):
```bash
echo "What tools do you have?" | asp run <target> --harness claude --print
```

### 5.3 Pi Harness Smoke Tests
Run each with `--dry-run` first, then with actual `pi` binary using non-interactive mode:

- [ ] Basic Pi run: `asp run pi-target --harness pi --dry-run`
- [ ] Verify `--extension` flags point to bundled `.js` files
- [ ] Verify extensions are namespaced (`<spaceId>__<name>.js`)
- [ ] Verify `--skills` points to merged skills directory
- [ ] Verify hook bridge extension (`asp-hooks.bridge.js`) is generated
- [ ] Verify model translation (`sonnet` → `claude-sonnet`)
- [ ] Test with explicit `--model` override
- [ ] Verify AGENT.md is copied (not renamed) for Pi
- [ ] Run `asp explain <target> --harness pi` and verify output

Non-interactive execution (requires Pi):
```bash
echo "What tools do you have?" | asp run <target> --harness pi --print
```

### 5.4 Multi-Harness Target Tests
Project with `harnesses = ["claude", "pi"]` in target config:

- [ ] `asp install` generates both `asp_modules/<target>/claude/` and `asp_modules/<target>/pi/`
- [ ] `asp build --harness claude` builds only Claude output
- [ ] `asp build --harness pi` builds only Pi output
- [ ] `asp build` builds both (if target declares both)
- [ ] Lock file contains `harnesses` section with per-harness `envHash`
- [ ] Verify warnings in lock file (e.g., W301 for blocking hooks on Pi)

### 5.5 AGENT.md / CLAUDE.md Handling
- [ ] Space with only `AGENT.md`: Claude output has `CLAUDE.md`, Pi output has `AGENT.md`
- [ ] Space with only `CLAUDE.md`: Claude output has `CLAUDE.md`, Pi output is empty (or warns)
- [ ] Space with both: Claude prefers `CLAUDE.md`, Pi uses `AGENT.md`
- [ ] Verify `asp explain` shows instructions file handling

### 5.6 Skills Directory Handling
- [ ] Single space with skills: skills copied to both harness outputs
- [ ] Multiple spaces with skills: skills merged in load order
- [ ] Skill collision handling (later space overwrites earlier)

### 5.7 Hooks Handling
- [ ] Space with `hooks/hooks.json`: Claude uses directly, Pi generates bridge
- [ ] Verify hook scripts are executable in output
- [ ] Verify Pi hook bridge has correct event mappings
- [ ] Verify W301 warning for blocking hooks on Pi

### 5.8 Extension Bundling (Pi)
- [ ] TypeScript extension bundles to `.js`
- [ ] Extension with dependencies bundles correctly
- [ ] `[pi.build]` options respected (format, target, external)
- [ ] Bundle includes correct namespacing wrapper

### 5.9 Error Cases
- [ ] `--harness pi` on Claude-only space: clear error message
- [ ] `--harness claude` on Pi-only space: clear error message
- [ ] Missing harness binary: helpful error with installation guidance
- [ ] Extension bundling failure: clear error with path and details

### 5.10 CLI Command Coverage
Test each CLI command with `--harness` flag:

- [ ] `asp run <target> --harness <id> --dry-run`
- [ ] `asp install --harness <id>`
- [ ] `asp build <target> --harness <id>`
- [ ] `asp explain <target> --harness <id>`
- [ ] `asp harnesses` (list available harnesses)
- [ ] `asp harnesses --json` (JSON output)

---

## Notes and Learnings

### Key Architectural Decisions

1. **Adapter Pattern**: Each harness implements a common interface for detection, validation, materialization, composition, and invocation.

2. **Two-Phase Materialization**: Per-space artifacts are cached independently, then composed per-target. This enables cache reuse across projects.

3. **Harness-Specific Dependencies**: Spaces can declare harness-specific dependencies that only apply when composing for that harness.

4. **Backwards Compatibility**: Phase 1 introduces no breaking changes. Existing Claude-only workflows continue to work unchanged.

5. **ClaudeAdapter Wrapping**: The ClaudeAdapter wraps existing functionality from @agent-spaces/claude and @agent-spaces/materializer rather than duplicating it.

6. **Harness EnvHash Design**: The harness-specific `envHash` in lock files includes the harness ID but NOT the harness version. This is intentional because:
   - Version changes independently of space content
   - Actual materialization cache uses `computeHarnessPluginCacheKey()` which includes version
   - Lock file hash is for "resolved environment identity" not "materialized artifact identity"

7. **Warning Code Organization**:
   - W1xx: System/project-level warnings (W101: lock file missing)
   - W2xx: Space/plugin lint rules (W201-W207: command collisions, hooks issues, etc.)
   - W3xx: Harness-specific warnings (W301-W310 reserved for Pi)

### File Locations

- Harness types: `packages/core/src/types/harness.ts`
- Lock harness types: `packages/core/src/types/lock.ts` (LockHarnessEntry)
- Lock schema: `packages/core/src/schemas/lock.schema.json`
- Harness-aware paths: `packages/core/src/config/asp-modules.ts`
- Harness-aware cache: `packages/store/src/cache.ts` (computeHarnessPluginCacheKey)
- Harness env hash: `packages/resolver/src/integrity.ts` (computeHarnessEnvHash)
- Lock generator: `packages/resolver/src/lock-generator.ts` (buildTargetEntry with harness entries)
- Harness adapters: `packages/engine/src/harness/`
- Harness registry: `packages/engine/src/harness/registry.ts`
- Claude adapter: `packages/engine/src/harness/claude-adapter.ts`
- Pi adapter: `packages/engine/src/harness/pi-adapter.ts`
- Pi errors: `packages/core/src/errors.ts` (PiError, PiNotFoundError, PiBundleError, PiInvocationError)
- CLI harness command: `packages/cli/src/commands/harnesses.ts`
- Instructions file linking: `packages/materializer/src/link-components.ts` (linkInstructionsFile)
- Hooks TOML parsing: `packages/materializer/src/hooks-toml.ts` (parseHooksToml, readHooksWithPrecedence, toClaudeHooksConfig)
- Permissions TOML parsing: `packages/materializer/src/permissions-toml.ts` (parsePermissionsToml, toClaudePermissions, toPiPermissions)

---

## Test Coverage

- [ ] HarnessAdapter interface tests
- [ ] ClaudeAdapter unit tests
- [ ] HarnessRegistry tests
- [ ] CLI --harness flag tests
- [ ] Integration test with Claude harness
- [ ] PiAdapter unit tests
- [ ] Pi extension bundling tests
- [ ] Hook bridge generation tests
- [ ] Integration test with Pi harness
- [x] Instructions file linking tests (9 tests in link-components.test.ts)
- [x] hooks.toml parsing and generation tests (27 tests in hooks-toml.test.ts)
- [x] permissions.toml parsing and translation tests (51 tests in permissions-toml.test.ts)
