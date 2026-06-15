# 🔧 Refactoring Analysis — spaces-harness-broker-client

**Target:** `packages/harness-broker-client/src`  ·  **Files read:** 11 (src) + 9 test files (read for contracts)  ·  **Lines:** 1202 (src)
**Generated:** 2026-06-14  ·  **Package type:** concurrent (async JSON-RPC transport / event-stream client)

## 🧭 Summary
A small, well-factored JSON-RPC broker client. The shared `JsonRpcFramedChannel` base cleanly hoists framing/pending-map/routing out of the two concrete transports — a genuine, twice-instantiated abstraction (not premature). The highest-leverage concern is the `startInvocationFromRequest` overload, whose positional/options-object polymorphism silently drops the third positional `runtime` arg when an options object is passed — a sharp Hyrum's-Law edge on the public surface. Most remaining items are low-risk internal tidies; there is little dead structure to remove.

## 🚪 Public boundary (assess first)
- **API surface (`index.ts`):** `BrokerClient` (class); types `ConnectUnixOptions`, `Disposer`, `InvocationStartDispatchOptions`, `InvocationStartResult`, `PermissionRequestHandler`; errors `BrokerRpcError`, `BrokerTransportError`; `JsonRpcChannelDebugOptions`, `UnmatchedResponseSink`; `EventIterator`; `StdioTransport` + `StdioTransportStartOptions`; `UnixSocketTransport` + `UnixSocketTransportConnectOptions`; `assertSocketPathWithinBudget`, `socketPathByteBudget`, `socketPathByteLength`; transport contract types `BrokerJsonRpcTransport`, `CloseHandler`, `NotificationHandler`, `RequestHandler`.
- **Findings:** The `startInvocation` / `startInvocationFromRequest` overload pair is the only contract-shaped concern (T07). The transport `close(options?)` contract is honest but asymmetric (graceMs ignored on unix) — documented, not a defect. Everything else is a thin, faithful delegation to the transport.
- **Verdict:** 🟡 needs care — surface is sound and well-documented except for the start-overload arg-resolution edge.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. `startInvocationFromRequest` overload silently drops 3rd positional `runtime` when 2nd arg is an options object — [T12] Make illegal states unrepresentable / [T07] Align interface to actual usage
- **Location:** `client.ts:149-210` (`startInvocationFromRequest` + `#normalizeDispatchOptions`)
- **Mechanism repaired:** A single parameter slot (`dispatchEnvOrOptions`) encodes two mutually-exclusive call shapes (bare `dispatchEnv` map vs. full options object), discriminated at runtime by `'dispatchEnv'/'runtime'/'lifecyclePolicy' in arg`. When the options-object branch is taken, the 3rd positional `runtime` is unreachable and dropped. The type system permits `startInvocationFromRequest(req, {dispatchEnv}, runtime)` — a call whose `runtime` is silently lost. That illegal-yet-typeable combination is the structural cause.
- **Symptom that flagged it:** One parameter typed as a union of two object shapes + a separate positional that only one branch consumes; `as` casts in `#normalizeDispatchOptions` to recover the intended shape.
- **Current → Suggested:** Expand/Contract (M02): add a single-options-object overload signature (`runtime`/`lifecyclePolicy`/`dispatchEnv` all in the object — `InvocationStartDispatchOptions` already exists and is exported), keep the legacy `(req, dispatchEnv, runtime)` positional shape supported, deprecate it in TSDoc, then migrate callers (the repo has exactly one external caller — `pre-hrc-broker-contract-harness.ts:949` already uses the options-object form) and finally remove the bare-map + 3rd-positional path. Do NOT collapse in place; this is observable surface.
- **Direction:** isolate (narrow the polymorphic slot via Expand/Contract)
- **Preservation:** test-suite — `start-request.test.ts` exercises bare-map (line 191), positional-runtime (line 218), and options-object (line 251) forms; all must stay green through the support-both phase. This is a redesign of the call contract, not a pure refactor — flag as such.
- **Falsifiable signal:** After contract: `startInvocationFromRequest(req, {dispatchEnv}, runtime)` becomes a type error (3rd arg no longer accepted alongside an options object), and the runtime branch in `#normalizeDispatchOptions` is gone.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** M
- **Tests:** existing `start-request.test.ts` overload matrix; add a characterization test pinning that options-object + positional-runtime today drops runtime (to document the behavior being removed).
- **Contraindication:** The positional overload is a deliberate back-compat affordance; if other repos (hrc-runtime) pass the 3rd positional, the removal phase must wait on their migration. Keep support-both until cross-repo callers are confirmed migrated.

### 2. `#normalizeDispatchOptions` + `#buildDispatch` discriminate-by-key duplicated against `InvocationStartDispatchOptions` shape — [T15] Extract missing abstraction (the option-key set)
- **Location:** `client.ts:198-210` (key list `'dispatchEnv' | 'runtime' | 'lifecyclePolicy'`) and `client.ts:220-227` (same three keys conditionally spread)
- **Mechanism repaired:** The three option keys are written out as string literals in the discriminator AND again as conditional spreads in `#buildDispatch`. The set "which keys are dispatch options" lives in two places; adding a 4th option means editing both, and the discriminator can drift from the actual `InvocationStartDispatchOptions` field set.
- **Symptom that flagged it:** Same triple of literals (`dispatchEnv`/`runtime`/`lifecyclePolicy`) appearing in two adjacent methods with no single source of truth.
- **Current → Suggested:** Name the key set once (e.g. `const DISPATCH_OPTION_KEYS = ['dispatchEnv','runtime','lifecyclePolicy'] as const`) and derive both the `in`-discriminator and the build-spread from it. Tightly coupled to Finding 1; best done as part of that contract change (when the bare-map branch is removed, the discriminator largely disappears anyway).
- **Direction:** relocate (single source of truth for the option-key set)
- **Preservation:** type/compiler-proof — same emitted dispatch object; the spread already forwards only these three keys, so no extra-prop leakage is introduced.
- **Falsifiable signal:** Adding a key to `InvocationStartDispatchOptions` requires touching one constant, not two methods.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** `start-request.test.ts` dispatch-envelope assertions (lines 161-272).
- **Contraindication:** If Finding 1 removes the bare-map branch, the discriminator collapses entirely; do this only in concert to avoid churning code that's about to be deleted. The coincidental "three literals" is NOT coincidental here — it is the same concept, so extraction is warranted.

### 3. Inbound broker→client request routing is a one-arm method switch in the constructor — [T19] Conditional ↔ dispatch (keep inline; flag for future)
- **Location:** `client.ts:81-86` (`onRequest` handler: `if method === 'invocation.permission.request' … else throw`)
- **Mechanism repaired:** Inbound request dispatch is currently a single `if/throw`. This is the correct shape for ONE method — a map/dispatch table would be premature abstraction (T16 contra). Flag only so that if a second broker→client request method is added, it converts to a dispatch table rather than growing an `else if` chain.
- **Symptom that flagged it:** A method-name `if` in hot constructor wiring.
- **Current → Suggested:** Leave as-is. Documented as a watch-point, not an action.
- **Direction:** (none — where-NOT)
- **Preservation:** n/a
- **Falsifiable signal:** n/a
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** n/a
- **Tests:** `permission-handler.test.ts`.
- **Contraindication:** One arm only — converting now would be premature abstraction. Do not flag as actionable.

### 4. `#idKey` / `String(id)` private helper is a trivial pass-through — [T23] Remove middle man (marginal; keep)
- **Location:** `json-rpc-channel.ts:229-231` (`#idKey(id) { return String(id) }`), used at lines 154 and 106-implied
- **Mechanism repaired:** A one-line private wrapper around `String()`. It does name the intent ("the map key for a JSON-RPC id is its string form") and centralizes the id→key coercion so the `request()` key (`req_N` string) and the response-match key stay consistent. That centralization is load-bearing.
- **Symptom that flagged it:** A private method that only forwards to a built-in.
- **Current → Suggested:** Keep. The wrapper documents the id-coercion invariant shared between `request` (writes `req_${n}`) and `handleMessage` (reads `String(message.id)`). Inlining would scatter the coercion rule.
- **Direction:** (none — where-NOT)
- **Preservation:** n/a
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** n/a
- **Contraindication:** Removing it re-duplicates the coercion intent across two call sites — the opposite of T15. Leave alone.

### 5. `assertWritable()` vs. inline `this.failure` reject in `request()` — duplicated failure-latch read — [T15] Extract missing abstraction (minor)
- **Location:** `json-rpc-channel.ts:99-104` (`request` checks `this.failure` then `this.closed` inline) vs. `json-rpc-channel.ts:234-238` (`assertWritable` throws `this.failure`) vs. `writeFrame` overrides in both transports calling `assertWritable()`
- **Mechanism repaired:** The "is this channel still usable?" gate is expressed two ways: `request()` returns a rejected promise from raw `this.failure`/`this.closed` reads; `writeFrame` throws via `assertWritable()`. They differ deliberately (request must REJECT, writeFrame must THROW; request also distinguishes `closed` with a fresh `BrokerTransportError`), so the apparent duplication is two distinct error-delivery contracts.
- **Symptom that flagged it:** Two readers of the same `failure` latch with similar guard logic.
- **Current → Suggested:** Leave as-is; the reject-vs-throw distinction is intentional and the messages differ. Documented as where-NOT.
- **Direction:** (none — where-NOT)
- **Preservation:** n/a
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** n/a
- **Contraindication:** Unifying would force one error-delivery mode (throw vs. reject) on both call sites, changing the `request()` rejection behavior. Behavior-preserving extraction not available cheaply.

### 6. `startInvocation` overload pre-builds `{ spec }` vs `{ spec, initialInput }` — conditional object assembly — [T22/clarity] (keep)
- **Location:** `client.ts:140-147`
- **Mechanism repaired:** `initialInput === undefined ? { spec } : { spec, initialInput }` avoids forwarding an explicit `initialInput: undefined` into the `InvocationStartRequest` (which would change the serialized envelope — a real wire-shape concern given exactOptionalPropertyTypes). This is a deliberate exact-field-set guard, not a smell.
- **Symptom that flagged it:** Ternary constructing two object shapes.
- **Current → Suggested:** Keep. The ternary preserves the exact serialized field set; `{ spec, initialInput: undefined }` would forward an extra `undefined` key (spread/projection hazard called out in the brief).
- **Direction:** (none — where-NOT)
- **Risk:** Low  ·  **API-impact:** internal-only
- **Contraindication:** Collapsing to a spread would emit `initialInput: undefined` and alter the NDJSON frame. Do not touch.

## 🪶 Deliberately left alone (where-NOT)
- **`JsonRpcFramedChannel` abstract base** (`json-rpc-channel.ts`) — genuinely shared by two concrete transports (`StdioTransport`, `UnixSocketTransport`), each overriding only `writeFrame`/`close` (+ unix `handleMessage` for the `control.fenced` fence). This is a correctly-extracted abstraction with two real instantiations; NOT a one-implementor interface. Do not collapse (T16 does not apply).
- **`BrokerJsonRpcTransport` interface** (`transport.ts`) — two implementors plus a `fromTransport` test/custom-channel seam; the substitution seam is real and used. Keep.
- **`EventIterator` push/buffer/waiters state machine** (`event-iterator.ts`) — the closed-latch + waiters/buffer logic is a tight, correct producer/consumer queue with a one-shot `onReturn` hook; the `#closed` boolean is a single latch, not boolean-soup. No T10 reification needed.
- **`InvocationEventHub` three-map model** (`#events`/`#pendingEvents`/`#lastEventSeq`) — each map has a distinct lifecycle (live stream / pre-stream buffer / dedup floor) and `drop` vs `dispose` deliberately diverge (drop keeps `#lastEventSeq`, dispose clears it). The asymmetry is documented and load-bearing; do not "simplify" into one structure.
- **`socket-path.ts` platform branch** (`platform() === 'linux' ? 108 : 104`) — a real, documented OS invariant (sockaddr_un budget), not a magic number; the constant is named and explained. Keep.
- **Transport `close(options?)` graceMs asymmetry** — unix ignores `graceMs` by design (broker is long-lived); documented at the interface (`transport.ts:22-33`). Honest leaky-but-intentional contract; not a finding.
- **`PermissionRouter` console.warn default + deny fallback** (`permission-router.ts`) — error handling is explicit and total: handler-throw and no-handler both fall back to `defaultDecision`/deny with a warning. Correct T18 shape already; nothing swallowed silently.

## 🔭 If applying: outside-in sequence
1. (Public, route through human) Finding 1 — Expand/Contract the `startInvocationFromRequest` overload: add options-object signature, support-both, migrate the single in-repo caller, confirm cross-repo (hrc-runtime) callers, then contract.
2. (Bundled with 1) Finding 2 — collapse the dispatch-option-key duplication once the bare-map branch is being reworked; derive discriminator + build-spread from one `as const` key list.
3. No standalone internal-only auto-applicable edits remain — Findings 3-6 are deliberate where-NOT keeps.

## ✅ Safety checklist
- [ ] Verified `JsonRpcFramedChannel` has two real implementors before declining T16 — confirmed (Stdio + Unix).
- [ ] Verified the start-overload arg-drop is real, not already fixed — confirmed via `#normalizeDispatchOptions` (3rd positional unreachable in options-object branch).
- [ ] Verified the option-key triple appears in two methods — confirmed (`client.ts:198-202` and `220-227`).
- [ ] Spread/projection: confirmed `#buildDispatch` and `startInvocation`'s `{ spec }` ternary preserve the exact field set (no extra `undefined` keys forwarded).
- [ ] No biome `useValidTypeof`-class hazard introduced (no `typeof` literal dedup proposed).
- [ ] Public-surface change (Finding 1) flagged as redesign + routed through Expand/Contract, NOT auto-applied.
- [ ] Single in-repo external caller (`pre-hrc-broker-contract-harness.ts:949`) already on the options-object form — migration cost is cross-repo only.
