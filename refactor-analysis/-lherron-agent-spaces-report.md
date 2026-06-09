# Refactor Analysis — `@lherron/agent-spaces` (packages/cli)

packageType: **general** (a Commander-based CLI; thin arg-parse + presentation layer over `spaces-config` / `spaces-execution` / `spaces-runtime`; almost no shared mutable state, no perf-critical paths).

## Summary

This package was already through two SOLID/code-smell passes (T-02028, T-02030) the day
before. It shows: the high-value shared seams already exist and are documented with WHY
comments — `helpers.ts` (project context, error normalization, doctor formatting, byte
formatting), `settings-helper.ts` (inherit-flags → settingSources), `scope-target-resolver.ts`
(scope-handle parsing), `harness-validator.ts` (harness validation + `DEFAULT_HARNESS_ID`),
`self/lib.ts` (self-context resolution), and `self/memory/lib.ts` (memory command scaffold).
The per-command files are small, single-responsibility, and consistently structured
(register → action → small named helpers → format functions).

The low-hanging fruit is gone. I found **2 genuine, narrow findings** (both Low-risk,
internal-only, auto-applicable) and a set of deliberately-left-alone items where the
apparent duplication is load-bearing-different or where extraction would not pay for itself.

No public-surface or High-risk findings. The public boundary is clean.

## Public boundary verdict

The package's public API (`exports["."]` → `src/index.ts`) is intentionally tiny:
- `main()` — CLI entry, drives Commander.
- `findProjectRoot()` — re-exported from `lib.ts`; thin delegate to `spaces-config.findProjectMarker`.

The many subpath exports in `package.json` (`./core`, `./resolver`, `./store`, `./engine`,
`./claude`, …) resolve to root-level `*.js` shim files (e.g. `core.js`), NOT to anything in
`src/`. They re-export bundled deps and are out of scope for src refactoring. Nothing in
`src/` should change their shape.

Verdict: **boundary is correctly minimal; no expand/contract or interface-narrowing needed.**
The `commands/**` files export only `registerXCommand(program)` functions consumed solely by
`command-registry.ts` — an internal registration list, not an external contract. `self/lib.ts`
and `self/memory/lib.ts` export a broader API surface, but it is internal-to-package (consumed
by sibling subcommands) and already well-factored.

## Findings by mechanism

### Finding 1 — [T15] Extract the duplicated `RunResult` → `displayPrompts` projection
- **Location:** `packages/cli/src/commands/run.ts:396-410` and `packages/cli/src/commands/gui.ts:96-111`
- **Mechanism:** T15 (extract missing abstraction — duplicated intent).
- **Direction:** EXTRACT. Both the `run` and `gui` commands, in their dry-run branch, build a
  byte-identical 11-field argument object from a `RunResult` and pass it to `displayPrompts`:
  `{ systemPrompt, systemPromptMode, reminderContent, primingPrompt, promptSectionSizes,
  reminderSectionSizes, totalContextChars, maxChars, nearMaxChars,
  command: result.displayCommand ?? result.command, showCommand: true, pagePrompts }`.
  Confirmed byte-identical via diff (only the leading `await displayPrompts({` differs by
  indentation). Extract a single helper, e.g.
  `displayRunResultPrompts(result: RunResult, pagePrompts: boolean | undefined): Promise<void>`,
  most naturally placed in `prompt-display.ts` (the existing re-export shim for the renderer) or
  a small new helper next to it. Both call sites collapse to one line.
- **Preservation:** Pure mechanical extraction of an identical literal; the field set is
  preserved EXACTLY (explicit projection, not a spread — no excess-property risk). `displayPrompts`
  is called with the same values, in the same order, under the same `if (options.dryRun)` guard.
  Observable output (the dry-run prompt/command dump) is unchanged.
- **Risk:** Low. **apiImpact:** internal-only.
- **Tests:** Covered indirectly by `__tests__/run-compiler-debug.test.ts` and
  `run-model-reasoning-effort.test.ts` (dry-run paths). No test assertions reference the literal
  shape, so no test updates required; run the existing CLI test suite to confirm.
- **Churn:** One new exported helper; two call sites migrated. No new lint findings (no
  parameterized-literal trick involved). `gui.ts` would drop its now-unneeded inline block.
- **Contraindication checked:** The two copies do NOT diverge (verified). The shared renderer
  already lives in `spaces-execution`; this only dedups the CLI-side argument assembly. Not
  load-bearing duplication.

### Finding 2 — [T15] Hoist the byte-identical `loadDistTags` (full-registry variant)
- **Location:** `packages/cli/src/commands/repo/status.ts:59-67` and
  `packages/cli/src/commands/spaces/list.ts:40-48`
- **Mechanism:** T15 (extract missing abstraction — duplicated intent).
- **Direction:** EXTRACT. These two `loadDistTags(repoPath): Promise<Record<string, Record<string,
  string>>>` functions are byte-identical (read `${repoPath}/registry/dist-tags.json`, JSON.parse,
  return `{}` on any failure). Hoist a single `loadAllDistTags(repoPath)` — a natural home is a
  small `commands/repo/registry-fs.ts` (or extend an existing shared helper), since both the repo
  and spaces command families read the same registry layout.
- **Preservation:** Identical body; same swallow-to-`{}` behavior on missing/corrupt file. No
  observable change.
- **Risk:** Low. **apiImpact:** internal-only.
- **Tests:** Exercised by registry-listing CLI tests; behavior identical, no assertion changes.
- **Churn:** One new tiny module/export; two imports added; two local copies removed.
- **Contraindication checked:** `repo/tags.ts:63` ALSO has a `loadDistTags`, but with a DIFFERENT
  signature/semantics — `loadDistTags(repoPath, spaceId): Promise<Record<string, string>>` returns
  the per-space sub-map (`allDistTags[spaceId] ?? {}`). That third variant is intentionally
  different (single-space projection) and MUST NOT be folded into the same function. Dedup only the
  two full-registry-map copies; leave the tags.ts per-space loader alone. (A nicer shape is to have
  the per-space loader call the shared full-map loader and index it, but that is optional polish, not
  required for the dedup.)

## Deliberately left alone (contraindications honored)

1. **`inferTargetFromBundleRoot` duplication — DO NOT dedup (diverging copies).**
   `self/lib.ts:164` and `resolve-reminder.ts:111` both define a function of this name, but they
   are NOT identical. `resolve-reminder.ts` additionally requires a non-empty trailing path segment
   (`harnessName = bundleRoot.split('/').pop()`) before it will return a target; `self/lib.ts` does
   not, and returns `string | null` vs `string | undefined`. Confirmed via diff. Folding them into
   one helper would silently change one caller's behavior — that is a redesign, not a refactor.
   Left as-is. (If a future task WANTS them unified, that is a behavior-change decision requiring
   its own characterization tests, not an auto-apply.)

2. **`.git/HEAD` existence check repeated in 6 files — load-bearing-different control flow.**
   (`repo/status.ts`, `spaces/list.ts`, `repo/publish.ts`, `repo/tags.ts`, `repo/init.ts`,
   `spaces/init.ts`.) Each call site does something different with the result: status prints an
   error block + `process.exit(1)`; list returns a boolean to the caller; publish/tags throw an
   `Error` ("No registry found. Run …"); init treats "exists" as a SUCCESS early-return ("Registry
   already exists"); spaces/init treats "missing" as an error. The shared part is a one-liner
   (`Bun.file(...).exists()`); the divergent part is the policy. Extracting a `registryExists(repoPath)`
   predicate would save one `Bun.file(...)` expression per site but would NOT collapse the divergent
   reactions, and a "throw if missing" helper would only fit 2 of the 6 sites. The duplication here is
   a thin filesystem probe with per-command policy attached — extraction has near-zero leverage and
   risks homogenizing intentionally different UX. Left alone. (Optional, very-low-value: a pure
   `registryExists(repoPath): Promise<boolean>` predicate; not worth the churn.)

3. **`ensureRegistryExists` — three intentionally different implementations.** `repo/status.ts`
   uses the `.git/HEAD` check + exit; `repo/publish.ts` uses `.git/HEAD` + throw; `repo/gc.ts` uses
   `stat(repoPath)` + throw (a weaker "directory exists" check, deliberately — gc operates on the
   repo dir itself). Same name, different contracts and different probes. Not duplication to merge.

4. **`manager-space-content.ts` (1425 LOC, the largest file).** Pure embedded markdown/TOML string
   constants returned by `getManagerSpaceFiles()`. No logic, no branching, no smell. The size is
   inherent to bundling the manager space into the CLI. Not refactorable without changing the
   packaging strategy (out of scope, and a product decision).

5. **`command-registry.ts` `COMMAND_REGISTRARS` array + loop.** This is the correct dispatch shape
   already (the prior pass introduced it). No conditional-to-dispatch or inline-back opportunity.

6. **The `RunMode` / `ExecuteMode` string-union + switch in `run.ts` and `agent/index.ts`.** These
   are bounded, total switches over a small closed union (`'project' | 'global' | 'dev' | 'invalid'`
   and the agent modes), each arm doing genuinely different work. They are total (no "can't happen"
   default arm to make unrepresentable), and the union is not growing one-arm-per-feature. No T19/T17
   action.

7. **`self/explain.ts` and `self/prompt.ts` finding/section builders.** Long but flat, each branch
   emits a distinct human-facing diagnostic string. The shared mechanics (template discovery, section
   analysis) are ALREADY hoisted into `self/lib.ts` (`resolveSelfTemplateContext`,
   `analyzeTemplateSections`, `classifyTemplateSource`, `readOptionalFile`). What remains is
   command-specific copy. No further extraction warranted.

8. **`ui.ts` `wrapCommandWithContinuation`.** Self-contained, one consumer (`commandBlock`), already
   carries its biome-ignore for the regex-exec loop. No nesting/guard-clause issue worth touching.

## Outside-in apply sequence

1. (Make-safe) The dry-run prompt-dump and registry-listing paths are already covered by the
   existing CLI tests (`run-compiler-debug.test.ts`, `run-model-reasoning-effort.test.ts`, and the
   repo/spaces listing tests). No new characterization tests needed for these two narrow,
   provably-identical extractions — but run `bun test` in `packages/cli` before and after.
2. Apply **Finding 1** (extract `displayRunResultPrompts`) — touches `run.ts`, `gui.ts`,
   `prompt-display.ts`. Lowest-risk, highest-clarity.
3. Apply **Finding 2** (hoist full-map `loadDistTags`) — touches `repo/status.ts`,
   `spaces/list.ts`, and adds one shared helper. Leave `repo/tags.ts`'s per-space loader untouched.
4. Re-run `bun test` and `biome check .` in `packages/cli`. No biome-ignore additions are expected
   from either finding (neither parameterizes a `typeof` literal nor spreads an object).

Net: **2 auto-applicable findings (Low / internal-only), 0 deferred.**
