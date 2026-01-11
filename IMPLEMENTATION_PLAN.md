# Multi-Harness Implementation Plan

> **Status:** Phase 3 Complete
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

### 4.1 AGENT.md Support
- [ ] Support `AGENT.md` as harness-agnostic instructions
- [ ] Claude materializer renames to `CLAUDE.md` in output
- [ ] Pi uses directly

### 4.2 hooks.toml Support
- [ ] Parse `hooks.toml` as canonical hook declaration
- [ ] Generate `hooks/hooks.json` for Claude
- [ ] Generate hook bridge for Pi

### 4.3 permissions.toml Support
- [ ] Parse granular permission definitions
- [ ] Translate to Claude settings
- [ ] Translate to Pi settings (best-effort)

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

**Next:** Phase 4 - Full Multi-Harness
- AGENT.md support
- hooks.toml parsing
- permissions.toml support

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
