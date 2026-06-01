# Broker IPC Durability — ASP Implementation Plan

Scope: **agent-spaces only** (protocol + broker + client + drivers + pre-hrc harness).
HRC-side work (runtime selection, tmux manager, startup reconciliation, projection,
degraded dispatch, CLI surfacing) is OUT OF SCOPE — consumed via the verdaccio
dev-publish loop (`sync:asp`). Source: `broker-ipc-durability-implementation-proposal.md`.

Branch: `main` (shared worktree). No new branches.

## Grounded findings (verified against code)

- Events already carry `seq` (`harness-broker-protocol/events.ts:25`); `InvocationEventSequencer`
  exists (`harness-broker/events.ts:50-85`). Ledger persists what sequencer stamps — no new numbering.
- `BrokerMethodV2` already written but unexported (`commands.ts:23-30`); public alias is
  `BrokerMethod = BrokerMethodV1` (`:32`). Capability flags `attachReplay?`, `events.replay?/.ack?`,
  `control.attach?` already exist as optional fields.
- `createProtocolServer` already binds `Readable`/`Writable` (`protocol-server.ts:18-52`); a
  `net.Socket` is a Duplex → reuse framing/correlation as-is.
- `inputId` already flows end-to-end (`invocation-manager.ts:380-384`); idempotency is a dedup guard.
- `protocolVersion` is `'harness-broker/0.1'` (`broker.ts:104`, `runtime-state.ts:88`) → bump to `0.2`.
- Codex hook socket is a single global `/tmp/harness-broker/codex-hooks.sock`
  (`codex-cli-tmux/driver.ts:458`); claude already hashes per-invocation (`claude-code-tmux/driver.ts:594`).
- Existing pre-hrc harness: `packages/agent-spaces/src/testing/pre-hrc-broker-*.ts` +
  `scripts/pre-hrc-broker-matrix-e2e.ts` / `pre-hrc-broker-matrix-aspc-e2e.ts`. Already has a
  `pre-hrc-broker-event-ledger.ts`. New unix harness = a transport row ALONGSIDE stdio.

## Decisions (locked after cody review, msg #4687)

- **`broker.listInvocations` is OUT of this milestone.** Export `BrokerMethod` as the v2 set MINUS
  `broker.listInvocations`; leave the name reserved in a comment. (Cody: "define fully or remove" — removed.)
- **Protocol version is negotiated, not hard-bumped.** Broker supports `['harness-broker/0.1','harness-broker/0.2']`;
  `broker.hello` returns the highest mutually supported. Avoids blast-radius on stdio rows. Stdio rows verify green.
- **Terminal-surface type lives in `harness-broker-protocol`** (protocol-local `BrokerTerminalSurfaceReport`).
  `spaces-runtime-contracts` already imports broker-protocol, so the shared type moves DOWN into broker-protocol;
  runtime-contracts re-imports it. No circular import.
- **`control.driverAttachExistingSurface?: boolean` capability is defined in Phase A** (not D), default false.
- **Broker-survives-HRC-restart only.** Input dispositions + pending-permission state are IN-MEMORY in the broker
  (the broker process stays alive across HRC restart). Only the event ledger is on disk. Broker-death recovery is a
  non-goal. `eventHighWater` in runtime-state MIRRORS the controller's projected high-water (does not supersede
  any per-invocation `lastEventSeq`).

## Phases (wrkq children)

### Phase A — Protocol v2 contract + runtime-state union  [no behavior; integration gate]
Packages: `harness-broker-protocol`, `spaces-runtime-contracts`.
- `commands.ts:32` export `BrokerMethod` = v2 set EXCLUDING `broker.listInvocations`; add v2 req/resp to
  `BrokerCommand` union for: `broker.attach`, `invocation.eventsSince`, `invocation.ackEvents`,
  `invocation.snapshot`, `invocation.permission.respond`.
- `invocation.ts` add `InvocationSnapshot`, `BrokerAttach{Request,Response}`,
  `InvocationEventsSince{Request,Response}`, `InvocationAckEvents{Request,Response}`,
  `InvocationSnapshotRequest`, and **`InvocationPermissionRespond{Request,Response}` fully specified**:
  fields incl. `permissionRequestId`, `decision`, optional `controllerInstanceId`; response models
  idempotent-duplicate (returns original), conflict (different decision), expired, and unknown-id cases.
  Reuse existing `InvocationInputResponse`, `PermissionRequestParams`, `InvocationState`,
  `ContinuationUpdate`, `InvocationCapabilities`, `InvocationEventEnvelope`.
- NEW protocol-local `BrokerTerminalSurfaceReport` in broker-protocol; move shared type down from
  runtime-contracts and re-import there. `InvocationSnapshot.terminalSurface` uses the protocol-local type.
- `errors.ts:22` add ALL of: `EventReplayUnavailable`, `AttachRejected`/`ControllerFenced`,
  `DuplicateInputConflict`, `PermissionResponseConflict`, `PermissionResponseExpired`,
  `UnknownPermissionRequest` (sequential codes from -32013). No ad-hoc codes in later phases.
- `capabilities.ts:51` widen `transports` to include `'unix-jsonrpc-ndjson'`; type `BrokerTransportKind`;
  add `control.driverAttachExistingSurface?: boolean` (default false) to the capability shape.
- `schemas.ts:238-247` extend `brokerMethods` set + per-method validators (accumulate-issues pattern).
- Make `protocolVersion` negotiable: protocol constant gains a supported-versions list `['0.1','0.2']`.
- `spaces-runtime-contracts/runtime-state.ts:86-93` endpoint → union
  `{kind:'stdio-jsonrpc-ndjson'} | {kind:'unix-jsonrpc-ndjson'; socketPath; attachTokenRef}`; ADD:
  `control.mode` as an explicit union (`'broker-ipc' | 'direct-tmux-degraded' | 'stdio-legacy'`),
  `control.brokerAttached`, `control.lastAttachError`; broker tmux pane/window metadata AND tui pane/window
  metadata (both panes, per proposal State model); `eventHighWater`. Update `compile-fixtures.ts:151`.
- Verify: schema accept/reject per v2 method; fixtures compile; `bun run build` green both packages.

### Phase B — Transport split + Unix socket server/client  [real bytes; no durability]
Packages: `harness-broker-client`, `harness-broker`.
- New `harness-broker-client/transport.ts`: `BrokerJsonRpcTransport` interface + move handler types.
- `stdio-transport.ts:34` `implements BrokerJsonRpcTransport` (no body change).
- New `harness-broker-client/unix-socket-transport.ts`: `UnixSocketTransport` over `net.connect`;
  `close()` destroys ONLY the socket, never a process.
- `client.ts:51,76` retype `#transport` to interface; add `static connectUnix`, `static fromTransport`;
  keep `start()`. Add v2 methods `attach/eventsSince/ackEvents/snapshot`. Dedup `(invocationId, seq)`.
- `harness-broker/cli.ts:20-29` accept `--transport unix` + flags (`--socket --runtime-id
  --host-session-id --generation --attach-token-file --event-ledger --log-file`); add `runUnix()`.
- `protocol-server.ts` bind a `net.Socket`; `runUnix` adds `net.createServer`: `0700` dir, unlink on exit.
- `broker.ts:99-112` advertise both transports + `attachReplay: true`.
- **Hazards (cody):** (a) enforce a Unix socket path budget — fail early with a clear error if `socketPath`
  exceeds the platform `sockaddr_un` limit (macOS is tight). (b) Stale-socket unlink must be conservative:
  connect/probe FIRST; if a live listener answers, do not unlink; on `EADDRINUSE` after the stale check, retry
  the probe rather than blind-unlinking; only unlink a socket node with no live listener. (c) Before C fencing
  exists, limit to ONE controller connection (or ensure unauthenticated extra sockets receive no
  notifications/permission requests).
- Verify: spawn `harness-broker run --transport unix`, `connectUnix`, full invocation;
  assert `close()` leaves broker process alive; oversized-path errors early.

### Phase C1 — Broker durability: ledger / attach / replay / fencing / input-idempotency
Package: `harness-broker` (mostly `invocation-manager.ts` + new modules).
- New `event-ledger.ts` (JSONL, append-only, fsync at lifecycle boundaries): `append` idempotent
  by `(invocationId, seq)` — duplicate `(invocationId, seq)` with DIFFERENT payload is corruption/conflict,
  NOT success. `eventsSince(afterSeq)`, `ackEvents(throughSeq)` monotonic + accepted only from the active
  fenced controller. Retention floor PER invocation; do NOT prune active invocations. Wire into `emit`/`onEvent`
  so events persist before/with notification.
- `InvocationSnapshot` assembly from live state (pendingInputIds, inputDispositions [in-memory],
  terminal surface, currentSeq/retentionFloorSeq). (Pending-permission fields filled by C2.)
- `broker.attach` handler: validate identity + attach token; latest-valid-attach-wins fencing
  (old controller gets terminal control error + close); return snapshot + seq bounds.
- `eventsSince`/`ackEvents` handlers from ledger; `EventReplayUnavailable` when afterSeq < floor.
- Explicit replay/live ordering: attach → snapshot/currentSeq → replay `> afterSeq` → live notifications;
  client de-dupes `(invocationId, seq)`; no gap while replay is in flight.
- `inputId` idempotency (`:380-384` + queue): in-memory disposition per inputId; dup+identical → original
  response; dup+different content/policy → `DuplicateInputConflict`; dispositions in snapshot.
- Verify: replay (non-empty/empty/floor-fail)+ack monotonic+fenced; dup input same/conflict; attach
  success/failure for matching vs mismatched runtime/generation/token; fencing closes old controller.

### Phase C2 — Broker durability: permission reconnect
Package: `harness-broker`. Depends on C1.
- Decouple driver permission waiting from the JSON-RPC request promise: the pending permission is
  broker-owned, in-memory, retained until absolute `deadlineAt`.
- Emit `permission.requested` audit event BEFORE sending the broker-to-client request.
- On controller disconnect with an outstanding request, keep it pending until `deadlineAt`; on expiry apply
  `defaultDecision` + emit `permission.resolved {decidedBy:'timeout'}`.
- Snapshot carries pending requests WITH absolute `deadlineAt` (so HRC can render remaining time).
- `invocation.permission.respond` idempotent by `permissionRequestId`: original decision returned on dup;
  `PermissionResponseConflict` on different decision; `PermissionResponseExpired` / `UnknownPermissionRequest`.
- Verify: pending permission survives controller socket close, appears in fresh connectUnix+attach snapshot
  with deadline, times out to defaultDecision, respond is idempotent/conflict/expired.

### Phase D — Driver / hook-socket runtime scoping
Package: `harness-broker/src/drivers`.
- Thread runtime-scoped IPC dir (from `--socket` parent → `hooks/`) through `DriverContext`, **keeping a
  `tmpdir()` default** for stdio / pre-existing tests so non-durable rows don't break.
- `codex-cli-tmux/driver.ts:458` make codex hook socket per-invocation (hash like claude `:594`).
  Use SHORT basenames under `hooks/` — relocation can lengthen derived `.settings.json`/wrapper paths;
  respect the same socket path budget as B.
- Stamp runtime/generation/invocation identity into hook envelopes; reject mismatched identity STRICTLY only
  when identity is provided by durable unix mode — legacy/stdio rows without generation must NOT fail on an
  absent field.
- Surface terminal-surface identity in snapshot (the protocol-local type from A).
- (`control.driverAttachExistingSurface` capability already defined in A — wire driver advertisement here.)
- Verify: codex+claude hook sockets unique per runtime/invocation; mismatched-identity envelope rejected;
  existing claude/codex tmux driver tests still green.

### Phase E — Pre-HRC unix-socket e2e harness  [capstone; alongside stdio harnesses]
Package: `packages/agent-spaces/src/testing` + `scripts`.
- Add a `unix-jsonrpc-ndjson` transport ROW to the pre-hrc broker matrix, alongside existing stdio rows.
- Driver-certification parity for the SHARED command-turn scenario + normalized event contract: every shared
  scenario runs against every row; a missing SHARED event on the unix row is a GAP, not an exemption.
- Unix-specific durability scenarios run ONLY on unix rows (do NOT force stdio rows to grow attach semantics):
  attach/replay after a simulated controller disconnect (reconnect via fresh `connectUnix`), inputId
  idempotency on retry, pending-permission survives reconnect, broker survives `transport.close()`.
- Wire into `scripts/pre-hrc-broker-matrix-e2e.ts` (and `-aspc-e2e.ts` if applicable).
- Verify: matrix run FULL GREEN, no skips; unix row exercises attach/replay/idempotency/permission.

## Non-goals (deferred / HRC-owned)
- Driver attach-to-existing-TUI after broker death (capability stays false).
- Broker-death recovery (only HRC-restart-while-broker-survives is in scope).
- `broker.listInvocations` (deferred from this milestone).
- Headless broker runtimes stay stdio-child.
- All HRC reconciliation/tmux/projection/CLI work.

## Dependency graph
A → B → C1 → C2 → D → E.  A is the integration gate (pure contract). B/C1/C2/D/E testable via loopback
(broker + client in one process), no HRC needed. Sequential on the shared worktree.
After any phase touching `harness-broker-protocol` or `spaces-runtime-contracts`, the dev set
publishes so HRC `sync:asp` picks it up — never pin semver.

## Current status for continuation
- 2026-06-01: plan authored; cody APPROVED-WITH-CHANGES (#4687); changes incorporated (C split into C1/C2,
  Phase A contract completed, B/D guardrails added). wrkq: T-01790 parent; A=T-01791 B=T-01792 C1=T-01793
  C2=T-01796 D=T-01794 E=T-01795. Dispatching Phase A.
