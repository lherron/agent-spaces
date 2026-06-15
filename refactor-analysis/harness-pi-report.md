# 🔧 Refactoring Analysis — spaces-harness-pi

**Target:** packages/harness-pi/src  ·  **Files read:** 10 (8 source + index + register; 1 test read-only)  ·  **Lines:** ~1647 source
**Generated:** 2026-06-14  ·  **Package type:** leaf (harness adapter; codegen + fs orchestration)

## 🧭 Summary
A single `HarnessAdapter` implementation (Pi CLI) plus cohesive submodules (detect / bundle / codegen / fs-helpers / errors / constants) re-exported through `pi-adapter.ts`. The package has already absorbed a prior refactor pass: fs error-handling is principled (ENOENT vs real IO faults), facets/lint loops are table-driven, and the module split is clean. Remaining leverage is concentrated at the boundary (an undeclared `hrcEventsBridgePath` carried by `as`-casts) and a handful of internal consolidations (a third `isFile` predicate, near-identical `loadTargetBundle` probe blocks). The codegen string-interpolation injection hazard is real but is a behavior-changing **redesign**, not a refactor.

## 🚪 Public boundary (assess first)
- **API surface:** `index.ts` re-exports from `pi-adapter.js`: `PiAdapter`, `piAdapter` (singleton), `detectPi`, `clearPiCache`, `findPiBinary`, `bundleExtension`, `discoverExtensions`, `generateHookBridgeCode`, types `PiInfo` / `ExtensionBuildOptions` / `HookDefinition`; plus `register`. `pi-adapter.ts` additionally re-exports `PiBundleError`, `PiNotFoundError`. The de-facto contract consumed by the runtime is the `HarnessAdapter` interface (from `spaces-config`) implemented by `PiAdapter`.
- **Findings:**
  - **F1 (T07 / M02):** `ComposedTargetBundle['pi']` in `spaces-config` does NOT declare `hrcEventsBridgePath`. The adapter invents a local `PiBundleWithHrc` type and casts to it at 5 sites (`pi-adapter.ts:94`, `:371`, `:621`, `:658`, `:808`). The field is written into the bundle, persisted, and re-read in `loadTargetBundle`/`buildRunArgs` — so it is a real part of the bundle contract that the shared type lies about. Callers must cast around the API → interface not aligned to actual usage.
  - **F2 (T16, narrow):** `detect.ts` populates `supportsExtensions` / `supportsSkills` by probing `pi --help` for `--extension` / `--skills`, surfaced as capability strings. No code branches on these (grep shows zero consumers beyond the capability array). The probe spawns two extra `pi --help` processes per detection for output that only ever appears in a detection report. Candidate for collapse — but see contraindication.
- **Verdict:** 🟡 needs care — the surface is small and coherent, but the `pi` bundle sub-type is leaky (F1): the persisted shape exceeds the declared shape, forcing casts.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. `hrcEventsBridgePath` is an undeclared bundle field cast around the type — [T07] Align interface to actual usage / [M02] Expand-Contract
- **Location:** `pi-adapter.ts:94` (local `PiBundleWithHrc`), `:371`, `:621`, `:658`, `:808`; shared type at `packages/config/src/core/types/harness.ts:371-380`.
- **Mechanism repaired:** Structural cause is a contract/usage divergence: the adapter produces and consumes a field (`hrcEventsBridgePath`) that the shared `ComposedTargetBundle['pi']` type omits, so every read/write launders through `as PiBundleWithHrc`. The cast is load-bearing (the field really exists on persisted bundles), so the type is simply wrong.
- **Symptom that flagged it:** Five `as PiBundleWithHrc` casts plus a hand-rolled augmentation type; one cast even double-asserts `as PiBundleWithHrc & { hrcEventsBridgePath: string }` (:371).
- **Current → Suggested:** Add `hrcEventsBridgePath?: string | undefined` (and, since it is also persisted, optionally `runManifestPath` already present) to the shared `pi?: {...}` shape in `spaces-config` via Expand/Contract (add field → adapter stops casting → other Pi consumers keep compiling because the field is optional), then delete `PiBundleWithHrc`.
- **Direction:** relocate (move the field from a local cast type into the shared contract) / isolate-removal of casts.
- **Preservation:** type/compiler-proof — adding an optional field is additive; runtime payload already carries it, so observable behavior (the JS object written/read) is unchanged.
- **Falsifiable signal:** after adding the field, all 5 casts can be deleted and `tsc`/biome stays green; bundle JSON written by `composeTarget` is byte-identical.
- **Risk:** Med  ·  **API-impact:** public-surface (edits shared `spaces-config` type consumed by other adapters/runtime)  ·  **Effort:** S-M
- **Tests:** existing `composeTarget`/`loadTargetBundle`/`buildRunArgs` tests pin the field presence; add no new behavior.
- **Contraindication:** none structural; the comment at :88-96 claims the field is "kept local to avoid changing the cross-adapter contract" — that intent is exactly what Expand/Contract makes safe, so the deferral is no longer warranted, but it MUST go through the additive path (do not make it required).

### 2. Third reimplementation of an `isFile` / `path-is-file` predicate — [T15] Extract missing abstraction (relocate into fs-helpers)
- **Location:** `codegen/hook-bridge.ts:53-60` (`isFile`); `detect.ts:45-52` (`fileExists` via `access F_OK`); inline `stat().isFile()` + bare `catch` in `pi-adapter.ts:541-550` (`linkPiAuth`), `:779-797` (`loadTargetBundle`, twice).
- **Mechanism repaired:** the same intent ("does this path resolve to a regular file, false on absence") is open-coded 4×, while `fs-helpers.ts` already owns the sibling predicates `dirExists` / `listDirEntries`. Missing the file-level analog forces re-derivation and inconsistent error handling (hook-bridge/linkPiAuth swallow ALL errors; fs-helpers deliberately re-throws non-ENOENT).
- **Symptom that flagged it:** duplicated try/stat/isFile across modules; `fs-helpers` is the obvious home.
- **Current → Suggested:** add `export async function fileExists(path): Promise<boolean>` to `fs-helpers.ts` (ENOENT→false, re-throw others), then call it from `loadTargetBundle` (replacing the two stat-probe blocks) and `hook-bridge`'s `isFile`. Note: `linkPiAuth` and `hook-bridge` currently swallow EACCES too — converting them to the re-throwing helper is a behavior change for those two call sites, so keep their local catch-all unless the change is explicitly accepted (or have the helper take a `swallowAll` option). Safest internal-only scope: consolidate only `loadTargetBundle`'s two blocks (which already only care about presence).
- **Direction:** relocate / isolate.
- **Preservation:** type/compiler-proof for `loadTargetBundle` (presence check semantics identical); test-suite for any further reach. The `loadTargetBundle` tests pin the returned `skillsDir`/`hookBridgePath`/`hrcEventsBridgePath` field population.
- **Falsifiable signal:** `loadTargetBundle` returns identical bundle objects for present/absent files; suite green.
- **Risk:** Low (scoped to `loadTargetBundle`)  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** existing `describe('loadTargetBundle')` covers present + absent cases.
- **Contraindication:** do NOT fold the error-swallowing `linkPiAuth`/`hook-bridge` catch-alls into a re-throwing helper without accepting the behavior change — their swallow-all is arguably load-bearing (auth optional; hook path probing best-effort).

### 3. `loadTargetBundle` repeats a "stat → isFile → keep path" probe three times — [T15] Extract missing abstraction
- **Location:** `pi-adapter.ts:769-797` (skills via `readdir`; hookBridge via `stat`; hrcEventsBridge via `stat`).
- **Mechanism repaired:** three structurally identical blocks differing only by path and the presence test; the intent ("optional path if it resolves") is unnamed. Directly composable with Finding 2's `fileExists` plus the existing `listDirEntries`.
- **Symptom that flagged it:** copy-paste try/catch trio with near-identical comments ("No skills directory" / "No hook bridge" / "No HRC events bridge").
- **Current → Suggested:** `skillsDirPath = (await listDirEntries(skillsDir)).length > 0 ? skillsDir : undefined` (mirrors what `composeTarget` already does at :356), and `hookBridge = (await fileExists(p)) ? p : undefined` ×2.
- **Direction:** remove (collapse duplication).
- **Preservation:** observational-equivalence — same path-or-undefined outputs; `listDirEntries` already maps ENOENT→[] which matches the current empty-on-missing behavior.
- **Falsifiable signal:** `loadTargetBundle` output unchanged across present/absent fixtures.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** `describe('loadTargetBundle')`.
- **Contraindication:** none.

### 4. Capability probing (`--help` grep for `--extension`/`--skills`) is dead variation — [T16] Collapse premature abstraction
- **Location:** `detect.ts:163-180` (`supportsPiFlag`), `:194-204` (parallel probe), consumed only at `pi-adapter.ts:155-156`.
- **Mechanism repaired:** `supportsExtensions`/`supportsSkills` are computed (two extra `pi --help` spawns) but nothing branches on them — they only decorate `detect()`'s `capabilities[]` report. Variation that never materializes; also note the probe greps for `--skills` while the adapter actually passes `--skill`/`--no-skills` (the probe flag and the used flag already disagree, evidence the signal isn't acted on).
- **Symptom that flagged it:** zero downstream consumers (grep), probe-flag/usage-flag mismatch.
- **Current → Suggested:** Either (a) leave as-is (it is a cheap, observable detection report), or (b) hard-code the two capabilities as always-true (Pi always supports extensions/skills in supported versions) and drop `supportsPiFlag` + the two extra spawns. (b) changes `PiInfo` shape (public type via `index.ts`) and removes the `--help` spawn — observable for anyone reading detection output, so route through Expand/Contract.
- **Direction:** remove.
- **Preservation:** redesign-adjacent — removing the probe changes `detect()` latency and the reported capabilities for old Pi builds lacking the flag; flag as **behavior-changing**, not a pure refactor.
- **Falsifiable signal:** `detect capability inference` test (`pi-adapter.test.ts:1983`) asserts the inferred capabilities; it would need updating → confirms behavior change.
- **Risk:** Med  ·  **API-impact:** public-surface (`PiInfo` exported; `detect()` capabilities observable)  ·  **Effort:** S
- **Tests:** `describe('detect capability inference')`.
- **Contraindication:** the seam is arguably a deliberate forward option (future Pi versions could drop a flag). Given it is cheap and harmless, **leave alone** unless capability-driven branching is explicitly wanted. Flagged for the record, not recommended for auto-apply.

### 5. Codegen interpolates raw `hook.script`/`hook.event` into JS string literals — REDESIGN (injection/correctness hazard)
- **Location:** `codegen/hook-bridge.ts:106-200` (template literals embedding `${hook.script}` / `${hook.event}` inside single-quoted JS in the generated extension, e.g. `:121`, `:146`, `:172`, `:191`).
- **Mechanism repaired:** would be [T18]/[T12] (encode the hook table as JSON-serialized data the generated code reads, rather than splicing untrusted strings into source) — but fixing it CHANGES the emitted bridge code for any script containing quotes/newlines, i.e. observable output changes.
- **Symptom that flagged it:** already documented by `test.todo` at `pi-adapter.test.ts:2043-2071` ("UNFIXED behavioral hazard"); a `script` with a quote terminates the literal or injects code.
- **Current → Suggested:** serialize hook metadata as a `JSON.stringify`'d table emitted once, and have the generated runtime iterate it — no raw interpolation of `script`/`event` into code positions.
- **Direction:** isolate (move untrusted values from code-position to data-position).
- **Preservation:** NOT a refactor — generated text changes for adversarial inputs; this is a **redesign**. Pin with the existing `.todo` characterization test flipped to active before/after.
- **Falsifiable signal:** the `.todo` test (`escapes hook.script values containing quotes/newlines`) goes green only after the change.
- **Risk:** High  ·  **API-impact:** internal-only (generated artifact), but correctness/security-sensitive  ·  **Effort:** M
- **Tests:** activate `pi-adapter.test.ts:2053` todo; add a fixture asserting the generated bridge still `require`-parses with an injection-y script.
- **Contraindication:** none — but because it is behavior-changing it must NOT be auto-applied in a refactor pass.

### 6. `PI_EVENT_MAP` carries lowercased "buggy snake_case" variants — observation, leave-or-isolate
- **Location:** `codegen/hook-bridge.ts:35-51` (entries `sessionstart`, `pretooluse`, `posttooluse`, `stop` with comment "from buggy snake_case conversion in readHooksWithPrecedence").
- **Mechanism repaired:** would be [T12]/[T03] — the real fix is upstream in `readHooksWithPrecedence` (normalize event names there), with this map being defense against a known-buggy producer. Removing the entries here without fixing the producer would silently drop hook registration → behavior change.
- **Symptom that flagged it:** self-described "buggy" workaround duplicated against the canonical names.
- **Current → Suggested:** track an upstream fix in `spaces-config`'s `readHooksWithPrecedence`; once normalized, remove the lowercased arm (Expand/Contract across packages).
- **Direction:** remove (cross-package, deferred).
- **Preservation:** behavior-changing across the package boundary — defer.
- **Falsifiable signal:** hook-bridge tests still register events when fed lowercased input only until the producer is fixed.
- **Risk:** Med  ·  **API-impact:** public-surface (depends on `spaces-config` behavior)  ·  **Effort:** M
- **Tests:** hook-bridge generation tests (`pi-adapter.test.ts:1663`).
- **Contraindication:** this is load-bearing compensation for a known producer bug — do NOT remove the variants until the producer is fixed.

### 7. `manifestWithPi` ad-hoc cast for optional `pi.build` config — [T07] minor, isolate
- **Location:** `pi-adapter.ts:245-258` (`input.manifest as typeof input.manifest & { pi?: { build?: {...} } }`).
- **Mechanism repaired:** the manifest's `pi.build` is read via an inline structural cast because the manifest type's `pi` config isn't surfaced here. `spaces-config` already exports `SpacePiConfig` (harness.ts:653 `pi?: SpacePiConfig`) — the cast likely duplicates an existing type.
- **Symptom that flagged it:** local re-declaration of a manifest sub-shape.
- **Current → Suggested:** if `ProjectManifest`/manifest type already exposes `pi?: SpacePiConfig` with a `build` field, drop the cast and read directly; otherwise keep but reference `SpacePiConfig` instead of an inline literal.
- **Direction:** isolate / relocate.
- **Preservation:** type/compiler-proof — pure type tightening, no runtime change.
- **Falsifiable signal:** removing the inline literal in favor of the named type compiles; `materializeSpace` bundling tests unchanged.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** `describe('materializeSpace')`.
- **Contraindication:** verify the manifest type actually carries `pi.build` before deleting the cast; if it only carries a different shape, the inline cast is genuinely the narrowest correct option — keep it.

## 🪶 Deliberately left alone (where-NOT)
- **fs-helpers ENOENT-vs-real-IO discipline** (`fs-helpers.ts`, `mergeExtensions`/`mergeSkills`/`mergeHooks`): already the principled form (re-throw non-ENOENT); the inline comments document a prior fix. No change.
- **`LINT_ONLY_FACETS` table + `collectLintOnlyFacets`** (`pi-adapter.ts:102-113`, `:596-607`): already table-driven dispatch over facets — this is the target state of T19/T15, not a smell.
- **`linkPiAuth` / `hook-bridge` swallow-all catches:** best-effort by design (auth optional; hook path probing tolerant). Converting to re-throwing helpers would be a behavior change — left alone.
- **Private method decomposition of `composeTarget`/`buildRunArgs`** (`mergeExtensions`, `pushExtensionArgs`, etc.): cohesive, single-responsibility helpers; no over-/under-abstraction. No change.
- **`piCommand` `.js`→bun dispatch** (`detect.ts:131`): a genuine, reachable two-arm branch (real executable vs `.js` run with bun). Not premature — keep.
- **Singleton `piAdapter`** (`pi-adapter.ts:834`): registry pattern expects an instance; `register.ts` consumes it. Not a hidden-dependency seam problem here.

## 🔭 If applying: outside-in sequence
1. **F1 (public, Expand/Contract):** add `hrcEventsBridgePath?` to `spaces-config` `ComposedTargetBundle['pi']`; rebuild; delete `PiBundleWithHrc` and all 5 casts in `pi-adapter.ts`. Verify bundle JSON byte-identical.
2. **F2/F3 (internal):** add `fileExists` to `fs-helpers.ts`; collapse `loadTargetBundle`'s three probe blocks (using `listDirEntries` + `fileExists`). Run `loadTargetBundle` tests.
3. **F7 (internal, optional):** replace the inline manifest cast with `SpacePiConfig` if the type exposes `build`.
4. **F5 (redesign, separate task):** JSON-serialize the hook table in `generateHookBridgeCode`; flip the `.todo` test active.
5. **F4 / F6 (deferred, cross-package or behavior-changing):** capability-probe collapse and `PI_EVENT_MAP` upstream normalization — only with explicit acceptance.

## ✅ Safety checklist
- [ ] `bun run --filter spaces-harness-pi build` / `tsc` green after each step.
- [ ] biome clean (no new casts introduced; parameterized literals don't trip `useValidTypeof` — N/A here).
- [ ] `pi-adapter.test.ts` suite green; specifically `composeTarget`, `loadTargetBundle`, `buildRunArgs`, `detect capability inference`, hook-bridge codegen + injection-hazard `.todo`.
- [ ] Spread/projection preservation: `loadTargetBundle`/`composeTarget` emit the EXACT field set (no extra props leaked via `{...}`); the `mergeHooks` projection at `pi-adapter.ts:489-491` intentionally drops `matcher` — preserve that exclusion.
- [ ] F1: confirm no OTHER adapter relied on the field being absent (it is optional → additive).
- [ ] Auto-apply ONLY F2/F3 (and F7 if type confirmed). F1, F4, F5, F6 route through review.
