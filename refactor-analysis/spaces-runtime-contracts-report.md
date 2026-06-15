# 🔧 Refactoring Analysis — spaces-runtime-contracts

**Target:** spaces-runtime-contracts (`packages/spaces-runtime-contracts/src`)  ·  **Files read:** 26  ·  **Lines:** 3061
**Generated:** 2026-06-14  ·  **Package type:** data (contracts/type-declaration package with 4 small logic islands)

## 🧭 Summary
This is a contracts package: ~90% pure `type`/`enum` declarations re-exported flat through `index.ts`, consumed by 30+ files across aspc/agent-spaces. The public surface is the product, so Hyrum's Law is maximal — almost every structural change to a type is observable. The genuine *logic* lives in four islands: `hash.ts` (canonical-json + `project`), `validate-execution-profile.ts` (legality gates, already well-factored into rule registries), `public-api.ts` (`transportAliasFor`), and the data tables (`route-catalog.ts`, `boundary-checks.ts`, `compile-fixtures.ts`). The code is in unusually good shape; most findings are low-risk internal tightenings, plus a handful of public-surface items that must route through Expand/Contract.

## 🚪 Public boundary (assess first)
- **API surface:** `index.ts` re-exports everything (`export *` from all 24 modules). Public values: `transportAliasFor`, `legacyTransportAlias`, `createCanonicalHasher`, `project`, `DEFAULT_HASH_PROJECTION`, `BrokerErrorCode` (enum), `REQUIRED_BOUNDARY_CHECKS`, `RUNTIME_ROUTE_CATALOG`, `DEFAULT_CODEX_BROKER_INPUT_POLICY`, `validate*ExecutionProfile`, and three test fixtures. Everything else is types.
- **Findings:**
  - **`export *` barrel (`index.ts`)** flattens 24 modules into one namespace. This is the entire API contract; any rename/removal anywhere is a public break. Acceptable for a contracts package, but it means *no* type here can be treated as internal-only — flag all type changes as public-surface.
  - **Test fixtures are exported through the public barrel** (`compileOnlyRuntimeRouteDecision`, `compileOnlyBrokerRuntimeState`, `durableUnixBrokerRuntimeState` from `compile-fixtures.ts`). No out-of-package consumer imports them by name today (only the in-package `runtime-state.red.test.ts`), yet they ship in the published surface. This is leaky — test data in the production API (see Finding 4).
  - **Open-ended `| string` unions** on `RuntimeStatus`, `RunStatus`, `RuntimeControlErrorCode`, `HarnessRuntime | string`, `brokerDriver: '…' | string` widen otherwise-closed enums to `string`, defeating exhaustiveness for consumers (see Finding 2). Deliberate escape hatch in places, but worth a documented decision.
- **Verdict:** 🟡 needs care — structurally sound and intentional, but the barrel + exported fixtures + `| string` widenings mean the boundary is broader and leakier than necessary, and every edit is observable.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. `project()` spread forwards extra props beyond the discriminated union — [T12] Make illegal states unrepresentable
- **Location:** `hash.ts:169-182` (the `base` + `switch` `{ ...base, planHash }` construction)
- **Mechanism repaired:** The `RuntimeContractProjection` union declares exactly one hash field per arm (`planHash` | `profileHash` | `specHash` | `startRequestHash`). The implementation builds `base = { hashProjection, value }` then spreads `{ ...base, planHash: hashValue }`. This is *currently* correct, but the spread is the classic projection hazard: if `base` ever gains a field, every arm silently forwards it, and the union no longer constrains the runtime shape. The type permits only one of the four hash keys; the construction does not structurally enforce that only that one is present.
- **Symptom that flagged it:** `{ ...base, planHash }` spread building a discriminated-union member (prompt's explicit spread/projection caution).
- **Current → Suggested:** Construct each arm with explicit literal object fields (`return { hashProjection: policy.hashProjection, value, planHash: hashValue }`) rather than spreading a shared `base`. Same field set today; removes the latent extra-prop forwarding.
- **Direction:** isolate
- **Preservation:** type/compiler-proof + test-suite — `satisfies RuntimeContractProjection` and the `hash.test.ts` projection assertions pin the exact field set; output bytes unchanged.
- **Falsifiable signal:** `Object.keys(project(x,'plan'))` equals `['hashProjection','value','planHash']` before and after; hash digests in `hash.test.ts` unchanged.
- **Risk:** Low  ·  **API-impact:** internal-only (return type & values identical)  ·  **Effort:** XS
- **Tests:** existing `hash.test.ts` covers digest + value; add a key-set assertion per arm.
- **Contraindication:** none — `base` has no other consumer.

### 2. Open-ended `| string` on closed status/driver/error unions — [T07] Align interface to actual usage / [M02] Expand-Contract
- **Location:** `primitives.ts:37-49` (`RuntimeStatus`), `primitives.ts:51-61` (`RunStatus`), `errors.ts:1-20` (`RuntimeControlErrorCode`), `execution-profile.ts:108` (`brokerDriver: ... | string`), `route-catalog.ts:25` (`driver: 'codex-app-server' | string`)
- **Mechanism repaired:** A union of named literals `| string` collapses to `string` for type-checking — consumers lose exhaustiveness (`switch` over `RuntimeStatus` can never be proven total) and IDE completion. The named arms become documentation, not constraints. Where the open end is a deliberate forward-compat hatch (broker drivers are pluggable) it is load-bearing; where it is not (`RuntimeStatus`, `RunStatus`, `RuntimeControlErrorCode` are all produced inside this repo), it is unnecessary widening.
- **Symptom that flagged it:** named-literal-union `| string` defeating the enum.
- **Current → Suggested:** Audit each: for repo-internal producers (`RuntimeStatus`, `RunStatus`, `RuntimeControlErrorCode`) consider dropping `| string` (closed enum) OR introduce a branded `KnownStatus | (string & {})` pattern that keeps completion. For genuinely pluggable ones (`brokerDriver`, catalog `driver`) keep `| string` but document it as the extension point. This is a public-contract change → Expand/Contract: add the narrowed alias alongside, migrate producers, then remove the wide form.
- **Direction:** remove (narrow) where internal; keep+document where pluggable
- **Preservation:** type/compiler-proof — narrowing only rejects values no in-repo producer emits; must verify no consumer relies on assigning a free string.
- **Falsifiable signal:** `bun run check` across all 30 consumers stays green after narrowing; grep for string-literal assignments to these fields not in the union.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** M (cross-repo type-check sweep)
- **Tests:** typecheck the full workspace; `v01-removal.red.test.ts` and consumer tests gate.
- **Contraindication:** `brokerDriver`/catalog `driver` `| string` is the deliberate driver-plugin seam — do NOT close it. Only narrow the status/error enums if the sweep confirms no free-string producers.

### 3. `exposurePoliciesMatch` casts around the `AgentchatExposurePolicy` union — [T07] Align interface to actual usage
- **Location:** `validate-execution-profile.ts:91-104` (`left.targetKind === (right as Exclude<…, { mode: 'none' }>).targetKind`)
- **Mechanism repaired:** The function compares `targetKind` across the `AgentchatExposurePolicy` union but must cast `right` with `Exclude<…, { mode: 'none' }>` because TS cannot narrow `right` from a guard on `left`. The cast is a symptom that the comparison is reaching across the discriminant. Narrowing both operands by their own discriminant (after the `left.mode === 'none'` early-return, narrow `right.mode !== 'none'` via a guard, or compare via a small helper that reads `targetKind` per-value) removes the cast.
- **Symptom that flagged it:** caller casting around the API (`as Exclude<...>`).
- **Current → Suggested:** Add `function exposureTargetKind(p: AgentchatExposurePolicy): string | undefined { return p.mode === 'none' ? undefined : p.targetKind }` and compare the two derived values. Removes the cast; behavior identical (both `none` already short-circuit true above).
- **Direction:** isolate
- **Preservation:** type/compiler-proof + test-suite — `validate-execution-profile.test.ts` covers exposure-mismatch diagnostics.
- **Falsifiable signal:** `broker_exposure_policy_mismatch` diagnostic fires/clears identically across the existing exposure test cases.
- **Risk:** Low  ·  **API-impact:** internal-only (private function)  ·  **Effort:** XS
- **Tests:** existing exposure-policy cases in `validate-execution-profile.test.ts`.
- **Contraindication:** none.

### 4. Test fixtures exported through the production barrel — [T03] Relocate by affinity / [T07] narrow the leaky surface
- **Location:** `compile-fixtures.ts:155-316` (re-exported by `index.ts:3` indirectly — file is `export *`'d), consumed only by `test/runtime-state.red.test.ts`
- **Mechanism repaired:** Fixtures (`compileOnlyRuntimeRouteDecision`, `compileOnlyBrokerRuntimeState`, `durableUnixBrokerRuntimeState`) are test data living in the shipped public API. Their presence means a fixture-shape change is a public-API change, and downstream packages can (Hyrum) start depending on them. Affinity says test data belongs next to tests or behind a `/testing` subpath export, not the default entry.
- **Symptom that flagged it:** production index re-exporting `*-fixtures` data only tests use.
- **Current → Suggested:** Move `compile-fixtures.ts` under a `testing/` subpath (mirroring agent-spaces' `src/testing/*`) and drop it from `index.ts`, or expose via a separate `spaces-runtime-contracts/testing` package export. Update the one in-package test import. This is a public-surface removal → Expand/Contract: add the new path, migrate the test, deprecate the barrel export, then remove.
- **Direction:** relocate
- **Preservation:** test-suite — `runtime-state.red.test.ts` import path updates; `satisfies` annotations keep shapes byte-identical.
- **Falsifiable signal:** no non-test importer breaks (grep confirms zero today); package test suite green after import-path change.
- **Risk:** Med  ·  **API-impact:** public-surface (removes 3 exported names from the barrel)  ·  **Effort:** S
- **Tests:** package suite; full-workspace typecheck to confirm no external consumer.
- **Contraindication:** if any external package is found importing these (none today), keep a re-export shim during Contract.

### 5. `serialize()` blends two distinct concerns under one recursion — [T22] guard clauses / readability (minor)
- **Location:** `hash.ts:68-104`
- **Mechanism repaired:** `serialize` handles primitive type-dispatch, array recursion, and object key-omission/timestamp-filtering in one function with a `typeof` ladder and inline pointer arithmetic. It is correct and tested, but the object-branch (lines 90-103) mixes three filters (omitPaths, ephemeral-timestamp, undefined-drop) inline. Extracting the object-field filter predicate would name the "is this field hash-material?" concept once. This is a *readability* nudge, not a structural defect.
- **Symptom that flagged it:** one function carrying primitive/array/object/filter responsibilities; nested conditional in the object branch.
- **Current → Suggested:** Extract `function includeObjectField(key, childPointer, child, policy): boolean` and let the object branch be a flat filter+map. No behavior change.
- **Direction:** isolate
- **Preservation:** observational-equivalence — pure function, `hash.test.ts` pins canonical output byte-for-byte.
- **Falsifiable signal:** every digest/canonicalize assertion in `hash.test.ts` unchanged.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** `hash.test.ts` (extensive: omitPaths, ephemeral, pathPrepend, lockedEnv, NaN).
- **Contraindication:** the function is hot and small; do not over-decompose into many tiny helpers (would obscure the single canonical-walk). One extraction max.

### 6. `RuntimeExecutionProfileKind = RuntimeControllerKind` aliases an identity — [T16] collapse premature abstraction (assess, likely keep)
- **Location:** `primitives.ts:34` (`export type RuntimeExecutionProfileKind = RuntimeControllerKind`)
- **Mechanism repaired:** A type alias identical to its source. It reads as a documented intent ("profile kind == controller kind") rather than a divergence point. If the two concepts are guaranteed to stay equal, the alias is naming-only sugar; if they may diverge, it is a deliberate seam. Worth a one-line decision comment either way so future readers don't assume they can diverge silently.
- **Symptom that flagged it:** `type A = B` with no structural difference, used in multiple profile types.
- **Current → Suggested:** Keep but add a `// invariant: profile kind mirrors controller kind` comment, OR inline if no semantic distinction is intended. Lean keep — it documents a real domain mapping.
- **Direction:** isolate (document) — likely a where-NOT
- **Preservation:** type/compiler-proof — alias inlining is structurally identical.
- **Falsifiable signal:** N/A (no behavior).
- **Risk:** Low  ·  **API-impact:** public-surface (it is exported)  ·  **Effort:** XS
- **Tests:** typecheck.
- **Contraindication:** This is plausibly a deliberate intent-naming alias (T15-style "name the concept once"). Default to leaving it; only inline if the team confirms no future divergence.

### 7. `HrcContinuationRef.provider: ProviderDomain` vs `BrokerContinuationRef.provider: string` — provider-type asymmetry — [T15] extract missing abstraction (assess)
- **Location:** `continuation.ts:6` (`provider: ProviderDomain`) vs `continuation.ts:12` (`provider: string`)
- **Mechanism repaired:** Two sibling continuation refs model `provider` with different types (closed `ProviderDomain` vs open `string`). The broker side is intentionally open (it forwards whatever the driver reports); the HRC side is closed. This is likely correct asymmetry (defense at the HRC boundary, permissive at the broker boundary), not a missed abstraction — flagging only to record the decision.
- **Symptom that flagged it:** same field name, divergent types across two adjacent types.
- **Current → Suggested:** Leave as-is; the divergence is load-bearing (HRC normalizes to known providers, broker passes through). No change.
- **Direction:** none (where-NOT, recorded)
- **Preservation:** N/A.
- **Falsifiable signal:** N/A.
- **Risk:** Low  ·  **API-impact:** public-surface  ·  **Effort:** —
- **Tests:** —
- **Contraindication:** This IS the contraindication — diverging copies are intentional. Do not unify.

## 🪶 Deliberately left alone (where-NOT)
- **`validate-execution-profile.ts` rule registries** — the broker/embedded-sdk legality gates are already refactored into ordered `BrokerLegalityRule[]` / `EmbeddedSdkLegalityRule[]` registries with `computeBrokerProfileFacts` and isolated structural-probe helpers (`readDriverTerminalHost`, `hasForbiddenProfileField`). This is exactly the [T19] conditional→dispatch and [T15] facts-extraction the mechanisms would recommend. Already done; do not touch (tests assert emission ORDER).
- **`validateExecutionProfile` `default: never` arm (`:519-523`)** — this is a *real reachable-guard* in spirit (defends against an un-wired new profile kind) AND gives compile-time exhaustiveness. Correct [T17] handling; keep.
- **`boundary-checks.ts` split string literals** — the mid-token concatenation is load-bearing (prevents the file from self-matching its own ripgrep patterns), documented in a 9-line comment. Do NOT "tidy" the literals together — that would change executed `rg` behavior. Textbook defense-in-depth contraindication.
- **`hash.ts` `omitsLockedEnv` guard** — duplicated-looking invariant ("never omit `process.lockedEnv`") enforced in `resolvePolicy`; this is a security invariant, intentionally defensive. Keep.
- **`compile-fixtures.ts` shared `BASE_*` sub-blocks** — already centralized (`BASE_INPUT_CAPABILITIES`, etc.) with comments explaining the dedup prevents drift. [T15] already applied correctly.
- **`primitives.ts` re-export of `IsoTimestamp`/`JsonValue` from broker-protocol** — thin re-export is the intended single-source-of-truth seam between contract packages; not a middle-man to collapse.
- **`public-api.ts` `transportAliasFor` / `legacyTransportAlias`** — already the canonical single-site derivation with an exhaustive `switch` (no default needed; all `RuntimeControllerKind` arms covered) and a doc comment pointing producers at it. This is the [T15] "name it once" target already achieved.

## 🔭 If applying: outside-in sequence
1. **Finding 1** (hash `project` explicit-arm construction) — Low/internal, no API change, pins the projection shape. Do first; it is isolated and test-backed.
2. **Finding 3** (`exposurePoliciesMatch` cast removal) — Low/internal, single private function.
3. **Finding 5** (extract `serialize` object-field predicate) — Low/internal, observational-equivalence under `hash.test.ts`.
4. **Finding 6** (document `RuntimeExecutionProfileKind` alias) — Low, comment-only.
5. **Finding 4** (relocate fixtures off the barrel) — Med/public-surface → Expand/Contract; needs a `/testing` subpath decision.
6. **Finding 2** (narrow `| string` status/error enums) — Med/public-surface, last, behind a full-workspace typecheck sweep; keep the driver `| string` seams open.
7. Findings 7 left alone (recorded only).

## ✅ Safety checklist
- [ ] `bun run check` (typecheck) green across the package AND all 30 external consumers after any type change.
- [ ] `hash.test.ts` digests/canonical bytes unchanged (Findings 1, 5).
- [ ] `validate-execution-profile.test.ts` diagnostic codes AND emission order unchanged (Finding 3).
- [ ] `runtime-state.red.test.ts` import path updated and green (Finding 4).
- [ ] Public-surface findings (2, 4, plus alias 6 if inlined) routed through Expand/Contract, never a hard rename in one step.
- [ ] No "tidy" of `boundary-checks.ts` concatenated literals.
- [ ] Confirm zero external importers of the three fixtures before Contract removal (grep clean today).
- [ ] If narrowing enums (Finding 2), grep for free-string producers; preserve `brokerDriver`/catalog `driver` `| string` plugin seams.
