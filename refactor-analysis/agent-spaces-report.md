# Refactoring Analysis

**Target:** packages/agent-spaces/src  
**Lines analyzed:** 10,976  ·  **Generated:** 2026-06-07  ·  **Focus:** all

## SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| **S** (Single Responsibility) | 🟡 | Large methods (>300 lines in client.ts); mixed concerns (turn execution + session lifecycle in one method) |
| **O** (Open/Closed) | 🟡 | Type-switch chains in mapUnifiedEvents, compileBrokerPlan path branching; new harness types require code changes |
| **L** (Liskov Substitution) | 🟢 | No LSP violations detected; no type-checks before method calls or no-op overrides |
| **I** (Interface Segregation) | 🟡 | InFlightRunContext interface has 12 fields; some clients only need a subset (hostSessionId + runId) |
| **D** (Dependency Injection) | 🟢 | Clean injection of adapters & services; createEventEmitter & buildAutoPermissionHandler used appropriately |

---

## Priority Refactorings

### 1. Consolidate Duplicated toAgentSpacesError Function — DIP/SRP Violation
- **Location:** run-tracker.ts:56–68 & run-turn-helpers.ts:8–23 (exported)
- **Current:** Two separate implementations with slightly different logic (run-tracker omits CodedError check; run-turn-helpers includes it). Both convert errors to AgentSpacesError.
- **Suggested:** Export toAgentSpacesError from run-turn-helpers.ts and delete the duplicate in run-tracker.ts; update imports in run-tracker.ts to use the exported version. The run-turn-helpers version is more complete (includes CodedError fallback).
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 15 min  ·  **Tests:** run-tracker.test.ts (if exists) + session-events.test.ts
- **Blast radius:** 2 files affected (run-tracker.ts imports, internal call sites)
- **Rationale:** Eliminates hidden semantic drift and centralizes error transformation logic.

### 2. Consolidate Duplicated normalizeAttachmentRefs Function — DIP/SRP Violation
- **Location:** run-tracker.ts:153–165 & session-events.ts:206–218
- **Current:** Identical function duplicated across two modules, converting string paths to AttachmentRef objects.
- **Suggested:** Extract normalizeAttachmentRefs to session-events.ts (already exported there) and import it in run-tracker.ts. Alternatively, move to a shared utils file if the module doesn't grow further.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 10 min  ·  **Tests:** run-tracker.test.ts + session-events.test.ts
- **Blast radius:** 2 files affected (session-events.ts already exports; run-tracker.ts needs to import)
- **Rationale:** Pure duplication creates maintenance burden and obscures intent.

### 3. Extract Common Turn Execution Setup from runTurnInFlight & runTurnNonInteractive — SRP Violation
- **Location:** client.ts:317–507 (runTurnInFlight) & client.ts:605–850 (runTurnNonInteractive)
- **Current:** Both methods repeat identical validation/setup sequence: frontend resolution, event emitter creation, spec validation, provider match, model resolution, materialization, permission handler, and session creation. The shared pattern is ~150 lines of boilerplate.
- **Suggested:** Extract a _prepareTurnContext function returning {eventEmitter, frontendDef, spec, modelResolution, materialized, permissionHandler, continuationKey, resolvedPrompt}. Call once from both methods, reducing duplication and improving readability.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 45 min  ·  **Tests:** client.test.ts; verify both runTurnInFlight and runTurnNonInteractive behave identically through the setup phase
- **Blast radius:** Single file (client.ts), internal function
- **Rationale:** Reduces cognitive load, prevents divergence in validation logic, improves test coverage by centralizing setup logic.

### 4. Break Up client.ts:runTurnNonInteractive Long Method (>240 lines) — SRP Violation
- **Location:** client.ts:605–851
- **Current:** Single method handles validation, spec materialization, session creation, event mapping, and error handling. Nested try-catch-finally blocks (4+ levels deep) obscure control flow. The method's body has multiple overlapping responsibilities.
- **Suggested:** 
  - Extract _runAgentSdkSession(…) → Promise<RunTurnNonInteractiveResponse>
  - Extract _runPiSdkSession(…) → Promise<RunTurnNonInteractiveResponse>
  - Extract _handleTurnError(…) → Promise<RunTurnNonInteractiveResponse>
  - Simplify runTurnNonInteractive to: prepare context → branch on frontend → call backend → return
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 90 min  ·  **Tests:** client.test.ts; all turn scenarios (agent-sdk, pi-sdk, error paths, continuation)
- **Blast radius:** client.ts + client.test.ts; no public API change
- **Rationale:** Method is at the threshold of maintainability; deep nesting and mixed concerns reduce testability. Extract brings each extracted fn below 50-line threshold.

### 5. Break Up client.ts:runTurnInFlight Long Method (>190 lines) — SRP Violation
- **Location:** client.ts:317–537
- **Current:** Complex event handling in nested Promise executor (line 425–505) with closure-captured context mutation. Session start / event handlers / prompt queueing all tangled in one closure.
- **Suggested:** Extract _setupInFlightSessionEventLoop(…) function that encapsulates the Promise executor, session.onEvent listener setup, and error handlers. Reduces runTurnInFlight to preparation + _setupInFlightSessionEventLoop call + finally cleanup.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 60 min  ·  **Tests:** client.test.ts; runTurnInFlight interrupt/input/completion scenarios
- **Blast radius:** client.ts + client.test.ts
- **Rationale:** Event loop closure is difficult to reason about; extraction improves readability and makes async behavior explicit.

### 6. Reduce Compile-Runtime-Plan Function Complexity (1878 lines, 40+ functions) — SRP Violation
- **Location:** compile-runtime-plan.ts:1–1878
- **Current:** Single file implements compiler logic, broker/foreground/embedded-sdk plan builders, validation, diagnostics, profile construction, and hash/projection logic. Functions are small but numerous; file reads like 4 interleaved state machines.
- **Suggested:** 
  - Split into compile-runtime-plan.ts (main export + route dispatch only, ~100 lines)
  - broker-compile.ts (compileBrokerPlan + helpers, ~200 lines)
  - foreground-compile.ts (compileForegroundPlan + helpers, ~200 lines)
  - embedded-sdk-compile.ts (compileEmbeddedSdkPlan + helpers, ~250 lines)
  - compile-helpers.ts (shared: hashing, capabilities, diagnostics, ~400 lines)
- **Risk:** High  ·  **API-impact:** internal-only  ·  **Effort:** 120 min  ·  **Tests:** compile-runtime-plan.test.ts (if exists); all three routes must still pass
- **Blast radius:** Client code already imports only the default export (compileRuntimePlan), so internal reorganization is transparent
- **Rationale:** File size makes skimming difficult; route-specific logic should be co-located. Enables future addition of new routes (e.g. new harness families) without touching the main file.

### 7. Introduce Type Guard for Frontend-Specific Logic Branches — OCP Violation
- **Location:** client.ts:327 (AGENT_SDK_FRONTEND check), :648 (PI_SDK_FRONTEND check), :687, :707, :731; session-events.ts:112–152 (message_end switch)
- **Current:** Scattered string equality checks (=== 'agent-sdk', === 'pi-sdk') throughout. Adding a new frontend type requires grep-ing and updating all branches. mapUnifiedEvents switch statement has 6 cases; new event types require code changes.
- **Suggested:** 
  - Create type-safe discriminated union or type guards: isFrontendAgentSdk(frontend): frontend is 'agent-sdk'; similar for pi-sdk
  - Replace string compares with guard calls for clarity
  - For mapUnifiedEvents: use exhaustiveness check (add `satisfies Record<UnifiedSessionEvent['type'], …>` or compiler trick)
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 30 min  ·  **Tests:** Existing tests should pass; no behavior change
- **Blast radius:** client.ts, session-events.ts (search & replace)
- **Rationale:** Improves OCP compliance: new frontends/event types can add exhaustiveness checks upfront rather than relying on developer memory.

### 8. Extract Continuation Reference Building — Feature Envy / Duplication
- **Location:** client.ts:286–288 (buildProcessInvocationSpec), :815–817 (runTurnNonInteractive), :835–837 (runTurnNonInteractive error path)
- **Current:** Pattern repeated 4+ times: `continuation ? { provider, key: continuationKey } : undefined`. Each is a 3-line ternary.
- **Suggested:** Helper function _buildContinuationRef(provider: ProviderDomain, key?: string): HarnessContinuationRef | undefined. Call from all sites.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 10 min  ·  **Tests:** No new tests needed; refactoring only
- **Blast radius:** client.ts
- **Rationale:** Tiny helper, but eliminates visual clutter and makes intent explicit.

---

## Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| **Long Parameter Lists** | client.ts:buildProcessInvocationSpec (8+ params after request object); prepare-cli-runtime.ts (request object with 12 fields) | Medium: Request objects are grouped, but individual params in extracted helpers may exceed 4. |
| **Deep Nesting (4+ levels)** | client.ts:runTurnNonInteractive (try→try→if/switch structure at line 775–799); client.ts:runTurnInFlight (Promise executor with nested callbacks, lines 425–505) | High: Reduces readability; hard to trace error handling paths. |
| **Duplicated Blocks** | normalizeAttachmentRefs (run-tracker.ts + session-events.ts); toAgentSpacesError (run-tracker.ts + run-turn-helpers.ts) | High: Hand-maintained duplication risks semantic drift. |
| **Magic Numbers** | broker-invocation.ts:39–43 (DEFAULT_BROKER_STARTUP_TIMEOUT_MS = 20_000); compile-runtime-plan.ts:68 (COMPILER_VERSION = '0.1.1') | Low–Med: Named constants are used, but inline 900_000 (15 min timeout) appears without context in a few places. Suggest extracting as named const. |
| **Mixed Concerns (data + IO + logic)** | run-tracker.ts:InFlightRunContext (mixes session lifecycle, event emission, buffer state, turn counting, and completion promise); materializeSpec (validation + I/O + materialization in one function) | Medium: InFlightRunContext should separate session state from turn tracking. Materialize could split into validate/load phases. |
| **Primitive Obsession** | runTurnNonInteractive uses `continuationKey: string \| undefined` directly throughout; no wrapper type. Passing hostSessionId as string repeatedly despite typing it as `string as string` casts. | Low–Med: Type narrowing works, but a SessionContext type would improve clarity. |
| **Feature Envy** | run-tracker.ts:completeInFlightSuccess/Failure call eventEmitter.emit multiple times; eventEmitter and session are closely coupled in context. | Low: Acceptable coupling for the use case, but suggests these methods could move to EventEmitter or a separate completion service. |

---

## Quick Wins (Low Risk, High Value)

1. **Consolidate toAgentSpacesError (15 min, Low risk)**
   - Delete run-tracker.ts:56–68
   - Import from run-turn-helpers in run-tracker.ts
   - Verify run-tracker.test.ts still passes

2. **Consolidate normalizeAttachmentRefs (10 min, Low risk)**
   - Delete run-tracker.ts:153–165
   - Add `export` to session-events.ts:206–218 (if not already)
   - Update run-tracker.ts import

3. **Add _buildContinuationRef Helper (10 min, Low risk)**
   - Extract 3-line ternary into helper in client.ts
   - Replace 4 call sites
   - No test changes needed

4. **Name Inline Timeout Magic Number (5 min, Low risk)**
   - broker-invocation.ts: define DEFAULT_BROKER_TURN_TIMEOUT_MS = 900_000
   - Use const name instead of literal 900_000 in any inline usages
   - Update doc comments to clarify "15 minutes"

---

## Technical Debt Notes

### High-Priority Refactoring Debt
- **compile-runtime-plan.ts bloat:** File has grown to ~1878 lines implementing 4 parallel state machines (broker, foreground, embedded-sdk, helpers). This is a strong candidate for splitting when time permits (see recommendation #6). Current organization is functional but makes onboarding and route-addition slow.
- **runTurnNonInteractive / runTurnInFlight duplication:** ~150 lines of shared setup logic; extract would prevent divergence in validation and reduce test maintenance.
- **InFlightRunContext growing:** Currently 12 fields; future in-flight features (e.g., incremental turn tracking, nested interrupt nesting) may push this past 15. Consider factoring into (SessionState, TurnTracker, EventState) sub-objects proactively.

### Medium-Priority Simplification Debt
- **Type guards for frontend discrimination:** Scattered === checks invite bugs when adding new frontends. Type guards would enforce exhaustiveness.
- **Continuation ref building:** Repeated ternary is easy to typo; a helper adds clarity.
- **Deep nesting in async handlers:** Current Promise executor pattern in runTurnInFlight is correct but hard to review. Extraction improves readability without changing behavior.

### Low-Priority Observations
- **Primitive obsession:** sessionId passed as bare string throughout; wrapper type would catch bugs earlier but not critical given current test coverage.
- **Magic constant 900_000 (turn timeout):** Named constant exists (DEFAULT_BROKER_TURN_TIMEOUT_MS) but inline literal appears in comments; standardize usage.
- **Mixed responsibilities in InFlightRunContext:** Good separation between session and context, but field count is high. No immediate action needed; monitor if >15 fields.

---

## Test Coverage Notes
- **21 test files** found in src directory; strong test suite.
- **Critical paths to validate post-refactoring:**
  - client.test.ts: runTurnInFlight + runTurnNonInteractive (agent-sdk + pi-sdk routes, interrupts, continuations)
  - session-events.test.ts: event mapping exhaustiveness (new event types must not silently pass through)
  - compile-runtime-plan (if test file exists): all three compiler routes (broker, foreground, embedded-sdk)
- **Recommend adding:** Integration test for shared turn setup logic post-extraction to prevent divergence between in-flight and non-interactive paths.

