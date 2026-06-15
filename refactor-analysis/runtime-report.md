# 🔧 Refactoring Analysis — spaces-runtime

**Target:** packages/runtime/src  ·  **Files read:** 22 (16 source + 6 test, edits scoped to source)  ·  **Lines:** ~2967 (source ~1900)
**Generated:** 2026-06-14  ·  **Package type:** data (template/prompt assembly + small registries + memory store)

## 🧭 Summary
The package is in good structural shape — recent passes already extracted shared `isRecord`/file-reader helpers, killed the TOML round-trip in `buildDefaultTemplate`, and documented several deliberate swallow-and-continue paths. The remaining leverage is at the public boundary: two thin convenience wrappers (`resolveContextTemplate`, `discoverSystemPromptTemplate`) have zero external consumers, and `CreateSessionOptions.model` re-declares a model-alias union that already lives in `spaces-config`. Inward, the two near-identical registries (Harness/Session) and the `withTargetLock`/lock-acquisition machinery are the only notable internal items.

## 🚪 Public boundary (assess first)
- **API surface (`index.ts`):** re-exports all of `harness/`, `session/`, `agent-memory/`; plus `parseContextTemplate`, `expandTemplate`, `resolveContextTemplate`, `resolveContextTemplateDetailed`, the four `system-prompt` discovery/inspection/materialize fns, `MaterializeResult`, and a large block of context/inspection types. `file-reader`, `type-guards`, `service-probe`, `service-probe-resolver`, `template-vars`, `materialize-io` internals are correctly NOT re-exported (verified: only `dist/*.d.ts` self-references, no real consumers).
- **Findings:**
  - `resolveContextTemplate` (the non-`Detailed` wrapper) has NO external caller (grep across packages = empty); it is a pure projection of `resolveContextTemplateDetailed`. Candidate for Contract (M02), but public — deferred.
  - `discoverSystemPromptTemplate` is a `const = discoverContextTemplate` alias with NO external caller; dead public alias — deferred (M02 remove-old).
  - `CreateSessionOptions.model` hardcodes `'fable' | 'haiku' | 'sonnet' | 'opus' | 'opus-4-6'` — a duplicate of `AgentSdkModelAlias` exported by `spaces-config`. Leaky/will-drift boundary (T07). Public — deferred.
- **Verdict:** 🟡 needs care — surface is mostly sound and well-typed, but carries two consumer-less convenience exports and one drifting inlined union; all three are public so they route through Expand/Contract.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. `CreateSessionOptions.model` re-declares spaces-config's model alias union — [T07] Align interface to actual usage / [T15] Extract missing abstraction
- **Location:** `session/options.ts:12`
- **Mechanism repaired:** a single source-of-truth concept (the set of valid Agent-SDK model aliases) is spelled out twice — once as `AgentSdkModelAlias` in `spaces-config/core/models.ts:85` and again inline here. The two will silently diverge (the `opus-4-6` pin already echoes the no-version-pinning concern in project memory).
- **Symptom that flagged it:** identical 5-member string union appears in two packages; runtime imports other types from `spaces-config` already.
- **Current → Suggested:** `model?: 'fable' | ... | 'opus-4-6'` → `model?: AgentSdkModelAlias` imported from `spaces-config`.
- **Direction:** relocate (consume the canonical type).
- **Preservation:** type/compiler-proof — if the unions are identical today the change is a no-op for callers; tsc proves equivalence. (If they differ, that difference is a latent bug, not preserved behavior — flag as redesign.)
- **Falsifiable signal:** `tsc` stays green and every existing `createSession({ model: ... })` call still type-checks.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** S
- **Tests:** existing session type tests + downstream `agent-spaces` createSession call sites.
- **Contraindication:** if the inline union is intentionally a SUBSET of the config alias (runtime deliberately refuses some models), keep it but derive via `Extract<AgentSdkModelAlias, ...>` rather than re-typing — confirm with config owner before applying.

### 2. Consumer-less `resolveContextTemplate` convenience wrapper — [T23] Remove middle man / [M02] Expand/Contract
- **Location:** `context-resolver.ts:119-129`
- **Mechanism repaired:** a public pass-through that projects `resolveContextTemplateDetailed` down to `{prompt, reminder}` with no caller anywhere in the monorepo. It widens the surface (two functions to keep in lockstep) for no realized benefit.
- **Symptom that flagged it:** grep for `resolveContextTemplate(` outside runtime/dist = empty; the only call is the wrapper-to-detailed delegation.
- **Current → Suggested:** mark deprecated, then remove after a deprecation window (Contract); callers (none today) migrate to `resolveContextTemplateDetailed` and read `.prompt/.reminder`.
- **Direction:** remove.
- **Preservation:** observational-equivalence for the remaining (detailed) path; behavior of any external caller cannot change because none exist — but it is exported, so Hyrum's Law applies.
- **Falsifiable signal:** build + downstream type-check stays green after removal; package `index.ts` export list shrinks by one with no broken import.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** S
- **Tests:** `context-resolver.test.ts` exercises it directly — those assertions move onto `resolveContextTemplateDetailed`.
- **Contraindication:** the `{prompt, reminder}`-only shape is a deliberately narrow public contract; if downstream HRC/ACP repos (outside this monorepo) import it, Contract must run the full add-new→support-both→migrate window, not a delete.

### 3. Dead public alias `discoverSystemPromptTemplate` — [T16] Collapse premature abstraction / [M02]
- **Location:** `system-prompt.ts:132`
- **Mechanism repaired:** `export const discoverSystemPromptTemplate = discoverContextTemplate` is a rename-era compatibility shim with no remaining caller — variation (two names for one fn) that never materialized.
- **Symptom that flagged it:** grep = no external use; identical function object.
- **Current → Suggested:** remove the alias export after a deprecation note.
- **Direction:** remove.
- **Preservation:** observational-equivalence — same function reachable under the canonical name.
- **Falsifiable signal:** removing the line + its `index.ts` re-export leaves build green.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** XS
- **Tests:** none target the alias by name.
- **Contraindication:** out-of-monorepo consumers may import the legacy name — verify before deleting; Expand/Contract if uncertain.

### 4. Harness/Session registries are the same registry instantiated twice — [T15] Extract missing abstraction
- **Location:** `harness/registry.ts:15` and `session/registry.ts:6`
- **Mechanism repaired:** both are a "keyed registry with register (throw-on-dupe) / get / getOrThrow / clear / keys" over a `Map`. The duplicated INTENT is a generic `KeyedRegistry<K, V>`; HarnessRegistry merely adds `has/getAll/getIds/detectAvailable/getAvailable`, SessionRegistry adds `createSession`. A `KeyedRegistry<K,V>` base (or a small factory) names the recurring concept once.
- **Symptom that flagged it:** near-identical Map + throw-on-dupe + getOrThrow bodies in two files.
- **Current → Suggested:** introduce internal `KeyedRegistry<K, V>` with `register/get/getOrThrow/has?/keys/clear`; have both classes extend/compose it, keeping their domain-specific extras and EXACT method names + error strings.
- **Direction:** relocate (lift shared core).
- **Preservation:** type/compiler-proof + test-suite — both `registry.test.ts` suites stay green; error messages preserved verbatim (`Harness adapter already registered:` / `Session factory already registered:`).
- **Falsifiable signal:** both registry test suites pass unchanged; thrown-message assertions unchanged.
- **Risk:** Low  ·  **API-impact:** internal-only (shared core is unexported; `HarnessRegistry`/`SessionRegistry` keep their public shapes)  ·  **Effort:** M
- **Tests:** `harness/registry.test.ts`, `session/registry.test.ts`.
- **Contraindication:** coincidental similarity — the two may diverge (harness gains async detection, session stays sync). If reviewers expect them to evolve independently, leave them; the shared surface is small (5 methods) and the abstraction is only marginally net-positive. Treat as optional.

### 5. `resolveTemplateRef` mixes ref-scheme dispatch, interpolation, and search-path probing — [T22] Guard clauses / [T03] Relocate by affinity
- **Location:** `context-resolver.ts:606-636`
- **Mechanism repaired:** one function does three jobs (scheme delegation to `resolveRootRelativeRef`, variable interpolation + absolute short-circuit, then search-path existence probing). The three concerns change for different reasons; splitting clarifies and isolates the `existsSync` probe (the only ambient-fs dependency in path resolution).
- **Symptom that flagged it:** a single function with three sequential responsibilities and an implicit fallthrough to `roots[0]`.
- **Current → Suggested:** extract `resolveScopedRef` (the `*-root:///` branch) and `resolveSearchPathRef` (interpolate + probe), keeping `resolveTemplateRef` as a 3-line dispatcher.
- **Direction:** relocate / isolate.
- **Preservation:** test-suite — pure restructuring, identical return for all branches incl. the `roots[0] ?? agentsRoot` fallback.
- **Falsifiable signal:** `context-resolver.test.ts` ref-resolution cases pass byte-for-byte.
- **Risk:** Low  ·  **API-impact:** internal-only (`resolveTemplateRef` is not exported)  ·  **Effort:** S
- **Tests:** `context-resolver.test.ts`.
- **Contraindication:** the function is short (~30 lines); if reviewers find the inline form readable, the split is cosmetic. Low priority.

### 6. `acquireAdvisoryLock` swallows fcntl-lock failure and silently falls back to in-process queue — [T18] Restructure error handling
- **Location:** `agent-memory/store.ts:238-273`
- **Mechanism repaired:** the cross-process advisory lock (python3 + fcntl) failing for ANY reason (no python3, spawn error, unexpected stdout) silently degrades to an in-process-only `acquireProcessLock`. That degradation is correctness-relevant (cross-process mutual exclusion is lost) yet absent from any signal or log — a swallowed failure that changes the safety guarantee.
- **Symptom that flagged it:** `if (!ready.done && ...includes('locked'))` success path; the `else` path just returns the weaker lock with no diagnostic, mirroring the `ASP_DEBUG`-guarded log the harness registry already uses for its swallow.
- **Current → Suggested:** keep the fallback (intentional resilience) but emit an `ASP_DEBUG`-guarded `console.debug` when degrading, matching the established pattern in `harness/registry.ts:100`. This makes the degraded mode diagnosable without changing behavior.
- **Direction:** isolate (surface the swallowed path).
- **Preservation:** observational-equivalence — adds a guarded debug log only; lock behavior unchanged.
- **Falsifiable signal:** with `ASP_DEBUG` set and python3 unavailable, a debug line appears and `store.test.ts` still passes; without `ASP_DEBUG`, output identical to today.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** XS
- **Tests:** `agent-memory/__tests__/store.test.ts`.
- **Contraindication:** if the silent fallback is a deliberate "never log in this hot path" choice, leave it; but the registry precedent suggests guarded debug is the house style. Note: this is the ONLY non-cosmetic correctness-visibility item — distinct from the documented intentional swallows in `resolveExecSection` and `probeServiceEndpoint`, which already carry justifying comments and DO NOT need touching.

## 🪶 Deliberately left alone (where-NOT)
- **`resolveExecSection` catch{} → undefined (`context-resolver.ts:419`)** and **`probeServiceEndpoint` swallow (`service-probe.ts`)** — documented, load-bearing: a failed exec/probe must contribute no content, not abort assembly. Intentional partiality; do not "fix".
- **`resolveSlotSection`'s `source === undefined` guard (`context-resolver.ts:433`)** — flagged in-code as unreachable-by-construction but retained for shape parity with the optional type. Converting to total (T17) would require tightening `SlotSectionDef.source` to required, a public type change with no behavior payoff. Leave.
- **`isRecord` / `file-reader` helpers** — already the result of a prior T15 extraction; correctly internal, not re-exported. No action.
- **`buildDefaultTemplate` object construction** — already de-round-tripped away from synth-TOML; the comment documents the prior refactor. No action.
- **`template-vars` alias map (`VARIABLE_ALIASES`)** — looks like duplication but is a deliberate canonical→alias projection (one value, many surface spellings); collapsing it would remove the back-compat spellings (behavior change). Leave.
- **Threat-pattern table in `scan.ts`** — a flat data table, not a conditional ladder; each pattern is a distinct security rule (defense-in-depth). Not a T19 dispatch candidate; parameterizing would obscure intent. Leave.
- **`MAX_CHARS_WARNING_RATIO` / cap constants** — named constants already; not magic numbers.

## 🔭 If applying: outside-in sequence
1. (Auto-applicable, internal-only) Finding 6 — add `ASP_DEBUG`-guarded debug to the lock fallback (XS, isolated).
2. (Auto-applicable, internal-only) Finding 5 — split `resolveTemplateRef` (pure restructure, covered by tests).
3. (Auto-applicable, internal-only, OPTIONAL) Finding 4 — lift `KeyedRegistry<K,V>`; only if reviewers agree the two registries should share a core.
4. (Deferred / human gate) Findings 1, 2, 3 — public-surface; run Expand/Contract: deprecate → confirm no out-of-monorepo consumers → migrate config-alias type / remove dead wrapper + alias.

## ✅ Safety checklist
- [ ] No exported symbol removed without Expand/Contract (findings 1–3 deferred for this reason).
- [ ] Object spreads preserve EXACT field sets — no findings introduce `{...obj, x}` forwarding; the existing conditional-spread builders are left intact.
- [ ] Error message strings preserved verbatim in any registry consolidation (finding 4).
- [ ] Intentional swallows (exec/probe) left untouched; only the undocumented lock-degradation path gains a guarded log.
- [ ] Run `bun test` for runtime + downstream `tsc` (agent-spaces, execution, cli) after any public-touching change.
- [ ] No new biome lint (no literal-into-typeof dedup performed here).
