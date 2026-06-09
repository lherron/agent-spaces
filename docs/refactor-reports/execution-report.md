# 🔧 Refactoring Analysis

**Target:** `packages/execution/src`
**Lines analyzed:** ~2,940 (non-test source; 20 `.ts` files, of which 3 are `*.test.ts` excluded from SOLID scoring)
**Generated:** 2026-06-01  ·  **Focus:** all

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🔴 | `run()` (run.ts:104–434) is a 330-line orchestration God-function mixing install detection, prompt expansion, system-prompt materialization, compiler-debug assembly, and harness execution. `space-launch.ts` mixes lock persistence, closure materialization, and run execution. |
| Open/Closed | 🟡 | Harness-id branching is duplicated across `compiler-debug.ts` (3 `switch`/`if` chains keyed on harness id), `placement-plan.ts` (claude-vs-codex model defaulting), and `prepareRunOptions` (`adapter.id !== 'codex'`). New harnesses touch several call sites. |
| Liskov Substitution | 🟢 | No inheritance hierarchies, no `throw "not implemented"` overrides, no no-op base-dropping overrides. Adapter polymorphism is interface-based and uniform. |
| Interface Segregation | 🟡 | `RunOptions` (types.ts:34–65, 24 members) and `GlobalRunOptions` (types.ts:134–161, 27 members) are near-duplicate fat option bags; `HarnessRunOptions` is rebuilt field-by-field in two places. `RunResult` carries 8 prompt-budget fields most callers ignore. |
| Dependency Inversion | 🟡 | `run()` and `space-launch.ts` read `process.env['ASP_RUN_VIA_COMPILER']` / `ASP_DEBUG_RUN` directly; the harness registry is a module singleton. The `compileRuntime` seam is a good DIP example to extend. |

## 🎯 Priority Refactorings

### 1. Decompose the `run()` God-function — Single Responsibility
- **Location:** `run.ts:104-434`
- **Current:** One `async function run` does: debug-timer setup, manifest load, runtime planning, local-component detection, harness detection, codex migration, lock-diff + install decision, bundle load, prompt combination/template expansion, projectId/taskId derivation, system-prompt materialization (lines 263–290), compiler-debug context assembly (lines 310–369), `executeHarnessRun` invocation, and `RunResult` assembly. Six+ distinct responsibilities, ~7 mutable `let` budget variables threaded through.
- **Suggested:** Extract cohesive helpers, mirroring the existing `./run/*` split: `decideInstall(...)` (lines 157–203), `resolveRunIdentity(...)` → `{ agentId, projectId, taskId, expansionContext, effectivePrompt }` (lines 211–237), `materializeRunSystemPrompt(...)` → a single result object instead of 6 `let`s (lines 257–290), and `maybeCompileRun(...)` (lines 310–372). `run()` becomes a ~60-line pipeline.
- **Risk:** Med  ·  **Effort:** ~0.5–1 day  ·  **Tests:** `run.test.ts` (922 lines) covers this surface — run after each extraction; assert dry-run command/displayCommand parity.

### 2. Collapse duplicated compiler-debug assembly between project and space runs — DRY / OCP
- **Location:** `run.ts:310-369` and `run/space-launch.ts:109-146`
- **Current:** Both paths independently read the same `ASP_RUN_VIA_COMPILER` gate, compute `wantDebugDump`, build a `placement` object, call `buildCompilerDebugContext`, invoke `options.compileRuntime`, and derive `compiledLaunch`. `compiler-debug.ts` already consolidated the *context shape* but not the *gate + invoke + compiledLaunch* control flow, which remains copy-pasted.
- **Suggested:** Extract `maybeCompileForRun({ compileRuntime, dryRun, debug, buildPlacement, ...meta })` returning `{ compileOutcome?, compiledLaunch? }`. Both run modes call it with only their differing `placement`/`correlation` builders.
- **Risk:** Med  ·  **Effort:** ~3–4 hrs  ·  **Tests:** Dry-run+debug snapshot tests for both project and space runs; verify `runtimeCompile` request/response shape unchanged.

### 3. Unify the harness-id dispatch chains — Open/Closed
- **Location:** `run/compiler-debug.ts:18-55` (3 functions), `run/placement-plan.ts:140-146`, `run-codex.ts:279`
- **Current:** `harnessFamilyForHarness`, `harnessRuntimeForHarness`, and `compileInteractionMode` each switch on raw harness-id strings; `buildSyntheticRunManifest` special-cases `'claude' | 'claude-agent-sdk'`; `prepareRunOptions` early-returns unless `adapter.id === 'codex'`. Adding a harness means editing each of these independently.
- **Suggested:** Source `family`/`runtime` from the existing `getHarnessCatalogEntry(...)` (already imported in compiler-debug.ts:14) so the catalog is the single extension point, or attach a `runtimePreparer` capability to the adapter so codex's `prepareRunOptions` lives behind the adapter interface rather than an `id ===` check.
- **Risk:** Med  ·  **Effort:** ~0.5 day  ·  **Tests:** Per-harness dry-run matrix (`bun run smoke:matrix --config fake-codex`) plus `run.test.ts` harness-selection cases.

### 4. Extract a shared `buildCliRunOptions` to kill the duplicated `HarnessRunOptions` literal — DRY / ISP
- **Location:** `run.ts:238-256` and `run/space-launch.ts:84-102`
- **Current:** Two near-identical 18-field object literals map an options bag onto `HarnessRunOptions`, differing only in `projectPath`/`cwd` defaulting and the prompt/system-prompt fields. Any new run option must be added in both literals (and to both `RunOptions`/`GlobalRunOptions`).
- **Suggested:** A single `toHarnessRunOptions(options, { aspHome, projectPath, cwd })` helper in `run/util.ts`, plus a shared base interface (`BaseRunOptions`) that both `RunOptions` and `GlobalRunOptions` extend to stop the 24-vs-27-field divergence.
- **Risk:** Low  ·  **Effort:** ~3 hrs  ·  **Tests:** `run.test.ts`; add a space-run option-mapping unit test.

### 5. Split `runGlobalSpace` materialization from execution — Single Responsibility
- **Location:** `run/space-launch.ts:189-318`
- **Current:** `runGlobalSpace` (130 lines) resolves the ref, computes the closure, snapshots every space, generates+persists the global lock, creates temp dirs, then loops the closure doing harness-support checks, plugin-name/version resolution, snapshot-path resolution, manifest reshaping, and per-space `materializeSpace` — then composes and runs. Three responsibilities (lock/closure, per-space artifact materialization, execution) in one function with a manual try/cleanup.
- **Suggested:** Extract `materializeClosureArtifacts(closure, lock, { paths, harnessId, adapter, artifactRoot })` → `{ artifacts, settingsInputs, loadOrder }` (lines 229–286). `runLocalSpace` has a parallel single-space block that the same helper signature could subsume.
- **Risk:** Med  ·  **Effort:** ~4 hrs  ·  **Tests:** Global/local space run integration tests; verify lock merge (`persistGlobalLock`) behavior unchanged.

### 6. Replace direct `process.env` reads with an injected runtime config — Dependency Inversion
- **Location:** `run.ts:105,215,221,310-311`; `run/space-launch.ts:111-112`; `run/agent-brain.ts:402`; `run/agent-tools.ts:104`
- **Current:** Feature gates (`ASP_RUN_VIA_COMPILER`, `ASP_DEBUG_RUN`) and identity fallbacks (`ASP_PROJECT`, `ASP_TASK_ID`) are read inline from `process.env`, duplicating the `=== '1' || === 'true'` gate parse in two files and making the gate untestable without mutating global env.
- **Suggested:** A small `resolveRunEnvFlags(env = process.env)` helper returning `{ viaCompiler, debugRun }`, threaded as a parameter (default `process.env`).
- **Risk:** Low  ·  **Effort:** ~2 hrs  ·  **Tests:** Unit-test the flag parser; existing tests pass env explicitly.

### 7. Make the codex managed-home sync list data-driven — Open/Closed
- **Location:** `run-codex.ts:217-224`
- **Current:** `prepareCodexRuntimeHome` hand-lists 6 `syncManagedFile` calls and 2 `syncManagedDir` calls. Adding a managed file means another call line; the file/dir distinction is implicit in which helper is called.
- **Suggested:** Drive from `const MANAGED_FILES = [...] as const` and `const MANAGED_DIRS = [...] as const`, iterate. Self-documents the managed surface and centralizes future additions.
- **Risk:** Low  ·  **Effort:** ~1 hr  ·  **Tests:** Codex dry-run smoke (`smoke:matrix --config fake-codex`); assert runtime-home contents unchanged.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Long method — `run()` is 330 lines | `run.ts:104-434` | 🟠 |
| Long method — `runGlobalSpace()` is 130 lines | `run/space-launch.ts:189-318` | 🟠 |
| Long method — `prepareCodexRuntimeHome()` is 64 lines | `run-codex.ts:209-272` | 🟡 |
| Duplicated block — compiler gate + invoke + compiledLaunch | `run.ts:310-372` vs `space-launch.ts:109-149` | 🟠 |
| Duplicated block — `HarnessRunOptions` literal | `run.ts:238-256` vs `space-launch.ts:84-102` | 🟠 |
| Duplicated function — `shellQuote` defined twice | `prompt-display.ts:65` and `run/util.ts:6` | 🟡 |
| Duplicated function — `pathExists` defined 3× | `run.ts` (imported), `run/util.ts:50`, `run-codex.ts:32` | 🟡 |
| Mutable-state thread — 6 `let` budget vars | `run.ts:257-290` | 🟡 |
| Near-duplicate option bags (24 vs 27 fields) | `types.ts:34-65` / `types.ts:134-161` | 🟡 |
| Near-duplicate return shape (anonymous object type repeated) | `agent-profile.ts:119-130` vs `152-166` | 🟡 |
| Dead/no-op function — `resolveInteractive` just returns its arg | `run/util.ts:43-48` | 🟡 |
| Repeated gate-parse string literals `'1' || 'true'` | `run.ts:311`, `space-launch.ts:112` | 🟡 |
| Magic numbers — `200`, `0o111`, `4096`, `35/33`, `24`, `0x23` framing widths | `prompt-display.ts:16`, `agent-tools.ts:160,179,188`, `run-codex.ts:50` | 🟡 |
| Hardcoded reserved-name list (45 entries) embedded in logic file | `agent-tools.ts:22-64` | 🟡 |
| Swallowed errors (empty `catch {}`) — acceptable but unlogged | `space-launch.ts:43-46`, `util.ts:75-80`, `agent-brain.ts:210-214` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Hoist the single `shellQuote` from `run/util.ts` and import it into `prompt-display.ts` (delete the duplicate at prompt-display.ts:65–68). Identical implementations.
2. Consolidate the four `pathExists` copies into the one in `run/util.ts` (already imported by `run.ts`); `run-codex.ts` and `agent-brain.ts` should import it.
3. Replace the inline `ASP_RUN_VIA_COMPILER === '1' || === 'true'` in `run.ts:311` and `space-launch.ts:112` with a shared `isViaCompiler(env)` helper.
4. Extract `agent-profile.ts`'s repeated anonymous `{ yolo?, remoteControl?, model?, harness?, claude?, codex?, compose? }` return type into a named `AgentRunDefaults` interface used by both `resolveAgentRunDefaults` and `resolveAgentRunDefaultsFromProfile`.
5. Promote `MANAGED_FILES`/`MANAGED_DIRS` consts in `run-codex.ts` (smell #7) — pure data move, no behavior change.

## ⚠️ Technical Debt Notes

- **Dual execution paths (legacy vs compiler).** `execute.ts:116-157` branches on `compiledLaunch`, and both `run.ts`/`space-launch.ts` carry the `ASP_RUN_VIA_COMPILER` gate. This is intentional transitional debt (per the in-code comments) but it is now duplicated across three files; consolidating (finding #2) reduces the blast radius when the legacy path is finally retired.
- **`RunResult` prompt-budget fields** (`maxChars`, `promptSectionSizes`, `reminderSectionSizes`, `totalContextChars`, `nearMaxChars`, `reminderContent`) are populated only on the project-target path and left `undefined` for space runs. Consider a nested `budget?: PromptBudget` object (the `PromptBudget` type already exists in `prompt-display.ts:25`) to group them and signal optionality.
- **`buildSyntheticRunManifest`** (placement-plan.ts:130–163) constructs a fake `ProjectManifest` purely to feed `adapter.getDefaultRunOptions`. This works around the adapter interface only accepting a manifest; a future adapter method that accepts resolved defaults directly would remove the synthetic-shape coupling.
- **Test coverage is strong** for `run.ts` (run.test.ts, 922 lines) and `agent-tools.ts` (agent-tools.test.ts, 200 lines), which de-risks findings #1, #3, #4. No dedicated unit tests were observed for `space-launch.ts` or `run-codex.ts` source helpers — add characterization tests before refactoring #2/#5.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (run.test.ts strong; add space-launch / run-codex / agent-brain characterization tests first)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run `bun run test` + `bun run typecheck` between each
- [ ] Validate `asp run --dry-run` command/displayCommand byte-parity after every change (CLAUDE.md mandate)
- [ ] Run `bun run smoke:matrix --config fake-codex` after any harness-dispatch (#3) or codex-home (#7) change
- [ ] Run `bun run check:boundaries` and `bun run check:manifests` before committing
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

Fresh-eyes pass focused on error-handling, async/cleanup correctness, dry-run side effects,
concurrency, contract/API asymmetry, and test gaps. Items below are NOT in the first report.

### A1. Dry-run performs filesystem side effects via the agent-tool runtime — Correctness / CLAUDE.md "dry-run must not launch"
- **Location:** `run/execute.ts:150-154` (no `dryRun` guard) -> `run/agent-tools.ts:80-102` (`mkdir` of state/cache/log + `projects/<id>` dirs).
- **Issue:** The agent-tool runtime block has **no dry-run guard**. So `asp run --dry-run` for an agent that `hasTools` still creates `<agentVarDir>/state|cache|logs` and `state/projects/<projectId>`, and runs `validateAgentTools` (which can `throw` on a bad tool name / non-executable file). A dry-run is supposed to be inspection-only; it should not mutate the filesystem or fail on tool validation. CLAUDE.md explicitly mandates dry-run not have launch side effects.
- **Risk:** Med (silent FS writes + dry-run can now throw)  ·  **Effort:** ~1 hr (mirror the brain guard, or compute env from `components` without the `mkdir`s under dry-run)  ·  **Tests:** add a dry-run + `hasTools` case asserting no dirs are created and no throw on a tools dir; none exists today.

### A2. Non-interactive harness output is buffered to memory and withheld until process exit — Performance / UX
- **Location:** `run/execute.ts:51-91` (`executeHarnessCommand` accumulates `stdout`/`stderr` strings) and `:196-201` (writes them only after `close`).
- **Issue:** For non-interactive runs (`stdio: 'pipe'`) the child's entire stdout/stderr is concatenated into JS strings and only flushed to `process.stdout/stderr` after the child exits. Long/streaming non-interactive runs show nothing until completion, and unbounded output buffers grow without limit (memory pressure for chatty harnesses). `chunk.toString()` per data event also assumes chunk boundaries don't split multibyte UTF-8 sequences (use a `StringDecoder` or pipe through). The interactive path inherits stdio (fine); only the capture path has this.
- **Risk:** Low-Med  ·  **Effort:** ~2 hrs (pipe child stdout/stderr straight through while still capturing for `invocation`, or stream-write on each chunk)  ·  **Tests:** none cover `executeHarnessCommand`; add a fixture binary that emits over time.

### A3. `persistGlobalLock` is a lock-free read-modify-write — Concurrency (lost update)
- **Location:** `run/space-launch.ts:38-61`.
- **Issue:** `runGlobalSpace` reads the global lock, merges `spaces`/`targets`, and writes it back with no file lock or atomic rename. Two concurrent `asp run space:...` invocations (common for a global registry) interleave read→merge→write and silently drop one set of entries; the write is also non-atomic (`writeFile` can leave a truncated/partial lock if the process dies mid-write). The per-project install path uses config-layer locks; this global path does not.
- **Risk:** Med  ·  **Effort:** ~3 hrs (write to temp + `rename`; wrap in the same advisory lock the config layer uses)  ·  **Tests:** concurrency characterization test issuing two global runs; assert merged lock contains both targets.

### A4. `migrateLegacyProjectCodexRuntimeHome` fallback can lose the runtime on partial failure — Error handling / data loss
- **Location:** `run-codex.ts:154-162`.
- **Issue:** On `rename` failure the catch does `rm(runtimeHome, force) → cp(legacy → runtimeHome) → rm(legacy)`. If `cp` throws partway (disk full, EXDEV during copy, interrupt), the original `legacy` still exists but `runtimeHome` is now a partial copy, and a *re-run* sees `runtimeExists === true` (line 150) and returns the corrupt home, never retrying the migration — Codex auth/state is silently half-migrated. The pre-`rm(runtimeHome)` also destroys any concurrently-created runtime before the rename is even attempted.
- **Risk:** Med (rare but data-losing)  ·  **Effort:** ~2-3 hrs (copy to a temp sibling then atomic rename into place; only `rm(legacy)` after success)  ·  **Tests:** existing migrate test covers the happy `rename` path only; add an EXDEV/`cp`-failure simulation.

### A7. `paginate`/`waitForKey` hard-exits the process and mutates global stdin from a library — Leaky abstraction
- **Location:** `pager.ts:27-29` (`process.exit(130)` on Ctrl-C) and `:13-22` (`setRawMode` / `resume` / `pause` on the shared `process.stdin`).
- **Issue:** A reusable display utility (re-exported as public API, index.ts:96) calls `process.exit(130)` directly on Ctrl-C, so any host embedding `displayPrompts({ pagePrompts: true })` (e.g. `hrc launch exec`) is killed with no chance to clean up child processes / temp dirs. It also flips global `process.stdin` raw mode and resume/pause state; if the caller already manages stdin (an interactive harness), this races/corrupts that state. `wasRaw ?? false` silently coerces an undefined `isRaw` (non-TTY) to "cooked", which can leave the terminal in the wrong mode if `isTTY` flips. Prefer signalling quit/abort to the caller over `process.exit`.
- **Risk:** Med (for embedders)  ·  **Effort:** ~2 hrs  ·  **Tests:** none for pager; hard to test as-is precisely because of the global stdin coupling — another reason to inject the streams.

### A8. `RunOptions` vs `GlobalRunOptions` diverge in *capabilities*, not just field count — ISP / contract drift
- **Location:** `run/types.ts:34-65` vs `:134-161`.
- **Issue:** Beyond the 24-vs-27 field count the first report noted, the two bags differ structurally: `RunOptions extends ResolveOptions` (inheriting resolve-time knobs) while `GlobalRunOptions` is a flat standalone interface — so resolve-time options are silently *unavailable* on the space-run path. `RunOptions` exposes `projectId`/`taskId`/`refresh` (used for identity + reinstall) that `GlobalRunOptions` omits, while `GlobalRunOptions` adds `cleanup`/`registryPath` that `RunOptions` omits. There's no compiler enforcement that the shared fields stay in sync; a new option added to one path is silently missing from the other (this is the latent defect behind first-report finding #4's two literals). Extract a shared `BaseRunOptions` and have both extend it, then make the run-vs-global deltas explicit and small.
- **Risk:** Low  ·  **Effort:** ~2-3 hrs  ·  **Tests:** typecheck + the existing run/space tests.

### A9. `resolveInteractive` is a true no-op AND it is the only normalization seam — Dead code with a latent trap
- **Location:** `run/util.ts:43-48`, called at `run.ts:243`, `space-launch.ts:89`, `placement-plan.ts:241`.
- **Issue:** The first report flagged `resolveInteractive` as a no-op smell. The sharper point: it is *imported in four places as if it normalized something*, so a future maintainer "fixing" interactive defaulting will edit one call site by hand and miss the others — the intended single seam is dead. Either delete it everywhere (pass the value through) or give it the real default logic and route all four sites through it. Leaving a no-op that *looks* like a policy hook is worse than no hook.
- **Risk:** Low  ·  **Effort:** ~30 min  ·  **Tests:** existing.

### A10. `child.on('error', ...)` can settle after `close` in the spawn wrapper — Async correctness
- **Location:** `run/execute.ts:83-89`.
- **Issue:** The promise-wrapped spawn attaches `error` (reject) and `close` (resolve) but never `removeListener`/guard against double-settle. A late `error` event after `close` is harmless to the already-settled promise, but the wrapper should still use a settle-once guard for clarity.
- **Risk:** Low  ·  **Effort:** ~30 min  ·  **Tests:** add a fixture binary for the real spawn path.

## 📝 Additional Code Smells (second pass)

| Smell | Location | Severity |
|-------|----------|----------|
| Dry-run side effect — `mkdir` + `validateAgentTools` run under `--dry-run` | `execute.ts:150-154` → `agent-tools.ts:80-102` | 🟠 |
| Unbounded in-memory stdout/stderr buffering, no streaming | `execute.ts:68-89,196-201` | 🟠 |
| Lock-free / non-atomic global-lock RMW | `space-launch.ts:38-61` | 🟠 |
| Partial-failure data loss in legacy codex-home migration | `run-codex.ts:154-162` | 🟠 |
| `process.exit(130)` inside a reusable display lib | `pager.ts:28` | 🟠 |
| Global `process.stdin` raw-mode mutation from a library | `pager.ts:14-22` | 🟡 |
| `chunk.toString()` may split multibyte UTF-8 at chunk boundary | `execute.ts:73,79` | 🟡 |
| `RunOptions` extends `ResolveOptions`, `GlobalRunOptions` does not | `types.ts:34,134` | 🟡 |

## ⚠️ Additional Technical Debt Notes (second pass)

- **Test coverage is thinner than the first report implied for the *execution* path.** The two test files (`run.test.ts`, `agent-tools.test.ts`) cover planners, profile-defaulting, codex-home materialization, and `isSpaceReference`, but there are **no** tests exercising `executeHarnessCommand` (spawn/capture/streaming), `space-launch.ts` (`runGlobalSpace`/`runLocalSpace` closure + temp-dir cleanup + lock merge), or `pager.ts`. Findings A2–A7 all land in untested code; add characterization tests before touching them.
- **Pure-function helpers are buried in IO modules.** `sanitizeCodexRuntimeSegment`/`ensureCodexProjectTrust`/`isWithinPath` (run-codex.ts) are deterministic and trivially unit-testable, but live alongside spawn/fs side effects, so they're not covered.
- **`combinePrompts` ordering is an undocumented contract.** `run/util.ts:33-41` always concatenates `priming\n\nuser`; multiple call sites depend on this order but nothing asserts it. A one-line doc-comment + a unit test would lock the contract before any refactor reorders the bags.
