# aspd: v2 ASP compilation and release hosting

## Current v2 contract

`aspd` serves the producer-owned ordinary compilation boundary from an immutable
ASP release. Its sole public ordinary compile RPC is
`aspc.compileHarnessInvocation`, accepting only
`schemaVersion: "agent-runtime-compile-request/v2"`. The request has a closed
selection vocabulary — `agent-harness`, `claude`, `codex`, and `muse` — plus
independent `modelProvider`, `model`, `reasoningEffort`, and boolean
`presentation` inputs. The default harness is `agent-harness` and the default
presentation is `false`.

ASPC validates the envelope and invokes the compiler; it owns no route catalog,
profile selector, or driver selector. The compiler catalog is the sole authority
that resolves harness and presentation to a recipe, frozen driver, transport,
terminal requirement, and hosting requirement. A provider or model never
chooses a harness. A true presentation request resolves to a fulfilling recipe
or a typed refusal; it is never silently downgraded.

Every successful ordinary response contains one `execution` and one canonical
start request at `execution.dispatchRequest.startRequest`. The selected v2
release must positively bind that compiler-selected driver before a successful
response can expose `executionRelease`; the broker executes the frozen driver
named by that canonical request. V1 requests, plans, and profiles; profile TOML
versions 1–3; target schema 1; aliases; `viewer`; and retired selectors fail
closed at their typed boundary. Existing v1 release artifacts remain immutable
history, not v2-compatible producers or fallback readers.

This is an ASP-only cutover. HRC continues to own its placement, authorization,
resource allocation, terminal leases, lifecycle, messaging, continuation,
credentials, and reattachment boundaries, but its migration and disposition of
prepared or live v1 state are explicitly outside this document's scope.

The governing active records are
`agent-spaces.producer-owned-harness-selection` and
`agent-spaces.aspd-release-worker-hosting`; the approved design is
`docs/proposals/producer-owned-harness-selection.md`.

## Historical pre-v2 pilot record

The rest of this page retains the T-08539/T-08561 pilot evidence and operation
notes. It accurately describes the then-current v1/additive ASPC surface, but
does not extend, soften, or replace the v2 contract above.

At that time, release-bound preparation was established by T-08539 and extended
to supported compiler-backed Claude/Pi workers by T-08561. Its governing designs
were `hrc-runtime/asp-hrc-split-proposal.md` at `bf3e539e` (Daedalus APPROVE,
EN-12789) and `agent-spaces.aspd-release-worker-hosting` (Daedalus APPROVE,
EN-13188). The pilot ASPC compile plane bound seven `aspc.*` methods through
`registerAspcCompileMethods`, served from an immutable release on an explicitly
configured Unix socket. It prepared but never started a harness.

### Pilot protocol: existing verbs and additive metadata only

The pilot had no new RPC verbs, replacement payload, or version bump:
`aspc/0.1` and the broker's `harness-broker/0.2|0.3` negotiation were unchanged.

| Surface | Pilot change | Why |
| --- | --- | --- |
| `aspc.hello` (W1) | `capabilities.transports` may report `unix-jsonrpc-ndjson`; optional `release: {releaseId, sourceCommit, builtAt}` | Accurate transport reporting; the serving release is proven by the reply, not by a path |
| `aspc.compileHarnessInvocation` ok response (W2) | optional `executionRelease: {releaseId, sourceCommit, builtAt, releaseRoot, worker: {protocol, executable, hostedDrivers?, argvPrefix}}` | The client launches the selected worker without PATH/`current`; `hostedDrivers` is positive evidence from bindings assigned to that executable |
| `broker.hello` (W3) | optional `release: {releaseId, sourceCommit, builtAt}` | The worker reports the release actually executing, at handshake |
| Thin Unix client (W4) | `spaces-aspc-protocol/unix-client` | Wire types + NDJSON framing + transport only |

In the pilot, all other compile response and profile shapes remained byte-for-byte
the existing contract. `aspd` did not register `aspc.compileAndStart` and
reported `compileAndStart: false`, `cohostedBroker: false`.

#### Pilot release identity

`release` blocks come from identity compiled into the executable
(`bun build --define`) when the release is built, not from launcher environment
variables. A checkout (non-release) process reports no `release` block; `aspd`
refuses to serve without one.

`executionRelease.releaseRoot` is the canonical directory of the release that
contains the running `aspd` payload, verified against its `release.json`.
`worker.executable` is the absolute selected worker launcher inside that
directory. `worker.hostedDrivers`, when present, is the sorted set of manifest
bindings assigned to that executable; extra registered drivers are not
evidence. `worker.protocol` is the selected profile's own `brokerProtocol`; it
is reported, not raised.
`worker.argvPrefix` is `["run", "--transport", "unix"]`; the remaining flags are
the existing broker CLI hosting contract HRC already realizes (`--socket`,
`--event-ledger`, `--runtime-id`, `--host-session-id`, `--generation`,
`--attach-token-file`, and for a tmux-tui viewer
`--experimental-observer-socket`).

#### Pilot release-owned offline evidence

Contract-capable frozen manifests declare
`harness-broker.offline-evidence/v1` in `capabilities`. Historical manifests may
omit the field; a consumer treats absence as unsupported and does not guess an
`evidence-read` command. The existing immutable `harness-broker` executable owns
the one-shot read-only mode:

```text
<executionRelease.worker.executable> evidence-read \
  --event-ledger <absolute events.ndjson> \
  --index <absolute ledger-index.db>
```

It reads one closed JSON request from stdin and writes one compact JSON result.
`eventsSince` returns already-committed normalized envelopes through the
published `harness-broker.offline-evidence/v1` DTOs. The reader copies the
SQLite DB and any WAL—not SHM—to a private temporary directory before opening
SQLite, verifies source identities before and after, and never writes beneath
the retained ledger directory. It has no ACK, prune, follow, attach, start,
submission, permission, socket, or raw-normalization path. A checkout executable
has no embedded release identity and returns typed `offline_schema_unsupported`.

The same mode accepts `providerObservations` for an explicit Codex or Claude
JSONL artifact. Those observations and independently normalized broker
comparison forms are comparison-only; they are not broker envelopes or
execution/lifecycle authority. The request/result, paging, byte limits,
snapshots, and typed errors are exported by `spaces-harness-broker-protocol`.
HRC remains responsible for selecting the persisted owning release, validating
the returned identity, projecting events, holding retained evidence, and
enforcing that offline projection never reattaches or acknowledges that
runtime. Reading retained evidence never starts or recreates execution
authority.

A release worker that hosts the codex-app-server viewer launches its renderer
through its own payload (`<releaseRoot>/libexec/harness-broker renderer …`),
passed explicitly by the release entrypoint, so the viewer always runs from the
same release as the worker. A checkout broker keeps `bun <renderer-entry>`
(T-08554).

A release worker that hosts the interactive codex-app-server TUI (`codexTui`
presentation, HRC's `hrc run` door) launches its codex-tui wrapper as
`<releaseRoot>/libexec/harness-broker codex-tui-wrapper …` through the tmux launch
runner `<releaseRoot>/libexec/harness-broker tmux-launch --launch-file …`, and its generated hook
bridge calls `<releaseRoot>/libexec/harness-broker codex-hook …`, both passed
explicitly by the release entrypoint, so the TUI wrapper and hook receiver run
from the same release as the worker. A checkout broker keeps `<execPath>
<codex-tui-wrapper entry>` and PATH `harness-broker codex-hook` (T-08556). The
wire, the compile and `worker.argvPrefix` are unchanged.

Release workers hosting `claude-code-tmux` or `pi-tui-tmux` also run their hook
bridges and tmux launch runner through the selected compiled payload:
`<payload> claude-hook`, `<payload> claude-hook-decision`, `<payload> pi-hook`,
and `<payload> tmux-launch`. Claude's statusline source is a digested release
asset; compilation verifies and copies it into the materialized bundle, whose
settings point only at the bundle-local copy. Checkout/package compositions
retain their existing source/PATH and best-effort statusline fallbacks.

If a binding-aware release selects a profile whose `brokerDriver` has no
binding, aspd returns `release_worker_driver_unavailable` on the existing
`ok:false` compile envelope before `executionRelease` or any hosting effect.
Retained pre-binding v1 releases keep their own compiled behavior and may omit
both the binding table and `hostedDrivers`; inspection does not retrofit them.

### Pilot preparation → hosting → start

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
   T-08562 adds the HRC admission rule that every non-`codex-app-server` aspd
   launch must also have `worker.hostedDrivers` containing the selected
   `brokerDriver`. Its absence remains accepted for the proven legacy Codex
   binding only.
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

#### Start uncertainty (explicitly unproven in this pilot)

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

### Pilot service lifecycle and activation

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

### Pilot commands

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

### Pilot external inputs

Native Codex (`ASP_CODEX_PATH`), Claude, and Pi executables, their credentials,
agent/project configuration roots, and the ASP home used for materialization
remain explicit external inputs. The execution-code pin does not freeze mutable
agent sources.

### Pilot execution preparation operations

The additive `aspc/0.1` preparation plane exposes one pure operation:
`aspc.prepareProcessInvocation`. Preparation
may resolve and materialize ASP-owned inputs but never starts a native command or
applies input. Direct preparation preserves the existing placement builder result
and adds mandatory structured system/priming content plus the serving release.
The Desktop preparation ops (`aspc.resolveDesktopIdentity`,
`aspc.admitDesktopRegistration`, `aspc.prepareDesktopObserver`) were retired
from the RPC surface by T-08594: a Codex Desktop thread joins HRC itself through
`harness-broker desktop-join` (hook-started, participant-served), and the
compiler functions stay as the in-process library behind that flow.

The thin Unix client refuses a missing advertised operation before sending it.
An aspd node must be configured and ready before consumers migrate to these
operations; consumers retain committed control and durable reattach, while a new
hook-driven registration is pending when the producer is unavailable. Release
binding selects the explicit `codex-app-server` worker for Desktop observer
hosting. It never guesses a first worker or PATH executable, and it does not
claim that the worker's other hosted drivers advertise `codex-desktop`.

### Pilot limitations

- The client still builds the existing `RuntimeCompileRequest` (placement roots,
  requested harness/interaction mode, policy, identity/correlation). Runtime
  intent input redesign is deferred.
- The broker does not itself refuse a start whose payload came from another
  release; the client's pre-launch and handshake checks enforce the binding.
- No durable start receipt / lost-reply retry on this path (above).
- Binding-aware producer support includes headless/interactive Codex,
  `claude-code-tmux`, and `pi-tui-tmux`. `pi-sdk` is deliberately unbound after
  its compiled worker failed the release closure gate on build-host paths from
  transitive `@silvia-odwyer/photon-node` and `esbuild`; T-08562 must keep it off
  the aspd route or refuse it explicitly. HRC route migration and its
  positive-evidence admission rule are separate consumer work (T-08562).
- `codex-cli-tmux` remains registered and deprecated, with no release binding;
  `codex-desktop` and `arris-resident` are not newly bound here.

### Pilot acceptance plan

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
8. For every binding-aware worker, inspect `drivers --json`, assert the selected
   driver appears in `hostedDrivers`, and prove worker/helper argv stays under
   the immutable release. Verify the release statusline digest equals the
   bundle copy and an unbound selected driver receives
   `release_worker_driver_unavailable` with no worker, pane, or native process.
9. Activate a retained pre-binding release and complete a Codex rollback turn
   with `hostedDrivers` absent; do not claim or launch a legacy non-Codex route.

### Pilot evidence layout

T-08539 retains its installed acceptance under
`var/wrkq-artifacts/T-08539/` (outside every checkout): `releases-build/` (built
A/B artifacts), `ns/` (the isolated service namespace with installed releases,
activation history and daemon logs), `client/` (the fixed pilot client artifact
and its closure manifest), `ev/` (scenario record, client state: preparations,
hosting intents, bindings, worker hellos, start outcomes, turn events) and
`gates/` (verify, matrix smoke, build outputs).
