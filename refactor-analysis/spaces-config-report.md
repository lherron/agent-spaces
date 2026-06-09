# Refactor Analysis — `spaces-config` (packages/config)

packageType: **general** (config-time determinism library: pure parsing/resolution/materialization, no concurrency or hot paths beyond IO).

## Summary

This package is large (~29k LOC incl. tests, ~12k src) but is in very good structural
shape. The two prior SOLID/code-smell passes (T-02028, T-02030) are clearly visible: the
hot files I read are already decomposed into named helpers and param objects
(`MaterializeTargetContext`, `populateSnapshotsFromLock`, `groupHooksByEventAndMatcher`,
`buildClaudeEventEntry`, `flattenClaudeNativeHooks`, `assertNoNameCollision`,
`collectSpacesAndIntegrities`, `parseBranchLine`/`categorizeFile`, the catalog-map dispatch
in `harness.ts`, the facet-list dispatch in `explainPermissions`). Magic numbers are named
constants; `asStringArray` narrowing helpers are shared; spreads are explicit projections.

I found **2 real findings**, both error-handling / dead-surface, plus a set of
deliberately-left-alone items. There is **no auto-applicable (Low/Med + internal-only)
finding** that is a pure behavior-preserving refactor — the one internal-only finding is a
behavior change (corrupt-file outcome) and is therefore flagged, not auto-applied.

**applicableCount = 0.**

## Public boundary verdict

The public API is fanned out across seven subpath exports (`.`, `./core`, `./git`,
`./resolver`, `./store`, `./materializer`, `./lint`) plus a flat root barrel that re-exports
selected names and re-namespaces `git`/`resolver`/`lint` to avoid collisions. This is a
deliberate, coherent boundary; `package.json#exports` matches the index files. No leaky or
fat-interface problem at the boundary. The one boundary defect is a **declared-but-unhonored
option** (`LintOptions.rules`) — see F2.

## Findings by mechanism

### F1 — `readHooksToml` swallows non-ENOENT errors (dead ENOENT branch + silent corrupt-file)
- **Location:** `packages/config/src/materializer/hooks-toml.ts:172-184`
- **Mechanism:** [T18] restructure error handling (+ [T17] partial→total: the ENOENT `if`
  arm is dead because both arms return `null`).
- **Direction:** Make the swallow explicit and policy-conforming. The sibling
  `readPermissionsToml` (`permissions-toml.ts:283-298`) documents the repo's "never silently
  capture errors" policy and re-throws any non-ENOENT error; `readHooksToml` does the
  opposite — `catch { if (ENOENT) return null; return null }` — so a malformed `hooks.toml`
  or a real IO error silently yields `null` (= "no hooks"), and the ENOENT check is
  unreachable-meaningful (both paths return the same value). Align with the sibling:
  `if (ENOENT) return null; throw err`.
- **Preservation / behavior:** This is a **behavior change**, not a pure refactor: today a
  corrupt `hooks.toml` materializes zero hooks; after the change it throws. The two callers
  (`materialize.ts:86`, `lint/rules/hooks-json.ts:46`) treat `null` as "no hooks" and do not
  catch, so the throw would propagate during materialization/lint — which is the intended,
  policy-correct outcome (a corrupt hooks file should fail loudly, matching permissions). The
  `| null` return type and the missing-file (ENOENT → null) contract are preserved.
- **Risk:** Med (behavior change on the corrupt-file path). **apiImpact:** internal-only
  (return type unchanged; only the corrupt/IO-error outcome changes).
- **Tests:** add a characterization test for "malformed hooks.toml throws" (mirror the
  permissions-toml.test.ts case); confirm no existing test asserts that a bad hooks.toml
  returns `null`/empty (none found in `hooks-toml.test.ts`).
- **Contraindication checked:** the second `return null` is *not* a deliberate defense-in-depth
  fallback — the sibling module and its inline policy comment establish the opposite intent;
  this looks like an un-updated copy that the prior passes touched on the permissions side but
  not here. Because it changes an observable outcome, it is flagged (not auto-applied).

### F2 — `LintOptions.rules` is a declared-but-unhonored public option
- **Location:** `packages/config/src/lint/index.ts:41-64` (interface + `lint()` signature
  `_options: LintOptions`); re-exported via `packages/config/src/index.ts:106` (`lintSpaces`).
- **Mechanism:** [T16] collapse premature abstraction / DE-ABSTRACT — a flag whose variation
  never materialized; equivalently [B/M02] expand-contract for a public contract.
- **Direction:** Either (a) honor it — filter `allRules` by the requested rule ids before the
  loop — or (b) remove the unused `rules?` field and the `_options` parameter. The function
  ignores `_options` entirely (underscore-prefixed, never read); no caller in this package
  passes options (`install.ts:666` calls `lintSpaces(lintContext)` with one arg). The dead
  surface advertises selective-rule linting that does not exist.
- **Preservation / behavior:** Observable behavior of every current call is identical either
  way (the option was never consulted). Honoring it (option a) *adds* capability rather than
  changing existing behavior; removing it (option b) is a contract narrowing.
- **Risk:** Low. **apiImpact:** **public-surface** (`LintOptions` and `lintSpaces` are
  exported; removal or semantic change is a contract change requiring expand-contract).
- **Tests:** if honored, add a test passing `{ rules: ['W201'] }` and asserting only that
  rule runs; if removed, update the exported-symbol/type surface and any downstream importer.
- **Contraindication checked:** an unused option *can* be a deliberate reserved extension
  point — but here it is undocumented as such and the parameter is underscore-discarded, which
  signals "forgotten", not "reserved". Still public, so surfaced for a human decision rather
  than auto-applied.

## Deliberately left alone (with reasons)

- **`computeClosure` dependency-edge `if`-chain** (`resolver/closure.ts:134-157`): four
  `parent===X && this===Y → throw` arms could become a `DISALLOWED_EDGES` lookup table
  ([T15]/[T19]). Left alone: only 4 arms, each message is edge-specific, and the imperative
  form reads clearly. Folding into a table trades readable per-edge messages for a parameterized
  template with no real reduction in surface — low value, churn-positive.
- **Per-kind `resolved`/`key` assignment** (`closure.ts:166-207`) and the parallel
  kind-suffix `if/else` in `install.ts:279-288`, plus `classifySpaceEntry` usage and the
  `deriveSpaceKey` regexes in `placement-resolver.ts:219-232`: there is a genuine recurring
  "space kind = agent | project | dev | registry" axis reified inconsistently across files.
  Unifying it into one shared kind→key/marker module is a [T15] extract-missing-abstraction,
  but it **crosses module boundaries and would touch the resolver's core load path** — a
  redesign, not a behavior-preserving refactor. Out of scope for an auto-apply pass; flag for a
  dedicated, test-gated effort if it recurs.
- **`buildResolvedFromSelector`** (`lock-generator.ts:107-121`) and
  `normalizeHarnessForHooks`/`normalizeHookHarness` (`hooks-toml.ts:217-226`): discriminated-
  union narrowing producing strings — idiomatic, total, correct. No dispatch refactor warranted.
- **`buildSyntheticAgentProjectManifest`** (`placement-resolver.ts:447-474`): heavy
  conditional-spread, but each spread is an **explicit, field-named projection** (the exact
  pattern the guidance prefers over `{...obj}`). Leave as-is.
- **Conditional-spread option assembly** in `materialize-refs.ts:171-215`: same explicit-
  projection pattern guarding `exactOptionalPropertyTypes`. Correct; do not "simplify" into
  spreads of whole objects.
- **`harness.ts` (650 lines)**: large but it is a types-and-catalog module (interfaces +
  one `HARNESS_CATALOG` source-of-truth with derived maps). Cohesive; the size is data, not
  tangled logic.
- **`catch {}` in `readHooksWithPrecedence`** (`hooks-toml.ts:482`): swallows JSON parse
  errors when falling back from toml→json legacy formats. This is a genuine best-effort
  legacy-format fallback (try toml, then try several json shapes, else "none") — load-bearing
  tolerance, unlike F1's parse-of-the-canonical-format. Left alone.
- **W202 `getCommandNames` vs `materialize-refs.detectCommandConflicts`**: both scan a
  `commands/` dir for `.md` files, but operate on different inputs (lint `SpaceLintData` vs
  resolved `pluginDirs`) for different purposes. Coincidental similarity, not load-bearing
  duplication; coupling them would create a false abstraction.

## Outside-in apply sequence (if a human elects to act)

1. **F2 (public-surface, Low):** decide honor-vs-remove for `LintOptions.rules`. This is the
   boundary call and gates nothing else; resolve it first via expand-contract.
2. **F1 (internal-only, Med, behavior-flagged):** before changing, add the characterization
   test for malformed `hooks.toml` (currently → `null`); then make `readHooksToml` re-throw
   non-ENOENT to match `readPermissionsToml`; re-run `materialize`/lint tests to confirm the
   throw propagates only on genuinely corrupt input.

No further structural changes recommended — the package is otherwise clean.
