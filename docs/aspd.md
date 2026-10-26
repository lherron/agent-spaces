# aspd: v2 ASP compilation and release hosting

## Current v2 contract

`aspd` serves the producer-owned ordinary compilation boundary from an immutable
ASP release. Its sole public ordinary compile RPC is
`aspc.compileHarnessInvocation`, accepting only
`schemaVersion: "agent-runtime-compile-request/v2"`. The request has a closed
selection vocabulary — `agent-harness`, `claude`, `codex`, and `muse` — plus
independent `modelProvider`, `model`, `reasoningEffort`, and boolean
`presentation` inputs. The default harness is `agent-harness` and the default
presentation is `true`.

On a main checkout with the system namespace at `../var/aspd` configured,
`just install` builds and installs a new immutable release, activates it on
the system socket, and checks that the running service reports the checkout's
source commit. Any seat may run this install from the main checkout, including the activation
(Lance ruling 2026-10-01). Standalone `aspd-activate` and `aspd-restart` stay with
Mable primary. Worktree installs leave the system service alone. The
explicit namespace recipes below remain available for isolated deployments.

ASPC validates the envelope and invokes the compiler; it owns no route catalog,
profile selector, or driver selector. The compiler catalog is the sole authority
that resolves harness and presentation to a recipe, frozen driver, transport,
terminal requirement, and hosting requirement. A provider or model never
chooses a harness. A true presentation request resolves to a fulfilling recipe
or a typed refusal; it is never silently downgraded.

Every successful ordinary response contains one `plan.execution` and one
canonical start request at `plan.execution.dispatchRequest.startRequest`. The selected v2
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

## Current service operations

The namespace layout, log format and lifecycle recipes below remain implemented
by `scripts/aspd-service.ts` and `harness/aspc-facade/src/aspd.ts`; the pilot
protocol and acceptance sections describe historical evidence. Current read and
preparation methods are registered in `harness/aspc/src/registration.ts`.

HRC's `packages/hrc-server/src/agent-spaces-adapter/aspd-preparation-client.ts`
uses `HRC_ASPD_SOCKET`: each preparation connects, negotiates `aspc.hello`,
compiles once, and closes. Requests after hello have a 120-second deadline.
It does not retry a compile or fall back to a bundled compiler. The launchd
bootstrap retries below concern service loading, not RPC or invocation replay.

A namespace starts unsupervised. To hand a selected namespace to a per-user
launchd job, the service script exposes
`bun scripts/aspd-service.ts supervise <absolute-ns> <label>` (there is no
`just aspd-supervise` recipe). This retires an unsupervised daemon before loading
the job, writes `~/Library/LaunchAgents/<label>.plist` and
`<ns>/service/launchd-run.sh`, and persists `config.supervisor`. Shared service
mutation remains Mable primary's responsibility.

Logs go to `config.logDir`, default `<ns>/logs`.
`bun scripts/aspd-service.ts log-dir <absolute-ns> <absolute-dir>` records it and
changes nothing else: the running daemon keeps its open files. The next
activation applies it, because every load of a supervised job regenerates and
re-adopts the plist and launch script from the config. `just install` on main
records `~/praesidium/var/logs/agent-spaces` (logging.md L1) for the system
namespace before it activates. A `restart` alone re-execs the launch script onto
the new paths but leaves launchd's `StandardOutPath` on the loaded plist.

When available on PATH, `praesidium-adopt` adopts the plist; adoption failure
aborts the operation. Every unloaded-job start re-adopts before bootstrap.
Bootstrap retries only exit status 5 or output matching `5: Input/output error`,
with at most four attempts separated by two seconds. Other failures stop
immediately. The same start/stop/restart/activate verbs then use launchd:
activation bootouts and waits for the old process before selecting and
bootstrapping the new release; restart uses `kickstart -k` and verifies a new
PID and serving identity. A stopped job stays unloaded until started again.

`just aspd-status <absolute-ns>` is read-only. Check `runningProcess`,
`serving.release` and `runningEqualsSelected`; installed releases and a selected
release alone do not establish that a daemon is serving. With supervision,
status also reports `supervisor` and `launchdPid`. The running record names
`logPath` (supervisor output) and `requestLogPath` (request log). An unsupervised
start instead captures stderr in
`<logDir>/aspd-<releaseId>-<timestamp>.log`.

## Front door: raspd (T-11835)

`raspd` (`crates/raspd`, plan `docs/proposals/aspd-rust-front-door.md`) is
aspd's Rust front door. Each release carries it beside the Bun binaries
(`<release>/raspd`, payload `libexec/raspd`, `runtimeClosure: "cargo-native"`).
`scripts/asp-release.ts` builds it with `cargo build --release --locked` on the
building node, so a node that builds releases needs cargo, as for hrc-runtime.

A fronted namespace runs raspd on the public `<ns>/run/aspd.sock` and Bun aspd on
`<ns>/run/aspd-bun.sock`, with one ASP_HOME. raspd answers `aspc.hello`,
`health`, `version` and `surface` itself, byte for byte as Bun would from the
same release. The exceptions: `version` adds `frontDoor`
(`{name: "raspd", sourceCommit, role, native, upstream, upstreamState}`), and
`health` lists `upstream_unavailable` in `degraded` after a failed relay.
Every other frame goes to Bun verbatim on an upstream connection tied to the
client connection. raspd also enforces Bun's frame rules itself: 16 MiB,
empty-frame refusal, and parse-error envelopes. When Bun can't be reached, or
closes before replying, a forwarded request gets JSON-RPC `-32603` with
`data.reason: "upstream_unavailable"`.

raspd writes only its own files. `rpc.request` goes to `<logDir>/raspd.log`
(`listener: "raspd"`, plus `servedBy: native|bun` and, for Bun,
`relay: relayed|upstream_failed`), with the supervisor's stderr in
`raspd.err.log`. Metrics go to `<var>/state/agent-spaces/metrics/raspd-<day>.ndjson`,
in the T-11824 row format with the same two keys added. Over a drained window,
per op, `relayed <= Bun's count <= relayed + upstream_failed`. Its cardo
kernel serves the observation document `aspd` on `<ns>/run/raspd-kernel.sock`:
service and release, Bun upstream health, per-op native, relayed and
upstream_failed counts, and the recent compiles. That kernel is never on the
request path.

The role lives in `config.frontDoor`, and the lifecycle verbs act on both
processes:

```bash
just aspd-front-door-enable  <absolute-ns> [label]   # Bun -> aspd-bun.sock, raspd -> aspd.sock
just aspd-front-door-status  <absolute-ns>
just aspd-front-door-disable <absolute-ns>           # rollback: raspd stops, Bun takes aspd.sock back
```

Under launchd supervision, raspd is its own job (default label
`com.praesidium.raspd`, script `<ns>/service/raspd-launchd-run.sh`). Clients are
unchanged, and no HRC restart is needed. Go-live on a real node is plan R4. The
scratch proof is `bun scripts/raspd-front-door-e2e.ts`, with artifacts under
`var/wrkq-artifacts/T-11835/e2e/`.

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
<logDir>/                       aspd.log (request log) + aspd.err.log (supervisor)
                                (logDir: config.logDir, default <ns>/logs)
```

#### Logs

Every line aspd writes, to either file, is one L2 JSON object
(`references/logging.md`): `{ts, level, component, event, data}`, `level` one of
`debug|info|warn|error`, `data` omitted when empty. Under launchd,
`aspd serve --socket <p> --log <logDir>/aspd.log` writes its own log: lines are
buffered and appended asynchronously (250 ms) and flushed on retire/exit.
`aspd.err.log` (the supervisor's stdout/stderr) carries only the
`aspd.serving`/`aspd.exit`/`aspd.fatal` lifecycle lines (also written to
`aspd.log`; `aspd.fatal` covers startup failures and uncaught errors) and an
`aspd.usage` refusal. aspd does not rotate either file: every write opens or holds it
with `O_APPEND` (the request log appends per flush; the launch script reopens
stdout/stderr with `>>`), so the collective copytruncate job (L4,
`com.praesidium.log-rotation`) rotates both without leaving an offset gap.
Without `--log` (spawn-mode `start`), everything goes to stderr, captured in the
timestamped log described above.

| Event | Component | When | `data` |
| --- | --- | --- | --- |
| `request.answered` | `rpc` | every registered `aspc.*` method request, after its reply is written | `conn`, `id`, `method`, `startedAt`, `durationMs`, `outcome` (`ok` \| `rejected:<code>` \| `error:<code>`), `replyBytes` (when available), `error` (when available), correlation, `phases` (compile only) |
| `request.admitted` | `rpc` | compile and prepare only | `conn`, `id`, `method`, `startedAt`, correlation |
| `request.slow` (`warn`) | `rpc` | still in flight after 2 s | `elapsedMs`, `slowRequestMs`, correlation; the answered line is also `warn` |
| `request.refused-retiring` (`warn`) | `rpc` | a frame dispatched after retirement began | `conn`, `id`, `method` |
| `rpc.observe-failed` (`error`) | `rpc` | the request-line observer threw | `message` |
| `retire.begin` / `retire.drained` | `aspd` | retirement | `inFlight`, `connections` |
| `aspd.serving` / `aspd.exit` / `aspd.fatal` | `aspd` | lifecycle (also on stderr) | `release`, `sourceCommit`, `socket`, `pid`, `log` / `release` / `error` |
| `aspd.usage` (`error`) | `aspd` | refused invocation, stderr only | `usage`, `args` |
| `log.dropped` / `log.write_failed` | `log` | buffer overflow / append failure | `lines` / `path`, `error` |

The same log carries the L3 transport events: `rpc.listen` announces
`listener: "aspd"` and its socket address; one `rpc.request` at completion
carries `listener`, `op`, `client`, `outcome` and `durationMs`, including
unknown operations and malformed complete frames. Usage-metrics warnings are
`component: "metrics"` lines. The compiler writes nothing to stderr: compile
cost is `request.answered`'s `durationMs` and `phases` plus the `compile.entry`
path marker (T-11829 retired the always-on `[asp-timing]` stderr line).
No request or response bodies are included in the canonical request line.

For discovery, call `avs aspc <socket> surface`: it returns
`schemaVersion: "aspd-surface/v1"` and the actually registered operations with
summaries and stream declarations. `health` reports process health without
checking dependencies. `version` reports the serving build, interface version
and capabilities. All three accept no params or an empty object and reject
unknown keys. Existing compile operations retain their JSON-RPC numeric error
codes and result shapes. `AspcUnixClient` sets envelope attribution once for
every request: explicit host name/version, or its own library name/version when
the host supplies no version. The `avs aspc` sender identifies itself as `avs/1`.

Transport errors retain their JSON-RPC numeric `code`, `message` and structured
issues, with additive `error.data.reason` and `error.data.advice`. Unknown-op
advice points at `surface`. Domain `ok: false` diagnostic results stay unchanged.

aspd accepts at most **16 MiB (16,777,216 UTF-8 bytes)** per frame, excluding LF
(including CR for CRLF). It refuses an oversized frame immediately with `-32700`,
`reason: "frame_too_large"`, discards through its LF, then accepts the next frame
on the same connection. Empty LF or CRLF frames immediately return `-32700`,
`reason: "empty_frame"`. Each refusal has one canonical request line; undecodable
frames use `op: "unmatched"`, `client: "unknown"`. A 2 MiB hello remains accepted.
There is no server-side handler deadline or cancellation; clients bound calls.

The limit was selected from retained real compile requests (15 samples, largest
compact JSON-RPC envelope 2,723 bytes) and an actual v2 compile made with the
running HRC release's pinned client (977 bytes, compile successful). This leaves
substantial headroom; these are observed samples, not a bound on arbitrary future
prompts or attachments. Callers must keep each frame within the documented limit.
Reproducible measurements and caller compatibility evidence live under
`var/wrkq-artifacts/T-11728/{real-request-sizes,pinned-client-smoke}.json`.

Unknown methods are refused by the protocol server before the registered
handler, so they do not produce `request.answered` lines. Parameter validation
failures for registered methods do.

Correlation is read from request params, never required: `runtimeId`,
`traceId`, `invocationId` and `scopeRef` from `compileRequest.identity` on
compiles, `agentId` on runtime-declaration reads. `runtimeId` joins a compile to
HRC's `broker.timing {"phase":"precompile-compile-rpc","runtimeId":...}` line.
Compile `phases` (ms) are `resolve`, `build`, and inside build
`placement-context`, `temp-sweep`, `plan-runtime`, `harness-detect`,
`agent-local`, `materialize`, `system-prompt` (or `load-semantics` for native
agent-harness plans). Example:

```bash
rg '"runtimeId":"rt-…"' ~/praesidium/var/logs/agent-spaces/aspd.log ~/praesidium/var/logs/hrc-runtime/hrc-server.log
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
