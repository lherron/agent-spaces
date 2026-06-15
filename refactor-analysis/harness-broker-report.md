# 🔧 Refactoring Analysis — spaces-harness-broker

**Target:** packages/harness-broker/src  ·  **Files read:** 45 (44 source + 1 stale type-fixture)  ·  **Lines:** ~10,010
**Generated:** 2026-06-14  ·  **Package type:** concurrent (event-sequenced broker + process/tmux drivers, async lifecycle state machines)

## 🧭 Summary
This is a mature, heavily-iterated broker: an `index.ts` factory surface (`createBroker`/`createProtocolServer`/managers/drivers), a single `invocation-manager` event state machine, a durable event ledger, an env four-channel composer, and three live drivers (codex-app-server, claude-code-tmux, codex-cli-tmux) plus shared tmux runtime. The public boundary is sound and narrow. The highest-leverage findings are NOT new abstractions but DE-abstractions (T16): a stale type-fixture left in `src/`, dead pre-lease tmux parsers/types, and a backward-compat re-export with zero consumers. The remaining items are internal cohesion lifts (T15) where the two tmux drivers + bridges + transcript readers carry byte-identical machinery.

## 🚪 Public boundary (assess first)
- **API surface (index.ts):** `createBroker`/`Broker`/`BrokerOptions`; `createDefaultBroker`; `createProtocolServer`/`ProtocolServer`/`ProtocolServerOptions`/`RequestHandler`; `createInvocationEventSequencer`/`InvocationEventSequencer`/`EventSequencerOptions`; `BrokerError`/`toJsonRpcError`; `createTmuxPaneController`/`TmuxPaneController` + 7 tmux types; `createInvocationManager`/`InvocationManager`/`Invocation`; `createDriverRegistry`/`DriverRegistry`; `createNoopDriver`/`NoopDriverOptions`; codex-cli-tmux driver + normalizer + kind; `Driver`/`DriverContext`/`DriverStartResult`.
- **Findings:** The surface is a coherent set of factory functions + their option/result types — no fat interface, no caller-side casting around the API. One asymmetry: `createEventLedger`/`EventLedger` is a first-class durability dependency (consumed by `cli.ts` and accepted via `BrokerOptions.eventLedger`) but is NOT exported from `index.ts`; external durable callers must deep-import `./event-ledger`. Not flagged as a defect (no external consumer today — verified `rg`), but noted as the one place the boundary is narrower than the dependency it advertises. `Invocation` is exported as a public type but is the broker's mutable internal record (40+ fields); widening risk if external code reads it.
- **Verdict:** 🟢 sound. No T07/M02 boundary repairs required. All actionable findings are internal-only or de-abstraction.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. Stale type-level test fixture shipped in src/ — [T16] Collapse premature abstraction
- **Location:** `runtime/dispatch-env-type-contracts.ts` (whole file, 36 lines)
- **Mechanism repaired:** dead scaffolding masquerading as source. The file's own header says "Remove or transform this file once T-04408 is green." The brand it was waiting for (`DispatchEnv` opaque type) now exists in `runtime/env.ts:11-15`, and `DriverContext.dispatchEnv`/`ProcessEnvChannels.dispatchEnv` are now `DispatchEnv | undefined`. I ran `tsc --noEmit` against the package: it passes — meaning the `@ts-expect-error` directives are now CORRECT (no longer "spurious"), so the proof has served its purpose and the file is inert.
- **Symptom that flagged it:** "Remove or transform this file once T-04408 is green" comment + "This file has NO runtime exports or behavior."
- **Current → Suggested:** Delete the file. The companion red test (`test/runtime/dispatch-env.red.test.ts`) already references it only in a comment, not via import.
- **Direction:** remove
- **Preservation:** type/compiler-proof — file has no runtime exports (`void _pA; void _pB`); removing it cannot change any observable behavior. `tsc` already green with the brand in place.
- **Falsifiable signal:** `bun run typecheck` stays green after deletion; `rg dispatch-env-type-contracts src` returns nothing.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** trivial
- **Tests:** existing typecheck + suite.
- **Contraindication:** if a CI gate intentionally imports this file as a live "directives must stay correct" canary — none found (`rg` shows only `cli.ts` matches the unrelated `registerBrokerObserverMethods`, and the red test references it by comment only).

### 2. Dead pre-lease tmux parsers/types — [T16] Collapse premature abstraction (REMOVE structure whose variation never materialized)
- **Location:** `runtime/tmux-parse.ts` — `parseVersion` (20-31), `parsePaneState` (33-62), `MIN_SUPPORTED_TMUX_VERSION` (9-12), `WINDOW_NAME` (14); `runtime/tmux.ts` — `TmuxPaneState` type (58-65) and the `export { parsePaneState }` backward-compat re-export (7-8)
- **Mechanism repaired:** structure left behind by the T-01725 pivot to lease-consuming drivers. Since the driver no longer owns/creates a tmux server (it only `inspect`s a leased pane via `parsePaneIdentity`), `parseVersion`/`parsePaneState`/`TmuxPaneState`/the version constants have NO importer anywhere in `src` or `test` (verified by `rg` excluding the definitions). `parsePaneIdentity` + `PANE_IDENTITY_FORMAT` ARE live (used by `TmuxPaneController.inspect`).
- **Symptom that flagged it:** zero-consumer exports; `parsePaneState`/`parseVersion`/`MIN_SUPPORTED_TMUX_VERSION` only appear at their own definitions.
- **Current → Suggested:** Remove `parseVersion`, `parsePaneState`, `MIN_SUPPORTED_TMUX_VERSION`, `WINDOW_NAME`, `TmuxPaneState`, and the `export { parsePaneState }` re-export in `tmux.ts`. Keep `parsePaneIdentity`/`PANE_IDENTITY_FORMAT`.
- **Direction:** remove
- **Preservation:** type/compiler-proof — removing unreferenced exports cannot alter runtime behavior; `tsc` proves no internal consumer. The `parsePaneState` re-export is a documented "backward compatibility" shim but is NOT in `index.ts` (not package-public) and has no in-repo importer.
- **Falsifiable signal:** delete + `bun run typecheck`/`bun test` stay green; `rg parsePaneState packages` returns nothing.
- **Risk:** Med  ·  **API-impact:** internal-only (not exported from index.ts; verified no cross-package importer)  ·  **Effort:** small
- **Tests:** typecheck + full suite; grep proof of zero consumers.
- **Contraindication:** the re-export comment claims a prior public role. Confirm no out-of-repo deep-import on `runtime/tmux` relies on it before deleting the re-export specifically; the parser functions themselves are unambiguously dead.

### 3. Duplicated hook-bridge plumbing across the two tmux drivers — [T15] Extract missing abstraction (name a recurring concept once)
- **Location:** `drivers/claude-code-tmux/hook-bridge.ts` and `drivers/codex-cli-tmux/hook-bridge.ts` — `readAll` and `postEnvelope` are BYTE-IDENTICAL (verified by `diff`); `parseHookJson` and the `run*HookBridgeCli(args)` entrypoint differ only in the bridge name and the `buildHookEnvelopeFromEnv` vs `buildCodexHookEnvelopeFromEnv` call.
- **Mechanism repaired:** one concept ("read stdin hook JSON → wrap envelope → post to unix socket → CLI with --socket, never fail the turn") implemented twice. The ONLY genuine variation is which envelope builder is called (claude requires `callbackSocket`; codex makes it optional).
- **Symptom that flagged it:** `diff` reports identical `readAll`+`postEnvelope`; the CLI entry bodies are structurally identical.
- **Current → Suggested:** Extract `readAll`, `postEnvelope`, `parseHookJson`, and a `runHookBridgeCli({ name, buildEnvelope })` to a shared `drivers/hook-bridge-shared.ts`; each driver's bridge becomes a thin call passing its envelope builder + label.
- **Direction:** relocate (consolidate)
- **Preservation:** test-suite — bodies are identical, so the shared form is observationally equivalent; keep both CLI wrapper names (`runClaudeHookBridgeCli`/`runCodexHookBridgeCli`) as thin delegations so `cli.ts` registration is untouched.
- **Falsifiable signal:** hook-bridge tests + the live virtu/ghoste2e tmux rows stay green; envelope JSON bytes byte-for-byte unchanged.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** small
- **Tests:** bridge unit tests; both tmux pre-hrc matrix rows.
- **Contraindication:** the envelope builders genuinely diverge (`callbackSocket` required vs optional) — keep them separate; share only the transport/CLI shell. Do NOT collapse the envelope builders.

### 4. Duplicated byte-offset JSONL tailer across the two transcript readers — [T15] Extract missing abstraction
- **Location:** `drivers/claude-code-tmux/hook-transcript.ts` `readNewBytes` (103-138) and `drivers/codex-cli-tmux/hook-transcript.ts` `readNewBytes` (255-290) — identical fd/offset/partial-line tailer; only the per-line `processLine` callback differs.
- **Mechanism repaired:** a recurring intent — "synchronously read newly appended bytes of a JSONL file in hook order, split on newlines, retain a partial, reset on truncation" — duplicated with a shared 64KB buffer + offset/partial pattern. The variation is purely the line handler (claude: queue-operation/enqueue → user.message; codex: event_msg deltas/agent_message held-latest).
- **Symptom that flagged it:** two near-identical `readNewBytes` + `existsSync/statSync/openSync/readSync/closeSync` loops and `resetState` offset/partial pairs.
- **Current → Suggested:** Extract a `createJsonlTailer({ onLine(line) })` helper owning `activePath`/`offset`/`partial`/buffer + `setPath`/`readNew`/`reset`; each reader supplies its `processLine` and its event-shaping state.
- **Direction:** relocate (consolidate)
- **Preservation:** test-suite — the tailer mechanics are identical; the differing state (held messages, dedup, message-id minting) stays in each reader. Observational equivalence verified against the existing transcript-ordering tests.
- **Falsifiable signal:** transcript-reader unit tests + tmux event-ordering rows (interim prose before tool events, terminal before turn.completed) stay green.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** medium
- **Tests:** both readers' unit tests; the hook-ordering e2e rows.
- **Contraindication:** the per-line state machines are intentionally divergent and MUST stay separate (claude has no held-latest; codex has delta coalescing + commentary). Share only the file-tailing mechanics, not the classification.

### 5. Duplicated observer-method registration block in cli.ts — [T15] Extract missing abstraction / [T23] collapse near-duplicate
- **Location:** `cli.ts` `registerBrokerObserverMethods` (237-271) re-declares the SAME `broker.hello`/`broker.health`/`broker.listInvocations`/`invocation.status`/`invocation.snapshot`/`invocation.eventsSince` handlers already in `registerBrokerMethods` (161-235), each with an identical `validateParams` inner closure.
- **Mechanism repaired:** the observer surface is a read-only SUBSET of the full surface; today it is a hand-copied second list that will silently drift (e.g. a validation tweak applied to one block only). The `validateParams` closure is itself defined twice byte-identically.
- **Symptom that flagged it:** two `validateParams` closures; six handler registrations duplicated verbatim.
- **Current → Suggested:** Define the read-only method set once (e.g. `registerReadMethods(server, broker)`); have `registerBrokerMethods` call it then add the mutating methods, and `registerBrokerObserverMethods` call it alone. Lift `validateParams` to a module-level `validateParams(method, id, params)` shared by both.
- **Direction:** relocate (consolidate)
- **Preservation:** test-suite — exact same method names/handlers registered; ordering of `register` calls is irrelevant (Map keyed by method).
- **Falsifiable signal:** observer-socket integration test + `broker.hello`/read-method round-trips stay green; same JSON-RPC surface advertised.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** small
- **Tests:** observer-socket test; broker method registration tests.
- **Contraindication:** observer mode deliberately omits mutating methods — keep that asymmetry; only the SHARED read set should be deduped, never auto-include mutators in the observer.

### 6. Redundant capture-gate re-check in TmuxPaneController — [T22] Guard clause / [T16] remove unreachable guard
- **Location:** `runtime/tmux.ts` `captureForSubmit` (243-253) — re-checks `this.lease.allowedOps.capture !== true` even though its only caller `waitForPane` (259-278) already returns `'no-capture'` when capture is denied, and `sendPastedLine` gates the capture path on `allowedOps.capture === true` (178).
- **Mechanism repaired:** a guard whose condition is already established by every caller — defensive but unreachable-in-practice branching that obscures the single source of the capture gate.
- **Symptom that flagged it:** the same `allowedOps.capture !== true` predicate appears at the call site and inside the callee.
- **Current → Suggested:** Keep the gate at `waitForPane`/`sendPastedLine` (the decision points) and drop the inner re-check, OR consciously keep it as defense-in-depth if `captureForSubmit` is intended to be call-site-independent. This is borderline — flagging for a human read, not auto-apply.
- **Direction:** isolate (consolidate the gate to one site)
- **Preservation:** observational-equivalence — removing a branch that callers already prevent from being reached changes nothing observable; but proving reachability needs care.
- **Falsifiable signal:** tmux paste/submit tests (capture-denied and capture-granted leases) stay green.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** trivial
- **Tests:** TmuxPaneController paste/submit unit tests with both lease shapes.
- **Contraindication:** load-bearing defense-in-depth — `captureForSubmit` could conceivably be called from a future site without the gate; the redundancy is cheap. Prefer leaving as-is unless consolidating the capture-capability check overall. (Listed for completeness; low value.)

### 7. `extractHookRecord` (codex driver) overlaps `unwrapHookPayload` (hook-json) — [T15] name the unwrap once
- **Location:** `drivers/codex-cli-tmux/driver.ts` `extractHookRecord` (397-401) vs `drivers/hook-json.ts` `unwrapHookPayload` (36-44)
- **Mechanism repaired:** two slightly-different "unwrap the inner hook payload" helpers. `extractHookRecord` additionally falls back through `hookData ?? hookEvent ?? payload ?? envelope` and unwraps a nested `hookEvent` by presence of `hook_event_name` — a SUPERSET of `unwrapHookPayload`'s nested-`hookEvent` logic. The codex hook-events normalizer ALSO re-derives the same fallback chain (`hook-events.ts:52`).
- **Symptom that flagged it:** the `envelope.hookData ?? envelope.hookEvent ?? envelope.payload ?? envelope` chain appears in both `extractHookRecord` and `normalizeCodexHookEnvelope`.
- **Current → Suggested:** Lift one `extractCodexHookRecord(envelope)` into `hook-json.ts` (or codex-cli-tmux module scope) and call it from both the driver and the normalizer. Note `hook-json.ts:5-9` already documents that the codex variant intentionally differs from the shared `asRecord` — respect that, share only the envelope-unwrap.
- **Direction:** relocate (consolidate)
- **Preservation:** test-suite — the chosen helper must be the SUPERSET behavior both already produce; verify the codex normalizer's `getString(hook,'turn_id')` merge still sees the same record.
- **Falsifiable signal:** codex hook normalization unit tests stay green for flat, `hookData`-wrapped, and `hookEvent`-nested envelopes.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** small
- **Tests:** codex hook-events + driver hook-handling tests.
- **Contraindication:** `unwrapHookPayload` and the codex variant are NOT equivalent (codex follows a fallback chain through `payload`/`envelope`); do not merge them into one — extract a distinct codex-specific helper used twice within the codex driver only.

## 🪶 Deliberately left alone (where-NOT)
- **`invocation-manager.ts` `applyEventState` switch (496-647) and `normalizeHook` if-chains (claude/codex hook-events):** these LOOK like T19 dispatch candidates, but each is a single stateful event-vocabulary projection with cross-arm shared state (held messages, completedTurns, activeTurnId, the documented `turn.completed`→`turn.failed` fallthrough). Converting to a dispatch table would scatter that shared state and add indirection without removing a per-feature arm-growth axis. Load-bearing as-is.
- **The two `SCRUB_PREFIXES`/leave-reason constant sets (`tmux-env.ts`, `tmux-shared.ts USER_INITIATED_END_REASONS`, `invocation-manager SESSION_LEAVE_REASONS`):** explicitly documented as DELIBERATELY different sets (`SESSION_LEAVE_REASONS` omits `clear`; the comment in `tmux-shared.ts:32-36` says it is "intentionally NOT this constant"). Coincidental similarity that must diverge — do not dedup (contra-T15).
- **`liveSocket` in `cli.ts runUnix` (338):** has a long comment justifying why it is NOT vestigial despite never being value-dereferenced (cleanup identity key, distinct lifetime from `activeController`). Correct as-is; do not "simplify away."
- **`asRecord` duplicated in `hook-json.ts` vs `codex-app-server/event-map.ts`:** documented divergence — the event-map variant treats arrays as records (no `Array.isArray` guard). Defense against a real shape difference; not a dedup target.
- **Per-driver `SurfaceState` interfaces (claude/codex tmux):** identical today but each driver's surface lifecycle differs; coincidental, low cost, leave separate unless extracting `PaneLeaseSurface` (already shared in `tmux-shared.ts`) is consciously widened.
- **`createEventLedger` not in index.ts:** noted at the boundary; NOT flagged because no external consumer needs it today. If a future durable host outside this package needs it, route via M02 Expand (add export), not a silent widening.
- **Two `sleep` helpers (`tmux.ts` local + `tmux-shared.ts` export):** trivially identical 1-liners; consolidating them is cosmetic and would add an import edge from `tmux.ts` (runtime core) to a drivers-adjacent module. Not worth the coupling.

## 🔭 If applying: outside-in sequence
1. Remove the stale fixture (#1) and dead tmux parsers/types (#2) — pure deletions, `tsc`-proven, zero behavior surface. Run typecheck + suite after each.
2. Consolidate cli.ts read-method registration (#5) — local, low-risk, kills a drift hazard on the JSON-RPC surface.
3. Extract shared hook-bridge transport (#3) and codex envelope-unwrap (#7) — verify byte-identical envelopes + hook tests.
4. Extract the JSONL tailer (#4) last — largest blast radius (event ordering); gate on the transcript-ordering e2e rows.
5. Decide #6 with a human (defense-in-depth vs single-gate) — do not auto-apply.

## ✅ Safety checklist
- [ ] `bun run typecheck` green after each removal (#1, #2).
- [ ] Full `bun test` for the package green after each step.
- [ ] Both tmux pre-hrc matrix rows (claude + codex) green after #3/#4/#7 — these are the only checks that exercise live envelope bytes + hook ordering.
- [ ] `rg` proof of zero consumers re-run before deleting #2's re-export specifically (out-of-repo deep-import on `runtime/tmux`).
- [ ] No spread/projection change to event payloads in #3/#4/#7 — preserve the EXACT field set; the envelope builders' `...(x !== undefined ? {x} : {})` shape must be byte-identical.
- [ ] No new biome lint findings introduced by any consolidation (none expected; no literal-parameterizing typeof dedup here).
