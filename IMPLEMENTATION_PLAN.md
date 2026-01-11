# Multi-Harness Implementation Plan

> **Status:** Phase 2 Complete (Core Integration)
> **Spec:** specs/MULTI-HARNESS-SPEC-PROPOSED.md
> **Current Phase:** 2 - Two-Phase Materialization (Core Integration Complete)

## Overview

This plan tracks the implementation of multi-harness support for Agent Spaces v2, enabling support for coding agents beyond Claude Code (initially Pi).

## Architecture Summary

The implementation follows a 4-phase migration path from the spec:

1. **Phase 1: Prepare** - Add HarnessAdapter interface, refactor Claude code, add CLI flags ✅
2. **Phase 2: Two-Phase Materialization** - Split materializeSpace() and composeTarget(), update output layout
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
- [ ] Generate harness entries during resolution/materialization

---

## Phase 3: Pi Support

### 3.1 Create PiAdapter
- [ ] Create `packages/engine/src/harness/pi-adapter.ts`
- [ ] Implement Pi binary detection
- [ ] Implement space validation for Pi

### 3.2 Pi Extension Bundling
- [ ] Add Bun build integration for TypeScript extensions
- [ ] Add `extensions/` directory handling in materializer
- [ ] Add tool namespacing transform

### 3.3 Hook Bridge Generation
- [ ] Create hook bridge extension generator
- [ ] Map abstract events to Pi events
- [ ] Generate `asp-hooks.bridge.js`

### 3.4 Pi-Specific Lint Rules
- [ ] W301: Hook marked blocking but event cannot block
- [ ] W302: Extension registers un-namespaced tool
- [ ] W303: Tool name collision after namespacing

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

**Completed:** Phase 2 - Two-Phase Materialization (Core Integration)
- ClaudeAdapter output path now returns harness subdirectory (`asp_modules/<target>/claude`)
- Harness-aware cache key function added
- Lock file types and schema updated with harness entries
- Harness-aware path helpers added to core package
- Engine files (install.ts, build.ts, run.ts) migrated to use harness adapters
- `--harness` flag added to install, build, and explain commands

**Remaining Phase 2 Work:**
- Generate harness entries in lock file during resolution (for harness-specific metadata tracking)

---

## Notes and Learnings

### Key Architectural Decisions

1. **Adapter Pattern**: Each harness implements a common interface for detection, validation, materialization, composition, and invocation.

2. **Two-Phase Materialization**: Per-space artifacts are cached independently, then composed per-target. This enables cache reuse across projects.

3. **Harness-Specific Dependencies**: Spaces can declare harness-specific dependencies that only apply when composing for that harness.

4. **Backwards Compatibility**: Phase 1 introduces no breaking changes. Existing Claude-only workflows continue to work unchanged.

5. **ClaudeAdapter Wrapping**: The ClaudeAdapter wraps existing functionality from @agent-spaces/claude and @agent-spaces/materializer rather than duplicating it.

### File Locations

- Harness types: `packages/core/src/types/harness.ts`
- Lock harness types: `packages/core/src/types/lock.ts` (LockHarnessEntry)
- Lock schema: `packages/core/src/schemas/lock.schema.json`
- Harness-aware paths: `packages/core/src/config/asp-modules.ts`
- Harness-aware cache: `packages/store/src/cache.ts` (computeHarnessPluginCacheKey)
- Harness adapters: `packages/engine/src/harness/`
- Harness registry: `packages/engine/src/harness/registry.ts`
- Claude adapter: `packages/engine/src/harness/claude-adapter.ts`
- CLI harness command: `packages/cli/src/commands/harnesses.ts`

---

## Test Coverage

- [ ] HarnessAdapter interface tests
- [ ] ClaudeAdapter unit tests
- [ ] HarnessRegistry tests
- [ ] CLI --harness flag tests
- [ ] Integration test with Claude harness
