# SOLID / code-smell audit — `packages/cli/` (`@lherron/agent-spaces`)

Audited every non-test source file under `packages/cli/src/`. The package was
recently put through a SOLID/code-smell cleanup pass (commit e238805), so the
bulk of it is already in good shape: long handlers are split into named private
helpers, the run-option literals are spread from a single `buildCommonRunOptions`,
harness validation / setting-source / scope-target resolution are centralized,
and the memory subcommands share a `withMemoryStore`/`withMemoryCommand` scaffold.

The findings below are the residual smells — mostly cross-file duplication that
the cleanup pass did not consolidate, plus a handful of magic numbers/strings and
dead local aliases. None are structural. The single largest file
(`commands/repo/manager-space-content.ts`, 1425 lines) is entirely embedded
markdown/TOML content strings with one trivial accessor — no logic to refactor.

---

## Duplicated `formatBytes` helper across two gc commands
- File: packages/cli/src/commands/gc.ts:80
- Risk: Low
- API-impact: internal-only
- Smell: `formatBytes` (the `units`/`1024` loop) is duplicated byte-for-byte in `commands/gc.ts:80` and `commands/repo/gc.ts:90`.
- Proposed change: Hoist a single `formatBytes` into `helpers.ts` (or `ui.ts`) and import it in both gc commands; delete the two local copies.

## Duplicated registry-existence + dist-tags reads across repo/spaces commands
- File: packages/cli/src/commands/repo/status.ts:33
- Risk: Med
- API-impact: internal-only
- Smell: The `Bun.file(`${repoPath}/.git/HEAD`).exists()` registry guard appears in `repo/status.ts:33`, `repo/tags.ts:121`, `repo/publish.ts:33`, `repo/gc.ts:32` (via `stat`), `spaces/list.ts:32`, and `spaces/init.ts:107`. A near-identical `loadDistTags` reading `registry/dist-tags.json` is copy-pasted in `repo/status.ts:59`, `repo/tags.ts:63`, and `spaces/list.ts:40`.
- Proposed change: Extract `registryExists(repoPath)` and `loadDistTags(repoPath)` into one shared module (e.g. `commands/repo/registry-fs.ts`) and route all callers through it. Keep each command's bespoke error message at the call site (behavior-preserving) since the messages differ slightly.

## `inferTargetFromBundleRoot` duplicated between resolve-reminder and self/lib
- File: packages/cli/src/commands/resolve-reminder.ts:111
- Risk: Med
- API-impact: internal-only
- Smell: `inferTargetFromBundleRoot` exists in both `commands/resolve-reminder.ts:111` and `commands/self/lib.ts:164` with subtly different bodies (the resolve-reminder copy additionally computes `harnessName` only to null-check it). Divergent copies of the same "parse target slug from bundle path" logic risk drifting.
- Proposed change: Keep the exported `self/lib.ts` version as the single source and import it into `resolve-reminder.ts` (or move both to a shared `bundle-path.ts`). Reconcile the one behavioral difference (harnessName presence check) deliberately rather than by accident.

## Agent-profile TOML load duplicated (resolve-reminder vs self/lib)
- File: packages/cli/src/commands/resolve-reminder.ts:193
- Risk: Low
- API-impact: internal-only
- Smell: The "load `agent-profile.toml` if discovery did not include a rawProfile" fallback (lines 193-204) re-implements the `readAgentProfile` helper already present in `self/lib.ts:228` (existsSync + parseToml + record guard).
- Proposed change: Export `readAgentProfile` from `self/lib.ts` (or a shared module) and reuse it in `resolve-reminder.ts`; drop the inline `parseToml(readFileSync(...))` block.

## Dead local alias + redundant computed var in `inferTargetFromBundleRoot`
- File: packages/cli/src/commands/resolve-reminder.ts:116
- Risk: Low
- API-impact: internal-only
- Smell: `const harnessDir = bundleRoot` is a pointless rename alias; `const harnessName = harnessDir.split('/').pop()` is computed only to be used in a single null check while `targetName` re-splits the same path again.
- Proposed change: Inline `bundleRoot` directly, drop the `harnessDir` alias, compute `targetName` once, and collapse the null check.

## Inline `error instanceof Error ? .message : String(error)` despite `errorMessage()` existing
- File: packages/cli/src/commands/explain.ts:62
- Risk: Low
- API-impact: internal-only
- Smell: `helpers.ts` exports `errorMessage()` precisely to kill this idiom, but it is still hand-rolled inline in catch blocks: `explain.ts:62-66`, `gc.ts:67-71`, `add.ts:93-97`, and `self/inspect.ts:60` / `self/paths.ts:78` (`err instanceof Error ? err.message : String(err)`).
- Proposed change: Replace each inline ternary with `errorMessage(error)`. Behavior-preserving; the produced string is identical.

## Duplicated "No asp-targets.toml found" error block
- File: packages/cli/src/commands/explain.ts:40
- Risk: Low
- API-impact: internal-only
- Smell: The two-line red+gray "No asp-targets.toml found in current directory or parents / Run this command from a project directory or use --project" block is duplicated verbatim in `explain.ts:41-43` and `add.ts:38-40`; `install.ts:85-87` prints a near-identical variant via the ui helpers.
- Proposed change: Extract a `printNoProjectError()` (chalk variant) into `helpers.ts` and call it from both chalk-based commands. (Commands that use `getProjectContext` already get this via `ProjectNotFoundError`/`exitWithAspError`; `explain.ts` and `add.ts` are the holdouts doing their own project lookup.)

## `normalizeMainError` and `normalizeCliError` overlap
- File: packages/cli/src/index.ts:28
- Risk: Med
- API-impact: internal-only
- Smell: `index.ts:28 normalizeMainError` and `helpers.ts:92 normalizeCliError` both contain the same `isAspError(error) && error.cause instanceof Error → new Error(`${msg}\n  Cause: ${cause.message}`)` formatting branch.
- Proposed change: Have `normalizeMainError` delegate the asp-error-cause formatting to a shared private helper (or fold it into `normalizeCliError` and call that from `index.ts`). Keep the `ProjectNotFoundError` branch exclusive to the helpers path.

## Repeated required-option guards in memory subcommands
- File: packages/cli/src/commands/self/memory/add.ts:33
- Risk: Low
- API-impact: internal-only
- Smell: `if (!options.X) { stderr.write(`${COMMAND_NAME}: --X is required\n`); process.exit(1) }` is repeated for `--target`, `--content`, `--match` across `memory/add.ts:33,39`, `memory/replace.ts:35,41,45`, and `memory/remove.ts:28,34` (6+ identical blocks).
- Proposed change: Add a `requireOption(commandName, flag, value): asserts value is string` helper to `memory/lib.ts` alongside the existing `validateTarget`; replace the inline blocks. Message text and exit-1 behavior preserved.

## Magic timeout literal in doctor remote check
- File: packages/cli/src/commands/doctor.ts:145
- Risk: Low
- API-impact: internal-only
- Smell: `timeout: 10000, // 10 second timeout` — magic number with an explanatory comment, the textbook named-constant case.
- Proposed change: `const REGISTRY_REMOTE_TIMEOUT_MS = 10_000` at module scope; reference it and drop the comment.

## Repeated commit short-SHA slice length in diff
- File: packages/cli/src/commands/diff.ts:86
- Risk: Low
- API-impact: internal-only
- Smell: `.commit.slice(0, 12)` (short-SHA display width) is repeated 4 times in `computeDiffChanges` (lines 86, 92, 93, 104).
- Proposed change: `const SHORT_SHA_LEN = 12` constant (or a tiny `shortSha(commit)` local) referenced in all four spots.

## Experimental-harness set and default-harness string are inline magic literals
- File: packages/cli/src/commands/harnesses.ts:117
- Risk: Low
- API-impact: internal-only
- Smell: `const experimentalHarnesses = new Set(['codex'])` and `defaultHarness: 'claude'` are inline literals; `'claude'` as the default harness id is also hard-coded in `harness-validator.ts:36` and `install.ts:29`.
- Proposed change: Introduce a same-package constant for the default harness id (and, if it belongs to the registry, source the "experimental" flag from the adapter rather than a local set). Do NOT change the public default value — pure rename of the literal.

## `asp-targets.toml` filename built as inline literal in some commands
- File: packages/cli/src/commands/add.ts:44
- Risk: Low
- API-impact: internal-only
- Smell: `${projectPath}/asp-targets.toml` is hand-built in `add.ts:44`, `remove.ts:45`, `diff.ts:183`, `install.ts:120`, `agent/index.ts:58`, while `TARGETS_FILENAME` (from `spaces-config`) is used in `init.ts` and `describe.ts`. Inconsistent — a rename would miss the literal sites.
- Proposed change: Use `join(projectPath, TARGETS_FILENAME)` everywhere the targets file path is constructed.

## `explainReminder` has two near-identical early-return payloads
- File: packages/cli/src/commands/self/explain.ts:235
- Risk: Low
- API-impact: internal-only
- Smell: In `explainReminder`, the "no template" (235-246) and "no reminder sections" (248-259) branches each push one finding then return the same `{ topic, templateSource, runModeAssumed, findings }` shape; the per-finding `findings.push({ level, message })` calls are verbose throughout the file.
- Proposed change: Add tiny local `info(msg)` / `warn(msg)` push helpers (or a `makeReminderPayload(findings, sections?)` closure) to remove the repeated object literals and the duplicated return shape. Purely local, behavior-preserving.

## Redundant `_harness` → re-bind double assignment
- File: packages/cli/src/commands/run.ts:362
- Risk: Low
- API-impact: internal-only
- Smell: `const _harness = validateOptionalHarness(...); options.harness = _harness` (run.ts:362-363) and `const _harness = validateHarness(...); const harnessId = _harness` (install.ts:77-78) introduce a throwaway `_harness` local that is immediately re-bound — leftover noise from a prior refactor.
- Proposed change: Assign directly (`options.harness = validateOptionalHarness(options.harness)` / `const harnessId = validateHarness(options.harness)`); drop the `_harness` intermediary.

---

## Summary of risk classification

All findings above are **Low** or **Med** risk and **internal-only** — they touch
private helpers, local variables, inline literals, and same-package constants.
None change anything exported from the package, any CLI flag, any user-visible
output string, or any thrown-error contract. There are **no High-risk or
public-surface findings** to defer.

The package is in good post-refactor shape; these are incremental dedupe/cleanup
items, not structural problems.
