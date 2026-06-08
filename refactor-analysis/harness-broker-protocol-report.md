# Refactoring Analysis

**Target:** packages/harness-broker-protocol/src  
**Lines analyzed:** 3,969  
**Generated:** 2026-06-07  
**Focus:** all

## SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| **S**RP | 🔴 | schemas.ts (1957 lines) mixes validation dispatch, payload validators, command dispatch, and env policy in one module |
| **O**CP | 🟡 | validateCommandParams switch (535 lines) must be extended per new broker method; uses manual dispatch instead of registry pattern |
| **L**SP | 🟢 | Error class hierarchy properly preserves base behavior; no breaking overrides |
| **I**SP | 🟡 | SchemaRecord has 150+ optional fields; fat interface invites misuse and tight coupling |
| **D**IP | 🟡 | lifecyclePolicyHash hardcoded as default arg; env key classification functions scattered; validation primitives tightly coupled |

## Priority Refactorings

### 1. Extract validators from schemas.ts into focused modules — SRP

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-protocol/src/schemas.ts` (entire file)
- **Current:** Single 1957-line file contains:
  - Command parameter dispatch and validation (lines 510–608)
  - Event payload validators registry and dispatchers (lines 1253–1525)
  - Harness recovery mode dispatch table (lines 798–827)
  - Invocation input/spec shape validators (lines 385–467)
  - Environment key validation (lines 1659–1710)
- **Suggested:** 
  - Create `src/validators/command-params.ts` for broker method validators
  - Create `src/validators/event-payloads.ts` for event payload validator registry
  - Create `src/validators/invocation-shape.ts` for spec/input/dispatch shape validation
  - Leave schemas.ts as thin orchestrator re-exporting public surface
- **Risk:** Med  
- **API-impact:** internal-only  
- **Effort:** 3–4 hours (move + adjust imports + minimal refactor)  
- **Tests:** All existing validation error tests pass; no signature changes to public exports

### 2. Replace validateCommandParams switch with registry dispatch — OCP

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-protocol/src/schemas.ts:510–608`
- **Current:** 73-line switch statement on `method` enum; each new broker method requires adding a case
- **Suggested:** 
  ```typescript
  const COMMAND_PARAM_VALIDATORS: Record<BrokerMethod, (params: SchemaRecord, issues: ValidationIssue[]) => void> = {
    'broker.hello': validateBrokerHelloParams,
    'broker.health': validateBrokerHealthParams,
    // ... one entry per method
  }
  // Then: const validator = COMMAND_PARAM_VALIDATORS[method]; validator?.(commandParams, issues);
  ```
- **Risk:** Low  
- **API-impact:** internal-only  
- **Effort:** 1–2 hours (extract validators, wire registry)  
- **Tests:** Reuse all existing command validation tests; no behavior change

### 3. Reduce SchemaRecord interface bloat — ISP

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-protocol/src/schemas.ts:65–195`
- **Current:** Single record with 150+ optional fields listing every DTO field ever used in a schema
- **Suggested:** 
  - Keep SchemaRecord as `Record<string, unknown> & { [k: string]: unknown }` (minimal anchor)
  - Document the "grab bag" intent in comments
  - Consumers cast to specific DTO types after validation
  - If type safety is needed: use discriminated unions or narrow asRecord() to return type-specific records
- **Risk:** Low  
- **API-impact:** internal-only  
- **Effort:** 1 hour (update SchemaRecord definition + add comment)  
- **Tests:** No test changes; purely a type-hygiene refactor

### 4. Extract env-key classification logic into focused functions — DIP

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-protocol/src/schemas.ts:1659–1710` calls env-keys functions; env-keys.ts already separated
- **Current:** Validation imports and calls `isAmbientEnvKey`, `isCredentialEnvKey`, `isReservedEnvKey` inline; policy is scattered across two modules
- **Suggested:** 
  - Create `src/validators/env-classification.ts` exporting a single `classifyEnvKey()` function returning an enum (ambient | credential | reserved | ok)
  - Callers invoke this once per key, not four separate predicates
  - Reduces call sites and centralizes error messages
- **Risk:** Low  
- **API-impact:** internal-only  
- **Effort:** 1 hour  
- **Tests:** Reuse env-keys tests; add validation test for the new enum classifier

### 5. Inject lifecyclePolicyHash hasher into validators — DIP

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-protocol/src/schemas.ts:704–750`
- **Current:** `validateLifecyclePolicyOverlay` takes optional `computeHash` param defaulting to `lifecyclePolicyHash`, hardcoding the crypto implementation
- **Suggested:** 
  - Change signature to require the hasher (no default), forcing callers to supply it
  - Add a factory function `createValidators(hasher)` that returns the validator suite
  - This allows test code and alternate hash algorithms to inject mocks without mutation
- **Risk:** Low  
- **API-impact:** internal-only  
- **Effort:** 1–2 hours (update signature + audit call sites)  
- **Tests:** Update tests that validate the policyHash to pass explicit mock hashers

### 6. Consolidate duplicated validation patterns — DRY (Code Smell)

- **Location:** Multiple functions in schemas.ts:
  - `validateEnv` (1659), `validateStringRecord` (1859) both loop `Object.entries(record)` validating field types
  - `validateOptionalPositiveInteger` (1933), `validateRequiredPositiveInteger` (1946) duplicate the number check logic
  - `validateInputContent` (1603), `validateTerminalSurfaceReportedPayload` (1483) both iterate arrays with pattern matching
- **Suggested:** 
  - Extract `validateRecord(value, basePath, fieldValidator)` that handles looping + issues collection
  - Combine positive integer validators: `function validateInteger(value, basePath, issues, { required, positive, message })` with options
  - Extract discriminated union validator `matchOnField(value, basePath, discriminator, handlers)`
- **Risk:** Low  
- **API-impact:** internal-only  
- **Effort:** 2–3 hours (extract + rewire call sites)  
- **Tests:** All existing tests pass; purely internal refactor

### 7. Break nested if-chains into early returns — Readability

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-protocol/src/schemas.ts:1078–1146` (validateDispatchRuntime)
- **Current:** Function has 4-level nesting (lines 1092–1145); checks for `runtime.tmux`, `terminalSurface`, driver kind all interleaved
- **Suggested:** 
  ```typescript
  function validateDispatchRuntime(...) {
    const runtime = asRecord(dispatchRequest['runtime']);
    if (!runtime && !needsRuntime(driverKind)) return; // early exit
    
    if (runtime?.tmux) validateTmuxLegacy(runtime.tmux, ...);
    if (runtime?.terminalSurface) validateTerminalSurface(runtime.terminalSurface, ...);
    
    if (needsRuntime(driverKind)) {
      enforceTerminalSurfaceOrLegacy(...);
    }
  }
  ```
- **Risk:** Low  
- **API-impact:** internal-only  
- **Effort:** 1–2 hours (refactor + test verification)  
- **Tests:** Reuse all validation test cases; no behavior change

## Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| **Long function** | `validateCommandParams` (lines 510–608, 98 lines) | Medium — dispatcher growing with each method; candidate for split |
| **Long function** | `validateSpec` (lines 385–467, 82 lines) | Medium — mixes harness, process, driver, launch sub-spec validation |
| **Long function** | `validateLifecyclePolicyOverlay` + mode validators (lines 704–876) | Medium — lifecycle policy dispatch + mode-specific validators interleaved |
| **Duplicated logic** | `validateEnv`, `validateStringRecord` (both `Object.entries` + validation loop) | Medium |
| **Duplicated logic** | `validateOptionalPositiveInteger`, `validateRequiredPositiveInteger` | Low — simple numeric check, minimal duplication |
| **Duplicated logic** | Array-item iteration pattern (lines 1615, 1899, 1924) | Low — forEach with per-item path construction, copy-paste candidate |
| **Deep nesting** | `validateDispatchRuntime` (4 levels, lines 1087–1145) | Medium — makes control flow hard to follow |
| **Deep nesting** | `validateRuntimeRetentionPolicy` (3–4 levels, mode-specific behavior hidden) | Low — not excessive but mode dispatch could be clearer |
| **Magic strings** | Event type literals scattered in EVENT_PAYLOAD_VALIDATORS object literal (lines 1296–1451) | Low — self-documenting in context, but no DRY enforcement |
| **Parameter overload** | `validateEnv(value, basePath, issues, channel, lockedEnv?)` | Low — 5 params; `channel` could be enum, `lockedEnv` could be context object |
| **Wide catch** | `lifecyclePolicyHash` try-catch (lines 735–739) silently swallows hash errors | Medium — masks crypto failures; should log or re-throw |

## Quick Wins (low risk, high value)

1. **Consolidate numeric validators** (1 hour) — Combine `validateOptionalPositiveInteger` / `validateRequiredPositiveInteger` into single `validateInteger(value, basePath, issues, { required, positive })` function. Eliminates 20 lines of duplication with zero behavior change.

2. **Extract `validateRecord` helper** (1 hour) — Pull out the `Object.entries` loop pattern used in `validateEnv` and `validateStringRecord`. Callers pass a field validator callback. Reduces code smell, improves readability.

3. **Create `EnvKeyClassification` enum** (1 hour) — Replace four separate `isAmbientEnvKey()` / `isCredentialEnvKey()` / etc. calls with single `classifyEnvKey(key)` returning enum. One call per key, cleaner error messages.

4. **Add early-exit guards in nested validators** (1 hour) — `validateDispatchRuntime`, `validateRuntimeRetentionPolicy`, and lifecycle mode dispatchers: hoist checks, return early, flatten nesting. No behavior change; pure readability.

## Technical Debt Notes

- **Event type drift risk:** EVENT_TYPES and EVENT_PAYLOAD_VALIDATORS tuples are maintained manually. Consider a single union-driven registry keyed by event type to prevent future misalignment.
- **Validation primitive asymmetry:** `optionalX` and `requireX` functions duplicate the "required vs invalid_type" distinction. A unified `validate(value, basePath, issues, { type, required })` helper would reduce this pattern across the codebase.
- **Hardcoded protocol versions:** SUPPORTED_BROKER_PROTOCOL_VERSIONS is imported into schemas.ts but defined in invocation.ts. Consider a central constants module.
- **Test coverage:** No test file visible in the exploration; ensure all validators have unit tests for both happy path and all error code branches (at least 3 test cases per validator function).

