# Refactor Analysis — spaces-harness-pi (`packages/harness-pi`)

packageType: **leaf** (a single HarnessAdapter plugin; pure transformation of inputs →
artifacts/args, no shared internal infra, consumed only through `HarnessAdapter` and `register`).

## Summary
The package is in good shape after the two prior passes (T-02028/T-02030). The error-handling and
duplication-extraction work clearly landed: `fs-helpers.ts` exists, `errors.ts` is clean, constants are
de-magicked, `pi-adapter.ts` is decomposed into small private methods, and the codegen modules read
single-purpose. Most low-hanging fruit is gone.

I found **4 honest findings**: one real behavior concern in generated code (flag, do NOT auto-apply),
two small internal-only structural cleanups, and one internal-only consistency gap. None touch the
public boundary's shape.

## Public boundary verdict
The public surface is `src/index.ts` (re-exporting from `pi-adapter.js`) plus `register.ts`. It is
intentionally a re-export hub keeping `./pi-adapter.js` stable while internals are split across
sibling modules — a deliberate, well-documented Boundary [T07] arrangement. The exported set
(`PiAdapter`, `piAdapter`, `detectPi`, `clearPiCache`, `findPiBinary`, `bundleExtension`,
`discoverExtensions`, `generateHookBridgeCode`, and the `PiInfo`/`ExtensionBuildOptions`/
`HookDefinition` types) matches actual consumer usage. The class methods (`detect`, `validateSpace`,
`materializeSpace`, `composeTarget`, `buildRunArgs`, `getRunEnv`, `getTargetOutputPath`,
`loadTargetBundle`, `getDefaultRunOptions`) are dictated by the `HarnessAdapter` interface in
`spaces-config` and are exercised by other adapters/execution — they are NOT removable. Verdict:
**boundary is sound; leave it.**

## Findings by mechanism

### F1 — Duplicate `session_start` handler in generated HRC-events bridge [T16 / behavior]
- **Location:** `src/adapters/codegen/hrc-events.ts:8-21` (the `HRC_FORWARDED_EVENTS` array still
  contains `'session_start'`) combined with the special-cased `pi.on('session_start', ...)` block at
  lines 76-90.
- **Mechanism:** Collapse premature/contradictory abstraction. The array comment (lines 25-26) and the
  module doc (line 40) both say `session_start` is "special-cased below," yet it is ALSO left in the
  generic-forward list. The generated extension therefore registers `pi.on('session_start', ...)`
  **twice** — once forwarding the raw event, once forwarding the sessionId-enriched event. The intent
  ("forward session_start with captured sessionId") is undermined by the un-enriched duplicate.
- **Direction:** Remove `'session_start'` from `HRC_FORWARDED_EVENTS` so only the enriched handler is
  emitted.
- **Preservation:** This is NOT behavior-preserving — it removes a runtime event registration from
  generated code (Pi would fire two handlers today). That is a redesign of generated behavior, so it
  must be a flagged, human-reviewed change, not an auto-apply. The existing characterization test
  (`pi-adapter.test.ts:932-947`) already omits `session_start` from its asserted loop, which suggests
  the duplicate was unintentional — but confirm with whoever owns the HRC forwarding contract that Pi
  tolerates (rather than depends on) the double-registration before changing it.
- **Risk:** High. **apiImpact:** public-surface (changes the bytes of a generated artifact other
  systems consume via `HRC_LAUNCH_HOOK_CLI`).
- **Tests:** Add an assertion that `session_start` is registered exactly once and only via the enriched
  path; the omit-from-loop test stays green.
- **Contraindication honored:** If HRC actually relies on receiving BOTH a bare and an enriched
  `session_start` (defense-in-depth), this duplicate is load-bearing — hence flagged, not applied.

### F2 — Inline structural-typing casts for the `pi` extra field are duplicated [T15]
- **Location:** `src/adapters/pi-adapter.ts:611-613` (`buildRunArgs`), `:652` (`pushExtensionArgs`
  param type), `:359-361` (`composeTarget` return), `:803` (`loadTargetBundle` return). Each spells out
  `ComposedTargetBundle['pi'] & { hrcEventsBridgePath?: string | undefined }` (or the NonNullable form)
  by hand.
- **Mechanism:** Extract missing abstraction. The "pi bundle that also carries `hrcEventsBridgePath`"
  is a real, repeated concept expressed four times as an ad-hoc intersection cast. A single internal
  type alias (e.g. `type PiBundleWithHrc = NonNullable<ComposedTargetBundle['pi']> &
  { hrcEventsBridgePath?: string | undefined }`) names it once.
- **Direction:** Extract the alias; reference it at all four sites.
- **Preservation:** Behavior-preserving — pure type-level deduplication, no runtime change, no emitted
  JS difference. Keep the `optional` vs `required` distinction the current sites encode (compose writes
  it as required, load/build read it as optional); the alias should be the optional form and the
  compose site can keep its local `as ... & { hrcEventsBridgePath: string }` narrowing.
- **Risk:** Low. **apiImpact:** internal-only (the alias is not exported; the public
  `ComposedTargetBundle` type is untouched).
- **Tests:** None new; existing compose/build/load tests cover it. `bun typecheck` is the gate.
- **Contraindication honored:** This stays a local alias — do NOT widen `ComposedTargetBundle['pi']`
  in `spaces-config` to add `hrcEventsBridgePath`; that would be a contract change [M02] affecting the
  other adapters and is out of scope.

### F3 — Compose-side directory reads bypass the `fs-helpers` ENOENT discipline [T18 / T03]
- **Location:** `src/adapters/pi-adapter.ts` — `mergeExtensions` (382-409), `mergeSkills` (421-439),
  `mergeHooks` (459-484). Each does a raw `try { stat(dir); if isDirectory ... } catch { /* doesn't
  exist */ }`.
- **Mechanism:** Restructure error handling + relocate by affinity. `fs-helpers.ts` was introduced
  (per its own header) specifically to "distinguish a missing source directory (ENOENT) from real IO
  failures so the latter are no longer silently swallowed," and `materializeSpace` uses it. The
  compose path was not migrated and still swallows ALL errors (e.g. EACCES, EMFILE) as "directory
  doesn't exist." This is the exact smell `fs-helpers` exists to kill, applied inconsistently.
- **Direction:** Route the three merge loops' existence check through an `fs-helpers` predicate
  (extend it with a small `dirExists(path): Promise<boolean>` that returns false only on ENOENT and
  re-throws otherwise), so non-ENOENT failures surface instead of being eaten. `mergeExtensions`
  iterates `readdir` after the check, so it wants a guard-then-read shape, not the copy-oriented
  `copyComponentDir`; a thin `dirExists` is the right new helper.
- **Preservation:** Behavior-preserving for the happy/ENOENT paths (the observable contract — "absent
  dir = skip" — is unchanged). It CHANGES behavior only for genuine IO faults, which today are masked;
  surfacing them is the intended improvement, not a regression. Note this for the reviewer; it is a
  low-risk strictening, internal-only.
- **Risk:** Low. **apiImpact:** internal-only.
- **Tests:** Existing "directory doesn't exist" branches stay green; optionally add a characterization
  test that a non-ENOENT stat error propagates (mirrors the rationale fs-helpers already encodes).
- **Contraindication honored:** Keep the per-loop bodies (readdir/copy logic) where they are — only the
  existence/error gate moves to the shared helper. Do NOT over-fold the three loops into one generic
  "merge any component dir" routine: they diverge meaningfully (collision tracking + linkOrCopy vs
  copyDir-per-subdir vs copyDir + hook parsing), so that duplication is load-bearing.

### F4 — `findPiBinary` PATH search ignores the `.js`-entrypoint affordance the common-paths loop honors [T15, minor]
- **Location:** `src/adapters/detect.ts:57-69` (`searchPath`) vs `:100-110` (common-paths loop). The
  common-paths loop accepts a non-executable `.js` file via `fileExists`, but `searchPath` only accepts
  `isExecutable` entries — an inconsistency in what counts as "found."
- **Mechanism:** Extract missing abstraction — the predicate "is this path a usable Pi entrypoint"
  (executable OR a runnable `.js`) is implemented in two places with two different rules.
- **Direction:** Factor a single `isUsablePiEntrypoint(path)` predicate used by both loops.
- **Preservation:** This is a **behavior change**, not a refactor: `searchPath` would start accepting
  `.js` files on PATH it currently rejects. Flag it; do NOT auto-apply. It may even be intentional that
  PATH entries must be real executables (PATH `.js` files are unusual). Recorded as
  deliberately-left-alone below rather than as an applicable item.
- **Risk:** Med. **apiImpact:** public-surface (`findPiBinary` is exported; detection result changes).
- **Tests:** Would need new detect tests for the PATH-`.js` case before any change.
- **Contraindication honored:** The asymmetry is plausibly deliberate (PATH = real binaries; install
  dirs = source checkouts run via bun). Left alone.

## Deliberately left alone (where-NOT applies)
- **`validateSpace` always-valid stub and `getDefaultRunOptions` empty return** (`pi-adapter.ts:166`,
  `:818`): these look like partial/no-op overrides [T17], but they are required `HarnessAdapter`
  methods and the empty bodies are documented, intentional opt-outs (Pi imposes no space-naming rule;
  the runtime supplies all run options). Total, correct, and contract-mandated — not a smell.
- **`PI_BLOCKING_EVENTS = []`** (`constants.ts:41`) and the `PI_BLOCKING_EVENTS.includes(hook.event)`
  guard (`pi-adapter.ts:509`): an empty-array constant that always makes the guard fire W301 looks like
  dead structure, but it is a deliberate, documented extension point ("none currently — best-effort
  only") and keeps the warning logic future-proof against Pi gaining blockable events. Leave it.
- **`manifestWithPi` cast** (`pi-adapter.ts:235-243`): an inline structural cast to read the optional
  `pi.build` extension off the manifest. It is local, single-use, and documented as reaching an
  extended schema; not worth a shared type. Leave it.
- **The three `try/catch` `stat` blocks' bodies** beyond the ENOENT gate (F3): the loop logic genuinely
  diverges per component type; do not dedup the bodies.
- **F4's PATH-vs-common-paths asymmetry**: see above — plausibly intentional, behavior-changing, left.
- **`piCommand` `.js`→bun dispatch** (`detect.ts:118-120`): tidy one-liner, single source of truth for
  the bun-vs-direct decision. No change.

## Outside-in apply sequence
1. **Make-safe (already in place):** the characterization suite in `pi-adapter.test.ts` (2037 lines)
   covers compose/materialize/buildRunArgs/codegen. No new harness needed before the internal-only
   edits; add the targeted assertions named in F2/F3 as you go.
2. **F2 (Low, internal-only, type-only):** extract the `PiBundleWithHrc` alias. Gate: `bun typecheck`.
   Pure mechanical, no test churn.
3. **F3 (Low, internal-only):** add `dirExists` to `fs-helpers.ts`, route the three compose merge loops
   through it. Gate: existing compose tests + the new propagation test. Touches one file's three
   methods plus a small helper export (internal).
4. **F1 (High, public-surface — DEFER to human):** do NOT auto-apply. Confirm the HRC forwarding
   contract tolerates removing the duplicate `session_start` registration, then drop it from
   `HRC_FORWARDED_EVENTS` and add the exactly-once assertion.
5. **F4 (Med, public-surface, behavior change — DEFER):** only if product wants PATH-`.js` parity;
   needs new detect tests first.

## Applicability tally
- Auto-applicable (Low/Med + internal-only): **F2, F3** → 2.
- Deferred (High OR public-surface): **F1** (High, public-surface), **F4** (Med, public-surface) → 2.
