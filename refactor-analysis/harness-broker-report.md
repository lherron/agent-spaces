# Refactoring Analysis
**Target:** packages/harness-broker/src
**Lines analyzed:** 9971  ·  **Generated:** 2026-06-07  ·  **Focus:** all

## SOLID Scorecard
| Principle | Status | Issues |
|-----------|--------|--------|
| **S**RP (Single Responsibility) | 🟡 | Large manager file (1377 lines); codex-app-server driver mixes lifecycle, RPC, and event mapping |
| **O**CP (Open/Closed) | 🟡 | Busy-policy dispatch uses table-driven approach (good), but event-type switches in applyEventState (41 cases) |
| **L**SP (Liskov Substitution) | 🟢 | Driver interface well-designed; no problematic overrides detected |
| **I**SP (Interface Segregation) | 🟢 | DriverContext appropriately scoped; no fat interfaces |
| **D**IP (Dependency Inversion) | 🟢 | Drivers injected; registry pattern used; no hardcoded singletons |

---

## Priority Refactorings

### 1. Extract Event State Machine from Invocation Manager — **SRP**
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker/src/invocation-manager.ts:495–645`
- **Current:** The `applyEventState()` function handles 41 distinct event types in a massive switch statement (140+ lines) within a 1377-line module that already manages queuing, draining, permissions, and inspection reads.
- **Suggested:** Extract into a separate `event-state-machine.ts` module with a dedicated `EventStateMachine` interface. This module becomes the single source of truth for state transitions and projections. Replace the switch with a Map<EventType, StateTransformer> (OCP-friendly) so new event types extend the map, not the code.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 2-3 hours  ·  **Tests:** All invocation-manager tests + new event-state-machine unit tests; verify state transitions remain idempotent
- **Why Now:** Enables future event-type additions without touching the manager; simplifies testing of terminal/lifecycle logic separately.

### 2. Extract Inspection Read-Model Builder — **SRP**
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker/src/invocation-manager.ts:827–965`
- **Current:** Seven functions (`inferDriverHealth`, `isProcessAlive`, `computeRetentionBlockers`, `buildLifecycleView`, `buildCurrentTurn`, `buildLivenessView`, `buildInspectionSummary`) totaling ~140 lines of read-model logic are inlined in the manager, mixing query/projection concerns with command-side state mutation.
- **Suggested:** Create `inspection-read-model.ts` exporting an `InspectionReadModel` class encapsulating all projection logic. The manager calls `.buildSummary(inv, opts)` once; this module owns liveness, lifecycle, and turn views. Enables isolated testing and future caching.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1-2 hours  ·  **Tests:** Unit tests for each projection function; snapshot tests for complete summaries
- **Why Now:** The manager is at critical size; this extraction reclaims ~200 LOC and clarifies intent (query vs. command).

### 3. Extract Permission Lifecycle State Machine — **SRP**
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker/src/invocation-manager.ts:767–821`
- **Current:** `brokerRequestPermission()` manages pending/settled permissions, timers, driver resolution, and event emission—multiple concerns in ~55 lines. Coupled with Invocation state records (`pendingPermissions`, `settledPermissions`).
- **Suggested:** Create `permission-lifecycle.ts` with a `PermissionLifecycleManager` that owns the pending/settled records and timer logic. The invocation manager passes a context; the lifecycle manager emits events back via callback. Simplifies the manager and makes permission logic unit-testable in isolation.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1-2 hours  ·  **Tests:** Unit tests for timeout, duplicate, and conflict scenarios; integration test with driver flow
- **Why Now:** Permissions are a distinct subsystem (C2 spec); isolating them clarifies the contract and reduces manager complexity.

### 4. Extract Input Queue and Drain Logic — **SRP**
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker/src/invocation-manager.ts:294–474`
- **Current:** Queue scheduling (`scheduleDrain`), draining (`doDrain`), busy-policy dispatch (`handleQueueWhenBusy`), and policy handler table (~180 lines) live in the manager. While the policy-dispatch pattern is good (OCP-friendly), the queue lifecycle is mixed with the manager's responsibility.
- **Suggested:** Extract into an `InputQueue` class with methods `enqueue()`, `drain()`, `evict()`, and a pluggable `BusyPolicyDispatcher`. The manager owns the queue instance and calls its public API; the queue owns draining promises and eviction logic.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 2-3 hours  ·  **Tests:** All queue-related tests refactored to target InputQueue directly; integration tests with manager remain
- **Why Now:** Makes queue policies independently testable and future-proof for new policies without touching the manager.

### 5. Split Codex Driver into Domain Layers — **SRP**
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker/src/drivers/codex-app-server/driver.ts` (638 lines)
- **Current:** Single driver file handles process spawning, RPC lifecycle, event notification handling, turn state tracking, startup timeouts, thread management, permission forwarding, and turn queuing. Highly cohesive but responsibilities are mixed.
- **Suggested:** Reorganize as:
  - `codex-driver-core.ts` (the public `Driver` interface impl)
  - `codex-process-lifecycle.ts` (spawn, exit handling)
  - `codex-rpc-lifecycle.ts` (client init, initialization handshake)
  - `codex-turn-state.ts` (turn tracking, timeout management)
  Then compose in the core driver. Keeps public surface unchanged but clarifies internal boundaries.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 3-4 hours  ·  **Tests:** All existing driver tests pass unchanged; no new tests required if composition is correct
- **Why Now:** Driver is large; this refactor enables easier future features (e.g., resume logic, turn retry) without ballooning further.

### 6. Extract Codex Event Mapping Logic into Stateless Utilities — **SRP**
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker/src/drivers/codex-app-server/event-map.ts` (452 lines)
- **Current:** `mapCodexNotificationInner()` is a 300+ line switch statement over native Codex notification types (>25 cases) that filters, transforms, and holds assistant-completion state. The stateful held-completions map is created-per-driver and passed through.
- **Suggested:** Keep the switch but extract individual case handlers into a `Map<string, NotificationHandler>` table (OCP-friendly). Each handler becomes a pure function or closure over shared state. Enables testing handlers independently and adding new Codex notification types without touching the core switch.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 2 hours  ·  **Tests:** Unit tests for each handler; existing integration tests pass
- **Why Now:** Makes event mapping patterns clear and extension points obvious; reduces case-handler cognitive load.

### 7. Extract Event Normalization into Dedicated Module — **SRP**
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker/src/runtime/event-normalize.ts` (currently imported from invocation-manager emit)
- **Current:** Event safety (truncation, well-known payload constraints) is isolated but the emit helper in the manager still handles both safe and unsafe payloads; responsibility is split.
- **Suggested:** Ensure the normalizer owns all event-payload validation. The manager's `emit()` becomes a pure adapter that calls the normalizer upfront, never handling unsafe payloads itself. Already mostly done; just formalize the boundary.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 30 minutes  ·  **Tests:** Existing normalization tests + verify emit rejects oversized payloads at entry point
- **Why Now:** Clarifies a key invariant and guards against future emit callers bypassing safety.

---

## Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| **Long Method** | `invocation-manager.ts:495–645` (applyEventState, 150 lines) | High |
| **Long Method** | `codex-app-server/driver.ts:280–393` (start, 113 lines) | High |
| **Large Class** | `invocation-manager.ts` (1377 lines total) | High |
| **Long Parameter List** | `codex-app-server/permissions.ts:200+` (multiple handlers with 4+ params) | Med |
| **Deep Nesting** | `invocation-manager.ts:1163–1195` (input policy dispatch, 3+ levels) | Med |
| **Duplicated Logic** | `invocation-manager.ts` emit + applyEventState pattern used 5+ times | Med |
| **Magic Numbers** | `protocol-server.ts:55` (MAX_CONSECUTIVE_PARSE_ERRORS = 64, undocumented) | Low |
| **Magic Numbers** | `invocation-manager.ts:57,60` (queue depth, permission timeout defaults) | Low |
| **Type Checks Before Calls** | `driver.ts` (payload typecast checks via `instanceof`/`as` before property access) | Med |
| **Primitive Obsession** | `invocation-manager.ts:62–73` (reason strings defined as constants, good start; extend to event type discriminators) | Low |

---

## Quick Wins (low risk, high value)

1. **Extract Busy-Policy Handlers Table** (`invocation-manager.ts:476–490`)
   - Already table-driven; just comment it as the OCP-pattern exemplar for future extension.
   - **Effort:** 15 min  ·  **Risk:** None

2. **Document MAX_CONSECUTIVE_PARSE_ERRORS** (`protocol-server.ts:55`)
   - Add a comment explaining the DoS mitigation. Mention the non-exponential amplification bound.
   - **Effort:** 10 min  ·  **Risk:** None

3. **Extract Reason-String Constants** (`invocation-manager.ts:49–55`)
   - Already done; ensure they're exported as `INVOCATION_REJECTION_REASONS` enum or constant map for client reference.
   - **Effort:** 20 min  ·  **Risk:** None

4. **Split Driver Capabilities into Separate Module** (`drivers/codex-app-server/driver.ts:40–69`)
   - Capabilities are static; move `CODEX_CAPABILITIES` to a `codex-capabilities.ts` file.
   - **Effort:** 20 min  ·  **Risk:** None (internal refactor)

5. **Extract Startup Timer Logic** (`codex-app-server/driver.ts:342–353`)
   - `armStartupTimer()` is a helper; extract to a `StartupTimer` class or utility.
   - **Effort:** 30 min  ·  **Risk:** Low

---

## Technical Debt Notes

### Architectural
- **Invocation Manager is the Critical Path:** At 1377 lines, it's the system's heart. Its size limits cognitive load and testability. The priority refactorings (1–4) are highest-leverage for keeping it maintainable as features grow.
- **Driver-Specific Logic is Consolidated:** Good—codex-app-server, claude-code-tmux, codex-cli-tmux, and noop-driver are distinct. However, codex-app-server is notably the largest (638 lines). Refactoring #5 keeps it from becoming a god object.
- **Event-Type Switch is a Future Hotspot:** As more harnesses and drivers attach, the 41-case switch in `applyEventState` will grow. Extracting it now (refactor #1) is cheaper than refactoring when it hits 60+ cases.

### Testing Gaps
- **Permission Lifecycle Not Unit-Tested in Isolation:** The `brokerRequestPermission()` function is tested indirectly through the manager. Extracting it (refactor #3) enables direct tests for timeout, duplicate, and conflict edge cases.
- **Event State Transitions Lack Focused Tests:** Verifying that every `event.type` correctly projects state is scattered across integration tests. A dedicated state-machine test suite (refactor #1) would improve coverage clarity.

### Patterns to Adopt
- **Policy Dispatch Tables:** The `busyPolicyHandlers` table (invocation-manager.ts:476) is a good OCP pattern. Apply it to event mapping (codex-app-server/event-map.ts) and Codex notification handlers.
- **Stateless Handlers:** The permission handler context (codex-app-server/permissions.ts:200+) shows good closure discipline. Extend this to event mappers.

### Known Risks
- **State Mutation Sequencing:** The manager's event-apply-project sequence (`applyEventState` → `onEvent` → project for next call) is fragile if a handler expects prior projections to be complete. Refactoring #1 + #2 mitigates by isolating state transitions.
- **Driver Startup Timeout Overlaps:** The codex driver's startup timer is armed/re-armed multiple times during initialization. A dedicated timer manager (refactor #5 substep) reduces race conditions.

---

## Scoring Summary
- **High-Impact Refactorings:** 3 (manager extraction, event state, inspection reads)
- **Medium-Impact Refactorings:** 2 (driver split, input queue)
- **Low-Impact Quick Wins:** 5
- **Auto-Applicable (Low/Med + internal-only):** 6 of 7 priority refactorings qualify
