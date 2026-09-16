# aspd: independent ASP preparation daemon (pilot)

Status: pilot contract for T-08539. Governing design:
`hrc-runtime/asp-hrc-split-proposal.md` at `bf3e539e` (Daedalus APPROVE,
EN-12789). Scope decisions: EN-12854 / EN-12856 (T-08539 room).

`aspd` is the existing ASPC compile plane — the seven `aspc.*` methods bound by
`registerAspcCompileMethods` — served by a long-lived process on a stable,
explicitly configured Unix socket, from one immutable ASP release. It prepares;
it never starts a harness. Workers are the existing `harness-broker` from the
same release, hosted by the client and controlled directly over their own Unix
sockets with the existing broker protocol.

The bounded supported path is HRC-hosted headless Codex (`codex-app-server`)
with durable worker IPC and no operator viewer. A standalone pilot client stands
in for HRC; HRC is not changed or activated.

## Protocol: existing verbs, additive metadata only

No new RPC verbs, no replacement payload, no version bump. `aspc/0.1` and the
broker's `harness-broker/0.2|0.3` negotiation are unchanged.

| Surface | Change | Why |
| --- | --- | --- |
| `aspc.hello` (W1) | `capabilities.transports` may report `unix-jsonrpc-ndjson`; optional `release: {releaseId, sourceCommit, builtAt}` | Accurate transport reporting; the serving release is proven by the reply, not by a path |
| `aspc.compileHarnessInvocation` ok response (W2) | optional `executionRelease: {releaseId, sourceCommit, builtAt, releaseRoot, worker: {protocol, executable, argvPrefix}}` | The client launches the worker from the selected release without choosing a binary by driver name or through PATH/`current` |
| `broker.hello` (W3) | optional `release: {releaseId, sourceCommit, builtAt}` | The worker reports the release actually executing, at handshake |
| Thin Unix client (W4) | `spaces-aspc-protocol/unix-client` | Wire types + NDJSON framing + transport only |

Everything else — `compileResponse`, `plan`, `selectedProfile`, `startRequest`,
`dispatchRequest`, diagnostics, catalog/inspection semantics — is byte-for-byte
the existing contract. `aspd` does not register `aspc.compileAndStart` and
reports `compileAndStart: false`, `cohostedBroker: false`.

### Release identity

`release` blocks come from identity compiled into the executable
(`bun build --define`) when the release is built, not from launcher environment
variables. A checkout (non-release) process reports no `release` block; `aspd`
refuses to serve without one.

`executionRelease.releaseRoot` is the canonical directory of the release that
contains the running `aspd` payload, verified against its `release.json`.
`worker.executable` is the absolute `harness-broker` launcher inside that
directory. `worker.protocol` is the selected profile's own `brokerProtocol`
(headless Codex selects `harness-broker/0.2`); it is reported, not raised.
`worker.argvPrefix` is `["run", "--transport", "unix"]`; the remaining flags are
the existing broker CLI hosting contract HRC already realizes (`--socket`,
`--event-ledger`, `--runtime-id`, `--host-session-id`, `--generation`,
`--attach-token-file`, and for a tmux-tui viewer
`--experimental-observer-socket`).

A release worker that hosts the codex-app-server viewer launches its renderer
through its own payload (`<releaseRoot>/libexec/harness-broker renderer …`),
passed explicitly by the release entrypoint, so the viewer always runs from the
same release as the worker. A checkout broker keeps `bun <renderer-entry>`
(T-08554).

## Preparation → hosting → start

1. **Prepare.** The client connects, calls `aspc.hello` (every connection), then
   `aspc.compileHarnessInvocation` with an existing `RuntimeCompileRequest`.
   Preparation may materialize resources (runtime homes under the daemon's
   configured ASP home). It starts no worker and no native harness and applies
   no input.
2. **Persist the preparation.** The client writes the complete response —
   including the intact `dispatchRequest` and `executionRelease` — before any
   hosting effect. This is the frozen preparation; it needs nothing from daemon
   memory.
3. **Validate before launch.** From the persisted bytes only: the release
   directory exists and its `release.json` names `executionRelease.releaseId`
   and `sourceCommit`; `worker.executable` resolves inside `releaseRoot`;
   `worker.protocol` is one the client supports. Any failure is a named refusal
   (`release_unavailable`, `release_identity_mismatch`,
   `worker_executable_outside_release`, `unsupported_worker_protocol`) and
   nothing is launched.
4. **Realize resources.** The client allocates the worker IPC directory, socket
   path, event-ledger path and attach-token file, persists them
   (`bindings.json`), then launches `worker.executable argvPrefix… flags` as a
   detached process. Bootstrap starts only the broker; the broker has no
   invocation until `invocation.start`.
5. **Handshake.** `broker.hello` with `protocolVersions: [worker.protocol]`. The
   negotiated version must equal `worker.protocol` and `hello.release` must
   equal `executionRelease` (`worker_release_mismatch` /
   `worker_release_unidentified` otherwise; the worker is terminated and no
   start is sent).
6. **Start.** The persisted `dispatchRequest` is sent unchanged through the
   existing `invocation.start`. The client then `broker.attach`es with the
   attempt identity and the selected profile's `startRequestHash`/`profileHash`
   and controls the invocation through existing submission/event/replay
   methods.

### Start uncertainty (explicitly unproven in this pilot)

`invocation.start` has no durable receipt. This pilot does **not** prove
lost-start-reply safe retry and does not claim `invocation.start` is idempotent.
The client never auto-replays an effectful request on timeout, close, or
reconnect: an ambiguous start stays ambiguous and is reported as such. A saved
preparation that has never been submitted is a different fact from an
uncertain start — launching it is a first submission, not a retry.

Durable ensure receipts exist only on the participant path
(`broker.installIdentity`/`broker.ensureInvocation`), whose identity gate
requires correlation hashes that only the Arris participant adapter stamps. The
headless Codex `dispatchRequest` carries neither, so that path does not apply
without a contract change. The gap is deferred to the HRC integration/recovery
design (recorded on T-08539); participant behavior is unchanged.

## Service lifecycle and activation

All state lives under one explicit namespace root:

```
<ns>/releases/<releaseId>/      installed immutable releases (install-asp-release)
<ns>/service/config.json        external inputs: ASP home, codex path, env passthrough
<ns>/service/active.json        selected release for the service (activation)
<ns>/service/activations.ndjson activation history with serving readback
<ns>/run/aspd.sock              stable endpoint
<ns>/run/aspd.json              running pid + release
<ns>/logs/                      daemon logs
```

`just aspd-status <ns>` reports three separate facts: installed releases,
the selected release (`active.json`), and the running service identity read back
from `aspc.hello` over the socket (`runningEqualsSelected`).

Activation (`just aspd-activate <ns> <releaseId>`):

1. Inspect the target installed release (immutability, digests, embedded
   identity).
2. Retire the running daemon: on `SIGTERM` it stops admitting — the listener
   closes and the socket node is removed, and every existing connection stops
   dispatching new frames — then in-flight requests finish and reply as the old
   release, then all connections are closed and the process exits.
3. Record the selection, start the target release on the same socket, and read
   back `aspc.hello`. Activation is reported complete only after the old daemon
   has exited and the new one answers with the target identity.

A connection opened before activation cannot admit work into the old release
after cutover: its later requests are never dispatched and the connection
closes. Reconnect plus `hello` is transport recovery, not replay; the caller
decides whether to submit again. Preparation during an outage fails with
explicit unavailability — there is no bundled or source fallback.

Workers are not children of the service lifecycle: stopping, restarting,
activating or rolling back `aspd` never signals them. A prepared payload stays
runnable while another release is active or no daemon is running. Releases are
retained; there is no automated deletion.

## Commands

```bash
# Build, stage and inspect immutable releases (each from a clean, recorded commit)
just build-asp-release <abs-build-root>
just install-asp-release <abs-build-root>/<releaseId> <ns>/releases
just inspect-asp-release <ns>/releases/<releaseId>

# Service lifecycle in one isolated namespace
just aspd-init <ns> <abs-codex-path>
just aspd-activate <ns> <releaseId>     # retire → select → start → hello readback
just aspd-status <ns>                   # installed / selected / serving identity
just aspd-stop <ns>
just aspd-start <ns>
just aspd-restart <ns>

# Pilot client artifact (closure verified from the build metafile) and acceptance
just build-aspd-pilot-client <abs-output-root>
bun scripts/aspd-pilot/scenario.ts --ns <ns> --client <client> --evidence <dir> \
  --release-a <idA> --release-b <idB> --agent-root <agent> --project-root <project>
```

The pilot client speaks NDJSON commands on stdin (`connect`, `prepare`,
`launch`, `turn`, `worker-hello`, `stop-worker`, `exit`) and records every
preparation, hosting intent, binding, worker hello, start outcome and turn under
its `--state` directory.

## External inputs

Native Codex executable (`ASP_CODEX_PATH`, frozen into the compiled start
request), Codex authentication, agent/project configuration roots, and the ASP
home used for materialization are explicit external inputs recorded in
`service/config.json` and in the preparation request. The execution-code pin
does not freeze mutable agent sources.

## Pilot limitations

- The client still builds the existing `RuntimeCompileRequest` (placement roots,
  requested harness/interaction mode, policy, identity/correlation). Runtime
  intent input redesign is deferred.
- The broker does not itself refuse a start whose payload came from another
  release; the client's pre-launch and handshake checks enforce the binding.
- No durable start receipt / lost-reply retry on this path (above).
- One route: headless `codex-app-server`. Other harnesses, participant-served
  workers, offline journal readers and HRC integration are out of scope.

## Acceptance plan

Installed artifacts only, isolated namespace, real Codex, driven by one fixed
pilot client artifact and process (`scripts/aspd-pilot`), evidence under
`var/wrkq-artifacts/T-08539/`:

1. Build and install releases A and B from recorded, pushed commits; inspect
   both; prove daemon and worker identities through `aspc.hello` and
   `broker.hello`.
2. A active: save a never-started preparation to disk; prepare/launch/start an
   A worker and complete a real turn with a unique marker.
3. Open a connection before activation, and put a preparation in flight across
   activation. Activate B: the in-flight request finishes as A; the old
   connection cannot admit new work; a new preparation on a reconnect is served
   by B; start a B worker and complete a real turn.
4. Send another real turn to the A worker while B is active. Launch the saved A
   preparation from disk while B is active; it runs A and completes a turn.
5. Stop `aspd`: preparation reports unavailability; existing A and B workers
   still take real turns. Restart; readback matches.
6. Roll back to A: new preparations are A; B workers still take turns.
7. Failure boundaries: no native process during preparation or bootstrap
   (process tree and `broker.listInvocations` before start); unsupported worker
   protocol, identity-mismatched release, executable outside the release and a
   withheld (unavailable) release are refused before launch; a worker whose
   hello identity differs is refused before `invocation.start`.

## Pilot evidence layout

T-08539 retains its installed acceptance under
`var/wrkq-artifacts/T-08539/` (outside every checkout): `releases-build/` (built
A/B artifacts), `ns/` (the isolated service namespace with installed releases,
activation history and daemon logs), `client/` (the fixed pilot client artifact
and its closure manifest), `ev/` (scenario record, client state: preparations,
hosting intents, bindings, worker hellos, start outcomes, turn events) and
`gates/` (verify, matrix smoke, build outputs).
