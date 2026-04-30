# gateway-ios implementation plan

## Source spec
`/Users/lherron/praesidium/hrc-ios/HRC_IOS_MVP.md` — read in full before implementing.

## What we're building
A new in-process Bun module `packages/gateway-ios` that:
- Exposes a TCP HTTP+WebSocket API for the SwiftUI iOS app on a configurable port.
- Internally consumes the HRC server (Unix socket) via `hrc-sdk` for event/message streams, status, sessions, literal input, interrupt.
- Projects HRC lifecycle events + durable hrcchat messages into mobile timeline frames; preserves canonical `eventKind` and `category` everywhere.
- Provides snapshot+live timeline (`WS /v1/timeline`), backwards history paging (`GET /v1/history`), session index (`GET /v1/sessions`, `POST /v1/sessions/refresh`), input (`POST /v1/input`), interrupt (`POST /v1/interrupt`), and diagnostics raw event stream (`WS /v1/diagnostics/events`).
- Hosted in the same process as the Discord gateway from `packages/acp-cli/src/server-runtime.ts`.

## Architecture decisions

### Hosting: same served runtime as ACP/Discord; HRC reached via hrc-sdk
The spec wording is "same process as HRC server and the Discord gateway", but in this repo `gateway-discord` is started from `packages/acp-cli/src/server-runtime.ts` and HRC is reached over its Unix socket. For MVP we follow the actual topology: mount `gateway-ios` in the same served runtime/supervisor as ACP and Discord (next to `startGatewayInProcess` in `acp-cli`), accessing HRC through `hrc-sdk` over the Unix socket. We do not push mobile DTOs, WebSocket framing, or projection routes into `hrc-server` — that would bloat the canonical HRC service with one client-specific presentation API.

Rejected: embedding routes directly into hrc-server. Revisit only if hrc-server is later embedded as a library.

### Wire transport: TCP HTTP + WS, separate Bun.serve
HRC's Unix socket is unreachable from a phone. The iOS gateway runs its own `Bun.serve({ port })` listener bound to a configurable host/port (default `127.0.0.1:18480`). Production deployments terminate TLS upstream (out of scope for this MVP wiring; same as acp-server).

### Replay-then-buffered streaming pattern (two cursors, two pumps)
Mirror `hrc-server/src/index.ts` `handleEvents` and `handleWatchMessages`. The timeline has **two durable sources** (lifecycle events + hrcchat messages), so open captures and drains both with separate high-waters `{ hrcSeq, messageSeq }`:
1. Start both async iterator pumps (hrc-sdk `watch()` for events, `watchMessages({follow})` for messages) **before** building the snapshot. Both buffers begin filling immediately.
2. Capture `replayHighWater = { hrcSeq, messageSeq }` from the most recent records pulled into the snapshot.
3. Build snapshot from durable storage at the captured high-water.
4. Send snapshot.
5. Drain each buffered source: deliver only items strictly newer than that source's high-water; dedupe by `hrcSeq` / `messageSeq`.
6. Continue forwarding live items as the iterators yield them.

There is no single total ordering between HRC events and hrcchat messages — frame identity and idempotent updates carry correctness, not delivery order. `frameSeq` on the wire is **gateway delivery order only**, not a source-truth cursor.

On WebSocket close (or client disconnect), the gateway must cancel both async iterators so they don't leak. Tested explicitly with a fake `HrcClient` that asserts iterators are closed after WS close.

### Backwards paging primitives (server-side change)
`HrcLifecycleEventRepo` and `MessageRepository` only support forward paging today. The spec asks the gateway to do progressive scrollback. We add server-side helpers rather than scanning client-side:
- `HrcLifecycleEventRepo.listBeforeHrcSeq(beforeHrcSeq, filters)` — SQL `WHERE hrc_seq < ? ORDER BY hrc_seq DESC LIMIT ?` for index efficiency. Repository returns the descending window; **gateway reverses to chronological** before feeding the reducer (the reducer always runs oldest-to-newest).
- `HrcMessageFilter.beforeSeq?: number` and `HrcMessageFilter.sessionRef?: string` — additive (existing filter has `afterSeq`, `limit`, `order`; the messages table already has a `session_ref` column).
- `MessageRepository.query` SQL filters `message_seq < ?` and `session_ref = ?` accordingly. `parseMessageFilter` validates the new fields.
- HRC server adds `beforeHrcSeq`/`limit` to `GET /v1/events` and accepts `beforeSeq`/`sessionRef` on `POST /v1/messages/query`.
- HRC SDK exposes them in `watch()` / `listMessages()`.
- For lifecycle history filtered by session: if `HrcLifecycleQueryFilters` cannot accept `sessionRef` directly, the gateway parses canonical `<scopeRef>/lane:<laneRef>` and passes `scopeRef` + lane filter through. Goal: long-lived stores must NOT leak unrelated events into per-session mobile history.

These changes are minimal and additive; no contract breakage.

### Projection: pure, fixture-testable, identity-strict
Reducer is a pure function `(prevState, hrcEventOrMessage) -> { state, frames }`. Frame identity rules (must be precise, not approximate):

- **Assistant message frame**: keyed by `runId + messageId + role`. Fallback when `messageId` is absent: `runId + role + "assistant_message"`. Multiple `turn.message` events for the same key append/merge blocks in `hrcSeq` order, update `lastHrcSeq`, and accumulate `sourceEvents`. Never create a second assistant frame for replayed delivery of the same `hrcSeq`. Never coalesce across runs or roles.
- **Tool frame**: keyed by `runId + toolUseId`. A `turn.tool_result` updates the existing `turn.tool_call` frame when present. If the result arrives first, create a placeholder tool_call frame and fill it when the call arrives.
- **`tool_batch` / `command_ledger`**: presentation-layer projections **over** the canonical tool frames. The source events still live on the per-tool frame; `tool_batch` references them.
- Every frame's `sourceEvents: [{ hrcSeq, eventKind }]` MUST preserve canonical HRC `eventKind` and `category`. UI may visually group tools, but DTO citations stay canonical.

Replay and live deliveries of the same event MUST mutate the same frame, never duplicate. Test harness loads fixture NDJSON dumps from real Claude Code and Codex CLI sessions and asserts deterministic frame output and idempotency under double-delivery.

### sessionRef in query/body, not path segments
Canonical sessionRef is `agent:cody:project:agent-spaces/lane:main` — contains `/`. All endpoints that take a sessionRef do so via query string or JSON body, never as a path segment. iOS app supplies canonical sessionRef; `displayRef` is UI-only.

### Frame DTOs: mobile UI types, not new HRC events
Frame kinds (`user_prompt`, `assistant_message`, `tool_call`, `tool_result`, `tool_batch`, `patch_summary`, `diff_summary`, `turn_status`, `session_status`, `input_ack`, `error`) and block kinds (`markdown`, `mono`, `tool_call`, `tool_result`, `command_ledger`, `patch_summary`, `diff_summary`, `status`, `raw_json`) live in `gateway-ios/src/contracts.ts`. Each frame includes `sourceEvents: [{ hrcSeq, eventKind }]` so the UI and diagnostics can correlate back to canonical HRC.

## Package layout

```
packages/gateway-ios/
  package.json
  tsconfig.json
  src/
    index.ts              # public exports (createGatewayIosModule + types)
    module.ts             # GatewayIosModule with start/stop lifecycle
    main.ts               # standalone dev binary (optional, for local testing)
    config.ts             # env var resolution
    contracts.ts          # mobile DTOs (Snapshot, Frame, Block, control msgs)
    routes.ts             # HTTP+WS route table
    health.ts             # GET /v1/health
    session-index.ts      # GET /v1/sessions, POST /v1/sessions/refresh
    timeline-ws.ts        # WS /v1/timeline (snapshot + live)
    timeline-history.ts   # GET /v1/history
    diagnostics-ws.ts     # WS /v1/diagnostics/events
    input.ts              # POST /v1/input, POST /v1/interrupt
    event-filter.ts       # is-this-event-for-this-session predicate
    event-reducer.ts      # pure: HRC event/message -> timeline state
    frame-projector.ts    # pure: timeline state -> render frames
    hrc-client.ts         # thin wrapper around HrcClient for our needs
    logger.ts
    tests/
      fixtures/
        claude-prompt-response.ndjson
        claude-tool-use.ndjson
        codex-prompt-response.ndjson
        codex-tool-use.ndjson
        interrupted-turn.ndjson
        stale-generation.ndjson
        input-rejected.ndjson
      reducer.test.ts
      frame-projector.test.ts
      session-index.test.ts
      timeline-ws.test.ts
      timeline-history.test.ts
      diagnostics-ws.test.ts
      input.test.ts
      health.test.ts
```

Module shape:
```ts
export type GatewayIosModuleOptions = {
  hrcSocketPath: string
  host?: string
  port?: number
  bearerToken?: string
  gatewayId?: string
}

export function createGatewayIosModule(options: GatewayIosModuleOptions): GatewayIosModule

type GatewayIosModule = {
  start(): Promise<{ host: string; port: number }>
  stop(): Promise<void>
}
```

## Phase plan and dependency graph

```
P0: branch + scaffold + frozen mobile DTO contracts (contracts.ts) + reducer input interface
  |
  +-- P1: server-side backwards paging primitives (hrc-store-sqlite + hrc-server + hrc-sdk)
  +-- P2: projection (event-reducer + frame-projector) + fixtures
  |     (P1 and P2 in parallel because P0 freezes the contracts both consume;
  |      P2's reducer input interface must accept later P1 store results without churn)
  |
  +-- P3: snapshot/live timeline WS         (depends on P1 + P2)
  +-- P4: history endpoint                  (depends on P1 + P2)
  +-- P5: health + session index + refresh  (depends only on P0)
  +-- P6: input + interrupt                 (depends only on P0)
       |  (diagnostics WS shares P3's replay/buffer plumbing — built in P3,
       |   exposed as a second route, not a forked implementation)
       v
  P7: in-process composition wired into acp-cli serve, feature-gated
      `--enable-ios-gateway` + env host/port/token, with shutdown coverage for ACP+Discord+iOS
  |
  +-- P8: end-to-end smoke against live Claude Code + Codex   (coordinator)
```

P0 must freeze: the mobile DTO contract surface (Snapshot, Frame, Block, control messages) and the reducer's input type. Once frozen, P1 and P2 run in parallel without churn. P3, P4, P5, P6 then run in parallel — each agent gets explicit "do not touch sibling files" non-goals. Diagnostics WS is built inside P3 (sharing the replay/buffer plumbing) and exposed as a second WS route.

## Wrkq tasks to create

| ID slot | Phase | Title | Owner pairs |
|---|---|---|---|
| W-P0 | P0 | Scaffold gateway-ios package + module skeleton + branch | curly + smokey (skeleton tests) |
| W-P1 | P1 | Add backwards paging to hrc-store-sqlite, hrc-server, hrc-sdk | larry + smokey |
| W-P2 | P2 | Implement event-reducer + frame-projector + fixtures | larry + smokey |
| W-P3 | P3 | Snapshot/live timeline WebSocket | curly + smokey |
| W-P4 | P4 | Progressive history endpoint | curly + smokey |
| W-P5 | P5 | Health + session index + refresh | larry + smokey |
| W-P6 | P6 | Input + interrupt | larry + smokey |
| W-P7 | P7 | In-process composition in acp-cli serve, feature-gated, shutdown coverage | curly |
| W-P8 | P8 | End-to-end smoke against live harnesses (Claude Code + Codex CLI) | coordinator |

Note: diagnostics WS is built inside P3 (timeline WS task) — it reuses P3's replay/buffer plumbing as a second WS route, not a separate package. Do not let it fork into a sibling implementation.

## Verification per phase

- **P0**: `bun run typecheck` and `bun test packages/gateway-ios` pass against the empty module.
- **P1**: store unit tests assert backwards-ordered results + limit; hrc-server route tests cover `beforeHrcSeq`/`beforeSeq`; SDK tests against in-memory hrc-server.
- **P2**: reducer tests against six fixture NDJSONs (claude prompt/response, claude tool, codex prompt/response, codex tool, interrupted, stale generation); idempotency test (apply same event twice → same frame, no duplication); coalescing test for assistant text and tool batches.
- **P3**: WS test opens the stream, asserts snapshot arrives before any live frame, asserts an event AND a message injected during snapshot construction are delivered after the snapshot via the buffered-drain path (use a fake HrcClient that lets the test control timing on both pumps independently). Asserts iterators are cancelled on WebSocket close (no leaks). Asserts the diagnostics WS route shares the same replay/buffer infra and produces raw events with full payloads.
- **P4**: GET test asserts oldest/newest cursors and `hasMoreBefore`, asserts frames returned newest-to-oldest are equivalent to forward replay reversed.
- **P5**: GET sessions returns counts/buckets matching synthesized HRC `/v1/status` fixture; refresh re-queries and updates.
- **P6**: input rejected for `mode=headless`; literal input call shape matches `DeliverLiteralBySelectorRequest`; interrupt routes to `/v1/interrupt` for runtime-bound and `/v1/app-sessions/interrupt` for app-managed.
- **P7**: `bun run packages/acp-cli/src/main.ts serve --enable-ios-gateway` boots all three (acp-server, discord, ios). `curl http://127.0.0.1:18480/v1/health` returns `{ ok: true, hrc.ok: true }`. Shutdown signal cleanly closes all three (acp-server, discord, ios) — no orphaned sockets, no leaked subscribers. Env vars: `ACP_IOS_GATEWAY_HOST`, `ACP_IOS_GATEWAY_PORT`, `ACP_IOS_GATEWAY_TOKEN`.
- **P8**: Coordinator opens an interactive Claude Code session, drives the gateway from a small wscat/Node script, validates snapshot+live+input+interrupt against a real HRC server. Then repeats against a Codex CLI interactive session. Both must show: snapshot arrives, live frames update existing items (no duplication), history paging returns older frames, input is acked and reflected in events, interrupt completes.

## Non-goals for MVP (write into each task body)

- No headless turn launch (`POST /v1/turns`) — phase two.
- No payload redaction.
- No Android, no React Native, no cross-platform.
- No path-segment sessionRef encoding.
- No renaming of HRC `eventKind` or `category` values.
- No iOS app code changes — that lives in `../hrc-ios` and is owned by the iOS prototype work; this plan is gateway only.

## Architecture review

Reviewed by cody@agent-spaces in DM #1212 (response to msg-afef9596-7ca6-4132-988a-51b87d347f26). Verdict: ship the architecture; required precision edits incorporated above.

Resolutions:
1. **Hosting**: confirmed — co-host in `acp-cli serve` next to Discord; HRC accessed via `hrc-sdk` over Unix socket. Wording changed throughout.
2. **Backwards paging**: confirmed — additive; SQL uses `ORDER BY hrc_seq DESC LIMIT ?` for index efficiency, gateway reverses to chronological before reducing. Lifecycle history must filter by sessionRef-derived scopeRef+lane to avoid leakage from long-lived stores.
3. **Replay/live race**: confirmed — explicit two-cursor contract `{hrcSeq, messageSeq}`, two pumps started before snapshot, dedupe per source, `frameSeq` is wire-only (gateway delivery order). Cancel both iterators on WS close.
4. **Coalescing**: confirmed — assistant frame keyed by `runId+messageId+role` (fallback `runId+role+assistant_message`); tool frame keyed by `runId+toolUseId`; tool_result updates existing tool_call (placeholder if result first); `tool_batch`/`command_ledger` are presentation projections, not canonical homes.
5. **Phase decomposition**: confirmed — P0 freezes contracts, P1+P2 parallel, P3-P6 parallel after P1+P2, diagnostics WS lives inside P3 (not a separate package), P7 feature-gated with shutdown coverage, P8 must be real smoke against Claude Code AND Codex CLI.

Open MVP-scope items with my decision (no architectural risk; punt to implementation):
- **Auth**: bind to 127.0.0.1 only by default; optional `ACP_IOS_GATEWAY_TOKEN` env var enforces a `Authorization: Bearer <token>` check on all routes. Remote access expected via SSH/Tailscale tunnel for MVP.
- **WebSocket framing**: JSON-per-message via `ws.send(JSON.stringify(...))`, control envelope `{ type, ... }` with discriminator union per `contracts.ts`.
- **Default port**: `127.0.0.1:18480` (next to taskboard 18450 / workboard 18460 / acp 18470).
