# 🔧 Refactoring Analysis — spaces-config

**Target:** packages/config/src (npm name: spaces-config)  ·  **Files read:** 87 non-test source files (+ key tests for contracts)  ·  **Lines:** ~18,320
**Generated:** 2026-06-14  ·  **Package type:** general (config-time determinism: resolution, locks, store, materialization, lint, orchestration)

## 🧭 Summary
Large, mature package whose internals already show deliberate extraction (classifySpaceEntry, readFileIfExists, populateSnapshotsFromLock). The highest-leverage issues are at the **public boundary**: a fully-dead family of `asp_modules` path helpers, a duplicated free-function vs `PathResolver` path API, and deprecated aliases — all public surface, so they route through Expand/Contract. The most actionable internal wins are error-discrimination by `err.message.includes(...)` (T18), an ignored `LintOptions.rules` flag (T16), and a couple of duplicated key/profile-load helpers (T15/T03).

## 🚪 Public boundary (assess first)
- **API surface:** Root `index.ts` re-exports `*` from every subsystem (`core`, `store`, `materializer`, `orchestration`) AND re-exports the same subsystems as namespaces (`git`, `resolver`, `lint`) PLUS hand-picked named re-exports of functions that "don't conflict." Subpath exports (`./core`, `./git`, `./resolver`, `./store`, `./materializer`, `./lint`) mirror the barrels.
- **Findings:**
  - The `asp_modules` path-helper family (15 symbols in `core/config/asp-modules.ts`) is exported but has **zero src/test callers anywhere in the monorepo** (verified). Real path derivation goes through `adapter.getTargetOutputPath(...)`. This is dead public surface (T16, public).
  - `store/paths.ts` exposes two parallel implementations of the same path math: free `getXxx()` functions and `PathResolver` methods. Most free getters have **0 external callers**; `PathResolver` is used everywhere. `getStorePath`/`.store`/`getSnapshotPath` are explicitly `@deprecated` aliases still exported (T23/T16, public).
  - Mixed `export *` + explicit named re-export in root `index.ts` risks accidental double-export / surface drift, but is currently consistent; low priority.
- **Verdict:** 🟡 needs care — boundary is sound for live consumers but carries non-trivial dead/duplicated public surface; changes are Expand/Contract.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. Dead `asp_modules` path-helper family — [T16] Collapse premature abstraction
- **Location:** `packages/config/src/core/config/asp-modules.ts:26-163` (and re-exports in `core/config/index.ts:31-49`, `core/index.ts:53-71`)
- **Mechanism repaired:** Variation that never materialized — an entire `asp_modules/<target>/[<harness>]/{plugins,mcp.json,settings.json}` layout API with no production or test consumer. Materialization actually writes to `codex-homes/.../bundles` via the harness adapter.
- **Symptom that flagged it:** 15 exported functions/constants; `grep` across all of `packages` (excluding the file's own barrel and `/dist/`) returns no callers.
- **Current → Suggested:** Remove the module (or, if kept as documented "user-facing filesystem view" that is genuinely planned, mark clearly and stop re-exporting from `core`). Removal is the honest direction given zero adoption.
- **Direction:** remove
- **Preservation:** observational-equivalence — no caller observes these symbols, so removal cannot change behavior; type/compiler-proof via build after delete.
- **Falsifiable signal:** after deleting and rebuilding the whole monorepo, `bun run build` + `bun test` stay green and `check:manifests` reports no missing export.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** S (delete + drop 2 barrel blocks)
- **Tests:** none reference these; full-monorepo typecheck is the gate.
- **Contraindication:** if a downstream repo outside this monorepo imports `getTargetOutputPath`/`getAspModulesPath` from `spaces-config/core`, the contract is load-bearing — must Expand/Contract (deprecate → migrate → remove) rather than hard-delete.

### 2. Error discrimination via `err.message.includes('File not found')` — [T18] Restructure error handling
- **Location:** `packages/config/src/orchestration/resolve.ts:114` and `:134`; thrown at `core/config/lock-json.ts:58`, `space-toml.ts:57`, `targets-toml.ts:78` as `new ConfigParseError('File not found', filePath)`.
- **Mechanism repaired:** Expected-outcome (file absent) is signalled by a free-text message, forcing callers to string-match to recover. The "not found" case is part of the contract but absent from the type.
- **Symptom that flagged it:** two `instanceof ConfigParseError && err.message.includes('File not found')` guards in the same file.
- **Current → Suggested:** Give the parsers a machine-readable discriminator — either a dedicated `ConfigFileNotFoundError extends ConfigParseError` subclass, or a `notFound: true`/`cause.code==='ENOENT'` field on `ConfigParseError`. Callers switch from message-match to `instanceof`/field. Message text stays identical (no observable change).
- **Direction:** isolate (encode the not-found case in the type)
- **Preservation:** test-suite — keep the same thrown message string so any test asserting message still passes; add a field/subclass only consumed internally.
- **Falsifiable signal:** swap both call sites to the typed check; existing resolve.ts tests (load-default-manifest, install) stay green; a deliberately corrupted-but-present file still throws (not swallowed as not-found).
- **Risk:** Low  ·  **API-impact:** internal-only (new subclass/field is additive; the two consumers are in-package)  ·  **Effort:** S
- **Tests:** `orchestration/load-default-manifest.test.ts`, `install.test.ts` pin the not-found→defaults path.
- **Contraindication:** `ConfigParseError` is exported; a *new subclass* is additive (safe), but renaming/removing `ConfigParseError` would be public-surface. Keep it additive.

### 3. `LintOptions.rules` declared but never honored — [T16] Collapse premature abstraction
- **Location:** `packages/config/src/lint/index.ts:41-52` — `LintOptions { rules?: string[] }`, but `lint(context, _options = {})` ignores `_options` entirely and always runs `allRules`.
- **Mechanism repaired:** A configuration knob (selective rule subset) whose variation never materialized; the parameter is dead and misleads callers into thinking rule filtering is supported.
- **Symptom that flagged it:** parameter named `_options`, zero reads of `.rules`.
- **Current → Suggested:** Either (a) remove the unused `options` param + `LintOptions` type, or (b) actually implement filtering by `rule.code`. Given no caller passes options today, removal is the truthful default; implementing is a *redesign* (new behavior) and must be flagged as such if chosen.
- **Direction:** remove (or, if implementing filtering, that is a redesign — out of scope for a behavior-preserving pass)
- **Preservation:** observational-equivalence — `_options` is currently inert; dropping it changes no runtime behavior.
- **Falsifiable signal:** delete the param; all `lint.test.ts` / callers (`install.ts`, `build.ts`, `explain.ts`) compile and pass — they all call `lint(context)` with one arg.
- **Risk:** Low  ·  **API-impact:** public-surface (`lint`/`LintOptions` re-exported via `lint` namespace + `lintSpaces`)  ·  **Effort:** S
- **Tests:** `lint/lint.test.ts`.
- **Contraindication:** `LintOptions` is exported; removing a parameter narrows a public signature → route through Expand/Contract (make param truly optional+ignored is already the state; safe removal still touches the published type). Treat as deferred.

### 4. Duplicated free-function vs `PathResolver` path math — [T23] Remove middle man / [T16] collapse
- **Location:** `packages/config/src/store/paths.ts` — free getters (`getSnapshotPath:98`, `getRepoPath:55`, `getCachePath:76`, `getProjectsPath:83`, `getTempPath:90`, `getGlobalLockPath:144`, `getPluginCachePath:108`, `getSpaceSourcePath:122`, `getProjectDataPath:182`, `getProjectTargetsPath:189`) vs the identical `PathResolver` getters/methods (`:296-352`).
- **Mechanism repaired:** Two parallel encodings of the same directory layout; a layout change must be made in both, and most free getters have **0 external callers** (verified) while `PathResolver` is the live path.
- **Symptom that flagged it:** `snapshot()`/`getSnapshotPath()`, `repo`/`getRepoPath()`, `.store`/`getStorePath()` (the last two `@deprecated`) compute byte-identical joins.
- **Current → Suggested:** Have the free getters delegate to a default `PathResolver` (single source of truth), then deprecate/remove the unused ones via Expand/Contract. Keep `getProjectHarnessBundleRootPath` (3 live callers) until those migrate.
- **Direction:** relocate (collapse onto `PathResolver`) then remove dead getters
- **Preservation:** type/compiler-proof for the delegation step (same output paths); removal step gated by full build.
- **Falsifiable signal:** rewrite a free getter to call `new PathResolver().<member>`; `paths.test.ts` asserts equality of both forms and stays green.
- **Risk:** Med  ·  **API-impact:** public-surface (all getters exported via `store`)  ·  **Effort:** M
- **Tests:** `store/paths.test.ts`.
- **Contraindication:** the `@deprecated getStorePath`/`.store` aliases may be retained intentionally for one release for downstream callers; only remove after confirming no external consumer.

### 5. `ref-parser.ts` is a pass-through over core — [T23] Remove middle man
- **Location:** `packages/config/src/resolver/ref-parser.ts:24-40` — `parseSpaceRef` wraps `coreParseSpaceRef` with **zero added behavior**; the file mostly re-exports core symbols (`parseSelector`, `formatSpaceRef`, `asSpaceId`, types).
- **Mechanism repaired:** A wrapper that adds no value but doubles the name (`parseSpaceRef` here vs `parseSpaceRefCore`), forcing the root barrel to disambiguate "resolver version extends core's" when it does not.
- **Symptom that flagged it:** body is `return coreParseSpaceRef(refString)`; doc says "provide resolver-specific context" but none exists.
- **Current → Suggested:** Re-export core's `parseSpaceRef` directly (drop the wrapper); keep `buildSpaceKey`/`parseSpaceKey`/`parseAllRefs` (these DO add logic). Resolves the barrel's two-name confusion.
- **Direction:** remove (collapse the no-op wrapper)
- **Preservation:** type/compiler-proof — re-exporting the same function is behaviorally identical.
- **Falsifiable signal:** `ref-parser.test.ts` + closure/selector tests pass; `parseSpaceRefCore` and `parseSpaceRef` become the same reference.
- **Risk:** Low  ·  **API-impact:** public-surface (both names re-exported from `resolver` and root)  ·  **Effort:** S
- **Tests:** `resolver/ref-parser.test.ts`.
- **Contraindication:** if any caller depends on `parseSpaceRef !== parseSpaceRefCore` identity (unlikely), keep both as aliases. Public → Expand/Contract.

### 6. Lock-entry → `SpaceKey` derivation duplicated — [T15] Extract missing abstraction / [T03] relocate by affinity
- **Location:** `packages/config/src/orchestration/install.ts:479-488` (4-arm: agent/project/dev/registry) and `build.ts:147-149` (dev/registry arms). Marker constants + `COMMIT_KEY_PREFIX_LEN` already centralized in `resolver/space-classification.ts`.
- **Mechanism repaired:** The intent "build the `<id>@<kind-or-commit-prefix>` key for a locked entry" is re-expressed in two orchestration files; `classifySpaceEntry` already lives next door, so the matching key-builder should too.
- **Symptom that flagged it:** identical `` `${entry.id}@dev` `` / `` `${entry.id}@${entry.commit.slice(0, COMMIT_KEY_PREFIX_LEN)}` `` literals across files.
- **Current → Suggested:** Add `spaceKeyForEntry(entry, kind?)` beside `classifySpaceEntry` in `space-classification.ts`; both orchestrators call it. install.ts keeps its 4-way (it handles agent/project), build.ts uses the dev/registry result — they converge on one helper.
- **Direction:** relocate (extract into `space-classification.ts`)
- **Preservation:** test-suite — helper returns byte-identical keys; assert against current outputs.
- **Falsifiable signal:** `install.test.ts` and `build` materialization tests produce the same plugin/bundle keys.
- **Risk:** Low  ·  **API-impact:** internal-only (new helper exported from resolver; orchestration is in-package)  ·  **Effort:** S/M
- **Tests:** `orchestration/install.test.ts`, `__tests__/m4-placement-resolution.test.ts`.
- **Contraindication:** install's agent/project arms and build's are genuinely different subsets — verify the extracted helper covers all four kinds before swapping (don't force build to acquire arms it never reaches).

### 7. Two divergent `loadAgentProfile` in the resolver dir — [T03] Relocate by affinity / [T15]
- **Location:** `packages/config/src/resolver/space-composition.ts:109-115` (raw `parseToml` → `Record<string,unknown>`) vs `resolver/placement-resolver.ts:414-421` (`parseAgentProfile` → typed `AgentRuntimeProfile`).
- **Mechanism repaired:** Same concept ("load agent-profile.toml from agentRoot, undefined if absent") implemented twice with different return shapes in the same directory; `space-composition` then reaches into `profile['spaces']['base']` with stringly-typed access that the typed parser would model.
- **Symptom that flagged it:** two private functions with the same name and purpose, one bypassing the typed parser.
- **Current → Suggested:** Have `space-composition` consume `parseAgentProfile`'s typed `AgentProfileSpaces` (`base`, `byMode`) instead of re-parsing raw TOML, then drop its local loader. Centralize on the typed reader (or a shared `readAgentProfileOptional`).
- **Direction:** relocate / isolate (one typed profile reader)
- **Preservation:** test-suite — composition output (ordered, deduped refs) must be identical; pin with existing fixtures.
- **Falsifiable signal:** `__tests__/m2-local-spaces.test.ts` / `m3-reserved-files-and-profile.test.ts` produce identical `ComposedSpaceEntry[]`.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** M
- **Tests:** `resolver/closure.test.ts`, `__tests__/m2-local-spaces.test.ts`, `m3-*`.
- **Contraindication:** the raw reader tolerates *partial/odd* TOML that the typed parser may reject; confirm `parseAgentProfile` is lenient on the same fixtures before switching, else this becomes a behavior change (redesign).

### 8. `deriveSpaceKey` regex re-implements ref→key parsing — [T15] Extract missing abstraction
- **Location:** `packages/config/src/resolver/placement-resolver.ts:219-232` — three ad-hoc regexes to turn a `space:agent:/project:/...` ref string into an `id@agent`/`id@project`/`id@selector` key.
- **Mechanism repaired:** The "parse a space ref string into its components" concept already exists (`parseSpaceRef`, `isAgentSpaceRef`, `isProjectSpaceRef`, `buildSpaceKey`); placement-resolver re-derives it with bespoke regexes that can drift from the canonical parser.
- **Symptom that flagged it:** hand-rolled `/^space:agent:([^@]+)/` etc. next to a fully-typed ref parser in a sibling module.
- **Current → Suggested:** Build the audit key from `parseSpaceRef(ref)` + existing marker constants (`AGENT_COMMIT_MARKER`/`PROJECT_COMMIT_MARKER`) instead of regex.
- **Direction:** relocate (reuse canonical parser)
- **Preservation:** test-suite — keys feed only audit metadata; assert identical `resolvedKey` strings on fixtures.
- **Falsifiable signal:** `__tests__/m4-placement-resolution.test.ts` / `phase2-placement-agent-project.test.ts` keep identical `resolvedKey` values.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** M
- **Contraindication:** `deriveSpaceKey` is best-effort/audit-only and tolerant of malformed refs (falls back to returning `ref`); `parseSpaceRef` may throw — wrap in the same try/return-ref fallback to preserve tolerance, else behavior changes.

### 9. Disallowed-edge enforcement: bare `Error` + string-prefix recovery — [T18] Restructure error handling
- **Location:** `packages/config/src/resolver/closure.ts:135-157` throws `new Error('Disallowed dependency edge: ...')`; `:264` recovers with `err.message.startsWith('Disallowed dependency edge')`.
- **Mechanism repaired:** A domain rule (illegal dependency edge) is signalled by an untyped error whose identity is recovered by string prefix — fragile and absent from any signature. The package already has a typed error hierarchy (`ResolutionError` subclasses).
- **Symptom that flagged it:** `startsWith('Disallowed dependency edge')` guard mirroring the throw site.
- **Current → Suggested:** Add `DisallowedDependencyEdgeError extends ResolutionError` (carry `parentType`, `childType`, `edge`); throw and `instanceof`-check it. Message text preserved.
- **Direction:** isolate (encode the rule in the type)
- **Preservation:** test-suite — keep identical message; the rethrow logic becomes `instanceof` instead of prefix match.
- **Falsifiable signal:** closure tests for edge violations still throw with the same message; a *different* error from a dep is still wrapped as `MissingDependencyError` (the edge branch no longer accidentally catches lookalike messages).
- **Risk:** Low  ·  **API-impact:** internal-only if the new error class is not exported; public-surface if added to the exported error set (additive, safe)  ·  **Effort:** S
- **Tests:** `resolver/closure.test.ts`.
- **Contraindication:** keep the edge-rule strings (the four messages) byte-identical so any caller/test asserting message passes.

### 10. `selector.ts` switch default arm is unreachable — [T17] Partial → total (contra-check)
- **Location:** `packages/config/src/resolver/selector.ts:46-69` — `switch (selector.kind)` over a closed `Selector` union with a `default:` that throws "Unknown selector kind".
- **Mechanism repaired:** Candidate "can't happen" arm. On inspection this is a **legitimate runtime guard** against malformed/untyped input crossing the boundary (selectors come from parsed TOML), so it is the *contra* case — leave it.
- **Symptom that flagged it:** `default` with a cast `(selector as Selector).kind`.
- **Current → Suggested:** No change. Optionally add an `assertNever`-style exhaustiveness check to get a compile error if `SelectorKind` grows, but the throw is correct.
- **Direction:** (none — documented as where-NOT)
- **Preservation:** n/a
- **Falsifiable signal:** n/a
- **Risk:** —  ·  **API-impact:** internal-only  ·  **Effort:** —
- **Contraindication:** This is a real reachable guard (untyped TOML input) — do NOT collapse the default arm.

## 🪶 Deliberately left alone (where-NOT)
- `resolver/space-classification.ts` — already the deliberate T15 extraction of dev/project/agent/registry classification; cohesive, single source. Leave.
- `core/atomic.ts` cleanup `catch {}` blocks (`:80-84`, `:147-151`) — intentional best-effort temp cleanup on the error path; swallowing is correct (defense, not a bug).
- `core/errors.ts` rich error hierarchy — many one-field subclasses, but each carries distinct typed context consumed by guards/UI; not premature.
- `selector.ts` / `resolveSelector` default arm — real input guard (see Finding 10), not a dead "can't happen."
- `models.ts` `normalizeAgentSdkModel` switch — closed-domain translation with a meaningful throw on unsupported model; correct.
- Root `index.ts` mixed `export *` + named re-exports — currently consistent; not worth churning the public surface for cosmetics.
- `git/exec.ts` 60s default timeout literal — single, documented, behavioral default; not magic-number obsession.

## 🔭 If applying: outside-in sequence
1. **Finding 2** (typed not-found error, additive) — internal, lowest risk, unblocks cleaner callers in resolve.ts.
2. **Finding 9** (typed disallowed-edge error, additive) — internal, same pattern as #2.
3. **Finding 6** (extract `spaceKeyForEntry`) — internal dedup, char/test-pinned.
4. **Finding 7 & 8** (single typed profile reader; reuse canonical ref parser) — internal, but verify tolerance contracts first (Med).
5. **Finding 5** (collapse `ref-parser` no-op wrapper) — public but trivial; Expand/Contract alias.
6. **Findings 1, 3, 4** (dead `asp_modules`, ignored `LintOptions.rules`, duplicate path getters) — **public-surface; route through Expand/Contract** (deprecate → confirm no external consumer → remove). Do last.

## ✅ Safety checklist
- [ ] Re-ran `grep` to confirm `asp_modules` helpers and free path getters have no callers BEFORE any removal (done for this report; re-confirm at apply time including downstream repos).
- [ ] New error subclasses are **additive** to `core/errors.ts` exports; no rename/remove of `ConfigParseError`/`ResolutionError`.
- [ ] All "preserve message text" findings (2, 9) keep thrown strings byte-identical.
- [ ] Profile-reader unification (7) and `deriveSpaceKey` (8) verified against existing fixtures for input-tolerance equivalence (throw-vs-undefined) before swap — else flag as redesign.
- [ ] Spread/projection in `buildSyntheticAgentProjectManifest` and `composeContent` untouched (exact field set is load-bearing).
- [ ] Public-surface removals (1, 3, 4, 5) staged via Expand/Contract, not hard-deleted in a single pass.
- [ ] `bun run build` + `bun test` (config package + dependents) + `check:manifests` green after each step.
