# 🔧 Refactoring Analysis

**Target:** `packages/harness-broker-client/src`
**Lines analyzed:** 1033 (8 source files)
**Generated:** 2026-06-01  ·  **Focus:** all

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🟡 | `BrokerClient` mixes RPC façade, event-stream demux, dedupe, and permission routing in one class; `startInvocationFromRequest` blends arg-overload normalization with dispatch logic. |
| Open/Closed | 🟢 | Method dispatch uses a transport-agnostic interface; no growing type-keyed switch. Minor: `#handleMessage` message-kind chains are bounded by the JSON-RPC spec, not by feature growth. |
| Liskov Substitution | 🟡 | `StdioTransport.close()` and `UnixSocketTransport.close()` honor the same signature but diverge sharply in behavior (one kills the broker child, one only closes its socket). Substitutable by type, surprising by contract. |
| Interface Segregation | 🟢 | `BrokerJsonRpcTransport` has 5 cohesive members. Handler types are minimal. |
| Dependency Inversion | 🟢 | `BrokerClient` depends on the `BrokerJsonRpcTransport` abstraction and exposes `fromTransport()` for injection. Concrete `new EventIterator()` is a value object, acceptable. |

## 🎯 Priority Refactorings

### 1. Duplicated transport implementation — DRY / SRP
- **Location:** `stdio-transport.ts:35-262` and `unix-socket-transport.ts:37-284`
- **Current:** The two transports are ~80% identical. `request()` (stdio:102-136 / unix:121-155), `#handleMessage` (stdio:178-201 / unix:207-230), `#handleRequest` (stdio:203-223 / unix:232-252), `#rejectPending` (stdio:251-257 / unix:273-279), `#idKey` (stdio:259-261 / unix:281-283), and the `PendingRequest` type + the `#decoder/#nextId/#pending/#notificationHandler/#requestHandler/#closeHandler/#closed` field set are copy-pasted. Only the underlying channel (child stdio vs socket), the close semantics, and stdio's stderr-tail capture genuinely differ.
- **Suggested:** Extract a `JsonRpcFramedChannel` base (or a `JsonRpcMux` composed helper) that owns NDJSON decode, id allocation, pending-request map, request/response/notification routing, and `#write`. Have each transport supply only: a `write(frame)` sink, a teardown strategy, and channel-specific failure messages. Stdio keeps the stderr-tail enrichment as an override hook.
- **Risk:** Med  ·  **Effort:** ~0.5 day  ·  **Tests:** `stdio`/`unix` behavior covered by `process-exit.test.ts`, `unix-socket-transport.red.test.ts`, `integration.test.ts`, `interleaving.test.ts` — run all after extraction; add a shared-channel unit test.

### 2. `startInvocationFromRequest` overload normalization tangle — SRP / readability
- **Location:** `client.ts:133-181`
- **Current:** The method accepts `dispatchEnvOrOptions` as either a `Record<string,string>` OR an `InvocationStartDispatchOptions`, discriminated by an inline `'dispatchEnv' in … || 'runtime' in … || 'lifecyclePolicy' in …` probe (lines 141-150), then assembles the dispatch envelope, then performs the request with rollback (lines 163-180). Three responsibilities in one ~48-line method; the `as` casts (146, 148) defeat the type system.
- **Suggested:** Extract `#normalizeDispatchOptions(arg, runtime): InvocationStartDispatchOptions` and `#buildDispatch(request, options): InvocationDispatchRequest`. Consider deprecating the positional `dispatchEnv`/`runtime` overload in favor of the options object to remove the discriminator entirely.
- **Risk:** Low  ·  **Effort:** ~2 hr  ·  **Tests:** `start-request.test.ts` exercises both call shapes — keep both green.

### 3. `BrokerClient` carries four distinct responsibilities — SRP
- **Location:** `client.ts:63-335`
- **Current:** One class owns (a) the typed RPC method façade (`hello`/`health`/`input`/`status`/`attach`/`eventsSince`/… — ~18 thin delegators), (b) event-stream lifecycle via `#events`/`#pendingEvents`/`#eventStream`/`#closeEventStreams`, (c) duplicate-seq suppression via `#lastEventSeq`/`#ingestEvent`, and (d) inbound permission-request routing (`#handlePermissionRequest`). Four reasons to change.
- **Suggested:** Extract an `InvocationEventHub` (owns `#events`, `#pendingEvents`, `#lastEventSeq`, `#ingestEvent`, `#eventStream`, `#closeEventStreams`) and a `PermissionRouter` (owns `#permissionHandler`, `#handlePermissionRequest`). `BrokerClient` retains the RPC façade and composes the two. Keeps the public surface identical.
- **Risk:** Med  ·  **Effort:** ~0.5 day  ·  **Tests:** `interleaving.test.ts`, `permission-handler.test.ts`, `broker-permission-reconnect.red.test.ts` cover the extracted behavior; run after split.

### 4. Hardcoded fence error code / decision fallback — magic numbers
- **Location:** `unix-socket-transport.ts:197-203` (`code: params.code ?? -32015`) and `client.ts:312, 323` (`request.defaultDecision ?? 'deny'`)
- **Current:** `-32015` is the `ControllerFenced` JSON-RPC code inlined with a comment but no named constant; `'deny'` is the duplicated safe-default permission decision.
- **Suggested:** Import the fence code from `spaces-harness-broker-protocol` if one is exported there (single source of truth); otherwise a local `const CONTROLLER_FENCED_CODE = -32015`. Hoist the `'deny'` fallback to one `DEFAULT_DENY_DECISION` constant in `client.ts`.
- **Risk:** Low  ·  **Effort:** ~30 min  ·  **Tests:** `broker-durability-unix.red.test.ts` asserts the fenced path.

### 5. `close()` contract divergence between transports — LSP
- **Location:** `transport.ts:17-23`, `stdio-transport.ts:138-165`, `unix-socket-transport.ts:161-178`
- **Current:** Both implement `close(options?: { graceMs? })`, but stdio uses `graceMs` to SIGTERM→SIGKILL its owned child while unix IGNORES `graceMs` (the param is `_options`) and only destroys its socket. A caller holding a `BrokerJsonRpcTransport` cannot reason about whether `close()` terminates the broker. The interface doc-comment (transport.ts:13-16) acknowledges this, which confirms it is a deliberate-but-leaky abstraction.
- **Suggested:** Either split the contract (`OwnedTransport.close()` vs `SharedTransport.disconnect()`) or document the divergence on the interface method itself and have `UnixSocketTransport.close` reject/ignore non-empty `graceMs` explicitly rather than silently discarding it.
- **Risk:** Med (touches public types)  ·  **Effort:** ~3 hr  ·  **Tests:** `process-exit.test.ts` (stdio kill path), `unix-socket-transport.red.test.ts` (socket-only close).

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Duplicated class (~80% shared) between two transports | `stdio-transport.ts` / `unix-socket-transport.ts` | 🟠 |
| `as` casts bypassing the type system in overload probe | `client.ts:146,148,261,307` | 🟠 |
| Boolean-flag overload (`dispatchEnvOrOptions` union) — long, branchy signature | `client.ts:133-150` | 🟡 |
| Magic numbers `-32015`, `-32601`, `-32603` inlined | `unix-socket-transport.ts:197,235`; `stdio-transport.ts:206`, etc. | 🟡 |
| Duplicated `'deny'` default-decision literal | `client.ts:312,323` | 🟡 |
| `console.warn` for control-flow logging in a library (no injected logger) | `client.ts:309,318` | 🟡 |
| Swallowed promise rejection guard `promise.catch(() => {})` duplicated | `stdio-transport.ts:126`, `unix-socket-transport.ts:145` | 🟡 |
| Repeated `#idKey`/`String(id)` + `PendingRequest` type in both transports | both transports | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Hoist `-32015` (controller-fenced) and the `'deny'` default decision into named constants (Finding 4).
2. Extract `#normalizeDispatchOptions` / `#buildDispatch` from `startInvocationFromRequest` to flatten the union-overload tangle (Finding 2) — pure internal refactor, public signature unchanged.
3. Replace the two `console.warn` calls in `#handlePermissionRequest` with an optional injected `onWarn`/logger so the library does not write to stderr unconditionally.

## ⚠️ Technical Debt Notes

- The transport duplication (Finding 1) is the dominant debt: any protocol-framing fix (NDJSON edge cases, pending-request leaks, request-id collisions) must currently be applied twice and kept in sync by hand. The stdio/unix `#handleMessage` already drifted — unix added a `control.fenced` branch (lines 191-205) that stdio lacks — which is exactly the divergence a shared base would prevent.
- The `BrokerClient` event-dedupe logic (`#lastEventSeq`, `#ingestEvent`) is subtle (drop-on-`seq <= lastSeq`) and lives inline among unrelated RPC delegators; isolating it (Finding 3) would make it independently testable.
- `transport.ts` interface comment openly documents that `close()` means two different things — a sign the abstraction is leaking (Finding 5). Acceptable today, but worth a typed split before a third transport arrives.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (`integration.test.ts`, `interleaving.test.ts`, `process-exit.test.ts`, `permission-handler.test.ts`, `start-request.test.ts`, `unix-socket-transport.red.test.ts`, `broker-durability-unix.red.test.ts`)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run `bun run test` between each
- [ ] Run `bun run typecheck` and `bun run check:boundaries` after the transport extraction
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

These are NOT in the first pass above. They focus on async/cleanup correctness, the
`EventIterator` concurrency contract, public-API/contract gaps, and a socket-teardown
data-loss window — areas the first report did not cover.

### A1. `EventIterator.return()` abandons in-flight `next()` waiters and never closes — async-cleanup bug
- **Location:** `event-iterator.ts:47-49` (`return()`), interacting with `next()` `#waiters` at `event-iterator.ts:42-45`.
- **Smell/principle:** Resource-cleanup correctness / leaky async-iterator contract (broken `AsyncIterator` protocol).
- **Detail:** `return()` resolves only the *caller's* `{ done: true }` and does NOT set `#closed` nor settle the `#waiters` array. When a consumer does `for await (… of events) { break }`, JS calls `iterator.return()`; any *other* pending `next()` promise (e.g. a second consumer, or a re-entered loop) stays unresolved forever, and the iterator is still "open" so future `push()` still buffers. By contrast `close()` *does* flush waiters and latch `#closed`. So the two teardown paths (`close()` vs `return()`) leave the object in inconsistent states. `return()` should set `#closed = true` and drain `#waiters` exactly like `close()`.
- **Risk:** Med (changes iterator semantics)  ·  **Effort:** ~1 hr  ·  **Tests:** none today exercise `break`/`return()` — no `for await` loop appears in any test (`grep "for await" test/` → 0 hits). Add a test that breaks out of a `for await` mid-stream and asserts the iterator is closed and a concurrent `next()` settles.

### A2. `EventIterator.next()` can't distinguish a pushed `undefined` value from an empty buffer — generic-contract bug
- **Location:** `event-iterator.ts:33-34` (`const event = this.#buffer.shift(); if (event !== undefined)`).
- **Smell/principle:** Primitive/sentinel-value abuse; `EventIterator<T>` is exported as a *public generic* (`index.ts:8`) yet silently breaks for any `T` that includes `undefined`.
- **Detail:** `shift()` returns `undefined` both when the buffer is empty and when the next buffered element *is* `undefined`. A `push(undefined)` followed by `next()` would be treated as an empty buffer and the value dropped/blocked. Today the only internal `T` is `InvocationEventEnvelope` (never `undefined`), so it's latent — but the type is public API. Track buffer emptiness by length (`if (this.#buffer.length > 0) return Promise.resolve({ done:false, value: this.#buffer.shift() as T })`) instead of a value-sentinel.
- **Risk:** Low  ·  **Effort:** ~20 min  ·  **Tests:** add `EventIterator<undefined>` push/next unit test.

### A3. `BrokerClient.onClose` close-handler loop is unguarded — one throwing subscriber starves the rest
- **Location:** `client.ts:84-89` (`for (const handler of this.#closeHandlers) handler(error)`).
- **Smell/principle:** Error-handling / fan-out robustness (swallow-vs-propagate inconsistency).
- **Detail:** The transport `onClose` callback synchronously calls every registered close handler with no try/catch. If any handler throws, the remaining handlers never run and the exception escapes into the transport's close path (`#fail` → `#closeHandler`), which is itself not expecting a throw from notifying the client. Compare with `#handlePermissionRequest`, which *does* guard handler failure. The close fan-out should isolate each handler (try/catch per handler) so one buggy subscriber can't abort cleanup of the others.
- **Risk:** Low  ·  **Effort:** ~20 min  ·  **Tests:** add a test registering two `onClose` handlers where the first throws; assert the second still fires.

### A4. `onClose` / `onPermissionRequest` have no unsubscribe; `#closeHandlers` only grows — leak + last-writer-wins contract
- **Location:** `client.ts:239-245` (`onPermissionRequest`, `onClose`), `#closeHandlers` declared `client.ts:71`.
- **Smell/principle:** API/contract surface; missing teardown seam; silent overwrite.
- **Detail:** (a) `onClose(handler)` returns `void` and there is no `offClose`; a long-lived `BrokerClient` that accrues handlers (e.g. per-invocation subscribers) leaks them for the client's lifetime. Idiomatic Node/EventTarget APIs return a disposer. (b) `onPermissionRequest` is single-slot last-writer-wins (`#permissionHandler = handler`) with no warning — a second registration silently shadows the first, which is surprising for a "register a handler" method. Either document single-handler semantics explicitly or return the previous handler / reject a double-register.
- **Risk:** Low (additive)  ·  **Effort:** ~1 hr  ·  **Tests:** add unsubscribe + double-register tests.

### A5. `InvocationStartDispatchOptions` is in a public method signature but not exported — contract gap
- **Location:** type defined `client.ts:57-61`; consumed by the public `startInvocationFromRequest(... dispatchEnvOrOptions?: … | InvocationStartDispatchOptions …)` at `client.ts:135`; **absent** from `index.ts:1-23` (only `ConnectUnixOptions`, `InvocationStartResult`, `PermissionRequestHandler` are re-exported).
- **Smell/principle:** Interface Segregation / public-API completeness — a caller cannot name the options object type they're expected to pass without reaching into a non-barrel path.
- **Detail:** External consumers building the options object must duplicate the shape or import from a deep path. Add `InvocationStartDispatchOptions` to the `export type { … } from './client'` block.
- **Risk:** Low  ·  **Effort:** ~5 min  ·  **Tests:** none (type-only export); `bun run typecheck`.

### A6. `UnixSocketTransport.close()` calls `socket.end()` immediately followed by `socket.destroy()` — drops buffered/unflushed writes
- **Location:** `unix-socket-transport.ts:174-175`.
- **Smell/principle:** Resource-teardown correctness / abrupt close.
- **Detail:** `end()` schedules a graceful FIN after flushing the write buffer, but the very next line `destroy()` tears the socket down synchronously, discarding anything `end()` hadn't flushed and skipping the FIN handshake. If a final frame (e.g. a last `permission.respond` or `dispose`) is still buffered, it can be lost. Either `end()` and await the `'finish'`/`'close'` event before `destroy()`, or just call one of them. (The stdio counterpart correctly does `stdin.end()` then *waits* on the exit promise before escalating — the unix path has no equivalent flush wait.)
- **Risk:** Med  ·  **Effort:** ~1 hr  ·  **Tests:** `unix-socket-transport.red.test.ts` covers socket-only close; add a test asserting a write issued just before `close()` is flushed.

### A7. `structuredClone(dispatch)` on every `invocation.start` — needless deep copy + throw surface
- **Location:** `client.ts:166` (`this.#transport.request('invocation.start', structuredClone(dispatch))`).
- **Smell/principle:** Performance hot-spot / defensive-copy of a just-constructed object; hidden failure mode.
- **Detail:** `dispatch` is freshly assembled one line earlier (`client.ts:154-161`) from caller-owned fragments — it is not subsequently mutated by this method, so the clone guards only against the *transport* mutating it (which it doesn't; it serializes to NDJSON). The clone is dead-weight on a per-invocation hot path and, worse, `structuredClone` *throws* on any non-cloneable member (functions, class instances) inside `startRequest.spec` / `runtime` / `dispatchEnv`, converting a previously-serializable payload into a hard crash. If a defensive copy is truly required, document why; otherwise drop it (the protocol layer serializes anyway).
- **Risk:** Low  ·  **Effort:** ~15 min  ·  **Tests:** `start-request.test.ts` — assert the dispatch payload still matches after removing the clone.

### A8. Unbounded `#nextId` request-id space is per-transport-instance, not globally unique across reconnect — latent dedupe hazard
- **Location:** `unix-socket-transport.ts:42,129` and `stdio-transport.ts:39,110` (`#nextId = 1`; ids `req_${this.#nextId++}`).
- **Smell/principle:** Concurrency / id-uniqueness across the broker-durability reconnect story.
- **Detail:** Each transport restarts `#nextId` at `1`, so two successive `UnixSocketTransport.connect()` sessions to the *same* long-lived broker (the documented reconnect/attach use case) both issue `req_1, req_2, …`. The broker correlates responses per-connection so this is currently safe, but the in-flight `permission.respond` / `eventsSince` durability flows assume the broker can't confuse a stale response from a prior connection with a new request of the same id. A connection-scoped prefix (or a monotonic high-resolution seed) would remove the ambiguity and make the id collision-proof if request framing ever crosses reconnect boundaries.
- **Risk:** Low (latent)  ·  **Effort:** ~30 min  ·  **Tests:** `broker-durability-unix.red.test.ts`, `broker-permission-reconnect.red.test.ts`.

### A9. `#handleMessage` response-not-found is silently dropped — no observability for late/duplicate responses
- **Location:** `stdio-transport.ts:181-183` and `unix-socket-transport.ts:210-212` (`if (!pending) return`).
- **Smell/principle:** Swallowed-signal / missing edge-case handling.
- **Detail:** A response whose id is not in `#pending` (late response after timeout/reject, duplicate response, or a broker echoing a wrong id) is dropped with no trace. During the durability reconnect work this is exactly the class of bug (stale response from a fenced connection) that is hardest to diagnose because nothing records it. A debug hook / counter for "unmatched response id" would make these visible without changing the happy path.
- **Risk:** Low  ·  **Effort:** ~30 min  ·  **Tests:** add a transport unit test feeding an unknown-id response and asserting an injected debug sink is notified.

### A10. `dispose()` deletes `#events` + `#lastEventSeq` but leaves orphaned `#pendingEvents` — state-cleanup gap
- **Location:** `client.ts:199-205` (`dispose`) vs the three maps cleared together only in `#closeEventStreams` (`client.ts:327-334`).
- **Smell/principle:** Incomplete teardown / map-set drift (three maps keyed by invocationId, but `dispose` cleans only two).
- **Detail:** `dispose(req)` closes the stream and deletes `#events[id]` and `#lastEventSeq[id]`, but does **not** delete `#pendingEvents[id]`. If events were buffered for an invocation that never had `#eventStream(id)` called (so they sat in `#pendingEvents`) and the caller disposes it, that buffer leaks until the whole client closes. The three maps should be cleaned as a unit on `dispose` just as they are in `#closeEventStreams`.
- **Risk:** Low  ·  **Effort:** ~15 min  ·  **Tests:** `interleaving.test.ts` — add a dispose-before-stream-drained case asserting `#pendingEvents` is cleared.
