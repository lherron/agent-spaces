# Refactoring Analysis
**Target:** packages/harness-pi/src  
**Lines analyzed:** 1550  ·  **Generated:** 2026-06-07  ·  **Focus:** all

## SOLID Scorecard
| Principle | Status | Issues |
|-----------|--------|--------|
| SRP (Single Responsibility) | 🟡 | PiAdapter has 17 methods spanning 786 lines; buildRunArgs mixes arg construction, path resolution, and conditional logic (102 lines) |
| OCP (Open/Closed) | 🟢 | Good use of interface-based composition; PI_EVENT_MAP and LINT_ONLY_FACETS are extension points |
| LSP (Liskov Substitution) | 🟢 | Proper interface implementation; no type checks in overrides |
| ISP (Interface Segregation) | 🟢 | Focused, minimal interfaces (HookDefinition, PiInfo, ExtensionBuildOptions all < 10 members) |
| DIP (Dependency Inversion) | 🟡 | Hardcoded singleton `piAdapter` instance; direct instantiation in module scope; tight coupling to spaces-config imports |

## Priority Refactorings

### 1. Extract CLI Argument Builder — SRP Violation
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/harness-pi/src/adapters/pi-adapter.ts:603-704
- **Current:** `buildRunArgs()` is 102 lines and handles: system prompt injection, extension discovery, hook bridge detection, skill merging, model translation, session continuation, interactive mode, and extra args.
- **Suggested:** Extract a separate `PiCliArgumentBuilder` class with focused methods:
  ```typescript
  class PiCliArgumentBuilder {
    addPromptArgs(args, options): void
    addExtensionArgs(args, piBundle, extensionsDir): void
    addSkillArgs(args, piBundle): void
    addModelArgs(args, model): void
    addContinuationArgs(args, options, bundle): void
  }
  ```
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 2-3 hours  ·  **Tests:** Update `buildRunArgs` unit tests to verify builder integration; add builder unit tests.

### 2. Extract Merge Logic to Separate Class — SRP Violation
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/harness-pi/src/adapters/pi-adapter.ts:365-486
- **Current:** Three similar `mergeX()` private methods (extensions, skills, hooks) with 45-46 lines each; duplicated `for (const artifact of input.artifacts)` + try-catch + mkdir pattern; only mergeExtensions handles collision detection.
- **Suggested:** Create a `PiTargetMerger` class:
  ```typescript
  class PiTargetMerger {
    async mergeExtensions(input, outputDir, warnings): Promise<string>
    async mergeSkills(input, outputDir): Promise<string>
    async mergeHooks(input, outputDir): Promise<HookDefinition[]>
    private async mergeComponentDir(srcPath, destPath, artifacts): Promise<void>
  }
  ```
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 2-3 hours  ·  **Tests:** Verify merge behavior with fixture artifacts; test collision warnings; test graceful missing-dir handling.

### 3. Move Hook-Bridge Codegen to Separate Module — SRP Violation
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/harness-pi/src/adapters/pi-adapter.ts:492-521 + codegen/hook-bridge.ts:104-228
- **Current:** `writeBridges()` (30 lines) orchestrates hook bridge + HRC events bridge generation; hook-bridge.ts's `generateHookBridgeCode()` contains a 120+ line template string with embedded loop/conditional/spawn logic; tight coupling between bridge generation and warnings.
- **Suggested:** 
  - Extract `BridgeCodeGenerator` class for template maintenance
  - Move W301 (blocking hooks) warning logic into the generator
  - Split codegen/hook-bridge.ts into: hook-bridge-generator.ts (code gen) + hook-script-resolver.ts (path resolution)
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 3-4 hours  ·  **Tests:** Verify generated bridge code structure; test all PI_EVENT_MAP cases; test blocking-hook warnings; test script path resolution edge cases.

### 4. Extract Permission Linting to Separate Class — SRP Violation
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/harness-pi/src/adapters/pi-adapter.ts:566-596
- **Current:** `lintPermissions()` and `collectLintOnlyFacets()` are tightly coupled to LINT_ONLY_FACETS constant; read permissions for every artifact, then emit warnings; duplication of facet iteration logic.
- **Suggested:** Extract `PermissionLinter` class:
  ```typescript
  class PermissionLinter {
    async lintArtifacts(artifacts): Promise<LockWarning[]>
    private collectLintOnlyFacets(piPerms): string[]
  }
  ```
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1.5-2 hours  ·  **Tests:** Test facet collection with various permission configs; test warning generation.

### 5. Simplify Hook Definition Transformation — Code Smell (Feature Envy)
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/harness-pi/src/adapters/pi-adapter.ts:464-476
- **Current:** In `mergeHooks()`, a loop manually copies hook properties into a new HookDefinition object, even though the source hook already has those fields. This is unnecessary copying with only script path transformation.
- **Suggested:** Inline the transformation or extract a dedicated mapper:
  ```typescript
  function transformHook(hook, scriptPath): HookDefinition {
    return { ...hook, script: scriptPath }
  }
  ```
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 30 mins  ·  **Tests:** Verify transformed hooks retain all fields.

### 6. Extract Component Directory Paths to Constants — Magic Strings
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/harness-pi/src/adapters/pi-adapter.ts:249, 286, 294, 304-305, 412, 449, and throughout
- **Current:** Directory names 'extensions', 'skills', 'hooks-scripts', 'scripts', 'shared' are hardcoded in 15+ locations across materialize and compose methods.
- **Suggested:** Add to constants.ts:
  ```typescript
  export const COMPONENT_DIR_NAMES = {
    EXTENSIONS: 'extensions',
    SKILLS: 'skills',
    HOOKS: 'hooks-scripts',
    SCRIPTS: 'scripts',
    SHARED: 'shared',
  } as const
  ```
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1 hour  ·  **Tests:** Verify directory creation and merging still works.

## Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Long method (102 lines) | buildRunArgs():603-704 | Medium |
| Duplicated loop + try-catch pattern | mergeExtensions/Skills/Hooks | Medium |
| Deep nesting (4 levels) in mergeExtensions | line 376-403 | Low |
| Deep nesting (4 levels) in buildRunArgs | line 677-688 (session dir ternary) | Low |
| Magic strings ('extensions', 'skills', etc.) | 15+ occurrences throughout | Low |
| Unused variable `sourceExtensions` potential issue | bundleSpaceExtensions:252 | Very Low |
| Catch blocks swallow all errors | mergeExtensions/Skills/Hooks:400-401 | Low (intentional but brittle) |
| Template string complexity in hook-bridge codegen | codegen/hook-bridge.ts:114-193 | Medium |
| Implicit API casting | pi-adapter.ts:610, 234 | Low (type-safe but repetitive) |

## Quick Wins (low risk, high value)

1. **Move directory names to constants** (1 hour, Low risk)
   - Define COMPONENT_DIR_NAMES in constants.ts
   - Replace all hardcoded 'extensions', 'skills', 'hooks-scripts' strings
   - Improves maintainability and reduces typo risk

2. **Inline trivial hook transformation** (30 mins, Low risk)
   - Replace the manual property copy loop in mergeHooks() with object spread
   - Reduces 7-line boilerplate to 1 line

3. **Extract path resolution to helper** (1 hour, Low risk)
   - Move buildRunArgs session dir computation to a named function
   - Reduces cognitive load of the 7-line ternary/join chain

4. **Add JSDoc to private merge methods** (30 mins, Very low risk)
   - Document the try-catch-continue pattern for missing dirs
   - Clarify artifact iteration and why errors are swallowed

## Technical Debt Notes

- **Singleton pattern risk:** `piAdapter` is instantiated at module scope (line 786). If state mutates (cachedPiInfo in detect.ts), it could leak across test isolation. Consider injection or lazy initialization.

- **Hardcoded event mapping:** PI_EVENT_MAP in hook-bridge.ts is not versioned and may diverge from Pi's actual event names. Consider reading from `pi --help` or a manifest.

- **Silent error handling:** Multiple catch blocks swallow non-ENOENT errors in merge methods, making debugging harder. Distinguish between "dir missing" (expected) and "permission denied" (unexpected).

- **Type casting for bundle extensions:** The `as typeof bundle.pi & { hrcEventsBridgePath?: ... }` casts (lines 610, 760) suggest the type contract could be clearer. Consider formalizing hrcEventsBridgePath in the bundle interface.

- **Assumptions about Pi CLI stability:** buildRunArgs hardcodes 12+ flags/values that may change between Pi versions. Consider feature-detection based on `pi --version` or `pi --help` output, similar to the detect.ts pattern.

- **Untested edge cases:**
  - No-extensions + no-skills composition
  - Collision handling when three or more spaces provide the same extension
  - Hook scripts that fail with non-zero exit but are marked blocking=true (W301)
  - Session dir creation failure in buildRunArgs

