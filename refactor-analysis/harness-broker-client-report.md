# Refactor audit — spaces-harness-broker-client

Package: `packages/harness-broker-client/`
Audited every non-test source file under `src/` (client, json-rpc-channel, stdio-transport,
unix-socket-transport, invocation-event-hub, event-iterator, permission-router, errors,
socket-path, transport, index).

## Overall assessment

This package was just through a SOLID/code-smell cleanup pass (HEAD commit e238805,
"SOLID/code-smell cleanup pass across all 17 packages"). It shows: responsibilities are
already split into focused units (framing in `JsonRpcFramedChannel`, per-transport teardown
in the two subclasses, event lifecycle in `InvocationEventHub`, permission fallback in
`PermissionRouter`, socket-budget math in `socket-path`), magic numbers are named constants
(`DEFAULT_CLOSE_GRACE_MS`, `STDERR_TAIL_LIMIT`, `JSON_RPC_*`, socket budgets), guard clauses
and early returns are used throughout, and behavior is heavily documented. There are no long
multi-job functions, no deep nesting, no commented-out blocks, and no obvious copy-paste
logic blocks of substance.

Only a handful of low-value findings remain. They are listed below honestly; none is a
structural problem.

## Dead method: InvocationEventHub.hasStream
- File: packages/harness-broker-client/src/invocation-event-hub.ts:59
- Risk: Low
- API-impact: internal-only
- Smell: Dead code. `hasStream(invocationId)` is defined but has zero callers in `src/` and
  zero references in the package's tests. `InvocationEventHub` is not re-exported from
  `index.ts`, so the method is not part of the package's public surface.
- Proposed change: Delete the `hasStream` method (and its leading doc comment). Behavior of
  every reachable path is unchanged.

## Unnecessary `export` on internal JSON-RPC code constants
- File: packages/harness-broker-client/src/json-rpc-channel.ts:18
- Risk: Low
- API-impact: internal-only
- Smell: `JSON_RPC_METHOD_NOT_FOUND` (-32601) and `JSON_RPC_INTERNAL_ERROR` (-32603) are
  declared `export const` but are referenced only inside `json-rpc-channel.ts` (lines 187,
  201) and are NOT re-exported from `index.ts`, so they are not actually part of the package
  public API. The `export` keyword overstates their reach.
- Proposed change: Drop `export` from both constants (keep them as module-private `const`s
  with their doc comments). Behavior unchanged; this only narrows visibility. (Verified with a
  workspace grep that no sibling package deep-imports `.../src/json-rpc-channel`; current grep
  shows only test/dist/self references.)

## Repeated `if (this.failure) throw this.failure` write guard across transports
- File: packages/harness-broker-client/src/stdio-transport.ts:104
- Risk: Low
- API-impact: internal-only
- Smell: Minor duplicated logic. Both `StdioTransport.writeFrame` (lines 104-106) and
  `UnixSocketTransport.writeFrame` (lines 146-148) open with the identical
  `if (this.failure) { throw this.failure }` failure-latch guard before their channel-specific
  destroyed-check. The shared `failure` field already lives on the base `JsonRpcFramedChannel`.
- Proposed change: Add a `protected assertWritable()` (or `throwIfFailed()`) helper on
  `JsonRpcFramedChannel` that performs the `if (this.failure) throw this.failure` check, and
  call it at the top of each subclass `writeFrame`. The per-transport destroyed-check
  (`child.stdin.destroyed` vs `socket.destroyed`, with their distinct messages) stays in the
  subclass. Behavior-preserving; removes one duplicated branch. (Marginal — the duplication is
  a single line; acceptable to leave as-is.)

## Notes considered and intentionally NOT filed as findings
- `BrokerClient` is a wide class (many one-line `this.#transport.request(...)` delegators).
  This is a deliberate, cohesive client facade over the JSON-RPC method surface, every method
  is exported public API, and splitting it would change the public surface. Not a god-object
  smell worth acting on; any change would be public-surface and is out of scope.
- `BrokerClient.startInvocation` / `startInvocationFromRequest` positional overload
  (`dispatchEnvOrOptions`) is a mild union/boolean-trap, but it is public API and already
  factored behind `#normalizeDispatchOptions` / `#buildDispatch`. Deferred — public-surface,
  do not touch.
- `client.close()` calls `#eventHub.closeAll()` and the transport's `onClose` callback also
  calls `closeAll()`; this looks redundant but `closeAll()` is idempotent and the second path
  covers transport-initiated closes. Correct as written; not a finding.
