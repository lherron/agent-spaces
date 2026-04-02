# HRC Code Review and Architecture Assessment

**Date:** 2026-03-31
**Reviewers:** Larry (hrc-server, hrc-bridge-agentchat), Smokey (hrc-core, hrc-store-sqlite, hrc-launch), Curly (hrc-sdk, hrc-cli, hrc-adapter-agent-spaces)
**Reference:** HRC_IMPLEMENTATION_PLAN.md

## Summary

**4 critical, 14 major, 12 minor, 7 nit**

Overall assessment: package boundaries are mostly respected, including `hrc-adapter-agent-spaces` as the only bridge into `agent-spaces` public APIs. The implementation is not production-ready yet. The main blockers are daemon single-instance safety, launch/store crash paths, and several server/runtime state-transition races that can corrupt or strand runtime state.

### Recommended remediation order

1. Fix the four criticals (launch crash paths, store JSON parse, daemon lock)
2. Fix server runtime/dispatch/watch races (findings 5-8)
3. Fix contract/type mismatches around SDK watch, in-flight input, and provider validation (findings 10-11, 19-22)
4. Backfill tests for FK enforcement, continuity derivation, and launch failure paths

---

## Critical

### C-1: Single-instance daemon lock is non-atomic (split-brain risk)
- **File:** packages/hrc-server/src/index.ts:2002-2016
- **Category:** concurrency
- **Reviewer:** Larry
- **Finding:** The single-instance guard is not atomic and does not verify socket health when the lock file is missing. Two concurrent startups can both observe no lock and both write `server.lock`, and a second startup with a deleted/missing lock will blindly unlink an active daemon's socket before starting. That can create split-brain daemons writing the same SQLite/tmux state.
- **Recommendation:** Acquire the lock with an atomic exclusive create/open, then probe the existing socket before removing anything. Only clear the lock/socket after proving the recorded owner is dead and the socket is stale.

### C-2: JSON parsing without error handling crashes all repository reads
- **File:** packages/hrc-store-sqlite/src/repositories.ts:227-233
- **Category:** errors
- **Reviewer:** Smokey
- **Finding:** `parseJson<T>()` calls `JSON.parse()` without try-catch. If any JSON column contains corrupted data, the entire query crashes with an unhandled `SyntaxError`. This is the central JSON deserialization path used by every repository.
- **Recommendation:** Wrap in try-catch, return `undefined` or a typed corruption result, and log context (table, column, row key).

### C-3: No child.on('error') handler in launch exec
- **File:** packages/hrc-launch/src/exec.ts:64-79
- **Category:** errors
- **Reviewer:** Smokey
- **Finding:** `spawn()` has no `error` event handler. If the command doesn't exist or can't be executed (ENOENT, EACCES), Node emits an `error` event. Without a handler, this crashes the wrapper after `wrapper-started` has been posted — leaving launches stranded with no terminal callback.
- **Recommendation:** Add `child.on('error', ...)` that posts a failure callback or spools it, then exits.

### C-4: Unhandled promise rejection in exit handler
- **File:** packages/hrc-launch/src/exec.ts:99-107
- **Category:** errors
- **Reviewer:** Smokey
- **Finding:** The `callbackOrSpool()` promise in `child.on('exit')` has `.then()` but no `.catch()`. If spooling fails (spool dir inaccessible, disk full), this is an unhandled rejection and the process hangs indefinitely.
- **Recommendation:** Add `.catch()` that logs the error and still resolves with the exit code.

---

## Major

### M-5: Failed tmux dispatch leaves runtime stuck busy
- **File:** packages/hrc-server/src/index.ts:662-716, 2253-2343
- **Category:** errors
- **Reviewer:** Larry
- **Finding:** The tmux dispatch path persists `run=accepted`, `runtime.status=busy`, and the accepted launch before launch completion. If `writeLaunchArtifact(...)` or `tmux.sendKeys(...)` fails, the request returns 500 but the runtime stays busy. Reconciliation never repairs this because `accepted` launches are not orphanable.
- **Recommendation:** Make the pre-launch state transition transactional/rollback on failure, or add an explicit recoverable intermediate state and include `accepted` launches in reconciliation.

### M-6: Terminate doesn't finalize active run — exited callback can resurrect
- **File:** packages/hrc-server/src/index.ts:1304-1334, 1408-1454
- **Category:** concurrency
- **Reviewer:** Larry
- **Finding:** `POST /v1/terminate` marks the runtime terminated but does not clear `activeRunId`, finalize the run, or tombstone the launch. A later `/exited` callback flips the runtime back to `ready`.
- **Recommendation:** Termination should atomically finalize/cancel the active run. `handleExited(...)` should ignore exits for terminated launches.

### M-7: Bridge registration reuses stale binding after session rotation
- **File:** packages/hrc-server/src/index.ts:1106-1141
- **Category:** api
- **Reviewer:** Larry
- **Finding:** Bridge registration deduplicates only on `(transport, target)` and returns existing records even when `hostSessionId`, `runtimeId`, or fence have changed. After clear-context, clients get a stale bridge.
- **Recommendation:** Reuse only when full binding identity matches, or explicitly rebind when identity differs.

### M-8: Watch follow mode can lose events during subscription handoff
- **File:** packages/hrc-server/src/index.ts:556-590
- **Category:** concurrency
- **Reviewer:** Larry
- **Finding:** `/v1/events?follow=true` snapshots `listFromSeq()` before registering the subscriber. Events appended between snapshot and subscription are lost.
- **Recommendation:** Register subscriber before catch-up query, or capture high-water seq and replay through the boundary.

### M-9: hrc-cli statically depends on hrc-server
- **File:** packages/hrc-cli/package.json
- **Category:** architecture
- **Reviewer:** Curly
- **Finding:** The plan defines CLI as a thin wrapper over hrc-sdk. Static dependency on hrc-server couples packaging/build to the server.
- **Recommendation:** Move `hrc-server` to `peerDependencies` or extract the server command.

### M-10: SDK watch() crashes on malformed NDJSON
- **File:** packages/hrc-sdk/src/client.ts:248-251
- **Category:** errors
- **Reviewer:** Curly
- **Finding:** `JSON.parse(trimmed)` with no try/catch. One malformed line kills the async generator.
- **Recommendation:** Catch parse failures and skip, yield typed error, or expose error callback.

### M-11: Unchecked provider cast in SDK adapter
- **File:** packages/hrc-adapter-agent-spaces/src/sdk-adapter/index.ts:199
- **Category:** types
- **Reviewer:** Curly
- **Finding:** `response.provider as HrcProvider` — unexpected providers enter the domain silently.
- **Recommendation:** Validate against the union and throw on mismatch.

### M-12: Fence parsing throws wrong error types
- **File:** packages/hrc-core/src/fences.ts:31-78
- **Category:** errors
- **Reviewer:** Smokey
- **Finding:** `parseFence()` throws `TypeError`/`RangeError` instead of `HrcBadRequestError`. Invalid fences surface as 500s.
- **Recommendation:** Replace with `HrcBadRequestError(HrcErrorCode.INVALID_FENCE, ...)`.

### M-13: Event append is non-transactional
- **File:** packages/hrc-store-sqlite/src/repositories.ts:1784-1835
- **Category:** concurrency
- **Reviewer:** Smokey
- **Finding:** `INSERT` then `SELECT last_insert_rowid()` as separate statements. Safe under single-writer but fragile.
- **Recommendation:** Wrap in explicit transaction.

### M-14: No FK constraint violation tests
- **File:** packages/hrc-store-sqlite/src/__tests__/
- **Category:** tests
- **Reviewer:** Smokey
- **Finding:** Tests verify pragma but never test that invalid FK inserts are rejected.
- **Recommendation:** Add negative FK tests.

### M-15: Continuity chain derivation untested
- **File:** packages/hrc-store-sqlite/src/repositories.ts:487-524
- **Category:** tests
- **Reviewer:** Smokey
- **Finding:** `derivePriorHostSessionIds()` has cycle detection and ordering logic but no direct tests.
- **Recommendation:** Add chain ordering and cycle-detection edge case tests.

### M-16: Spool sequence TOCTOU race
- **File:** packages/hrc-launch/src/spool.ts:15-24
- **Category:** concurrency
- **Reviewer:** Smokey
- **Finding:** `spoolCallback()` reads existing seqs, computes next, then writes — not atomic. Concurrent spoolers can overwrite.
- **Recommendation:** Use exclusive file creation (`wx`) with retry, or use PID+timestamp for uniqueness.

### M-17: No spool replay helper exported from hrc-launch
- **File:** packages/hrc-launch/src/
- **Category:** architecture
- **Reviewer:** Smokey
- **Finding:** `readSpoolEntries()` exists but no replay function. The package owns the format but doesn't own replay.
- **Recommendation:** Export a replay helper that reads, posts, and removes delivered entries.

### M-18: Hook CLI doesn't validate parseInt result
- **File:** packages/hrc-launch/src/hook-cli.ts:35
- **Category:** errors
- **Reviewer:** Smokey
- **Finding:** `Number.parseInt(generationStr, 10)` can produce NaN from malformed env var. NaN propagates into hook payload.
- **Recommendation:** Add `isNaN` check and fail fast.

---

## Minor

### m-19: In-flight input SDK type mismatch
- **File:** packages/hrc-sdk/src/types.ts:72-77 vs packages/hrc-server/src/index.ts:113-118
- **Category:** api | **Reviewer:** Curly
- **Finding:** SDK makes both `input` and `prompt` optional; server requires `prompt`.
- **Recommendation:** Make `prompt` required, treat `input` as deprecated alias.

### m-20: Watch has no AbortSignal/cancellation
- **File:** packages/hrc-sdk/src/client.ts:221-259
- **Category:** concurrency | **Reviewer:** Curly
- **Finding:** Abandoned follow-mode consumers leave connections lingering.
- **Recommendation:** Accept optional `AbortSignal` in `WatchOptions`.

### m-21: SDK turn has no timeout/cancellation
- **File:** packages/hrc-adapter-agent-spaces/src/sdk-adapter/index.ts:152-194
- **Category:** concurrency | **Reviewer:** Curly
- **Finding:** Hung runner blocks indefinitely.
- **Recommendation:** Accept optional `AbortSignal`.

### m-22: Error parsing discards non-JSON response bodies
- **File:** packages/hrc-sdk/src/client.ts:80-86
- **Category:** errors | **Reviewer:** Curly
- **Finding:** Non-JSON responses (proxy 502, empty body) produce generic status-only errors.
- **Recommendation:** Fall back to `res.text()` and include excerpt.

### m-23: CLI arg parsing rejects dash-prefixed values
- **File:** packages/hrc-cli/src/cli.ts:28, 38
- **Category:** quality | **Reviewer:** Curly
- **Finding:** Fragile pattern that differs from standard conventions.
- **Recommendation:** Use `--flag=value` syntax or `--` separator.

### m-24: Duplicate CONFLICT/STALE_CONTEXT error code
- **File:** packages/hrc-core/src/errors.ts:10-11
- **Category:** quality | **Reviewer:** Smokey
- **Finding:** Both map to `'stale_context'`; CONFLICT is unused.
- **Recommendation:** Remove alias or document.

### m-25: Forward-declared error codes not in plan
- **File:** packages/hrc-core/src/errors.ts:8-9
- **Category:** architecture | **Reviewer:** Smokey
- **Finding:** UNKNOWN_SURFACE and UNKNOWN_BRIDGE not in plan's HTTP error model.
- **Recommendation:** Mark as phase 4/5 forward declarations.

### m-26: paths.ts falls back to CWD when HOME unset
- **File:** packages/hrc-core/src/paths.ts:44
- **Category:** quality | **Reviewer:** Smokey
- **Finding:** Missing HOME → `./.local/state/hrc` is surprising.
- **Recommendation:** Throw or use safe fallback.

### m-27: Opaque JSON fields lack validation guidance
- **File:** packages/hrc-core/src/contracts.ts
- **Category:** types | **Reviewer:** Smokey
- **Finding:** `Record<string, unknown>` with no documented trust boundary.
- **Recommendation:** Document where validation is expected.

### m-28: Duplicate get/find method aliases
- **File:** packages/hrc-store-sqlite/src/repositories.ts
- **Category:** quality | **Reviewer:** Smokey
- **Finding:** Identical methods double the API surface.
- **Recommendation:** Pick one convention, remove aliases.

### m-29: parseJson uses unsafe type assertion
- **File:** packages/hrc-store-sqlite/src/repositories.ts:232
- **Category:** types | **Reviewer:** Smokey
- **Finding:** `JSON.parse(value) as T` silently casts.
- **Recommendation:** Document trust boundary.

### m-30: Launch artifact argv not length-validated at parse boundary
- **File:** packages/hrc-launch/src/launch-artifact.ts
- **Category:** errors | **Reviewer:** Smokey
- **Finding:** Empty argv check happens in exec.ts, not at parse time.
- **Recommendation:** Move validation to `readLaunchArtifact`.

---

## Nit

- **n-33:** `_STUB_COMMANDS` dead code in cli.ts:78 (Curly)
- **n-34:** `watch()` sends `follow=false` redundantly (Curly)
- **n-35:** `toEventJson` destructure/re-include pattern is unclear (Curly)
- **n-36:** Tests use `as any` to bypass types (Curly)
- **n-37:** Missing error-path integration tests in hrc-launch (Smokey)
- **n-31:** Error subclass constructors untested (Smokey)
- **n-32:** Missing runtime_id index on local_bridges (Smokey)

---

## Architecture Compliance

All reviewers confirmed package boundaries are respected:
- `hrc-adapter-agent-spaces` is the only bridge to `agent-spaces` and uses public APIs only (not `src/*` internals)
- `cli-adapter/` and `sdk-adapter/` split matches the plan
- `hrc-core` has zero side effects, no agent-spaces imports, correct deps on agent-scope and spaces-config
- `hrc-store-sqlite` has proper WAL/FK/busy_timeout pragmas, all 10 tables present
- `hrc-launch` has correct wrapper callback order (wrapper-started → child-started → exited)
- SDK client covers all 30 server endpoints
- Correlation env vars (HRC_SESSION_REF, HRC_HOST_SESSION_ID, HRC_RUN_ID) correctly injected
- Env merge order correct: base → correlation → launch overrides → unset → pathPrepend
