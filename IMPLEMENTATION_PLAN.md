# Implementation Plan: Fix Cognitive Complexity Lint Warnings

**Status:** 58 lint warnings (down from 62, reduced by refactoring high-complexity CLI commands)

---

## Priority 1: CLI Shared Helpers (Highest Impact)

- [x] **Create `packages/cli/src/helpers.ts`** with shared utilities
  - [x] `getProjectContext(options)` - wraps project root discovery + returns context
  - [x] `handleCliError(error)` - standardized error formatting with chalk + process.exit
  - [x] `logInvocationOutput(result)` - stdout/stderr logging
  - [x] `getStatusIcon(status)` / `getStatusColor(status)` - for doctor.ts output
  - [x] `formatCheckResults(checks, options)` / `outputDoctorSummary()` - doctor output

- [ ] **Refactor remaining CLI commands to use helpers** (partially complete)
  - [ ] `build.ts` (26 → ~15)
  - [x] `lint.ts` (51 → 0, fully refactored with helper functions)
  - [ ] `list.ts` (28 → ~15)
  - [ ] `remove.ts` (17 → ~12)
  - [ ] `upgrade.ts` (19 → ~12)
  - [ ] `repo/gc.ts` (22 → ~15)
  - [ ] `repo/init.ts` (20 → ~12)
  - [ ] `repo/publish.ts` (21 → ~15)

---

## Priority 2: High-Complexity CLI Commands

- [x] **Refactor `diff.ts`** (92 → 0, no warnings)
  - [x] Extract `buildSpacesMap(lock, targetName)` - builds Map from lock file
  - [x] Extract `computeDiffChanges(current, fresh)` - returns added/removed/updated
  - [x] Extract `formatDiffText()` / `formatChangeText()` - text formatting
  - [x] Extract `computeAllDiffs()` / `outputDiffs()` - orchestration functions

- [x] **Refactor `doctor.ts`** (73 → 0, no warnings)
  - [x] Extract `checkClaude()` - Claude binary check
  - [x] Extract `checkAspHome()` - ASP_HOME directory check
  - [x] Extract `checkDirectoryAccess(name, path)` - handles read/write fallback
  - [x] Extract `checkRegistry()` / `checkRegistryRemote()` - registry checks
  - [x] Extract `checkProject()` - project directory check
  - [x] Use shared `formatCheckResults()` / `outputDoctorSummary()` from helpers.ts

- [x] **Refactor `repo/status.ts`** (61 → 0, no warnings)
  - [x] Extract `ensureRegistryExists()` - registry existence check
  - [x] Extract `listSpaces()` / `loadDistTags()` - data loading
  - [x] Extract `formatGitChanges()` / `formatSpacesList()` - output formatting
  - [x] Extract `formatStatusText()` - main text formatter

- [x] **Refactor `run.ts`** (44 → 0, no warnings)
  - [x] Extract `isLocalSpacePath()` - local space detection
  - [x] Extract `detectRunMode(projectPath, target)` - project/global/dev mode detection
  - [x] Extract `runProjectMode()` / `runGlobalMode()` / `runDevMode()` - mode handlers
  - [x] Extract `showInvalidModeHelp()` - error display

- [ ] **Refactor `repo/tags.ts`** (36 → ~15 per function)
  - [ ] Extract `formatTagsOutput(tags, options)` - JSON vs text formatting

---

## Priority 3: Validation Refactoring

- [ ] **Refactor `packages/resolver/src/validator.ts`**
  - [ ] Extract `validateSpaceRefs(refs, errorCode, context)` - dedupe lines 52-70 & 105-122
  - [ ] Split `validateClosure` into 4 focused functions

- [ ] **Refactor `packages/claude/src/validate.ts`** (48, 34)
  - [ ] Extract `validatePluginDirectory(dir)` - directory existence check
  - [ ] Extract `validatePluginJson(dir, json)` - plugin.json structure validation
  - [ ] Extract `validateComponentPaths(dir, manifest)` - component path checks
  - [ ] Extract `validateHooksDirectory(dir)` - hooks/ validation
  - [ ] Split `validateHooksJson` - separate config vs hooks array validation

---

## Priority 4: Other Functions

- [ ] **Refactor `packages/git/src/repo.ts`** (34)
  - [ ] Split `getStatus` - Extract `parseBranchLine()` and `parseStatusLine()`

- [ ] **Refactor `packages/engine/src/explain.ts`** (20)
  - [ ] Split `formatExplainText` - Extract `formatSpaceExplanation(space)`

- [ ] **Refactor `packages/engine/src/run.ts`** (19, 21, 18)
  - [ ] `run`, `runGlobalSpace`, `runLocalSpace` - minor extraction

- [ ] **Refactor `packages/engine/src/install.ts`** (16)
  - [ ] `installNeeded` - just over limit, may not need changes

- [ ] **Refactor `packages/lint/src/rules/W202-agent-command-namespace.ts`** (19)
  - [ ] `checkAgentCommandNamespace` - extract pattern matching

---

## Priority 5: Test Utilities (Low Priority)

- [ ] **`packages/core/src/config/space-toml.test.ts`** - `toToml` (30)
  - Option A: Add `// biome-ignore` (acceptable for test utilities)
  - Option B: Use TOML serialization library

- [ ] **`packages/core/src/config/targets-toml.test.ts`** - `toToml` (29)
  - Same options as above

---

## Verification

After each priority block:
1. `bun run typecheck` - no type errors
2. `bun run test` - all tests pass
3. `bun run lint` - verify complexity reduction
4. Manual smoke test of affected commands

---

## Progress Summary

- **Before:** 62 warnings
- **After Priority 2 (partial):** 58 warnings (reduced by 4)
- Major files refactored:
  - `diff.ts`: 92 → 0 (no warnings)
  - `doctor.ts`: 73 → 0 (no warnings)
  - `lint.ts`: 51 → 0 (no warnings)
  - `repo/status.ts`: 61 → 0 (no warnings)
  - `run.ts`: 44 → 0 (no warnings)

### Key Approach
Created `packages/cli/src/helpers.ts` with shared utilities that multiple commands use:
- `getProjectContext()` - consolidated project context resolution
- `handleCliError()` - standardized error handling
- `logInvocationOutput()` - stdout/stderr logging
- `formatCheckResults()` / `outputDoctorSummary()` - doctor output helpers
- `getStatusIcon()` / `getStatusColor()` - status display helpers
