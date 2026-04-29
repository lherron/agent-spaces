# acp-ops-reducer Refactor Notes

## Purpose

`acp-ops-reducer` is the pure client-side reducer package for the ACP operator session dashboard. It stores projected dashboard events, derives session timeline rows through `acp-ops-projection`, maintains reconnect/drop counters and the durable HRC cursor, parses incremental NDJSON event streams, applies event filters, and exposes sorted rows/events for the ops web UI.

## Public surface

Package export: `acp-ops-reducer` exports `./src/index.ts` for Bun and `./dist/index.js`/`./dist/index.d.ts` for built imports.

Exported types:

- `DashboardEvent` and `SessionTimelineRow`, re-exported from `acp-ops-projection`.
- `ReducerWindow`, with `fromTs`, `toTs`, and `windowMs`.
- `ReducerState`, with `rows`, `events`, `lastProcessedHrcSeq`, `droppedEvents`, `reconnectCount`, and `window`.
- `ReducerEventFilters`, with optional session, runtime, run, family, severity, and timestamp filters.
- `ParsedNdjsonChunk`, with parsed `events`, trailing `remainder`, and `droppedLines`.

Exported functions:

- `applyEvent(state, event)`: idempotently adds a `DashboardEvent`, sanitizes payload previews, updates the matching row, marks superseded generations as blocked, and advances `lastProcessedHrcSeq`.
- `reconnect(state)`: increments `reconnectCount`.
- `setWindow(state, windowMs, nowTs)`: updates the active time window and rebuilds derived rows.
- `compact(state)`: removes events older than `state.window.fromTs`, preserving invalid-timestamp events and cursor metadata.
- `parseNdjsonChunk(buffer)`: parses complete newline-delimited JSON lines, returns the incomplete trailing line as `remainder`, and counts malformed complete lines.
- `selectVisibleEvents(state, filters)`: filters events and sorts them by timestamp with `hrcSeq` fallback.
- `selectSortedRows(state)`: sorts timeline rows by `stats.lastEventAt`, then host session id, then generation.

There are no HTTP routes or CLI commands in this package. Runtime consumers are `packages/acp-ops-web/src/store/useReducerStore.ts`, `packages/acp-ops-web/src/api/stream.ts`, and `packages/acp-ops-web/src/hooks/useDetailEventBackfill.ts`.

## Internal structure

- `src/index.ts`: all reducer implementation. The top of the file defines public reducer state/filter types, local payload-preview sanitization helpers, event ordering, row identity helpers, superseded-generation handling, row rebuilding, exported reducer operations, the NDJSON parser, and selectors.
- `test/reducer.red.test.ts`: Bun red-contract tests for ordered replay, idempotency, replay dedupe, malformed NDJSON recovery, ordering, generation rotation, stale-context visibility, in-flight input paths, payload redaction, compaction, and reconnect cursor behavior.
- `package.json`: workspace package metadata, exports, scripts, and the `acp-ops-projection` production dependency.
- `tsconfig.json`: composite TypeScript project rooted at `src`, excluding tests and referencing `../acp-ops-projection`.

## Dependencies

Production dependency:

- `acp-ops-projection`: supplies `DashboardEvent`, `SessionTimelineRow`, and `deriveSessionRow`.

Test/development dependencies:

- `bun:test`: imported by `test/reducer.red.test.ts` from the Bun runtime.
- `@types/bun`: package dev dependency for Bun typings.
- `typescript`: package dev dependency for build/typecheck.
- `acp-ops-web` is not a package dependency, but it is the current runtime consumer and imports reducer APIs directly.

## Test coverage

The package has 11 Bun tests in `test/reducer.red.test.ts`. Covered behavior includes ordered replay, duplicate event idempotency, replay dedupe, malformed NDJSON line drops, timestamp tie ordering, generation rotation, stale-context warning visibility, in-flight input event visibility, payload redaction before exposure, bounded-window compaction, and reconnect cursor preservation.

Gaps:

- `selectVisibleEvents` does not have direct tests for every filter field (`scopeRef`, `laneRef`, `hostSessionId`, `runtimeId`, `runId`, `family`, `severity`, `fromTs`, `toTs`) or for invalid date filter behavior.
- `selectSortedRows` has indirect coverage through simple row ordering, but no test for invalid/missing `stats.lastEventAt`, host-session tie-breaks, or generation tie-breaks.
- `setWindow` is only covered through compaction setup; it lacks direct assertions for negative `windowMs`, invalid `nowTs`, and row stat recalculation after a window change.
- `parseNdjsonChunk` is not tested for multiple valid lines, blank-only input, trailing newline behavior, or valid JSON with an invalid event shape.

## Recommended refactors and reductions

1. Share redaction logic with `acp-ops-projection` instead of maintaining a second sanitizer in `packages/acp-ops-reducer/src/index.ts`. The reducer duplicates `REDACTED_VALUE`, credential key matching, raw-provider key matching, and recursive object traversal already present in `packages/acp-ops-projection/src/index.ts` (`redactPayload`/`redactValue`). Exporting or reusing a projection-level helper would reduce drift in credential detection and truncation/depth behavior.

2. Move row identity into a shared exported helper. `packages/acp-ops-reducer/src/index.ts` has private `rowIdFor(event)`, while `packages/acp-ops-web/src/store/useReducerStore.ts` has its own `eventRowId(event)` with the same `${hostSessionId}:${generation}` convention. Exporting a small `eventRowId`/`rowIdForEvent` from the reducer or projection package would remove duplicate identity rules at the reducer/web boundary.

3. Split `packages/acp-ops-reducer/src/index.ts` by responsibility before adding more behavior. The file currently combines redaction, ordering, row derivation orchestration, reducer state transitions, stream parsing, and selectors in 340 lines. Natural low-risk modules are `redaction`, `rowIdentity`, `ndjson`, `selectors`, and `stateTransitions`; this would make the existing test gaps easier to cover without changing the public API.

4. Avoid full event scans on every accepted event in `applyEvent`. `eventsForRow(events.values(), rowId)` scans all retained events to derive a single row, and then `markSupersededRows` scans all rows. This is acceptable for the current small package, but the reducer already compacts only by time window and the stream can replay/backfill many events. Keeping a row-to-event index inside `ReducerState` or rebuilding rows only in batch paths would reduce repeated work in `applyEvent` and make the compaction/window paths the explicit rebuild points.

5. Add event-shape validation at the NDJSON boundary or rename `parseNdjsonChunk` to make its contract explicit. `parseNdjsonChunk` currently casts any valid JSON line to `DashboardEvent`, so `{}` or an array is accepted as an event and failures move downstream into reducer/projection code. A narrow validator for required fields (`id`, `hrcSeq`, `ts`, `sessionRef`, `hostSessionId`, `generation`, `eventKind`, `family`, `severity`, `label`, `redacted`) would localize bad stream data handling and make `droppedLines` mean "not a usable dashboard event," not only "not JSON."
