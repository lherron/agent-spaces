# acp-ops-web Refactor Notes

## Purpose

`acp-ops-web` is the Vite/React operator dashboard for ACP/HRC live sessions. It loads a session-dashboard snapshot, follows the ACP operations event stream, reduces events into visible session rows, and renders a dense monitoring UI with a queue, canvas timeline, event stream, inspector, status strip, and replay controls.

## Public Surface

This package is private and does not publish a library entrypoint. Its executable surface is the package scripts in `package.json`: `bun run dev` starts Vite, `bun run build` builds the dashboard, `bun run typecheck` runs `tsc --noEmit`, and `bun run test` runs Playwright. The browser app mounts from `index.html` through `src/main.tsx`, which renders `App` under a React Query provider.

The dashboard consumes two ACP ops endpoints: `GET /v1/ops/session-dashboard/snapshot` in `src/api/snapshot.ts`, with optional `fromSeq`, `scopeRef`, `laneRef`, and `hostSessionId` query parameters; and `GET /v1/ops/session-dashboard/events` in `src/api/stream.ts` and `src/hooks/useDetailEventBackfill.ts`, with NDJSON responses and query parameters including `fromSeq`, `follow`, `scopeRef`, `laneRef`, `hostSessionId`, `runId`, `family`, and detail `limit`. `vite.config.ts` proxies `/v1` to `http://127.0.0.1:18470`.

Important exported symbols inside the package are the API helpers `fetchSessionDashboardSnapshot`, `sessionDashboardSnapshotQueryOptions`, `useSessionDashboardSnapshot`, `openSessionDashboardStream`, and the stream/request types; the Zustand store helpers `useReducerStore`, `dispatchDashboardAction`, `getDashboardState`, and `createInitialDashboardReducerState`; the timeline primitives in `src/components/timeline/drawTimeline.ts` such as `computeTimelineLayout`, `timelineWindowForEvents`, `hitTest`, `drawTimeline`, `eventToX`, and `laneY`; selection helpers `sortRows`, `selectTimeline`, and `useTimelineSelection`; and UI components under `src/components/**`.

There are no package-specific CLI commands beyond the Bun scripts, and no server routes are implemented here.

## Internal Structure

`src/App.tsx` is the composition root. It reads the dashboard store, starts `useDashboardStream`, computes overview/detail timeline selection, backfills selected-row events when needed, wires canvas rendering and hit testing, and passes the resulting pieces into `DashboardShell`.

`src/api/snapshot.ts` contains the snapshot fetch/query hook, an empty snapshot factory, and development demo data generation. `src/api/stream.ts` opens the NDJSON event stream, deduplicates event ids, tracks the last processed HRC sequence, reports gaps, and reconnects after short delays. `src/store/useReducerStore.ts` owns the Zustand state and adapts `acp-ops-reducer` output into rows, events, summary, connection state, selection, gap state, and family filtering.

The hooks under `src/hooks/` split runtime behavior: `useDashboardStream` loads snapshots and streams events, `useDetailEventBackfill` fetches historical detail events for selected rows outside the live window, `useTimelineSelection` sorts rows and chooses overview/detail event windows, `useCanvasRenderer` redraws the canvas on animation frames and tracks timeline metadata, and `useCanvasHitTesting` maps pointer/keyboard input to events.

The UI components under `src/components/` are grouped by dashboard area. `DashboardShell` defines the page grid and static shell controls. `StatusStrip`, `SessionQueue`, `SessionCard`, `ReplayControls`, `TimelinePanel`, `TimelineCanvas`, `TimelineEventStream`, and `EventInspector` render the status metrics, session list, replay/filter footer, canvas/list timeline, and selected event details. `src/components/timeline/drawTimeline.ts` contains the canvas layout, drawing, hit target, and geometry logic.

Shared helpers live in `src/lib/`: colors and family tone mapping in `colors.ts`, event sorting/preview/card labeling in `events.ts`, scope/session key parsing in `sessionRefs.ts`, and simple time labels in `time.ts`. Styles are imported from `src/styles.css`, with tokens in `src/styles/tokens.css`, most layout/component rules in `src/styles/components.css`, and a currently empty `src/styles/layout.css` placeholder.

Config files are `vite.config.ts`, `playwright.config.ts`, `tsconfig.json`, `bunfig.toml`, and `index.html`. Tests live in `tests/session-dashboard.spec.ts` and `tests/bun/playwright-red.test.ts`.

## Dependencies

Production dependencies are `@tanstack/react-query` for snapshot fetching, `acp-ops-projection` for dashboard types, `acp-ops-reducer` for event reduction and NDJSON parsing, `pixi.js`, `react`, `react-dom`, and `zustand`. `pixi.js` is declared but no source file imports it.

Development and test dependencies are `@playwright/test`, `@types/bun`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `typescript`, and `vite`. The tests use Playwright directly and a Bun wrapper test that shells out to `bunx playwright test`.

## Test Coverage

There are 7 Playwright tests in `tests/session-dashboard.spec.ts`: default dashboard rendering and nonblank canvas, pause behavior, event inspector selection, in-flight branch/rejoin rendering, stale-context warning rendering, 320px viewport fallback, and reduced-motion behavior. `tests/bun/playwright-red.test.ts` adds 1 Bun test that invokes the Playwright suite and asserts it ran 7 tests successfully.

Coverage is strong for the visual red-test path but thin for non-visual logic. There are no focused unit tests for `openSessionDashboardStream` reconnect/gap/dedup behavior, `useReducerStore` snapshot/event/filter transitions, `useDetailEventBackfill` failure and dropped-line handling, `parseScopeRef` edge cases, or `sortRows`/`selectTimeline` ordering outside the single mocked dashboard shape.

## Recommended Refactors and Reductions

1. Remove or internalize unused exports in `src/lib/colors.ts` and `src/lib/sessionRefs.ts`. `familyToneClass` and `selectedRowRef` are exported but unused by `src` and `tests`; deleting them would reduce public-looking surface area.

2. Split `src/components/timeline/drawTimeline.ts` by responsibility. At 629 lines it mixes exported geometry used by tests (`computeTimelineLayout`, `eventToX`, `laneY`), canvas painting (`drawGrid`, `drawRow`, `drawBead`, `drawScopePill`), hit testing, branch semantics, and text utilities. A smaller `timelineLayout`/`timelinePaint` boundary would make canvas changes easier to test without rendering the whole dashboard.

3. Move the development fixture generation out of `src/api/snapshot.ts`. The fetch/query functions share a 234-line API module with `createDevelopmentDashboardSnapshot`, `demoSession`, and `demoEvents`; keeping demo data in a dev/test fixture module would keep the production API client focused and avoid coupling fallback UI data to endpoint code.

4. Consolidate event-stream fetching and NDJSON parsing between `src/api/stream.ts` and `src/hooks/useDetailEventBackfill.ts`. Both build `/v1/ops/session-dashboard/events` requests and parse NDJSON with `parseNdjsonChunk`, but only the live stream reports dropped lines and errors. A shared request/parser helper would reduce duplicated endpoint knowledge and make detail backfill behavior easier to test.

5. Either wire or remove inert controls. `DashboardShell` renders Auto-refresh, Replay, display, confirm, side-nav, alerts, and collapse controls; `ReplayControls` renders `fromSeq`, `window`, `speed`, and a hard-coded `Throughput 12.4 MB/s`; `TimelinePanel` renders Scale/Fit/zoom/expand; `EventInspector` renders close and static tabs; `SessionQueue` renders filter and View all buttons. These elements currently do not change state or dispatch actions, so they add UI surface without behavior.

6. Split `src/styles/components.css` and either populate or delete `src/styles/layout.css`. `components.css` is 1,293 lines and contains shell grid layout, header/nav, status metrics, queue rows, canvas panel, inspector, replay controls, high contrast, and responsive rules, while `layout.css` contains only a placeholder comment. Moving page layout/responsive rules into `layout.css` and keeping component rules grouped would reduce styling churn.

7. Reconcile the duplicate connection-state types in `src/api/stream.ts` and `src/components/controls/ReplayControls.tsx`. `StreamConnectionState` and `ConnectionState` contain the same string union, and `App.tsx` casts the store value to the component type. Reusing the stream type in the component would remove the cast and prevent drift.

8. Remove the unused `pixi.js` dependency from `package.json` unless a near-term canvas renderer migration is active. The current timeline is implemented with a plain 2D canvas in `TimelineCanvas` and `drawTimeline`, and no file imports Pixi.
