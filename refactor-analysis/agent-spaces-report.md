# 🔧 Refactoring Analysis — agent-spaces

**Target:** packages/agent-spaces/src (npm name: `agent-spaces`)  ·  **Files read:** 17 runtime source files (index, types, client, client-support, client-materialization, placement-api, prepare-cli-runtime, run-placement-turn, broker-invocation, session-events, run-tracker, run-turn-helpers, runtime-env, compile-runtime-plan, run-compile, execute-embedded-sdk, foreground-launch) + 6 tests read for contracts; `testing/*` (9 files) are pre-HRC conformance fixtures (treated as test support, not refactored)  ·  **Lines:** ~5,100 runtime (10,931 incl tests)
**Generated:** 2026-06-14  ·  **Package type:** general (compiler + session runtime; concurrency in the in-flight turn paths)

## 🧭 Summary
The package is the asp compiler + the session/turn executor and the broker/foreground/embedded-sdk plan builders. The public boundary (`index.ts` → `types.ts` + `placement-api.ts`) is broad but mostly sound; two public helpers are dead (no internal callers, re-implement private logic) and a cluster of `@deprecated` aliases (`cpSessionId`, legacy `env`) are still settable in parallel with their replacements. The highest-leverage internal work is collapsing the **duplicated agent-local env-composition pipeline** (prepare-cli-runtime vs run-placement-turn) and the **duplicated turn-driver event/completion loop** (client.ts vs run-placement-turn.ts), both of which are hand-copied multi-statement intent.

## 🚪 Public boundary (assess first)
- **API surface:** `createAgentSpacesClient`, `AgentSpacesClient` (= `RuntimeCompiler & SpaceResolver & InvocationSpecBuilder & TurnExecutor`), all Request/Response interfaces in `types.ts`, `placement-api.ts` types + `buildCorrelationEnvVars`/`getProviderForFrontend`/`validateProviderMatch`, `createCompileRuntimeFn`, `composeForegroundEnv`/`foregroundLaunchFromResponse`/`ForegroundLaunch`. Cross-repo consumers confirmed: `hrc-runtime/.../agent-spaces-adapter/{sdk,cli}-adapter.ts` import `AgentSpacesClient`, the turn/build Request+Response types, `ProcessInvocationSpec`, and `createAgentSpacesClient` — Hyrum's Law is in force.
- **Findings:** F1 (dead public helpers `getProviderForFrontend`/`validateProviderMatch`), F2 (`@deprecated` parallel fields `cpSessionId`/legacy `env` still independently settable — illegal-state surface), F8 (`PlacementAgentSpacesClient` exported-shape never wired).
- **Verdict:** 🟡 needs care — the contract is consumed cross-repo, so every boundary change routes through Expand/Contract. Internals carry the real refactor leverage.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. Dead public provider-validation helpers re-implement private logic — [T16] Collapse premature abstraction / [M02] Expand-Contract
- **Location:** `placement-api.ts:116-152` (`FRONTEND_PROVIDER_MAP`, `getProviderForFrontend`, `validateProviderMatch`), exported at `index.ts:50-53`.
- **Mechanism repaired:** A second, parallel source of truth for "which provider does a frontend belong to" that no internal caller uses. The live path uses `client-support.ts` `FRONTEND_DEFS` + `assertProviderMatch`. `FRONTEND_PROVIDER_MAP` is a hand-maintained copy of catalog data (`getHarnessCatalogEntryByFrontend`) that will silently drift (it omits `pi-cli`, which `FRONTEND_DEFS` includes).
- **Symptom that flagged it:** Two functions that compute provider-from-frontend; grep shows zero internal callers and no cross-repo callers (only `buildCorrelationEnvVars` from this module is consumed elsewhere).
- **Current → Suggested:** Contract via Expand/Contract: either (a) re-point `getProviderForFrontend`/`validateProviderMatch` to delegate to `getHarnessCatalogEntryByFrontend`/`assertProviderMatch` (removes the drifting `FRONTEND_PROVIDER_MAP` literal, preserves the export), or (b) deprecate + remove the exports once a no-consumer scan across repos is confirmed.
- **Direction:** remove (the duplicated map) / isolate (delegate the exports).
- **Preservation:** test-suite — `pi-cli-public-types.test.ts` and consumer-contract tests pin the export shape; behavior for the 4 mapped frontends is identical when delegating to the catalog.
- **Falsifiable signal:** delete `FRONTEND_PROVIDER_MAP`, delegate, run the suite + `bun run --filter hrc-server check`; if green, the map was dead.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** S
- **Tests:** existing public-types + consumer-contract tests; add a catalog-parity assertion.
- **Contraindication:** if any out-of-tree consumer imports these, removal (option b) breaks them — prefer the delegate option, which is behavior-preserving.

### 2. Duplicated agent-local env-composition pipeline — [T15] Extract missing abstraction / [T03] Relocate by affinity
- **Location:** `prepare-cli-runtime.ts:358-420` vs `run-placement-turn.ts:158-198`.
- **Mechanism repaired:** The exact same intent ("compose locked/dispatch env from correlation + req channels + ASP_HOME, run `detectAgentLocalComponents`, fold `prepareAgentBrainRuntime`, then `prepareAgentToolRuntime` while stripping PATH out of lockedEnv") is hand-copied in two files, including the identical `const { PATH: toolPath, ...toolLockedEnv } = toolRuntime.env; void toolPath` PATH-strip idiom. This is the kind of change-touches-N-files duplication where the two copies have already started to diverge (prepare uses `pathPrepend`; run-placement discards it).
- **Symptom that flagged it:** Two near-identical ~40-line blocks; the `void toolPath` discard appears verbatim in both.
- **Current → Suggested:** Extract a `composeAgentLocalEnv(placement, { req env channels, aspHome })` helper returning `{ lockedEnv, dispatchEnv, env, pathPrepend, warnings, agentLocalComponents }`. Both callers consume it. Note the divergence: run-placement currently drops `pathPrepend` (PATH never enters an in-process SDK launch the same way) — preserve that by letting the SDK caller ignore the returned `pathPrepend`, do NOT change in-process PATH handling (that would be a redesign).
- **Direction:** relocate (into one shared helper).
- **Preservation:** type/compiler-proof for the shape; test-suite for byte-parity (`run-compile-byte-parity.test.ts`, `placement-correlation-env.test.ts`) — the composed env must stay key-for-key identical.
- **Falsifiable signal:** after extraction, byte-parity + correlation-env tests stay green and a snapshot of `lockedEnv`/`dispatchEnv` for a representative placement is unchanged.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** M
- **Tests:** byte-parity, placement-correlation-env, soul-materialization.
- **Contraindication:** the two copies differ in PATH treatment (typed pathPrepend vs in-process); the extraction must EXPOSE pathPrepend and let each caller choose — collapsing that distinction is a behavior change, not a refactor.

### 3. Duplicated turn-driver event/completion loop — [T15] Extract missing abstraction
- **Location:** `client.ts:326-547` (`runTurnInFlight`) and `client.ts:614-856` (`runTurnNonInteractive`) and `run-placement-turn.ts:302-364` — three copies of "create session → wire `onEvent` → `mapUnifiedEvents` → drain `outstandingTurns` via `shouldDrainOutstandingTurn` → resolve/reject a completion promise → finally stop session + restoreEnv".
- **Mechanism repaired:** The same in-flight driver state machine (the `InFlightRunContext` + onEvent body + completion plumbing) is assembled inline three times. `run-tracker.ts` already extracted the *data* helpers (`completeInFlightSuccess`, `enqueueInFlightPrompt`, `resolveInFlight`); the *wiring* (the `onEvent` closure that calls `mapUnifiedEvents` + drain + resolve) is still triplicated.
- **Symptom that flagged it:** Three structurally-identical `session.onEvent((event) => { const mapped = mapUnifiedEvents(...); if (shouldDrainOutstandingTurn(...)) {...} })` closures differing only in how `continuationKey` is captured.
- **Current → Suggested:** Extract `attachTurnDriver(context, { onContinuationKey, allowSessionIdUpdate })` into `run-tracker.ts` (or a new `turn-driver.ts`) that installs the onEvent closure and returns the turn-completion promise. The three call sites pass their session + context.
- **Direction:** relocate / isolate (one driver attach point).
- **Preservation:** test-suite — `client-concurrency.test.ts`, `client-process-invocation.characterization.test.ts`, `headless-empty-response.test.ts` pin the observable event order and completion semantics.
- **Falsifiable signal:** event sequences and completion/timeout behavior in the concurrency + characterization tests are byte-identical before/after.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** M-L
- **Tests:** client-concurrency, characterization, headless-empty-response.
- **Contraindication:** the non-inflight `runTurnNonInteractive` path uses a simpler `turnEnded` boolean rather than `outstandingTurns`; do not force it into the in-flight shape if that changes when `turn_end` resolves — verify the empty-response gate (run-placement-turn:374-398) is preserved exactly.

### 4. `arrow-shaped` turn methods exceed nesting/length budget — [T22] Guard clauses / flatten nesting
- **Location:** `client.ts:326-547` and `client.ts:614-856` (each ~220 lines, nesting reaches 6: method → withAspHome → try → new Promise → onEvent → if).
- **Mechanism repaired:** Deep nesting from `withAspHome(async () => { ... try { new Promise((resolve)=>{ session.onEvent(()=>{ if ... }) }) } })`. Hard to reason about which `finally` runs when.
- **Symptom that flagged it:** Nesting ≥4 and arrow-shaped error funnels; the same `catch`→`emitTurnFailure` pattern at multiple depths.
- **Current → Suggested:** Largely subsumed by Finding 3 (extracting the driver removes the deepest arms). Independently: hoist the early validation block (`validateSpec` + `isAbsolute(cwd)` + `assertProviderMatch` + `resolveModel`) into a `validateTurnRequest` guard that returns either the resolved tuple or an `emitTurnFailure` early-return.
- **Direction:** isolate (guard extraction).
- **Preservation:** test-suite — characterization test pins the failure events emitted for each invalid input.
- **Falsifiable signal:** invalid-cwd / provider-mismatch / unsupported-model inputs still emit the same `state:error`+`complete` pair with the same codes.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** M (do AFTER Finding 3)
- **Tests:** characterization, m5-public-api-cutover.
- **Contraindication:** none, but sequence after Finding 3 to avoid touching the same lines twice.

### 5. Per-plan-builder boilerplate tail re-copies the diagnostics/compileId/resolvedBundle quartet — [T15] Extract missing abstraction
- **Location:** `compile-runtime-plan.ts` — the closing ~35 lines of `compileBrokerPlan` (868-921), `compileForegroundPlan` (1042-1096), `compileEmbeddedSdkPlan` (1350-1397), `compileTmuxBrokerPlan` (1663-1719) each re-do: map `prepared.warnings`→diagnostics, append `disallowedToolsUnsupportedDiagnostic`, `stableId('compile', {requestId, operationId, generation, profileHash})`, `createdAt`, `toResolvedBundle`, `toCompiledPlacement`, then `assemblePlan({...})`.
- **Mechanism repaired:** `assemblePlan` already centralizes the *envelope*; the *pre-assembly preamble* (diagnostics + compileId + bundle/placement coercion) is still copied four times. Adding a fifth route means copying the preamble again.
- **Symptom that flagged it:** Four identical `const compileId = stableId('compile', { requestId..., profileHash }) as CompileId; const createdAt = ...; const resolvedBundle = toResolvedBundle(...); const compiledPlacement = toCompiledPlacement(placement);` runs.
- **Current → Suggested:** Extract `finalizePlan({ req, profileHash, profileId, preparedWarnings, disallowedToolsContext, resolvedBundleSource, bundleIdentity, placement, ...assembleRest })` that folds the preamble + `assemblePlan` into one call. Key-order of `assemblePlan` is hash-authoritative — keep it; only the preamble moves.
- **Direction:** relocate (into the shared finalizer).
- **Preservation:** test-suite — `run-compile-byte-parity.test.ts`, `compile-runtime-plan.test.ts`, `compiler-broker-profile.test.ts` pin planHash/profileHash/compileId byte-for-byte.
- **Falsifiable signal:** all hashes (planHash/profileHash/specHash/compileId) unchanged across the four routes.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** M
- **Tests:** byte-parity, compile-runtime-plan, compiler-broker-profile, compiler-broker-initial-input.
- **Contraindication:** `disallowedToolsUnsupportedDiagnostic` is appended on three routes but GATED (`if (!honorDisallowedTools)`) only on the tmux route — the finalizer must take the diagnostic as a precomputed value, not re-derive the gate, or it changes codex-tmux diagnostics.

### 6. `parseModelId` / namespaced-model split is reimplemented in the embedded-sdk executor — [T15] Extract missing abstraction
- **Location:** `client-support.ts:133-147` (`parseModelId`, splits on `/`) vs `execute-embedded-sdk.ts:401-405` (manual `indexOf('/')` → `registryProvider`/`registryModel`) vs `compile-runtime-plan.ts` comment at 1282-1290 describing the same namespacing.
- **Mechanism repaired:** "Split a possibly-namespaced model id into (provider, model)" is a named concept implemented twice with subtly different fallbacks (`parseModelId` defaults provider to `'codex'`; the executor defaults to `profile.session.provider`).
- **Symptom that flagged it:** Two `modelId.indexOf('/')` parsers with divergent fallback providers.
- **Current → Suggested:** Export a single `splitNamespacedModel(modelId, fallbackProvider)` from `client-support.ts` and call it from both. Preserve each caller's fallback by passing it as the argument.
- **Direction:** relocate (one parser, parameterized fallback).
- **Preservation:** test-suite — `execute-embedded-sdk.test.ts` pins the registry (provider, model) recovery for `openai-codex/gpt-5.5` and bare ids.
- **Falsifiable signal:** embedded-sdk tests + model-resolution tests unchanged.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Contraindication:** the two fallbacks genuinely differ — parameterize, do NOT unify the default to one literal (that would change behavior on bare ids).

### 7. `@deprecated` parallel fields (`cpSessionId`, legacy `env`) keep illegal states representable — [T12] Make illegal states unrepresentable / [M02] Expand-Contract
- **Location:** `types.ts` (`cpSessionId` on `RunTurnNonInteractiveRequest:123`, `QueueInFlightInputRequest:161`, `InterruptInFlightTurnRequest:178`, `BuildProcessInvocationSpecRequest:191`, `DescribeRequest:282`, `BaseEvent:343`; legacy `env` at 135/205/240); resolution logic in `runtime-env.ts:48-62` and the `{...req.env, ...req.lockedEnv}` merges.
- **Mechanism repaired:** Both `hostSessionId` and `cpSessionId` are independently settable with no type-level guarantee they agree; same for `env` vs `lockedEnv`. The "they might disagree" invariant is resolved at call sites (`?? cpSessionId`, `{...env, ...lockedEnv}`) rather than encoded.
- **Symptom that flagged it:** Six `@deprecated cpSessionId` clones + three `@deprecated env` clones, each needing a runtime coalesce.
- **Current → Suggested:** Expand/Contract: announce removal, then drop the deprecated members and the coalescing arms. This is a public-contract change — cross-repo consumers (hrc adapters) may still set them. Stage: add-new (done) → migrate consumers → remove-old.
- **Direction:** remove (the legacy aliases) — staged.
- **Preservation:** char-test then type/compiler-proof — `v01-removal.red.test.ts` already characterizes removal expectations; consumer-contract test in hrc-runtime gates it.
- **Falsifiable signal:** after removal, `bun run --filter hrc-server` and the consumer-contract test compile without referencing the removed fields.
- **Risk:** High  ·  **API-impact:** public-surface  ·  **Effort:** M (coordination across repos)
- **Contraindication:** cannot be auto-applied; a consumer scan across hrc-runtime + agent-control-plane must confirm zero `cpSessionId`/legacy-`env` usage first.

### 8. `PlacementAgentSpacesClient` interface is a never-wired option — [T16] Collapse premature abstraction
- **Location:** `placement-api.ts:158-163`.
- **Mechanism repaired:** An interface declaring a placement-flavored client surface that nothing implements or returns (the real client is `AgentSpacesClient`, which already accepts placement via the union request types). It is NOT re-exported from `index.ts` either — pure dead structure.
- **Symptom that flagged it:** grep shows the symbol only in its own declaration + dist; no `implements`, no return type, no import.
- **Current → Suggested:** Remove the interface. It is not part of the published surface (`index.ts` exports the other placement types but not this one).
- **Direction:** remove.
- **Preservation:** type/compiler-proof — removing an unexported, unimplemented interface cannot change behavior; `tsc` proves no referent.
- **Falsifiable signal:** package + consumer builds stay green after deletion.
- **Risk:** Low  ·  **API-impact:** internal-only (not in `index.ts`)  ·  **Effort:** S
- **Contraindication:** if it is documentation-by-type for a planned wiring, leave a one-line comment instead — but an empty unimplemented interface is not a deliberate seam.

### 9. `deriveHandleParts` shorthand-fallback branch is a deep nested arrow — [T22] Guard clauses
- **Location:** `broker-invocation.ts:51-104`.
- **Mechanism repaired:** The `catch` block hand-parses `@`/`:` with nested `if (atIndex===-1) {...} else { if (colonIndex===-1) {...} else {...} }` (nesting 4 inside a catch inside a function). The intent ("parse `agent@project:task` shorthand") is a recurring concept.
- **Symptom that flagged it:** Nested index-of parsing reproducing what `parseScopeRef` does, as a fallback.
- **Current → Suggested:** Extract `parseShorthandHandle(scopeRef): HandleParts` with guard clauses (return early on each separator-absent case). Keep the diagnostic stderr line in `deriveHandleParts`.
- **Direction:** isolate (extract + flatten).
- **Preservation:** test-suite — `placement-correlation-env.test.ts` and broker correlation tests pin agentId/projectId/taskId derivation.
- **Falsifiable signal:** correlation labels for canonical + shorthand handles unchanged.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Contraindication:** the diagnostic side-effect (stderr write) must stay in the caller, not the pure parser.

### 10. `as unknown as` placement/bundle casts are localized but still escape the type system — [T07] Align interface to actual usage
- **Location:** `compile-runtime-plan.ts:114` (`toResolvedBundle` `as unknown as`), `:716` (`req.placement as CompilePlacement`), `run-compile.ts:101` (`placement as RuntimeCompileRequest['placement']`), and the `as unknown as Parameters<typeof buildCorrelationEnvVars>[0]` casts in testing harnesses.
- **Mechanism repaired:** `RuntimeCompileRequest['placement']` and the spaces-config `RuntimePlacement` are structurally close but not assignable, forcing double-casts. The `CompilePlacement` intersection already partially addresses this (good); the residual `as unknown as` on `resolvedBundle` indicates the plan-shape `resolvedBundle` type is wider/narrower than what prepare returns.
- **Symptom that flagged it:** `as unknown as` double-casts in the compile path.
- **Current → Suggested:** This is a cross-package contract gap (spaces-runtime-contracts vs spaces-config). In-package, narrow `toResolvedBundle`'s return by defining a shared `ResolvedBundleLike` and a real mapping function rather than a blind cast — only if the field sets actually align. Otherwise flag as a contracts-package redesign, not a local refactor.
- **Direction:** isolate (or defer to contracts redesign).
- **Preservation:** type/compiler-proof.
- **Falsifiable signal:** the `as unknown as` is removable without a tsc error once the contract types align.
- **Risk:** Med  ·  **API-impact:** internal-only (in-package), but root cause is cross-package  ·  **Effort:** M
- **Contraindication:** if the field sets genuinely differ, a cast is honest; do not fabricate a mapping that drops/adds fields (spread-projection behavior change).

## 🪶 Deliberately left alone (where-NOT)
- **`assemblePlan` envelope key order** (`compile-runtime-plan.ts:168-189`) — load-bearing: the literal key order is the projection-hash input. Do not "tidy" it.
- **Per-field broker timeout constants** (`broker-invocation.ts:38-49`) — already named with intent and documented; magic-number extraction is done. Leave.
- **The two `void toolPath` PATH discards** beyond the dedup in Finding 2 — the discard itself is the documented invariant ("PATH never enters lockedEnv"); the comment is defense-in-depth. Keep the comment when extracting.
- **`buildContinuationRef` ternary helper** (`client.ts:107-112`) — already the centralization of the `key ? {provider,key} : undefined` pattern; it is the fix, not a smell. (Note: run-placement-turn.ts:404 and run-tracker.ts:62 still inline the ternary — a minor follow-on to Finding 6's spirit, but low value; left alone.)
- **`emitTurnFailure` / `toAgentSpacesError`** (`run-turn-helpers.ts`) — already the extracted error-handling seam; correctly used everywhere. No change.
- **`testing/*` pre-HRC harness** — conformance fixtures; out of scope for behavior-preserving runtime refactor.
- **Empty-response gate** (`run-placement-turn.ts:374-398`) — a real, reachable guard (T-01522); NOT a partial→total candidate. Keep.

## 🔭 If applying: outside-in sequence
1. **F8** (remove unused `PlacementAgentSpacesClient`) — zero-risk warm-up, proves the build gate.
2. **F6** (`splitNamespacedModel`) and **F9** (`parseShorthandHandle`) — small, isolated, test-pinned.
3. **F2** (`composeAgentLocalEnv`) — guard byte-parity + correlation-env tests; preserve pathPrepend distinction.
4. **F3** (`attachTurnDriver`) then **F4** (turn-request guard) — biggest internal win; sequence F3 before F4.
5. **F5** (`finalizePlan` preamble) — guard all four route hashes.
6. **F1** (delegate `getProviderForFrontend`/`validateProviderMatch` to catalog) — public-surface; Expand/Contract, keep exports.
7. **F10 / F7** — defer: F10 is a cross-package contracts question; F7 is a staged multi-repo deprecation removal.

## ✅ Safety checklist
- [ ] `bun run --filter agent-spaces test` green (esp. `run-compile-byte-parity`, `compile-runtime-plan`, `client-concurrency`, `client-process-invocation.characterization`, `execute-embedded-sdk`, `placement-correlation-env`).
- [ ] planHash/profileHash/specHash/compileId unchanged for all four compile routes (byte-parity).
- [ ] `lockedEnv`/`dispatchEnv`/`pathPrepend` key-for-key identical after F2 (no spread-projection field drift).
- [ ] Cross-repo: `bun run --filter hrc-server check` + agent-spaces consumer-contract test green (F1/F7 gate).
- [ ] No `{...obj}` projection introduced that forwards extra props on a typed boundary object.
- [ ] If parameterizing the model-split literal (F6), confirm no biome `useValidTypeof`-class lint; scoped `// biome-ignore` only if forced.
- [ ] Deprecation removals (F7) only after a verified zero-consumer scan across hrc-runtime + agent-control-plane.
