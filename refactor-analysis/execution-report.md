# spaces-execution — SOLID / code-smell audit

Package: `packages/execution/` (npm `spaces-execution`)
Audited: every non-test source file under `src/` (index.ts, run.ts, run-codex.ts, pager.ts,
prompt-display.ts, and all of `run/*.ts`, plus the thin re-export barrels harness/agent-sdk/claude/pi-session).

## Overall assessment

This package was just put through a deliberate SOLID/code-smell pass (commit e238805,
"refactor(packages): SOLID/code-smell cleanup pass across all 17 packages (T-02028)"), and it
shows. The bulk of `run.ts` has already been decomposed into `run/identity.ts`,
`run/placement-plan.ts`, `run/execute.ts`, `run/compiler-debug.ts`, and `run/util.ts`. Named
constants, guard clauses, grouped result objects, and explicit "behavior-preserving consolidation"
comments are present throughout. Magic numbers in `agent-tools.ts`, `run-codex.ts`, and
`prompt-display.ts` are already lifted into named constants.

The remaining findings are minor. Most are intentionally deferred because they touch the
public-surface `run()` flow or are not strictly behavior-preserving. A small number of genuinely
safe, internal-only cleanups remain.

---

## W401 warning code is an inline magic string
- File: packages/execution/src/run.ts:404
- Risk: Low
- API-impact: internal-only
- Smell: The warning shape `{ code: 'W401', severity: 'warning', message }` is built inline with a
  bare `'W401'` literal and `'warning'` string. The code is a magic string with no named constant
  or comment explaining what W401 denotes.
- Proposed change: Introduce a module-local `const RUN_WARNING_CODE = 'W401'` and reference it when
  mapping `execution.warnings`. Pure rename of a literal to a named constant; the emitted value is
  unchanged.

## Synthetic snapshot-integrity placeholder repeats a magic 64-zero sha256
- File: packages/execution/src/run/space-launch.ts:225
- Risk: Low
- API-impact: internal-only
- Smell: `` `sha256:${'0'.repeat(64)}` `` is an inline magic literal for "no integrity known". The
  `64` (sha256 hex length) is unexplained, and the sibling `runLocalSpace` uses a *different*
  placeholder (`'sha256:dev'`, line 391) for the same "synthetic integrity" concept.
- Proposed change: Add a module-local named constant (e.g.
  `const PLACEHOLDER_SNAPSHOT_INTEGRITY = \`sha256:${'0'.repeat(64)}\` as \`sha256:${string}\``)
  and reference it at line 225. Behavior-preserving; produces the identical string. (Do NOT unify
  with `'sha256:dev'` — that is a deliberately distinct dev-mode marker.)

## Duplicated rename-then-copy-fallback migration block
- File: packages/execution/src/run.ts:111 (and packages/execution/src/run-codex.ts:142)
- Risk: Med
- API-impact: internal-only
- Smell: `migrateLegacyProjectHarnessOutput` (run.ts:111-118) and
  `migrateLegacyProjectCodexRuntimeHome` (run-codex.ts:142-150) both implement the same
  "mkdir parent; try rename; on failure rm+cp+rm" move-with-fallback dance. Two near-identical
  copies of a tricky fs primitive.
- Proposed change: Extract a private `moveDirWithCopyFallback(src, dest)` helper (likely into
  `run/util.ts`, internal/non-exported) and call it from both sites. Note the two copies differ
  slightly: run-codex.ts does an extra `rm(dest)` before the rename inside the try; run.ts does not.
  Reconcile carefully so behavior is preserved per-caller (or keep a `clearDestFirst` flag). Tagged
  Med because it spans two files and the pre-rename `rm` divergence must be handled exactly, not
  smoothed over.

## `run()` remains a ~290-line multi-stage orchestration function
- File: packages/execution/src/run.ts:140
- Risk: Med
- API-impact: public-surface
- Smell: `run()` (lines 140-432) is still long and does many jobs: env-flag/debug-log setup, manifest
  load, runtime planning, harness detection, legacy migration, install-decision + materialize/install
  branch (lines 201-247), lock read, identity resolution, system-prompt materialization, the inline
  `buildContext` compiler closure (lines 322-367), execution, and result assembly. The install-decision
  block and the `buildContext` closure are each cohesive enough to extract.
- Proposed change: Extract (a) the `needsInstall` decision + materialize/install branch into a private
  `ensureTargetInstalled(...)` helper, and (b) the inline `buildContext` closure into a private
  `buildProjectRunCompilerContext(...)`. Both internal/non-exported. DEFERRED: `run()` is the package's
  central exported entry point; even a behavior-preserving extraction reshapes the hottest code path and
  warrants a human eye on the debugLog ordering and the conditional-spread literals. Flagged
  public-surface because it is an exported function on the package's primary launch path.

## Near-duplicate result-object assembly between `run()` and `executeSpaceRun()`
- File: packages/execution/src/run.ts:400 (and packages/execution/src/run/space-launch.ts:157)
- Risk: High
- API-impact: public-surface
- Smell: Both build a `RunResult` (`build: {...}`, `invocation`, `exitCode`, `command`,
  `displayCommand`, `primingPrompt`, conditional `runtimeCompile`) from an `ExecuteHarnessResult`.
  The shapes overlap substantially though `run()` adds the budget/prompt fields and `launch`.
- Proposed change: Could factor a shared `toRunResult(execution, { lock, primingPrompt, compileOutcome, ... })`
  builder. DEFERRED: `RunResult` is an exported type and these are the two public run entry points; the
  field sets are not identical (budget fields, `launch`, warnings provenance differ), so a naive merge
  risks dropping or reordering fields on the public result. Needs a human to confirm field-for-field parity.

## `pathExists` is duplicated but the two copies are NOT behavior-identical
- File: packages/execution/src/run/agent-brain.ts:293
- Risk: Med
- API-impact: internal-only
- Smell: `agent-brain.ts` defines a private `pathExists` (293-303) that duplicates the exported
  `pathExists` in `run/util.ts:127`. Looks like a copy-paste candidate for dedupe.
- Proposed change: Do NOT mechanically dedupe. The two implementations differ in error semantics:
  `run/util.ts` swallows *all* errors and returns `false`; `agent-brain.ts` returns `false` only on
  `ENOENT` and *rethrows* other errors. Either keep both (and add a one-line comment on the
  agent-brain copy noting the intentional rethrow), or unify on the stricter ENOENT-only variant ONLY
  after auditing every `util.pathExists` caller for tolerance of a thrown non-ENOENT error. Tagged Med
  because "dedupe" here is a latent behavior change, not a safe rename.

## `runGlobalSpace` and `runLocalSpace` share temp-dir + compose-and-execute scaffolding
- File: packages/execution/src/run/space-launch.ts:273 (and :357)
- Risk: High
- API-impact: public-surface
- Smell: Both functions repeat: resolve aspHome/harness/adapter/detect, create tempDir + outputDir +
  artifactRoot, ensureDir x2, build a `ComposeTargetInput`, call `adapter.composeTarget`, then
  `executeSpaceRun`, with the same `try/catch { cleanupTempDir; throw }` wrapper.
- Proposed change: Could extract a shared `composeAndExecuteInTempDir(...)` wrapping the temp-dir
  lifecycle and the compose+execute+cleanup. DEFERRED: both are exported entry points, the
  `ComposeTargetInput` construction differs materially (global derives artifacts from a closure;
  local synthesizes a single-space input + synthetic lock), and the cleanup/try-catch boundary is
  load-bearing. Needs a human to ensure the error/cleanup semantics stay identical.

## Two parallel env-flag boolean parsers (informational, no change recommended)
- File: packages/execution/src/run/util.ts:53
- Risk: Low
- API-impact: internal-only
- Smell: `isEnvFlagEnabled` (accepts `'1'|'true'`) and `isEnvFlagDisabled` (accepts
  `'0'|'false'|'no'|'off'`) are two helpers with overlapping intent and asymmetric accepted
  vocabularies. The asymmetry is deliberate (one gate is default-off, one default-on).
- Proposed change: Optional only — document the asymmetry with a short comment if desired. No
  refactor recommended; listed for completeness so it isn't re-flagged later.

---

## Notes / non-findings

- `compiler-debug.ts`, `identity.ts`, and `util.ts` carry explicit "behavior-preserving
  consolidation" comments and already capture the previously-duplicated compiler-gate, identity, and
  options-mapping logic. No further dedupe warranted there.
- Magic numbers are already named in `agent-tools.ts` (`EXECUTABLE_MODE_BITS`, `SHEBANG_SNIFF_BYTES`,
  `SHEBANG_HASH/BANG`), `run-codex.ts` (`CODEX_RUNTIME_KEY_LENGTH`, `MANAGED_FILES`, `MANAGED_DIRS`),
  and `prompt-display.ts` (`FRAME_WIDTH`, `LONG_ARG_THRESHOLD`, `PROMPT_FLAGS`).
- `pager.ts` `process.exit(130)` on Ctrl-C and `\x03`/ANSI escapes are conventional terminal idioms,
  not magic-string smells.
- No dead code, unused exports, commented-out blocks, or unreachable branches were found.
- The barrel files (index.ts, harness/index.ts, agent-sdk, claude, pi-session) are pure re-export
  surfaces; their structure (type-only re-exports to dodge startup barrel imports) is intentional and
  documented.
