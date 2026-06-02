# 🔧 Refactoring Analysis

**Target:** `packages/harness-pi/src`
**Lines analyzed:** 1356 (3 source files; `pi-adapter.ts` = 1336, `index.ts` = 14, `register.ts` = 6; test file excluded)
**Generated:** 2026-06-01  ·  **Focus:** all

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🔴 | One 1336-line file holds errors, binary detection, version/flag probing, extension bundling, two string-template code generators, and the full adapter. `composeTarget` (~205 lines) and `materializeSpace` (~137 lines) each mix filesystem IO, codegen, auth, settings, and lint concerns. |
| Open/Closed | 🟡 | Hook event mapping is table-driven (good), but component-directory copy logic is hand-unrolled per directory; adding a new component kind requires editing `materializeSpace`/`composeTarget`. Model list is inline data rather than externally extensible. |
| Liskov Substitution | 🟢 | No subclassing or overrides; `PiAdapter` is a single concrete implementation of `HarnessAdapter`. No throw-on-override or no-op-override smells. |
| Interface Segregation | 🟡 | `validateSpace` and `getDefaultRunOptions` are forced stubs that return empty results — the adapter implements interface members it has nothing to do. Structural `as X & {...}` casts (`manifestWithPi`, `piBundle`) reach for fields the typed contract does not expose. |
| Dependency Inversion | 🔴 | `Bun.spawn`, `homedir()`, `process.env`, and hardcoded paths (`~/.pi/agent/auth.json`, `praesidium/var/logs`) are wired directly into business logic with no injection seam. A module-level mutable `cachedPiInfo` singleton couples detection to global state. |

## 🎯 Priority Refactorings

### 1. Split `pi-adapter.ts` into cohesive modules — Single Responsibility
- **Location:** `packages/harness-pi/src/adapters/pi-adapter.ts:1-1336`
- **Current:** A single 1336-line file containing error classes, binary discovery/version/flag detection, extension bundling, two large code generators, the adapter class, the lint-facet collector, and a singleton export.
- **Suggested:** Extract into `errors.ts`, `detect.ts` (find/version/flag/cache), `bundle.ts` (`bundleExtension`, `discoverExtensions`), `codegen/hook-bridge.ts` + `codegen/hrc-events.ts`, and keep `pi-adapter.ts` as the thin orchestration class. Each becomes independently testable.
- **Risk:** Med  ·  **Effort:** ~0.5 day  ·  **Tests:** `pi-adapter.test.ts` import paths; re-export surface in `index.ts` must stay identical.

### 2. Decompose `composeTarget` — Single Responsibility / Long Method
- **Location:** `pi-adapter.ts:916-1122`
- **Current:** ~205-line method performing extension merge + W303 collision detection, skill merge, hook merge + path resolution, hook-bridge codegen + W301 warnings, HRC-events codegen, skills-presence check, auth symlink creation, settings.json generation, and permissions W304 linting.
- **Suggested:** Extract `mergeExtensions()`, `mergeSkills()`, `mergeHooks()`, `writeBridges()`, `linkPiAuth()`, `writePiSettings()`, and `lintPermissions()` private helpers, each returning its own warnings; `composeTarget` becomes a short sequence of calls aggregating warnings.
- **Risk:** Med  ·  **Effort:** ~0.5 day  ·  **Tests:** add focused unit tests per extracted helper; existing composition test must still pass.

### 3. Replace string-concatenation codegen with template files — Single Responsibility / Maintainability
- **Location:** `pi-adapter.ts:451-593` (`generateHookBridgeCode`) and `595-682` (`generateHrcEventsBridgeCode`)
- **Current:** Runtime JS is assembled by interpolating into ~140-line and ~85-line backtick templates. User-controlled values (`hook.script`, `hook.event`) are interpolated directly into generated source as bare single-quoted literals (injection/escaping hazard), and both functions hand-roll near-identical `child_process.spawn` + stdin/close logic.
- **Suggested:** Move the static runtime scaffolding into checked-in `.js` template assets read at build/compose time, inject only a JSON-serialized hook table (no code interpolation), and share one spawn helper between both bridges.
- **Risk:** Med  ·  **Effort:** ~0.5–1 day  ·  **Tests:** snapshot tests on generated output; add an injection test (script name containing a quote).

### 4. Introduce injection seams for process/host dependencies — Dependency Inversion
- **Location:** `pi-adapter.ts:214,241,330` (`Bun.spawn`), `1063` (`homedir()` + `~/.pi/agent/auth.json`), `575` (`praesidium/var/logs`), `106` (`cachedPiInfo` singleton)
- **Current:** Spawning, the home directory, and well-known paths are referenced directly inside detection/bundling/compose logic; detection caches into a module-global, making tests order-dependent and forcing `clearPiCache()` workarounds.
- **Suggested:** Accept a small `{ spawn, homedir, env }` host port (defaulting to the real implementations) and pass the cache as an instance field rather than a module global. Lift hardcoded paths into named constants/config.
- **Risk:** Med  ·  **Effort:** ~1 day  ·  **Tests:** detection tests can inject a fake spawn instead of relying on a real `pi` binary.

### 5. Collapse repeated "stat-dir-then-readdir" copy blocks — DRY / Open-Closed
- **Location:** `pi-adapter.ts:827-880` (skills/hooks/shared/scripts in `materializeSpace`) and `936-1026` (extensions/skills/hooks in `composeTarget`)
- **Current:** The pattern `stat(dir) → isDirectory → copyDir/readdir → swallow error` is copy-pasted ~7 times with subtly different bodies, each silently swallowing all errors in a bare `catch {}`.
- **Suggested:** Extract a `copyComponentDir(src, dest, onEach?)` helper driven by the already-declared (but unused) `_PI_COMPONENT_DIRS` list, so adding a component type is data, not new code. Distinguish "directory absent" (ENOENT) from real IO errors instead of swallowing both.
- **Risk:** Low  ·  **Effort:** ~0.5 day  ·  **Tests:** materialize/compose tests cover the happy path; add a non-ENOENT error case.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| God file (1336 lines, many concerns) | `pi-adapter.ts:1-1336` | 🟠 |
| Long method `composeTarget` (~205 lines) | `pi-adapter.ts:916-1122` | 🟠 |
| Long method `materializeSpace` (~137 lines) | `pi-adapter.ts:769-906` | 🟠 |
| Long method `buildRunArgs` (~100 lines) | `pi-adapter.ts:1157-1258` | 🟡 |
| Large string-template codegen, value interpolation into generated code | `pi-adapter.ts:451-593` | 🟠 |
| Duplicated `child_process.spawn` logic across both bridges | `pi-adapter.ts:506-523, 644-659` | 🟡 |
| Duplicated stat→readdir copy block (~7×) | `pi-adapter.ts:827-880, 936-1026` | 🟡 |
| Bare `catch {}` swallows all errors incl. real IO failures | `pi-adapter.ts:371,839,855,866,878,960,984,1023,1058,1072` | 🟠 |
| Structural cast escape hatch `as typeof X & {...}` | `pi-adapter.ts:786-794, 1164-1166, 1232-1233` | 🟡 |
| Stub interface methods returning empty results | `pi-adapter.ts:747-762, 1325-1330` | 🟡 |
| Mutable module-global cache singleton | `pi-adapter.ts:106` | 🟡 |
| Unused constant `_PI_COMPONENT_DIRS` | `pi-adapter.ts:92` | 🟡 |
| Magic hardcoded paths (`praesidium/var/logs`, `~/.pi/agent/auth.json`, `state/hrc/runtimes`) | `pi-adapter.ts:575, 1063, 1234-1240` | 🟡 |
| `as` cast on returned bundle to attach `hrcEventsBridgePath` not in the contract | `pi-adapter.ts:1109-1118, 1308-1314` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Remove or wire up the dead `_PI_COMPONENT_DIRS` constant (`pi-adapter.ts:92`).
2. Extract `errors.ts` (`PiNotFoundError`, `PiBundleError`) — pure move, zero behavior change.
3. Hoist the hardcoded path strings (`praesidium/var/logs`, `~/.pi/agent/auth.json`) into named constants near the existing `COMMON_PI_PATHS` block.
4. Extract `collectLintOnlyFacets`'s seven near-identical branches into a small table-driven loop over `[facet, accessor]` pairs (`pi-adapter.ts:1124-1150`).
5. Narrow at least the obviously-recoverable `catch {}` blocks to re-throw on non-ENOENT errors.

## ⚠️ Technical Debt Notes

- The hook-bridge generator interpolates `hook.script` and `hook.event` directly into emitted JavaScript as single-quoted literals (`pi-adapter.ts:481,498,506,532,551`). Any value containing a quote or newline produces broken or injected code. This is the highest-correctness-risk item; prefer passing a JSON-serialized table into static scaffolding.
- `hrcEventsBridgePath` is appended to the bundle via `as` casts (`pi-adapter.ts:1109-1118`, `1164-1166`, `1308-1314`) because `ComposedTargetBundle['pi']` does not declare it. The shared `spaces-config` type should carry this field so the casts disappear.
- Detection relies on a module-level mutable cache plus an exported `clearPiCache()` reset hook, signalling test-induced global state. Per-instance state would remove the reset escape hatch.
- `validateSpace` does no validation and `getDefaultRunOptions` returns `{}`; either implement them or document that Pi intentionally opts out, so readers don't assume logic is missing.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (extend `pi-adapter.test.ts`; add codegen snapshot + injection cases)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run tests between each (`bun run test`, `bun run typecheck`, `bun run lint`)
- [ ] Run `bun run check:boundaries` and `bun run check:manifests` after module splits (re-export surface in `index.ts` must stay stable)
- [ ] Smoke the Pi harness path (`--harness pi`, `PI_CODING_AGENT_DIR`, `--no-extensions`, `--no-skills`) per CLAUDE.md
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

These are correctness/concurrency/contract issues the first pass did not list. They focus on runtime behavior rather than structure.

### A1. `await proc.exited` happens *before* draining stdout/stderr — pipe-buffer deadlock — Resource/Concurrency correctness
- **Principle/smell:** Async resource ordering bug (deadlock on full pipe buffer).
- **Location:** `pi-adapter.ts:219-220` (`queryPiVersion`), also `pi-adapter.ts:246-247` (`supportsPiFlag`) and `pi-adapter.ts:335-336` (`bundleExtension`).
- **Detail:** Each does `const exitCode = await proc.exited` *then* `await new Response(proc.stdout).text()`. With `stdout: 'pipe'`, if the child writes more than the OS pipe buffer (~64KB) before exiting, it blocks on write while the parent blocks on `proc.exited` — neither side drains the pipe, producing a hang. `pi --help` output is the most likely to exceed the buffer. The correct order is to start reading stdout/stderr (e.g. kick off the `Response().text()` promises) and only then await `exited`, or await them together. The `catch` only guards thrown errors, not a hang, so this fails as an indefinite stall rather than a clean fallback.
- **Risk:** Med (intermittent hangs in detection)  ·  **Effort:** ~0.5 day (read concurrently, then await exit).

### A2. `supportsPiFlag` uses substring `includes` → false positives across flag names — Contract correctness
- **Location:** `pi-adapter.ts:251` (`return helpText.includes(flag)`).
- **Detail:** Probing `--extension` returns true if help text contains `--extensions`, `--no-extension`, or any prose mention. Capabilities (`supportsExtensions`/`supportsSkills`) and the emitted `--extension`/`--skills` args therefore key off a loose match. Should match a whole flag token (word boundary / split on whitespace) instead of a raw substring.
- **Risk:** Low–Med (wrong capability inference)  ·  **Effort:** ~1–2 hrs.

### A3. `COMMON_PI_PATHS` is frozen at module import and never tilde-expands — Determinism / Dependency Inversion
- **Location:** `pi-adapter.ts:79-87`.
- **Detail:** Distinct from the runtime `homedir()` DI item already filed. These paths are computed once at *import* time from `process.env['HOME']`, so any later env mutation (tests, subprocess launch with a different HOME) is ignored. The `|| '~'` fallback is also dead: a literal `'~'` is never expanded by `join`, so when HOME is unset the resulting `~/tools/...` paths are nonsensical rather than user-home-relative.
- **Risk:** Low  ·  **Effort:** ~1 hr (compute inside `findPiBinary`, expand or drop the `~` fallback).

### A4. `buildRunArgs` calls `readdirSync(extensionsDir)` with no guard — Missing edge-case handling
- **Location:** `pi-adapter.ts:1184`.
- **Detail:** Every async sibling that reads a component dir swallows ENOENT and degrades gracefully, but the *synchronous* `readdirSync` here will throw if `extensionsDir` is missing or not yet created (partial/corrupt bundle, or a `loadTargetBundle` result where the dir was never written). The intended `--no-extensions` fallback at `:1204` is never reached because the throw escapes first. Wrap in try/catch (or `existsSync` check) and fall through to `hasExtensions=false`.
- **Risk:** Med (crash instead of degrade)  ·  **Effort:** ~1 hr  ·  **Tests:** add a buildRunArgs case with a missing extensions dir.

### A5. Intra-space extension name collisions silently overwrite — Missing edge-case / silent data loss
- **Location:** `pi-adapter.ts:810-813` (namespacing) and the bundle loop `:808-825`.
- **Detail:** The output name is `${spaceId}__${srcName}.js` where `srcName` strips the extension. Within one space, `foo.ts` and `foo.js` both map to `spaceId__foo.js`; the second `bundleExtension` overwrites the first to the same `outPath` with no error or warning. The W303 collision check (`:947-955`) only runs cross-space at compose time, so same-space collisions are invisible. Detect the duplicate `outName` in the loop and warn (or include the original extension in the namespaced name).
- **Risk:** Low–Med (silent dropped extension)  ·  **Effort:** ~1–2 hrs.

### A6. `detectPi` has no in-flight de-duplication — Concurrency (redundant work / thundering herd)
- **Location:** `pi-adapter.ts:261-283`.
- **Detail:** The first report flagged `cachedPiInfo` as a test-order global. Separately: because only the *resolved* value is cached, N concurrent first callers each run the full detection (1 spawn for `--version` + 2 spawns for `--help`) before any populates the cache — there is no memoized in-flight promise. Cache a `Promise<PiInfo>` (cleared on `forceRefresh`/`clearPiCache`) so concurrent callers share one detection.
- **Risk:** Low (extra subprocess churn)  ·  **Effort:** ~1 hr.

### A7. `findPiBinary` splits PATH on `:` only and keeps empty segments — Portability / edge-case
- **Location:** `pi-adapter.ts:150-157` (`searchPath`).
- **Detail:** Hardcoded `pathEnv.split(':')` is wrong on Windows (`;`), and empty PATH entries yield `join('', 'pi') === 'pi'`, an accidental relative-path probe. Use `path.delimiter` and skip empty segments.
- **Risk:** Low  ·  **Effort:** ~30 min.

### A8. Test gaps for correctness-critical paths — Test coverage
- **Location:** `pi-adapter.test.ts` (whole file).
- **Detail:** No test covers (a) hook-script values containing a quote/newline (the injection hazard the first report calls the top correctness risk — codegen is only tested with benign script names); (b) `materializeSpace` cleanup-on-failure (`:901-905`) — that the `cacheDir` is removed when a mid-bundle throw occurs; (c) `loadTargetBundle`, `getRunEnv`, and `getDefaultRunOptions` are entirely untested; (d) `detect()` capability inference when `supportsPiFlag` returns false. Add focused cases, especially the injection and cleanup ones.
- **Risk:** Low (test-only)  ·  **Effort:** ~0.5 day.

### A9. `materializeSpace` catch deletes a caller-supplied `cacheDir` it may not own — Surprising side effect
- **Location:** `pi-adapter.ts:901-905` (`await rm(cacheDir, { recursive: true, force: true })`).
- **Detail:** On *any* failure the whole `cacheDir` is recursively removed, but `cacheDir` is provided by the caller and is only conditionally cleaned at entry (only when `options.force`). If a non-force call fails partway, this deletes pre-existing sibling content the caller placed in that dir. The `.catch(() => {})` also swallows cleanup failures silently. Scope cleanup to artifacts this method created, or only when it created the dir.
- **Risk:** Low–Med  ·  **Effort:** ~1–2 hrs.
