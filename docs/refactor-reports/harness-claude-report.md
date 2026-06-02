# 🔧 Refactoring Analysis

**Target:** `packages/harness-claude/src`
**Lines analyzed:** 3,278 (non-test source); 11 source files
**Generated:** 2026-06-01  ·  **Focus:** all

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🔴 | `AgentSession` (958 LOC) mixes SDK lifecycle, message decoding, tool tracking, event emission, and subagent-context bookkeeping in one class. `ClaudeAdapter` (523 LOC) mixes detection, validation, materialization, composition, statusline install, and CLI-arg building. |
| Open/Closed | 🟡 | SDK message decoding is a growing chain of `if (type === ...)`/`if (msgType === ...)` blocks in three places. Adding a new content-block or message type requires editing every chain. |
| Liskov Substitution | 🟢 | No throwing/no-op overrides; `ClaudeAgentSdkAdapter` cleanly delegates and only rewrites `harnessId`. Both adapters honor the `HarnessAdapter` contract. |
| Interface Segregation | 🟢 | `HarnessAdapter` is wide but every member is implemented meaningfully; `HookEventBusAdapter` is small and focused. No stubbed-out members. |
| Dependency Inversion | 🟡 | `AgentSession.start()` calls the SDK `query()` free function directly and reads `process.env`/`process.pid`, so the SDK and process globals can't be substituted in tests. `detect.ts` caches in a module-level `let cachedInfo` singleton. |

## 🎯 Priority Refactorings

### 1. Duplicated SDK-message decoding logic across two files — DRY / SRP
- **Location:** `agent-sdk/agent-session.ts:577-694, 860-951` and `agent-sdk/hooks-bridge.ts:300-463`
- **Current:** `resolveToolUseId`, `normalizeToolResultBlocks`, `processToolUseBlock`, `processToolResultBlock`, and `emitUserToolResultIfNeeded` are implemented near-verbatim in **both** `agent-session.ts` and `hooks-bridge.ts`. `normalizeToolResultBlocks` (text/image/media_ref/resource_link/resource handling) is ~75 lines copy-pasted; `resolveToolUseId` is identical; the tool-name/tool-input extraction ternaries (`name ?? tool_name ?? 'tool'`, `input ?? tool_input`) recur 4+ times. The two copies have already drifted (the agent-session copy carries `structured_content` into `details`; the hooks-bridge copy into `tool_response`), which is exactly the bug-divergence risk duplication creates.
- **Suggested:** Extract a shared `sdk-message-decode.ts` (or `tool-blocks.ts`) module exporting `resolveToolUseId`, `normalizeToolResultBlocks`, `extractToolName`, `extractToolInput`, and a `forEachToolBlock(content, { onToolUse, onToolResult })` visitor. Have both `AgentSession` and `processSDKMessage` consume it. This collapses the two divergent copies into one source of truth.
- **Risk:** Med  ·  **Effort:** 0.5–1 day  ·  **Tests:** `agent-session.getMetadata.test.ts` plus add focused unit tests for the new decode module covering each block type and the `structured_content`/`is_error` branches.

### 2. `AgentSession` is a god class — SRP
- **Location:** `agent-sdk/agent-session.ts:58-737` (class body ~680 LOC, 25+ members)
- **Current:** One class owns: SDK query lifecycle (`start`/`stop`/`interrupt`), the output-listener loop with a stop-sentinel race (`listenToOutput`, ~100 LOC), message-to-event mapping (`handleSdkMessage`, `handleToolBlocks`, `processToolUseBlock`, `processToolResultBlock`), tool-use registry (`toolUses` map + counter), subagent-context state machine (`currentSubagentContext`), six emit-once latches (`hasEmittedAgentStart`, `stopEmitted`, etc.), and assistant-text extraction. Many `private` methods and several module-level free functions (`mapSdkMessage`, `mapSdkContent`) belong to a "decode SDK message → UnifiedSessionEvent" concern that is orthogonal to session lifecycle.
- **Suggested:** Split into (a) `AgentSession` (lifecycle + state + delegating to a translator), (b) a `SdkEventTranslator`/`MessageMapper` that holds the tool-use map + subagent context and turns raw SDK messages into `UnifiedSessionEvent[]`, and (c) keep `mapSdkMessage`/`mapSdkContent`/`normalizeToolInput` in the shared decode module from #1. The translator can be unit-tested without spinning up the SDK.
- **Risk:** Med–High (touches the hot streaming path)  ·  **Effort:** 1–2 days  ·  **Tests:** Keep `getMetadata` test green; add translator tests fed canned SDK message fixtures; verify broker matrix smoke (`bun run smoke:matrix --config fake-codex`) still produces the normalized event vocabulary.

### 3. `listenToOutput` is a long method with triplicated turn-flush cleanup — Long Method / DRY
- **Location:** `agent-sdk/agent-session.ts:355-457`
- **Current:** ~100-line method combining the iterator/stop-promise race, init-message parsing, plugin-name logging, response-text capture, message dispatch, and result handling, with a `try/catch/finally` where the `while (this.pendingTurnIds.length > 0) this.emitTurnEndIfNeeded()` flush plus an `emitStopIfNeeded` appears in all three of the catch, the finally, and partially the happy path. The state-transition logic (`running → error`, `running → stopped`) is spread across the three blocks.
- **Suggested:** Extract `private flushPendingTurns()` and `private finalizeState(reason)` helpers and a `private processMessage(value)` method so the loop body is a few lines. Centralize the "drain pending turn_end + emit stop" sequence in one helper called from each exit path.
- **Risk:** Med  ·  **Effort:** 0.5 day  ·  **Tests:** As #2; explicitly cover the mid-turn-crash path (catch branch) and clean-exit-without-result path (finally branch).

### 4. `ClaudeAdapter` mixes too many responsibilities — SRP
- **Location:** `adapters/claude-adapter.ts:74-518`
- **Current:** A single class implements detection, space validation, per-space materialization (fs linking, hooks.json generation), target composition (plugin copy, MCP compose, settings merge, statusline install), CLI-arg construction, env construction, and default-option resolution. `composeTarget` (135 LOC) alone does plugin copying, MCP composition, a nested permissions-merge loop, and best-effort statusline patching.
- **Suggested:** This is largely orchestration over `spaces-config` helpers, so it cannot be fully decomposed without changing the adapter contract — but the bulky bodies of `composeTarget` and `buildRunArgs` should move to free functions (e.g. `composeClaudeSettings(input)`, `installStatusline(outputDir, settings)`, `buildSessionArgs(options)`, `buildRemoteControlArgs(...)`). The class then reads as a thin coordinator and each piece is independently testable.
- **Risk:** Low–Med  ·  **Effort:** 1 day  ·  **Tests:** `claude-adapter.test.ts` and `claude-agent-sdk-adapter.test.ts`; re-run `asp run <space> --dry-run` per CLAUDE.md to confirm generated args are unchanged.

### 5. Direct SDK / process-global coupling blocks substitution — DIP
- **Location:** `agent-sdk/agent-session.ts:128, 131, 140, 155-159`
- **Current:** `start()` calls the imported `query(...)` free function directly, reads `process.pid`, and spreads `process.env` into options. There is no seam to inject a fake SDK, so `AgentSession`'s lifecycle/error paths can only be exercised against the real SDK (the only test present is `getMetadata`).
- **Suggested:** Inject a `queryFactory: (args) => Query` (defaulting to the real `query`) via the constructor `opts`, and read pid/env through a tiny `runtimeEnv` seam. Enables deterministic unit tests of `listenToOutput`, stop/interrupt, and the crash-flush behavior.
- **Risk:** Low  ·  **Effort:** 0.5 day  ·  **Tests:** New unit tests using a fake `Query` async iterator.

### 6. Open/Closed: content-block type dispatch is a hardcoded chain — OCP
- **Location:** `agent-sdk/agent-session.ts:772-858` (`mapSdkContent`), `:875-951` and `hooks-bridge.ts:387-463` (`normalizeToolResultBlocks`)
- **Current:** Each block kind (`text`, `image`, `media_ref`, `resource_link`, `resource`, `tool_use`, `tool_result`) is an explicit `if (type === ...)` arm, repeated across three functions. Supporting a new block type means editing every arm in every copy.
- **Suggested:** After #1 unifies the copies, drive block conversion from a small `Record<blockType, (block) => ContentBlock | undefined>` handler table so new types are added in one place.
- **Risk:** Low  ·  **Effort:** 0.25 day (folds into #1)  ·  **Tests:** Decode-module unit tests per block type.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Duplicated code (`normalizeToolResultBlocks` ~75 LOC verbatim in two files) | `agent-session.ts:875` / `hooks-bridge.ts:387` | 🟠 |
| Duplicated code (`resolveToolUseId` identical in two files) | `agent-session.ts:868` / `hooks-bridge.ts:375` | 🟠 |
| Duplicated tool-name/tool-input extraction ternaries (4+ occurrences) | `agent-session.ts:536-543,602-614,634-640` | 🟡 |
| Long method (`listenToOutput`, ~100 LOC) | `agent-session.ts:355-457` | 🟠 |
| Long method (`composeTarget`, ~135 LOC) | `claude-adapter.ts:240-375` | 🟠 |
| Long method (`buildRunArgs` with nested IIFE for remote-control args) | `claude-adapter.ts:380-451` | 🟡 |
| God class (`AgentSession`, 25+ members, ~680 LOC body) | `agent-session.ts:58-737` | 🟠 |
| Boolean-latch flag soup (6 emit-once flags) | `agent-session.ts:74-82` | 🟡 |
| Module-level mutable singleton cache | `detect.ts:33` (`let cachedInfo`) | 🟡 |
| `console.log`/`console.error` used for structured diagnostics (no injectable logger) | `agent-session.ts:151,218,252,348,427`; `hooks-bridge.ts` (none) | 🟡 |
| Best-effort `try {} catch {}` swallows statusline write errors silently | `claude-adapter.ts:350-363` | 🟡 |
| Primitive obsession: SDK messages passed as `Record<string, unknown>` and re-narrowed everywhere | `agent-session.ts`, `hooks-bridge.ts` throughout | 🟡 |
| `as any` casts at SDK boundary (2) | `agent-session.ts:144,157` | 🟡 |
| Magic number `maxTurns ?? 100` | `agent-session.ts:137` | 🟡 |
| Dead/unused constant (`_COMPONENT_DIRS` never referenced) | `validate.ts:49` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Extract `resolveToolUseId` and `normalizeToolResultBlocks` into one shared module and delete the duplicate copies (immediate de-duplication, kills the existing `structured_content` drift).
2. Hoist the `maxTurns ?? 100` default and `SHELL: '/bin/bash'` into a named constant in `agent-session.ts`.
3. Remove the unused `_COMPONENT_DIRS` constant in `validate.ts:49`.
4. Pull `buildSessionArgs` and `buildRemoteControlArgs` out of `buildRunArgs` (including the inline IIFE) into small named free functions — pure, easy to unit-test.
5. Replace the silent statusline `catch {}` with a warning pushed onto the returned `warnings` array so the best-effort failure is at least observable (note: keep it non-fatal per the "statusline is best-effort" intent — this does not violate the `asp run` never-swallow rule, which targets run errors, not composition cosmetics).

## ⚠️ Technical Debt Notes

- The decode duplication between `agent-session.ts` and `hooks-bridge.ts` has **already diverged** (`structured_content` routing, `tool_use` standalone-message handling exists only in agent-session). Every future SDK schema change must be applied in two places or behavior silently splits between the event stream and the hook stream. This is the single highest-leverage cleanup.
- `AgentSession` has essentially no unit coverage beyond `getMetadata` because the SDK `query()` and `process` globals are hardwired. The error/crash-flush paths (`listenToOutput` catch/finally) are the most fragile code in the package and are currently untested; the DIP fix (#5) is a prerequisite to covering them.
- `ClaudeAgentSdkAdapter` is a thin delegation wrapper over `ClaudeAdapter`. This is fine, but it means any SRP cleanup of `ClaudeAdapter` automatically benefits both harness IDs — refactor once.
- `detect.ts` module-level `cachedInfo` is process-global; tests must call `clearClaudeCache()` between cases. Consider an instance-scoped detector if test isolation becomes a problem.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (add decode-module + translator unit tests before #1/#2)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run tests between each (`bun run test`, `bun run typecheck`)
- [ ] Run `bun run lint` and `bun run check:boundaries` after each change
- [ ] Re-run `asp run <space> --dry-run` after touching `buildRunArgs` to confirm generated args are byte-identical
- [ ] Run `bun run smoke:matrix --config fake-codex` after touching `AgentSession`/event emission to confirm the normalized broker event vocabulary is unchanged
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

The first pass concentrated on `agent-session.ts` / `hooks-bridge.ts` / `claude-adapter.ts` SRP/DRY/OCP structure. This pass focused on correctness — error handling, async/cleanup, races, dead wiring, contract surface, and test gaps — across the under-examined files (`prompt-queue.ts`, `invoke.ts`, `register.ts`, `detect.ts`).

### A1. `PromptQueue.close()` does not wake a parked consumer — async/race deadlock (Correctness, high)
- **Smell/principle:** broken async handshake / lost-wakeup race.
- **Location:** `agent-sdk/prompt-queue.ts:104-112` (`close`) vs `:86-93` (the consumer `await new Promise`).
- **What:** When the async iterator is parked at `await new Promise(... this.waiting = (m) => resolve(m) ...)` and then `close()` is called, `close()` sets `this.waiting = null` (line 110) **without invoking the stored resolver**. The only path that resolves a waiting consumer with `null` is the `if (this.closed) resolve(null)` check at line 89, which runs **only at registration time** — i.e. only if the queue was already closed before the consumer parked. A consumer that parks first and is then closed never resolves: that `await` hangs forever, so the SDK's input `AsyncIterable` never terminates. `AgentSession.stop()` calls `promptQueue.close(reason)` (agent-session.ts:235) on the normal teardown path, so this can wedge the SDK input loop. The `stopPromise`/`outputIterator.return()` race in `stop()` happens to paper over it for the *output* side, but the input iterator itself is left dangling.
- **Fix:** Have `close()` capture and call the pending resolver with `null` (mirror `push`’s deliver-immediately pattern): `const w = this.waiting; this.waiting = null; w?.(/* null */)` — and change the resolver type so it can be resolved with `null` directly instead of relying on the closed-flag re-check.
- **Risk:** Med (touches teardown of the hot session) · **Effort:** 0.5 day · **Tests:** none exist for `PromptQueue` (see A6) — add a test that parks the iterator, calls `close()`, and asserts the iterator completes.

### A2. `register.ts` hardcodes the hook event bus to `undefined` and never wires `onSdkSessionId` — dead wiring / leaky seam (DIP, Med)
- **Smell/principle:** an injection seam that is never injected; whole code path unreachable in production.
- **Location:** `register.ts:11-29` (second `AgentSession` ctor arg is literally `undefined`; no `opts.onSdkSessionId`).
- **What:** `AgentSession`’s constructor accepts a `HookEventBusAdapter` and an `onSdkSessionId` callback (agent-session.ts:92-99), and `HooksBridge` has an entire `hookEventBus`-driven permission/auto-allow branch (hooks-bridge.ts:98-130). The session-factory registered with `SessionRegistry` always passes `undefined`, so that branch is **dead** through the registry path — every permission decision falls through to the `permissionHandler` path, and `onSdkSessionId` resume-callback notifications never fire for registry-created sessions (resume relies on the emitted `sdk_session_id` event only). Either the bus should be threaded from `options`, or the `hookEventBus` parameter + its bridge branch should be removed as dead surface.
- **Risk:** Low (clarification / removal) · **Effort:** 0.25–0.5 day · **Tests:** add a registry test asserting the wired collaborators; or delete the dead branch and its `HookEventBusAdapter` export.

### A3. `canUseTool` ignores the SDK `AbortSignal` — missing cancellation (Correctness, Med)
- **Smell/principle:** dropped cancellation token; permission request can outlive its turn.
- **Location:** `agent-sdk/hooks-bridge.ts:57-62` — the callback signature receives `opts: { signal: AbortSignal }` but binds it as `_opts` and never observes `signal`.
- **What:** When the SDK aborts a turn (or `AgentSession.stop()` calls `abortController.abort()`, agent-session.ts:264) while a `permissionHandler.requestPermission(...)` / `hookEventBus.requestPermission(...)` is in flight, the awaited permission promise is **not** cancelled — it can resolve after teardown and return an `allow` decision for a turn that no longer exists, or leave the host’s permission UI waiting. The signal should be wired to reject/short-circuit the pending request (`opts.signal.addEventListener('abort', …)` or pass it through to the handler).
- **Risk:** Med (interrupt/stop correctness) · **Effort:** 0.5 day · **Tests:** simulate abort during a pending permission request and assert it rejects/denies promptly.

### A4. `invokeClaude` timeout path is silent and leaks the timer on error — error handling (Correctness, Med)
- **Smell/principle:** swallowed timeout outcome + resource leak on the throw path.
- **Location:** `claude/invoke.ts:244-273`.
- **What:** (a) On timeout, `setTimeout` calls `proc.kill()` (line 248) but the function still falls through to `return { exitCode, stdout, stderr }` with whatever exit code the kill produced — the caller gets **no signal that a timeout occurred** (no thrown `ClaudeInvocationError`, no flag). (b) `clearTimeout(timeoutId)` runs at line 254-255 *inside* the `try`, after `await proc.exited`. If `proc.exited` rejects (or any line between spawn and clear throws), control jumps to the `catch` (line 271) and the timer is **never cleared** — it leaks and will `proc.kill()` a process that may already be gone. (c) `proc.kill()` sends a single signal with no escalation/await, so a wedged child may survive the timeout. Move `clearTimeout` into a `finally`, and surface timeouts explicitly (throw or set a `timedOut` field).
- **Risk:** Low–Med · **Effort:** 0.5 day · **Tests:** `invoke.test.ts:382-497` covers `runClaudePrompt`/`spawnClaude` but has **no timeout test** — add one.

### A5. `agent_end` reason is decided by a teardown race between `stop()` and the listener `finally` — concurrency (Low–Med)
- **Smell/principle:** double-source emit guarded only by a latch, so the *payload* is nondeterministic.
- **Location:** `agent-sdk/agent-session.ts:281` (`stop()` → `emitAgentEnd(reason)`) and `:455` (listener `finally` → `emitAgentEnd(this.stopReason ?? …)`), latch at `:480-482`.
- **What:** The `hasEmittedAgentEnd` latch correctly prevents a *double* emit, but `stop()` awaits `this.outputListener` (line 277) which itself runs the `finally` that may call `emitAgentEnd` first. Whichever path wins sets the `reason` (caller-supplied `reason` vs `stopReason ?? 'error'/'stopped'`), so the observed `agent_end.reason` depends on scheduling. Centralize end-emission in one place (e.g. only the listener `finally` emits, with `stop()` setting `stopReason` before awaiting) so the reason is deterministic. Same shape applies to `emitSessionEnd()` (line 280) racing the listener’s final flush.
- **Risk:** Low–Med (observable event payload) · **Effort:** 0.5 day · **Tests:** unit test stop-during-active-turn and assert a single, deterministic `agent_end.reason` (depends on the DIP seam from first-pass #5).

### A6. Untested correctness-critical units: `PromptQueue` and the `invoke` timeout — test gap (Med)
- **Smell/principle:** zero coverage on the queue that feeds the SDK and on the timeout branch.
- **Location:** `agent-sdk/prompt-queue.ts` (no `*.test.ts` references it at all); `claude/invoke.ts:244-256` (timeout branch untested).
- **What:** `PromptQueue` owns the park/deliver/close handshake implicated in A1 and has **no tests**. Its `[Symbol.asyncIterator]` is reentrancy-unsafe (a single shared `this.waiting` slot means two concurrent consumers would clobber each other) — currently only one consumer exists, but nothing documents or guards that invariant. Add tests for: push-before-iterate, iterate-then-push (park/deliver), close-while-parked (A1), and `pendingCount`/`isClosed`.
- **Risk:** Low (tests only) · **Effort:** 0.5 day.

### A7. Unverified / likely-dead public API surface in `claude/index.ts` — contract surface (Low)
- **Smell/principle:** exported helpers with no in-repo consumers widen the published contract for free.
- **Location:** `claude/index.ts:26-32` re-exports `invokeClaude`, `invokeClaudeOrThrow`, `runClaudePrompt`, `spawnClaude` (and these are re-exported package-wide via `index.ts` `export * from './claude/index.js'`).
- **What:** A repo-wide grep finds **no non-test caller** of `spawnClaude`, `runClaudePrompt`, `invokeClaudeOrThrow`, or `invokeClaude` outside `invoke.ts`/its own test. For a cross-repo publishable boundary package this is permanent API surface (and maintenance/security weight for the `Bun.spawn` paths) with no internal user. Confirm whether HRC/ACP consume them; if not, narrow the export to what the adapters actually use (`buildClaudeArgs`/`formatClaudeCommand`/`getClaudeCommand` are the ones the dry-run path needs) and drop the rest.
- **Risk:** Low (but it is a published-API change) · **Effort:** 0.25 day · **Tests:** pack smoke (`cd packages/cli && bun scripts/smoke-test-pack.ts`) after pruning exports.

### A8. `detect.ts` PATH search ignores empty/whitespace PATH entries and never validates the binary is actually Claude — missing-edge-case (Low)
- **Smell/principle:** trust-on-first-executable; missing edge handling.
- **Location:** `claude/detect.ts:80-92` (`searchPath`) and `:181-198` (`detectClaude` hardcodes `supportsPluginDir/supportsMcpConfig: true`).
- **What:** `pathEnv.split(':')` (line 82) yields an empty string for an empty PATH segment (`::` or trailing `:`), making `join('', 'claude')` resolve to a relative `claude` that `access(X_OK)` will test against the *cwd* — a foot-gun that could pick up a `./claude` in the working directory. Also `queryVersion` failure silently yields `'unknown'` and `detectClaude` unconditionally asserts plugin/mcp support regardless of the detected version, so the `supports*` fields are decorative (they’re always `true`) — either compute them from `version` or drop them as misleading. `COMMON_CLAUDE_PATHS` also lists `/usr/local/bin/claude` twice (lines 49, 52).
- **Risk:** Low · **Effort:** 0.25 day · **Tests:** `detect.test.ts` — add an empty-PATH-segment case and a duplicate-path dedup assertion.
