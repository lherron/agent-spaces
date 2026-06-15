# 🔧 Refactoring Analysis — @lherron/agent-spaces (CLI)

**Target:** packages/cli/src  ·  **Files read:** 56 source (non-test)  ·  **Lines:** ~6,000 (9,651 incl. tests)
**Generated:** 2026-06-14  ·  **Package type:** leaf (thin Commander argument-parsing layer delegating to engine/spaces-* packages)

## 🧭 Summary
The CLI is a well-decomposed Commander tree: one `register*Command` per file, centralized via `command-registry.ts`, with prior refactor passes already having hoisted the high-frequency duplications (`resolvePaths`, `getProjectContext`, `validateHarness`, `buildCommonRunOptions`, `buildSettingSources`, the memory `withMemory*` scaffolds). The remaining findings are second-order: a registry-existence invariant re-implemented 7 ways across the `repo`/`spaces` families, an error-handling protocol split (some commands route through `exitWithAspError`, others hand-roll `console.error(chalk.red)`+`process.exit(1)`), and a few genuinely duplicated helpers (`inferTargetFromBundleRoot`, per-space dist-tags read). The public boundary is narrow and sound.

## 🚪 Public boundary (assess first)
- **API surface (src):** `index.ts` exports `main()` and re-exports `findProjectRoot`. Everything else is reached through `bin/asp.js` → `main()`. The package.json `exports` map (`./core`, `./resolver`, `./store`, …) points at prepack-generated `.js` shims that re-export the bundled `spaces-*` deps — they are **not** authored under `src/` and are out of scope for source refactoring here.
- **Findings:** No T07/M02 issues. `main()` and `findProjectRoot()` are minimal and match their callers. The deep import surface is the per-command `register*` functions, all consumed only by `command-registry.ts` (internal).
- **Verdict:** 🟢 sound — the observable surface is `asp <cmd>` CLI behavior (stdout/stderr/exit codes), not a TS API. Refactors below must preserve that observable contract; they do not touch `index.ts`.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. Registry-existence invariant re-implemented 7 ways — [T15] Extract missing abstraction + [T18] Restructure error handling
- **Location:** `commands/repo/status.ts:34`, `commands/repo/gc.ts:32`, `commands/repo/publish.ts:33`, `commands/repo/tags.ts:121`, `commands/repo/init.ts:136`, `commands/repo/new-space.ts:42`, `commands/spaces/init.ts:45`, `commands/spaces/list.ts:33`
- **Mechanism repaired:** one domain invariant ("the registry is an initialized git repo, detected by `.git/HEAD`") has no single name; each call site re-encodes the path string `${repo}/.git/HEAD` AND independently chooses its failure protocol. Four files define a private `ensureRegistryExists` with three *different* contracts: `status.ts`/`gc.ts` throw-or-`process.exit`, `publish.ts` throws `Error`, `list.ts` returns `boolean`. The concept should be named once (e.g. `registryExists(repoPath)` predicate in `repo/registry-fs.ts`, alongside the existing `loadAllDistTags`).
- **Symptom that flagged it:** 7 copies of the `.git/HEAD` literal; 4 same-named functions with divergent return types/side-effects.
- **Current → Suggested:** add `export async function registryExists(repoPath: string): Promise<boolean>` to `registry-fs.ts`; have each site call it and keep its own message/exit so observable output is byte-identical. Do NOT unify the *messages* (they differ deliberately: "Registry not initialized" vs "No registry found" vs "No registry found. Run …").
- **Direction:** relocate (the predicate) — keep per-site error text where it is.
- **Preservation:** test-suite — exit codes and stderr text unchanged per site; only the existence check is factored. `repo/__tests__/new-space.test.ts` + `commands/self/__tests__` exercise these paths.
- **Falsifiable signal:** snapshot each command's stderr+exit on a missing registry before/after; must match exactly.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** existing repo/new-space test; add a characterization test asserting stderr text per command on missing `.git/HEAD`.
- **Contraindication:** do NOT also unify the divergent error *messages* or the throw-vs-exit choice into the helper — that would change observable output and is a redesign, not a refactor. Factor only the boolean detection.

### 2. `inferTargetFromBundleRoot` duplicated across two modules — [T15] Extract missing abstraction
- **Location:** `commands/self/lib.ts:164` and `commands/resolve-reminder.ts:111`
- **Mechanism repaired:** the bundle-layout→target-slug derivation (walk up from `ASP_PLUGIN_ROOT`/bundle root, take the directory two levels up) is one concept implemented twice with subtly different return contracts (`self/lib.ts` returns `string | null`; `resolve-reminder.ts` returns `string | undefined` and also has the related `inferTargetFromClaudePluginRoot`/`inferTargetFromCodexHome` siblings). The shared core ("target name from a bundle root path") should live once.
- **Symptom that flagged it:** two functions of the same name + near-identical bodies; one is even imported from `spaces-config` in `agent/index.ts` (`buildRuntimeBundleRef`), suggesting the canonical home may be a shared package.
- **Current → Suggested:** extract the path-walk into one helper (candidate home: `self/lib.ts`, or better, push down to `spaces-config` since `resolve-reminder` and `agent` already import bundle helpers from there). `resolve-reminder.ts` adapts the `null`↔`undefined` at its boundary.
- **Direction:** relocate / isolate.
- **Preservation:** type/compiler-proof for the extraction; the `null`/`undefined` normalization is the only behavioral seam and is mechanical.
- **Falsifiable signal:** unit-test both bundle-root shapes (`.../bundles/<target>/<harness>` and the codex-home variant) return the same slug pre/post.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** `context-template-cli.test.ts` covers resolve-reminder; add a direct unit test for the extracted helper.
- **Contraindication:** confirm the two copies have NOT already diverged in intent (self/lib uses `ASP_PLUGIN_ROOT` directly; resolve-reminder layers Claude/codex env probes on top). Extract only the shared innermost walk, not the env-probe wrappers.

### 3. Per-space dist-tags read bypasses the shared loader — [T23] Remove middle man / collapse pass-through
- **Location:** `commands/repo/tags.ts:63` (`loadDistTags`) vs `commands/repo/registry-fs.ts:15` (`loadAllDistTags`)
- **Mechanism repaired:** `registry-fs.ts` was created specifically to be the single reader of `registry/dist-tags.json` (status.ts and spaces/list.ts use it). `tags.ts` still re-reads and re-parses the same file inline, then indexes `allDistTags[spaceId]`. That is exactly `loadAllDistTags(repo)[spaceId] ?? {}`.
- **Symptom that flagged it:** a second `dist-tags.json` read+`JSON.parse`+`catch→{}` that duplicates the hoisted helper's body.
- **Current → Suggested:** `tags.ts` calls `loadAllDistTags(paths.repo)` and reads `[spaceId] ?? {}`.
- **Direction:** remove (the inline copy).
- **Preservation:** observational-equivalence — both swallow read/parse errors to `{}`; result is identical.
- **Falsifiable signal:** `asp repo tags <id>` output identical with present/absent/corrupt dist-tags.json.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** XS
- **Tests:** add a tags-command characterization test (none currently isolates it).
- **Contraindication:** none — this is the intended consumer of the existing seam.

### 4. Two-protocol error handling fragments the CLI error contract — [T18] Restructure error handling
- **Location:** `exitWithAspError` users (`build.ts`, `remove.ts`, `describe.ts`, `lint.ts`, `list.ts`, `diff.ts`, `upgrade.ts`, repo/*, spaces/*) **vs** hand-rolled `console.error(chalk.red(...))`+`process.exit(1)` users (`add.ts:95`, `explain.ts:62`, `gc.ts:68`, `harnesses.ts:144`, plus `printNoProjectError()` in `add.ts`/`explain.ts`)
- **Mechanism repaired:** there are two competing "report-and-exit" protocols. `helpers.ts` already centralizes the blessed one (`exitWithAspError` → cli-kit, with `--json` awareness and `ProjectNotFoundError` normalization) and even provides `printNoProjectError()` as the chalk-bridge. The four hold-out commands skip it, so their errors are NOT `--json`-aware and don't get AspError cause-flattening (`formatAspErrorCause`).
- **Symptom that flagged it:** `error instanceof Error ? error.message : String(error)` was already extracted as `errorMessage()`, yet the same commands wrap it in their own `console.error(chalk.red(...))`+`exit(1)` instead of `exitWithAspError`.
- **Current → Suggested:** migrate the hold-outs to `exitWithAspError(error, options)`. NOTE: this is a **behavior change** for `add`/`explain`/`gc`/`harnesses` — error text routes through cli-kit's `binName: 'asp'` formatter and gains `--json` support (harnesses/gc/explain have no `--json` today, so observable change there is the cli-kit prefix/format only). Treat as redesign → Expand/Contract, not auto-apply.
- **Direction:** relocate (onto the shared protocol).
- **Preservation:** char-test — must snapshot current stderr/exit for each hold-out and decide per-command whether the new format is acceptable; routes through M02 because output text is observable (Hyrum's Law: scripts may grep these messages).
- **Falsifiable signal:** diff stderr of `asp add`/`asp explain`/`asp gc`/`asp harnesses` failure paths before/after.
- **Risk:** Med  ·  **API-impact:** public-surface (CLI stderr contract)  ·  **Effort:** M
- **Tests:** characterize each hold-out's error output first; needs human sign-off on the format change.
- **Contraindication:** `install.ts` deliberately keeps its own ui.ts-based error block (documented in `harness-validator.ts`); do NOT fold install into the chalk/cli-kit path. The chalk hold-outs may likewise be intentional — verify before migrating.

### 5. `LintWarning` re-declared locally, shadowing the canonical type — [T15]/[T12] name the concept once
- **Location:** `commands/lint.ts:22` (local `interface LintWarning`) vs the imported `LintWarning` from `spaces-config` used in `describe.ts:14`
- **Mechanism repaired:** the lint command defines its own structurally-similar `LintWarning` (adds `target`, makes `severity: string`) instead of extending/importing the canonical one. Two types named identically for the same concept invite drift (e.g. `severity: string` here vs a narrower union upstream).
- **Symptom that flagged it:** same type name, same domain, two definitions; the local one is hand-mapped field-by-field from `explanation.warnings` at `lint.ts:80`.
- **Current → Suggested:** import the canonical `LintWarning` and define the CLI-local shape as a derived type (`type ProjectLintWarning = LintWarning & { target: string }`) or alias to avoid name collision.
- **Direction:** isolate (reuse the canonical type).
- **Preservation:** type/compiler-proof — the field-by-field map at `:80` already produces the same runtime shape; only the type annotation changes.
- **Falsifiable signal:** `tsc --noEmit` green; `asp lint --json` output unchanged.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Contraindication:** if the upstream `LintWarning.severity` is a strict union that the CLI deliberately widens to `string` for the `'info'` synthetic W101 lock warning, keep a distinct CLI type but rename it (`LintRow`) so the shadow is intentional and visible.

### 6. `HUMAN_LABELS` memory-target table duplicated — [T15] Extract missing abstraction
- **Location:** `commands/self/memory/inspect.ts:18` and `commands/self/memory/paths-cmd.ts:18`
- **Mechanism repaired:** the memory-target → (scope, zone) label mapping is hard-coded twice with the same three rows (`memory`/`user`/`persona`), once as `{scope, zone}` objects and once as `'scope, zone'` strings. The label taxonomy is one concept.
- **Symptom that flagged it:** two `HUMAN_LABELS: Record<MemoryTargetName, …>` constants with the same data, different serialization.
- **Current → Suggested:** define one `MEMORY_TARGET_LABELS` in `memory/lib.ts`; each renderer formats it (object access vs `${scope}, ${zone}`).
- **Direction:** relocate (into the shared memory lib).
- **Preservation:** observational-equivalence — rendered strings unchanged.
- **Falsifiable signal:** `asp self memory inspect` and `… paths` text output identical pre/post.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** XS
- **Tests:** `self/memory/__tests__/cli.test.ts`.
- **Contraindication:** `paths-cmd.ts:61-64` ALSO prints a hard-coded plaintext label block "for NO_COLOR mode"; that is a separate literal-for-test-visibility and may be deliberately independent — leave it unless the test asserts a single source.

### 7. `gui.ts` rebuilds the run-options object instead of reusing `buildCommonRunOptions` — [T15] Extract missing abstraction
- **Location:** `commands/gui.ts:46-63` vs `commands/run.ts:80` (`buildCommonRunOptions`)
- **Mechanism repaired:** `run.ts` already extracted the ~20-field run-options shape into `buildCommonRunOptions(options)` precisely because the mode literals drifted. `gui.ts` hand-builds a near-identical object (same `aspHome`/`registryPath`/`refresh`/`settingSources`/`settings`/`inheritProject`/`inheritUser`/`pagePrompts`/`compileRuntime` fields) plus gui-specific (`harness:'codex'`, `launchSurface`, `interactive:true`). This is a missed reuse of an already-named abstraction.
- **Symptom that flagged it:** the same field-spread pattern the run.ts WHY-comment warns against, re-appearing in gui.ts.
- **Current → Suggested:** export `buildCommonRunOptions` from a shared module (e.g. `settings-helper.ts` or a new `run-options.ts`) and have `gui.ts` spread it, overriding only its gui-specific keys. **Caution:** `gui.ts`'s `GuiOptions` is a SUBSET of `RunOptions` (no `extraArgs`/`yolo`/`debug`/`model`/`resume`/etc.), so spreading the full common builder would forward `undefined` for fields gui never had — verify `run()` treats absent vs `undefined` identically before applying (the `{...common, ...guiSpecific}` must not introduce new keys with `undefined` that change `run()` behavior).
- **Direction:** relocate (share the builder).
- **Preservation:** test-suite — must confirm the extra forwarded `undefined` keys are inert in `runGui`'s `run()` call; this is the spread/projection hazard called out in the brief.
- **Falsifiable signal:** `asp gui <agent> --dry-run --print-command` output identical pre/post; assert the compiled spec is unchanged.
- **Risk:** Med  ·  **API-impact:** internal-only (but feeds the spaces-execution `run()` contract)  ·  **Effort:** M
- **Tests:** no dedicated gui test exists; add a `--dry-run` characterization first.
- **Contraindication:** if `run()` distinguishes "key absent" from "key=undefined" (e.g. via `'k' in opts`), do NOT spread — the field sets must stay exactly as today. Verify before extracting.

## 🪶 Deliberately left alone (where-NOT)
- **`helpers.ts` `getStatusIcon`/`getStatusColor` two parallel switches** — they return different types (string vs function) for the same enum; collapsing into one config object is churn with no invariant repaired. The `default`-less exhaustive switches are already T17-total.
- **`ui.ts` color/symbol palette** — single-purpose presentation constants; the `wrapCommandWithContinuation` regex loop carries a correct scoped `biome-ignore`. No premature abstraction.
- **`command-registry.ts` `COMMAND_REGISTRARS` array** — clean dispatch table; do not "abstract" further.
- **Memory `withMemoryCommand`/`withMemoryContext`/`withMemoryStore` ladder** — already the correct seam extraction; the three variants reflect three real needs (no ctx / ctx / ctx+store), not premature generality.
- **`run.ts` `RunMode` switch + `detectRunMode`** — a genuine, documented priority dispatch with reachable arms; `'invalid'` is handled (T17-total). Leave as dispatch.
- **`resolve-reminder.ts` `inferTargetFromClaudePluginRoot`/`inferTargetFromCodexHome` wrappers** — env-probe-specific; only the innermost walk overlaps with finding #2. Keep the wrappers local.
- **Per-command error *messages*** — divergent registry/project error text is load-bearing (different commands guide users differently); do not unify (see #1 contraindication).
- **`spaces/list.ts ensureRegistryExists` returning `boolean`** — its return-a-flag contract is the right shape for its call site; only the `.git/HEAD` literal (finding #1) should be shared, not the wrapper.

## 🔭 If applying: outside-in sequence
1. **#3** (dist-tags pass-through) — XS, zero-risk, pure reuse of an existing seam.
2. **#1** (registry-exists predicate) — add `registryExists()` to `registry-fs.ts`, swap the 7 literals, keep all per-site messages/exits. Char-test stderr per command first.
3. **#6** (memory labels) + **#2** (inferTargetFromBundleRoot) — local extractions, compiler-proof.
4. **#5** (LintWarning type) — type-only, `tsc` gate.
5. **#7** (gui run-options) — only after verifying the spread/projection field-set is inert; characterize `asp gui --dry-run` first.
6. **#4** (error-protocol unification) — DEFER to Expand/Contract; needs human sign-off because it alters observable stderr/JSON for `add`/`explain`/`gc`/`harnesses`.

## ✅ Safety checklist
- [ ] No edits to `index.ts` / public `main`/`findProjectRoot` surface.
- [ ] Registry-exists factor keeps each command's exact stderr text and exit code (snapshot before/after).
- [ ] dist-tags swap preserves the `catch→{}` swallow semantics.
- [ ] `inferTargetFromBundleRoot` extraction normalizes `null`/`undefined` at the resolve-reminder boundary only.
- [ ] gui run-options reuse verified NOT to add new `undefined` keys that change `run()` (spread/projection hazard).
- [ ] Error-protocol unification (#4) routed through Expand/Contract with human review — NOT auto-applied.
- [ ] `tsc --noEmit` + `bun test` + `biome check` green; no new lint findings from any literal-parameterization.
