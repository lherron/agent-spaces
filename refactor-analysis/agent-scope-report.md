# 🔧 Refactoring Analysis
**Target:** packages/agent-scope/src  
**Lines analyzed:** 685 (source) + 1121 (tests)  
**Generated:** 2026-06-07  
**Focus:** all SOLID violations & code smells

## 📊 SOLID Scorecard
| Principle | Status | Issues |
|-----------|--------|--------|
| **S**ingle Responsibility | 🟡 | scope-ref.ts violates SRP: dual concerns (validation + parsing) across split functions; input.ts mixes resolution logic with parsing |
| **O**pen/Closed | 🟢 | No switch/if-else chains keyed on type enums that grow per new case |
| **L**iskov Substitution | 🟢 | No inheritance hierarchies or overrides in scope |
| **I**nterface Segregation | 🟢 | Types are focused; no fat service interfaces |
| **D**ependency Inversion | 🟢 | No hardcoded `new Concrete()` or hardcoded singletons; pure functions |

## 🎯 Priority Refactorings

### 1. Extract Duplicated scopeRef.split(':') Logic — SRP
- **Location:** scope-ref.ts:42, scope-ref.ts:118
- **Current:** `validateScopeRef` and `parseScopeRef` both independently split and parse the scopeRef string. Split is repeated; parsing logic mirrors part of validation.
- **Suggested:** Extract a shared internal `_parseScopeRefParts(scopeRef: string): { parts: string[], agentId: string, projectId?: string, taskId?: string, nextKey?: string, roleName?: string }` helper that both functions can reuse. This reduces duplication and ensures consistent parsing rules.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1-2 hours  ·  **Tests:** scope-ref.test.ts validates both paths; refactoring is safe as long as outputs remain identical.

### 2. Extract Duplicated validateToken Pattern — DRY / Code Smell
- **Location:** scope-handle.ts:77-93 (4 repeated blocks), scope-ref.ts:50-51, scope-ref.ts:62-63, scope-ref.ts:76-77, scope-ref.ts:86-87, scope-ref.ts:97-98
- **Current:** Repeating pattern: `const xErr = validateToken(x, 'label'); if (xErr) return { ok: false, error: xErr }` appears 5+ times in validateScopeRef alone, 4+ times in validateScopeHandle. No abstraction.
- **Suggested:** Create a helper `function validateTokenField(value: string, fieldName: string): ValidationResult` that returns the full ValidationResult, eliminating the repetitive if-check boilerplate.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1 hour  ·  **Tests:** scope-ref.test.ts, scope-handle.test.ts; all error messages remain unchanged.

### 3. Deep Nesting in validateScopeRef Function — Complexity / Readability
- **Location:** scope-ref.ts:41-106 (66 lines)
- **Current:** Function has 3-4 levels of nesting (if → nested checks for 'role' vs 'task' paths, each with internal validation blocks). Max nesting depth ≥4 detected in task branch (lines 81-100).
- **Suggested:** Extract logic for each scope kind into separate validation helpers: `validateAgentScope`, `validateProjectScope`, `validateRoleScope`, `validateTaskScope`. Or use a state machine approach with early returns for each kind. Reduces cyclomatic complexity from ~12 to ~3 per function.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 2-3 hours  ·  **Tests:** scope-ref.test.ts extensively covers all 5 scope kinds; refactoring requires verification of all edge cases (length checks, missing tokens, invalid segments).

### 4. parseScopeRef Duplicates Validation Logic — SRP Violation
- **Location:** scope-ref.ts:112-147
- **Current:** `parseScopeRef` calls `validateScopeRef` first (line 113), then re-parses the same parts independently (lines 118-146). The validation already checked structure; the parsing repeats part boundary logic.
- **Suggested:** Refactor to have `validateScopeRef` return a structured parse result (or pass) so `parseScopeRef` can skip re-splitting and directly map the validated parts to `ParsedScopeRef` kinds.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 2 hours  ·  **Tests:** scope-ref.test.ts, input.test.ts; both test the parse paths; ensure kind detection logic is tested for all 5 kinds.

### 5. Implicit Default Behavior in normalizeLaneRef & toLaneRef — Magic Value / Feature Envy
- **Location:** lane-ref.ts:27-36, input.ts:38-46
- **Current:** Both functions default to 'main' with no explicit parameter; the assumption that 'main' is the default is implicit in the logic. `toLaneRef` duplicates the same normalize logic as `normalizeLaneRef` but with a different flow (early return on 'main' vs. normalize call).
- **Suggested:** Consolidate logic; have `toLaneRef` call `normalizeLaneRef` directly if it receives a non-undefined string, or make the default explicit as a const `DEFAULT_LANE_ID = 'main'`.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1 hour  ·  **Tests:** input.test.ts, session-ref.test.ts; verify default lane is 'main' in all resolver outputs.

### 6. parseScopeInput Mixed Concerns — SRP (Minor)
- **Location:** input.ts:54-91 (38 lines)
- **Current:** Function handles three distinct input formats (SessionHandle with ~, ScopeHandle, ScopeRef) in sequence. While each branch is small, mixing three different parsing strategies in one function violates single responsibility.
- **Suggested:** Extract branches into `parseSessionInput`, `parseScopeHandleInput`, `parseScopeRefInput` helpers. `parseScopeInput` becomes a dispatcher that calls the right helper.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1-2 hours  ·  **Tests:** input.test.ts covers all three input types; refactoring is safe if outputs remain identical.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| **Duplicated code block** (split + validate token pattern) | scope-ref.ts:41–106, scope-handle.ts:70–96 | High |
| **Deep nesting** (≥4 levels) | scope-ref.ts:81–100 (validateScopeRef task branch) | Med |
| **Duplicated logic** (scopeRef.split(':')) | scope-ref.ts:42, 118 | Med |
| **Mixed concerns** (3 input format handlers) | input.ts:54–91 | Low |
| **Magic number / implicit default** | lane-ref.ts:28, input.ts:39 (assumes 'main' default) | Low |
| **Utility function redundancy** | lane-ref.ts:27–36 vs input.ts:38–46 (normalizeLaneRef vs toLaneRef) | Low |
| **Type assertion** (unsafe cast) | scope-ref.ts:5 (`parts[i] as string`) | Low |

## 🚀 Quick Wins (low risk, high value)

1. **Refactor validateTokenField helper (1 hour, Low risk)**  
   Eliminates 5+ code repetitions in scope-ref.ts and scope-handle.ts. Improves readability.

2. **Deduplicate scope-ref.split(':') calls (1 hour, Low risk)**  
   Extract to a shared parser; both validateScopeRef and parseScopeRef reuse it. Reduces mutation and ensures consistency.

3. **Consolidate lane default logic (1 hour, Low risk)**  
   Merge toLaneRef and normalizeLaneRef; remove implicit default assumption.

## ⚠️ Technical Debt Notes

- **Complexity hotspot:** scope-ref.ts validateScopeRef function is the package's highest cyclomatic complexity due to branching on scope kind. Consider simplifying via dispatch table or extracted helpers before adding new scope kinds.
- **Test coverage:** 1121 lines of tests for 685 lines of source (1.6:1 ratio) is healthy. All refactorings have high test coverage.
- **Type safety:** Use of `parts[i] as string` in scope-ref.ts:5 is a code smell; consider extracting as a safer helper with bounds checking or using `.at()` once TS 4.4+ is standard.
- **Future scalability:** If scope refs grow to support additional qualifiers (e.g., workspace, context), the branching logic in validateScopeRef and parseScopeRef will become unmaintainable. Recommend refactoring to a declarative schema or state machine *before* adding more kinds.

---

**Generated by Refactoring Analysis Tool**  
Focus: SOLID principles, code smells, long functions, deep nesting, duplication  
No files modified (read-only analysis).
