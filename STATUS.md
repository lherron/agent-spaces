# Session Dashboard Implementation Status

**Spec:** `~/praesidium/acp-spec/spec/orchestration/SESSION_DASHBOARD.md`
**Scope:** Phase 1 (read-only local operator view) from spec §21.
**State:** ✅ Phase 1 complete. All 7 wrkq tasks closed. Live E2E smoke green.

## Final delivery (2026-04-24)

| ID | Purpose | Assignee | State | Result |
|---|---|---|---|---|
| T-01201 | G1 red tests + type scaffold (projection) | smokey | completed | 29 tests, 28 red, 1 pass. Types frozen. |
| T-01200 | G2 red tests (server endpoints) | curly | completed | 33 tests, all red (404s). |
| T-01199 | G3 red tests (reducer) | smokey | completed | 11 red tests, API scaffold. |
| T-01202 | G4+G5 red tests (web + Playwright) | larry | completed | 7 Playwright red tests + Vite/React scaffold. |
| T-01203 | G1 impl (projection) | cody | completed | 29/29 green. |
| T-01204 | G2+G3 impl (server + reducer) | larry | completed | Reducer 11/11. Server ops 33/33. Full acp-server suite 254/254. |
| T-01205 | G4+G5 impl (web) | cody (recovery from curly) | completed | 7/7 Playwright green. Vite build clean. |

### Adjacent issues discovered

- **T-01206**: HRC zombie-runtime bug. Curly's T-01205 runtime crashed mid-work; `hrc runtime terminate` errors with "missing tmux state". Workaround: dispatched recovery on `cody@agent-spaces:T-01205` (fresh session). Curly's partial work on disk (api/snapshot.ts, api/stream.ts, store/useReducerStore.ts) was preserved and folded in.

## Live E2E smoke (2026-04-24 03:10 UTC)

Dev stack: HRC ✅, ACP ✅, workboard ✅ (taskboard down — pre-existing, unrelated).

- `GET /v1/ops/session-dashboard/snapshot` → well-formed `SessionDashboardSnapshot` JSON. window, cursors, summary, sessions all populated from live HRC state. eventRatePerMinute=46 at smoke time.
- `GET /v1/ops/session-dashboard/events?follow=true&fromSeq=25000` → NDJSON stream of real dashboard events. Projection applied (family, severity, eventKind). Redaction working: `max_output_tokens: "[REDACTED]"` observed in payloadPreview.

## Architecture (locked, as shipped)

- **Packages:** `packages/acp-ops-projection` (pure mapping + redaction), `packages/acp-ops-reducer` (pure client state), `packages/acp-ops-web` (Vite + React + Zustand + Canvas 2D).
- **Cursor:** `hrcSeq` only (Phase 1). ACP-global merged cursor deferred to Phase 2.
- **Delivery state:** joined snapshot only. Not eventized.
- **Auth:** SKIPPED for Phase 1. No authZ middleware. Open routes.
- **Raw payload:** gated by `ACP_DASHBOARD_RAW_PAYLOAD=1` env flag (read at call time in projection).
- **Canvas:** Canvas 2D, not PixiJS. Reason: Playwright tests use `getContext('2d') + getImageData()` which is incompatible with WebGL contexts.

## Spec sections delivered

- §7 views, §8 types, §9 family mapping, §10 API shape, §11 streaming, §12 reducer invariants, §13 rendering, §14 visual semantics, §15 performance targets, §16 redaction, §18 reconnect semantics, §19 test surface.

## Out of scope / Phase 2

- ACP Run / InputAttempt / task / coordination / delivery joins.
- ACP-merged cursor.
- Authorization + mutating controls (attach/capture/interrupt/terminate).
- Cross-host federation.
