# 🔧 Refactoring Analysis

**Target:** `packages/config/src`
**Lines analyzed:** ~16,646 (non-test source; 60 production `.ts` files)
**Generated:** 2026-06-01  ·  **Focus:** all

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🟡 | `explain.ts` (825 LOC) mixes content reading, composition, and two output formatters; `materializeTarget()` / `install()` are long mixed-concern orchestrators. |
| Open/Closed | 🟡 | Harness branching (`claude` vs `pi`) hardcoded in `permissions-toml.ts` and `hooks-toml.ts`; bundle-kind handling is enum-keyed but contained. |
| Liskov Substitution | 🟢 | No `throw "not implemented"` overrides, no base-behavior-dropping overrides found. The single broad interface (`HarnessAdapter`) is implemented out-of-package. |
| Interface Segregation | 🟡 | `HarnessAdapter` has 11 members spanning detect/validate/materialize/compose/run; `ComposedTargetBundle` is a fat union carrying `pi`/`piSdk`/`codex`/Claude fields together. |
| Dependency Inversion | 🟡 | `new PathResolver(...)` constructed inline in many orchestration functions; `readFileSync`/`existsSync` called directly throughout `placement-resolver.ts`, defeating a test/IO seam. Adapter itself is correctly injected. |

## 🎯 Priority Refactorings

### 1. Duplicated space-kind classification + path selection — DRY / SRP
- **Location:** `orchestration/install.ts:190-215`, `:267-309`, `:589-603`; `orchestration/materialize-refs.ts:295-297`; `orchestration/build.ts:136-147`
- **Current:** The `isDev / isProjectSpace / isAgentSpace` determination — `entry.commit === (DEV_COMMIT_MARKER as string) || entry.integrity === DEV_INTEGRITY` etc. — is repeated verbatim at least 5 times, and the downstream "where does this space's content live" selection (agent `spaces/`, project `spaces/`, registry `spaces/`, or `paths.snapshot(integrity)`) is duplicated nearly identically for `snapshotPath` (install.ts:300-309) and `pluginPath` (install.ts:594-603).
- **Suggested:** Extract a `classifySpaceEntry(entry): { kind: 'dev'|'project'|'agent'|'registry' }` helper and a `resolveSpaceContentDir(kind, entry, { agentPath, projectPath, registryPath, paths })` helper into `core/` (or `resolver/`). Replace all call sites. This also kills the repeated `as string` casts on the marker constants (a smell pointing at a type mismatch between `CommitSha` markers and `entry.commit`).
- **Risk:** Med  ·  **Effort:** ~3-4h  ·  **Tests:** `install.test.ts`, `materialize-refs.test.ts`, `m4-placement-resolution.test.ts`; add a focused unit test for the two new helpers.

### 2. `explain.ts` mixes data acquisition, composition, and presentation — SRP
- **Location:** `orchestration/explain.ts` (entire 825-line file)
- **Current:** One module holds: filesystem content readers (`readHooksFromDir`, `readMcpFromDir`, `listSkills`, `readSettingsFromDir`), the domain `buildSpaceInfo`/`composeContent`/`explainTarget` logic, AND two presenters (`formatExplainText` with 6 nested formatter helpers, `formatExplainJson`). `readHooksFromDir` alone is a 50-line method handling three different hooks.json shapes.
- **Suggested:** Split into three modules: `explain/content-readers.ts` (the dir-reading helpers), `explain/explain.ts` (build/compose/explainTarget), and `explain/format-text.ts` (the `formatSpaceText`/`formatComposedText`/`formatTargetText` chain). The hooks-shape detection in `readHooksFromDir` overlaps with `hooks-toml.ts` `readHooksWithPrecedence` — consolidate the "parse any hooks.json shape" logic in one place.
- **Risk:** Low (pure reorganization, no behavior change)  ·  **Effort:** ~3h  ·  **Tests:** existing explain tests should pass unchanged; add no new behavior.

### 3. Harness dispatch hardcoded as `claude` vs `pi` branches — OCP
- **Location:** `materializer/permissions-toml.ts:687-729` (`explainPermissions`), `:356`/`:518` (`toClaudePermissions`/`toPiPermissions`); `materializer/hooks-toml.ts:212-214` (`normalizeHarnessForHooks`)
- **Current:** Translation logic collapses every harness to a binary `'claude' | 'pi'` and then `if (normalized === 'claude') { ... } else { ... }` with two fully-parallel `formatFacet(...)` blocks (`explainPermissions` repeats the same 8 facet calls twice). Adding `codex` permission/hook translation means editing each of these sites. `CLAUDE_ENFORCEMENT` and `PI_ENFORCEMENT` are parallel tables that must be kept in lockstep.
- **Suggested:** Introduce a small registry keyed by normalized harness family → `{ enforcement: Record<FacetKey, EnforcementLevel>, notes: Record<FacetKey, string> }`, and make `toXxxPermissions` a single `toHarnessPermissions(permissions, family)` driven by that table. `explainPermissions` then iterates one facet list once instead of duplicating the block.
- **Risk:** Med  ·  **Effort:** ~3h  ·  **Tests:** `permissions-toml.test.ts`, `hooks-toml.test.ts`.

### 4. `materializeTarget()` is a long mixed-concern orchestrator — SRP / Long Method
- **Location:** `orchestration/install.ts:236-451` (~215 lines)
- **Current:** Single function does: output-path resolution, per-space loop (classification, cache-key compute, snapshot-path selection, manifest read+normalize, harness-support filter, cache check, adapter.materializeSpace, cache-metadata write, artifact+settings collection), synthetic agent-component materialization, codex-options loading, adapter.composeTarget, and temp cleanup. Nested 4+ levels deep in places.
- **Suggested:** Extract `materializeSpaceEntry(entry, ctx): { artifact, settings } | null` (the per-iteration body) and `loadEffectiveCodexOptions(projectPath, targetName, aspHome)`. `materializeTarget` becomes a readable pipeline: build entries → map materialize → append agent-local → compose.
- **Risk:** Med  ·  **Effort:** ~4h  ·  **Tests:** `install.test.ts`, `materialize-refs.test.ts`; cross-repo broker smoke (`bun run smoke:matrix --config fake-codex`) since materialization output feeds the broker.

### 5. Direct sync IO in `placement-resolver.ts` defeats the testing/IO seam — DIP
- **Location:** `resolver/placement-resolver.ts` — `readFileSync`/`existsSync` at lines 17, 222-237, 244-250, 278-330, 354-404
- **Current:** Resolution, integrity hashing, and instruction loading call `existsSync`/`readFileSync` directly. There is no injected filesystem, so tests must touch real disk and `dryRun` is threaded as ad-hoc `if (placement.dryRun)` guards in three places (`:57`, `:74`, `:281`) to tolerate missing files.
- **Suggested:** Accept an optional `fs` reader seam (or a small `InstructionSource` interface) so dry-run / tests inject content. At minimum, collapse the repeated "exists? → read : undefined" pattern in `resolveInstructionRef`, `computeSpaceIntegrity`, and `loadAgentProfile` into one `readFileIfExists(path)` helper.
- **Risk:** Low-Med  ·  **Effort:** ~2-3h  ·  **Tests:** `m4-placement-resolution.test.ts`, `phase2-placement-agent-project.test.ts`.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Dead branch: both arms of the `ENOENT` check `return null` | `materializer/permissions-toml.ts:274-277` | 🟡 |
| `catch {}` swallows all errors silently (hides malformed hooks/mcp/settings) — 7 sites | `orchestration/explain.ts:191,231,276,316,336,351,371` | 🟠 |
| `catch {}` swallows parse/IO errors | `materializer/hooks-toml.ts:173-178,189-194,437-439` | 🟠 |
| Duplicated 8-line facet-formatting block (claude vs pi arms) | `materializer/permissions-toml.ts:705-729` | 🟡 |
| Repeated `as string` casts on marker constants (type-system smell) | `orchestration/install.ts:192,197,202,269,270,271,591,592,593` | 🟡 |
| Magic literals: hard-coded `'0.0.0'`, `.slice(0, 12)`, `.slice(0, 16)`, truncation `> 30`/`> 3` | `install.ts:275,292`; `explain.ts:651,760,699-700`; `placement-resolver.ts:268` | 🟡 |
| Deep nesting (4+ levels): hooks.json shape walk | `materializer/hooks-toml.ts:398-435` | 🟡 |
| `buildPiToolsList` ignores its only parameter (`_permissions`) and returns a constant | `materializer/permissions-toml.ts:613-621` | 🟡 |
| Primitive obsession: settings/permission facets passed as bare `string[]` with parallel enforcement tables | `materializer/permissions-toml.ts:173-196` | 🟡 |
| `parseHarnessSettings` long if/else key dispatch (per-key string compare) | `core/config/agent-profile-toml.ts:177-220` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Collapse the dead double-`return null` in `readPermissionsToml` (`permissions-toml.ts:274-277`) to a single `return null` after the try/catch, or rethrow non-ENOENT errors per the repo's "never silently capture errors" rule.
2. Extract `classifySpaceEntry(entry)` and replace the 5 duplicated marker-comparison blocks — mechanical, immediately removes the `as string` casts.
3. De-duplicate the `explainPermissions` claude/pi formatting arms into one facet-list iteration (`permissions-toml.ts:705-729`).
4. Either use or drop the unused `_permissions` arg in `buildPiToolsList`; if it's genuinely a constant, return a named `DEFAULT_PI_TOOLS` const and document why.
5. Name the magic truncation/slice numbers in `explain.ts` (`COMMIT_SHORT_LEN = 12`, `ENV_VALUE_MAX = 30`, `FACET_PREVIEW = 3`).

## ⚠️ Technical Debt Notes

- **Error-swallowing vs. project policy.** CLAUDE.md states "`asp run` should never silently capture errors." The explain/hooks/permissions readers lean heavily on bare `catch {}` returning `undefined`/`null`/`[]`. For genuinely-optional files (`hooks.json` absent) that's fine, but the current blanket catches also hide *malformed* files (bad JSON/TOML), which will surface as "no hooks/settings shown" rather than a diagnosable error. Consider distinguishing ENOENT (return empty) from parse errors (propagate or warn).
- **Two hooks.json parsers.** `explain.ts:readHooksFromDir` and `hooks-toml.ts:readHooksWithPrecedence` both independently interpret the three legacy hooks.json shapes. They can drift; consolidate on one canonical reader.
- **Parallel enforcement tables.** `CLAUDE_ENFORCEMENT` / `PI_ENFORCEMENT` must be edited together every time a facet is added; a single keyed registry removes that coupling and the duplicated `toClaude*`/`toPi*` translation bodies.
- **Fat bundle/adapter contracts.** `ComposedTargetBundle` carries optional `pi`/`piSdk`/`codex`/Claude sub-objects on one type; the `HarnessAdapter` interface (11 members) couples detection, materialization, composition, and run-arg building. These are out-of-package implementation contracts, so changes ripple to all harness packages — treat any ISP split as a cross-package effort, not a config-only refactor.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (`install.test.ts`, `materialize-refs.test.ts`, `m4-placement-resolution.test.ts`, `permissions-toml.test.ts`, `hooks-toml.test.ts`)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run `bun run test` + `bun run typecheck` between each
- [ ] Run boundary/manifest checks (`bun run check:boundaries`, `bun run check:manifests`) — config is a cross-repo publishable boundary package
- [ ] For #1/#4, run `bun run smoke:matrix --config fake-codex` (materialization output feeds the broker)
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

The first pass focused on the large orchestration/materializer files (`explain.ts`,
`install.ts`, `permissions-toml.ts`, `placement-resolver.ts`). This pass looked at the
store/resolver/core IO layer (`integrity.ts`, `snapshot.ts`, `cache.ts`, `atomic.ts`,
`locks.ts`, `closure.ts`, `lock-generator.ts`, `agent-project-merge.ts`) with an eye for
silent-error / integrity-correctness / concurrency issues the first pass did not list.

### A1. Integrity hash silently falls back to "empty content" on ANY git error — Correctness / Silent-error (HIGH)
- **Principle/smell:** Swallowed exception masking an integrity failure (violates CLAUDE.md "never silently capture errors")
- **Location:** `resolver/integrity.ts:79-86`
- **Detail:** `computeIntegrity` wraps `listTreeRecursive` in `try { … } catch (_err) { return hash("v1\0") }`. The comment says "if the tree doesn't exist," but the catch is unconditional: a transient git failure, a permissions error, or a corrupt object store all produce the SAME deterministic hash as a legitimately-empty space. That hash is then written into the lock file and used by `verifyIntegrity`/`verifySnapshot`, so a corrupted/unreadable space can silently pass integrity verification. Distinguish "path absent in tree" from real git errors and rethrow the latter.
- **Risk:** Med (changes a hot path used by lock-gen and snapshotting) · **Effort:** ~1-2h · **Tests:** `integrity.test.ts`, `lock-generator.test.ts`.

### A2. `createSnapshot` uses `Date.now()` for temp-dir uniqueness and a non-atomic overwrite — Concurrency / Race (HIGH)
- **Principle/smell:** Race condition + hand-rolled non-atomic rename that bypasses the existing `atomicDir` helper
- **Location:** `store/snapshot.ts:101` (`snapshot-${Date.now()}`), `:118-120` (`rename(tempDir, finalPath)`)
- **Detail:** Two `createSnapshot` calls in the same millisecond collide on the temp dir. Worse, the content-addressed write is `extractTree → rename(tempDir, finalPath)` with no lock and no "rm target first" — `atomic.ts:atomicDir()` exists for exactly this and uses `crypto.randomBytes` + target-removal, but `createSnapshot` reimplements it incorrectly. On a populated target, `rename` can fail with `ENOTEMPTY` on some platforms when two processes snapshot identical content concurrently. Route this through `atomicDir`/`crypto.randomBytes`.
- **Risk:** Med · **Effort:** ~2h · **Tests:** `snapshot.test.ts`; add a concurrent-create test.

### A3. Duplicated filesystem-hashing/size helpers across three modules — DRY / SRP
- **Principle/smell:** Copy-paste of git-blob/dir-walk/dir-size logic that must stay byte-for-byte identical
- **Location:** `computeGitBlobOid` at `resolver/integrity.ts:135` AND `store/snapshot.ts:194`; `collectFilesystemEntries` (`integrity.ts:150`) vs `collectFileEntries` (`snapshot.ts:199`) — near-identical walks producing the SAME canonical `v1\0…` representation; `computeDirSize` duplicated at `store/snapshot.ts:274` AND `store/cache.ts:164`.
- **Detail:** The two integrity walks MUST produce identical hashes (snapshot.ts even documents "this must match resolver/integrity.ts"), yet they are independent copies that can drift — a one-line change to ignored-paths or mode logic in one silently breaks snapshot verification. Extract a single `core/fs-hash.ts` (`computeGitBlobOid`, `walkBlobEntries`, `canonicalIntegrity`) and one `dirSize` util.
- **Risk:** Med (shared by integrity verification) · **Effort:** ~3h · **Tests:** `integrity.test.ts`, `snapshot.test.ts`, `cache.test.ts`.

### A4. `mergeAgentWithProjectTarget` picks `claude.model` over `codex.model` regardless of harness — Correctness
- **Principle/smell:** Harness-blind precedence; latent cross-harness bug
- **Location:** `core/merge/agent-project-merge.ts:123-124`
- **Detail:** `model: projectTarget?.claude?.model ?? projectTarget?.codex?.model ?? profile.harnessDefaults?.model`. The resolved `harness` is computed two lines down but never consulted: a codex target that also carries a `claude.model` override (e.g. inherited defaults) will wrongly resolve to the Claude model. Select the model from the branch matching the resolved harness family.
- **Risk:** Low-Med · **Effort:** ~1h · **Tests:** `agent-project-merge` tests; add a codex-target-with-claude-override case.

### A5. `isTargetUpToDate` only diffs the compose list, ignoring resolved commits/integrities — Missing edge case
- **Principle/smell:** Incomplete staleness check
- **Location:** `resolver/lock-generator.ts:337-352`
- **Detail:** Returns `true` whenever `entry.compose` matches the requested compose by order+length. It never checks whether the selectors now resolve to different commits or whether space integrities changed, so a moving selector (`@head`, a dist-tag) reports "up to date" even after the underlying content moved. Either rename to `isComposeUnchanged` (honest naming) or extend it to compare resolved commits/`envHash`.
- **Risk:** Low (naming) / Med (if behavior extended) · **Effort:** ~1-2h · **Tests:** `lock-generator.test.ts`.

### A6. `DEFAULT_HARNESSES = ['claude']` hardcodes harness enumeration in lock generation — OCP
- **Principle/smell:** Open/Closed — separate from the first report's permissions/hooks OCP item
- **Location:** `resolver/lock-generator.ts:26`, consumed at `:208-214`
- **Detail:** Lock files only ever emit a `claude` harness entry; adding `codex`/`pi` per-harness env hashes means editing this constant and the loop. This is a different OCP site than `permissions-toml.ts`/`hooks-toml.ts` (first report #3). Drive the harness list from a shared registry/config so lock-gen, permissions, and hooks all enumerate harnesses from one source.
- **Risk:** Low · **Effort:** ~1h · **Tests:** `lock-generator.test.ts`.

### A7. `computeClosure` re-wraps deep failures as a shallow `MissingDependencyError`, losing the cause — Error-handling
- **Principle/smell:** Exception cause erasure
- **Location:** `resolver/closure.ts:259-270`
- **Detail:** The dependency-visit `catch` rethrows `CyclicDependencyError` and "Disallowed dependency edge" errors, but turns EVERYTHING else into `new MissingDependencyError(ref.id, depRefString)`. A genuine read/parse error several levels deep (bad manifest TOML, IO error) is reported as "missing dependency `<ref>`" with no original message and no `cause`. Attach the original error as `{ cause: err }` (or only wrap true resolution-not-found errors) so failures are diagnosable.
- **Risk:** Low · **Effort:** ~1h · **Tests:** `closure.test.ts`.

### A8. `acquireLock` only maps message-substring "ELOCKED"/"already being held" to a timeout — Leaky abstraction / Fragile error mapping
- **Principle/smell:** String-matching on third-party error messages
- **Location:** `core/locks.ts:96-104` (release) and `:110-117` (acquire)
- **Detail:** Both the acquire path and the release path classify `proper-lockfile` failures by `err.message.includes(...)` ("ELOCKED", "already being held", "not acquired", "already released"). If the library changes its message wording, a held-lock failure silently becomes a generic `LockError` (or a release no-op stops being a no-op). Prefer matching on the library's error `code`/typed errors; at minimum centralize these magic strings in one place with a comment pinning the `proper-lockfile` version they track.
- **Risk:** Low · **Effort:** ~1h · **Tests:** `locks.test.ts`.

### A9. `getCacheMetadata`/`getSnapshotMetadata` swallow JSON parse errors as "missing" — Silent-error
- **Principle/smell:** `catch { return null }` conflates ENOENT with corruption (same family as the first report's explain/hooks note, but in the store layer)
- **Location:** `store/cache.ts:105-110`, `store/snapshot.ts:69-74`, `:143-149` (`verifySnapshot`)
- **Detail:** A truncated/corrupt `.asp-cache.json` or `.asp-snapshot.json` is indistinguishable from "no metadata," so the system silently re-materializes or treats a corrupt snapshot as absent rather than surfacing the corruption. Distinguish ENOENT (return null) from `JSON.parse`/read errors (warn or propagate), consistent with the repo error-handling policy.
- **Risk:** Low · **Effort:** ~1h · **Tests:** `cache.test.ts`, `snapshot.test.ts`.

### A10. `atomicWrite` fsync opens the temp file read-only — durability gap — Correctness (LOW)
- **Principle/smell:** fsync on a read-only fd may not flush data on all platforms
- **Location:** `core/atomic.ts:67-74`
- **Detail:** After `writeFile`, the durability path reopens the temp file with `'r'` and calls `fd.sync()`. `writeFile` opens/closes its own fd, so this second fd is a fresh read handle; on some platforms/filesystems `fsync` on a read-only descriptor is not guaranteed to flush the just-written data. The robust pattern is to keep the write fd open and `fsync` it (or use the `flush` option), and the parent directory is never fsynced so the rename itself isn't durably recorded. Low impact for a cache/snapshot store, but the function advertises "crash-safe."
- **Risk:** Low · **Effort:** ~1-2h · **Tests:** hard to unit-test; document the guarantee.
