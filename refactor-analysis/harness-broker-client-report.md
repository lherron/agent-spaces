# Refactoring Analysis
**Target:** packages/harness-broker-client/src  
**Lines analyzed:** 1,158  ·  **Generated:** 2026-06-07  ·  **Focus:** all

## SOLID Scorecard
| Principle | Status | Issues |
|-----------|--------|--------|
| S (SRP) | 🟡 | client.ts (329 lines) exceeds threshold; mixes invocation control, event routing, permission handling |
| O (OCP) | 🟢 | No detected switch/if-else chains on types; transport abstraction cleanly extensible |
| L (LSP) | 🟢 | No override violations; abstract JsonRpcFramedChannel properly delegated |
| I (ISP) | 🟢 | No fat interfaces; BrokerJsonRpcTransport (5 members) is well-scoped |
| D (DIP) | 🟡 | Direct instantiation of collaborators in BrokerClient; limited injection seams |

---

## Priority Refactorings

### 1. BrokerClient: Multiple Concerns in Single Class — SRP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-client/src/client.ts:70-329`
- **Current:** BrokerClient manages transport, permissions (via PermissionRouter), event routing (via InvocationEventHub), and the public API surface. The class coordinates 3 internal concerns:
  - Transport lifecycle & request routing (lines 76-92, 312-315)
  - Permission request handling (lines 285-298)
  - Invocation event stream management (lines 134-181, 263-265, 317-328)
- **Suggested:** Extract permission handling into a dedicated `PermissionController` and event-stream coordination into a public wrapper (already done via EventIterator, but lifecycle is tangled). Consider a builder pattern for the different invocation-start overloads or a dedicated `InvocationController`.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** 2–3 days  ·  **Tests:** All invocation lifecycle tests (start-request.test.ts, integration.test.ts, handler-disposers.test.ts) must remain green.
- **Impact:** 329-line class is at the upper limit; extracting 40–60 lines of permission logic and event-hub coordination would bring BrokerClient to ~260 lines and clarify the single responsibility (transport RPC facade).

### 2. JsonRpcFramedChannel: Tight Transport Coupling — DIP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-client/src/json-rpc-channel.ts:55-235`
- **Current:** JsonRpcFramedChannel depends directly on error classes (BrokerRpcError, BrokerTransportError) and protocol types (JsonRpcRequest, etc.) from spaces-harness-broker-protocol. The abstract class is tightly bound to broker semantics, limiting reuse for other JSON-RPC transports.
- **Suggested:** Introduce a factory or options object to parameterize error construction and response validation, decoupling the framing logic from broker-specific error semantics. This makes the channel reusable for non-broker JSON-RPC use.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 1–2 days  ·  **Tests:** json-rpc-channel.test.ts (implicit via integration tests); all request/response routing must remain correct.
- **Impact:** Low immediate impact; high value for reuse if this channel is ever used outside broker context.

### 3. Invocation Start: Overloaded Constructor Surface — SRP + DIP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-client/src/client.ts:134-147, 149-181, 189-205, 211-223`
- **Current:** Three overlapping entry points (startInvocation, startInvocationFromRequest, #normalizeDispatchOptions, #buildDispatch) with complex parameter normalization logic. The public API tolerates both `dispatchEnv` and `InvocationStartDispatchOptions`, requiring runtime type discrimination.
- **Suggested:** Use a builder or overload-specific classes (e.g., InvocationBuilder) to clarify intent and reduce the number of internal normalization methods. Alternatively, expose only startInvocationFromRequest and leave convenience wrappers in a separate file.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** 1–2 days  ·  **Tests:** start-request.test.ts covers both overload paths; all must remain passing.
- **Impact:** Reduces 4 tightly coupled methods to 1–2 clear entry points.

### 4. Event Lifecycle Leaks in Error Path — SRP + DIP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-client/src/client.ts:160-180`
- **Current:** startInvocationFromRequest registers a stream in EventHub upfront, then may fail to register the invocation with the broker. On error, it manually cleans up (drop/close). If #eventHub.stream or #buildDispatch throw, cleanup is skipped.
- **Suggested:** Defer stream registration until after a successful broker RPC, or wrap the entire flow in a try-finally that always cleans up. Alternatively, move this responsibility to a dedicated InvocationSession manager.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** < 1 day  ·  **Tests:** start-request.test.ts, interleaving.test.ts (error case).
- **Impact:** Prevents resource leaks in edge cases (e.g., if #buildDispatch throws after stream creation).

### 5. Async State Machine Without Explicit State — SRP + Code Smell
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-client/src/json-rpc-channel.ts:98-134`
- **Current:** The request() method manages pending requests with just a Map and numeric ID counter. There is no explicit state for "channel-open", "failing", "closed"—only latched bool flags (closed, failure). Multiple transitions are possible (e.g., calling request() after failure() succeeds with the cached error), which is correct but implicit.
- **Suggested:** Introduce an explicit enum-based state machine (OPEN → FAILING → CLOSED) to make state transitions observable and testable. This also aids debugging.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** < 1 day  ·  **Tests:** All integration tests; unmatched-response.test.ts.
- **Impact:** Clarifies correctness of concurrent close/request/fail transitions.

### 6. PermissionRouter: Hardcoded console.warn Dependency — DIP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-client/src/permission-router.ts:20-24`
- **Current:** PermissionRouter defaults to console.warn for warnings but is hardcoded to inject it. The BrokerClient does not provide an override path for custom logging/metrics backends.
- **Suggested:** Allow BrokerClient to pass a warn function (or logger interface) through to PermissionRouter, or move the warn callback to a central telemetry/instrumentation module.
- **Risk:** Low  ·  **API-impact:** public-surface (minor)  ·  **Effort:** < 1 day  ·  **Tests:** permission-handler.test.ts confirms no warnings on success; new test for custom warn function.
- **Impact:** Enables integration with application logging infrastructure.

### 7. UnixSocketTransport & StdioTransport: Duplicated Close Ceremony — DRY
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-broker-client/src/unix-socket-transport.ts:98-115, stdio-transport.ts:69-96`
- **Current:** Both transports repeat "if already closed, return promise; set closed flag; reject pending; handle already-exited case" boilerplate (lines roughly 98–104 in unix, 70–79 in stdio).
- **Suggested:** Move the common close ceremony to JsonRpcFramedChannel as a template method, delegating only the resource-specific part (kill child vs. destroy socket) to subclasses.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** < 1 day  ·  **Tests:** process-exit.test.ts, all close paths.
- **Impact:** ~15 lines of duplication removed; clearer layering between abstract and concrete.

---

## Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Long method (50+ lines) | json-rpc-channel.ts:182-206 (#handleRequest) | Low — straightforward error handling; single responsibility. |
| Nested callbacks (3 levels) | stdio-transport.ts:35–51 | Med — on('data'), on('error'), on('exit') all register handlers; each does its own thing. Could extract to a setupChildHandlers() method. |
| Nested callbacks (4 levels) | unix-socket-transport.ts:55–89 (connect timeout + settle logic) | Med — settled flag, timer, two socket event handlers all nest to manage race condition. Could extract to a ConnectHelper or use Promise.race more explicitly. |
| Magic numbers | socket-path.ts:10 (108, 104) | Low — well-documented as platform limits; used only once per platform. |
| No-op overrides | event-iterator.ts:47–49 (return) | Low — AsyncIterator contract requires return(); this is a correct no-op. |
| Implicit type coercion | json-rpc-channel.ts:229–231 (#idKey) | Low — String(id) is correct; id can be string or number per JSON-RPC spec. |

---

## Quick Wins (Low Risk, High Value)

1. **Extract nested callback setup in StdioTransport** (< 30 min)
   - Move lines 35–51 (stdio-transport.ts) into a private #setupChildHandlers() method.
   - Clarifies intent; no behavior change.

2. **Move socket-path validation into transport constructors** (< 30 min)
   - UnixSocketTransport.connect already calls assertSocketPathWithinBudget (line 56).
   - Consider caching the budget check in a lazy static so it's not recomputed per connect.

3. **Deduplicate close ceremony** (< 1 day)
   - Extract "if already closed, set closed flag, reject pending" into a protected closeImpl() in JsonRpcFramedChannel.
   - Each subclass overrides only the resource-specific teardown.

4. **Add explicit state machine to JsonRpcFramedChannel** (< 1 day)
   - Replace (closed, failure) flags with an enum-based state machine (OPEN | FAILING | CLOSED).
   - Add a test to verify transitions are correct.

---

## Technical Debt Notes

- **Event stream lifecycle complexity:** InvocationEventHub owns buffering and deduplication, but BrokerClient must manually manage the stream lifecycle on start/dispose/close. Consider a higher-level wrapper (e.g., InvocationSession) that bundles stream + lifecycle.

- **Transport abstraction is sound but could be more testable:** JsonRpcFramedChannel is abstract; both concrete transports are well-designed. However, error paths (late response, malformed NDJSON) are tested only indirectly via integration tests. Consider adding unit tests that directly inject frames into a mock channel.

- **Permission handler error handling is lenient:** If the handler throws, it falls back to broker's defaultDecision silently. This is correct from a safety perspective but may hide bugs in production. Consider a metrics/telemetry hook (see DIP finding #6).

- **No built-in request timeout:** Callers must manage their own timeouts for request() calls. The unix socket connect has a timeout (UnixSocketTransport line 62–74), but request() does not. Consider a default timeout in JsonRpcFramedChannel.

- **EventIterator does not backpressure:** If events arrive faster than the consumer iterates, the buffer grows unbounded. Consider a max-buffer-size limit with a backpressure signal.

---

## Summary

The codebase is well-structured and follows SOLID principles overall. The main violations are:
1. **SRP:** BrokerClient mixes API surface, permission routing, and event coordination (329 lines).
2. **DIP:** Limited injection points for PermissionRouter's warn function and JsonRpcFramedChannel's error construction.

All violations are internal-scoped except the public API surface of BrokerClient, which is stable and unlikely to break. Most fixes are low-risk refactorings that improve clarity without behavior changes.

The codebase would benefit from:
- Extracting 40–60 lines of permission + event-hub coordination from BrokerClient.
- Making the JSON-RPC channel more reusable by parameterizing error construction.
- Deduplicating close ceremony across transports.
- Adding an explicit state machine to JsonRpcFramedChannel for correctness verification.

All recommendations are actionable within 3–5 days of effort.
