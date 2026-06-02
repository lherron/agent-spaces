# 🔧 Refactoring Analysis

**Target:** `packages/harness-pi-sdk/src`
**Lines analyzed:** 2674 (non-test source, 10 files)
**Generated:** 2026-06-01  ·  **Focus:** all

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🔴 | `pi-session.ts` (737L) and `pi-sdk-adapter.ts` (704L) each mix many concerns; `mapPiEventToUnified` + `mapToolResultContent` are oversized; `runner.ts` `main()` does arg parsing, SDK loading, hook wiring, model resolution, and mode dispatch. |
| Open/Closed | 🟡 | Event mapping (`mapPiEventToUnified`) and hook-emit (`emitHookForEvent`) are large `switch` statements keyed on event `type`; `parseArgs` is a hand-rolled flag `switch`; adding a content-block / event type means editing several branches. |
| Liskov Substitution | 🟢 | No `throw "not implemented"` overrides or base-behavior-dropping subclasses. `getDefaultRunOptions`/`validateSpace` are legitimately empty contract methods. |
| Interface Segregation | 🟡 | `PiSessionConfig` carries 19 optional fields, several unused by the live code path (`systemPrompt`, `additionalExtensionPaths`, `extensions`, `skills`, `contextFiles` are accepted but never read in `pi-session.ts`). `HarnessAdapter` is a fat interface but externally defined. |
| Dependency Inversion | 🟡 | `PiSession.start()` directly news up `AuthStorage`, `ModelRegistry`, `SessionManager` and reads `process.env`/`homedir()` inline — no injection seam, so the auth/model/session wiring is untestable in isolation. `runner.ts` and `pi-bundle.ts` reach for `process.env`, `Bun.spawn`, `console` directly. |

## 🎯 Priority Refactorings

### 1. Whole-file duplication: `bundle.ts` ≈ `runner.ts` hook machinery — DRY / SRP
- **Location:** `pi-session/bundle.ts:65-294` vs `pi-sdk/pi-sdk/runner.ts:170-398`
- **Current:** `loadBundle`, `resolveHookScriptPath`, `runHookScript`, and the entire `buildHookExtension` (the env construction, the `runHooks` closure, the four `pi.on(...)` registrations, the `asp-hook` `sendMessage` formatting) are duplicated almost verbatim in two files. The only differences are `pi as ExtensionApi` casting and an `ExtensionFactory` return type. The `PiSdkBundle*` interfaces are ALSO redeclared a third time inside `runner.ts:24-51` and a fourth inside `pi-sdk-adapter.ts:69-96`.
- **Suggested:** Extract the shared hook runtime (`runHookScript`, `resolveHookScriptPath`, `buildHookExtension`, `loadBundle`) into one internal module (e.g. `pi-session/hook-runtime.ts`) and have both `bundle.ts` and `runner.ts` import it. Hoist the `PiSdkBundle*` manifest/entry types into a single `bundle-manifest-types.ts` consumed by all four sites.
- **Risk:** Med  ·  **Effort:** ~0.5 day  ·  **Tests:** `pi-session.test.ts`, plus a new unit test for the extracted hook runner; verify `bun run smoke:matrix --config fake-codex` still wires hooks.

### 2. `mapToolResultContent` — duplicated block-mapping arms / SRP / OCP
- **Location:** `pi-session/pi-session.ts:653-729`
- **Current:** 77-line function with three near-identical `item => { if image / if media_ref / if text ... }` mapping bodies (the array branch at 657-687 and the object-content branch at 692-720 are copy-paste). Magic shape-narrowing via inline `as { type: string; text?; data?; ... }` casts repeated four times.
- **Suggested:** Extract one `mapContentItem(item: unknown): ContentBlock` helper and call it from both `Array.isArray` and `obj.content` branches. Reuse it in `mapContentBlocks` (619-650) which performs the same image/media_ref/text/toolCall fan-out.
- **Risk:** Low  ·  **Effort:** ~2h  ·  **Tests:** add table-driven cases to `pi-session.test.ts` covering string / array / `{content:[]}` / scalar results.

### 3. `PiSession.start()` hardwires its collaborators — DIP / SRP
- **Location:** `pi-session/pi-session.ts:75-135`
- **Current:** Inside one method: env-var precedence resolution, `homedir()` join, `resolveAuthStoragePath` filesystem probing, `AuthStorage.create`, `ModelRegistry.create`, model lookup with a `console.warn` fallback, `SessionManager` selection (3-way ternary at 103-108), and `createAgentSession`. All concrete SDK constructors are called directly, so none of this is substitutable for tests.
- **Suggested:** Introduce a `PiRuntimeFactory` seam (`{ createAuthStorage, createModelRegistry, createSessionManager, createAgentSession }`) defaulting to the real SDK, injected via `PiSessionConfig`. Move auth-path/global-dir resolution into a small pure helper returning a resolved config object so `start()` only orchestrates.
- **Risk:** Med  ·  **Effort:** ~0.5 day  ·  **Tests:** unit-test the resolver helper; existing `getMetadata`/`pi-session` tests stay green.

### 4. `mapPiEventToUnified` — long method + growing type switch — SRP / OCP
- **Location:** `pi-session/pi-session.ts:428-594`
- **Current:** 166-line `switch` over 11 event `type`s; several arms (`turn_end`, `message_end`, `agent_end`) embed nontrivial held-message logic plus inline mapping of tool results. Adding an event type or changing finalization semantics means editing this single block.
- **Suggested:** Split into a per-event handler map (`Record<PiEvent['type'], (e, sessionId, state) => UnifiedSessionEvent[]>`) or at minimum extract the `turn_end`/`message_end`/`agent_end` bodies into named functions (`handleTurnEnd`, `handleMessageEnd`, `handleAgentEnd`) that operate on `PiEventMappingState`. The held-latest invariants are well-documented in comments — preserve them verbatim.
- **Risk:** Med (subtle held-latest state machine)  ·  **Effort:** ~0.5 day  ·  **Tests:** the held-latest behavior must be locked by `pi-session.test.ts` before refactoring; add final:true/false ordering assertions.

### 5. `materializeSpace` / `composeTarget` — repeated "stat-dir-then-readdir" + swallowed catches — SRP / DRY
- **Location:** `adapters/pi-sdk-adapter.ts:302-330`, `379-499`, `643-676`
- **Current:** The pattern `try { stat(dir).isDirectory(); copyDir/readdir; push } catch { /* doesn't exist */ }` is repeated ~9 times for extensions/skills/hooks/context, and the `hasSkills`/`hasHooks`/`hasContext` probes at 471-499 repeat a fourth `readdir-then-length` idiom three times. `composeTarget` is ~205 lines doing dir setup, four artifact-merge loops, auth symlinking, settings.json generation, and manifest emission.
- **Suggested:** Extract `copyDirIfPresent(src, dest)` and `dirHasEntries(dir): boolean` helpers; split `composeTarget` into `mergeArtifacts(...)`, `writeAuthSymlink(...)`, `writeSettings(...)`, `writeBundleManifest(...)`.
- **Risk:** Low  ·  **Effort:** ~0.5 day  ·  **Tests:** add a compose unit/integration test asserting bundle.json + settings.json contents.

### 6. Model-spec delimiter inconsistency — latent bug worth flagging
- **Location:** `runner.ts:539` (`args.model.split(':')`) vs adapter model ids like `'openai-codex/gpt-5.5'` (`pi-sdk-adapter.ts:61,192-200`)
- **Current:** `runner.ts` requires `provider:model` (colon) and throws `'Model must be specified as provider:model'`, but the adapter's `DEFAULT_PI_SDK_MODEL` and `models[]` all use `provider/model` (slash). `pi-session.ts` instead consumes separate `provider`+`model` config fields. The colon-split path appears unreachable with the slash-formatted defaults and would throw if ever exercised.
- **Suggested:** Unify on one model-spec format and one parser shared by adapter + runner + session. Not a mechanical refactor — confirm the intended delimiter before changing.
- **Risk:** Med (behavioral)  ·  **Effort:** ~3h  ·  **Tests:** add a runner arg-parse test asserting the accepted format.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Duplicated module (hook runtime + manifest types across 2-4 files) | `bundle.ts:65-294`, `runner.ts:24-51,170-398`, `pi-sdk-adapter.ts:69-96` | 🟠 |
| Long method (166 lines) | `pi-session.ts:428-594` `mapPiEventToUnified` | 🟠 |
| Long method (77 lines) with duplicated arms | `pi-session.ts:653-729` `mapToolResultContent` | 🟠 |
| Long method (205 lines) | `pi-sdk-adapter.ts:353-558` `composeTarget` | 🟠 |
| Long method (~90 lines) | `pi-sdk-adapter.ts:249-351` `materializeSpace` | 🟡 |
| Empty `catch {}` swallowing errors (~12 sites) | `pi-sdk-adapter.ts:313,328,395,412,444,466,477,487,497,511,654,664,674`; `runner.ts:150,270` | 🟡 |
| Confused param typing: `options` treated as both string and `PromptOptions` | `pi-session.ts:146` (`typeof (options as unknown) === 'string'`) | 🟠 |
| Mutating event via cast instead of typed field | `pi-session.ts:524` `(event as { textDelta?: string }).textDelta = delta` | 🟡 |
| Magic strings / `as`-cast shape narrowing repeated | `pi-session.ts:660-685,694-717` tool-result block casts | 🟡 |
| Hand-rolled flag parser (no shared cli-kit usage) | `runner.ts:65-140` `parseArgs` | 🟡 |
| Dead/unused config surface (accepted, never read) | `types.ts:44-50` `systemPrompt`,`additionalExtensionPaths`,`extensions`,`skills`,`contextFiles` vs `pi-session.ts` | 🟡 |
| `console.warn`/`console.error` as primary error channel | `pi-session.ts:97,150,222`; `runner.ts:464-468,575` | 🟡 |
| Direct env / homedir / Bun.spawn reads (no seam) | `pi-session.ts:85-86`; `pi-sdk-adapter.ts:204,502,597`; `pi-bundle.ts:50`; `runner.ts:247` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Extract `mapContentItem(item)` from `mapToolResultContent` and reuse in both array/object branches (kills ~40 duplicated lines). (Finding 2)
2. Hoist the `PiSdkBundleManifest`/`*Entry` interfaces into one shared types file; delete the three redeclarations. (Finding 1, types only — low risk)
3. Add `copyDirIfPresent` / `dirHasEntries` helpers in the adapter to collapse the repeated stat/readdir/try-catch idioms. (Finding 5)
4. Replace the `typeof (options as unknown) === 'string'` runId hack (`pi-session.ts:146`) with a clear `options?.runId` read once `PromptOptions` is the only accepted shape.

## ⚠️ Technical Debt Notes

- The hook-execution logic exists in two living copies (`bundle.ts` library path and `runner.ts` standalone path). They have already drifted slightly (cast style, return type). Any security/escaping fix to `runHookScript` (which uses `shell: true`) must be applied in both places today — a classic shotgun-surgery hazard.
- `runner.ts` model parsing (`provider:model` colon) is inconsistent with the adapter's slash-formatted model ids; the colon path looks unreachable. Treat as a latent bug, not a pure refactor (Finding 6).
- `PiSessionConfig` advertises an extension/skill/contextFile/systemPrompt surface that the current `PiSession` implementation ignores; either wire it through or trim it so the contract reflects reality (ISP).
- Pervasive empty `catch {}` blocks conflict with the repo's CLAUDE.md "never silently capture errors" guidance for the run path; audit which of these genuinely mean "optional dir absent" vs. which mask real IO failures.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (especially held-latest event ordering and tool-result mapping)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run tests between each
- [ ] Run `bun run test`, `bun run typecheck`, `bun run lint` after each step
- [ ] Run `bun run smoke:matrix --config fake-codex` to validate hook + event wiring end-to-end
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

Fresh-eyes pass focused on error-handling, async/cleanup correctness, the contract surface, and dead code. The items below are NOT in the first pass.

### A1. `--resume` arg crashes the runner — latent contract bug (correctness)
- **Smell:** Broken producer/consumer contract; unreachable-but-fatal branch.
- **Location:** Producer `adapters/pi-sdk-adapter.ts:591-595` (`buildRunArgs` pushes `--resume` when `options.continuationKey` is set) vs consumer `pi-sdk/pi-sdk/runner.ts:121-124` (`parseArgs` default branch throws `Unknown argument: ${arg}` for any token starting with `-`, and there is no `--resume` case).
- **Impact:** Any run that passes a `continuationKey` produces a command line the runner immediately rejects with a thrown error and `process.exit(1)`. The adapter comment even says "runner may not implement resume yet … we pass the flag for forward compatibility," but the runner does not tolerate unknown flags, so this is not forward-compatible — it is a guaranteed failure the moment resume is exercised.
- **Risk:** Med (behavioral, currently dormant)  ·  **Effort:** ~1h — either drop the `--resume` push or add a no-op (consume-and-ignore) `--resume` case to `parseArgs`. **Tests:** add a `buildRunArgs({continuationKey})` → `parseArgs` round-trip test.

### A2. `createPermissionHook` is dead code (dead code / DIP)
- **Smell:** Unused public export; abandoned abstraction.
- **Location:** `pi-session/permission-hook.ts:13-69` (entire `createPermissionHook` + `PermissionHookOptions`).
- **Impact:** This is the ONLY code that actually consults a `PermissionHandler`/`hookEventBus.requestPermission` to gate a `tool_call` (returning `{block:true}`). It is exported from `pi-session/index.ts` but never imported by `PiSession`, `register.ts`, the runner, or the adapter. The live `PiSession` path instead emits fire-and-forget `PreToolUse` hooks via `emitHookForEvent` (`pi-session.ts:240-276`) that can never block. So the package ships a permission-gating extension that is never wired in. Either wire it into the SDK session (see A3) or delete it; today it is a maintenance trap that looks load-bearing.
- **Risk:** Low (deletion) / Med (if wiring it in)  ·  **Effort:** ~1-3h.

### A3. `setPermissionHandler` stores a handler that is never read (broken feature / contract)
- **Smell:** Write-only field; silently no-op API.
- **Location:** `pi-session/pi-session.ts:60,71-73` — `permissionHandler` is assigned in `setPermissionHandler` and never referenced anywhere else in the class. `register.ts:25-27` dutifully calls `session.setPermissionHandler(options.permissionHandler)`.
- **Impact:** A caller wiring a `PermissionHandler` (the host-facing approval seam) reasonably expects tool calls to be gated. In the SDK session they are not — the handler is dropped on the floor and `createAgentSession` is invoked with no permission extension. This is a silent correctness gap: permissions appear configured but have zero effect. Pairs with A2 (the unused `createPermissionHook` is exactly what `start()` should register).
- **Risk:** Med (security/behavior)  ·  **Effort:** ~3h — register `createPermissionHook({ permissionHandler, hookEventBus, ... })` as an extension in `start()`. **Tests:** assert a denied tool_call yields `{block:true}`.

### A4. `PiSessionStartOptions.skills / extensions / contextFiles` are accepted but ignored by `start()` (ISP / leaky contract)
- **Smell:** Dead parameter surface (distinct from the first report's note on the *config* fields — this is the *start-options* object).
- **Location:** `pi-session/types.ts:55-61` declares `skills`, `extensions`, `contextFiles` on `PiSessionStartOptions`; `pi-session.ts:75-135` `start()` reads only `options.agentDir` / `options.globalAgentDir` and never references the other three. `createAgentSession` is called without `extensions`/`skills`/`contextFiles`, even though the runner path DOES pass all three.
- **Impact:** The SDK-session entry point cannot actually load extensions, skills, or context files — a real capability gap vs. the runner. Callers passing these get no error and no effect.
- **Risk:** Low (trim) / Med (wire through)  ·  **Effort:** ~2-4h.

### A5. `sendPrompt` state machine is a no-op race; `streaming` is never observable (concurrency / correctness)
- **Smell:** Misleading state transition; unsynchronized lifecycle.
- **Location:** `pi-session/pi-session.ts:137-155`.
- **Impact:** `start()` sets `streaming` then resets to `running` in a `finally` the instant `agentSession.prompt(text)` resolves. But assistant/tool events are delivered asynchronously through `subscribe` (`subscribeToEvents`, 226-237), and `prompt()` may resolve before or after the event stream drains depending on the SDK. So `getState()` realistically never reports `streaming` to an observer, and `isHealthy()` (180-182, which treats `streaming` as healthy) is effectively dead for that arm. There is also no re-entrancy guard: a second `sendPrompt` while one is in flight is allowed (state is `running`), risking interleaved prompts against one `AgentSession`.
- **Risk:** Med  ·  **Effort:** ~0.5 day — drive state off the event stream (e.g. set `running` on `agent_end`/`turn_end`, not in `finally`) and reject concurrent prompts. **Tests:** assert state observable as `streaming` mid-stream and that a concurrent `sendPrompt` throws.

### A6. `stop()` aborts without ordering/await guarantees; runs from `error` state (async cleanup)
- **Smell:** Fire-and-forget cleanup; unawaited resource teardown.
- **Location:** `pi-session/pi-session.ts:157-178`.
- **Impact:** (a) `agentSession.abort()` is not awaited and its result is ignored — if abort is async, `stop()` returns before the underlying session is actually torn down. (b) Although `unsubscribe()` is called first, any events the SDK emits synchronously during/after `abort()` (or a late async batch) still hit nothing harmful, but `lastActivityAt` bookkeeping and the `SessionEnd` hook fire regardless of whether `abort()` succeeded. (c) `stop()` only early-returns on `stopped`; calling it from the `error` state proceeds to abort a possibly-null/failed session and emits `SessionEnd` — arguably fine, but undocumented and untested. There is no idempotency test and no test that `stop()` releases the subscription.
- **Risk:** Low-Med  ·  **Effort:** ~2-3h — await abort if it returns a promise, guard null, add idempotency + cleanup tests.

### A7. `resolveSdkEntry` reads the entire candidate file just to test existence (performance / misuse)
- **Smell:** Wrong tool for an existence check; `byteLength >= 0` is a tautology.
- **Location:** `pi-sdk/pi-sdk/runner.ts:142-156` — `await readFile(entryPath)` then `if (file.byteLength >= 0) return entryPath`. The condition is always true for any file that reads (even empty), so this is an existence probe implemented by slurping the whole SDK bundle into memory.
- **Impact:** Loads a potentially large `dist/index.js` into a Buffer on every cold start solely to confirm it exists; the sibling adapter (`pi-sdk-adapter.ts:124-132`) correctly uses `access(path, F_OK)`. Inconsistent and wasteful.
- **Risk:** Low  ·  **Effort:** ~15m — switch to `fs.promises.access` (or `stat`). **Tests:** existing detect/runner paths.

### A8. `mapPiEventToUnified` default-parameter state silently breaks held-latest for stateless callers (leaky abstraction / footgun)
- **Smell:** Hidden per-call state; default that defeats the function's invariant.
- **Location:** `pi-session/pi-session.ts:431` (`state: PiEventMappingState = createPiEventMappingState()`).
- **Impact:** The held-latest finalization machine (held message, `agentActive`) only works if the SAME state object is threaded across calls. The default arg means any caller that omits `state` gets a fresh, empty state every invocation — so `flushHeld`, the `final:false`→`final:true` sequencing, and `agentActive` carry-across all silently degrade to "never holds, never finalizes correctly." This is exactly the kind of default that compiles, passes a single-event unit test, and misbehaves only in the multi-event production stream. Several existing tests call it WITHOUT state (e.g. `pi-session.test.ts:85,131,150`), reinforcing a usage that is invalid for real streams.
- **Risk:** Med (subtle)  ·  **Effort:** ~30m — make `state` a required parameter so the type system forces threading; update the single-event tests to pass explicit fresh state.

### A9. `composeTarget` ordering is deterministic for extensions only — hooks/context/skills are filesystem-ordered (reproducibility)
- **Smell:** Partial determinism; non-reproducible bundle manifest.
- **Location:** `adapters/pi-sdk-adapter.ts:384` sorts extension entries (`(await readdir(srcExtDir)).sort()`), but context entries (`readdir(srcContextDir, {withFileTypes:true})`, 452) and skill entries (403) are iterated in raw `readdir` order, and hook order follows `readHooksWithPrecedence` (423-442) without a final stable sort. The bundle.json `contextFiles`/`hooks` arrays therefore depend on OS/filesystem enumeration order across artifacts.
- **Impact:** Two composes of the same input can emit byte-different `bundle.json`, undermining cache keys / hash-stable bundles (the repo leans heavily on config-time determinism per `spaces-config`). The adapter test (`pi-sdk-adapter.test.ts:76-84`) only asserts extension ordering, masking this gap.
- **Risk:** Low-Med  ·  **Effort:** ~1h — sort context/skill `readdir` results and apply a stable sort to the emitted `hooks` array. **Tests:** extend the compose test to assert deterministic context/hook ordering.

### A10. `agent_start` resets `held` but a stray pre-`agent_start` message_end is silently lost (edge case)
- **Smell:** Unhandled boundary; silent drop.
- **Location:** `pi-session/pi-session.ts:434-437` — `case 'agent_start'` unconditionally does `state.held = undefined`.
- **Impact:** If a `message_end` arrives and is held just before an `agent_start` (out-of-order/late delivery, or a second prompt cycle reusing the same state without an intervening terminal), the held assistant message is dropped without ever emitting its `final:false` intermediate. The held-latest comments assume agent_start is always the clean opener; there is no test for held-message survival across an agent_start boundary.
- **Risk:** Low  ·  **Effort:** ~1h — flush any held message as `final:false` before resetting, or document the invariant and assert it.

### 📝 Additional Code Smells (second pass)

| Smell | Location | Severity |
|-------|----------|----------|
| Broken arg contract: `--resume` emitted but rejected by parser | `pi-sdk-adapter.ts:591`, `runner.ts:121-124` | 🟠 |
| Dead module: `createPermissionHook` exported, never wired | `permission-hook.ts:13-69` | 🟠 |
| Write-only field: `permissionHandler` set, never read | `pi-session.ts:60,71-73` | 🟠 |
| Default-arg state defeats held-latest invariant | `pi-session.ts:431` | 🟠 |
| Existence check by full `readFile` (`byteLength>=0` tautology) | `runner.ts:146-148` | 🟡 |
| Unawaited `agentSession.abort()` in `stop()` | `pi-session.ts:166` | 🟡 |
| `streaming` state never observable (reset in `finally`) | `pi-session.ts:143,153` | 🟡 |
| Non-deterministic hook/context/skill ordering in bundle.json | `pi-sdk-adapter.ts:403,423-442,452` | 🟡 |
| Ignored start-options: `skills`/`extensions`/`contextFiles` | `types.ts:55-61` vs `pi-session.ts:75-135` | 🟡 |
| No re-entrancy guard on concurrent `sendPrompt` | `pi-session.ts:137-155` | 🟡 |

### 🧪 Additional Test-Gap Notes (second pass)

- No test exercises `PiSession.start()`/`sendPrompt`/`stop()` lifecycle at all — only the pure `mapPiEventToUnified` mapper and `composeTarget`/`buildRunArgs` are covered. Permission gating, abort/cleanup idempotency, and state transitions are entirely untested.
- `buildRunArgs` is tested for model defaulting but NOT for the `continuationKey → --resume` path (A1) or the `--no-extensions`/`--no-skills` toggles.
- `parseArgs` (runner) has no unit test, so the `--resume` rejection (A1) and the unreachable colon model-split (first-pass Finding 6) are both undetected.
- The adapter test's custom-model case (`pi-sdk-adapter.test.ts:140-143`) passes `anthropic:claude-3-opus` (colon) and asserts it flows through verbatim — this test actively encodes the colon format that `runner.ts:539` consumes, while the adapter's own model IDs use slash, so the suite simultaneously blesses both formats (compounds first-pass Finding 6).
