# Refactoring Analysis
**Target:** packages/cli-kit/src
**Lines analyzed:** 180 (source) · **Generated:** 2026-06-07 · **Focus:** all

## SOLID Scorecard
| Principle | Status | Issues |
|-----------|--------|--------|
| **S** (SRP) | 🟢 | None detected |
| **O** (OCP) | 🟢 | None detected |
| **L** (LSP) | 🟢 | None detected |
| **I** (ISP) | 🟡 | Minor: `BuildDeps` generic union + optional deps pattern reduces cohesion |
| **D** (DIP) | 🟡 | Minor: `readFileSync` direct import; injected deps partially mitigate |

## Priority Refactorings

### 1. Extract DependencyInjection wrapper for file I/O operations — DIP
- **Location:** index.ts:1–2, 119–154
- **Current:** Direct import of `readFileSync` at module top; `consumeBody` and `readBody` accept injected `readFile` but default to the imported function.
- **Suggested:** Create a `FileSystem` interface and inject it consistently at the top level of CLI actions, or use a factory function to decouple from Node.js fs module. This reduces surprise coupling in test/CLI boundaries.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** 1–2 hours · **Tests:** Update mock injection in consumeBody tests; add file system abstraction tests.
- **Rationale:** The module imports `readFileSync` but doesn't use it directly anymore (only defaults in the deps parameter). Removing the import clarifies that all file I/O is injectable.

### 2. Consolidate parameter validation into a single error-throwing validator factory — Code smell (parameter sprawl)
- **Location:** index.ts:64–117 (parseDuration, parseJsonObject, parseCommaList, parseIntegerValue)
- **Current:** Four independent validator functions with similar signatures and nearly identical error-throwing patterns. Each takes a `flag: string` parameter and throws `CliUsageError` independently.
- **Suggested:** Create a `createValidator<T>(flag: string, parse: (raw: string) => T, validate: (value: T) => void)` factory that centralizes error handling, reducing duplication in error messages and logic flow.
- **Risk:** Low · **API-impact:** public-surface (function names exported) · **Effort:** 2–3 hours · **Tests:** Existing tests should pass; add factory-level tests for edge cases.
- **Rationale:** Four similar validation patterns with identical error handling suggest a missing abstraction. Consolidating reduces duplication and makes adding new validators cheaper.

### 3. Simplify `exitWithError` by reducing conditional branches — Code smell (flag-based dispatch)
- **Location:** index.ts:159–180
- **Current:** The function checks `opts.json` twice (once in an if block for stderr formatting, implicitly in subsequent logic). The usage flag determination is coupled to error type checking.
- **Suggested:** Extract a formatter function: `formatError(err, usage, json)` that returns `{ message, usage, formatted }`, decoupling concerns. Consider extracting JSON/plaintext formatters into separate functions.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** 1–2 hours · **Tests:** Existing tests provide good coverage; add tests for each formatter path.
- **Rationale:** Reduces cyclomatic complexity and makes it easier to add new output formats (e.g., YAML, XML).

### 4. Document and constrain the `withDeps` contract — Code smell (overloaded generics + implicit coupling)
- **Location:** index.ts:41–54
- **Current:** The function relies on Commander's undocumented behavior that the last argument is always the `Command` instance. The comment explains it, but the contract is implicit and fragile.
- **Suggested:** Add a runtime check: assert that `args.at(-1)` is a Command-like object with an `opts()` method, or refactor to use a more explicit wrapper that fully decouples from Commander's argument ordering.
- **Risk:** Med · **API-impact:** public-surface · **Effort:** 1–2 hours · **Tests:** Add defensive tests for argument count and type validation.
- **Rationale:** This is a frequently-called helper; making the contract explicit prevents silent bugs if Commander's behavior changes.

### 5. Extract DURATION_UNIT_MS magic constants into a named constant object — Code smell (magic numbers)
- **Location:** index.ts:56–62
- **Current:** DURATION_UNIT_MS is well-named, but the millisecond values (1_000, 60_000, 3_600_000) are magic numbers. The regex is constructed dynamically from keys.
- **Suggested:** Consider using a static map: `const DURATIONS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const` and validate keys at the type level rather than runtime.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** 30 min · **Tests:** Existing tests cover all paths; no new tests needed.
- **Rationale:** Makes the constants immutable and more discoverable. The current pattern is actually quite good; this is a minor polish.

## Code Smells

| Smell | Location | Severity | Notes |
|-------|----------|----------|-------|
| Parameter sprawl (4 similar validators) | index.ts:64–117 | Med | Each validator function has nearly identical error-throwing logic. |
| Magic numbers in duration conversion | index.ts:56–62 | Low | The multipliers (1_000, 60_000, etc.) are clear from context and well-organized. |
| Implicit Commander contract | index.ts:41–54 | Med | `withDeps` assumes `args.at(-1)` is a Command; no runtime validation. |
| Conditional output formatting | index.ts:159–180 | Low | Multiple branches for JSON vs. plaintext; minor complexity. |
| Direct fs module import | index.ts:1 | Low | Imported but defaulted via injection; can be removed. |
| Union type in `deps` parameter | index.ts:124 | Low | `opts: { positional?: string \| undefined; file?: string \| undefined }` could be more explicitly constrained (e.g., validate only one is set). |

## Quick Wins (low risk, high value)

1. **Remove unused `readFileSync` import** (1 min)
   - Currently imported but never referenced outside the `deps` defaults pattern.
   - Location: index.ts:1
   - Change: Remove line 1, update `readBody` to not default anything (force explicit injection).

2. **Add explicit runtime validation in `withDeps`** (30 min)
   - Add a guard to ensure `command` has an `opts()` method before calling it.
   - Location: index.ts:45–52
   - Change: Replace implicit assumption with defensive check.

3. **Extract regex pattern as a named constant** (15 min)
   - Move the regex construction into a standalone constant.
   - Location: index.ts:62
   - Change: `const DURATION_REGEX = /^(\d+)(ms|s|m|h)$/` (hardcode the alternation for clarity).

4. **Group validator functions** (1 hour)
   - Move all four validators (parseDuration, parseJsonObject, parseCommaList, parseIntegerValue) into a new "validators" export barrel, or create a `validators.ts` submodule.
   - This reduces cognitive load without breaking the API.

## Technical Debt Notes

- **Commander coupling:** The `withDeps` helper is tightly coupled to Commander's internal behavior. Consider testing against multiple Commander versions.
- **Error handling strategy:** All input validation errors throw `CliUsageError`; this is good for consistency, but could benefit from structured error codes (e.g., `CliUsageError({ code: 'INVALID_DURATION', message: '...' })`).
- **Type safety:** The overloads for `repeatable<T>()` are excellent; the module's overall type safety is high. No concerns here.
- **Test coverage:** The test file provides thorough coverage; all paths are exercised. No coverage gaps detected.
- **No SOLID violations detected:** The module is well-designed for its purpose (CLI toolkit). SRP is clearly maintained; each function has one reason to change.

## Conclusion

The `cli-kit` package is **well-structured and maintainable**. It exhibits strong adherence to SOLID principles, particularly SRP and DIP (via dependency injection). The identified refactorings are **minor polish items**—not critical issues—that would further improve clarity and reduce cognitive load. The codebase is production-ready and requires no urgent changes.

---
**Generated by refactor-analysis tool · 2026-06-07**
