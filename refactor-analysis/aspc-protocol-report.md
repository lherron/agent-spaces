# 🔧 Refactoring Analysis

**Target:** packages/aspc-protocol/src  
**Lines analyzed:** 501  ·  **Generated:** 2026-06-07  ·  **Focus:** all

---

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| **S** - Single Responsibility | 🟡 | `schemas.ts` (378 lines) mixes validation orchestration, low-level type checking, and error handling in one file |
| **O** - Open/Closed | 🟢 | Well-designed: validator dispatch table (`ASPC_PARAMS_VALIDATORS`) allows new methods without modifying core logic |
| **L** - Liskov Substitution | 🟢 | Exception hierarchy properly structured; `AspcValidationError` abstract base with typed subclasses |
| **I** - Interface Segregation | 🟡 | `AspcCommand` union type (4 variants) centralizes all request types; no fat interfaces but type repetition across response variants |
| **D** - Dependency Inversion | 🟢 | No hardcoded dependencies; clean imports from `spaces-harness-broker-protocol` and `spaces-runtime-contracts` |

---

## 🎯 Priority Refactorings

### 1. Extract Validation Primitives into Separate Module — SRP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/aspc-protocol/src/schemas.ts:286-378`
- **Current:** Low-level validation helpers (`requireRecord`, `coerceRecord`, `requireString`, `optionalString`, `requireStringArray`, `requireLiteral`, `path`, `issue`) are co-located with high-level orchestration logic (method validators, request validators, error classes).
- **Suggested:** Extract primitives into `schemas-primitives.ts` or `validation-primitives.ts`. This isolates 93 lines of reusable, generic validation infrastructure from 85 lines of ASPC-specific validation logic.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1 hour  ·  **Tests:** No test changes required; same exports, cleaner surface.

### 2. Consolidate Validation Error Classes with Factory Pattern — SRP + DRY
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/aspc-protocol/src/schemas.ts:32-81`
- **Current:** Five nearly-identical error classes (`AspcHelloRequestValidationError`, `AspcCompileRuntimePlanRequestValidationError`, `AspcCompileHarnessInvocationRequestValidationError`, `AspcCommandValidationError`), each repeating name/code/message pattern. Minimal variation (code string, name string).
- **Suggested:** Introduce a factory function or constructor overload to DRY the boilerplate. Example: `createAspcValidationError('AspcHelloRequestValidationError', 'INVALID_ASPC_HELLO_REQUEST', 'Invalid ASPC hello request', issues)`. Alternatively, use a parameterized `AspcValidationError` with static factory methods.
- **Risk:** Medium  ·  **API-impact:** public-surface (instanceof checks may break)  ·  **Effort:** 2 hours  ·  **Tests:** Update all tests that use `instanceof` or catch specific error types; verify error codes in response serialization.

### 3. Eliminate Repetition in Nested Validation Functions — DRY
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/aspc-protocol/src/schemas.ts:248-284`
- **Current:** `validateOptionalBooleanRecord` and `validateStringRecord` follow the same pattern:
  1. Check if undefined, return
  2. `requireRecord(value, basePath, issues)`
  3. Iterate entries, validate type, push issue if invalid
  
  This pattern repeats inline validation across 35 lines that could be parameterized.
- **Suggested:** Extract a higher-order validator factory: `createRecordValidator<T>(typeCheck: (v: unknown) => v is T, typeName: string)` or a more generic `validateDictionary(value, basePath, itemValidator)`.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1.5 hours  ·  **Tests:** Same private functions; no test changes needed.

### 4. Long Parameter Lists in Validator Chain — Code Smell
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/aspc-protocol/src/schemas.ts:159-246`
- **Current:** Most validator functions take `(value: unknown, basePath: string, issues: ValidationIssue[])` — 3 params consistently. This is acceptable but the `basePath` threading and `issues` accumulation create a mutation pattern that feels procedural.
- **Suggested:** Consider a `ValidationContext { basePath: string; issues: ValidationIssue[] }` object to reduce parameter count and clarify intent. Alternatively, return partial validation state instead of mutating `issues[]` in-place.
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** 3 hours  ·  **Tests:** No logic change; same outcomes, cleaner control flow.

### 5. Magic Literal Strings in Type Definitions — Code Smell
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/aspc-protocol/src/types.ts:40-121`
- **Current:** Literal strings like `'aspc-compile-harness-invocation-response/v1'` and `'aspc-compile-and-start-response/v1'` appear in response type unions (lines 91, 101, 111, 117) but are not defined as named constants. The `ASPC_PROTOCOL_VERSION` constant exists (line 16) but version literals in response types are inlined.
- **Suggested:** Extract response schema version strings to named constants (`ASPC_COMPILE_HARNESS_INVOCATION_RESPONSE_VERSION`, etc.) at the top of types.ts, alongside `ASPC_PROTOCOL_VERSION`.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 0.5 hours  ·  **Tests:** No test changes; type definitions only.

### 6. Deeply Nested Type Unions in Response Objects — Code Smell (Complexity)
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/aspc-protocol/src/types.ts:89-121`
- **Current:** `AspcCompileHarnessInvocationResponse` and `AspcCompileAndStartResponse` are deeply nested `{ schemaVersion, ok, ... } | { schemaVersion, ok: false, ... }` unions. The success branch extracts from parent types via `Extract<>`, which is correct but makes the shape hard to visualize.
- **Suggested:** Define explicit named types: `AspcCompileHarnessInvocationResponseSuccess` and `AspcCompileHarnessInvocationResponseFailure`, then union them. This improves discoverability and reduces cognitive load for consumers.
- **Risk:** Low  ·  **API-impact:** public-surface (if consumers rely on exact union shape)  ·  **Effort:** 1 hour  ·  **Tests:** Update imports in any code that destructures or types response objects.

### 7. Inconsistent Optional Field Patterns — Code Smell
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/aspc-protocol/src/types.ts:40-87`
- **Current:** Mixed optional syntax: some fields use `| undefined` (line 43, 73), others omit it (line 52, 84). TypeScript allows both but inconsistency reduces readability.
- **Suggested:** Standardize to `| undefined` or use `?:` optional property syntax consistently throughout the file.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 0.5 hours  ·  **Tests:** No test changes.

---

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| **Long method** | `validateHello` (lines 159–187) | Medium — 29 lines, multi-step validation with conditional nesting |
| **Long method** | `validateCompileHarnessInvocation` (lines 201–212) | Low — 12 lines but calls `validateCompileRuntimePlan` first, creating implicit dependency chain |
| **Duplicated logic** | `validateOptionalBooleanRecord` + `validateStringRecord` (lines 248–284) | Medium — ~18 lines each, same pattern applied to different types |
| **Magic numbers** | ISSUE_CODE literals (lines 20–24) | Low — Defined as constants but not exported; limited reusability |
| **Primitive obsession** | `basePath: string` threaded through all validators | Medium — String concatenation for path tracking instead of structured path object |
| **Feature envy** | Error classes lean on `ValidationIssue` type from upstream package | Low — Acceptable; clear dependency, not circular |
| **Mutable accumulator pattern** | `issues: ValidationIssue[]` mutated in every validator | Low — Functional style would be cleaner; current pattern is performant but side-effect-heavy |

---

## 🚀 Quick Wins (Low Risk, High Value)

1. **Extract response schema version constants** (30 mins)
   - Define `ASPC_COMPILE_HARNESS_INVOCATION_RESPONSE_VERSION = 'aspc-compile-harness-invocation-response/v1'` etc. at top of types.ts
   - Replace inline string literals in response type definitions
   - Impact: Improves DRY, reduces copy-paste risk for future response versioning

2. **Standardize optional syntax in types.ts** (15 mins)
   - Choose `| undefined` or `?:` and apply consistently across all interfaces
   - Impact: Improves readability, reduces cognitive load for API consumers

3. **Export ISSUE_CODE constants** (10 mins)
   - Currently `ISSUE_CODE` is private; make it public if consumers need to reference error codes
   - If not, add a comment explaining intentional privacy
   - Impact: Clarifies intent, enables reuse in validators or tests

---

## ⚠️ Technical Debt Notes

### Validation Architecture
- The validator dispatch pattern (`ASPC_PARAMS_VALIDATORS`) is excellent: it couples new methods to their validators compile-time and prevents method/validator drift.
- However, the low-level primitives (`requireRecord`, `requireString`, etc.) are private, forcing other packages to re-implement validation patterns if they need similar logic. Consider a shared `@spaces/validation-primitives` package if validation becomes a cross-package concern.

### Error Handling
- The error class hierarchy supports future expansion well: new error types can extend `AspcValidationError` and inherit the `issues` payload.
- All validators consistently populate the `issues[]` array, making error aggregation predictable.

### Type Safety
- Types are well-structured; the union-based response design (`ok: boolean` discriminator) is sound.
- However, extracting success/failure branches into named types would improve both clarity and type narrowing in consumers.

### Testing Gaps
- No test file visible in this package's src/. Validators are critical paths; recommend:
  - Unit tests for each validator function (happy path + error cases)
  - Edge cases: empty records, deeply nested invalid structures, missing required fields
  - Snapshot tests for error message format and codes

### Future Scaling
- If ASPC methods grow beyond 4, the dispatch table pattern remains scalable.
- If request shapes diverge significantly, consider a schema validation library (e.g., Zod, io-ts) instead of hand-rolled validators.

---

## Summary

**Overall Health:** 🟢 **Good**  
This is a lean, well-structured validation package. SOLID principles are respected; the dispatcher pattern is exemplary. Main improvements are cosmetic (DRY, naming) and architectural (primitives extraction). No critical bugs or anti-patterns detected. The codebase is suitable for small to medium growth without major refactoring.

**Quick Refactor Path:**
1. Extract validation primitives (SRP improvement)
2. Define response version constants (DRY)
3. Consolidate error classes with factory (DRY + API clarity)
4. Consider ValidationContext object if validators grow

**Effort Estimate:** 4–6 hours for all refactorings; 1–2 hours for quick wins only.
