# Harness Broker — Implementation Plan

Companion to `harness-broker-spec.md` (spec/0.1-draft).

This plan lands spec §17 Phases 0–4 without a big-bang HRC cutover. The broker lives in Agent Spaces, consumes already-compiled invocation specs, owns only in-memory process/driver state, and exposes provider-neutral JSON-RPC/NDJSON commands plus normalized broker events. The spec is canonical. Where the proposal HTML series (`docs/harness-broker-proposal/`) diverges in scope, the spec wins; the proposal contributes migration sequencing only.

Authored jointly by `clod` and `cody`.

---

## Status — Phases 0–4 SHIPPED ✅

**Merged to `main`:** 2026-05-20 (merge commit `484d574`). Branch `feat-harness-broker` deleted.

**E2E validated against codex-cli 0.130.0:** message-only smoke + tool-execution smoke (`pwd` + `ls`) both produce full turn lifecycle with real model output, real thread UUIDs, real token usage. Runbook at `runbooks/e2e-harness-codex-app-server.md`.

**Test totals:** 67+ unit/golden tests across the three new packages; 0 fail; 1 todo (Phase 3 ask-client perm scenario deferred to a future client capability addition).

### Phase delivery table

| Phase | wrkq tasks | Final commit(s) | Tests | State |
|---|---|---|---|---|
| 0 — Protocol package | T-01541 (smokey) / T-01540 (larry) | `98a59db` | 16 pass | ✅ closed |
| 1 — Broker skeleton | T-01542 (smokey) / T-01543 (curly) | `27739bc` | 14 pass | ✅ closed |
| 2 — Codex driver | T-01544 (smokey) / T-01545 (larry) | `ef26e92`, `e65642b` (lint fix) | 28 pass / 1 todo | ✅ closed |
| 3 — Control + policies | T-01546 (smokey) / T-01547 (curly, 2 turns) | `e084e5d` | 45 pass / 1 todo | ✅ closed |
| 4 — Reference client | T-01548 (smokey) / T-01549 (larry) | `a646b80` | 6 pass | ✅ closed |
| Defect cleanup | T-01552 (smokey) / T-01553 (larry) | `ae923d5`, `e7f2b14` | net 47 pass / 1 todo | ✅ closed (T-01550, T-01551 also closed) |

### Known follow-up defects

All filed broker defects from initial validation are closed.

Past defects (now closed):
- T-01550 — `sandboxMode` string rejected by real codex; driver now translates spec string into codex's internally-tagged enum.
- T-01551 — `run-once` exited at `input.accepted`; now awaits `turn.completed`/`failed`/`interrupted`.
- T-01554 — `tool.call.*` payloads omitted `input`/`result` against real codex (fake fixture was pre-shaped); driver now projects per-item-type from real codex shapes. `tool.call.delta` absence for short commands and `durationMs:0` confirmed as codex 0.130.0 behavior, not broker bugs.

### What remains on the roadmap (post-merge)

- **HRC integration** (impl plan §5) — separate work item in `hrc-runtime`. Estimated 5–7d, owned by HRC maintainer. `hrc-server/src/launch/exec.ts` continues to handle all current traffic; broker remains dormant until an opt-in gate is wired in HRC.
- **Phase 3 ask-client permission flow** — currently `todo` test. Requires a client capable of advertising `permissionRequests:true` and handling broker→client requests; reference client supports it but no real consumer exercises it yet.

---

## 1. Package layout

Three new packages under `agent-spaces/packages/`, named with the existing `spaces-` prefix convention. Each follows the repo's existing publishable-package shape (TS source under `src/`, `prepack` strips `bun` exports, `postpack` restores `package.json`).

```
agent-spaces/packages/
  harness-broker-protocol/        # package name: spaces-harness-broker-protocol
    package.json
    tsconfig.json
    src/
      index.ts                    # barrel
      invocation.ts               # HarnessInvocationSpec + driver specs
      commands.ts                 # JSON-RPC request/response types
      events.ts                   # InvocationEventEnvelope + payload types
      capabilities.ts             # InvocationCapabilities, BrokerCapabilities, DriverSummary
      errors.ts                   # BrokerErrorCode enum + helpers
      jsonrpc.ts                  # JSON-RPC 2.0 frame types
      ndjson.ts                   # NDJSON encode/decode primitives
      schemas.ts                  # runtime validators
      fixtures/codex-app-server/  # spec + golden fixtures
    test/
      schemas.test.ts
      jsonrpc.test.ts
      ndjson.test.ts

  harness-broker/                 # package name: spaces-harness-broker
    package.json
    tsconfig.json
    bin/
      harness-broker.js           # CLI entry (#!/usr/bin/env bun)
    src/
      index.ts
      cli.ts                      # run | validate-spec | drivers | run-once
      broker.ts                   # top-level process wiring
      protocol-server.ts          # request dispatch + notification emission
      invocation-manager.ts       # single-invocation state machine (v0)
      events.ts                   # event sequencer + envelope assembly
      errors.ts                   # BrokerError class + JSON-RPC mapping
      security/
        redaction.ts              # env/secret scrubbing for events
        path-policy.ts            # cwd existence, no shell expansion
      runtime/
        process-runner.ts         # spawn + signal forward
        env.ts                    # explicit env construction
        signals.ts                # policy-driven signal forwarding
      drivers/
        driver.ts                 # Driver interface + DriverContext
        registry.ts               # driver kind → factory
        noop-driver.ts            # test-only; not registered in production builds
        codex-app-server/
          driver.ts               # implements Driver
          rpc-client.ts           # copied from harness-codex (see §6)
          event-map.ts            # Codex notification → broker event
          input.ts                # user input → turn/start mapping
          permissions.ts          # permissionPolicy (Phase 3)
      testing/
        fake-codex-app-server.ts  # scriptable fake harness
        stdio-harness.ts          # in-process broker test driver
    test/
      protocol-server.test.ts
      broker-lifecycle.test.ts
      events.test.ts
      drivers/codex-app-server/*.test.ts
      cli.test.ts
    testdata/
      codex-app-server/*.golden.jsonl

  harness-broker-client/          # package name: spaces-harness-broker-client (Phase 4)
    package.json
    src/
      index.ts
      client.ts                   # typed command methods + async event iter
      stdio-transport.ts          # spawn broker, wire stdin/stdout
      event-iterator.ts           # backpressure-safe event buffer
      errors.ts
    test/
      integration.test.ts         # spawns real broker against fake codex
```

### Dependency direction (enforced via `scripts/check-boundaries.ts`)

| Package | May depend on | Must NOT depend on |
|---|---|---|
| `spaces-harness-broker-protocol` | TypeScript stdlib; validation lib only if already accepted by repo (otherwise hand-rolled) | `spaces-config`, `spaces-runtime`, driver packages, HRC, ACP, ASP compiler |
| `spaces-harness-broker` | `spaces-harness-broker-protocol`, node stdlib | HRC packages, ACP, `agent-spaces` umbrella, `spaces-execution` display helpers, ASP placement/materializer APIs, **any direct import of `spaces-harness-codex`** (RPC client is copied; see §6) |
| `spaces-harness-broker-client` | `spaces-harness-broker-protocol`, node stdlib | All other workspace packages |

### Repo plumbing changes per new package

When each package lands, update:

- Root `package.json` `build:ordered` and `test` script ordering: protocol → broker → broker-client, before `agent-spaces`/CLI consumers.
- `scripts/check-boundaries.ts`: add the new package roots and forbidden-import rules above.
- `scripts/check-manifest-edges.ts`: no custom change expected if manifests are correct.
- Each new package's `package.json` mirrors `spaces-harness-codex`'s `prepack: bun ../../scripts/strip-bun-exports.ts` and `postpack: git checkout HEAD -- package.json`.

---

## 2. Phase-by-phase work breakdown

### Phase 0 — Protocol package (~2 days)

Establish the compatibility contract before any process execution exists.

**Files to create** (under `packages/harness-broker-protocol/`):

- `package.json` (name `spaces-harness-broker-protocol`, `type: module`, prepack/postpack), `tsconfig.json` (strict, `noUncheckedIndexedAccess`).
- `src/index.ts` — barrel; exports only protocol surfaces.
- `src/invocation.ts` — `HarnessInvocationSpec`, `HarnessDescriptor`, `HarnessProcessSpec`, `HarnessTransportSpec`, `InteractionSpec`, `ContinuationSpec`, `ProcessLimits`, `CodexAppServerDriverSpec`, `PermissionPolicy`, `UnknownDriverSpec`. Optional properties as `prop?: T | undefined` per repo style.
- `src/commands.ts` — JSON-RPC request/response types for `broker.hello`, `broker.health`, `invocation.start`, `invocation.input`, `invocation.interrupt`, `invocation.stop`, `invocation.status`, `invocation.dispose`, optional broker→client `invocation.permission.request`.
- `src/events.ts` — `InvocationEventEnvelope<T>`, `InvocationEventType` union (all 24 types from spec §9.2), all payload shapes from §9.4.
- `src/capabilities.ts` — `InvocationCapabilities`, `BrokerCapabilities`, `DriverSummary`, `ClientCapabilities`.
- `src/errors.ts` — `BrokerErrorCode` numeric enum exactly per spec §12; JSON-RPC error envelope helper.
- `src/jsonrpc.ts` — `JsonRpcRequest`/`JsonRpcResponse`/`JsonRpcNotification` types and discrimination helpers.
- `src/ndjson.ts` — line-buffered frame reader; line-terminated frame writer; robust to partial buffers; recovers after malformed frame.
- `src/schemas.ts` — runtime validators for `HarnessInvocationSpec`, command params, event envelope. Use `zod` if already an accepted dep; otherwise hand-rolled structural validation. Export `validateInvocationSpec(unknown): HarnessInvocationSpec` and `validateCommand(unknown): BrokerCommand`.
- `src/fixtures/codex-app-server/start-fresh.spec.json`, `resume.spec.json`, `basic-events.golden.jsonl`.

**Tests:**

- `test/schemas.test.ts` — spec §6.2 and §19 examples validate; missing `process.command` / invalid driver kind / invalid env keys / unsupported protocol version fail with stable codes.
- `test/jsonrpc.test.ts` — parses requests/responses/notifications; rejects malformed shapes; supports interleaved responses + events.
- `test/ndjson.test.ts` — partial frames, multiple frames per chunk, malformed line yields recoverable error and subsequent frames still decode.

**Exit criteria:**

- `bun run --filter spaces-harness-broker-protocol typecheck && bun run --filter spaces-harness-broker-protocol test` passes.
- `bun run check:boundaries` and `bun run check:manifests` pass.
- Zero workspace-internal imports.

### Phase 1 — Broker process skeleton (~3 days)

A runnable broker that speaks the protocol but has only noop/test-flag invocation behavior.

**Files to create** (under `packages/harness-broker/`):

- `package.json`, `tsconfig.json`.
- `bin/harness-broker.js` — shebang to bun; delegates to `src/cli.ts`.
- `src/cli.ts` — parses `run --transport stdio`. Implement `validate-spec` and `drivers --json` only if cheap; otherwise defer until after the core loop is stable.
- `src/protocol-server.ts` — NDJSON read on stdin, NDJSON write on stdout (stdout protocol-only; stderr diagnostics-only). Routes JSON-RPC requests, emits notifications, sends JSON-RPC errors for malformed/unknown methods.
- `src/broker.ts` — composes protocol-server + invocation-manager + driver registry; wires `broker.hello` and `broker.health` handlers.
- `src/invocation-manager.ts` — v0: zero-or-one invocation. State machine matches spec §11.1 exactly: `starting`, `ready`, `turn_active`, `stopping`, `exited`, `failed`, `disposed`. Rejects second `invocation.start` with `InvalidInvocationState`.
- `src/events.ts` — monotonic `seq` allocation starting at 1, deterministic `time` formatter, envelope assembly.
- `src/errors.ts` — `BrokerError extends Error` with `code: BrokerErrorCode`, `data?: unknown`; `toJsonRpcError(err)` helper.
- `src/security/redaction.ts` — stub for Phase 3.
- `src/drivers/driver.ts` — interface (see Phase 2).
- `src/drivers/registry.ts` — `register('codex-app-server', factory)`; reports `available: false` if no implementation.
- `src/drivers/noop-driver.ts` — test-only driver for lifecycle exercises; not registered in production builds.
- `src/testing/stdio-harness.ts` — in-process pair of streams to drive the broker without spawning.

**Tests:**

- `test/protocol-server.test.ts` — request/response routing; unknown method → -32601; malformed frame recovery; stdout contains only JSON-RPC frames.
- `test/broker-lifecycle.test.ts` — `hello`/`health`/`status`/`dispose`; one-invocation broker rejects second active invocation; exactly one terminal event per invocation.
- `test/events.test.ts` — monotonic seq, envelope includes `invocationId`, optional `correlation` echoed verbatim and never interpreted.
- `test/cli.test.ts` — spawn `bun packages/harness-broker/bin/harness-broker.js run --transport stdio`, send `broker.hello`, assert JSON-RPC response.

**Exit criteria:**

- Broker process can be started by a parent and commanded over stdio.
- Rejects invalid specs and unsupported drivers without spawning children.
- No HRC concepts (callback, spool, launchId, runtimeId, generation) appear in Phase 1 source.
- `drivers --json` (if implemented) reports `codex-app-server` as `available: false, unavailableReason: 'not implemented'`.

### Phase 2 — Codex app-server driver (~5 days)

Drive a real or fake Codex app-server from an exact compiled spec and emit broker-normalized events.

**Files to create:**

- `src/drivers/codex-app-server/driver.ts` — implements `Driver` interface.
- `src/drivers/codex-app-server/rpc-client.ts` — copied + adapted from `packages/harness-codex/src/codex-session/rpc-client.ts` (see §6 reuse decision). Pending request map, request-handler support for permission prompts, close semantics that reject pending requests, stderr as diagnostics.
- `src/drivers/codex-app-server/event-map.ts` — pure functions mapping each Codex notification to a normalized broker event per spec §10.4. Single switch on `method`/`params.item.type`.
- `src/drivers/codex-app-server/input.ts` — map `InvocationInput(kind:'user', content:[...])` (text + `local_image`) to Codex `turn/start` parameters.
- `src/drivers/codex-app-server/permissions.ts` — Phase 3 hook point; v0 wires `deny` only.
- `src/runtime/process-runner.ts` — validate cwd is an existing directory; spawn exact command/args with `shell: false`; explicit env from spec + conservative inherited-env policy.
- `src/runtime/env.ts` — explicit env construction; no shell expansion; reject obviously invalid env keys.
- `src/runtime/signals.ts` — policy-driven signal forwarding to child; emit `diagnostic` events on forward.
- `src/testing/fake-codex-app-server.ts` — scriptable fake (see Test Strategy §3).
- `src/cli.ts` — extend `run-once --spec invocation.json --input input.json` as a thin dev wrapper over the same broker protocol + Codex driver path. **No alternate execution path permitted.**

**Driver interface:**

```ts
export interface Driver {
  readonly kind: string
  readonly version: string
  capabilities(): InvocationCapabilities
  start(spec: HarnessInvocationSpec, ctx: DriverContext): Promise<DriverStartResult>
  input(req: InvocationInputRequest): Promise<InvocationInputResponse>
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  dispose(): Promise<void>
}

export interface DriverContext {
  invocationId: string
  emit(env: InvocationEventEnvelope): void
}
```

**Startup sequence (spec §10.2):**

1. Spawn `codex ... app-server` per `spec.process`.
2. Send `initialize`, await response.
3. Send `initialized`.
4. Send `thread/start` (or `thread/resume` if `driver.resumeThreadId` present).
5. Emit `invocation.started` (with `pid`, `command`, `args`, `cwd`; **never `env`**).
6. Emit `continuation.updated` with `provider:'codex'`, `kind:'thread'`, `key:<threadId>`.
7. Emit `invocation.ready`.

**Resume fallback (spec §10.5):**

- `start-fresh`: emit `driver.notice`, retry `thread/start`, update continuation.
- `fail`: emit `invocation.failed` and reject `invocation.start`.

**Codex → broker event map (spec §10.4):** implement the full table verbatim in `event-map.ts`. In particular:

- `error` notification → `diagnostic` + terminal `turn.failed` or `invocation.failed` depending on active state.
- Child stderr line → `diagnostic` with `source:'harness'` unless suppressed.
- Child exit → exactly one `invocation.exited`.

**Input v0 (Codex app-server):**

- Only `kind: 'user'` accepted. Text and `local_image` content map to Codex turn input.
- `steer`, `append_context`, concurrent input, and busy-state input all rejected with `UnsupportedCapability` or `InputRejected` per spec §7.4 / §11.2.

**Stop/dispose:**

- `stop`: graceful child termination (SIGTERM → SIGKILL after `graceMs`).
- `dispose`: free in-memory invocation state after terminal.
- `interrupt({scope:'turn'})`: returns `effect: 'unsupported'` unless a Codex protocol cancel method is verified (open question §18.2).

**Tests** (spec §16.3 scenarios 1–12):

1. Start fresh thread and complete a turn.
2. Resume existing thread and complete a turn.
3. Resume missing thread with `start-fresh` fallback.
4. Resume missing thread with `fail`.
5. Assistant message deltas and final message.
6. All five tool-like item types: `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, `imageView`.
7. Token usage update.
8. (Phase 3) Permission request with each policy mode.
9. App-server emits `error` during startup.
10. App-server exits during active turn.
11. Stop active invocation.
12. Unsupported `steer`/`append`/`interrupt` rejection.

Plus:

- Spawn receives exact argv, no shell.
- cwd-missing failure is clean (`SpawnFailed` per spec §12).
- Env redaction: env values never appear in any emitted event JSON.

**Exit criteria:**

- All scenarios 1–7, 9–12 pass against fakes. (8 deferred to Phase 3.)
- Golden traces stable; diff requires explicit `UPDATE_GOLDEN=1` to refresh.
- Phase 2 contains no HRC callback / runId / tmuxId / generation / spool concepts.

### Phase 3 — Control and policies (~2 days)

Production-grade timeout, permission, and rejection semantics.

**Work:**

- `src/invocation/timeouts.ts` — applies `process.limits.startupTimeoutMs`, `turnTimeoutMs`, `stopGraceMs`, `maxEventBytes`. Timeout → `BrokerErrorCode.Timeout` + appropriate terminal event (`invocation.failed` or `turn.failed`).
- `src/drivers/codex-app-server/permissions.ts` — full `PermissionPolicy`:
  - `deny`: immediate denial.
  - `allow`: immediate approval.
  - `ask-client`: if negotiated in `broker.hello`, send broker→client `invocation.permission.request`, honor `timeoutMs` + `defaultDecision`; if negotiation absent or timeout, fall back per spec §10.6.
- `src/security/redaction.ts` — scrubs:
  - All env values from `invocation.started` and any other event payload (echo only argv/cwd/pid).
  - `Authorization:` / `*-Token:` / `Bearer ...` patterns in diagnostic payloads.
  - Attachment binary content (paths only).
- `src/invocation/input-policy.ts` — applies `InputPolicy.whenBusy` for unsupported `steer`/`append_context` per spec §11.2.
- Capability reporting refined to accurately advertise `input.user`, `localImages`, `stop`, `dispose`, permission negotiation, and unsupported steer/interrupt.

**Tests:**

- Timeout tests: delayed initialize, delayed turn, non-exiting child after stop.
- Permission tests: deny / allow / ask-client(decision) / ask-client(timeout→default) / ask-client without negotiation → default-deny + diagnostic.
- Redaction tests: env values, `Authorization` headers, `Bearer` tokens, and attachment paths all redacted in event stream.
- Capability tests: unsupported controls reject with `BrokerErrorCode.UnsupportedCapability`.

**Exit criteria:**

- No environment values appear in any normalized event under any scenario (asserted by test).
- All timeout paths emit exactly one terminal event.
- Capability matrix matches spec §8 Codex app-server v0 block verbatim.

### Phase 4 — Reference client (~2 days)

A typed client library so consumers (HRC, tests, future integrations) don't reinvent transport plumbing.

**Files** (under `packages/harness-broker-client/`):

- `src/stdio-transport.ts` — spawn `harness-broker run --transport stdio` as child; wire stdin/stdout; parse JSON-RPC frames.
- `src/client.ts`:
  ```ts
  export class BrokerClient {
    static async start(opts: { command: string; args?: string[]; cwd?: string; env?: Record<string,string> }): Promise<BrokerClient>
    hello(req: BrokerHelloRequest): Promise<BrokerHelloResponse>
    health(req?: BrokerHealthRequest): Promise<BrokerHealthResponse>
    startInvocation(spec: HarnessInvocationSpec, initialInput?: InvocationInput): Promise<{ invocationId: string; events: AsyncIterable<InvocationEventEnvelope> }>
    input(req: InvocationInputRequest): Promise<InvocationInputResponse>
    interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
    stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
    status(req: InvocationStatusRequest): Promise<InvocationStatusResponse>
    dispose(req: InvocationDisposeRequest): Promise<void>
    onPermissionRequest(handler: (req: PermissionRequestParams) => Promise<PermissionDecision>): void
    close(): Promise<void>
  }
  ```
- `src/event-iterator.ts` — backpressure-safe event buffer over notifications.
- `src/errors.ts` — surfaces broker error codes + transport errors.

**Tests:**

- `test/integration.test.ts` — spawn real broker child against fake codex; run hello → startInvocation → input → assistant deltas → turn.completed → stop → dispose.
- Interleaved responses + events route correctly.
- Process exit rejects pending requests.

**Exit criteria:**

- HRC can depend on `spaces-harness-broker-client` + `spaces-harness-broker-protocol` without importing `spaces-harness-codex/codex-session`.
- Client package never imports `spaces-harness-broker` internals.

---

## 3. Test strategy

### Levels

| Level | Lives in | Purpose |
|---|---|---|
| Type / schema | `harness-broker-protocol/test` | spec compliance at type + runtime-validation level |
| Protocol / transport | `harness-broker/test/protocol-server.test.ts` | NDJSON, JSON-RPC framing, malformed-frame recovery |
| Lifecycle | `harness-broker/test/broker-lifecycle.test.ts` | broker.hello, status, dispose, single-invocation enforcement, terminal-event uniqueness |
| Driver (fake-harness) | `harness-broker/test/drivers/codex-app-server/*.test.ts` | spec §16.3 scenarios using fake app-server |
| Golden | `harness-broker/testdata/codex-app-server/*.golden.jsonl` | event sequences locked; diff-on-change with `UPDATE_GOLDEN=1` |
| Integration | `harness-broker-client/test/integration.test.ts` | real broker process, real fake-codex child |

### Fake-harness pattern

A fake Codex app-server is a Bun script that reads NDJSON requests from stdin and writes scripted responses/notifications to stdout. Each scenario ~30 lines.

```ts
// src/testing/fake-codex-app-server.ts (helper)
export function framed(stdin = process.stdin, stdout = process.stdout) {
  // line-buffered NDJSON reader/writer
}

// example scenario script
import { framed, expect } from '../testing/fake-codex-app-server.ts'
const io = framed()
expect(await io.read(), { method: 'initialize' })
io.respond({ ok: true })
expect(await io.read(), { method: 'initialized' })
expect(await io.read(), { method: 'thread/start' })
io.respond({ threadId: 'thread_abc' })
const turn = await io.read()
expect(turn, { method: 'turn/start' })
io.notify('turn/started', { turnId: 'turn_1' })
io.notify('item/started', { item: { type: 'agentMessage', id: 'm1' } })
io.notify('item/agentMessage/delta', { id: 'm1', text: 'hello' })
io.notify('item/completed', { item: { type: 'agentMessage', id: 'm1', content: [{ type: 'text', text: 'hello' }] } })
io.notify('turn/completed', { turnId: 'turn_1', status: 'completed' })
io.respond({ ok: true })
```

### Golden traces

- Stored as NDJSON files under `testdata/codex-app-server/<scenario>.golden.jsonl`, matching the broker's notification format exactly.
- Tests assert byte-equivalence after normalizing volatile fields: `time`, `pid`, `durationMs`. (`seq` is deterministic per scenario and is asserted.)
- Stored per-Codex-version (`testdata/codex-app-server/v<X>/<scenario>.golden.jsonl`) so protocol drift doesn't churn unrelated tests.
- Update workflow: `UPDATE_GOLDEN=1 bun test` regenerates.

---

## 4. Capabilities matrix (Codex app-server v0)

Verbatim from spec §8. The driver MUST return this from `capabilities()`:

```json
{
  "input": {
    "user": true,
    "steer": false,
    "appendContext": false,
    "localImages": true,
    "fileRefs": false,
    "queue": false
  },
  "turns": {
    "concurrency": "single",
    "interrupt": "unsupported"
  },
  "continuation": {
    "supported": true,
    "provider": "codex",
    "keyKind": "thread"
  },
  "events": {
    "assistantDeltas": true,
    "toolCalls": true,
    "usage": true,
    "diagnostics": true
  },
  "control": {
    "stop": true,
    "dispose": true
  }
}
```

A Phase 3 test asserts the driver's `capabilities()` output deep-equals this fixture.

---

## 5. HRC migration appendix

The spec is HRC-agnostic; the broker doesn't know about callbacks, spool, runtime IDs, or HRC at all. Migration is HRC's responsibility and must not affect the broker package boundary.

### Strategy: parallel paths, opt-in cutover

1. **Phases 0–4 do not modify `hrc-server/src/launch/exec.ts`.** Existing behavior preserved.
2. After Phase 4, add an HRC-side launch path beside existing exec:
   - `hrc-runtime/packages/hrc-server/src/broker/compile.ts` — builds a `HarnessInvocationSpec` from existing launch artifact data. (HRC owns the compile; broker doesn't.)
   - `hrc-runtime/packages/hrc-server/src/broker/start.ts` — starts `harness-broker` via the reference client.
   - `hrc-runtime/packages/hrc-server/src/broker/events.ts` — adapts broker events to current HRC persistence / callback / `eventKind` shapes.
   - `hrc-runtime/packages/hrc-server/src/broker/envelope.ts` — HRC-only launch IDs, runtime IDs, callback socket paths, generation, spool config.
3. Feature-gate the new path by harness/mode:
   - Gate 1: headless Codex app-server with fake harness in CI.
   - Gate 2: real local Codex app-server headless smoke, opt-in via env/config.
   - Gate 3: selected HRC dev sessions opt-in.
   - Interactive/tmux launches stay on `exec.ts` until broker covers event parity and operator-display behavior.
4. Event compatibility:
   - HRC adapter translates broker events to existing HRC callback/event names during migration.
   - HRC owns persistence, generation fences, run/runtime/session IDs, callback routes, stale-callback rejection, spool replay.
   - Broker `invocationId` + monotonic `seq` are the idempotency inputs for HRC persistence; broker is not a durable log.
5. Once Codex app-server traffic runs 100% through broker for a stable period:
   - Delete `runCodexAppServerOneShot` import from `hrc-runtime/packages/hrc-server/src/launch/exec.ts:10`.
   - Delete the app-server one-shot branch from `exec.ts`.
   - Other harnesses (Claude CLI, Pi CLI, headless Codex JSONL) keep `exec.ts` until their broker drivers exist.

### What stays in HRC permanently

- Callback HTTP routes (`/v1/internal/launches/:launchId/event`), generation fences, spool replay.
- `launchId`, `runtimeId`, `hostSessionId`, `runId` interpretation.
- AgentChat register/deregister; OTEL config injection into Codex home (compile-time, before broker spawn).
- Launch header rendering, prompt material display.
- tmux session/window/pane lifecycle.

### Manual smoke gates before claiming HRC migration complete

- `just install` Agent Spaces packages through the repo's install flow.
- Restart HRC.
- Run an HRC launch through the broker path with real config.
- Confirm persisted HRC events, continuation update, final output, and exit behavior match the existing path from the operator perspective.

---

## 6. Reuse decisions (per spec §20)

| Existing file | Decision | Rationale |
|---|---|---|
| `packages/harness-codex/src/codex-session/rpc-client.ts` (219 lines) | **Copy** to `harness-broker/src/drivers/codex-app-server/rpc-client.ts` | Importing would preserve the boundary we're dissolving. Copying lets the broker own close/error/request semantics and avoids treating session helpers as API. |
| `packages/harness-codex/src/codex-session/run-one-shot.ts` (594 lines) | **Mine for patterns** | Event-mapping logic informs `event-map.ts`; do not import. Existing file mixes orchestration + mapping; broker separates them. |
| `packages/harness-codex/src/adapters/codex-adapter.ts` (1178 lines) | **Reference only** | Adapter belongs to ASP compile pipeline; produces `HarnessInvocationSpec` input but is not part of broker. |
| `hrc-runtime/packages/hrc-server/src/launch/exec.ts` (750 lines) | **Operational inspiration only** | Process spawn / signal-forward patterns; do not import. Callback/spool/launchId belong to HRC permanently. |

---

## 7. Risk register

Merged from spec §18 and implementation-specific risks.

| Risk | Impact | Mitigation |
|---|---|---|
| Codex app-server protocol drift (spec §18.1) | Driver breaks silently when Codex releases a new app-server version | Driver pins `clientInfo.version`; version-gate `initialize` response; fail fast with `DriverUnavailable`. Add a smoke test against installed Codex binary (skip if absent). Goldens stored per-Codex-version. |
| Turn interrupt unsupported (spec §18.2) | Operators expect to interrupt; broker rejects | Capability declares `interrupt: 'unsupported'`. Reject with `UnsupportedCapability`. Revisit when Codex publishes a cancel/interrupt method. |
| Permission UX (spec §18.3) | `ask-client` requires broker→client request; v0 client may not support | Default `deny` documented. `ask-client` rejected at `broker.hello` if `clientCapabilities.permissionRequests !== true`. |
| Event granularity / golden churn (spec §18.4) | Codex item schema evolves → goldens churn | Drivers carry `version`; `event-map.ts` translates by Codex version. Goldens stored per-version under `testdata/codex-app-server/v<X>/`. |
| Structured final results (spec §18.5) | Tempting to design output-schema in v0 | v0 treats final output as text + raw usage/artifacts. Defer `outputSchema` to a later phase. |
| Multiple invocations per broker (spec §18.6) | Tempting to add early; complicates state | v0 hard-rejects second `invocation.start` with `InvalidInvocationState`. Protocol carries `invocationId` so future expansion is non-breaking. |
| PTY drivers later (spec §18.7) | Future PTY broker could conflate protocol stdout with harness stdout | Spec mandates separation. Add import-boundary test forbidding `harnessTransport.kind === 'pty'` until a Phase 5+ PTY driver lands. |
| Env / security leakage | `invocation.started` could leak credentials | Phase 3 redaction mandatory before any non-test consumer. Test asserts env values never appear in event JSON under any scenario. |
| Event ordering / replay | Process-exit races could duplicate or reorder events | Broker emits monotonic `seq` per spec §5.3. HRC persists idempotently. Broker is not a durable event log. |
| Test flakiness from real subprocess spawning | Race conditions in fake-harness tests | Fakes are deterministic NDJSON scripts (no timing assumptions). Each test wraps in stop+dispose. CI runs with explicit `timeout(30s)`. |
| Package boundary drift | Broker could start importing compiler or HRC internals | New packages added to `scripts/check-boundaries.ts` with forbidden-import rules. CI enforces. |
| Reusing existing rpc-client | Coupling broker to `harness-codex` defeats package split goal | Decision §6: copy, don't import. |

---

## 8. Review checkpoints

- **End of Phase 0:** review protocol/schema names and event envelope before implementation depends on them.
- **End of Phase 1:** review broker stdio behavior and state machine against spec §11.1, with noop driver.
- **End of Phase 2:** review Codex golden event fixtures against spec §10.4 mapping table.
- **End of Phase 3:** review capability/error semantics and permission policy UX.
- **End of Phase 4:** review HRC client integration sketch before enabling any real HRC launch path.

---

## 9. Effort estimate

| Phase | Effort | Ships independently? |
|---|---|---|
| 0 — Protocol | 2d | Yes (types + validators only) |
| 1 — Skeleton | 3d | Yes (no driver; usable for client lib dev) |
| 2 — Codex driver | 5d | Yes — broker becomes useful to real consumers |
| 3 — Control / policies | 2d | Yes |
| 4 — Reference client | 2d | Yes |
| **Total** | **~14 working days** | — |

HRC migration (post-Phase 4) is a separate work item in `hrc-runtime`, estimated 5–7d, owned by HRC maintainer.

---

## 10. Open items

Resolved during delivery:

1. ~~**Schema validation library.**~~ Hand-rolled (`zod` was only a transitive dep, not declared). ~700 LOC of validators in `packages/harness-broker-protocol/src/schemas.ts`.
2. ~~**CI smoke against real Codex binary.**~~ Not in CI; manual smoke documented in `runbooks/e2e-harness-codex-app-server.md`. Validated against codex-cli 0.130.0 on 2026-05-20.

Still open:

3. **HRC migration owner & timing.** Phases 0–4 left HRC untouched. Who owns the `hrc-runtime` integration work, and when? Broker is dormant on `main` until something explicitly invokes it.
4. **Broker-owned FIFO input queue.** The protocol has `interaction.inputQueue`, `policy.whenBusy: "queue"`, queued dispositions, and `input.queued` events, but the current manager delegates `invocation.input` directly to `driver.input`. Before HRC migrates busy-session dispatch to the broker, implement the queue in `InvocationManager`: admit busy inputs into a per-invocation FIFO queue, emit `input.queued`, drain one input after each terminal turn event, and keep the behavior client-agnostic so HRC, ACP, CLIs, tests, and future clients all share the same semantics. See wrkq T-01574.
5. **Future driver roadmap.** v0 ships Codex app-server only. When (and who) for Claude CLI / Pi CLI / headless Codex JSONL drivers? Recommend defer until at least one real consumer (HRC or otherwise) is running the Codex driver in production.
6. **`ask-client` permission flow.** Wire-protocol works; no consumer exercises it yet. Once HRC (or another client) needs interactive approval, exercise the path and promote the deferred `todo` test to a real assertion.
