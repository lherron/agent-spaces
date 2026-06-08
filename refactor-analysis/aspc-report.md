# Refactoring Analysis
**Target:** packages/aspc/src
**Lines analyzed:** 585  ·  **Generated:** 2026-06-07  ·  **Focus:** all

## SOLID Scorecard
| Principle | Status | Issues |
|-----------|--------|--------|
| **S** (SRP) | 🟡 | service.ts mixes compilation, error handling, and profile selection; facade.ts combines server setup, route registration, and stream management |
| **O** (OCP) | 🟢 | Table-driven patterns in service.ts and facade.ts enable extension without modification |
| **L** (LSP) | 🟢 | No type-checking anti-patterns or broken contracts detected |
| **I** (ISP) | 🟢 | Minimal, focused interfaces; no fat service classes or stub implementations |
| **D** (DIP) | 🟡 | Hardcoded instantiation of `createAgentSpacesClient` and `createDefaultBroker` break inversion of control |

---

## Priority Refactorings

### 1. Extract Compiler Dependency Injection in service.ts — DIP
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/aspc/src/service.ts:109-115
- **Current:** `defaultCompiler` directly instantiates `createAgentSpacesClient`, hardcoding the compiler factory
- **Suggested:** Move `defaultCompiler` into `AspcServiceOptions` as an injected factory or optional default, allowing callers to supply their own compiler implementation without modifying service.ts
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 15 min  ·  **Tests:** existing unit tests for `createAspcService` should verify default compiler fallback and custom compiler override
- **Rationale:** Enables testing with mock compilers and decouples from agent-spaces client library

### 2. Reduce Hardcoded Type Casts in brokerMethodTable — ISP + Type Safety
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/aspc/src/facade.ts:112-154
- **Current:** Repeated `as` type casts in brokerMethodTable entries (lines 115, 119, 124, 135, 139, 143, 147, 151); 9 casts create drift risk
- **Suggested:** Create a typed route registry interface with discriminated unions per method signature, eliminating unsafe casts
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 30 min  ·  **Tests:** verify registerBrokerMethods dispatches correct payloads; add type-level tests if feasible
- **Rationale:** Catches method signature mismatches at compile time; improves maintainability when Broker interface evolves

### 3. Extract Broker Setup from createAspcFacadeServer — SRP
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/aspc/src/facade.ts:45-51
- **Current:** Broker instantiation logic nested in facade factory; couples facade creation to broker setup
- **Suggested:** Extract broker creation (including emitEvent + permission callbacks) into separate `createBrokerWithCallbacks()` function; pass result to facade factory
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 20 min  ·  **Tests:** test broker setup in isolation; verify callbacks wired correctly
- **Rationale:** Separates concerns—broker setup from facade routing; easier to test and reuse broker creation

### 4. Extract Error Response Builders into Factory — SRP + DRY
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/aspc/src/service.ts:245-276
- **Current:** Three near-identical error response builders (`failRuntimeCompile`, `failHarnessInvocation`, `failCompileAndStart`) duplicate schema versioning and ok:false pattern
- **Suggested:** Create a generic error factory `failWith(schema, compileResponse?, diagnostics)` and refactor calls to use it
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 20 min  ·  **Tests:** existing error path tests should continue to pass; add unit test for factory with each schema type
- **Rationale:** Eliminates duplication; centralizes error response shape logic; reduces maintenance burden

### 5. Extract Profile Selection Logic into Dedicated Module — SRP
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/aspc/src/service.ts:159-223
- **Current:** `selectBrokerProfile` and `SELECTOR_CRITERIA` live in service.ts alongside compilation and dispatch building; 65 lines of selection-specific code
- **Suggested:** Move profile selection into a separate file/module `profileSelector.ts` with criteria table, selection logic, and diagnostics; export factory for testing
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 45 min  ·  **Tests:** add isolated unit tests for each selector dimension; verify existing harness invocation tests still pass
- **Rationale:** Single responsibility—profile selection deserves its own module; improves testability; clarifies intent

### 6. Parameterize Magic Strings (Schemas, Methods) — Code Smell
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/aspc/src/service.ts:26-28; facade.ts:114-152
- **Current:** Schema versions and method names hardcoded as string literals scattered across files (e.g., `'aspc-compile-and-start-response/v1'`, `'broker.hello'`)
- **Suggested:** Create an `AspcRoutes` enum or const object with all method names and schema versions; import and reference throughout
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 25 min  ·  **Tests:** no behavioral change; grep existing tests to verify method name strings still match after refactor
- **Rationale:** Single source of truth; prevents typos; simplifies version bumps

### 7. Flatten Nested Conditionals in compileAndStart — Readability
- **Location:** /Users/lherron/praesidium/agent-spaces/packages/aspc/src/service.ts:82-105
- **Current:** Three levels of nesting (if broker, if !compile.ok, if error); difficult to follow execution path
- **Suggested:** Use early returns: validate broker at top, return if compile fails before broker.start call
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 10 min  ·  **Tests:** existing compileAndStart tests should pass unchanged
- **Rationale:** Improves readability; reduces cognitive load; follows "fail fast" pattern

---

## Code Smells
| Smell | Location | Severity |
|-------|----------|----------|
| **Type casting chains** | facade.ts:115–151 (9× `as` casts in brokerMethodTable) | 🟡 Med |
| **Magic strings** | service.ts:26-28, facade.ts:114-152 (schema versions, method names) | 🟡 Med |
| **Long parameter list** | service.ts:93-97 (`broker.start(…, …, …, ...)` with 4 args) | 🟡 Med |
| **Duplicated error builders** | service.ts:245-276 (3 near-identical fail* functions) | 🟡 Med |
| **Nested conditionals** | service.ts:82-105 (3 levels: broker check → compile check → error handling) | 🟡 Med |
| **Hardcoded dependencies** | service.ts:109-115 (defaultCompiler), facade.ts:47 (createDefaultBroker) | 🟡 Med |
| **God function** | service.ts lines 131-157 (compileHarnessInvocation handles 5+ concerns) | 🟡 Med |

---

## Quick Wins (low risk, high value)

1. **Extract Routes Constants** (5 min): Move `'aspc.hello'`, `'aspc.compileRuntimePlan'`, etc. into a `const ASPC_METHODS = { ... }` object; reference throughout facade.ts and service.ts. Zero API change.

2. **Flatten compileAndStart** (10 min): Replace nested ifs with early returns in service.ts:82-105. Improves readability, no behavioral change.

3. **Add Parameter Docs** (10 min): Document `profileSelector` parameter in `AspcCompileHarnessInvocationRequest`; clarify how selector dimensions compose. Aids onboarding.

4. **Extract compilerDiagnostic Usage** (15 min): Consolidate all `compilerDiagnostic()` calls in service.ts into a diagnostics module with named code constants (`COMPILER_EXCEPTION`, `BROKER_PROFILE_MISSING`, etc.). Reduces string duplication.

---

## Technical Debt Notes

- **Broker Type Casting Risk**: The `brokerMethodTable` design leans on runtime type safety (caller must pass correct param shape). Consider a discriminated-union routing pattern or a method registry with static type guarantees.

- **Error Aggregation**: Multiple error paths return diagnostics arrays, but error context (where the error originated, stack traces) could be richer. Consider adding a Diagnostics Builder with context tracking.

- **Testing Barriers**: Hardcoded compiler and broker factories make unit testing difficult. Injecting them via options (already done for compiler) would improve testability of edge cases.

- **No Structured Logging**: Errors are formatted to strings for `stderr`; consider structured error logging with codes and metadata for operational insight.

- **Future Extension**: If new compiler backends or transport types are added, the table-driven design in `facade.ts` and `service.ts` can absorb them, but CLI parsing (cli.ts:7-15) will grow linearly. Consider a CLI command registry to follow OCP.
