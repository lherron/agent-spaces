# 🔧 Refactoring Analysis

**Target:** `packages/cli/src`
**Lines analyzed:** ~8,900 (non-test TypeScript sources)
**Generated:** 2026-06-01  ·  **Focus:** all

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🟡 | `manager-space-content.ts` (1,425 lines) mixes 11 large embedded doc blobs with the file-list API; `run.ts` action handler does validation + mode detection + 3 near-identical option assemblies + output. |
| Open/Closed | 🟢 | Switch/case usage (`run` mode, `diff` change type, memory error mapping) is over closed, exhaustive union types — adding a variant is a compiler-checked edit, not an open-ended `if` chain. Minor: `getManagerSpaceFiles` list grows per file. |
| Liskov Substitution | 🟢 | No class hierarchies with overrides; no `throw "not implemented"`, no type-check-before-call, no no-op overrides. Not applicable in any harmful way. |
| Interface Segregation | 🟡 | `AgentCommandOptions` (24 fields) and `RunOptions` (28 fields) are fat option bags threaded through many helpers that each use a small subset. `SelfContext` (18 fields) is broad but cohesive. |
| Dependency Inversion | 🟡 | Business logic instantiates concretes directly: `new PathResolver(...)` repeated in ~9 commands, `new MemoryStore(...)` in 5 memory commands, plus hard `process.env`/`console.log`/`process.exit` coupling throughout. No injection seam for stores/paths/output. |

## 🎯 Priority Refactorings

### 1. Split embedded content from logic in `manager-space-content.ts` — SRP
- **Location:** `packages/cli/src/commands/repo/manager-space-content.ts:1-1425`
- **Current:** A single 1,425-line module holds 11 large `const X = \`...markdown...\`` template literals (command docs, a skill, an agent definition) plus the `getManagerSpaceFiles()` accessor. ~1,390 of the lines are static documentation text, not code.
- **Suggested:** Move the markdown bodies to real files under a `templates/agent-spaces-manager/` asset directory and load them at pack time (or keep them as separate `*.content.ts` modules, one per asset). Keep `getManagerSpaceFiles()` as a thin index that maps `path -> loaded content`. This shrinks the logic surface to a few dozen lines and lets doc edits happen without scrolling a giant code file.
- **Risk:** Med (must preserve exact byte content so `repo init` installs identical files; the cross-repo prepack/pack smoke must still bundle the assets) · **Effort:** 0.5–1 day · **Tests:** `repo/init` install test and `build-bundle-ref-agent-project.test.ts`; verify packaged tarball includes the template assets (`bun scripts/smoke-pack-cross-repo.ts`, `packages/cli/scripts/smoke-test-pack.ts`).

### 2. Collapse the three duplicated run-option builders in `run.ts` — SRP / DRY
- **Location:** `packages/cli/src/commands/run.ts:207-389` (`runProjectMode`, `runGlobalMode`, `runDevMode`)
- **Current:** The `runOptions` / `globalOptions` / `devOptions` objects are ~25-field literals that are 90% identical across the three modes (every field except `projectPath`, `projectId`, `taskId`, and `interactive` defaulting is copy-pasted three times). A new run flag must be added in three places, and drift is easy (e.g. `inheritLocal` is read in `buildSettingSources` but only some builders forward sibling inherit flags).
- **Suggested:** Extract a single `buildCommonRunOptions(options): CommonRunOptions` that produces the shared shape once, then have each mode spread it and add its mode-specific keys. Consider a small `RunModeHandler` map keyed by `RunMode` so the action body's `switch` becomes a lookup.
- **Risk:** Low · **Effort:** 2–3 hrs · **Tests:** `run-model-reasoning-effort.test.ts`, `run-compiler-debug.test.ts`, `convenience-resolution.test.ts`, plus `--dry-run` smoke per CLAUDE.md (project/global/dev/codex).

### 3. Extract a shared "self memory command" scaffold — SRP / DRY / DIP
- **Location:** `add.ts`, `read.ts`, `remove.ts`, `replace.ts`, `inspect.ts`, `snapshot-cmd.ts`, `paths-cmd.ts`, `diff-cmd.ts` under `packages/cli/src/commands/self/memory/`
- **Current:** Every memory subcommand repeats the same boilerplate: `resolveSelfContext()` → `if (!ctx.agentName) { stderr; process.exit(1) }` (8 files) → `validateTarget` with the identical `expected: memory, user, persona` message (4 files) → `new MemoryStore({ agentName, agentsRoot })` (5 files) → identical top-level `catch` that writes `self memory <x>: <msg>` and `process.exit(1)`. The `mapErrorToExitCode` / `mapReplaceError` shape in `replace.ts:96-135` is also echoed in sibling write commands.
- **Suggested:** Add a `withMemoryStore(commandName, fn)` helper (in a `self/memory/lib.ts`) that resolves context, guards `agentName`, builds the store, and wraps the try/catch + exit-code mapping once. Centralize `validateTarget` and the error→exit-code table. Subcommands shrink to option parsing + the one store call.
- **Risk:** Low · **Effort:** 3–4 hrs · **Tests:** `self/memory/__tests__/cli.test.ts` (assert identical exit codes / messages preserved).

### 4. Introduce a path/store provider seam — DIP
- **Location:** `new PathResolver({ aspHome })` at `helpers.ts:47`, `path.ts:30`, `doctor.ts:210`, `gc.ts:27`, `spaces/list.ts:147`, `spaces/init.ts:106`, `repo/{status,init,publish,tags,gc}.ts`; `new MemoryStore(...)` in 5 memory commands.
- **Current:** Commands reach out and `new` their collaborators inline, reading `process.env`/`getAspHome()` directly. There is no seam to substitute a fake in unit tests, so command tests must touch the real filesystem/env.
- **Suggested:** `helpers.getProjectContext()` already centralizes `PathResolver` construction — route the repo/spaces/doctor commands through a shared `resolvePaths(options)` factory (or extend `getProjectContext`) instead of each constructing its own. For `MemoryStore`, accept an optional injected factory (defaulting to `new MemoryStore`) so the scaffold from item 3 owns instantiation.
- **Risk:** Low (mechanical) · **Effort:** 2–3 hrs · **Tests:** existing command CLI tests; no behavior change expected.

### 5. Narrow the fat option bags `AgentCommandOptions` / `RunOptions` — ISP
- **Location:** `packages/cli/src/commands/agent/index.ts:126-149` (24 fields), `packages/cli/src/commands/run.ts:46-70` (28 fields)
- **Current:** The full options object is passed to helpers (`resolveHarnessOption`, `buildPlacement`, `buildSettingSources`) that each consume only a handful of fields, so the dependency surface of each helper is much wider than its real need. `handleExecute` in `agent/index.ts:254-373` is ~120 lines branching CLI-frontends vs SDK-frontends inline.
- **Suggested:** Define focused sub-shapes (`PlacementInputs`, `ContinuationInputs`, `SettingSourceInputs`) and pass only what each helper needs. Split `handleExecute` into `runProcessFrontend(...)` and `runSdkFrontend(...)`.
- **Risk:** Med (type plumbing touches many call sites) · **Effort:** 0.5 day · **Tests:** `m6-agent-cli.test.ts`, `scope-handle-cli.test.ts`, `build-bundle-ref-agent-project.test.ts`.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| God file: 1,425 lines, ~98% embedded string content | `commands/repo/manager-space-content.ts:1` | 🟠 |
| Duplicated ~25-field option literal ×3 | `commands/run.ts:215-239, 308-331, 359-382` | 🟠 |
| Duplicated `agentName` guard + try/catch + exit boilerplate across 8 files | `commands/self/memory/*.ts` | 🟠 |
| Duplicated `validateTarget` ("memory, user, persona") ×4 | `commands/self/memory/{add,read,remove,replace}.ts` | 🟡 |
| Long method: `handleExecute` ~120 lines with frontend branch inline | `commands/agent/index.ts:254-373` | 🟡 |
| `require('node:fs')` mid-function instead of top import | `commands/run.ts:165` | 🟡 |
| `as unknown as Parameters<...>[0]` / `as Parameters<...>[0]` casts bypass type checking | `commands/agent/index.ts:308, 370` | 🟡 |
| `as \`space:${string}@${string}\`` cast relies on an upstream guard far from the cast site | `commands/run.ts:334` | 🟡 |
| Direct `console.log` / `process.stdout.write` rendering interleaved with logic (no output seam) | `run.ts`, `doctor.ts`, `agent/index.ts`, `self/*` | 🟡 |
| Repeated `error instanceof Error ? error.message : String(error)` idiom (>10 sites) | across `commands/**` | 🟡 |
| Magic exit codes (1/2/3/4) without named constants | `self/memory/replace.ts:96-104` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Hoist the inline `require('node:fs')` in `run.ts:165` (`hasAgentProfile`) to a top-level `import { existsSync } from 'node:fs'` — matches the rest of the codebase and removes a CJS-style require in an ESM module.
2. Extract `errorMessage(e: unknown): string` into `helpers.ts` and replace the >10 copies of `error instanceof Error ? error.message : String(error)`.
3. Extract `buildCommonRunOptions(options)` in `run.ts` (item 2) — pure refactor, no behavior change, removes the largest copy-paste in the package.
4. Centralize the memory `validateTarget` + `expected: memory, user, persona` message in one helper imported by the 4 write/read commands.
5. Name the memory exit codes (`EXIT_AMBIGUOUS = 1`, `EXIT_SCANNER_BLOCKED = 2`, `EXIT_CAP = 3`, `EXIT_DELIMITER = 4`) so `mapErrorToExitCode` is self-documenting.

## ⚠️ Technical Debt Notes

- **Render vs. logic coupling:** nearly every command writes directly to `console`/`process.stdout` and calls `process.exit` from deep inside handlers. This is idiomatic for a CLI and consistent with the project rule that `asp run` must exit immediately on error, but it does make pure unit testing of the assembly logic harder. The existing `--json` branches are duplicated per command; a tiny `emit(payload, { json })` helper would consolidate them without changing the "exit immediately" contract.
- **Type-escape casts in `agent/index.ts`:** the two `as ... Parameters<...>[0]` casts (lines 308, 370) silently decouple the CLI from the `agent-spaces` client signature. If the client's request shape changes, these will not fail to compile. Consider constructing a typed request object and letting inference catch drift.
- **The OCP picture is healthy:** the `switch` statements found (`run` mode, `diff` change type, `explain` topic, memory error mapping) are all exhaustive over closed union types, so they fail to compile when a variant is added — this is the desired shape, not an anti-pattern. No action needed there.
- **`manager-space-content.ts` packaging coupling:** any change to how that content is stored must keep working through the cross-repo prepack (`exports.*.bun` stripping) and the pack smoke. Treat item 1 as packaging-sensitive, not a pure source move.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (CLI tests under `src/__tests__` and `src/commands/self/memory/__tests__`)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run `bun run test` + `bun run typecheck` between each
- [ ] For `run.ts` changes, re-run the `--dry-run` smokes from CLAUDE.md (project / global / dev / codex)
- [ ] For `manager-space-content.ts`, run `bun scripts/smoke-pack-cross-repo.ts` and `packages/cli/scripts/smoke-test-pack.ts`
- [ ] Run `bun run lint` and `bun run check:boundaries` / `check:manifests`
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

This pass focused on the `self/*` introspection family, `resolve-reminder.ts`, and
cross-cutting correctness/perf issues that the first pass (centered on `run.ts`,
`manager-space-content.ts`, the memory commands, and the fat option bags) did not
surface. Each item below is new — no duplication with §1–5 above.

### A1. Two divergent `inferTargetFromBundleRoot` implementations — DRY / correctness
- **Smell:** Duplicated logic that has silently drifted (two "same name, different behavior" copies).
- **Location:** `commands/self/lib.ts:161` (exported, returns `string | null`) vs `commands/resolve-reminder.ts:109` (file-private, returns `string | undefined`).
- **Detail:** The `lib.ts` version computes `targetDir = dirname(bundleRoot)` and returns its basename with **no** check that the bundle is actually a harness dir. The `resolve-reminder.ts` version adds a `harnessName` non-empty guard (`if (!harnessName || dirname(targetDir) === targetDir) return undefined`). For the same `ASP_PLUGIN_ROOT`, the two paths can disagree on whether a target is inferable. Because `asp self *` and the `SessionStart` `resolve-reminder` hook both infer the agent from the same env var, this divergence can make introspection and reminder injection disagree about which agent is running.
- **Suggested:** Export one canonical `inferTargetFromBundleRoot` from `lib.ts` (or a shared `self/infer.ts`), pick the stricter semantics, and have `resolve-reminder.ts` import it. Normalize the return type (`string | null`).
- **Risk:** Med (semantics must be reconciled, not just deduped) · **Effort:** 2–3 hrs · **Tests:** add a table test covering bundle-root → target across both call sites; `resolve-reminder` hook tests.

### A2. N+1 template resolution re-runs `exec`/`service-probe` side effects — performance / correctness
- **Smell:** Hidden quadratic work plus repeated side effects.
- **Location:** `commands/self/lib.ts:421` `analyzeTemplateSections` (resolves each section in its own `resolveContextTemplateDetailed` call) combined with the callers that ALSO resolve the whole template: `self/explain.ts:167` + `:174`, and `self/prompt.ts:175` + `:185`.
- **Detail:** For an N-section template, `analyzeTemplateSections` issues N separate `resolveContextTemplateDetailed` calls (one synthetic single-section template each), and `explainPrompt` / `buildSystemPayload` additionally resolve the full template once more — so a section is resolved roughly twice and the whole template ~N+1 times. For `exec` sections this re-spawns the command, and for `service-probe` sections it re-hits the probed services, once per analysis pass, with `--sections`. Side-effecting template sections are executed far more often than the user expects from a read-only `inspect`/`explain`.
- **Suggested:** Resolve the full template **once** with a "per-section breakdown" option (have `resolveContextTemplateDetailed` return per-section sizes/inclusion), and derive `SectionReport[]` from that single result instead of re-resolving section-by-section. If the runtime API can't yet return per-section data, cache `exec`/`service-probe` results within a single command invocation.
- **Risk:** Med (touches the runtime resolver contract or adds a cache) · **Effort:** 0.5 day · **Tests:** `self/__tests__` for explain/prompt `--sections`; assert exec sections run once.

### A3. `self inspect --json` serializes the whole `SelfContext`, leaking a non-serializable function and unfiltered fields — leaky abstraction / contract
- **Smell:** Spreading an internal struct directly into a public JSON contract.
- **Location:** `commands/self/inspect.ts:42` (`{ ...ctx, derived: {...} }`).
- **Detail:** `SelfContext` includes `lookup: (key) => string | null` (`lib.ts:58`), which `JSON.stringify` silently drops — so the JSON shape depends on which fields happen to be functions. It also emits the full `launch` artifact and `injectedEnv`. Because the JSON output is a machine contract for clod/cody, dumping the entire internal struct couples consumers to incidental fields and means any new internal field on `SelfContext` becomes an unintended public output. (`self paths --json` at `paths.ts:54` correctly hand-picks fields — `inspect` should match that discipline.)
- **Suggested:** Define an explicit `InspectJsonPayload` shape and project only the intended fields, mirroring `paths.ts`. Drop `lookup` from the serialized surface explicitly.
- **Risk:** Low (but it IS a contract change if a consumer relied on a leaked field) · **Effort:** 1–2 hrs · **Tests:** snapshot the `inspect --json` keys.

### A4. `readLaunchArtifactLite` returns an unvalidated `as LaunchArtifactLite` from arbitrary JSON — missing edge-case handling
- **Smell:** Unsafe cast presenting untrusted data as a typed struct.
- **Location:** `commands/self/lib.ts:245` (`return { artifact: parsed as LaunchArtifactLite, ... }`).
- **Detail:** After confirming `parsed` is a non-null, non-array object, every field is trusted via a blanket cast. `argv` is later iterated (`extractSystemPrompt`/`extractPrimingPrompt` call `argv.indexOf`), and `env` is passed to `filterInjectedEnv`. If the launch file contains `{ "argv": "oops" }` or `{ "env": [] }`, `argv.indexOf` / `Object.entries` will throw or misbehave at a call site far from the parse, defeating the "lenient" intent stated in the function's own doc comment. `filterInjectedEnv` partially guards (`typeof value === 'string'`) but `extractSystemPrompt` does not guard that `argv` is an array.
- **Suggested:** Coerce defensively at the boundary — e.g. `argv: Array.isArray(parsed.argv) ? parsed.argv.filter(x => typeof x === 'string') : []`, `env: isRecord(parsed.env) ? parsed.env : {}` — or run it through a small validator so malformed-but-present fields degrade to defaults instead of throwing later.
- **Risk:** Low · **Effort:** 1–2 hrs · **Tests:** add malformed-artifact cases (string `argv`, array `env`) to `self/lib` tests.

### A5. Duplicated `readOptionalFile` across the self family — DRY
- **Smell:** Identical helper copy-pasted.
- **Location:** `commands/self/prompt.ts:275` and `commands/self/explain.ts:402` (byte-identical), plus an inline `existsSync`/`readFileSync` pattern in `resolve-reminder.ts:196` and `lib.ts:218`.
- **Suggested:** Move `readOptionalFile(path: string | null): string | null` into `self/lib.ts` and import it in both commands.
- **Risk:** Low · **Effort:** 15 min · **Tests:** existing self command tests.

### A6. `process.exit(2)` for usage errors is hand-rolled and inconsistent with the `index.ts` `CliUsageError` path — OCP / consistency
- **Smell:** Two parallel error-exit conventions in one CLI.
- **Location:** Manual `stderr.write(...) + process.exit(2)` in `self/prompt.ts:113,119,124,129`, `self/explain.ts:96`, `self/paths.ts:45`, `self/memory/{scan-cmd,snapshot-cmd,diff-cmd}.ts`. Meanwhile `index.ts:115-119` routes Commander/`CliUsageError` through `cli-kit`'s `exitWithError(...)`.
- **Detail:** The `self` subcommands invent their own "invalid argument → exit 2" handling instead of throwing a `CliUsageError` that the central `main()` handler already formats. This means usage-error formatting (prefix, color, JSON-vs-text) is decided per command and won't track future changes to `cli-kit`'s error renderer.
- **Suggested:** Throw `new CliUsageError(message)` (from `cli-kit`) for invalid `which`/`--kind`/mutually-exclusive-flag cases and let the existing top-level handler emit them, instead of writing stderr + `process.exit(2)` inline.
- **Risk:** Med (exit code 2 vs whatever `CliUsageError` maps to must be preserved if tests assert it) · **Effort:** 2–3 hrs · **Tests:** `self/__tests__` exit-code assertions.

### A7. `formatWhenPredicate` evaluated twice in a single expression — micro-inefficiency / readability
- **Location:** `commands/self/lib.ts:445` — `...(formatWhenPredicate(section) ? { when: formatWhenPredicate(section) } : {})`.
- **Detail:** The predicate is computed once for the truthiness test and again for the value. Harmless but wasteful and mildly error-prone if the function ever becomes non-pure.
- **Suggested:** `const when = formatWhenPredicate(section); ...(when ? { when } : {})`.
- **Risk:** Low · **Effort:** 5 min · **Tests:** none.

### A8. Mid-function `require('node:fs')` is reachable on a common path (not only dry-run) — code smell (extends first-pass quick-win #1)
- **Location:** `commands/run.ts:165` inside `hasAgentProfile`, called from `detectRunMode` at `run.ts:197`.
- **Detail:** The first pass flagged the inline `require` stylistically. Adding context: `hasAgentProfile` runs during run-mode detection for the no-project / agent-profile fallback path (`detectRunMode` step 4), so the CJS `require` in an ESM module executes on real launches, not just an edge path. It also synchronously stats the filesystem inside what reads like a pure predicate. Worth pairing the hoist with a top-level `import { existsSync } from 'node:fs'`.
- **Risk:** Low · **Effort:** 5 min · **Tests:** `--dry-run` smokes already cover mode detection.

### Updated code-smell table (new rows only)

| Smell | Location | Severity |
|-------|----------|----------|
| Two divergent `inferTargetFromBundleRoot` copies | `self/lib.ts:161` + `resolve-reminder.ts:109` | 🟠 |
| N+1 template resolution re-runs exec/probe side effects | `self/lib.ts:421` + `explain.ts:167`/`prompt.ts:175` | 🟠 |
| Whole `SelfContext` (incl. a function) spread into JSON contract | `self/inspect.ts:42` | 🟡 |
| Unvalidated `as LaunchArtifactLite` from arbitrary JSON | `self/lib.ts:245` | 🟡 |
| Duplicated `readOptionalFile` ×2 (byte-identical) | `self/prompt.ts:275`, `self/explain.ts:402` | 🟡 |
| Hand-rolled `process.exit(2)` usage errors vs central `CliUsageError` | `self/{prompt,explain,paths}.ts`, `self/memory/*` | 🟡 |
| Predicate evaluated twice in one expression | `self/lib.ts:445` | 🟡 |
