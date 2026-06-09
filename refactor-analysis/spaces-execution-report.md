# Refactor analysis — `spaces-execution`

**Package dir:** `packages/execution`
**Package type:** general (run-time orchestration: harness launch, sessions, install/materialize wrappers)
**Scope:** 21 `.ts` source files (~3,050 LOC excluding the two test files). Read in full.

## Summary

This package is already in good shape — the two prior passes (T-02028, T-02030) clearly
landed. The classic low-hanging fruit is gone: the duplicated `toHarnessRunOptions` literal,
the duplicated compiler-debug context, the duplicated legacy-home migration dance, and the
six-`let` budget soup have all already been consolidated into `run/util.ts`,
`run/compiler-debug.ts`, and `run/identity.ts`, each with a load-bearing doc comment that
explains the consolidation. I did not re-flag any of those.

What remains is a small number of **genuinely dead structure** items — exports and a helper
that have **zero call sites anywhere in the monorepo** (verified by grep across
`packages`, `scripts`, `integration-tests`, excluding `dist/`). These are T16 de-abstraction
candidates, not "extract more". Two of them sit on the public index surface, so they are
deferred (public-surface). One is internal-only and safely applicable. There is also one
small internal duplication (`pathExists`) that is real but low-value.

Net: **1 applicable** (Low, internal-only), **2 deferred** (public-surface dead exports).
I deliberately did NOT manufacture findings to pad the count.

## Public boundary verdict

The package has **real external consumers**: `packages/cli`, `packages/agent-spaces`,
`packages/harness-broker`, `integration-tests`, and `scripts`. So `index.ts` is a true
published contract (M02 expand/contract applies to any change there) — internal churn is
free, but export removals are public-surface and must be deferred to a human even when the
symbol is provably dead, because an out-of-tree consumer (or the dev-publish Verdaccio loop)
could import it.

The boundary itself is well-shaped: most of `index.ts` is type-only re-exports and four thin
`harnessRegistry.getOrThrow(...)` install/build/materialize wrappers that exist precisely to
inject the adapter — that is legitimate adapter wiring, not a middle-man to collapse. The
deliberate "types-only, import runtime directly" split for `pi-session` / `claude` /
`agent-sdk` (to avoid pulling the pi-coding-agent barrel at CLI startup) is a load-bearing
performance boundary and is correctly commented; leave it alone.

The one boundary smell is that two symbols are exported from `index.ts` but called by no
one (see DF-1, DF-2 below).

## Findings by mechanism

### [T16] Collapse premature abstraction — dead public export `renderKeyValueSection` (DEFERRED)

- **Location:** `packages/execution/src/prompt-display.ts:108` (exported via `index.ts:104`)
- **Mechanism:** T16 de-abstract / remove dead surface.
- **Direction:** REMOVE. `renderKeyValueSection` has zero call sites in the entire monorepo
  (only its definition and its `index.ts` re-export match `grep -rnw`). It was presumably
  added speculatively alongside `renderSection` (which *is* used externally by
  `harness-broker/src/runtime/tmux-launch-runner.ts`), but the key-value variant was never
  wired up.
- **Preservation:** Removing an uncalled export cannot change observed behavior of any current
  caller. You'd know it helped: the public surface shrinks by one symbol, `tsc` stays green.
- **Risk:** Low. **apiImpact:** public-surface → **DEFERRED** (an out-of-tree importer is
  theoretically possible; a human should confirm before contracting the published API).
- **Tests:** none reference it; nothing to update. Churn: an `index.ts` export line + the
  function body deletion. No new lint.
- **Contraindication checked:** Is it a deliberate option kept for symmetry with
  `renderSection`? Possibly — but `renderSection` earns its keep via a real external consumer
  and `renderKeyValueSection` has none, so the symmetry is aspirational, not load-bearing.
  Flagged rather than auto-applied for exactly this reason.

### [T16] Collapse premature abstraction — dead public export `displayCommand` (DEFERRED)

- **Location:** `packages/execution/src/prompt-display.ts:295` (exported via `index.ts:101`)
- **Mechanism:** T16 de-abstract / remove dead surface.
- **Direction:** REMOVE. The exported **function** `displayCommand(command: string)` has zero
  call sites. Every other `displayCommand` hit across the repo is the unrelated
  `RunResult.displayCommand` / `spec.displayCommand` **field** or a local variable — none
  invoke this function. The actual command rendering in the live path goes through
  `displayPrompts({ showCommand: true, command })` in `execute.ts`, not `displayCommand()`.
- **Preservation:** Uncalled export; removal is behavior-neutral.
- **Risk:** Low. **apiImpact:** public-surface → **DEFERRED**.
- **Tests:** none reference the function. Churn: `index.ts` export line + body deletion.
- **Contraindication checked:** Could a CLI command call it? Grepped `packages/cli` — the only
  `displayCommand` import there (`cli/src/prompt-display.ts:10`) re-exports the symbol but no
  call site invokes it; CLI renders via its own logic and the `RunResult.displayCommand`
  field. Still deferred because it is on the published boundary.

### [T16] Collapse premature abstraction — dead internal helper `isViaCompiler` (APPLICABLE)

- **Location:** `packages/execution/src/run/util.ts:81`
- **Mechanism:** T16 de-abstract / remove dead seam.
- **Direction:** REMOVE. `isViaCompiler(env)` is a one-line wrapper around
  `resolveRunEnvFlags(env).viaCompiler`. It is **not** re-exported from `index.ts` and has
  **zero call sites** (in-package, external, or test). Both real consumers (`run.ts:137`,
  `space-launch.ts:114`) destructure `viaCompiler` directly from `resolveRunEnvFlags`. This
  is a leftover convenience seam that the consolidation into `resolveRunEnvFlags` superseded.
- **Preservation:** Internal, uncalled → removal is invisible to all callers and tests.
  You'd know it helped: one fewer redundant entry point into the same env-gate logic, so the
  "where do I read the compiler gate?" answer is unambiguous (`resolveRunEnvFlags`).
- **Risk:** Low. **apiImpact:** internal-only → **APPLICABLE**.
- **Tests:** `run.test.ts:415` tests `resolveRunEnvFlags`, not `isViaCompiler`; nothing to
  update. Churn: delete ~3 lines + its doc comment. No new lint.
- **Contraindication checked:** Is it a deliberate public convenience? No — it is not on the
  index surface and nothing imports it, so there is no consumer whose ergonomics it serves.

### [T15/T03] Duplicated `pathExists` helper (LEFT ALONE — see below)

Noted and intentionally not flagged for application; rationale in "Deliberately left alone".

## Deliberately left alone (with reasons)

- **`pathExists` duplicated in `run/agent-brain.ts:293` and `run/util.ts:127`.** Both are the
  same `stat`-or-false shape. *Why not dedupe:* `agent-brain.ts` deliberately keeps a small
  self-contained set of fs predicates (`pathExists`, `ensureDirectory`, `isNodeError`,
  `isInitialized`) so the brain runtime module has no intra-`run/` import beyond `./util.js`
  for genuinely shared concerns. Folding this one predicate into a `util` import buys ~6 lines
  and adds a cross-module coupling for a trivial wrapper; the prior passes evidently judged it
  not worth it. The copies are not diverging (no defense-in-depth subtlety), so it is *eligible*
  in principle — but it is the lowest-value change in the package and the contraindication
  (keep the brain module's fs predicates local/cohesive) is reasonable. Marked left-alone to
  avoid a churny, debatable edit.

- **`run/util.ts` `pathExists` vs `agent-brain.ts` `pathExists` differ in error handling.**
  `util.ts` swallows *all* errors → false; `agent-brain.ts` rethrows non-ENOENT. This is a
  **real semantic difference**, which is itself a reason NOT to mechanically merge them — a
  naive dedupe would change one call site's behavior on EACCES/EPERM. This confirms the
  divergence is load-bearing-ish and the helpers should stay separate.

- **`parsePlacementRuntimeModelId` default-to-`'codex'` arm** (`placement-plan.ts:88`). The
  no-slash branch returning `provider: 'codex'` looks like a "can't happen" default but is a
  **real reachable mapping** (single-segment model ids → codex). Keep explicit; not a T17.

- **`harnessFamilyForHarness` / `harnessRuntimeForHarness` / `compileInteractionMode`
  conditionals** (`compiler-debug.ts:19-59`). These are small enum→enum maps that fan out one
  arm per harness. They are NOT growing-one-arm-per-feature switches begging for a dispatch
  table — they map to a *fixed, catalog-bounded* set and one of them (`compileInteractionMode`)
  already correctly delegates the embedded-vs-headless decision to the catalog's
  `transport: 'sdk'` flag rather than hardcoding. Converting these to a registry/dispatch would
  add indirection without removing a real maintenance axis. Leave as guard clauses.

- **The four `harnessRegistry.getOrThrow(...)` install/build/materialize wrappers in
  `index.ts`.** These are adapter-injection wrappers, not pass-through middle men (they add the
  `adapter` resolution the config package requires). T23 does not apply.

- **`mergeDefined` / `toHarnessRunOptions` / `maybeCompileForRun` / `materializeRunSystemPrompt`.**
  All already-consolidated shared helpers with explicit "extracted from / consolidates two
  copies" doc comments. The prior passes did this work; nothing to re-extract.

- **`run.ts` `run()` ~290-line orchestration.** Long but linear and already decomposed into
  named stage helpers (`planProjectTargetRuntime`, `resolveRunIdentity`,
  `materializeRunSystemPrompt`, `maybeCompileForRun`, `executeHarnessRun`). The remaining length
  is irreducible pipeline wiring; further extraction would just relocate the same call sequence
  behind one more indirection without reducing nesting (it is mostly flat). Not flagged.

## Outside-in apply sequence

1. **Make-safe (already satisfied):** the public surface has live characterization tests
   (`run.test.ts` covers `isSpaceReference`, `planPlacementRuntime`, `planProjectTargetRuntime`,
   `combinePrompts`, `resolveRunEnvFlags`, codex runtime homes, prompt threading;
   `agent-tools.test.ts` covers tool validation). No new T40 net needed for the one applicable
   change because `isViaCompiler` is uncalled.
2. **Applicable now (internal-only, Low):** remove `isViaCompiler` from `run/util.ts`. Run
   `bun test` in the package + `tsc --noEmit`; both should stay green with no test edits.
3. **Deferred to human (public-surface):** DF-1 `renderKeyValueSection` and DF-2
   `displayCommand` export removals. These contract the published `index.ts` API; confirm no
   out-of-tree / Verdaccio consumer relies on them, then remove the export lines + bodies
   together (M02 contract step). If kept, leave a one-line "intentionally exported for X" note
   so the next pass doesn't re-flag them.
