# Refactoring Analysis

**Target:** packages/spaces-runtime-contracts/src  
**Lines analyzed:** 3,047  
**Generated:** 2026-06-07  
**Focus:** SOLID principles & code smells

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| **SRP** (Single Responsibility) | 🟢 | None — each file/type has clear, focused purpose |
| **OCP** (Open/Closed) | 🟢 | None — extensibility via composition & type unions, no switch-bloat |
| **LSP** (Liskov Substitution) | 🟢 | None — no class hierarchies; all composition-based |
| **ISP** (Interface Segregation) | 🟢 | None — interfaces are small and focused; no fat contracts |
| **DIP** (Dependency Inversion) | 🟢 | None — pure contract types, no hardcoded dependencies |

---

## 🎯 Priority Refactorings

### 1. Extract Diagnostic Factory in validate-execution-profile.ts — SRP

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/spaces-runtime-contracts/src/validate-execution-profile.ts:12–23`
- **Current:** Helper function `executionProfileDiagnostic()` is well-designed, but diagnostic construction is repeated inline across ~50+ rule invocations (lines 33–450). Each rule must manually construct diagnostic objects.
- **Suggested:** Already partially mitigated by the helper function. However, consider extracting rule-factory builders to reduce boilerplate further:
  - Create `createTerminalValidationRules()`, `createBrokerProtocolRules()`, etc. as factory functions
  - Parameterize rule message templates to reduce string duplication
  - This improves maintainability when adding new broker drivers
- **Risk:** Low  
- **API-impact:** internal-only  
- **Effort:** 1–2 hours  
- **Tests:** validate-execution-profile.test.ts — no changes; all rule invocations remain the same

### 2. Consolidate Base Capability Definitions in compile-fixtures.ts — DRY

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/spaces-runtime-contracts/src/compile-fixtures.ts:24–82`
- **Current:** `BASE_INPUT_CAPABILITIES`, `BASE_TURNS_CAPABILITIES`, `BASE_CONTINUATION_CAPABILITIES` are defined as constants. The same base blocks are reconstructed in `BASE_INVOCATION_INPUT_BLOCKS` (lines 73–77), creating implicit coupling and duplication.
- **Suggested:** 
  - Move all three base-block constants to a dedicated `capabilities-fixtures.ts` or re-export from a shared fixtures module
  - Reference the same constants in both runtime and invocation capability definitions
  - Add JSDoc explaining the shared nature to prevent future drift
- **Risk:** Low  
- **API-impact:** internal-only  
- **Effort:** 30 minutes  
- **Tests:** compile-fixtures.test.ts — no logic changes; snapshot tests may update fixture references

---

## 📝 Code Smells

| Smell | Location | Severity | Notes |
|-------|----------|----------|-------|
| **Repeated Diagnostic Pattern** | validate-execution-profile.ts, lines 33–450 | Low | ~50 inline diagnostic calls follow the same pattern. Already mitigated by helper `executionProfileDiagnostic()`, but could reduce further with rule factories. |
| **Implicit Data Drift** | compile-fixtures.ts, lines 24–82 | Low | BASE_CAPABILITIES duplicated between runtime and invocation fixtures. No active drift observed, but future maintainers may forget to keep them in sync. |
| **Large Object Literal** | compile-fixtures.ts, lines 155–316 | Very Low | `compileOnlyRuntimeRouteDecision` and `durableUnixBrokerRuntimeState` are ~160 lines each. This is acceptable for fixture data—not a code smell. |
| **Conditional Type Narrowing** | validate-execution-profile.ts, lines 91–104 | Very Low | `exposurePoliciesMatch()` uses conditional checks and type narrowing. Acceptable; logic is clear and matches domain semantics. |

---

## 🚀 Quick Wins (low risk, high value)

1. **Add JSDoc to BASE_CAPABILITIES in compile-fixtures.ts** (5 min)
   - Document that these blocks must be kept in sync across fixtures
   - Prevents silent future drift

2. **Extract rule-factory pattern for broker drivers** (1–2 hours)
   - Move BROKER_PROTOCOL_RULES, CODEX_APP_SERVER_RULES, etc. into factory functions
   - Reduces boilerplate when adding new broker drivers (e.g., `createBrokerRule()`)
   - Improves testability of individual rule chains

3. **Add type guard utilities for profile narrowing** (optional, low urgency)
   - Functions like `isTmuxBrokerExposurePolicy()` and `isNoneExposurePolicy()` are well-written
   - Consider extracting to a `exposure-policy-guards.ts` for reuse

---

## ⚠️ Technical Debt Notes

### Strengths
- **Excellent contract-first design:** Pure type definitions with minimal implementation logic
- **Clear separation of concerns:** Each file owns one contract area (execution-profile, capabilities, permissions, etc.)
- **No god objects or fat interfaces:** All types are focused and composable
- **Strong extensibility:** New execution profile kinds, broker drivers, and capabilities are added via type unions (not enum-switch sprawl)

### No Violations Detected
- ✓ No single-responsibility violations
- ✓ No switch/if-else chains that grow per type
- ✓ No Liskov substitution violations (no inheritance)
- ✓ No fat interfaces; no unused method stubs
- ✓ No hardcoded dependencies; no singletons

### Minor Style Considerations
- Some TypeScript files are pure type exports (e.g., `primitives.ts`, `ids.ts`, `exposure.ts`). This is appropriate for a contract package.
- The `hash.ts` implementation (serialize function) is complex but well-documented; no refactor needed.
- Type parameter names in some generics are terse (`TDecision`, `JsonValue`); consider expanding for clarity in IDE hover-hints, but not essential.

---

## Summary

**This package is architecturally sound and follows SOLID principles exceptionally well.** It is a pure contract/types package with minimal implementation logic, making it resistant to most common refactoring needs. 

The only candidates for improvement are cosmetic:
1. DRY principle improvements in fixture definitions (consolidate base capability blocks)
2. Boilerplate reduction in validation rules (extract rule factories)

Both are **internal-only** and **low-risk** refactorings. No changes to public APIs or external contracts are needed.
