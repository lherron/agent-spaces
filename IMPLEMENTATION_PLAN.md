# Implementation Plan: Modular Harness Architecture

## Overview

This plan outlines the refactoring of agent-spaces from a monolithic execution package with hardcoded harness branching to a modular architecture where each harness is self-contained and the runtime is harness-agnostic. The goal is to achieve a plugin-style architecture where adding a new harness requires changes in exactly 3 places: the config enum, a new harness package, and one `register()` call.

**Key Deliverables:**
- `packages/runtime/` (spaces-runtime) - harness-agnostic runtime primitives
- `packages/harness-claude/` - Claude and Claude Agent SDK adapters
- `packages/harness-pi/` - Pi adapter
- `packages/harness-pi-sdk/` - Pi SDK adapter
- `packages/harness-codex/` - Codex adapter
- Refactored execution layer with zero harness-ID branching
- Refactored CLI with adapter-driven pipelines

---

## Phase 1: Interface Changes in spaces-config (Foundation)

Extend the HarnessAdapter interface and HarnessRunOptions to support adapter-driven bundle loading and environment configuration.

- [ ] Add `loadTargetBundle(outputDir: string, targetName: string): Promise<ComposedTargetBundle>` method to HarnessAdapter interface
- [ ] Add `getRunEnv(bundle: ComposedTargetBundle, options: HarnessRunOptions): Record<string, string>` method to HarnessAdapter interface
- [ ] Add `getDefaultRunOptions(manifest: SpaceManifest, targetName: string): Partial<HarnessRunOptions>` method to HarnessAdapter interface
- [ ] Add `permissionMode?: string` field to HarnessRunOptions type
- [ ] Add `settings?: string` field to HarnessRunOptions type
- [ ] Add `debug?: boolean` field to HarnessRunOptions type
- [ ] Export any new types needed by harness packages (ComposedTargetBundle if not already exported)
- [ ] Update spaces-config package version and changelog

---

## Phase 2: Create spaces-runtime Package (Infrastructure)

Create a new package containing harness-agnostic runtime primitives, including the SessionRegistry pattern.

- [ ] Create `packages/runtime/` directory structure with standard package layout
- [ ] Create `packages/runtime/package.json` with appropriate dependencies
- [ ] Create `packages/runtime/tsconfig.json` extending base config
- [ ] Move HarnessRegistry from `packages/execution/src/harness/registry.ts` to `packages/runtime/src/harness-registry.ts`
- [ ] Create SessionRegistry class in `packages/runtime/src/session-registry.ts` with `register()` and `create()` methods
- [ ] Move/copy UnifiedSession interface to `packages/runtime/src/session/types.ts`
- [ ] Move/copy event types to `packages/runtime/src/events/types.ts`
- [ ] Move/copy event emitter utilities from `packages/execution/src/events/` to `packages/runtime/src/events/`
- [ ] Move/copy permission handler types to `packages/runtime/src/permissions/types.ts`
- [ ] Create `createSession()` function that uses SessionRegistry (not hardcoded branching)
- [ ] Create main export barrel file `packages/runtime/src/index.ts`
- [ ] Add spaces-runtime to root workspace configuration
- [ ] Build and verify package compiles successfully

---

## Phase 3: Implement New Adapter Methods

Add the three new required methods to each existing adapter, enabling adapter-driven bundle loading and configuration.

### Claude Adapter
- [ ] Implement `loadTargetBundle()` in Claude adapter (extract logic from run.ts)
- [ ] Implement `getRunEnv()` in Claude adapter (extract environment setup logic)
- [ ] Implement `getDefaultRunOptions()` in Claude adapter

### Claude Agent SDK Adapter
- [ ] Implement `loadTargetBundle()` in Claude Agent SDK adapter
- [ ] Implement `getRunEnv()` in Claude Agent SDK adapter
- [ ] Implement `getDefaultRunOptions()` in Claude Agent SDK adapter

### Pi Adapter
- [ ] Implement `loadTargetBundle()` in Pi adapter (extract from buildPiBundle logic)
- [ ] Implement `getRunEnv()` in Pi adapter
- [ ] Implement `getDefaultRunOptions()` in Pi adapter

### Pi SDK Adapter
- [ ] Implement `loadTargetBundle()` in Pi SDK adapter (extract from loadPiSdkBundle logic)
- [ ] Implement `getRunEnv()` in Pi SDK adapter
- [ ] Implement `getDefaultRunOptions()` in Pi SDK adapter

### Codex Adapter
- [ ] Implement `loadTargetBundle()` in Codex adapter (extract from loadCodexBundle logic)
- [ ] Implement `getRunEnv()` in Codex adapter
- [ ] Implement `getDefaultRunOptions()` in Codex adapter

---

## Phase 4: Create Harness Packages

Extract harness-specific code into dedicated packages. Each package should be self-contained with its adapter, session implementation, and utilities.

### packages/harness-claude/
- [ ] Create `packages/harness-claude/` directory structure
- [ ] Create `packages/harness-claude/package.json` with dependencies on spaces-config and spaces-runtime
- [ ] Create `packages/harness-claude/tsconfig.json`
- [ ] Move ClaudeAdapter from `packages/execution/src/harness/adapters/claude.ts`
- [ ] Move ClaudeAgentSdkAdapter from `packages/execution/src/harness/adapters/claude-agent-sdk.ts`
- [ ] Move claude session code from `packages/execution/src/claude/`
- [ ] Move agent-sdk session code from `packages/execution/src/agent-sdk/`
- [ ] Create adapter registration export that calls `HarnessRegistry.register()` and `SessionRegistry.register()`
- [ ] Create main export barrel file
- [ ] Verify package builds successfully

### packages/harness-pi/
- [ ] Create `packages/harness-pi/` directory structure
- [ ] Create `packages/harness-pi/package.json`
- [ ] Create `packages/harness-pi/tsconfig.json`
- [ ] Move PiAdapter from `packages/execution/src/harness/adapters/pi.ts`
- [ ] Create adapter registration export
- [ ] Create main export barrel file
- [ ] Verify package builds successfully

### packages/harness-pi-sdk/
- [ ] Create `packages/harness-pi-sdk/` directory structure
- [ ] Create `packages/harness-pi-sdk/package.json`
- [ ] Create `packages/harness-pi-sdk/tsconfig.json`
- [ ] Move PiSdkAdapter from `packages/execution/src/harness/adapters/pi-sdk.ts`
- [ ] Move pi-session code from `packages/execution/src/pi-session/`
- [ ] Move pi-sdk code from `packages/execution/src/pi-sdk/`
- [ ] Create adapter registration export
- [ ] Create main export barrel file
- [ ] Verify package builds successfully

### packages/harness-codex/
- [ ] Create `packages/harness-codex/` directory structure
- [ ] Create `packages/harness-codex/package.json`
- [ ] Create `packages/harness-codex/tsconfig.json`
- [ ] Move CodexAdapter from `packages/execution/src/harness/adapters/codex.ts`
- [ ] Move codex-session code from `packages/execution/src/codex-session/`
- [ ] Create adapter registration export
- [ ] Create main export barrel file
- [ ] Verify package builds successfully

---

## Phase 5: Refactor Execution Layer

Remove all harness-specific code from the execution package and eliminate harness-ID branching. The execution package should become a thin orchestration layer.

### Refactor run.ts
- [ ] Remove `buildPiBundle()` function - replace with `adapter.loadTargetBundle()`
- [ ] Remove `loadPiSdkBundle()` function - replace with `adapter.loadTargetBundle()`
- [ ] Remove `loadCodexBundle()` function - replace with `adapter.loadTargetBundle()`
- [ ] Remove all `if (harnessId === 'pi')` conditionals
- [ ] Remove all `if (harnessId === 'pi-sdk')` conditionals
- [ ] Remove all `if (harnessId === 'codex')` conditionals
- [ ] Remove all `if (harnessId === 'claude')` conditionals
- [ ] Remove all `if (harnessId === 'claude-agent-sdk')` conditionals
- [ ] Use `adapter.getDefaultRunOptions()` for harness-specific defaults
- [ ] Use `adapter.getRunEnv()` for environment variable setup
- [ ] Verify run.ts has ZERO harness-ID string comparisons

### Refactor session/factory.ts
- [ ] Remove hardcoded if/else branching for session creation
- [ ] Import and use `createSession()` from spaces-runtime
- [ ] Ensure SessionRegistry is populated by harness package imports
- [ ] Delete any orphaned session creation code

### Update execution package dependencies
- [ ] Add dependency on spaces-runtime
- [ ] Add dependencies on all harness packages (for registration side-effects)
- [ ] Remove harness-specific code that has been moved to harness packages
- [ ] Delete empty directories after code extraction
- [ ] Update execution package exports/barrel file
- [ ] Re-export HarnessRegistry from spaces-runtime for backwards compatibility

### Verification
- [ ] Verify execution package builds successfully
- [ ] Verify no TypeScript errors in dependent packages
- [ ] Run existing unit tests and fix any failures

---

## Phase 6: Refactor CLI

Update the CLI to use adapter-driven pipelines, removing duplicate bundle loading and harness branching.

### Refactor install.ts
- [ ] Remove duplicate bundle loading functions
- [ ] Use `adapter.loadTargetBundle()` instead of inline implementations
- [ ] Remove harness-specific conditionals
- [ ] Ensure install command works with all harness types

### Refactor run command
- [ ] Verify run command uses refactored execution layer correctly
- [ ] Remove any CLI-level harness branching that duplicates execution logic
- [ ] Test run command with each harness type

### Update build configuration
- [ ] Update CLI prepack script to include new harness packages
- [ ] Update build order in workspace configuration
- [ ] Ensure harness packages are built before execution and CLI
- [ ] Update any esbuild or bundler configurations

### Final verification
- [ ] Test `asp install` command with all harness types
- [ ] Test `asp run` command with all harness types
- [ ] Verify no behavior regressions from original implementation
- [ ] Run full test suite

---

## Acceptance Criteria Checklist

- [ ] `run.ts` contains ZERO harness-ID branching (no string comparisons like `=== 'pi'`)
- [ ] `session/factory.ts` hardcoded branching is deleted; creation is registry-based
- [ ] Each harness lives ONLY in its harness package (no harness code in execution)
- [ ] Adding new harness requires edits in exactly 3 places: config enum + new package + one register() call
- [ ] CLI install command continues to work without behavior regressions
- [ ] CLI run command continues to work without behavior regressions
- [ ] All existing tests pass
- [ ] Build succeeds for all packages

---

## Notes

### Minor Issues to Address During Implementation
- Resolve TODO in run.ts: "Consider caching lint results in asp_modules"
- Standardize instructions file handling across adapters
- Standardize hook directory naming (hooks/ vs hooks-scripts/)
- Consider unifying adapter architecture patterns (delegation vs shared utilities)

### Dependencies Between Phases
- Phase 2 depends on Phase 1 (runtime needs new types from config)
- Phase 3 can start after Phase 1 (adapters need new interface)
- Phase 4 depends on Phases 2 and 3 (harness packages need runtime and updated adapters)
- Phase 5 depends on Phase 4 (execution refactor needs harness packages)
- Phase 6 depends on Phase 5 (CLI needs refactored execution layer)

### Risk Mitigation
- Each phase should be completed and tested before moving to the next
- Keep original code commented/available until replacement is verified
- Create feature branch for modularization work
- Consider incremental PRs per phase for easier review
