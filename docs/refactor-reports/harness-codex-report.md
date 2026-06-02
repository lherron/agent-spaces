# 🔧 Refactoring Analysis

**Target:** `packages/harness-codex/src`
**Lines analyzed:** 2,941 (non-test source across 8 files)
**Generated:** 2026-06-01  ·  **Focus:** all

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🔴 | `codex-adapter.ts` (1,221 lines) and `CodexSession` (786 lines) each mix many unrelated concerns — discovery, hashing, TOML/hooks, materialize, compose, run-arg building; session mixes RPC lifecycle, event mapping, permissions, attachments, file IO. |
| Open/Closed | 🟡 | Codex thread-item kind dispatch is duplicated as parallel `switch` chains in three places; every new item type forces edits in all of them. |
| Liskov Substitution | 🟢 | No broken overrides, no `throw "not implemented"`, no base-behavior-dropping no-ops. Adapters implement their interfaces fully. |
| Interface Segregation | 🟡 | `HarnessAdapter` is a fat interface and `CodexAdapter` is correspondingly large; `CodexSessionConfig` has 16 mostly-optional fields acting as a grab-bag. |
| Dependency Inversion | 🟡 | `CodexSession.start()` directly `spawn`s `codex` and `new CodexRpcClient(...)`; one-shot path takes an injected `proc` but session path does not — no seam for the process/RPC collaborator, making the spawn untestable without a real binary. |

## 🎯 Priority Refactorings

### 1. Duplicated Codex event-mapping engine — DRY / OCP / SRP
- **Location:** `codex-session/codex-session.ts:32-157, 498-663, 716-786` vs `codex-session/run-one-shot.ts:12-124, 410-595`
- **Current:** Two files independently define the **same** `CodexThreadItem` union, the same notification interfaces (`ThreadStartResponse`, `TurnStartResponse`, `TurnCompletedNotification`, `ItemStarted/CompletedNotification`, `AgentMessageDeltaNotification`, `CommandExecutionOutputDeltaNotification`, `FileChangeOutputDeltaNotification`, `McpToolCallProgressNotification`, `ErrorNotification`), and near-identical `handleItemStarted` / `handleItemCompleted` per-item-type `switch` dispatchers, plus copies of `buildToolResult`, `buildUserInputs`, and `formatCodexError`. The two `handleNotification` methods route the same JSON-RPC method names to the same unified events. This is roughly 300+ duplicated lines.
- **Suggested:** Extract a shared module (e.g. `codex-session/event-mapping.ts`) holding the `CodexThreadItem` union, the notification-param interfaces, and pure `mapItemStarted(item) → UnifiedSessionEvent[]` / `mapItemCompleted(item) → { events; finalOutput? }` functions plus `buildToolResult` / `buildUserInputs` / `formatCodexError`. Both `CodexSession` and `runCodexAppServerOneShot` consume the shared mapper; each keeps only its own lifecycle/turn-completion glue. This collapses three parallel `switch` ladders into one (OCP) and removes the drift risk where one path supports an item kind the other silently ignores (`run-one-shot` already diverges with a `'unknown'` variant and a `thread/tokenUsage/updated` case the session path lacks).
- **Risk:** Med  ·  **Effort:** ~0.5–1 day  ·  **Tests:** `codex-session.test.ts`, `run-one-shot.test.ts`, `codex-session.getMetadata.test.ts` already exercise both paths; add a focused unit test for the extracted mapper.

### 2. `codex-adapter.ts` is a 1,221-line god module — SRP
- **Location:** `adapters/codex-adapter.ts:1-1222`
- **Current:** One file owns: launch-descriptor building (`buildCodexAppServerLaunchDescriptor`), hooks config + trust-state hashing (`buildCodexHookGroup`, `buildHrcCodexHooksConfig`, `buildCodexHookTrustState`, `addCodexHookTrustState`, `normalizedCodexHookHash`, `canonicalJson`, `versionForCodexTomlValue`, `trustCodexHooksInConfigToml`), praesidium-context AGENTS.md editing, codex binary discovery (`codexCommandCandidates`, `nvmCodexCandidates`, `runCommand`, semver helpers), config merging (`applyDottedKey`, `mergeCodexConfig`, `buildCodexConfig`), plus the `CodexAdapter` class with `detect/validateSpace/materializeSpace/composeTarget/buildRunArgs/loadTargetBundle/...`.
- **Suggested:** Split into cohesive modules under `adapters/`: `codex-discovery.ts` (binary candidates + version detection + `runCommand`), `codex-hooks.ts` (hooks config + trust-state hashing + canonicalization), `codex-config.ts` (dotted-key merge + `buildCodexConfig`), `codex-agents.ts` (`buildAgentsMarkdown` + praesidium block edit). `codex-adapter.ts` retains only the `CodexAdapter` class orchestrating these. Improves testability and shrinks the blast radius of edits to any one concern.
- **Risk:** Med (many exported symbols; check `index.ts` re-exports and importers in execution/HRC)  ·  **Effort:** ~1 day  ·  **Tests:** `codex-adapter.test.ts`, `codex-adapter.model-reasoning-effort.test.ts`; keep public export surface identical.

### 3. `CodexSession.handleNotification` (107 lines) + dual item dispatch — SRP / Long Method
- **Location:** `codex-session/codex-session.ts:382-489` (`handleNotification`), `:498-572` (`handleItemStarted`), `:574-663` (`handleItemCompleted`)
- **Current:** `handleNotification` is a single 100+ line method dispatching ~11 RPC method names, several inline-casting `notification.params` and emitting events; the item handlers are two more large switch ladders. The class mixes RPC routing, turn-artifact accumulation, permission resolution, and event emission.
- **Suggested:** Once finding #1 is extracted, this method reduces to a thin router delegating item events to the shared mapper and turn/artifact events to small private helpers (`onTurnCompleted`, `onTurnDiff`, `onTurnPlan`). Consider a `Map<method, handler>` table instead of the `switch` to flatten the routing.
- **Risk:** Med  ·  **Effort:** ~0.5 day (mostly subsumed by #1)  ·  **Tests:** `codex-session.test.ts`.

### 4. `buildRunArgs` branching + `detect` nested loop — Long Method / Deep Nesting
- **Location:** `adapters/codex-adapter.ts:1063-1140` (`buildRunArgs`), `:670-740` (`detect`)
- **Current:** `buildRunArgs` interleaves exec/resume/prompt mode branches with feature-flag appends and per-option `if` pushes (~77 lines). `detect` is a `try` wrapping a `for` over candidates with nested `try/catch` per sub-command and multiple `continue` paths reaching ~70 lines and 4+ nesting levels.
- **Suggested:** For `buildRunArgs`, extract `buildExecArgs`, `buildResumeArgs`, `buildInteractiveArgs` and a shared `appendCommonFlags(args, options)`. For `detect`, extract `probeCandidate(candidate): { detection } | { error }` so the loop body is one call; collect errors and return on first success.
- **Risk:** Low  ·  **Effort:** ~0.5 day  ·  **Tests:** existing adapter tests cover arg shapes; add cases per mode.

### 5. Direct `spawn` + `new CodexRpcClient` inside `CodexSession.start` — DIP
- **Location:** `codex-session/codex-session.ts:187-223`
- **Current:** `start()` calls `spawn(command, args, …)` and `new CodexRpcClient(this.proc, …)` directly. The headless `runCodexAppServerOneShot` already accepts an injected `proc`, so the two paths are inconsistent and the interactive session cannot be unit-tested without a real `codex` binary.
- **Suggested:** Inject a process/transport factory (e.g. `config.spawnProc?: (cmd, args, opts) => ChildProcessWithoutNullStreams`) defaulting to `node:child_process.spawn`, or accept an optional pre-spawned `proc` like the one-shot path does. Provides a clean test seam and unifies the two entry points.
- **Risk:** Low  ·  **Effort:** ~0.25 day  ·  **Tests:** `codex-session.test.ts` could then drive a fake proc.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Large duplicated type/handler blocks across two files | `codex-session.ts` vs `run-one-shot.ts` | 🟠 |
| God file (1,221 lines, mixed concerns) | `adapters/codex-adapter.ts:1` | 🟠 |
| Long method (107 lines) | `codex-session.ts:382` `handleNotification` | 🟠 |
| Long method + deep nesting (~70 lines, nested try/for/try) | `codex-adapter.ts:670` `detect` | 🟡 |
| Long method (~77 lines, mode branching) | `codex-adapter.ts:1063` `buildRunArgs` | 🟡 |
| Repeated `as <Notification>` casts on `notification.params` (no runtime validation) | `codex-session.ts:382-489`, `run-one-shot.ts:192-276` | 🟡 |
| Magic numbers | `codex-adapter.ts:289` (`600` default timeout), `codex-session.ts:25` (`10 * 1024 * 1024`), `:1172` (`size > 2` mcp probe) | 🟡 |
| Repeated inline closure `Awaited<ReturnType<typeof runCommand>>` + per-call try/catch | `codex-adapter.ts:678-719` | 🟡 |
| Grab-bag config object with 16 optional fields | `types.ts:36-52` `CodexSessionConfig` | 🟡 |
| Duplicated optional-spread conditionals (`...(x !== undefined ? {x} : {})`) repeated dozens of times | `codex-adapter.ts:104-126`, `register.ts:17-31` | 🟡 |
| `String(error)` / `error instanceof Error ? … : String(error)` ternary duplicated ~10× | throughout `codex-adapter.ts`, `codex-session.ts` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Extract the duplicated `error instanceof Error ? error.message : String(error)` pattern into a tiny `errorMessage(err): string` helper used across the package.
2. Name the magic numbers: `DEFAULT_HOOK_TIMEOUT_SECONDS = 600`, `MIN_MCP_CONFIG_BYTES = 2` (the `size > 2` mcp probe), alongside the existing `MAX_IMAGE_BYTES`.
3. Pull the shared `CodexThreadItem` union into one module and import it in both `codex-session.ts` and `run-one-shot.ts` (smallest first step toward finding #1 — pure type move, zero runtime change).
4. In `detect`, hoist the repeated `Awaited<ReturnType<typeof runCommand>>` into a named type alias to de-noise the three probe calls.

## ⚠️ Technical Debt Notes

- The two event-mapping paths have already begun to **drift**: `run-one-shot.ts` handles `thread/tokenUsage/updated` and a `'unknown'` item variant, while `codex-session.ts` does not; `codex-session.ts` handles `turn/diff/updated` and `turn/plan/updated` artifacts that the one-shot path ignores. Until finding #1 is addressed, every protocol change to the codex app-server must be applied in two places and will keep diverging.
- `notification.params` is cast with `as` everywhere without runtime validation; a malformed/renamed field from the codex app-server surfaces as `undefined` at use-site rather than a clear parse error. Consider a thin validation layer (or schema) at the RPC boundary.
- `CodexAdapter` exports many internal helpers (hooks/trust hashing, `trustCodexHooksInConfigToml`) presumably consumed by HRC/execution; before splitting (finding #2) confirm the external import surface via `src/index.ts` so the public re-exports stay stable and boundary checks pass.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (`codex-adapter.test.ts`, `codex-adapter.model-reasoning-effort.test.ts`, `codex-session.test.ts`, `codex-session.getMetadata.test.ts`, `run-one-shot.test.ts`)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run tests between each
- [ ] Run `bun run typecheck`, `bun run lint`, `bun run check:boundaries`, `bun run check:manifests` after structural moves
- [ ] Keep the public export surface in `src/index.ts` identical when splitting `codex-adapter.ts`; verify cross-repo consumers (HRC/ACP) still resolve
- [ ] Run the harness-broker matrix smoke (`bun run smoke:matrix --config fake-codex` at minimum) since event-mapping changes affect normalized broker vocabulary
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

Fresh-eyes pass focused on error-handling, async/cleanup correctness, races, and contract gaps the first pass did not list. The first pass covered structural/SRP/DRY duplication well; these items are about runtime correctness and resource lifecycle.

### A1. child stderr is never drained — pipe-buffer deadlock risk — Missing edge case / resource bug
- **Location:** `codex-session/codex-session.ts:206-210` (`spawn(command, args, { stdio: 'pipe' })`) and `codex-session/rpc-client.ts:54` (only `proc.stdout` is consumed)
- **Issue:** `CodexRpcClient` reads `proc.stdout` via a readline interface but **nothing ever reads `proc.stderr`**. With `stdio: 'pipe'`, the child's stderr is a flowing-disabled pipe; if the codex app-server writes more than the OS pipe buffer (~64 KB) to stderr without anyone draining it, the child blocks on write and the whole session deadlocks. It also means all app-server diagnostics are silently discarded, hurting debuggability. The one-shot path inherits the same `proc` so it is exposed too (caller-spawned). Either `.resume()`/drain stderr, pipe it to the events-output sink, or use `stdio: ['pipe','pipe','inherit']`.
- **Risk:** Low to apply  ·  **Effort:** ~0.25 day  ·  **Severity:** 🟠 (latent hang)

### A2. `CodexRpcClient.close()` leaks the readline interface and process listeners — Resource cleanup
- **Location:** `codex-session/rpc-client.ts:54-67` (creates `rl = createInterface(...)`, registers `proc.on('error')` + `proc.on('exit')`) vs `:96-99` (`close()` only does `this.proc.stdin.end()`)
- **Issue:** `close()` never calls `rl.close()` and never removes the `error`/`exit` listeners it attached. The readline interface keeps a `'line'` listener on `proc.stdout`, and the two `proc.on(...)` handlers stay registered for the process's lifetime. In a long-lived host that creates/destroys many `CodexSession`s (or restarts after `handleError`), these accumulate — a slow listener/handle leak. `close()` should `rl.close()` and detach listeners (track the `rl` handle and bound handlers).
- **Risk:** Low  ·  **Effort:** ~0.25 day  ·  **Severity:** 🟡

### A3. `start()` can clobber an `error` state back to `running` — Race / swallowed failure
- **Location:** `codex-session/codex-session.ts:212-271`
- **Issue:** During `start()` the RPC client is wired up first (`onError`/`onNotification` live), then a sequence of `await rpc.sendRequest(...)` runs. An async `onError` (e.g. process `exit`, or an `error` notification) calls `handleError()` which sets `this.state = 'error'`. But the `try` block unconditionally sets `this.state = 'running'` at line 267 after the awaits resolve, silently overwriting the error. The `catch` only sets `error` when the awaited request itself rejects; an error that arrives *between* awaits but doesn't reject the in-flight request leaves the session "running" while the child may be dead. `start()` should re-check `this.state` (or a sticky error flag) before committing to `running`.
- **Risk:** Med  ·  **Effort:** ~0.25 day  ·  **Severity:** 🟠

### A4. `CodexSession` notifications are not serialized, unlike one-shot — Inconsistent concurrency model
- **Location:** `codex-session/codex-session.ts:213-215` (`onNotification: (n) => this.handleNotification(n)`) vs `run-one-shot.ts:170-184` (`notificationQueue = notificationQueue.then(() => handleNotification(...))`)
- **Issue:** The one-shot path deliberately chains notifications through a `notificationQueue` promise to serialize async handling; the long-lived session path invokes `handleNotification` synchronously with no ordering guard. `handleNotification` is currently sync so ordering holds today, but the two sibling paths having opposite concurrency contracts is a latent trap: any future `await` added inside the session handler (e.g. async permission pre-fetch, or A1's stderr-to-sink) would silently interleave turn/item events and corrupt `turnArtifacts`/`items` accumulation. Align both on the same serialized model.
- **Risk:** Med  ·  **Effort:** ~0.25 day  ·  **Severity:** 🟡

### A5. `stop()` does not flush the events-output write chain — Lost data on shutdown
- **Location:** `codex-session/codex-session.ts:318-329` (`stop`) and `:372-380` (`recordMessage` appends via `this.eventsOutputPromise` chain)
- **Issue:** Event-log writes are queued onto `eventsOutputPromise` (sequential `appendFile`s). `stop()` closes the RPC and kills the proc but never awaits `eventsOutputPromise`, so any in-flight or queued appends can be lost when the process/host tears down right after `stop()`. `stop()` (and arguably `handleError`) should `await this.eventsOutputPromise` (best-effort) before resolving.
- **Risk:** Low  ·  **Effort:** ~0.1 day  ·  **Severity:** 🟡

### A6. URL image attachments bypass the size guard applied to file images — Asymmetric validation
- **Location:** `codex-session/codex-session.ts:758-783` (`buildUserInputs`)
- **Issue:** File-path image attachments are `stat`'d and rejected over `MAX_IMAGE_BYTES` (line 770-773), but `kind === 'url'` image attachments are pushed straight through with no size/validation. A non-image, non-readable `file` attachment also degrades silently to a `Attached file: <path>` text breadcrumb with no existence check, so a typo'd path is invisibly dropped rather than surfaced (contradicts the project's "never silently capture errors" rule for the run path). Decide whether the size cap is intentional for files only; if not, document why URL images are exempt.
- **Risk:** Low  ·  **Effort:** ~0.25 day  ·  **Severity:** 🟡

### A7. `resolvePendingTurn` turn-id matching can strand the prompt promise — Edge case
- **Location:** `codex-session/codex-session.ts:491-496`
- **Issue:** `resolvePendingTurn(turnId)` returns without resolving when `this.currentTurnId && turnId && this.currentTurnId !== turnId`. If a stale/secondary `turn/completed` arrives, or `currentTurnId` was updated by a later `turn/started` before the matching `turn/completed` lands, the pending `sendPrompt` promise can be left unresolved and `sendPrompt` hangs forever (no timeout). There is no timeout/abort guard on `await pending` in `sendPrompt` (line 305). Consider keying pending turns by id explicitly and/or adding a turn timeout.
- **Risk:** Med  ·  **Effort:** ~0.25 day  ·  **Severity:** 🟡

### A8. `handleRequest` default-rejects unknown approval requests, blocking the turn — Contract gap
- **Location:** `codex-session/codex-session.ts:665-701` (throws `Unhandled Codex request`) vs `rpc-client.ts:187-195` (turns a handler throw into a `-32000` error response *and* calls `handleError`, killing the session)
- **Issue:** Any approval/request method the session doesn't explicitly handle (e.g. a newly added codex request kind) causes `handleRequest` to throw, which `CodexRpcClient.handleRequest` converts into both an error response and a session-fatal `handleError`. So a single unrecognized RPC request from a newer app-server tears down an otherwise healthy session. The one-shot path is safer here (only two known methods, declines, throws only truly-unknown). A forward-compatible default (decline + warn notice) would be more resilient than fail-the-session.
- **Risk:** Med  ·  **Effort:** ~0.25 day  ·  **Severity:** 🟡

### A9. `recordMessage` write-failure escalates to fatal session error — Disproportionate error handling
- **Location:** `codex-session/codex-session.ts:374-379`
- **Issue:** If appending to `eventsOutputPath` fails (disk full, perms), the `.catch` calls `this.handleError(...)`, which kills the RPC and the child process. A diagnostic side-channel write failure should not terminate the live agent session; it should log/emit a `notice` and continue. This couples observability plumbing to session liveness.
- **Risk:** Low  ·  **Effort:** ~0.1 day  ·  **Severity:** 🟡

### A10. Test gap: no coverage for stderr/exit/listener-cleanup or events-output flush — Test gaps
- **Location:** package tests (`codex-session/*.test.ts`, `rpc-client` has **no** dedicated test file)
- **Issue:** `rpc-client.ts` (the JSON-RPC framing, pending-promise rejection on exit, drain backpressure at `:204-207`, unknown-response-id handling at `:148-153`) has no direct unit test — it's only exercised indirectly through the shim. There is no test for: process exit rejecting all pending requests, `writeMessage` after `close()` throwing, the `start()`-state-clobber race (A3), or events-output flush on `stop()` (A5). Adding a focused `rpc-client.test.ts` with a fake duplex proc would lock down the riskiest concurrency surface cheaply.
- **Risk:** Low  ·  **Effort:** ~0.5 day  ·  **Severity:** 🟡

### A11. Adapter swallows discovery errors into a generic "not detected" outcome — Error visibility
- **Location:** `adapters/codex-adapter.ts:670-740` (`detect`), per the first pass's line refs (nested `try/catch` per candidate that `continue`s on failure)
- **Issue (refinement, not a dup of #4):** #4 flagged `detect` as a long/deeply-nested method. The distinct *behavioral* smell is that each probe's `catch` discards the underlying error and `continue`s, so when `codex` exists but fails for a real reason (permission denied, version-flag crash, corrupt binary) the user gets an undifferentiated "not detected" rather than the actual cause. This conflicts with the CLAUDE.md directive that the run path should never silently capture errors. `probeCandidate` (suggested in #4) should additionally surface the last non-ENOENT error rather than dropping it.
- **Risk:** Low  ·  **Effort:** ~0.25 day (folds into #4)  ·  **Severity:** 🟡
