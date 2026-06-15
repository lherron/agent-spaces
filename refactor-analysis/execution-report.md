# 🔧 Refactoring Analysis — spaces-execution

**Target:** packages/execution/src  ·  **Files read:** 17 source (+ 3 tests)  ·  **Lines:** ~2,600 source
**Generated:** 2026-06-14  ·  **Package type:** general (run-time orchestration / launch volatility)

## 🧭 Summary
This package is a thin orchestration shell: a large public barrel that re-exports harness adapters /
session helpers from sibling packages, plus the `run()` launch pipeline (project-target + global/local
space modes) and codex runtime-home preparation. The code is already heavily refactored (most prior
duplication has been pulled into `run/util.ts`, `run/compiler-debug.ts`, `run/identity.ts`). The
remaining leverage is in DEAD/DECOMMISSIONED surface (brain runtime), an over-broad public barrel, a few
never-read result fields, and over-exposed module functions that are internal-only. No magic-number or
new-extraction work is warranted — the recurring concepts are already named once.

## 🚪 Public boundary (assess first)
- **API surface:** `index.ts` re-exports `claude/*`, `spaces-runtime/session`, `agent-sdk/*`, pi-session
  *types*, all of `harness/*`, the `run*` family (`run`, `runWithPrompt`, `runInteractive`,
  `runGlobalSpace`, `runLocalSpace`, `isSpaceReference`, detectors, planners, prepare/resolve helpers,
  and ~20 types), `pager.paginate`, `prompt-display.*`, and the install/materialize/build wrappers that
  inject the harness adapter. `harness/index.ts` is itself a second barrel re-exporting four sibling
  harness packages and constructing/registering the singletons.
- **Findings:**
  - The barrel re-exports a *decommissioned* brain runtime (`resolveAgentBrainRuntime`,
    `BrainRuntimeResolution`, `EnabledAgentBrainEnvResult`, `AgentBrainEnvResult`) — public surface that
    is dead (always returns `disabled`/`{}`). See Finding 1 (M02 / T16).
  - `run.ts` re-exports `resolveAgentRunDefaults`, `resolveAgentRunDefaults`-adjacent helpers, and
    `migrateLegacyProjectHarnessOutput`/`migrateLegacyProjectCodexRuntimeHome` which are consumed only by
    the test suite, not by other packages — legitimate "pin behavior" surface, leave alone.
  - `harness/index.ts` constructs `harnessRegistry`/`sessionRegistry` and calls `setSessionRegistry` at
    **module-load** time (import side effects). This is a deliberate startup wiring seam, not a smell —
    documented as where-NOT.
- **Verdict:** 🟡 needs care — sound shape, but it publicly exposes a decommissioned subsystem
  (brain) whose removal must route through Expand/Contract.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. Decommissioned brain runtime still exported as live public surface — [T16] Collapse premature abstraction + [M02] Expand/Contract
- **Location:** `run/agent-brain.ts:11-59`; re-exported `index.ts:70-91`, `run.ts:42-49`
- **Mechanism repaired:** A whole subsystem's variation never materialized (brain was decommissioned).
  `resolveAgentBrainRuntime` always returns `{ kind: 'disabled', reason: 'decommissioned' }`; the rich
  discriminated union `BrainRuntimeResolution` with its `enabled` arm, `EnabledAgentBrainEnvResult`, and
  the `G BRAIN_HOME`/`BRAIN_REPO` template-literal key types are structure for a branch that can no
  longer be reached. `prepareAgentBrainRuntime` always returns `{}`.
- **Symptom that flagged it:** One-arm discriminated union where the other arm is unreachable; a function
  whose only return is the `disabled` literal; a 50-line type file modeling capabilities that are off.
- **Current → Suggested:** `resolveAgentBrainRuntime` has ZERO external callers (grep-confirmed; only the
  barrel re-exports it). It can be removed. `prepareAgentBrainRuntime` is still called from `execute.ts`
  and two `agent-spaces` CLI sites but always yields `{}` (the `{...harnessEnv, ...brainEnv}` spread is a
  no-op). Collapse the union to the single reachable shape and, via Expand/Contract, deprecate then
  remove `resolveAgentBrainRuntime` + the `enabled`/`Brain*` types from the barrel.
- **Direction:** remove (de-abstract)
- **Preservation:** type/compiler-proof for the union collapse (no `enabled` value is ever produced);
  observational-equivalence for the no-op `prepareAgentBrainRuntime` spread. Removing the export is a
  public-contract change → Expand/Contract.
- **Falsifiable signal:** `grep -rn 'resolveAgentBrainRuntime' --include='*.ts' | grep -v dist | grep -v
  'agent-brain.ts\|src/index.ts\|src/run.ts'` returns nothing (no real callers). Build + full test suite
  stays green after removal.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** M
- **Tests:** add a characterization test asserting `prepareAgentBrainRuntime(...)` returns `{}` before
  collapsing; existing `run-compile-brain-decommissioned.test.ts` (in agent-spaces) pins the disabled
  outcome at the compiler layer.
- **Contraindication:** This is a published export — an out-of-tree consumer could import it. Honor the
  add-new→support-both→migrate→remove-old sequence (deprecate first, ship a release, then drop). Keeping
  `prepareAgentBrainRuntime` as a documented no-op compat hook (its CLI comment already says so) is
  acceptable; only the *resolver* + `enabled` type machinery should be removed.

### 2. `RunResult.compilerDebugContext` is a never-read/never-written field — [T16] Collapse premature abstraction
- **Location:** `run/types.ts:137`
- **Mechanism repaired:** A result field that no producer sets and no consumer reads — dead structure on
  a public type. `run()` populates `runtimeCompile` (the real request/response), never
  `compilerDebugContext`; grep finds the symbol only at its own declaration.
- **Symptom that flagged it:** Optional field present on the type with zero assignments and zero reads
  across the repo (grep returns only `types.ts:137`).
- **Current → Suggested:** Remove the `compilerDebugContext?` field from `RunResult`. The live debug
  surface is `runtimeCompile.request/response`.
- **Direction:** remove
- **Preservation:** type/compiler-proof — removing a field never assigned cannot change any runtime
  value; only a consumer reading it would break, and none exists.
- **Falsifiable signal:** `grep -rn 'compilerDebugContext' --include='*.ts' | grep -v dist` returns only
  the declaration line; typecheck + tests stay green after removal.
- **Risk:** Low  ·  **API-impact:** public-surface (field on an exported type)  ·  **Effort:** S
- **Tests:** `run.test.ts` "RunResult exposes systemPromptMode…" pins the *other* fields; no test
  references `compilerDebugContext`.
- **Contraindication:** It is on an exported type; an external consumer could theoretically type against
  it. Risk is low because it is never populated (always `undefined`), but route through Expand/Contract
  to be safe rather than deleting in one shot.

### 3. Over-exported internal helpers in `compiler-debug.ts` — [T07] Align interface to actual usage
- **Location:** `run/compiler-debug.ts:19-59,114-139` (`harnessFamilyForHarness`,
  `harnessRuntimeForHarness`, `compileInteractionMode`, `buildCompilerDebugContext`)
- **Mechanism repaired:** Module exports wider than actual usage. These four are `export function` but
  are imported nowhere outside `compiler-debug.ts` and are NOT re-exported through the package barrel —
  they exist only to feed `maybeCompileForRun`. The public arrow of the module should be
  `maybeCompileForRun` + its arg/result types only.
- **Symptom that flagged it:** `export` keyword on functions whose only references are intra-file.
- **Current → Suggested:** Drop `export` from the three normalizers and `buildCompilerDebugContext`
  (keep them module-private), leaving `maybeCompileForRun` and the `*Args`/`*Result` interfaces exported.
- **Direction:** remove (narrow visibility)
- **Preservation:** type/compiler-proof — no external importer, no behavior change.
- **Falsifiable signal:** `grep -rn 'harnessFamilyForHarness\|buildCompilerDebugContext' --include='*.ts'
  | grep -v dist | grep -v compiler-debug.ts` returns nothing; build stays green after de-exporting.
- **Risk:** Low  ·  **API-impact:** internal-only (not in barrel)  ·  **Effort:** S
- **Tests:** none reference these directly; compile-time only.
- **Contraindication:** If a future test wants to unit-test `compileInteractionMode`'s `sdk`-transport
  branch in isolation, keep it exported. Currently no such test exists, so the narrow is safe.

### 4. `run()` is a ~315-line arrow-shaped pipeline with deep nesting in the install branch — [T22] Guard clauses / flatten + [T03] Relocate by affinity
- **Location:** `run.ts:138-454` (notably the `needsInstall` block `233-274` and the
  `buildContext` closure `343-389`)
- **Mechanism repaired:** Low cohesion + nesting in a single orchestrator. The install branch inlines
  two large option-literal builders (materializeFromRefs vs configInstall) with conditional-spread
  pyramids; the compiler `buildContext` closure inlines placement/correlation assembly. The prior
  refactor already extracted identity/system-prompt/util — this is the residual.
- **Symptom that flagged it:** Function length, `if (needsInstall) { if (effectiveCompose) {…} else {…}}`
  nesting, a 45-line inline closure assembling a structured object.
- **Current → Suggested:** Extract a `resolveInstallOutcome(...)` helper returning
  `materializedHarnessOutputPath` (mirrors how `space-launch.ts` already factors `executeSpaceRun`), and
  move the project-target `buildContext` body next to `space-launch.ts`'s equivalent (both build a
  `BuildCompilerDebugContextArgs`) — or into `placement-plan.ts`, which already owns placement assembly.
- **Direction:** relocate
- **Preservation:** test-suite — pure code-motion of an existing branch; `run.test.ts` exercises the
  planner/identity pieces but NOT `run()` end-to-end, so add a characterization test first.
- **Falsifiable signal:** `run()` shrinks below ~150 lines; byte-parity tests in `agent-spaces`
  (`run-compile-byte-parity.test.ts`) still pass (they assert the compiled launch shape unchanged).
- **Risk:** Med  ·  **API-impact:** internal-only (`run` signature unchanged)  ·  **Effort:** M
- **Tests:** `run-compile-byte-parity.test.ts` (sibling pkg) is the real guard; add a local
  characterization harness around `run()` install-selection before moving.
- **Contraindication:** The two install literals look similar but the `materializeFromRefs` and
  `configInstall` option bags are NOT the same field set — do NOT merge them into one parameterized
  literal (that would forward wrong props). Extract each branch as-is into a named helper; keep them
  distinct (coincidental similarity that legitimately diverges).

### 5. `resolveCodexRuntimeHomePath` is a 4-level nested path-selection ladder — [T22] Guard clauses / flatten
- **Location:** `run-codex.ts:148-189`
- **Mechanism repaired:** Nested `if (projectPath) { if (projectId && target) {…} if (target) {…} … if
  (inferred) {…} }` selecting among five home-path shapes (project+id, project+target, inferred-project,
  ad-hoc-cwd). The selection axis (which "mode" of home) is implicit in the nesting order.
- **Symptom that flagged it:** Arrow shape with early-return-able branches; a "first matching rule wins"
  ladder expressed as nesting rather than guard clauses.
- **Current → Suggested:** Flatten to sequential guard clauses, each returning the resolved path
  (already returns inside branches — just hoist the `aspHome` computation and remove the outer `if`
  wrapping). Optionally name the selection as a small discriminator first.
- **Direction:** isolate (flatten)
- **Preservation:** test-suite — `run.test.ts` `prepareCodexRuntimeHome` cases cover project, agent-
  project (`codexRuntimeTargetName`), and ad-hoc-cwd paths; behavior is pinned.
- **Falsifiable signal:** The three `prepareCodexRuntimeHome` tests (project / cody / ad-hoc) stay green;
  resolved paths byte-identical.
- **Risk:** Low  ·  **API-impact:** internal-only (function is module-private)  ·  **Effort:** S
- **Tests:** existing `run.test.ts` codex-home tests are sufficient.
- **Contraindication:** None — the branches are mutually exclusive and already return; flattening is
  mechanical.

### 6. Duplicated env-prefixed display-command assembly — [T15] Extract missing abstraction (small)
- **Location:** `run/execute.ts:222-223,235,248,273` — `envPrefix + formatCommand(...)` and
  `envPrefix + formatDisplayCommand(commandPath, args)` recur four times in one function.
- **Mechanism repaired:** A recurring intent ("the env-prefixed displayed command for *these* argv") is
  re-spelled at four sites; the `formatDisplayCommand` call is recomputed three times with identical
  args.
- **Symptom that flagged it:** Same `envPrefix + formatDisplayCommand(commandPath, args)` expression
  appears in the dry-run return, the displayPrompts call, and the live return.
- **Current → Suggested:** Compute `const displayCommand = envPrefix + formatDisplayCommand(commandPath,
  args)` once after `args`/`harnessEnv` are finalized and reuse it.
- **Direction:** isolate (hoist a local)
- **Preservation:** observational-equivalence — `formatDisplayCommand` is pure; hoisting the call cannot
  change output.
- **Falsifiable signal:** Returned `displayCommand` identical across dry-run and live paths (it already
  must be).
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** no direct test; covered by the function's own return-shape consumers in `run.ts`.
- **Contraindication:** None — purely a within-function CSE; do not over-extract into a separate module.

## 🪶 Deliberately left alone (where-NOT)
- **Module-load registry wiring** (`harness/index.ts:56-72`): constructing `harnessRegistry`/
  `sessionRegistry` and `setSessionRegistry(...)`/`register(...)` at import time is a deliberate startup
  seam, intentionally eager (with documented lazy exceptions for pi-sdk/codex session factories to avoid
  barrel imports). Introducing a substitution seam here would change startup timing — out of scope for a
  behavior-preserving pass.
- **`shellQuote`/`formatCommand`/`formatEnvPrefix` duplicated in `packages/cli/commands/install.ts`**:
  the CLI keeps its OWN private copies rather than importing from `run/util.ts`. This is cross-package
  duplication, not in-package; consolidating it touches a second package's import graph → not an
  execution-package refactor. (Noted for a future cross-package pass.)
- **Two near-identical install option literals in `run()`** (compose vs non-compose): they look like a
  dedup candidate but feed different functions with different field sets — merging risks prop-forwarding
  bugs. Extract-each-as-helper (Finding 4) yes; parameterize-into-one no.
- **`prepareAgentBrainRuntime` as a no-op** stays callable: its `agent-spaces` callers and `execute.ts`
  still invoke it as a documented compatibility hook. Only the dead *resolver* + `enabled` types are
  removal candidates (Finding 1).
- **`pi-session/index.ts` types-only re-export** and the "import directly to avoid barrel" comments: a
  deliberate startup-perf boundary, not a leaky API.
- **Magic numbers in `agent-tools.ts` / `run-codex.ts`** (`EXECUTABLE_MODE_BITS`, `SHEBANG_*`,
  `CODEX_RUNTIME_KEY_LENGTH`, `FRAME_WIDTH`, `LONG_ARG_THRESHOLD`): already named constants with
  explanatory comments — no extraction needed.
- **`RunCompileOutcome.diagnostics`**: looks unused locally but IS consumed in `agent-spaces`
  (`run-compile.ts`) — live, leave it.

## 🔭 If applying: outside-in sequence
1. Finding 2 (remove dead `compilerDebugContext` field) — smallest, public-type, Expand/Contract.
2. Finding 1 (collapse + deprecate brain resolver/types) — public-surface, Expand/Contract; pin no-op first.
3. Finding 3 (narrow `compiler-debug.ts` exports) — internal, compiler-proof.
4. Finding 6 (hoist `displayCommand` local in `execute.ts`) — internal, trivial.
5. Finding 5 (flatten `resolveCodexRuntimeHomePath`) — internal, pinned by existing tests.
6. Finding 4 (decompose `run()` install branch + relocate `buildContext`) — largest; add characterization
   test, lean on byte-parity suite.

## ✅ Safety checklist
- [ ] Characterization: pin `prepareAgentBrainRuntime` returns `{}` before collapsing the union.
- [ ] Characterization: harness around `run()` install-path selection before Finding 4 motion.
- [ ] Expand/Contract for Findings 1 & 2 (deprecate → release → remove) — both touch exported types.
- [ ] Confirm no spread/projection change in extracted install helpers (preserve exact field sets;
  do NOT merge the two install literals).
- [ ] Re-run sibling `run-compile-byte-parity.test.ts` after Finding 4 (asserts launch-shape parity).
- [ ] `bun test packages/execution` green after each internal-only change (Findings 3,5,6).
