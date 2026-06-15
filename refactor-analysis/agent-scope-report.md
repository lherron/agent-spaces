# 🔧 Refactoring Analysis — agent-scope

**Target:** `packages/agent-scope/src` (npm name: `agent-scope`)  ·  **Files read:** 8 source + 5 test = 13  ·  **Lines:** 737 (source)
**Generated:** 2026-06-14  ·  **Package type:** leaf (pure string-grammar library, zero workspace deps)

## 🧭 Summary

A small, well-factored grammar library: parse / validate / format / build for ScopeRef, ScopeHandle, LaneRef, SessionRef, SessionHandle plus a resolver. Behavior is heavily characterized by 5 test files. The structure is mostly sound; the residual smells are (a) one piece of genuine feature-envy/duplication in `input.ts` that re-implements lane-ref logic, (b) three near-identical "scope field bag" types that name the same concept three times, and (c) a double grammar traversal in `validateScopeRef` + `parseScopeRef`. No illegal-state or error-handling defects. The public surface is wider than its external usage but that is plausibly deliberate library API.

## 🚪 Public boundary (assess first)

- **API surface (`index.ts`):** types `ScopeKind, ParsedScopeRef, LaneRef, SessionRef, ValidationResult, ResolvedScopeInput, ResolveQualifiedScopeOptions`; consts `TOKEN_PATTERN, TOKEN_MIN_LENGTH, TOKEN_MAX_LENGTH, DEFAULT_PRIMARY_TASK_ID`; functions `validateToken`, `parseScopeRef, formatScopeRef, validateScopeRef, ancestorScopeRefs, buildScopeRef`, `normalizeLaneRef, validateLaneRef, laneIdFromRef, laneRefFromId`, `formatSessionRef, normalizeSessionRef, parseSessionRef`, `parseScopeHandle, formatScopeHandle, validateScopeHandle`, `parseSessionHandle, formatSessionHandle`, `resolveQualifiedScopeInput, resolveScopeInput`.
- **External consumers (grep across repo):** only **three** symbols are imported outside this package — `parseScopeHandle` (cli/scope-target-resolver), `parseScopeRef` (cli/agent, agent-spaces/broker-invocation), `resolveScopeInput` (cli/agent, agent-spaces/run-compile). A release-hardening test in `packages/config` asserts the module is widely imported. The remaining ~20 exports are used only internally or by this package's own tests.
- **Findings:** No T07 fat/leaky-interface defect at the function-signature level — callers do not cast around the API, and the field bags returned (`ParsedScopeRef`, `ResolvedScopeInput`) match usage. The only boundary observation is the **export-surface breadth** (M02 candidate, see Finding 5): the un-consumed exports are either deliberate library completeness (format/build/ancestor/lane/session pairs) or latent dead API. This is a judgment call, not a defect — left as a deferred/public-surface note, not auto-applied.
- **Verdict:** 🟢 sound — signatures align with usage; widen/narrow not needed. Surface breadth is a deliberate-option question for the owner, not a leak.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. `toLaneRef` re-implements lane-ref ownership (feature envy + literal dup) — [T03] Relocate by affinity / [T15] Extract missing abstraction
- **Location:** `input.ts:38-48` (`toLaneRef`), specifically the hardcoded `'lane:'` literals at `input.ts:46`.
- **Mechanism repaired:** Cohesion / single-owner for the lane grammar. `lane-ref.ts` already owns the `lane:` prefix (`LANE_PREFIX`), the default-id rule (`DEFAULT_LANE_ID`), and the "bare id → LaneRef" mapping (`laneRefFromId`). `toLaneRef` duplicates all three: it re-tests `=== DEFAULT_LANE_ID`, re-hardcodes the string `'lane:'` twice, and re-wraps a bare id — work `laneRefFromId` already does. `input.ts` already imports from `lane-ref.js`, so the dependency edge exists; the logic simply lives on the wrong side of it.
- **Symptom that flagged it:** A `'lane:'` string literal appears in `input.ts` while `LANE_PREFIX = 'lane:'` is exported from the sibling that owns it; `toLaneRef` and `laneRefFromId` encode the same id→ref rule.
- **Current → Suggested:** Replace the body of `toLaneRef` with a delegation to `lane-ref` — accept a bare-or-prefixed id, normalize via the existing `normalizeLaneRef` (which already accepts `main`/`lane:<id>`) after stripping/forwarding through `LANE_PREFIX`, or push a small `laneRefFromInput(maybePrefixed)` helper into `lane-ref.ts` and call it. Net: the `'lane:'` literal exists in exactly one file.
- **Direction:** relocate (logic to `lane-ref.ts`) + remove (duplicated literal/branch in `input.ts`).
- **Preservation:** test-suite + observational-equivalence — `input.test.ts` pins `resolveScopeInput('agent:larry','deploy')` and `('agent:larry','lane:deploy')` both → `laneId:'deploy', laneRef:'lane:deploy'`, and the `main`/undefined paths; delegation must produce byte-identical refs.
- **Falsifiable signal:** after the change, `grep "'lane:'" input.ts` returns nothing and `bun test packages/agent-scope` stays green.
- **Risk:** Low  ·  **API-impact:** internal-only (`toLaneRef` is not exported)  ·  **Effort:** S
- **Tests:** existing `input.test.ts` lane cases cover it; add one for an already-prefixed `lane:deploy` default if not present (it is, line 55).
- **Contraindication:** none — this is not defense-in-depth; it is the same rule expressed twice with the same source of truth one import away. Do not, however, change `toLaneRef`'s *acceptance* of both bare and prefixed forms (that is contract).

### 2. Three near-identical scope field-bag types name one concept three times — [T15] Extract missing abstraction
- **Location:** `scope-ref.ts:8-14` (`ScopeRefFields`), `scope-handle.ts:24-30` (`HandleParts`), `input.ts:57-64` (`ScopeInputParts`, which is `{agentId,projectId?,taskId?,roleName?}` + `laneId,laneRef`).
- **Mechanism repaired:** Name a recurring concept once. All three are the structural decomposition `{ agentId; projectId?; taskId?; roleName? }`. `buildScopeRef`, `splitHandle`, and `parseScopeInput` all traffic in exactly this shape; `ScopeInputParts` is that shape plus a lane pair. Today a new optional segment (or a field rename) must be edited in three places that are guaranteed to move together.
- **Symptom that flagged it:** Three local `type` aliases with identical core fields, declared in three files, all feeding the same `buildScopeRef`.
- **Current → Suggested:** Introduce one internal `ScopeFields` type (e.g. in `types.ts`, un-exported or exported per owner preference) and have `buildScopeRef`/`splitHandle` reference it; let `ScopeInputParts` be `ScopeFields & { laneId; laneRef }`. `ParsedScopeRef` deliberately stays separate (it adds `kind` + `scopeRef`, see where-NOT).
- **Direction:** isolate (collapse three definitions to one shared internal type).
- **Preservation:** type/compiler-proof — purely a type-alias unification; emitted JS is unchanged, structural typing already makes these interchangeable (`formatScopeRef` already passes a `ParsedScopeRef` into `buildScopeRef(ScopeRefFields)` and the compiler accepts it).
- **Falsifiable signal:** `tsc`/`bun build` clean and `bun test` green after the three aliases reference one definition.
- **Risk:** Low  ·  **API-impact:** internal-only (none of the three aliases is exported)  ·  **Effort:** S
- **Tests:** no behavior change; existing suites suffice.
- **Contraindication:** Only collapse the bags that are *intended* to be the same concept. Do NOT fold in `ParsedScopeRef` — its extra `kind`/`scopeRef` are load-bearing and exported; merging would couple the public type to the internal builder input.

### 3. `validateScopeRef` + `parseScopeRef` traverse the grammar twice (parse-then-revalidate) — [T12] Make illegal states unrepresentable / parse-don't-validate
- **Location:** `scope-ref.ts:41-97` (`validateScopeRef`) and `scope-ref.ts:103-138` (`parseScopeRef`), which calls `validateScopeRef` then re-`split(':')` and re-walks the identical segment grammar.
- **Mechanism repaired:** Eliminate the duplicated grammar walk so the structure is validated and decoded in one pass — the canonical "validate returns the parsed value" shape. Right now the segment-position knowledge (which index is project, task, role; which lengths are legal) is encoded twice; a grammar change (e.g. a new segment) must be made consistently in both walkers or `parseScopeRef` silently mis-decodes a string `validateScopeRef` accepted.
- **Symptom that flagged it:** `parseScopeRef` re-splits and re-branches on `parts.length` / `nextKey` exactly mirroring `validateScopeRef`; two functions encode one grammar.
- **Current → Suggested:** Have an internal `tryParseScopeRef(s): ParsedScopeRef | { error }` (or `ValidationResult & {parsed?}`) do the single walk; `validateScopeRef` returns `{ok}` from it, `parseScopeRef` returns the parsed value or throws. Public signatures of both exported functions are unchanged.
- **Direction:** isolate (single internal walker) + remove (the second traversal).
- **Preservation:** test-suite — `scope-ref.test.ts` pins every kind, every error branch message, and round-trips; the refactor must keep the **exact** error strings (each branch is asserted by regex). Public-surface return shapes are unchanged so this stays a refactor, not a redesign, *provided error wording is byte-preserved*.
- **Falsifiable signal:** `validateScopeRef error branches (backlog G)` suite still matches all 10 regexes; parse kind/roundtrip suites green.
- **Risk:** Med (error-message preservation is exacting; the two walkers must be reconciled without drift)  ·  **API-impact:** internal-only (both wrappers keep their signatures)  ·  **Effort:** M
- **Tests:** existing branch-message tests are the safety net; add a characterization assert that `parseScopeRef(x).scopeRef === x` for every valid form (largely present).
- **Contraindication:** The current split is defensible defense-in-depth (validate is the gate, parse re-derives). If the owner values the two functions being independently auditable, treat the duplication as load-bearing and skip. Flagged Med, not auto-applied as aggressively as 1/2.

### 4. `part(parts, i) as string` index cast — [T17] Partial → total (narrow the input) / minor
- **Location:** `scope-ref.ts:4-6` — `function part(parts, i){ return parts[i] as string }`.
- **Mechanism repaired:** The `as string` defeats `noUncheckedIndexedAccess`; every call site has *already* proven the index exists via the preceding `parts.length` guards, so the cast is sound — but it is an unchecked assertion sprinkled at ~12 call sites. The cleaner form is to destructure the validated parts once after the length check (total over the known shape) rather than re-index with a blanket cast.
- **Symptom that flagged it:** A one-line `as string` helper used pervasively to silence index-access strictness.
- **Current → Suggested:** Leave as-is OR, when doing Finding 3's single-walker, destructure positionally inside the walk so the cast disappears naturally. Not worth a standalone change.
- **Direction:** remove (fold into Finding 3).
- **Preservation:** type/compiler-proof.
- **Falsifiable signal:** `grep "as string" scope-ref.ts` empty after Finding 3.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** XS (only as a rider on Finding 3)
- **Tests:** none new.
- **Contraindication:** Do not replace the cast with runtime null-checks that change behavior on malformed-but-validated input — the guards already make it total; a cast here is honest, not a smell on its own. Only worth touching alongside Finding 3.

### 5. Export surface is ~3x wider than external usage — [M02] Expand/Contract (public-contract question)
- **Location:** `index.ts:1-21` — only `parseScopeHandle`, `parseScopeRef`, `resolveScopeInput` are imported outside the package; `formatScopeRef`, `ancestorScopeRefs`, `validateScopeRef`, `buildScopeRef`, the entire lane API (`normalizeLaneRef/validateLaneRef/laneIdFromRef/laneRefFromId`), the session-ref/session-handle API, `resolveQualifiedScopeInput`, and the token consts have no current external importer.
- **Mechanism repaired:** Align published surface to actual contract — OR consciously affirm it as library completeness. This is NOT auto-applicable: removing an export is a breaking change governed by Expand/Contract (deprecate → wait → remove), and Hyrum's Law plus the `config` release-hardening test (which asserts agent-scope is widely imported) mean unseen consumers (downstream repos hrc-runtime / agent-control-plane) may bind these.
- **Symptom that flagged it:** Large export list; grep shows most symbols unused outside the package.
- **Current → Suggested:** Owner decision. Most likely **keep** (a parse/format/validate/build grammar library is expected to ship the full symmetric set, and session/lane APIs are the documented contract from AGENT_SCOPE_SHORTHAND.md). If trimming is ever desired, route through Expand/Contract with a cross-repo grep of hrc-runtime + agent-control-plane first.
- **Direction:** (potential) remove — but deferred to human.
- **Preservation:** N/A (any removal is a redesign of the public contract, not a refactor).
- **Falsifiable signal:** cross-repo grep of all three split repos shows zero importers of a given symbol before any removal.
- **Risk:** High (cross-repo breakage)  ·  **API-impact:** public-surface  ·  **Effort:** M (audit-dominated)
- **Tests:** `packages/config/.../m7-release-hardening.test.ts` guards the "is imported" invariant.
- **Contraindication:** Strong where-NOT — a complete, symmetric grammar API is a deliberate option; do not strip format/build/ancestor/lane/session pairs just because this repo's grep is quiet. Treat as documentation/decision, likely "leave alone."

## 🪶 Deliberately left alone (where-NOT)

- **`ParsedScopeRef` vs the field bags (Finding 2 boundary):** keep separate — `kind` + `scopeRef` are load-bearing and exported; folding into the internal `ScopeFields` would leak the builder-input shape into the public type.
- **`validateScopeHandle` per-field re-validation (`scope-handle.ts:90-110`):** four sequential `validateTokenField` blocks look like dup but each carries a distinct `label` ("agentId"/"projectId"/...) that surfaces in error messages tests assert; parameterizing the label list would obscure the messages for marginal gain. Not flagged.
- **`splitHandle` exported cross-module but absent from `index.ts`:** correct — it is an internal seam shared by `scope-handle` and `input`, deliberately not part of the public contract. No change.
- **`buildScopeRef` segment-append chain (`scope-ref.ts:20-36`):** four sequential `if (x !== undefined)` appends are the canonical single source of truth (and tested as "backlog G"); not boolean soup, not a dispatch candidate — inlined sequence is the clearest form. Leave.
- **`parseSessionRef` whitespace-trim policy (`session-ref.ts:31-45`):** the asymmetric trim (ref form trims, handle forms do not) is *documented and intentional*; not a primitive-obsession finding.
- **`DEFAULT_LANE_ID = 'main'` vs `LaneRef 'main'` literal:** the two `'main'` literals (the bare-id default vs the LaneRef union member) are intentionally the same value but live in different type domains (id-space vs ref-space); already centralized via `DEFAULT_LANE_ID` where it matters. The remaining bare `'main'` returns in `lane-ref.ts`/`session-handle.ts` are LaneRef-typed and reading them as `DEFAULT_LANE_ID` would actually be a type mismatch (id vs ref). Leave.
- **Error handling:** every validate path returns a typed `ValidationResult`; every parse path throws with an actionable message including the offending input. No swallowed catch, no exceptions-for-expected-flow. No T18 finding.

## 🔭 If applying: outside-in sequence

1. **Finding 5 (public surface):** decide/skip first — it gates whether any export churn happens. Almost certainly "leave as deliberate library API."
2. **Finding 1 (relocate lane logic to `lane-ref.ts`):** smallest, internal-only, removes the cross-file `'lane:'` literal; do first among code edits.
3. **Finding 2 (collapse the three field bags):** type-only, compiler-proof; do after 1 so `ScopeInputParts` references the unified type cleanly.
4. **Finding 3 (single grammar walker) + Finding 4 (drop the `as string` cast as a rider):** last and most careful — preserve every error string exactly; lean on `scope-ref.test.ts` branch regexes.

## ✅ Safety checklist

- [ ] `bun test packages/agent-scope` green after each step (5 suites, full round-trip + every error-branch regex).
- [ ] No public function signature in `index.ts` changes for Findings 1–4 (refactor, not redesign).
- [ ] Finding 3: byte-identical error messages — diff the 10 `validateScopeRef error branches` matches before/after.
- [ ] Finding 1/2: `grep "'lane:'" src/input.ts` empty; three field-bag aliases reduced to one shared type.
- [ ] No spread/projection field-set drift introduced (e.g. the `{ ...splitHandle(input), laneId, laneRef }` at `input.ts:107` must keep forwarding exactly the handle fields — do not let a unified type widen it).
- [ ] Any export removal (Finding 5) routes through Expand/Contract with a cross-repo grep of hrc-runtime + agent-control-plane; do NOT auto-apply.
- [ ] `tsc`/build clean (consumers in cli + agent-spaces compile against the unchanged surface).
