# 🔧 Refactoring Analysis

**Target:** `packages/aspc-protocol/src` (`index.ts`, `types.ts`, `schemas.ts`)
**Lines analyzed:** 452 (index 2, types 113, schemas 337)
**Generated:** 2026-06-01  ·  **Focus:** all

## Summary

`aspc-protocol` is a small, well-factored protocol package: a pure type/interface
surface (`types.ts`), a barrel (`index.ts`), and a hand-rolled JSON-RPC request
validator (`schemas.ts`). The code is clean, has no IO, no inheritance, and no
classes beyond four near-identical error subclasses. The findings below are
genuine but low-severity; this package is not a refactoring hot spot. The most
actionable items are duplication in the validation-error classes and in the
method-name dispatch logic, plus a couple of latent correctness gaps in the
validator.

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🟢 | `schemas.ts` mixes error types + public validators + a private validation toolkit, but each unit is tiny and cohesive. One soft concern. |
| Open/Closed | 🟡 | Method name is enumerated in 4 separate places that must all change together when a new `aspc.*` method is added. |
| Liskov Substitution | 🟢 | No overrides, no `throw "not implemented"`, no base-behavior drops. Error subclasses extend `Error` cleanly. |
| Interface Segregation | 🟢 | No interface exceeds ~6 members; consumers depend only on what they call. |
| Dependency Inversion | 🟢 | No concrete collaborators constructed in business logic; pure functions over `unknown`. Imports are type/contract-only. |

## 🎯 Priority Refactorings

### 1. New `aspc.*` method requires four synchronized edits — Open/Closed
- **Location:** `types.ts:20-30` (`AspcMethod` + `AspcCommand`), `schemas.ts:102-113` (switch), `schemas.ts:121-128` (`isAspcMethod`)
- **Current:** The set of methods is hand-listed in `AspcMethod` (union), `AspcCommand` (union of `JsonRpcRequest<...>`), the `validateAspcCommand` `switch`, and the `isAspcMethod` boolean chain. Adding `aspc.foo` means editing all four, and nothing forces consistency — `isAspcMethod` can drift out of sync with `AspcMethod` silently.
- **Suggested:** Drive the method set from one source of truth. e.g. a `const ASPC_METHODS = ['aspc.hello', ...] as const`, derive `type AspcMethod = typeof ASPC_METHODS[number]`, and implement `isAspcMethod` as `ASPC_METHODS.includes(value as AspcMethod)`. Optionally a `Record<AspcMethod, validatorFn>` dispatch table replaces the `switch`, so an exhaustiveness check fails compilation when a method is added without a validator.
- **Risk:** Low  ·  **Effort:** ~30 min  ·  **Tests:** existing `schemas.test.ts` covers all branches; add a case asserting `isAspcMethod` rejects a near-miss.

### 2. Four duplicated validation-error classes — DRY / SRP
- **Location:** `schemas.ts:15-57` (`AspcHelloRequestValidationError`, `AspcCompileRuntimePlanRequestValidationError`, `AspcCompileHarnessInvocationRequestValidationError`, `AspcCommandValidationError`)
- **Current:** Four classes are byte-for-byte identical except for `code`, `name`, and the super message. ~42 lines of boilerplate carrying one bit of variation each.
- **Suggested:** Extract a shared `AspcValidationError extends Error` base holding `issues: ValidationIssue[]` and a `code`/`name` set from constructor args, OR a small factory `makeAspcValidationError(name, code, message)`. Keep the four exported names as thin subclasses/aliases so the public surface and `instanceof`/`code` discrimination stay intact.
- **Risk:** Low (public class names must remain exported and `code` values unchanged for consumers that branch on them)  ·  **Effort:** ~20 min  ·  **Tests:** add assertions that each error still exposes its `code` and `issues`; current tests only check the message string.

### 3. `validateCompileHarnessInvocation` re-derives the record twice — minor smell / latent inconsistency
- **Location:** `schemas.ts:171-183`
- **Current:** It calls `validateCompileRuntimePlan(value, ...)` (which internally does `record(value, ...)` and pushes an issue if not an object), then independently calls `asRecord(value)` and `return`s on `undefined`. Two separate "is this an object?" paths over the same value; the second is silent (no issue pushed) because the first already reported. Works today, but the coupling is implicit and fragile if either helper changes.
- **Suggested:** Have `validateCompileRuntimePlan` return the validated record (or `undefined`) and reuse it, so there's a single object-shape gate and a single source for the record. Removes the redundant `asRecord` call.
- **Risk:** Low  ·  **Effort:** ~15 min  ·  **Tests:** add a case passing a non-object to `compileHarnessInvocation` to lock current single-issue behavior.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Duplicated error-class bodies (4x identical except literals) | `schemas.ts:15-57` | 🟠 |
| Method name enumerated in 4 places (union, command union, switch, predicate) | `types.ts:20-30`, `schemas.ts:102-113`, `schemas.ts:121-128` | 🟠 |
| `RuntimeCompileRequest` validated only to depth-1 (`identity`/`placement`/`requested`/etc. checked as "is an object" but contents never validated) | `schemas.ts:185-204` | 🟡 |
| `validateRequiredRecord` / `validateOptionalRecord` are one-line wrappers over `record`/`asRecord` adding no logic, slight indirection | `schemas.ts:249-257` | 🟡 |
| Stringly-typed issue `code` values (`'invalid_type'`, `'required'`, `'unsupported_protocol'`, …) repeated as string literals, no shared enum/const | `schemas.ts` throughout | 🟡 |
| `validate*` functions return `value as T` after side-effect validation; the cast trusts the validator's completeness (esp. given the shallow depth-1 check above) | `schemas.ts:65, 76, 87, 118` | 🟡 |
| Empty interface `AspcCompileAndStartRequest extends AspcCompileHarnessInvocationRequest {}` — pure alias dressed as interface | `types.ts:99` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Collapse the four validation-error classes to a shared base/factory (Refactoring #2) — removes ~30 lines with no behavior change.
2. Single-source the method list and derive `AspcMethod` + `isAspcMethod` from it (Refactoring #1) — eliminates the silent-drift hazard between the type union and the runtime predicate.
3. Replace `export interface AspcCompileAndStartRequest extends ... {}` (`types.ts:99`) with `export type AspcCompileAndStartRequest = AspcCompileHarnessInvocationRequest` to make the aliasing intent explicit (or add a comment if a distinct nominal type is intended).
4. Hoist issue `code` strings into a shared `const` map so producers and any future consumers reference one set of literals.

## ⚠️ Technical Debt Notes

- **Shallow runtime validation vs. strong static types.** `validateRuntimeCompileRequest` (`schemas.ts:185-204`) only asserts that `identity`, `placement`, `requested`, `materialization`, `hrcPolicy`, `correlation` are objects — it does not validate their fields, yet `validateAspcCompileRuntimePlanRequest` casts the result to the fully-typed `RuntimeCompileRequest`. A malformed-but-object payload passes validation and is then treated as type-safe downstream. This is a deliberate boundary choice (delegating deep validation to the compiler), but it should be documented; the `as` casts otherwise overstate the guarantee. If `spaces-runtime-contracts` exposes a deep validator, prefer delegating to it.
- **`hrcPolicy: {}` accepted as required object** (test fixture `schemas.test.ts:34`) — confirm an empty object is intended to be valid; the current depth-1 check makes it so.
- **No validator for the response types** (`AspcHelloResponse`, `AspcCompileHarnessInvocationResponse`, `AspcCompileAndStartResponse` in `types.ts`). Only request/command shapes are validated. If responses cross a trust boundary on the client side, they currently rely solely on the type cast. Likely acceptable for a facade-authored response, but worth noting.
- **Package is healthy overall** — no SRP-breaking god files, no inheritance misuse, no DIP violations. Keep it small; resist folding broker/runtime logic into this contract package.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (`packages/aspc-protocol/test/schemas.test.ts`; add cases for error `code`/`issues` and non-object branches before refactoring)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run `bun run test` and `bun run typecheck` between each
- [ ] Keep all four error-class names and their `code` literals exported unchanged (consumers may branch on them)
- [ ] Re-run `bun run lint` and `bun run check:boundaries` / `bun run check:manifests` (cross-repo boundary package)
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

These are items not raised in the first pass. The first pass covered method-set
duplication, error-class duplication, the double record-derivation in
`validateCompileHarnessInvocation`, shallow depth-1 validation, stringly-typed
codes, the empty-interface alias, and missing response validators. The following
are distinct.

### A1. Dead/redundant `validateJsonRpcId` call — unreachable validation branch
- **Smell:** Dead code / speculative validation.
- **Location:** `schemas.ts:101` (call) and `schemas.ts:130-134` (`validateJsonRpcId`).
- **Detail:** `validateAspcCommand` only reaches line 101 inside the `isJsonRpcRequest(value)` success branch (line 96 negation already handled). But `isJsonRpcRequest` in `spaces-harness-broker-protocol` (`jsonrpc.ts:91-92`) already requires `Object.hasOwn(value,'id') && isJsonRpcId(value.id)`, and `isJsonRpcId` (`jsonrpc.ts:136-138`) is byte-for-byte the same predicate (`null | string | number`) that `validateJsonRpcId` re-checks. So `validateJsonRpcId(value.id, 'id', issues)` can never push an issue — the `id` was already guaranteed valid by the guard. The function and its call site are dead. Either drop them, or (if the intent is to keep id-validation local and not lean on the imported guard's internals) document that coupling.
- **Risk:** Low · **Effort:** ~10 min · **Tests:** no test currently exercises a bad `id` reaching `validateAspcCommand` (it can't), so removal needs no test change; confirm via coverage that the branch is unreachable.

### A2. Hello `capabilities` validator accepts arbitrary keys — leaky validation vs. contract
- **Smell:** Validation under-constrains the typed contract (silent extra-field acceptance).
- **Location:** `schemas.ts:157` + `validateOptionalBooleanRecord` (`schemas.ts:219-234`); contract at `types.ts:38-44`.
- **Detail:** The `AspcHelloRequest.capabilities` type permits exactly three optional keys (`compileRuntimePlan`, `compileHarnessInvocation`, `compileAndStart`). The runtime validator only checks that *every* value is a boolean — it accepts any unknown key (e.g. `{ launchRockets: true }`) as valid. A client that misspells a capability flag (`compileAndstart`) passes validation and silently loses the capability. Consider validating the key set, or at least documenting that capabilities is intentionally open/forward-compatible.
- **Risk:** Low · **Effort:** ~15 min · **Tests:** add a case asserting an unknown capability key is rejected (or explicitly allowed, per decision).

### A3. `protocolVersions` re-read and protocol check runs on unvalidated items
- **Smell:** Duplicated read + order-of-checks gap.
- **Location:** `schemas.ts:144-156` (`validateHello`).
- **Detail:** `requireStringArray(request['protocolVersions'], ...)` validates the array, then the code independently re-reads `request['protocolVersions']`, re-tests `Array.isArray`, and runs `.includes(ASPC_PROTOCOL_VERSION)`. The `.includes` runs even when array items failed the string check, and the property is read twice. Hoist into a local (`const versions = request['protocolVersions']`) and gate the membership check on the array already being well-formed, so the supported-protocol issue isn't emitted alongside item-type issues for the same field.
- **Risk:** Low · **Effort:** ~10 min · **Tests:** add a case with a non-string element to confirm one issue, not overlapping issues.

### A4. `record` vs `asRecord` naming hides the "reports-vs-silent" distinction
- **Smell:** Misleading/ambiguous naming on the internal validation toolkit.
- **Location:** `schemas.ts:259-282` (`record`, `asRecord`).
- **Detail:** Both functions coerce `unknown` to `SchemaRecord | undefined`, but `record` *pushes an issue* on failure while `asRecord` is *silent*. The names don't signal that difference, which is exactly the trap behind the first pass's "double-derivation" finding (`validateCompileHarnessInvocation` mixes both). Rename to convey intent, e.g. `requireRecord` (issue-pushing) / `coerceRecord` (silent). This is a readability fix that also makes A1-style misuse harder.
- **Risk:** Low (internal, non-exported) · **Effort:** ~10 min · **Tests:** none (pure rename).

### A5. `requireStringArray` item message omits the path it computed
- **Smell:** Inconsistent diagnostic messages.
- **Location:** `schemas.ts:309-315`.
- **Detail:** Every other validator embeds the failing path in the message (e.g. `` `${basePath} must be a string` ``). The array-item branch builds `path(basePath, String(index))` for the issue's `path` field but hardcodes the message to the generic `'array item must be a string'`, so the human-readable message can't point at the offending index. Align it with the rest (`` `${path(basePath, String(index))} must be a string` ``).
- **Risk:** Low · **Effort:** ~5 min · **Tests:** assert the issue message includes the index path.

### A6. Test gap: `compileAndStart` path and `validateAspcCompileAndStartRequest` never exercised
- **Smell:** Untested public surface / dead-feeling export.
- **Location:** `schemas.ts:90-92` (`validateAspcCompileAndStartRequest`), `schemas.ts:110` (`aspc.compileAndStart` switch arm); test file `test/schemas.test.ts`.
- **Detail:** `validateAspcCompileAndStartRequest` is exported but never imported or called in the test suite, and no `validateAspcCommand` test sends `method: 'aspc.compileAndStart'`. The arm shares logic with `compileHarnessInvocation`, but that coupling is exactly what a test should pin — a future split of the two validators would silently change `compileAndStart` behavior with no failing test. Add a happy-path + reject case for both.
- **Risk:** Low · **Effort:** ~15 min · **Tests:** this *is* the test addition.

### A7. `validateAspcCommand` reports only `Unsupported ASPC method` without listing valid methods
- **Smell:** Minor diagnostic ergonomics / coupling to drift hazard from first-pass item #1.
- **Location:** `schemas.ts:99`.
- **Detail:** When `isAspcMethod` rejects, the issue message is `` `Unsupported ASPC method: ${value.method}` `` with no enumeration of accepted methods. If the method set were single-sourced (first-pass refactoring #1), the message could render the allowed set from that constant for free, turning the drift hazard fix into a better error too. Noting it here as a concrete payoff of #1, not a standalone change.
- **Risk:** Low · **Effort:** trivial (folds into #1) · **Tests:** assert the message lists valid methods.
