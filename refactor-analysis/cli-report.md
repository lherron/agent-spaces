# Refactoring Analysis: packages/cli/src

**Target:** packages/cli/src  
**Lines analyzed:** 9,098  ·  **Generated:** 2026-06-07  ·  **Focus:** all

---

## SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| **SRP** (Single Responsibility) | 🟡 | 4 large command files (>300 LOC) mix argument parsing, domain logic, and formatting |
| **OCP** (Open/Closed) | 🟡 | Type/enum-based dispatch in `run.ts` (detectRunMode, buildSettingSources chains) |
| **LSP** (Liskov Substitution) | 🟢 | No violations detected; clean interface contracts |
| **ISP** (Interface Segregation) | 🟢 | Interfaces are focused; options interfaces are narrow |
| **DIP** (Dependency Inversion) | 🟡 | Direct new PathResolver() calls; harness validation spreads across 5 commands |

---

## Priority Refactorings

### 1. Extract `validateHarness()` to shared utility module — DIP
- **Location:** `/packages/cli/src/commands/build.ts:33`, `/packages/cli/src/commands/explain.ts:20`, `/packages/cli/src/commands/install.ts:28`, `/packages/cli/src/commands/run.ts:385`
- **Current:** Four identical 10-line harness validators duplicated across commands; mix arg validation, error display, and process.exit()
- **Suggested:** Create `src/harness-validator.ts` with a single exported function that accepts a harness ID and returns HarnessId or throws with a clean error message. Update callers to catch and handle errors via the existing `exitWithAspError()` pattern.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 30 minutes  ·  **Tests:** `npm test packages/cli` (validate harness option error messages)

### 2. Extract `buildSettingSources()` to shared utility — DIP + OCP
- **Location:** `/packages/cli/src/commands/run.ts:110`, `/packages/cli/src/commands/gui.ts:63`
- **Current:** Identical function in two files; conditional inherit logic (inheritAll → null, multiple flag combinations → comma string) is duplicated
- **Suggested:** Create `src/settings-helper.ts` exporting `buildSettingSources(inherit: { all?: boolean; project?: boolean; user?: boolean; local?: boolean }): string | null | undefined`. Both commands import and call the shared function.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 20 minutes  ·  **Tests:** Existing unit tests for run/gui commands (verify settings inheritance is still correct)

### 3. Extract `resolveProjectRunTarget()` and `resolveGuiTarget()` to shared utility — OCP + DIP
- **Location:** `/packages/cli/src/commands/run.ts:80`, `/packages/cli/src/commands/gui.ts:41`
- **Current:** Nearly identical scope-handle parsing logic (18 lines each); same try/catch parseScopeHandle pattern with same fallback behavior
- **Suggested:** Create `src/scope-target-resolver.ts` with a generic function that accepts a target string and returns { targetName, displayTarget, projectId?, taskId? }. Both commands use it without change.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 25 minutes  ·  **Tests:** `npm test packages/cli` (run/gui scope parsing edge cases)

### 4. Split `run.ts` into mode handlers + orchestrator — SRP
- **Location:** `/packages/cli/src/commands/run.ts` (500 LOC)
- **Current:** Single file mixes 7 concerns: mode detection (detectRunMode), project/global/dev mode handlers (3 async functions, ~220 LOC), common options builder, harness validation, error handling, CLI registration, prompt display, compiler debug dump. Functions are well-factored but tight coupling within one file.
- **Suggested:** Create `src/commands/run/` subdirectory: 
  - `modes.ts`: export `detectRunMode()`, `isLocalSpacePath()`, `hasAgentProfile()`
  - `modes/project.ts`: export `runProjectMode()`
  - `modes/global.ts`: export `runGlobalMode()`
  - `modes/dev.ts`: export `runDevMode()`
  - `index.ts`: imports all; contains CLI registration and orchestration only
  - Move `buildCommonRunOptions()` to `src/run-options-builder.ts`
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 90 minutes  ·  **Tests:** All existing unit and integration tests (verify no behavior change)

### 5. Reduce parameter count in `resolveContextTemplateDetailed()` and `resolveSelfContext()` calls — ISP + DIP
- **Location:** `/packages/cli/src/commands/self/lib.ts:206` (resolveContextTemplateDetailed call passes 3 args), `/packages/cli/src/commands/self/explain.ts` (multiple dispatch patterns)
- **Current:** Long call site argument lists; context is scattered across multiple variables before passing to resolver functions
- **Suggested:** Build a single resolver options object once per command entry point and thread it through. Example: `const resolverOpts = buildResolverOpts(options, agentRoot, agentName); await resolveContextTemplateDetailed(contextTemplate, resolverOpts)`.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 45 minutes  ·  **Tests:** `npm test packages/cli` (`asp self` commands)

### 6. Create a command registration factory to reduce boilerplate — SRP + OCP
- **Location:** `/packages/cli/src/index.ts:63-98` (18 similar register calls)
- **Current:** 18 nearly identical command registrations (e.g., `registerRunCommand(program)`, `registerInitCommand(program)`, ...) in `createProgram()`. If adding a new command, 3 places need updating: import, register call, index file.
- **Suggested:** Create `src/command-registry.ts` exporting `registerAllCommands(program: Command): void` that imports all register functions and calls them. Update `createProgram()` to call one function. Reduces coupling between index.ts and individual command modules.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 40 minutes  ·  **Tests:** Existing CLI smoke tests (verify all commands still register)

---

## Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| **Duplicated block** | `validateHarness()` in build.ts, explain.ts, install.ts, run.ts | Medium |
| **Duplicated block** | `buildSettingSources()` in run.ts, gui.ts | Low |
| **Duplicated block** | `resolveProjectRunTarget()` vs `resolveGuiTarget()` | Low |
| **Type-based dispatch chain** | `detectRunMode()` → 4 conditions + 1 invalid state (run.ts:211-234) | Low |
| **Long method** | `createProgram()` in index.ts (35 LOC; all register calls) | Low |
| **Magic numbers** | `timeout: 10000` (doctor.ts:145), hardcoded maxWidth 76 (ui.ts:121) | Low |
| **Type-based switch in format** | `formatChangeText()` in diff.ts; `computeDiffChanges()` (switch on type 'added'/'removed'/'updated') | Low |
| **Primitive obsession** | Strings used for enum-like values (runMode: 'project'|'global'|'dev'|'invalid') instead of type-safe enum | Low |
| **Feature envy** | `run.ts` calls many `spaces-execution` and `spaces-config` functions; tight coupling to orchestration layer | Low |

---

## Quick Wins (low risk, high value)

1. **Extract shared `validateHarness()` → 30 min**: Eliminates 40 LOC of duplication across 4 files. High visibility, zero behavior change.
2. **Extract shared `buildSettingSources()` → 20 min**: Reduces duplication in run/gui commands. Test coverage already present.
3. **Move command registration to factory → 40 min**: Reduces long import list in index.ts; makes adding new commands a two-step process (register + export).
4. **Define `RunMode` as const assertion or enum in run.ts → 10 min**: Replace string literals ('project'|'global'|'dev'|'invalid') with `as const` type guard for type safety.

---

## Technical Debt Notes

### Distributed Concern: Harness Validation
Five commands (build, explain, install, run, gui) validate harness IDs with identical logic but no shared utility. Each repeats the same error message formatting and process.exit() call. This is maintainability debt—if the harness registry API changes, 5 places need updating.

### Distributed Concern: Settings Source Building
Two commands (run, gui) have identical `buildSettingSources()` functions with no shared home. If a new inherit flag is added (e.g., --inherit-workspace), both need updating independently.

### Tight Coupling in run.ts
The `run` command orchestrates three different execution modes (project/global/dev) and several option-builder functions. While each function is clean, the file is 500 LOC and mixing concerns. Future changes to mode detection or option building will likely touch this file.

### Long Promise Chain in index.ts
The `normalizeMainError()` function (lines 49-58) appears twice in index.ts (line 52 and line 131). Small candidate for extraction but low priority given the brevity.

### Minimal Test Coverage for Utilities
Files like `ui.ts` (command wrapping, path formatting) and `helpers.ts` (path context resolution) have no unit tests. Integration tests via CLI commands provide some coverage, but unit tests would catch regressions faster.

### Parameter List Growth in Resolver Functions
Commands like `resolveContextTemplateDetailed()` and `resolveSelfContext()` accept options objects, but call sites are often verbose (e.g., resolve-reminder.ts:184-190). A builder pattern or options normalization could reduce call-site complexity.

---

### Summary

**Key Violations:**
- **SRP**: run.ts (500 LOC) mixes orchestration, mode handling, and formatting
- **OCP**: Harness validation, settings source building spread across commands without factory/shared utility
- **DIP**: Direct PathResolver instantiation; no injection seam for shared validation logic

**Easiest Wins:**
1. Extract validateHarness() → shared utility (DIP, 4 duplications)
2. Extract buildSettingSources() → shared utility (DIP, 2 duplications)
3. Reorganize run.ts as subdirectory with mode handlers (SRP, 500→250 LOC in index)
4. Create command-registry factory (OCP, reduce coupling in index.ts)

**Effort / Impact Ratio:**
- Harness validation + settings sources: ~50 min work, eliminates ~40 LOC duplication, high maintainability gain
- Run.ts reorganization: ~90 min work, improves readability + SRP, no behavior change
- Command registry: ~40 min work, future-proofs command registration

All identified refactorings are **low risk** and **internal-only** (no public API changes).
