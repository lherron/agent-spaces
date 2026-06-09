# Refactor Analysis — spaces-harness-broker

Package dir: `packages/harness-broker`
packageType: **concurrent** (event-ordered single-invocation broker; promise-serialized
drains/steers/hook pipelines; durability/fencing state machine). Analysis tuned to ordering
invariants and write-once state, not raw throughput.

## Summary

This package already absorbed TWO full SOLID/code-smell passes (T-02028, T-02030) the day before.
The result shows: the public boundary is deliberate and narrow, the invocation event state machine
is a single switch (not boolean soup), duplicated JSON-poke helpers were already lifted to
`drivers/hook-json.ts`, env/parse/normalize concerns are already SRP-split into their own modules,
and magic timing constants carry named consts + rationale comments. Most low-hanging fruit is gone.

I found **no High-risk and no public-surface findings**. The remaining items are a small number of
**Low-risk, internal-only** cleanups (a true helper duplication, two export-narrowing candidates, one
write-only local variable). Several tempting "findings" were pressure-tested and **left alone** — they
are load-bearing or already correct. A 0-applicable result would also have been honest here; the
applicable items below are real but minor.

## Public boundary verdict (assessed first, outside-in)

`src/index.ts` exports: `createBroker`/`Broker`/`BrokerOptions`, `createDefaultBroker`,
`createProtocolServer` + types, `createInvocationEventSequencer` + types, `BrokerError`/`toJsonRpcError`,
`createTmuxPaneController`/`TmuxPaneController` + tmux lease types, `createInvocationManager` +
`InvocationManager`/`Invocation`, `createDriverRegistry`/`DriverRegistry`, `createNoopDriver`,
the codex-cli-tmux normalizer/driver factory + kind, and `Driver`/`DriverContext`/`DriverStartResult`.

Verdict: **aligned and intentional — do NOT touch.** Every export is either a factory the CLI/consumers
construct or a type they pass. The boundary correctly exposes `TmuxPaneController` (the lease-consuming
controller the drivers actually use) while NOT exporting the legacy `TmuxManager` lifecycle class (see
DA-1). Cross-repo consumers (hrc-runtime) bind to these factories, so the package effectively has
external consumers — any signature change here is **public-surface** and must go through expand/contract,
not an auto-apply. None of the applicable findings touch this surface.

## Findings by mechanism

### F-1 — [T15] Collapse duplicated `getHookString` into the shared `hook-json` helper
- **Location:** `src/drivers/codex-cli-tmux/driver.ts:403` (`getHookString`), used at lines 252, 257, 258.
- **Mechanism:** T15 extract/merge missing abstraction — the duplicate already exists as
  `getString` in `src/drivers/hook-json.ts:21` (byte-identical body: `typeof value === 'string'`).
  The codex hook-events module already imports `getString` from `hook-json`; the driver re-declares
  its own copy instead of importing it.
- **Direction:** MERGE toward the existing shared helper (import `getString` from `../hook-json`,
  delete the local `getHookString`, rename the 3 call sites). This is dedup toward an established
  single source, not new abstraction.
- **Preservation:** Identical behavior — same predicate, same return type. No event shape, ordering,
  or fencing change.
- **Risk:** Low. **apiImpact:** internal-only (`getHookString` is a module-local function, not exported).
- **Tests:** existing codex-cli-tmux driver tests cover the hook-string reads (turn_id / hook_event_name
  / transcript_path); no test references `getHookString` by name. No new tests required.
- **Contraindication checked:** `extractHookRecord` in the SAME file is NOT a duplicate of
  `hook-json.unwrapHookPayload` — `extractHookRecord` selects among `hookData/hookEvent/payload/envelope`
  at the ENVELOPE level and then unwraps a nested `hookEvent`, whereas `unwrapHookPayload` operates on an
  already-selected hook record. Leave `extractHookRecord` alone; only `getHookString` is the true dup.

### F-2 — [T07] Narrow module-local `scrubInheritedEnv` from `export` to private
- **Location:** `src/runtime/tmux-env.ts:25` (`export function scrubInheritedEnv`).
- **Mechanism:** T07 align interface to actual usage — `scrubInheritedEnv` is `export`ed but its ONLY
  caller is `sanitizeTmuxClientEnv` in the same file (line 46). No other src module and no test imports
  it (verified by grep). The public seam for callers is `sanitizeTmuxClientEnv` /
  `listInheritedEnvKeysToScrub` / `sanitizeTmuxServerPath`, all of which ARE consumed by `tmux.ts`.
- **Direction:** Drop the `export` keyword (narrow the surface). Pure subtraction.
- **Preservation:** No behavior change; it remains callable from its single in-file caller.
- **Risk:** Low. **apiImpact:** internal-only (module is not re-exported from index.ts).
- **Tests:** none reference it; no churn.
- **Contraindication checked:** This is a deliberate option only if a test or sibling is expected to
  reach it directly — grep shows neither does. Safe to narrow. (If the apply phase is conservative about
  removing exports that *could* be a test seam, this is the one to skip first — it is the lowest-value item.)

### F-3 — [T07] Narrow the unused direct `buildHookEnvelope` / `buildCodexHookEnvelope` exports
- **Location:** `src/drivers/claude-code-tmux/hook-ingestion.ts:18` (`buildHookEnvelope`);
  `src/drivers/codex-cli-tmux/hook-ingestion.ts:18` (`buildCodexHookEnvelope`).
- **Mechanism:** T07 — both functions are `export`ed but consumed only by their own
  `*FromEnv` wrapper in the same file. No `src` sibling and no test imports the direct (non-`FromEnv`)
  variant (grep confirms only the in-file `return buildHookEnvelope(...)` call sites). The `*FromEnv`
  variants are the real seam the bridges use.
- **Direction:** Drop the `export` on the two direct builders (keep `*FromEnv` exported). Subtraction.
- **Preservation:** No behavior change; the in-file wrapper still calls them.
- **Risk:** Low. **apiImpact:** internal-only.
- **Tests:** none import these directly; the bridges test through `*FromEnv`. No churn.
- **Contraindication checked:** These split exist to separate "env extraction + validation"
  (`*FromEnv`) from "pure envelope shaping" (`build*`). The pure builder is a legitimate seam IF a test
  wanted to construct an envelope without env plumbing — but no such test exists today. Narrowing is safe
  now and trivially reversible (re-add `export`) if a future test needs it. **Lower priority than F-1.**

### F-4 — [T16] Dead local state: write-only `liveSocket` in the unix runtime
- **Location:** `src/cli.ts:245` (`let liveSocket`), assigned at 311 and 362, read only in the
  `liveSocket === socket` guard at 365 before clearing `liveServer`.
- **Mechanism:** T16 remove structure whose variation never materialized — `liveSocket`'s VALUE is never
  consumed (no property/method access; grep shows no `liveSocket.`). It exists solely as an identity token
  for the cleanup comparison. The cleanup's real job is "clear `liveServer` iff THIS socket was the live
  one." That identity check can be expressed against the data already in scope.
- **Direction:** Two honest options, both preserving behavior:
  (a) keep `liveSocket` but acknowledge it is purely the cleanup identity key (status quo — no edit), or
  (b) DE-duplicate the paired tracking by guarding cleanup on a single live-channel record (e.g. compare
  `activeController?.socket === socket` / track only `liveServer` alongside its socket in one object), so
  there is one "who is live" datum instead of two parallel `liveServer`/`liveSocket` writes.
- **Preservation:** The fencing/notify path uses `liveServer`, not `liveSocket`; option (b) must keep the
  invariant "cleanup clears `liveServer` only when the closing socket is the current live one" EXACTLY,
  including the interaction with `activeController` reset at 369. This is concurrency-sensitive (latest
  connection wins; previous controller fenced on attach), so behavior equivalence must be proven, not
  assumed.
- **Risk:** Low for option (a)/no-op; **Med if option (b) is attempted** because it touches the
  live-channel/fencing bookkeeping in the durable runtime — exactly the path the broker-tmux pane-lease
  e2e exercises. Recommend (a): treat as documented-intent, leave the variable, and (optionally) add a
  one-line comment that `liveSocket` is the cleanup identity key only.
- **apiImpact:** internal-only.
- **Tests:** the unix attach/fence path is covered by durability + broker-tmux e2e; option (b) would
  require re-running that e2e (per the broker-tmux-ghostmux-e2e runbook), not just unit tests.
- **Contraindication checked:** This is NOT obviously dead — removing it naively (deleting the variable)
  would break the `=== socket` cleanup guard. It is "write-mostly," not "write-only-unused." Flagged for
  visibility; the safe action is to leave it.

## Deliberately left alone (pressure-tested, NOT findings)

- **DA-1 — `TmuxManager` lifecycle class (`runtime/tmux.ts:130-325`) is NOT exported from index.ts and
  has NO production caller** (drivers use `TmuxPaneController` via leases; grep shows zero `src`
  references to `createTmuxManager`/`ensurePane`/`createSession`/`getAttachDescriptor`). It is kept alive
  ONLY by `test/runtime/tmux.test.ts`. This is the single largest T16 de-abstraction candidate in the
  package (~200 lines: session create/rename/retire, version probe, server scrub, attach descriptor).
  **Left alone deliberately:** (1) it has a dedicated characterization test that asserts its behavior, so
  it is not unguarded dead code; (2) removing it is a **behavior/scope decision** (does the broker still
  owe a session-owning lifecycle path, or is lease-only now the permanent contract?), which per the
  pre-HRC / driver-certification direction is a product call, not an auto-apply; (3) `parsePaneState` is
  re-exported from `tmux.ts` for backward compat and is consumed by `TmuxManager`'s own methods. If the
  lease-only model is confirmed permanent, deleting `TmuxManager` + its test + the `parsePaneState`
  back-compat re-export is the highest-leverage cleanup — but it is a **redesign flag, not a refactor**.
- **`Invocation` event state machine (`invocation-manager.ts:495`)** — a single `switch` over event type
  with one well-commented fallthrough (`turn.completed` → shared turn-end projection, with a scoped
  `biome-ignore`). This is already the T19 dispatch shape; the boolean-ish fields
  (`terminalEmitted`/`disposedEmitted`/`summaryEmitted`/`harnessStartedSeen`) are write-once idempotency
  guards, each justified by a comment. Not boolean soup; leave it.
- **`busyPolicyHandlers` table (`invocation-manager.ts:476`)** — already the OCP dispatch table the prior
  pass introduced (one handler per `whenBusy` policy). Adding a policy is a table entry. Correct as-is.
- **Duplicated driver capability descriptors** (`CLAUDE_CODE_TMUX_CAPABILITIES`,
  `CODEX_CLI_TMUX_CAPABILITIES`, `CODEX_CAPABILITIES`, `NOOP_CAPABILITIES`, `TEST_CAPABILITIES`) — these
  LOOK like duplication but are **load-bearing divergence**: each driver advertises a genuinely different
  capability surface (claude has `continuation.provider:'anthropic'`/`keyKind:'session'` and
  `events.toolCalls:true`; codex-cli omits provider; codex-app-server has `localImages:true`/`usage:true`;
  noop has `user:true` but `applyInputNow` throws). Parameterizing them into one factory would couple
  unrelated drivers and invite accidental capability drift. Keep them separate (defense-in-depth /
  diverging-copies contraindication).
- **Two transcript readers** (`claude-code-tmux/hook-transcript.ts`,
  `codex-cli-tmux/hook-transcript.ts`) share the byte-offset JSONL tailer SHAPE but the codex one carries
  held-latest/delta-coalescing/terminal-classification the claude one explicitly does NOT need (its
  doc-comment says so). The shared JSON-poke primitives are ALREADY factored into `hook-json.ts`. Merging
  the tailers would force the simpler reader to carry the complex reader's state. Leave separate.
- **`safeStartedPayload` / `normalizeEventPayload` partial-handling** (`runtime/event-normalize.ts`) — the
  string-leaf truncation and well-known-shape constraints are total over their input and fail safe
  (unserializable → marker). No swallowed errors that hide expected outcomes. Correct.
- **`emit()` recursion for diagnostics + graceful-exit summary** (`invocation-manager.ts:651-704`) — the
  re-entrant `emit` for truncation diagnostics and the once-guarded `invocation.summary` push are
  intentional and guarded (`summaryEmitted`); the comment explains the ordering requirement (summary
  recorded before lease reap). Not a nesting/partial-function smell.

## Outside-in apply sequence

1. **Pin the boundary (T40, no code):** the index.ts surface and the durable-runtime fencing path are
   characterized by existing durability + broker-tmux e2e + driver unit tests. Confirm green before
   touching anything. None of the applicable findings change the boundary, so no expand/contract needed.
2. **F-1 (Low, internal):** replace the local `getHookString` in `codex-cli-tmux/driver.ts` with the
   imported `getString` from `../hook-json`. Run codex-cli-tmux driver + hook-events tests.
3. **F-3 (Low, internal):** drop `export` on the two direct `build*HookEnvelope` builders (keep
   `*FromEnv`). Re-run hook-ingestion/bridge tests.
4. **F-2 (Low, internal):** drop `export` on `scrubInheritedEnv` (lowest value; skip if the apply phase
   prefers to preserve possible test seams). Re-run tmux-env / tmux tests.
5. **F-4:** prefer the no-op/comment-only path (option a). Do NOT attempt the live-channel consolidation
   (option b) inside an auto-apply pass — it perturbs durable fencing bookkeeping and needs the
   broker-tmux ghostmux e2e to re-certify.
6. **DA-1 (TmuxManager removal):** out of scope for auto-apply — surface to a human as a redesign/scope
   decision (lease-only permanence). If confirmed, it is the single highest-leverage de-abstraction.

After 2–4, run the package build + lint (`getString` fold is lint-neutral — no `typeof`-in-a-helper
biome trap because `hook-json.getString` already exists and is already used) and the full test suite.
