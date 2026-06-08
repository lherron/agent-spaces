# Refactoring Analysis
**Target:** packages/execution/src
**Lines analyzed:** 3822  ·  **Generated:** 2026-06-07  ·  **Focus:** all

## Summary
The execution package is a well-structured orchestration layer for harness integration and runtime execution. Most files follow single responsibility principles with clear separation of concerns. However, several files exhibit moderate-to-high complexity due to orchestration requirements and environmental handling. No major SOLID violations detected, but refactoring opportunities exist around conditional branching and function parameter count.

## SOLID Scorecard
| Principle | Status | Issues |
|-----------|--------|--------|
| **S** - Single Responsibility | 🟡 | `run.ts` (465 lines), `space-launch.ts` (443 lines), `agent-brain.ts` (435 lines) mix orchestration with environment setup; parameter aggregation functions |
| **O** - Open/Closed | 🟢 | Adapter pattern well-used; harness registry enables extension without modification |
| **L** - Liskov Substitution | 🟢 | No type guards, overrides dropping behavior, or invalid implementations detected |
| **I** - Interface Segregation | 🟢 | Context/options interfaces appropriately sized; no implementors stubbing unused methods |
| **D** - Dependency Inversion | 🟡 | `harnessRegistry.getOrThrow()` called directly in 8+ locations; could centralize. Environment globals in util.ts defaults to process.env |

---

## Priority Refactorings

### 1. Extract orchestration concerns from `run.ts` — SRP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/execution/src/run.ts:140-439`
- **Current:** The `run()` function orchestrates 20+ concerns: manifest loading, runtime planning, compilation, identity resolution, system prompt materialization, bundle caching, harness execution, and result assembly. The function spans 300 lines with 7+ nested conditional blocks.
- **Suggested:** Extract phases into separate orchestration functions:
  - `resolveProjectRuntime()`: manifest → plan → adapter
  - `ensureProjectBundle()`: caching logic + install decision
  - `assembleProjectEnvironment()`: identity + system prompt + budget
  - `executeProjectRun()`: compilation + harness spawn
  This preserves the top-level orchestration while moving domain logic to reusable phases.
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** Medium (6-8h)  ·  **Tests:** `run.test.ts` covers happy path; new phase tests required to validate extraction without behavioral change

### 2. Consolidate harnessRegistry access patterns — DIP
- **Location:** Multiple: `run.ts:184`, `space-launch.ts:280`, `placement-plan.ts:184`, `agent-profile.ts` (loading), `index.ts:123+` (5 wrappers)
- **Current:** `harnessRegistry.getOrThrow(harnessId)` repeated 8+ times across the codebase. Each site must know the registry exists and how to resolve adapters. No injection seam.
- **Suggested:** Introduce a `ResolvedAdapter` helper function or create a minimal `AdapterResolver` abstraction that encapsulates registry lookup with consistent error handling. Inject via function parameter or context.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** Low (2-3h)  ·  **Tests:** grep for `getOrThrow` calls; update tests to use helper; no behavior change

### 3. Extract conditional harness branching in `execute.ts` — OCP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/execution/src/run/execute.ts:174-220`
- **Current:** The main launch path splits on `runOptions.launchSurface === 'codex-app'` (lines 183–219), repeating the pattern for env/args/command resolution. If more surfaces are added, the if/else tree grows.
- **Suggested:** Define a `LaunchSurfaceStrategy` interface with `resolveLaunch(bundle, options) → LaunchConfig` and inject strategies per surface type. Registry maps surface type → strategy.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** Medium (4-5h)  ·  **Tests:** `execute.ts` has no direct tests; integration tests cover both paths; verify dry-run and interactive modes still work

### 4. Reduce function parameter count in `planPlacementRuntime` — SRP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/execution/src/run/placement-plan.ts:204-270`
- **Current:** `planPlacementRuntime()` takes 1 options bag with 7 fields. Inside, `resolvePlacementRuntimeModel()` (line 102) takes 4 parameters; callers must manually assemble context.
- **Suggested:** Introduce intermediate `PlacementRuntimeResolution` interface to bundle environment checks (supportedModels, effectiveConfig) so parameter list shrinks to 2 (options + resolved context). Extract model resolution into its own pure function with fewer deps.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** Low (2-3h)  ·  **Tests:** No direct test; exercise via harness detection + run paths

### 5. Decouple environment default from process.env in `util.ts` — DIP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/execution/src/run/util.ts:70-77` (`resolveRunEnvFlags`)
- **Current:** Functions default to `process.env` without allowing callers to inject. Tests must mock process.env globally or can't test feature gates in isolation. `compileInteractionMode()` in `compiler-debug.ts:44` uses `harnessId` parameter but doesn't accept env.
- **Suggested:** Pass env as explicit (non-optional) parameter to `resolveRunEnvFlags()`, `isViaCompiler()`, and similar. Callers provide process.env or test env; tests no longer rely on global side effects.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** Low (1-2h)  ·  **Tests:** Grep for global mocks in test files; each site gains a new param; verify feature gates still work end-to-end

### 6. Extract brain/tool runtime preparation concerns — SRP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/execution/src/run/execute.ts:201-209` (interleaved with command building)
- **Current:** Brain and tool runtime setup (lines 201–209) is sandwiched between harness env composition and cwd resolution. Responsibility blending: env assembly + special-case I/O for two agent runtimes.
- **Suggested:** Extract `prepareAgentRuntimes(agentOptions, harnessEnv) → {env, warnings}` so execute.ts orchestrates only: detect launch surface → collect env → materialize agent layers → spawn. Agent setup becomes a black box.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** Low (2h)  ·  **Tests:** Tool and brain runtime tests already exist; ensure warnings propagate correctly

---

## Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| **Long function (>50 lines)** | `run.ts:140-439` (300 lines), `space-launch.ts:273-349` (77 lines), `agent-brain.ts:80-125` (46 lines) | Medium |
| **Deep nesting (>=4 levels)** | `run.ts:215-247` (if/materialize branch), `space-launch.ts:312-348` (artifact materialization loop) | Medium |
| **Magic numbers** | `agent-tools.ts:22, 24, 26` (SHEBANG_* constants well-named), `run-codex.ts:40` (CODEX_RUNTIME_KEY_LENGTH=24 unexplained), `prompt-display.ts:15, 17` (FRAME_WIDTH, THRESHOLD thresholds) | Low |
| **Duplicated blocks** | `run.ts:322-350` (placement literal repeated for agent vs non-agent), `space-launch.ts:112-142` (similar compiler context build) | Medium |
| **Long parameter lists (>4)** | `planPlacementRuntime` (7 in options), `buildCodexAppLaunch` (2 + options), `executeHarnessRun` (5 + options) | Low-Medium |
| **Feature envy** | `run.ts:256-296` (identity resolution reaches into agentProfile internals, then system prompt materialization does same), `placement-plan.ts:102-128` (model resolution coupled to adapter knowledge) | Medium |
| **Conditional complexity (if-else chains)** | `execute.ts:183-219` (codex-app surface branching), `compiler-debug.ts:30-41` (harness ID normalization via switch) | Low |

---

## Quick Wins (low risk, high value)

### 1. Consolidate `resolveRunEnvFlags()` call sites
- **Files affected:** `run.ts:141`, `space-launch.ts:106`
- **Change:** Both call `resolveRunEnvFlags()` and destructure `{ debugRun, viaCompiler }`. Extract a shared `resolveRunContext()` or pass the result through the orchestration chain to avoid redundant work.
- **Risk:** Low  ·  **Effort:** < 1h

### 2. Replace magic numbers in prompt-display.ts
- **Lines:** 15 (FRAME_WIDTH=72), 17 (LONG_ARG_THRESHOLD=200)
- **Change:** Already has well-named constants. Document why these thresholds (e.g., "FRAME_WIDTH: 72-char typical terminal, LONG_ARG_THRESHOLD: hide prompts >200 chars for readability").
- **Risk:** Very Low  ·  **Effort:** < 0.5h

### 3. Simplify `findSourcePathInJsonValue()` recursion in agent-brain.ts
- **Lines:** 358–395
- **Change:** Add early-exit conditions and a visited set to prevent infinite recursion on cyclic JSON structures (currently possible but unlikely). Document the assumption that gbrain sources output is acyclic.
- **Risk:** Low  ·  **Effort:** 1h

### 4. Remove unused `isRecord()` type guard pattern
- **Location:** `agent-brain.ts:429–430` (used 3 times)
- **Change:** Function is well-implemented. Consider moving to a shared utils file if used elsewhere in the codebase (currently not).
- **Risk:** Very Low  ·  **Effort:** < 0.5h

---

## Technical Debt Notes

### 1. Harness adapter polymorphism still growing
The `HarnessAdapter` interface (imported from spaces-config) has no versioning or deprecation strategy. New adapters must implement all methods; no graceful fallback for older clients. Over time, adding adapter features will require changes across all implementations.
**Mitigation:** Consider a version-aware adapter loader or a decorator pattern to wrap adapters with optional-method facades.

### 2. System prompt materialization budget tracking
The `RunSystemPromptBudget` interface (identity.ts) collects 6 optional numeric fields that track context window usage. This is scattered across return types (RunResult, MaterializeRunSystemPromptResult). If budget calculations change, multiple sites must update.
**Mitigation:** Consider a `SystemPromptBudgetCalculator` service that owns all budget logic, reducing data propagation.

### 3. Codex-specific logic scattered
Files touch Codex via:
- `run-codex.ts:273-284` (prepareRunOptions branching on adapter.id === 'codex')
- `execute.ts:183-219` (codex-app surface branching)
- `run.ts:197-199` (codex migration)
Each site reimplements the "if codex, do X" check without a central registry.
**Mitigation:** Consider a `CodexAdapter` wrapper or a `LegacyCodexBridge` module that centralizes all Codex-specific behavior.

### 4. No integration test for via-compiler path
The `ASP_RUN_VIA_COMPILER` feature gate (util.ts) conditionally drives foreground spawns via compiled plans. This path is only tested if compileRuntime is injected. End-to-end tests should verify compiled vs. legacy spawns produce the same result.
**Mitigation:** Add a test harness that mocks compileRuntime with known output and verifies launch shape parity.

### 5. Agent tool validation is eager but warnings non-blocking
`validateAgentTools()` (agent-tools.ts:128-178) throws on invalid names/perms but only warns on missing shebangs. This asymmetry may lead to runtime failures if warnings are ignored.
**Mitigation:** Consider a severity tier or a separate "strict mode" flag for validation.

---

## Files Summary

| File | Lines | Role | Health |
|------|-------|------|--------|
| `run.ts` | 465 | Main orchestration for project-target runs | 🟡 Complex orchestration, long function |
| `space-launch.ts` | 443 | Orchestration for space-based runs | 🟡 Similar orchestration pattern |
| `agent-brain.ts` | 435 | GBRAIN runtime setup (init, sources, gating) | 🟢 Well-structured for complexity |
| `prompt-display.ts` | 292 | Terminal rendering for prompts/commands | 🟢 Focused, minimal deps |
| `execute.ts` | 288 | Harness invocation and launch | 🟡 Conditional branching on surface type |
| `run-codex.ts` | 284 | Codex-specific runtime home setup | 🟡 Feature-specific module, tightly coupled |
| `placement-plan.ts` | 270 | Harness placement and model resolution | 🟢 Pure functions, clear dependencies |
| `agent-tools.ts` | 200 | Agent tool validation and env setup | 🟢 Focused validation logic |
| `index.ts` | 197 | Public API re-exports and wrappers | 🟢 Clear wrapper pattern |
| `agent-profile.ts` | 165 | Agent profile loading and defaults | 🟢 Config resolution, minimal I/O |
| `util.ts` | 158 | Shared utilities (env gates, param mapping) | 🟢 Pure functions |
| `types.ts` | 151 | Type definitions | 🟢 Well-organized |
| `identity.ts` | 151 | Run identity and system prompt materialization | 🟡 Balanced; template expansion mixed with budget tracking |
| `compiler-debug.ts` | 137 | Compiler invocation and debug context | 🟢 Clear translation layer |
| `pager.ts` | 92 | Terminal pagination | 🟢 Single-purpose utility |
| Others | <100 | Minimal re-exports, harness registry | 🟢 Well-scoped |

---

## Refactoring Difficulty Rating

- **Low-effort (1-2h):** Registry consolidation, env injection, parameter reduction, quick wins
- **Medium-effort (4-8h):** Orchestration extraction, surface strategy pattern, agent runtime extraction
- **High-effort (12+h):** Codex bridge, system prompt budget refactoring, full integration test suite

**Recommended order:** Quick wins → Low-effort consolidation → Medium-effort extraction (if SRP budget allows)
