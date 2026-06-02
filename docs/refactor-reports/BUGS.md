# 🐞 Correctness Bug Triage (second-pass findings)

**Generated:** 2026-06-01 · **Source:** the `🔁 Additional Findings (second pass)` section of each `*-report.md` · **Count:** 97 behavioral defects (the other 52 second-pass findings are code-quality/contract/test-gap items — see [REFACTOR-BACKLOG.md](./REFACTOR-BACKLOG.md)).

## What this is — and what it isn't

These are findings that describe **wrong behavior** — a crash, hang, leak, race, data loss, or a silently-incorrect result. Naming, DRY, dead-code, additive-API, and pure test-gap items were moved out to the backlog; this file is bugs only.

Two important caveats:

- **`Class` column.** Each bug is tagged **live** or **latent**.
  - **live** (~37) = reachable by inputs the code sees *today*; can manifest now.
  - **latent** (~60) = a real defect gated behind a path not currently exercised (e.g. resume isn't wired, the only `T` is never `undefined`, a handler is still synchronous). These can't fire yet but become live the moment that path is taken — worth fixing before arming it, not necessarily before shipping.
- **Proposed, not verified.** Every fix was written from reading the code, not from a reproducing test. Confirm with a failing test first, especially for 🔴 live items. Full write-ups (detail + rationale + test guidance) are under the matching `### A#` heading in `<package>-report.md`.

Severity: 🔴 High (production-affecting) · 🟠 Med · 🟡 Low.

---

## 🔴 High-severity shortlist (fix these first — all live)

| # | Package | Finding | What breaks | Location |
|---|---------|---------|-------------|----------|
| 1 | harness-broker-protocol | A1 — NDJSON UTF-8 corruption | fresh `TextDecoder` per `push()` w/o `{stream:true}` mangles any multi-byte char split across a chunk boundary — the **single ingress for every broker frame** | `ndjson.ts:24` |
| 2 | harness-broker | A1 — ledger torn-line crash | `loadExisting` does `JSON.parse(line)` with no try/catch; a partial trailing line from a killed write **takes down broker startup** | `event-ledger.ts:166-186` |
| 3 | harness-claude | A1 — PromptQueue lost-wakeup deadlock | `close()` nulls the waiter without resolving it; a parked consumer hangs forever, wedging the SDK input loop on normal `stop()` | `prompt-queue.ts:104-112` |
| 4 | harness-pi | A1 — pipe-buffer deadlock | `await proc.exited` *before* draining stdout/stderr; a child exceeding the ~64KB pipe buffer hangs detection | `pi-adapter.ts:219,246,335` |
| 5 | harness-codex | A1 — stderr never drained | `stdio:'pipe'` but nothing reads `proc.stderr`; >64KB of app-server stderr deadlocks the session | `codex-session.ts:206`, `rpc-client.ts:54` |
| 6 | runtime | A2 — python-lock stderr deadlock | advisory-lock child spawned `stderr:'pipe'`, never drained; a stuck child hangs `withTargetLock` | `agent-memory/store.ts:248-282` |
| 7 | harness-pi-sdk | A3 — permission handler never read | `setPermissionHandler` stores a handler nothing consumes; **tool calls appear gated but aren't** (security) | `pi-session.ts:60,71-73` |
| 8 | config | A1 — integrity hash silent fallback | `computeIntegrity` catches **any** git error and returns the empty-space hash; a corrupt/unreadable space silently **passes integrity verification** | `resolver/integrity.ts:79-86` |
| 9 | agent-spaces | A1 — `process.env` overlay race | global non-reentrant overlay held for a whole turn; concurrent sessions clobber each other's `ASP_HOME`/PATH/**credentials** | `runtime-env.ts:10` + call sites |
| 10 | execution | A1 — dry-run FS side effects | agent-tool runtime block has no `dryRun` guard; `--dry-run` creates dirs and can **throw** on tool validation (violates CLAUDE.md) | `run/execute.ts:150-154` |

> Also genuinely live and high-impact, just below the cut: `harness-broker A5` (dropped responses after close), `harness-broker A7` (RPC hang, no timeout), `harness-claude A3/A4/A5` (abort ignored / timer leak / nondeterministic end), `harness-codex A3` (error state clobbered to running), `harness-pi A4` (crash instead of `--no-extensions`), `runtime A3/A4` (substring data loss / detect hang), `config A2/A4` (snapshot race / wrong harness model), `execution A2/A3/A7` (output buffering / lock race / `process.exit` in a library).

---

## Per-package bugs

`Class`: **live** = can fire today · **latent** = real defect, no current trigger.

### agent-scope (4)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A | 🟠 | live | `parseSessionHandle` never validates laneId — invalid `LaneRef` escapes the type contract | `session-handle.ts:18-36` | route lane through `normalizeLaneRef` | 15m |
| B | 🟡 | latent | `formatScopeRef` trusts caller fields → can emit a non-canonical, unparseable ref | `scope-ref.ts:132-148` | guard project→task→role chain or drive off `kind` | 20m |
| C | 🟡 | latent | `formatSessionHandle` slices `laneRef` without validating the `lane:` prefix | `session-handle.ts:51-53` | validate / reuse `laneIdFromRef` | 10m |
| E | 🟡 | latent | `resolveQualifiedScopeInput` drops a role-without-project (throws on internal string) | `input.ts:130-152` | construct `ParsedScopeRef` directly; guard | 25m |

### agent-spaces (5)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🔴 | live | global `process.env` overlay race — concurrent turns clobber env/credentials | `runtime-env.ts:10` | thread explicit env object / serialize overlays | 1-2d |
| A2 | 🟠 | live | event emitter swallows `onEvent` errors; unbounded promise chain | `session-events.ts:54-56` | surface/log emit failures; explicit queue | 3-4h |
| A3 | 🟠 | latent | `composeEnv` PATH precedence reads stale base vs `dispatchEnv.PATH` | `execute-embedded-sdk.ts:125-129` | base off `process.env.PATH` explicitly | 2h |
| A4 | 🟠 | live | duplicated `toAgentSpacesError` — run-tracker copy drops `CodedError.code` | `run-tracker.ts:56` | delete copy, import helper | 1h |
| A5 | 🟠 | latent | embedded-sdk env overlay applied after bundle load / session ctor | `execute-embedded-sdk.ts:377-488` | move `applyEnvOverlay` before pi-sdk calls | 1h |

### aspc-protocol (1)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A2 | 🟠 | latent | hello `capabilities` validator accepts arbitrary keys — misspelled flag silently lost | `schemas.ts:157,219-234` | validate key set or document open contract | 15m |

### aspc (5)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🟠 | live | `void server.start()` rejection swallowed → facade hangs / unhandledRejection | `facade.ts:87` | `.catch` → stderr + non-zero exit | 15m |
| A2 | 🟠 | latent | `compileAndStart` lets `broker.start` throw raw — two failure shapes for one method | `service.ts:91-96` | wrap start failure in `ok:false` envelope | 30m |
| A3 | 🟠 | live | `AspcClient` no subprocess-liveness wiring — pending requests hang on facade death | `client.ts:18-78` | expose close/error, reject in-flight | 30-45m |
| A4 | 🟡 | latent | `hello` ignores client `protocolVersions` — no negotiation | `service.ts:47` | check + return incompatibility | 20m |
| A7 | 🟡 | live | close-path swallows `close()` rejection → may hang instead of exit | `facade.ts:89-93` | `.catch` → exit(1) | 10m |

### cli-kit (4)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🟠 | live | `parseIntegerValue` accepts `10abc`/`3.9`/`0x10` (prefix parse) | `index.ts:96` | strict `/^-?\d+$/` or full-string compare | 10m |
| A2 | 🟡 | latent | no max / safe-integer guard on parsed ints | `index.ts:95-101` | add `max` + `isSafeInteger` | 10m |
| A4 | 🟡 | latent | `consumeBody` treats `file:''` as "no file" | `index.ts:107` | use `!== undefined` | 5m |
| A5 | 🟠 | live | `withDeps` silent no-op when no Command; blind positional cast | `index.ts:38-43` | assert final arg is `Command`, throw | 15m |

### cli (4)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🟠 | live | two divergent `inferTargetFromBundleRoot` — introspection & reminder hook disagree | `self/lib.ts:161` vs `resolve-reminder.ts:109` | export one canonical, stricter version | 2-3h |
| A2 | 🟠 | live | N+1 template resolution re-runs `exec`/`service-probe` side effects on read-only inspect | `self/lib.ts:421` + callers | resolve once w/ per-section breakdown | 0.5d |
| A3 | 🟡 | latent | `self inspect --json` serializes whole `SelfContext` (drops a function, leaks fields) | `self/inspect.ts:42` | explicit `InspectJsonPayload` projection | 1-2h |
| A4 | 🟡 | latent | `readLaunchArtifactLite` blanket `as` cast → later throw on malformed `argv`/`env` | `self/lib.ts:245` | coerce defensively | 1-2h |

### config (7)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🔴 | live | integrity hash silently falls back to empty-space hash on **any** git error | `resolver/integrity.ts:79-86` | distinguish absent-path from real errors, rethrow | 1-2h |
| A2 | 🟠 | live | `createSnapshot` `Date.now()` temp-dir + non-atomic overwrite (race) | `store/snapshot.ts:101,118-120` | route through `atomicDir`/`randomBytes` | 2h |
| A3 | 🟠 | latent | duplicated fs-hash/dir-walk that **must** stay identical (drift breaks verification) | `integrity.ts:135,150` + `snapshot.ts` | extract `core/fs-hash.ts` | 3h |
| A4 | 🟠 | live | `mergeAgentWithProjectTarget` picks `claude.model` over `codex.model` regardless of harness | `agent-project-merge.ts:123-124` | select by resolved harness family | 1h |
| A5 | 🟡 | latent | `isTargetUpToDate` ignores resolved commits — moving selector reads stale | `lock-generator.ts:337-352` | compare commits/envHash | 1-2h |
| A9 | 🟡 | latent | cache/snapshot metadata getters swallow `JSON.parse` errors as "missing" | `cache.ts:105`, `snapshot.ts:69,143` | distinguish ENOENT from corruption | 1h |
| A10 | 🟡 | latent | `atomicWrite` fsyncs a read-only fd; parent dir never fsynced | `core/atomic.ts:67-74` | keep write fd open + fsync; fsync dir | 1-2h |

### execution (8)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🔴 | live | dry-run creates dirs + runs `validateAgentTools` (can throw) — no `dryRun` guard | `run/execute.ts:150-154` → `agent-tools.ts:80-102` | mirror the brain-runtime guard | 1h |
| A2 | 🟠 | live | non-interactive stdout buffered to memory, withheld until exit; UTF-8 chunk split | `run/execute.ts:51-91,196-201` | stream through / `StringDecoder` | 2h |
| A3 | 🟠 | live | `persistGlobalLock` lock-free non-atomic read-modify-write (lost update) | `run/space-launch.ts:38-61` | temp+rename under advisory lock | 3h |
| A4 | 🟠 | latent | legacy codex-home migration can lose runtime on partial `cp` failure | `run-codex.ts:154-162` | copy to temp sibling, atomic rename | 2-3h |
| A5 | 🟡 | latent | `findSourcePath` collapses whitespace in paths | `run/agent-brain.ts:337-342` | prefer JSON; split on first ws run | 1h |
| A6 | 🟠 | latent | `ensureSourceRegistered` list→add TOCTOU race | `run/agent-brain.ts:161-194` | serialize per-agent / idempotent upsert | 3h |
| A7 | 🟠 | live | `paginate`/`waitForKey` `process.exit(130)` + mutates global stdin from a lib | `pager.ts:13-29` | signal quit to caller; inject streams | 2h |
| A10 | 🟠 | latent | gbrain runner has no timeout/output cap; spawn wrappers can double-settle | `agent-brain.ts:422-425` | settle-once guard + timeout + max-buffer | 1-2h |

### harness-broker-client (6)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🟠 | latent | `EventIterator.return()` abandons in-flight `next()` waiters, never closes | `event-iterator.ts:47-49` | latch `#closed` + drain `#waiters` | 1h |
| A2 | 🟡 | latent | `next()` can't distinguish pushed `undefined` from empty buffer | `event-iterator.ts:33-34` | track emptiness by length | 20m |
| A3 | 🟠 | live | `onClose` handler loop unguarded — one throwing subscriber starves the rest | `client.ts:84-89` | try/catch per handler | 20m |
| A6 | 🟠 | live | unix `close()` does `end()` then `destroy()` — drops buffered final frame | `unix-socket-transport.ts:174-175` | await flush before destroy | 1h |
| A8 | 🟡 | latent | `#nextId` restarts at 1 per transport — dedupe hazard across reconnect | `*-transport.ts:42,129` | connection-scoped prefix | 30m |
| A10 | 🟡 | latent | `dispose()` leaves orphaned `#pendingEvents` (leak) | `client.ts:199-205` | clear all 3 maps as a unit | 15m |

### harness-broker-protocol (5)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🔴 | live | `NdjsonDecoder.push` corrupts multi-byte UTF-8 split across chunks (every frame) | `ndjson.ts:24` | long-lived `TextDecoder` + `{stream:true}` + drain in `flush()` | 1h |
| A2 | 🟠 | latent | `NdjsonDecoder` unbounded buffer — OOM on huge/newline-less line | `ndjson.ts:21-41` | `maxLineBytes` guard → terminal error | 1-2h |
| A3 | 🟠 | latent | `canonicalizeJson` asymmetric `undefined`/`function`/`symbol` in a **policy hash** | `lifecycle.ts:243-272` | reject non-JSON values | 2h |
| A4 | 🟡 | latent | `isJsonRpcResponse` accepts `result: undefined`; empty `method` accepted | `jsonrpc.ts:110-125` | `result !== undefined`; reject empty method | 30m |
| A8 | 🟠 | live | `isCredentialEnvKey` uppercase-only — `my_token` slips a credential filter | `env-keys.ts:47-59` | case-insensitive or document contract | 1h |

### harness-broker (9)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🔴 | live | ledger `loadExisting` `JSON.parse` per line, no try/catch — torn line crashes startup | `event-ledger.ts:166-186` | tolerant parse, drop torn tail | 0.5d |
| A2 | 🟠 | latent | `rewriteLedger` fsyncs temp but not parent dir before/after rename | `event-ledger.ts:198-218` | fsync dir fd after rename | <0.5d |
| A3 | 🟠 | latent | `currentSeq` does `Math.max(...keys)` — O(n)/`RangeError` on hot path at scale | `event-ledger.ts:130-136` | maintain running max | <0.5d |
| A5 | 🟠 | live | protocol-server fire-and-forget handlers race `close()` — response silently dropped | `protocol-server.ts:95-113` | track in-flight, send shutdown error | 0.5d |
| A6 | 🟡 | live | CLI shutdown/error exit can leave torn socket; no double-signal idempotency | `cli.ts:359-377` | await close, unlink on error, guard re-entry | 0.5d |
| A7 | 🟠 | live | `CodexRpcClient` no per-request timeout — never-answered RPC hangs forever | `rpc-client.ts:80-96` | per-request deadline | 0.5d |
| A8 | 🟡 | latent | hook listener never unlinks per-invocation socket; `catch{}` swallows envelope errors | `codex-cli-tmux/driver.ts:569-613` | unlink on close; emit diagnostic | <0.5d |
| A10 | 🟠 | latent | `error`-notification `turn.failed` doesn't clear `turnActive` → duplicate turn-terminal | `codex-app-server/driver.ts:123-220` | clear `turnActive`/timeout on emit | 0.5d |
| A11 | 🟡 | latent | codex stderr readline has no `'error'` listener — possible process crash | `codex-app-server/driver.ts:305-309` | add `'error'` handler | <0.5d |

### harness-claude (5)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🔴 | live | `PromptQueue.close()` doesn't wake a parked consumer — deadlock on teardown | `prompt-queue.ts:104-112` | call pending resolver with `null` | 0.5d |
| A3 | 🟠 | live | `canUseTool` ignores SDK `AbortSignal` — permission can outlive its turn | `hooks-bridge.ts:57-62` | wire signal to reject pending request | 0.5d |
| A4 | 🟠 | live | `invokeClaude` timeout is silent + leaks the timer on the throw path | `claude/invoke.ts:244-273` | `clearTimeout` in `finally`; surface timeout | 0.5d |
| A5 | 🟠 | live | `agent_end` reason decided by a teardown race (nondeterministic payload) | `agent-session.ts:281,455` | centralize end-emission | 0.5d |
| A8 | 🟡 | latent | `detect.ts` empty PATH segment → relative `./claude`; `supports*` always true | `claude/detect.ts:80-92` | skip empty segments; compute or drop flags | 0.25d |

### harness-codex (10)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🔴 | live | child stderr never drained — pipe-buffer deadlock | `codex-session.ts:206`, `rpc-client.ts:54` | drain stderr / `inherit` | 0.25d |
| A2 | 🟡 | latent | `CodexRpcClient.close()` leaks readline + process listeners | `rpc-client.ts:54-99` | `rl.close()` + detach handlers | 0.25d |
| A3 | 🟠 | live | `start()` clobbers an `error` state back to `running` | `codex-session.ts:212-271` | re-check state / sticky error flag | 0.25d |
| A4 | 🟠 | latent | session notifications not serialized (one-shot path is) — ordering trap | `codex-session.ts:213-215` | align on serialized queue | 0.25d |
| A5 | 🟡 | latent | `stop()` doesn't flush events-output write chain — lost data | `codex-session.ts:318-329` | await `eventsOutputPromise` | 0.1d |
| A6 | 🟡 | latent | URL image attachments bypass the file-image size guard | `codex-session.ts:758-783` | apply guard / document exemption | 0.25d |
| A7 | 🟠 | latent | `resolvePendingTurn` id mismatch can strand `sendPrompt` (no timeout) | `codex-session.ts:491-496` | key pending by id + turn timeout | 0.25d |
| A8 | 🟠 | latent | unknown approval request kills an otherwise-healthy session | `codex-session.ts:665-701` | forward-compatible decline+warn | 0.25d |
| A9 | 🟡 | latent | `recordMessage` write failure escalates to fatal session error | `codex-session.ts:374-379` | log/emit notice, continue | 0.1d |
| A11 | 🟡 | live | `detect` swallows real discovery errors into "not detected" | `codex-adapter.ts:670-740` | surface last non-ENOENT error | 0.25d |

### harness-pi (8)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🔴 | live | `await proc.exited` before draining stdout/stderr — pipe-buffer deadlock | `pi-adapter.ts:219,246,335` | read concurrently, then await exit | 0.5d |
| A2 | 🟠 | live | `supportsPiFlag` substring `includes` → cross-flag false positives | `pi-adapter.ts:251` | whole-token match | 1-2h |
| A3 | 🟡 | latent | `COMMON_PI_PATHS` frozen at import; dead `~` fallback never expands | `pi-adapter.ts:79-87` | compute in `findPiBinary`, expand/drop `~` | 1h |
| A4 | 🟠 | live | `buildRunArgs` `readdirSync` no guard — crashes instead of `--no-extensions` | `pi-adapter.ts:1184` | try/catch → `hasExtensions=false` | 1h |
| A5 | 🟠 | latent | intra-space extension name collision silently overwrites | `pi-adapter.ts:808-825` | detect dup `outName`, warn | 1-2h |
| A6 | 🟡 | latent | `detectPi` no in-flight de-dup — N concurrent callers each run full detection | `pi-adapter.ts:261-283` | memoize `Promise<PiInfo>` | 1h |
| A7 | 🟡 | latent | `findPiBinary` splits PATH on `:` only, keeps empty segments | `pi-adapter.ts:150-157` | `path.delimiter`, skip empties | 30m |
| A9 | 🟠 | latent | `materializeSpace` catch `rm`s a caller-supplied `cacheDir` it may not own | `pi-adapter.ts:901-905` | scope cleanup to created artifacts | 1-2h |

### harness-pi-sdk (8)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🟠 | latent | `--resume` emitted by adapter, rejected by runner `parseArgs` → `exit(1)` | `pi-sdk-adapter.ts:591`, `runner.ts:121-124` | drop flag or add no-op `--resume` case | 1h |
| A3 | 🔴 | live | `setPermissionHandler` stores a handler never read — permissions silently no-op | `pi-session.ts:60,71-73` | register `createPermissionHook` in `start()` | 3h |
| A4 | 🟠 | latent | `start()` ignores `skills`/`extensions`/`contextFiles` start-options | `types.ts:55-61` vs `pi-session.ts:75-135` | wire through or trim | 2-4h |
| A5 | 🟠 | latent | `sendPrompt` state machine no-op race; `streaming` never observable; no re-entrancy guard | `pi-session.ts:137-155` | drive state off event stream; reject concurrent | 0.5d |
| A6 | 🟡 | latent | `stop()` doesn't await `agentSession.abort()`; runs from `error` state | `pi-session.ts:157-178` | await abort, guard null | 2-3h |
| A8 | 🟠 | latent | `mapPiEventToUnified` default-arg state defeats held-latest for stateless callers | `pi-session.ts:431` | make `state` required | 30m |
| A9 | 🟠 | latent | `composeTarget` deterministic for extensions only — hooks/context/skills fs-ordered | `pi-sdk-adapter.ts:403,423-442,452` | stable-sort all artifact lists | 1h |
| A10 | 🟡 | latent | `agent_start` resets `held` — a stray pre-`agent_start` `message_end` is lost | `pi-session.ts:434-437` | flush held as `final:false` first | 1h |

### runtime (5)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🟠 | latent | temp file leaks on atomic-write rename failure | `agent-memory/store.ts:186-205` | unlink temp on rename catch | 30m |
| A2 | 🔴 | live | advisory-lock child stderr piped but never drained — unbounded hang | `agent-memory/store.ts:248-282` | `stderr:'ignore'` + read timeout | 1h |
| A3 | 🟠 | live | `MemoryStore.replace/remove` match by substring `includes` — data-loss footgun | `agent-memory/store.ts:237-245` | exact-match first; `match` option | 2h |
| A4 | 🟠 | live | `detectAvailable` no per-adapter timeout — one hung probe blocks all | `harness/registry.ts:86-105` | `Promise.race` w/ timeout | 1h |
| A6 | 🟠 | latent | global `lockQueues` map keyed by raw path — cross-instance coupling, no timeout | `agent-memory/store.ts:47,284-301` | scope to instance; max-wait timeout | 2h |

### spaces-runtime-contracts (3)

| ID | Sev | Class | Bug | Location | Recommended fix | Effort |
|----|-----|-------|-----|----------|-----------------|--------|
| A1 | 🟠 | latent | omitting an **array element** via `omitPaths` emits malformed canonical JSON (`[a,,c]`) | `hash.ts:69,83-88` | reject array-index omits or drop like object branch | 30m |
| A3 | 🟡 | latent | top-level `undefined`/`function`/`symbol` silently hashes `'null'` | `hash.ts:77-81` | throw at top-level entry | 20m |
| A4 | 🟠 | latent | `omitsLockedEnv` escaping asymmetry + no pointer-shape validation → silent bypass of determinism guard | `hash.ts:69,94,123-129` | validate pointer, single escaped tokenizer | 45m |

---

## Rollup

| | Live | Latent | Total |
|--|------|--------|-------|
| 🔴 High | 10 | 0 | 10 |
| 🟠 Med | ~22 | ~33 | ~55 |
| 🟡 Low | ~5 | ~27 | ~32 |
| **Total** | **~37** | **~60** | **97** |

**Cross-cutting pattern:** the same **pipe-buffer deadlock** (await child exit before draining stderr/stdout) appears independently in `harness-pi A1`, `harness-codex A1`, `harness-broker` (stderr A11), and `runtime A2` — worth one coordinated fix plus a shared spawn helper.

For the 52 non-bug findings (naming, DRY, dead-code, additive-API, test gaps), see [REFACTOR-BACKLOG.md](./REFACTOR-BACKLOG.md).
