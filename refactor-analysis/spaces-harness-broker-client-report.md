# Refactor analysis — spaces-harness-broker-client

packageType: **general** (a thin, typed RPC facade over a JSON-RPC/NDJSON transport;
correctness is dominated by lifecycle/teardown edge cases, not throughput).

## Summary

This package is a typed client facade for the harness broker: a `BrokerClient` over a
transport abstraction (`JsonRpcFramedChannel` → `StdioTransport` / `UnixSocketTransport`),
plus three small collaborators (`InvocationEventHub`, `PermissionRouter`, `EventIterator`)
and two value helpers (`socket-path`, `errors`). 11 files, ~1175 LOC.

The codebase has had two prior SOLID/code-smell passes (T-02028, T-02030). It shows: the
structure is already well-factored. The transport split has a real, documented seam
(`BrokerJsonRpcTransport`) with **two genuinely distinct implementations** (owned-child
SIGTERM/SIGKILL vs. socket-only destroy) — so it is NOT a one-implementor abstraction and
must NOT be de-abstracted. `JsonRpcFramedChannel` hoists the shared framing/pending-map/
routing; the `handleMessage` override seam for the unix `control.fenced` fence is real and
used. Characterization-test coverage on the public surface is strong (`integration`,
`start-request`, `unmatched-response`, `handler-disposers`, `process-exit`,
`broker-durability-unix`, `interleaving`, `permission-handler`), so make-safe [T40] is
largely satisfied for the apply phase.

I found **0 auto-applicable (Low/Med + internal-only) findings**. The two surviving
observations are both judgment calls about the PUBLIC surface (one cross-repo consumer in
`hrc-runtime`), so they are deferred, not auto-applied. This is an honest near-clean result.

## Public boundary verdict

`index.ts` re-exports `BrokerClient`, the two concrete transports, `EventIterator`, the
two error classes, the socket-path helpers, and a focused set of types. The boundary is
**coherent and intentional**, not leaky:

- `BrokerJsonRpcTransport` is exported so a consumer can supply a custom channel via
  `BrokerClient.fromTransport`; `StdioTransport`/`UnixSocketTransport` are exported so a
  consumer can construct/own one directly. Both are exercised cross-repo.
- The transport-specific `close()` semantics divergence (kill child vs. destroy socket) is
  documented at the interface level (`transport.ts`) — the leaky-abstraction risk is
  acknowledged in-band rather than hidden. Good.
- I confirmed against the sole external consumer (`hrc-runtime/packages/hrc-server`): it
  uses `startInvocationFromRequest`, `status`, `snapshot`, `health`, `stop`, `onClose`,
  `streamInvocationEvents`, `attach`, `eventsSince`, `ackEvents`, `dispose`, `listInvocations`,
  `interrupt`, `input`, `hello`, `close`, `onPermissionRequest`. The full v2 surface is real
  consumer demand, not speculative.

Verdict: **do not narrow or widen the public API.** Both deferred items below touch this
surface and need a human's M02 (expand/contract) judgment because of the cross-repo consumer.

## Findings by mechanism

### [T16] De-abstract candidate — `startInvocation` positional convenience overload — REJECTED after pressure-test
- **Location:** `src/client.ts:134-147` (`startInvocation`), and the discriminated arg in
  `startInvocationFromRequest` / `#normalizeDispatchOptions` (`src/client.ts:149-210`).
- **Initial smell:** `startInvocation(spec, initialInput?, runtime?, lifecyclePolicy?)` is a
  4-positional-arg wrapper that just rebuilds a request and delegates; `startInvocationFromRequest`
  takes a `dispatchEnvOrOptions` that is EITHER a bare `dispatchEnv` map OR a full options
  object, discriminated by key-presence. Smells like a primitive-obsession / overloaded-param
  pair ripe for collapse.
- **Why REJECTED (contraindication honored):** The dual form is load-bearing at the cross-repo
  boundary. `hrc-runtime/.../broker/controller.ts:730-739` calls BOTH the options-object form
  (`startInvocationFromRequest(req, { dispatchEnv, runtime, lifecyclePolicy })`) AND the bare
  positional form (`startInvocationFromRequest(req, input.dispatchEnv, dispatchRuntime)`). The
  `#normalizeDispatchOptions` key-presence discriminator is therefore exercised by real callers,
  not dead. Collapsing it would be a public-surface contract change (M02), not an internal
  refactor. Leave it.
- Note: `startInvocation` (the spec-positional convenience entry) has no external consumer
  (only this package's own tests at `test/*.ts`). It could in principle be trimmed, but that is
  a public-surface deletion gated on M02/consumer audit — see deferred item D1.

### [T15 / DRY] writeFrame destroyed-guard duplicated across transports — minor, deferred-by-affinity
- **Location:** `src/stdio-transport.ts:103-109` and `src/unix-socket-transport.ts:145-151`.
- **Shape:** both `writeFrame` implementations do `assertWritable(); if (sink.destroyed) throw
  new BrokerTransportError('... is closed'); sink.write(encodeNdjsonFrame(message))`. The
  destroyed-check + encode + write triad is structurally identical; only the sink
  (`child.stdin` vs `socket`) and the error string differ.
- **Why NOT a clean extraction:** The sinks have different types (`Writable` vs `net.Socket`),
  the error messages are intentionally distinct ("Broker stdin is closed" vs "Broker socket is
  closed"), and the divergence is small (3 lines). Folding into a base-class
  `protected writeEncodedFrame(sink, closedMessage)` would add a parameterized helper to save
  ~2 lines per transport while coupling the base class to a `{ destroyed: boolean; write }`
  shape. This is duplication that is **arguably load-bearing** (each transport keeps its own
  precise diagnostic). Net churn (new base method, two call-site edits, test re-read) likely
  exceeds the value. Left alone deliberately; recorded for completeness, not recommended.

### [T17] No partial→total defects found
- `JsonRpcFramedChannel.handleMessage` (`src/json-rpc-channel.ts:152-180`) is a real exhaustive
  router (response / notification / request), each arm reachable; the implicit "else" (a frame
  that is none of the three) is a deliberate silent drop, correct for a tolerant wire reader.
- `PermissionRouter.#fallback` and the no-handler/handler-throws paths
  (`src/permission-router.ts:41-66`) are all genuine reachable guards with a safe-deny default.
  These are correct totality, not "can't happen" arms to narrow.

### [T18] Error handling — already correct
- `request()` write-failure cleanup deletes the pending entry before rejecting
  (`src/json-rpc-channel.ts:126-131`); `fail()` is idempotent and rejects-all-pending exactly
  once (`:212-218`); `#handleRequest` maps handler throws to a `-32603` error response rather
  than swallowing (`:182-206`). The `promise.catch(() => {})` at `:124` is a deliberate,
  commented unhandled-rejection guard, not a swallow. No restructuring warranted.

### [T10] Implicit state — already reified
- `closed` / `failure` latches are explicit and centrally gated in `request()`
  (`src/json-rpc-channel.ts:98-104`). The `UnixSocketTransport` `settled` latch
  (`:69-101`) and `#closePromise`/`#resolveClose` close-handshake are clean single-fire state.
  No boolean-soup to encode.

## Deliberately left alone (with reasons)

- **Transport seam (`BrokerJsonRpcTransport` + `JsonRpcFramedChannel`)** — two real
  implementations with divergent teardown contracts; the `handleMessage` override for
  `control.fenced` is used by exactly the unix transport. Not a premature abstraction. Keep.
- **`EventIterator.return()` does not remove its stream from `InvocationEventHub`** — a `for
  await` break leaves the per-invocation `EventIterator` in the hub's `#events` map until
  `dispose`/`closeAll`. This is a behavior question (a potential slow leak across many short
  attaches), NOT a refactor: changing it alters the de-dupe/replay contract documented on the
  hub. If the user wants it pursued, it is a redesign, not an API-preserving cleanup. Flagged
  here, not auto-applied.
- **`assertWritable()` checks only `failure`, not `closed`** (`json-rpc-channel.ts:234-238`) —
  intentional: every `request()` already gates on `closed` before reaching `writeFrame`, and
  `writeFrame` additionally checks `sink.destroyed`. The asymmetry is defensible and changing it
  would be behavior-touching. Left.
- **`#idKey(id) => String(id)`** (`json-rpc-channel.ts:229-231`) — a one-liner that normalizes
  number|string JSON-RPC ids to a Map key. Trivial but named and correct; inlining it would lose
  the intent label. Keep.
- All magic numbers are already named constants (`DEFAULT_CLOSE_GRACE_MS`, `STDERR_TAIL_LIMIT`,
  `JSON_RPC_METHOD_NOT_FOUND`, `JSON_RPC_INTERNAL_ERROR`, socket-path budgets). Prior passes
  handled these.

## Outside-in apply sequence

No auto-applicable internal-only findings. The apply phase should make **no source edits** to
this package. The two deferred items (D1, D2) are public-surface and require a human decision
(M02 expand/contract against the `hrc-runtime` consumer) before any change — they are surfaced,
not applied.
