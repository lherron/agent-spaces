# acp-ops-projection Refactor Sweep

## Purpose

`acp-ops-projection` defines the shared operator dashboard projection contract for HRC lifecycle events. It turns normalized lifecycle events into redacted dashboard events, derives per-session timeline rows, and computes aggregate dashboard summary counts used by `acp-server`, `acp-ops-reducer`, and `acp-ops-web`.

## Public Surface

The package exports a single module from `src/index.ts` through `package.json` (`bun` consumers read `src/index.ts`; built ESM and declarations are emitted to `dist/`).

Exported types:

- `DashboardEventFamily`
- `DashboardEventSeverity`
- `SessionRef`
- `DashboardEvent`
- `SessionTimelineRow`
- `SessionDashboardSummary`
- `SessionDashboardSnapshot`
- `RedactionOptions`
- `HrcLifecycleEvent`

Exported values and functions:

- `defaultRedactionOptions`
- `projectHrcToDashboardEvent(event, opts?)`
- `deriveSessionRow(events, windowMs)`
- `redactPayload(payload, opts?)`
- `buildSummary(rows, events, windowMs)`

There are no HTTP routes or CLI commands in this package.

## Internal Structure

- `package.json` declares the workspace package, ESM exports, build/typecheck/test scripts, and dev-only dependencies.
- `tsconfig.json` builds only `src/**/*`, excludes tests and generated output, and emits composite TypeScript output to `dist/`.
- `src/index.ts` contains all production code: public dashboard DTO types, redaction defaults and recursive payload previewing, event family/severity classifiers, row derivation helpers, event-window rate calculations, and summary aggregation.
- `test/projection.red.test.ts` contains red-contract coverage for family mapping, severity mapping, stable event IDs, generation-aware row IDs, and redaction defaults/limits.
- `packages/acp-server/src/handlers/ops-dashboard-shared.ts` is a direct consumer that normalizes core HRC records before calling this package and duplicates one event comparator locally.

## Dependencies

Production dependencies: none.

Test/build dependencies:

- `@types/bun`
- `typescript`
- Bun's built-in `bun:test` runner

Workspace consumers include `acp-server`, `acp-ops-reducer`, and `acp-ops-web`.

## Test Coverage

Verified with `bun run --filter acp-ops-projection test`: 29 passing test cases across `test/projection.red.test.ts`, with 31 assertions. `bun run --filter acp-ops-projection typecheck` also passed.

Covered areas:

- Event family mapping for runtime, launch, agent message, tool, input, delivery, handoff, surface, context, warning, and rejection events.
- Payload `type` precedence over category.
- Stable `hrc:<hrcSeq>` event IDs.
- Severity mapping for payload error codes, warning event kinds, success endings, and ordinary events.
- `deriveSessionRow` row ID generation by `hostSessionId:generation`.
- Redaction defaults, credential-key redaction, string truncation, object depth caps, array caps, and explicit raw payload debug mode.

Gaps:

- `buildSummary` is not directly tested even though it owns count aggregation for busy, idle, launching, stale, dead, in-flight input, delivery-pending, and event-rate fields.
- `deriveSessionRow` is only tested for row ID behavior; runtime status derivation, visual priority, continuity, color role, delivery pending, transport filtering, and latest-field selection are untested in this package.
- Redaction does not have package-level tests for binary-like values, circular structures, zero/negative limits, raw provider key redaction, or the `ACP_DASHBOARD_RAW_PAYLOAD` environment override.

## Recommended Refactors and Reductions

1. Split the oversized `src/index.ts` module by responsibility. The file is 787 lines and currently mixes public DTOs (`DashboardEvent`, `SessionTimelineRow`, `SessionDashboardSnapshot`), classification helpers (`deriveFamily`, `deriveSeverity`), recursive redaction (`redactValue`, `redactPayload`), row projection (`deriveRuntimeStatus`, `deriveSessionRow`), and summary aggregation (`buildSummary`). A minimal split into `types.ts`, `redaction.ts`, `eventProjection.ts`, and `sessionRows.ts` would reduce scan cost without changing the package's top-level exports.

2. Make the top-level event-field contract explicit. `src/index.ts` reads top-level `errorCode` through `eventErrorCode` and top-level payload-preview fields such as `transport` in `deriveSessionRow`, while `HrcLifecycleEvent` only declares `payload?: unknown` plus core IDs. `packages/acp-server/src/handlers/ops-dashboard-shared.ts` works around this with `ProjectionInputEvent = ProjectionHrcLifecycleEvent & { errorCode?: string; transport?: string }`. Either add these supported fields to `HrcLifecycleEvent` or require `acp-server` to place them under `payload`; keeping the intersection type makes the public boundary unclear.

3. Remove the duplicated event comparator boundary. `src/index.ts` has an internal `compareEvents` with timestamp-then-`hrcSeq` ordering, and `packages/acp-server/src/handlers/ops-dashboard-shared.ts` maintains a separate `compareDashboardEvents` with the same behavior. Exporting a dashboard event comparator from this package, or moving sorting fully behind `deriveSessionRow`/reducer APIs, would reduce duplicated logic and avoid drift in timeline ordering.
