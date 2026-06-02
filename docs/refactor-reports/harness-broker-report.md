# 🔧 Refactoring Analysis

**Target:** `packages/harness-broker/src`
**Lines analyzed:** ~9,134 (34 source files; deep-read the 8 largest/most-central)
**Generated:** 2026-06-01  ·  **Focus:** all (SRP, OCP, LSP, ISP, DIP) + code smells

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🔴 | `invocation-manager.ts` (1027 lines) fuses queue/drain, permission lifecycle, idempotency ledger, the event state machine, and the start/input/stop/dispose facade into one closure. `tmux.ts` (721) holds env-scrubbing, version parsing, metadata regexes, lifecycle management, and the paste-confirm-submit protocol. `cli.ts` (498) mixes arg parsing, two transport servers, fencing, and run-once. |
| Open/Closed | 🟡 | `applyEventState` and `mapCodexNotificationInner` are large `switch` blocks keyed on event/notification type that must be edited for every new case. The `input()` `whenBusy` policy ladder is an if-chain that grows per policy. Tolerable (closed enums) but not extensible without edits. |
| Liskov Substitution | 🟡 | `TmuxPaneController.resize()` is a capability-gated no-op (throws if denied, otherwise does nothing) — a method present on the surface that silently performs no work. Codex `interrupt()` always returns `accepted: false, effect: 'unsupported'`. Both are "implemented" methods that don't honor the implied contract of their name. |
| Interface Segregation | 🟡 | `Invocation` is a 25+ field god-record bundling public projection, queue locks, idempotency maps, and permission maps. `DriverContext` carries 6 members several drivers ignore (`requestPermission`, `brokerOwnsPermissionLifecycle`, `clientCapabilities` unused by tmux drivers). |
| Dependency Inversion | 🟡 | Drivers `new TmuxPaneController(...)` directly and reach for `Bun.spawn` / `node:net` `createServer` via inline `await import(...)` instead of an injected seam (the `exec`/`hooks.listen` seams exist but socket-listen is hardcoded). `event-map.ts` uses module-level mutable singleton `defaultHeldAssistantCompletions`. |

## 🎯 Priority Refactorings

### 1. Decompose `createInvocationManager` — Single Responsibility
- **Location:** `src/invocation-manager.ts:208-1027`
- **Current:** One 800-line factory closure owns at least six distinct concerns: (a) the input FIFO drain engine (`scheduleDrain`/`doDrain`/`applyAndEmit`/`attemptSteerAndEmit`/`evictQueue`), (b) broker-owned permission lifecycle (`brokerRequestPermission` + `permissionRespond`, ~120 lines of settle/timeout/idempotency), (c) the input idempotency ledger (`fingerprintInput`/`recordDisposition`/`inputDispositions`), (d) the event state machine (`applyEventState`, a 14-case switch), (e) the emit/normalize pipeline (`emit`/`emitTerminal`), and (f) the public start/input/interrupt/stop/status/dispose/permissionRespond facade. The single `input()` method alone is ~145 lines (729-874).
- **Suggested:** Extract collaborators behind small interfaces, each unit-testable in isolation: `InputQueue` (drain/steer/evict), `PermissionLedger` (pending/settled/settle/respond), `InputIdempotencyLedger` (fingerprint/record/replay), `InvocationStateMachine` (`applyEventState`). The manager becomes a thin orchestrator wiring them to the driver. Replace the `input()` policy ladder with a small policy dispatch table (also addresses OCP).
- **Risk:** Med  ·  **Effort:** ~1.5–2 days  ·  **Tests:** `input-queue`, `input-policy`, `initial-input`, `timeouts`, `broker-lifecycle` cover the seams — refactor behind them one collaborator at a time.

### 2. Hoist duplicated tmux-driver scaffolding into a shared module — DRY / SRP
- **Location:** `src/drivers/claude-code-tmux/driver.ts` and `src/drivers/codex-cli-tmux/driver.ts`
- **Current:** The two tmux drivers carry near-byte-identical private helpers: `extractText` (claude 464, codex 518), `getInvocationRuntimeId` (claude 471, codex 432), `shellQuote` (claude 597, codex 525 — and a *third* copy in `runtime/tmux-launch-exec.ts:63`), `sleep` (codex 532, also `tmux.ts:669`), and the ~45-line `listenForHookEnvelopes` Unix-socket server (claude 631, codex 569) plus its `buildClaudeHookSocketPath`/`buildCodexHookSocketPath` SHA-256 token helper (claude 623, codex 558). `start()` also repeats the same lease-validation → `TmuxPaneController` → inspect-and-compare-ids block in both files.
- **Suggested:** A `runtime/tmux-driver-support.ts` (or `drivers/tmux-shared.ts`) exporting `extractText`, `shellQuote`, `sleep`, `getInvocationRuntimeId`, `listenForHookEnvelopes`, `buildHookSocketPath`, and a `consumePaneLease(driverCtx, opts): { controller, surface }` helper that performs the lease-shape validation + inspect/identity check once. Consolidate the three `shellQuote` copies into one.
- **Risk:** Low  ·  **Effort:** ~0.5 day  ·  **Tests:** both `drivers/*-tmux/driver*.test.ts` plus `runtime/tmux*.test.ts`; behavior-preserving extraction.

### 3. Split `tmux.ts` into module-level helpers vs. controller classes — SRP
- **Location:** `src/runtime/tmux.ts:1-722`
- **Current:** One file mixes pure parsing/sanitization free functions (`parseVersion`, `parsePaneState`, `parsePaneIdentity`, `sanitizeTmuxServerPath`, `scrubInheritedEnv`, `normalizePane`), the `TmuxManager` lifecycle class, the `TmuxPaneController` lease class, and the embedded paste-confirm-submit state protocol (`sendPastedLine`/`waitForPane`/`discardPromptLine`, with its own 8 tuning constants 89-100). Three responsibilities (env sanitization, pane parsing, the submit protocol) are independently testable but currently entangled.
- **Suggested:** `tmux-env.ts` (scrub/sanitize), `tmux-parse.ts` (pane/version parsers + patterns), and keep `tmux.ts` for the two classes. Optionally extract the paste-confirm-submit loop into a `PaneSubmitter` collaborator the controller delegates to.
- **Risk:** Low  ·  **Effort:** ~0.5 day  ·  **Tests:** `runtime/tmux.test.ts`, `runtime/tmux-pane-controller.test.ts`, `runtime/env.test.ts`.

### 4. Split `cli.ts` transport entry points — SRP
- **Location:** `src/cli.ts:32-498`
- **Current:** A single `main()` dispatch plus `runStdio` (78), `runUnix` (175, ~200 lines: socket-budget check, ledger/identity wiring, stale-socket reclaim, fencing, durability method registration, server lifecycle), `runOnce`, and three validate/load helpers all in one file. `runUnix` alone owns connection fencing, the live-controller pointer dance, and shutdown.
- **Suggested:** `cli/stdio-transport.ts`, `cli/unix-transport.ts` (with the fencing/`activeController` logic as a small `ControllerRegistry`), `cli/run-once.ts`, and a thin `cli.ts` that only parses argv and dispatches. `readFlag`/`formatError` move to a `cli/args.ts`.
- **Risk:** Low  ·  **Effort:** ~0.5 day  ·  **Tests:** `cli.test.ts`, `run-once.test.ts`, `protocol-server.test.ts`.

### 5. Replace the module-level mutable singleton in `event-map.ts` — DIP / hidden state
- **Location:** `src/drivers/codex-app-server/event-map.ts:36,49-51`
- **Current:** `const defaultHeldAssistantCompletions: HeldAssistantCompletions = new Map()` is module-global mutable state backing the exported `mapCodexNotification`. Any caller of the non-factory export shares one cross-invocation Map of held assistant completions — a latent cross-talk hazard if `mapCodexNotification` is ever used outside tests. The driver correctly uses `createCodexNotificationMapper()`; the singleton export exists only as a convenience.
- **Suggested:** Remove the singleton + `mapCodexNotification` wrapper, or make `mapCodexNotification` allocate a fresh `Map` per call. Keep only the `createCodexNotificationMapper()` factory as the supported surface.
- **Risk:** Low  ·  **Effort:** <0.5 day  ·  **Tests:** `drivers/codex-app-server/event-map.test.ts`.

### 6. Collapse the `input()` `whenBusy` policy ladder — OCP
- **Location:** `src/invocation-manager.ts:803-873`
- **Current:** A flat if-chain (`whenBusy === 'reject'` / `'interrupt_then_apply'` / `'queue'` / fallback) with the queue branch holding nested capability/kind/depth checks. Each new busy policy requires editing this method.
- **Suggested:** A `Record<WhenBusy, (inv, input, req) => Promise<InvocationInputResponse>>` dispatch table (pairs naturally with the queue extraction in #1). Centralizes the reason-string vocabulary already gathered at the top of the file.
- **Risk:** Med  ·  **Effort:** ~0.5 day  ·  **Tests:** `input-policy.test.ts`, `input-queue.test.ts`.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| God file / class — 1027-line manager closure with 6 concerns | `invocation-manager.ts:208` | 🟠 |
| Long method — `input()` ~145 lines | `invocation-manager.ts:729-874` | 🟠 |
| Long method — `start()` ~115 lines | `drivers/codex-app-server/driver.ts:275-388` | 🟠 |
| Long method — claude `start()` ~200 lines | `drivers/claude-code-tmux/driver.ts:196-394` | 🟠 |
| Duplicated helpers across the two tmux drivers (`extractText`, `shellQuote`, `sleep`, `listenForHookEnvelopes`, socket-path builder, lease-validation block) | `claude-code-tmux/driver.ts` & `codex-cli-tmux/driver.ts` | 🟠 |
| `shellQuote` copied in 3 files | `claude…/driver.ts:597`, `codex…/driver.ts:525`, `runtime/tmux-launch-exec.ts:63` | 🟠 |
| Module-level mutable singleton `Map` | `drivers/codex-app-server/event-map.ts:36` | 🟠 |
| Magic-number cluster (8 paste/submit tuning constants + blind `1_000`ms sleeps) | `runtime/tmux.ts:89-100,366,374`; `codex-cli-tmux/driver.ts:350,361` | 🟡 |
| Primitive-obsession / god-record — 25+ field `Invocation` interface | `invocation-manager.ts:127-169` | 🟡 |
| Large `switch` on event type | `invocation-manager.ts:358-438` (`applyEventState`) | 🟡 |
| Large `switch` on native method | `drivers/codex-app-server/event-map.ts:77-267` | 🟡 |
| Repeated `extra`-spread payload construction (`...(x !== undefined ? {x} : {})`) recurs dozens of times | `broker.ts`, both tmux drivers, manager | 🟡 |
| Capability-gated no-op method (`resize` does nothing when allowed) | `runtime/tmux.ts:656-660` | 🟡 |
| `as unknown` / `as { kind?: unknown }` casts to read payload fields instead of typed accessors | `invocation-manager.ts:362-433`; `codex-cli-tmux/driver.ts:170-172` | 🟡 |
| Hardcoded `await import('node:net'/'node:fs/promises')` inside drivers (no injection seam for the socket server) | `claude…/driver.ts:635`, `codex…/driver.ts:573` | 🟡 |
| Inline shell-script generation as a JS string array (codex hook wrapper) | `codex-cli-tmux/driver.ts:484-516` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Consolidate the three `shellQuote` copies and the duplicated `sleep`/`extractText`/`getInvocationRuntimeId` into one shared util (Refactoring #2, partial). Pure functions, behavior-preserving.
2. Remove the `mapCodexNotification` module singleton or make it allocate per-call (Refactoring #5). Self-contained, eliminates a latent cross-talk bug.
3. Extract `listenForHookEnvelopes` + the SHA-256 socket-path builder into one shared `tmux-hook-socket.ts` (both copies are identical). Deletes ~90 duplicated lines.

## ⚠️ Technical Debt Notes

- The two tmux drivers (`claude-code-tmux`, `codex-cli-tmux`) have diverged by copy-paste rather than sharing a base; their `start()` lease-handshake, hook-drain serialization, and socket-listen plumbing are the same shape with cosmetic differences. A shared `tmux-driver-support` module (or a small template/strategy base) would keep future fixes (e.g. the T-01794 generation-fencing logic, which already exists in slightly different form in each file) from drifting again.
- `Invocation` doubles as both the manager's internal mutable record and the data the broker's `buildSnapshot` reaches into directly (`broker.ts:169-204` reads `inv.inputDispositions`, `inv.pendingPermissions`, `inv.pending`). Extracting the permission/idempotency ledgers (#1) also tightens this snapshot coupling into explicit projection methods.
- Several methods exist purely to satisfy a uniform interface but report "unsupported" at runtime (codex `interrupt`, `resize` no-op). These are honest capability gates, but they read as LSP smells; documenting them as explicit "capability-denied" surfaces (or moving capability checks to the type level) would clarify intent.
- Heavy reliance on `as unknown` / structural casts to read event payload fields in the state machine and codex-cli driver suggests the event payloads would benefit from a discriminated-union accessor layer.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (manager: `input-*`, `timeouts`, `broker-lifecycle`; tmux: `runtime/tmux*`, `drivers/*-tmux`; codex: `drivers/codex-app-server/*`)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run `bun run test` + `bun run typecheck` between each
- [ ] Run the broker MATRIX smoke (`bun run smoke:matrix`, at least `--config fake-codex`) before declaring any driver/manager change complete — per CLAUDE.md harness-broker rule
- [ ] Verify boundaries/manifests unaffected (`bun run check:boundaries`, `bun run check:manifests`)
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

Fresh-eyes pass focused on error handling, async/cleanup, concurrency, contract surface, and edge cases. The items below are NOT in the first report.

### A1. Ledger persistence is non-atomic; `loadExisting` will crash on a torn last line — Error handling / durability
- **Smell:** Swallowed-vs-unswallowed inconsistency + crash on recoverable corruption.
- **Location:** `src/event-ledger.ts:166-186` (`loadExisting`), `188-196` (`appendLine`).
- **Detail:** `appendLine` does `openSync(path,'a') → writeFileSync(fd,line) → fsyncSync`. A single `writeFileSync(fd, ...)` is not guaranteed to write the whole buffer in one syscall, and a process kill mid-write can leave a partial trailing line. `loadExisting` wraps `readFileSync` in a `try {} catch { return }` (so a missing file is tolerated) but then calls `JSON.parse(line)` per line **with no try/catch** — one torn/partial line throws a `SyntaxError` out of `createEventLedger`, taking down broker startup hard. The append path fsyncs the data fd but never fsyncs the parent directory, so even the durable rename in `rewriteLedger` isn't crash-atomic across a power loss. Risk: a crash during normal append makes the durable ledger unloadable on the next boot.
- **Risk:** Med · **Effort:** ~0.5 day · **Tests:** add an `event-ledger` case that loads a file with a trailing partial JSON line and asserts it recovers (drops the torn tail) instead of throwing.

### A2. `rewriteLedger` fsyncs the temp file but not the parent dir before/after rename — Durability edge case
- **Smell:** Missing-edge-case (partial fsync) in an explicitly "durable" path.
- **Location:** `src/event-ledger.ts:198-218`.
- **Detail:** The function writes `path.tmp`, fsyncs the tmp fd, then `renameSync(tmp, path)`. The rename itself is a metadata operation on the directory; without an `fsync` on the directory fd after the rename, a crash can leave the rename unpersisted (old file) even though the data was fsynced. This defeats the intent of the tmp-then-rename pattern. The first report flagged this file only for the `Math.max(...keys)` style; the durability gap is new.
- **Risk:** Low · **Effort:** <0.5 day · **Tests:** hard to unit-test crash-atomicity; document the guarantee and add the dir-fsync.

### A3. `currentSeq` spreads all keys into `Math.max(...)` — perf / stack hazard on large ledgers — Performance
- **Smell:** Performance hot spot + potential `RangeError` (too many spread args).
- **Location:** `src/event-ledger.ts:130-136`.
- **Detail:** `Math.max(...bySeq.keys())` materializes every sequence number as call arguments. For a long-lived durable invocation with tens of thousands of events this is O(n) per call AND can throw `RangeError: Maximum call stack size exceeded` once the arg count exceeds the engine limit. `currentSeq` is called on every event-emit path (it backs sequence allocation), so this is on a hot path. A running `max` maintained on insert (or `for` loop) is O(1)/O(n)-without-spread.
- **Risk:** Low · **Effort:** <0.5 day · **Tests:** `event-ledger` perf/correctness case appending a large number of events then calling `currentSeq`.

### A4. Module-global `permissionRequestCounter` shared across all invocations — Hidden state / DIP
- **Smell:** Module-level mutable singleton (a second instance of the smell the first report flagged only for `event-map.ts`).
- **Location:** `src/drivers/codex-app-server/permissions.ts:95-100`.
- **Detail:** `let permissionRequestCounter = 0` is a file-global incremented by `nextPermissionRequestId`. Although the id embeds `invocationId` (so collisions are avoided), the counter monotonically grows process-wide and is shared across concurrent invocations and across test cases in the same process — making `permissionRequestId` values non-deterministic and non-resettable per invocation, and creating cross-test ordering coupling. The first report's singleton finding (#5) covered `event-map.ts` only; this is a distinct occurrence in a different module.
- **Risk:** Low · **Effort:** <0.5 day · **Tests:** `drivers/codex-app-server/permissions.test.ts` — assert per-invocation id sequences start independently.

### A5. `protocol-server` fire-and-forget request handlers race a concurrent `close()` — Concurrency / resource correctness
- **Smell:** Race condition + swallowed shutdown signal.
- **Location:** `src/protocol-server.ts:95-113` (`handleLine` handler dispatch) and `132-143` (`start` registers `stdin.on('data')` but `start()` body is `async` yet does no awaiting — the `Promise<void>` it returns resolves before any data flows, a misleading contract).
- **Detail:** Each inbound request spawns `void handler(...).then(writeOk, writeErr)`. There is no tracking set of in-flight handler promises, so `close()` (line 183) flips `closed=true`, removes the `data` listener, and rejects pending *outbound* requests — but already-dispatched inbound handlers keep running and may call `writeFrame`, which silently no-ops once `closed` (line 51). The handler's result is computed, then dropped on the floor with no diagnostic — the client that sent that request never gets a response and never an error. Also `start()` being `async` with no `await` is a leaky contract: callers may believe awaiting it means the stream is fully consumed.
- **Risk:** Med · **Effort:** ~0.5 day · **Tests:** `protocol-server.test.ts` — dispatch a slow handler, call `close()` before it resolves, assert the client sees a shutdown error rather than silence.

### A6. CLI `shutdown` / `netServer.on('error')` can `process.exit` while a torn socket file remains — Cleanup ordering
- **Smell:** Resource-cleanup ordering / swallowed error.
- **Location:** `src/cli.ts:359-377`.
- **Detail:** `shutdown` calls `netServer.close()` (async, callback ignored) then `unlink(socketPath)` then `process.exit(0)` — it exits as soon as the unlink settles, without waiting for `netServer.close()` to finish draining live connections, so in-flight responses to attached controllers can be dropped. The `netServer.on('error')` handler `process.exit(1)`s without unlinking the socket node, leaving a stale socket file that the next boot's `reclaimStaleSocket` must clean up (it does, but the asymmetry is a latent foot-gun). SIGTERM/SIGINT both register `shutdown` with no idempotency guard, so a double signal triggers a second `netServer.close()`/`unlink` race.
- **Risk:** Low · **Effort:** ~0.5 day · **Tests:** `cli.test.ts` — assert socket file removed on both clean shutdown and error exit; double-signal is a no-op.

### A7. `CodexRpcClient` request map has no per-request timeout — a never-answered RPC hangs forever — Missing edge case
- **Smell:** Missing-edge-case (unbounded await) — contrast with `protocol-server` which DOES support `timeoutMs`.
- **Location:** `src/drivers/codex-app-server/rpc-client.ts:80-96`, `pending` map `53-56`.
- **Detail:** `sendRequest` registers a pending entry and returns a promise that only settles via `handleResponse` (matching id), `close()`, or `handleError` (proc error/exit). If the Codex app-server accepts a request id but never emits the matching response (and never exits/errors), the awaiting caller hangs indefinitely — there is no per-request deadline here. The driver layers a *startup* race and a *turn* timeout on top (`driver.ts:336-346,404-430`), but any RPC outside those two windows (or a malformed response that fails the id match at `166`) has no bound. The sibling `protocol-server.request` deliberately supports `timeoutMs`; the asymmetry is the smell.
- **Risk:** Med · **Effort:** ~0.5 day · **Tests:** `rpc-client` test that sends a request, never replies, and asserts a timeout rejection rather than a hang.

### A8. `listenForHookEnvelopes` (codex-cli-tmux) does not unlink the socket node on `close()` — Resource leak
- **Smell:** Resource-cleanup gap (asymmetric create/destroy).
- **Location:** `src/drivers/codex-cli-tmux/driver.ts:569-613` (and the structurally-identical claude copy noted in the first report's DRY item).
- **Detail:** On setup the listener `rm(socketPath, {force:true})` before `server.listen` (defensive), but `close()` only calls `server.close(...)` — it never `rm`s the socket file. Because the socket path is now per-invocation/runtime (T-01794, SHA-256 token basename), each invocation leaves a dead socket node behind in `socketDir`; over many invocations these accumulate with no reaper. The `conn.on('end')` JSON-parse/handler block also `catch {}`-swallows any handler error to `conn.end('err')` with no diagnostic emitted, so a malformed/oversized hook envelope is dropped silently. (First report flagged this function only for DRY duplication and the hardcoded `await import`; the leak + silent-drop are new.)
- **Risk:** Low · **Effort:** <0.5 day · **Tests:** driver test asserting the socket file is removed after the listener handle closes.

### A9. `onData` writes a parse-error frame with `id: null` for every malformed line — protocol-noise / DoS surface — Robustness
- **Smell:** Missing-edge-case / unbounded reaction to bad input.
- **Location:** `src/protocol-server.ts:115-125`.
- **Detail:** A peer sending a stream of non-NDJSON bytes produces one `createJsonRpcErrorResponse(null, -32700, …)` write per decoded malformed frame, with no rate limit or cap. Combined with the decoder's buffering, a hostile/buggy client can amplify a single bad chunk into many writes. Minor, but worth a bound or a "stop after N consecutive parse errors → close" policy.
- **Risk:** Low · **Effort:** <0.5 day · **Tests:** `protocol-server.test.ts` — push garbage and assert bounded error responses.

### A10. `onNotification` 'error' branch can emit `turn.failed` AND later let `onExit` emit another terminal — state-machine edge — Concurrency / contract
- **Smell:** Missing-edge-case in the terminal-event guard.
- **Location:** `src/drivers/codex-app-server/driver.ts:123-190` vs `192-220`.
- **Detail:** When a native `error` notification arrives with `turnActive`, the code emits `turn.failed` but does NOT set `terminalEmitted` (only `emitTerminalFailure` sets it, and that branch is skipped when a turn is active). It leaves `turnActive` unchanged after emitting `turn.failed` here (unlike the mapped-event path at `181-188` which clears `turnActive` and the turn timeout). So a subsequent process exit reaches `onExit`, sees `turnActive` still true, and emits a SECOND turn terminal (`turn.failed`/`turn.interrupted`) for the same turn — a duplicate turn-terminal for one turn id. The mapped-notification path is careful to clear `turnActive`/`turnTimeout` on turn-terminal; the hand-rolled `error`-branch `turn.failed` is not, creating an inconsistency.
- **Risk:** Med · **Effort:** ~0.5 day · **Tests:** `drivers/codex-app-server/*` — deliver an `error` notification mid-turn, then exit the proc, assert exactly one turn-terminal for the turn.

### A11. `start()` being `async` but doing no `await` in `protocol-server` and the codex stderr line-reader having no error handler — Robustness
- **Smell:** Unhandled stream error + misleading async signature.
- **Location:** `src/drivers/codex-app-server/driver.ts:305-309` (stderr `createInterface(...).on('line', …)` with no `.on('error')`), `src/protocol-server.ts:132-143`.
- **Detail:** The stderr readline interface only handles `'line'`; if the stderr stream errors (e.g. the pipe breaks abruptly), there is no `'error'` listener, so Node may emit an unhandled `'error'` and crash the broker process. Pair this with the `protocol-server.start()` no-await signature (A5) as a small cluster of "stream wiring that looks complete but isn't."
- **Risk:** Low · **Effort:** <0.5 day · **Tests:** driver test that errors the stderr stream and asserts no process crash.

### 📝 Additional Code Smells (second pass)

| Smell | Location | Severity |
|-------|----------|----------|
| `JSON.parse` per line with no try/catch in durable-ledger load (crashes on torn line) | `event-ledger.ts:180` | 🟠 |
| `Math.max(...keys)` spread on hot path (perf + RangeError) | `event-ledger.ts:135` | 🟠 |
| Unbounded RPC await — no per-request timeout in `CodexRpcClient` | `rpc-client.ts:80-96` | 🟠 |
| Fire-and-forget handler response silently dropped after `close()` | `protocol-server.ts:96-113,51` | 🟠 |
| Module-global `permissionRequestCounter` shared across invocations/tests | `permissions.ts:95` | 🟡 |
| Hook listener never unlinks its per-invocation socket node on close (file leak) | `codex-cli-tmux/driver.ts:606-612` | 🟡 |
| `catch {}` swallows hook-envelope parse/handler errors with no diagnostic | `codex-cli-tmux/driver.ts:591-593` | 🟡 |
| stderr readline has no `'error'` listener (possible unhandled stream error) | `codex-app-server/driver.ts:305` | 🟡 |
| `error`-notification `turn.failed` doesn't clear `turnActive`/`turnTimeout` → possible duplicate turn-terminal | `codex-app-server/driver.ts:131-143` | 🟡 |
| Unbounded parse-error responses for malformed input stream | `protocol-server.ts:121-123` | 🟡 |
| Missing parent-dir fsync after rename in "durable" rewrite path | `event-ledger.ts:217` | 🟡 |
| `start()` declared `async` but awaits nothing (misleading contract) | `protocol-server.ts:132` | 🟡 |
| Double SIGTERM/SIGINT triggers re-entrant shutdown (no idempotency guard) | `cli.ts:359-368` | 🟡 |
