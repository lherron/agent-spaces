# 🔧 Refactoring Analysis

**Target:** `packages/runtime/src`
**Lines analyzed:** 3,255 (non-test TypeScript; 18 source files)
**Generated:** 2026-06-01  ·  **Focus:** all (SRP, OCP, LSP, ISP, DIP) + code smells

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🔴 | `context-resolver.ts` (849 LOC) mixes template-variable interpolation, file IO, `exec`/bash execution, TCP/unix socket probing, truncation, byte-accounting, and diagnostics in one module. `system-prompt.ts` (419 LOC) mixes discovery, profile parsing, default-template TOML string-building, resolution orchestration, and file materialization. |
| Open/Closed | 🟡 | Section dispatch is `switch (section.type)` repeated across `resolveSection`, `describeSectionSource`, and `parseSection` in two parallel module families; adding a section type touches ≥5 switch sites. `parseServiceEndpoint` hardcodes the protocol/port whitelist. |
| Liskov Substitution | 🟢 | No inheritance hierarchies, no `throw "not implemented"` overrides, no base-class substitution issues. Tagged-union dispatch is used instead of subtyping. |
| Interface Segregation | 🟡 | `CreateSessionOptions` (`session/options.ts`) is a 30+-field "kitchen-sink" config object blending Claude/Agent-SDK, Pi, and Codex concerns; every consumer depends on fields it never reads. `ContextResolverContext` carries 14 optional fields. |
| Dependency Inversion | 🟡 | `session/factory.ts` reads a module-level mutable singleton (`let sessionRegistry`). Resolvers call `process.cwd()` / `process.env` directly. `MemoryStore` hard-spawns `python3`/`Bun.spawn` for locking with no injected lock provider. |

## 🎯 Priority Refactorings

### 1. Dead/duplicated legacy system-prompt path — SRP / DRY
- **Location:** `system-prompt-template.ts:1-305`, `system-prompt-resolver.ts:1-214`
- **Current:** Neither module is exported from `index.ts`, and a repo-wide grep finds **no importers outside their own `.test.ts` files**. They are the v1 system-prompt implementation, fully superseded by the v2 `context-template.ts` / `context-resolver.ts` pair. The two families duplicate near-identical logic: `resolveTemplateRef`, `readOptionalFile`, `joinResolvedContent`, `isMissingFileError`, `resolveExecSection`, `matchesWhenPredicate`, `resolveFileSection`, and the entire `describeValue` / `parseOptional*` parser-helper suite are copy-pasted between `system-prompt-resolver.ts` and `context-resolver.ts`, and between `system-prompt-template.ts` and `context-template.ts`.
- **Suggested:** Confirm the v1 path is retired, then delete both modules and their tests (~517 LOC + tests removed). If a v1 consumer still exists in HRC/ACP, instead extract the shared helpers into one internal module (e.g. `template-io.ts`) imported by both resolvers.
- **Risk:** Low (no internal importers)  ·  **Effort:** ~1h (delete) / ~3h (extract-shared)  ·  **Tests:** Remove `system-prompt-template.test.ts`, `system-prompt-resolver`-adjacent tests; run `bun run test` + `check:boundaries`.

### 2. `context-resolver.ts` is a god-module — SRP
- **Location:** `context-resolver.ts:1-849`
- **Current:** One 849-line file owns: variable-map construction (`buildVariableMap`, `buildScopeRef`, `buildHandle`, `formatLocalDate`), mustache interpolation, file reading, bash `exec` (`resolveExecSection`), **network service probing** (`parseServiceEndpoint`, `probeServiceEndpoint` — raw `net.connect` TCP/unix sockets), slot resolution, truncation (`truncateSectionContent`), byte counting, and global `max_chars` enforcement.
- **Suggested:** Split along seams: `template-vars.ts` (variable map + scope/handle/date builders + `interpolateVariables`/`expandTemplate`), `service-probe.ts` (`parseServiceEndpoint` + `probeServiceEndpoint`), `section-io.ts` (file/exec resolution), and keep `context-resolver.ts` as the orchestrator over `resolveZone`. The service-probe socket code in particular has zero conceptual overlap with prompt assembly.
- **Risk:** Med (heavily exercised resolution path)  ·  **Effort:** ~half day  ·  **Tests:** `context-resolver.test.ts`, `context-template.test.ts` should pass unchanged; add focused unit tests on the extracted modules.

### 3. `buildVariableMap` duplicates every key in 3 naming conventions — SRP / maintainability
- **Location:** `context-resolver.ts:652-690`
- **Current:** The same values are emitted under camelCase (`agentRoot`), snake_case (`agent_root`), `path.*` namespace (`path.agentRoot`), and legacy aliases (`agent_name`, `agents_root`, `project_root`, `project_id`, `run_mode`) — `agentRoot` appears 3 times, `projectRoot` 4 times. Adding a variable means remembering to add 2-4 aliases by hand.
- **Suggested:** Define a canonical key list plus an explicit `ALIASES: Record<string,string>` map and expand programmatically, so the source-of-truth value lives once. Document the alias table in one place.
- **Risk:** Low  ·  **Effort:** ~1h  ·  **Tests:** Variable-interpolation cases in `context-resolver.test.ts`.

### 4. `system-prompt.ts` mixes discovery, TOML string-building, and IO — SRP
- **Location:** `system-prompt.ts:117-155` (`materializeSystemPrompt`), `:359-419` (`buildDefaultTemplateToml`/`buildScaffoldSectionsToml`/`fileSectionToml`)
- **Current:** The module discovers templates, parses `agent-profile.toml`, **emits a default template by concatenating TOML strings** (`buildDefaultTemplateToml` builds `[[prompt]]` text that is then re-parsed by `parseContextTemplate`), orchestrates resolution, and writes files (`writeMaterializedPrompt`/`writeMaterializedContext`). The build-TOML-string-then-reparse round-trip is fragile (manual `quoteTomlString = JSON.stringify`) and couples this file to TOML syntax it shouldn't know.
- **Suggested:** Construct a `ContextTemplate` object directly instead of synthesizing-and-reparsing TOML; move the two `writeMaterialized*` functions into a `materialize-io.ts`; move profile loading into a `agent-profile.ts` loader.
- **Risk:** Med  ·  **Effort:** ~half day  ·  **Tests:** `system-prompt.test.ts`, `system-prompt-cleanup.test.ts`.

### 5. Section-type dispatch is duplicated across switch sites — OCP
- **Location:** `context-resolver.ts:268-286` (`describeSectionSource`), `:321-339` (`resolveSection`); `context-template.ts:183-260` (`parseSection`)
- **Current:** Each new `ContextSectionType` requires editing three independent `switch` statements (parse, resolve, describe) plus the `CONTEXT_SECTION_TYPES` literal. The type system does not force all three to stay in sync.
- **Suggested:** Introduce a per-type handler table keyed by `ContextSectionType` with `{ parse, resolve, describe }`, so adding a type is one registry entry. At minimum, centralize the section-type tuple as the single source the switches are checked against.
- **Risk:** Med  ·  **Effort:** ~half day  ·  **Tests:** template + resolver suites.

### 6. Mutable module-singleton session registry — DIP
- **Location:** `session/factory.ts:5-16`
- **Current:** `let sessionRegistry: SessionRegistry | undefined` is global mutable state set via `setSessionRegistry`. `createSession` throws at call time if it was never configured (a temporal-coupling hazard), and tests cannot run in parallel with different registries.
- **Suggested:** Make `createSession` take the registry (or a factory closure) explicitly, or expose `registry.createSession(options)` as a method so the dependency is passed, not ambiently mutated.
- **Risk:** Low-Med (small blast radius but public-ish seam)  ·  **Effort:** ~2h  ·  **Tests:** `session/registry.test.ts`; check consumers in `execution`/`cli`.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| God module / long file (849 LOC) | `context-resolver.ts:1` | 🟠 |
| Dead code (no importers) | `system-prompt-template.ts`, `system-prompt-resolver.ts` | 🟠 |
| Duplicated helpers across v1/v2 families (`resolveTemplateRef`, `readOptionalFile`, `joinResolvedContent`, `isMissingFileError`, `describeValue`, `parseOptional*`) | `system-prompt-resolver.ts:178-213` vs `context-resolver.ts:793-849`; `system-prompt-template.ts:226-304` vs `context-template.ts:390-480` | 🟠 |
| Triplicated variable aliases | `context-resolver.ts:662-689` | 🟡 |
| Build-string-then-reparse round-trip (TOML synthesized then `parseContextTemplate`d) | `system-prompt.ts:359-419` | 🟡 |
| Long parameter object / kitchen-sink config (30+ fields) | `session/options.ts:7-40` | 🟡 |
| Magic numbers (caps `2200`/`1375`/`8192`, `MAX_CHARS_WARNING_RATIO = 0.9`, ports `443`/`80`, `1024*1024`) | `agent-memory/paths.ts:42,49,58`; `context-resolver.ts:109,442-444,372` | 🟡 |
| Spawns `python3` for advisory file locking; silently degrades to in-process lock | `agent-memory/store.ts:247-282` | 🟡 |
| Mutable module-level counters/maps (`tempCounter`, `lockQueues`) | `agent-memory/store.ts:47-48` | 🟡 |
| Swallowed errors via bare `catch {}` (exec failure → `undefined`, probe error → `false`) — intentional but undocumented | `context-resolver.ts:377,447`; `system-prompt-resolver.ts:136` | 🟡 |
| Duplicated `ENTRY_DELIMITER` constant defined in two files | `agent-memory/store.ts:7` and `agent-memory/scan.ts:17` | 🟡 |
| `as string` / `as number` casts bypassing the `ParsedEndpoint` union | `context-resolver.ts:459-460` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Delete the unused v1 modules `system-prompt-template.ts` + `system-prompt-resolver.ts` (and their tests) once confirmed retired — removes ~517 LOC of duplicated logic (Finding 1).
2. Export `ENTRY_DELIMITER` from `scan.ts` (or a shared constants module) and import it into `store.ts` to kill the duplicated `'\n§\n'` literal.
3. Name the memory cap magic numbers in `paths.ts` (`MEMORY_CAP_CHARS = 2200`, etc.) with a comment on their origin.
4. Collapse `joinResolvedContent`/`joinCommandContent` in `context-resolver.ts` (lines 821-841) — they differ only by separator; parameterize the join string.

## ⚠️ Technical Debt Notes

- **Two parallel template systems coexist.** v1 (`system-prompt-*`, schema_version 1, `[[section]]`) and v2 (`context-*`, schema_version 2, `[[prompt]]`/`[[reminder]]`). v2 is the only one wired into `index.ts`. Carrying v1 doubles the parser/resolver surface and the maintenance cost of every section-type change. Decide and delete.
- **Memory locking relies on an external `python3` binary** (`store.ts:247`) with a fallback to a best-effort in-process queue. This is a portability and correctness risk (cross-process safety is silently lost if `python3` is absent). Consider a native `flock`/`proper-lockfile`-style dependency or document the contract.
- **Resolvers reach into ambient globals** (`process.cwd()` at `context-resolver.ts:298`, `process.env` fallbacks). This makes section `when.exists` predicates depend on the caller's working directory, which is implicit and hard to test deterministically; inject `cwd`/`env` via the context object that already exists.
- **`CreateSessionOptions` aggregates three harnesses' options.** As more harnesses land, this object grows unbounded (ISP). Consider per-harness option sub-objects (`claude?: {...}`, `codex?: {...}`, `pi?: {...}`).

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (resolver/template/memory suites exist; verify legacy-deletion doesn't drop unique coverage)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run tests between each (`bun run test`)
- [ ] Run `bun run typecheck`, `bun run lint`, `bun run check:boundaries`, `bun run check:manifests`
- [ ] Confirm no HRC/ACP cross-repo consumer imports the v1 system-prompt modules before deleting them
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

These are issues not raised in the first pass. They emphasize error-handling /
resource-cleanup / concurrency / API-contract concerns rather than file size.

### A1. Temp file leaks on atomic-write rename failure — resource cleanup
- **Location:** `agent-memory/store.ts:186-205` (`atomicWrite`)
- **Smell:** Missing cleanup on the error path. The `try/finally` only guarantees
  `handle.close()`. If `rename(tempPath, config.path)` throws (EXDEV across a
  bind-mount, EACCES, ENOSPC, or a throwing `beforeAtomicRename` test hook), the
  `${path}.tmp.${pid}.${counter}` file is left on disk forever. Repeated failures
  accumulate orphan temp files next to the memory file.
- **Suggested:** Wrap the post-write phase so a failed rename unlinks the temp
  file before rethrowing (e.g. `try { ...hooks...; await rename(...) } catch (e) {
  await rm(tempPath, { force: true }); throw e }`).
- **Risk:** Low  ·  **Effort:** ~30m  ·  **Tests:** add a `store.test.ts` case
  that makes `beforeAtomicRename` throw and asserts no `.tmp.` file remains.

### A2. Advisory-lock child process: stderr piped but never drained — deadlock risk
- **Location:** `agent-memory/store.ts:248-282` (`acquireAdvisoryLock`)
- **Smell:** `Bun.spawn` is created with `stderr: 'pipe'` but nothing ever reads
  that stream. If `python3` writes enough to stderr (e.g. a `fcntl`/`Traceback`
  on an unusual platform, or a deprecation warning) the child can block on a full
  pipe buffer and the `await reader.read()` on stdout never resolves — hanging the
  whole `withTargetLock` call. The first pass flagged the *python dependency* and
  silent degradation; it did not flag this drain/hang hazard. Note also: on the
  happy path the child is kept alive holding the OS lock, and `stderr` is never
  consumed for its full lifetime.
- **Suggested:** Use `stderr: 'ignore'` (or actively drain it), and/or add a
  timeout around the initial `reader.read()` so a stuck child falls back to the
  in-process queue instead of hanging.
- **Risk:** Med (rare but unbounded hang)  ·  **Effort:** ~1h  ·  **Tests:** hard
  to unit-test directly; at minimum switch to `'ignore'` and keep the existing
  fallback path covered.

### A3. `MemoryStore.replace`/`remove` match by substring `includes`, not whole-entry — edge-case correctness
- **Location:** `agent-memory/store.ts:237-245` (`findMatches`), used by `replace:132` and `remove:149`
- **Smell:** `findMatches` selects entries via `entry.includes(oldSubstr)`. A short
  `old` string that is a substring of several distinct entries yields
  `ambiguous_match` even when the caller meant an exact entry; conversely a string
  spanning what the user thinks of as one logical note will silently match a
  larger entry and replace/delete the whole thing. There is no anchoring,
  trimming, or exact-match fast path. This is a quiet data-loss footgun for the
  mutate APIs.
- **Suggested:** Try exact-entry equality first (after trim) and only fall back to
  substring; or expose a `match: 'exact' | 'contains'` option. Document the
  matching contract in the `StoreResult` union.
- **Risk:** Med (data loss on mis-match)  ·  **Effort:** ~2h  ·  **Tests:** add
  `store.test.ts` cases for substring-overlap across entries and exact match.

### A4. `detectAvailable` has no per-adapter timeout — hang/liveness
- **Location:** `harness/registry.ts:86-105` (`detectAvailable`), also via `getAvailable:112`
- **Smell:** `Promise.all(... adapter.detect() ...)` awaits every adapter with no
  timeout. `detect()` typically shells out to probe a binary; a single hung
  detection (slow PATH lookup, stuck child, NFS stat) blocks the entire
  `detectAvailable()` / `getAvailable()` indefinitely. The `try/catch` only
  converts *thrown* errors into `available:false`; it does nothing for a probe
  that never returns.
- **Suggested:** Wrap each `adapter.detect()` in a `Promise.race` against a
  configurable timeout that resolves to `{ available:false, error:'timeout' }`.
- **Risk:** Low-Med  ·  **Effort:** ~1h  ·  **Tests:** `registry.test.ts` with a
  fake adapter whose `detect()` never resolves.

### A5. `UnifiedSession.onEvent` has no unsubscribe / replace semantics — API contract gap
- **Location:** `session/types.ts:178` (`onEvent`); `:179` (`setPermissionHandler`)
- **Smell:** `onEvent(callback): void` returns nothing, so a registered listener
  can never be removed. Across a long-lived session (resume, re-attach, host UI
  re-render) callers can only ever *add* listeners, risking duplicate dispatch
  and listener leaks; and the contract for multiple registrations (append vs.
  replace) is unspecified. `setPermissionHandler` similarly has ambiguous
  replace-vs-stack semantics. This is a public-surface (ISP/contract) gap not
  noted in the first pass, which focused on `CreateSessionOptions`.
- **Suggested:** Return an unsubscribe disposable (`onEvent(cb): () => void`) and
  document single-vs-multi listener behavior in the interface JSDoc.
- **Risk:** Low (additive)  ·  **Effort:** ~2h incl. implementor updates  ·
  **Tests:** verify implementors honor the disposable.

### A6. `acquireProcessLock` keeps a global `lockQueues` map keyed by raw lock path — cross-instance global state
- **Location:** `agent-memory/store.ts:47,284-301`
- **Smell:** The fallback in-process lock queue is a *module-level* `Map`, so two
  independent `MemoryStore` instances (or two test cases) that resolve to the same
  `lockPath` share one queue, and a never-released holder (e.g. an `action` that
  hangs) wedges the path for the whole process with no timeout or diagnostics. The
  first pass listed `lockQueues`/`tempCounter` as "mutable module-level state" in
  the smell table but did not call out the cross-instance coupling or the
  no-timeout starvation risk of the queue itself.
- **Suggested:** Scope the queue to the `MemoryStore` instance (or an injected
  lock provider), and consider a max-wait timeout that rejects rather than queues
  forever.
- **Risk:** Low-Med  ·  **Effort:** ~2h  ·  **Tests:** `store.test.ts` parallel
  mutate on the same target from two `MemoryStore` instances.

### A7. `detectAvailable` / `getAvailable` swallow the underlying error type — observability
- **Location:** `harness/registry.ts:94-100`
- **Smell:** A thrown detection error is flattened to `error.message` only;
  stack/cause is dropped and the failure is otherwise silent (no log, no
  rethrow). Combined with A4 this makes a misbehaving adapter invisible to
  callers, who only see `available:false`. Intentional-but-undocumented swallow,
  similar to the `catch {}` cases the first pass flagged in `context-resolver.ts`
  but in a different module.
- **Risk:** Low  ·  **Effort:** ~30m (attach `cause`, optional debug log)  ·
  **Tests:** existing `registry.test.ts` detection-throws case.
