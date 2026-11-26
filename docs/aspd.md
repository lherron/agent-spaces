# aspd: v2 ASP compilation and release hosting

## Current v2 contract

`aspd` serves the producer-owned ordinary compilation boundary from an immutable
ASP release. Its sole public ordinary compile RPC is
`aspc.compileHarnessInvocation`, accepting only
`schemaVersion: "agent-runtime-compile-request/v2"`. The request has a closed
selection vocabulary — `agent-harness`, `claude`, `claude-hrcpty`, `codex`,
`codex-hrcpty`, and `muse` — plus
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
`agent-spaces.aspd-release-worker-hosting`. The completed selection design is
preserved as attachment `ATT-00425` on T-08699; retrieve it with
`wrkq attach get ATT-00425`. Current selection vocabulary and defaults are
defined by the [compiler catalog](../compiler/agent-spaces/src/harness-selection/catalog.ts).

## Current service operations

`aspd` requires an explicit namespace for each status or lifecycle operation.
Use the Justfile service recipes before reaching for `pgrep`, `launchctl`, or
broad filesystem searches.

```bash
just aspd-status <absolute-namespace>
just aspd-start <absolute-namespace>
just aspd-stop <absolute-namespace>
just aspd-restart <absolute-namespace>
```

The namespace layout, log format and lifecycle recipes below remain implemented
by `scripts/aspd-service.ts` and `harness/aspc-facade/src/aspd.ts`; the pilot
protocol and acceptance sections describe historical evidence. Current read and
preparation methods are registered in `harness/aspc/src/registration.ts`.

HRC's native client (`AspSession`, hrc-runtime
`crates/hrc-native/src/server/placement/aspc.rs`) uses `HRC_ASPD_SOCKET`: each
preparation connects, negotiates `aspc.hello`, compiles once, and closes. A
connection that compiles has a 120-second deadline, a read-only one 60 seconds.
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

`raspd` (`crates/raspd`, law `architecture/records/invariants/agent-spaces.aspd-rust-front-door.yaml`) is
aspd's Rust front door. Each release carries it beside the Bun binaries
(`<release>/raspd`, payload `libexec/raspd`, `runtimeClosure: "cargo-native"`).
`scripts/asp-release.ts` builds it with `cargo build --release --locked` on the
building node, so a node that builds releases needs cargo, as for hrc-runtime.

A fronted namespace runs raspd on the public `<ns>/run/aspd.sock` and Bun aspd on
`<ns>/run/aspd-bun.sock`, with one ASP_HOME. raspd answers `aspc.hello`,
`health`, `version` and `surface` itself. `version` adds `frontDoor`
(`{name: "raspd", sourceCommit, role, native, upstream, upstreamState}`), and
`health` lists `upstream_unavailable` in `degraded` after a failed relay.
Supported read, compile and inspection requests are also native. An input whose
disposition permits forwarding goes to Bun verbatim on an upstream connection
tied to the client connection; explicit refusals remain local. Discovery reports
the refused operations as described below. raspd also enforces Bun's frame rules itself: 16 MiB,
empty-frame refusal, and parse-error envelopes. When Bun can't be reached, or
closes before replying, a forwarded request gets JSON-RPC `-32603` with
`data.reason: "upstream_unavailable"`.

### Sole mode (T-13018)

`raspd serve` without `--upstream` is sole mode: there is no Bun behind it.
Every request raspd cannot answer natively is answered from its disposition
table, `crates/raspd/dispositions.json` (one row per forward reason, generated
from the T-13008 forward inventory with the T-13018 r2 overrides). A `refuse`
row returns Bun's envelope and code for that input (the message is raspd's); an
`impossible` row returns `-32603` and logs `raspd.defect`; a `native` row a
later slice will answer natively refuses with its placeholder reply until then.
A forward reason needs a row to compile (`reason!`). In sole mode `version`
reports `frontDoor.role: "sole"` with no `upstream` fields, and `health` never
lists `upstream_unavailable`. A panic answers `-32603`, and a global-lock.json
that fails Bun's lock schema refuses, in both modes. The log line for a
refusal is `native.refused` (event) and `rpc.request` with `servedBy: native`,
`relay: refused` and `fallback: <reason>`.

`bun scripts/raspd-sole/table-e2e.ts --raspd <binary>` checks the table end to
end on scratch (run by `cargo test`, so by `just verify`).

raspd writes only its own files. `rpc.request` goes to `<logDir>/raspd.log`
(`listener: "raspd"`, plus `servedBy: native|bun` and, for Bun,
`relay: relayed|upstream_failed`), with the supervisor's stderr in
`raspd.err.log`. Metrics go to `<var>/state/agent-spaces/metrics/raspd-<day>.ndjson`,
in the T-11824 row format with the same two keys added. Over a drained window,
per op, `relayed <= Bun's count <= relayed + upstream_failed`. Its cardo
kernel serves protocol 3 and the observation graph `aspd` on
`<ns>/run/raspd-kernel.sock` (`graph.inspect {graph: "aspd"}`):
service and release, Bun upstream health, per-op native, relayed and
upstream_failed counts, and the recent compiles. That kernel is never on the
request path. It registers as the cardo app `aspd`; the unnamed instance at
cardo's standard root is addressed as `cardo aspd …`. Private kernels can set
`--kernel-root <absolute-path>` and `--kernel-instance <name>`; the existing
`--kernel-socket` path is unchanged. `kernel.stop` refuses `stop_unsupported`
with the namespace stop recipe; SIGTERM or SIGINT retires both surfaces.

### Roles: direct, fronted, sole

A namespace has one of three roles, recorded in `<ns>/service/config.json`.
`status` (`role`) and `front-door-status` (`mode`) both name it.

| role | `config.frontDoor` | public `aspd.sock` | `aspd-bun.sock` |
| --- | --- | --- | --- |
| direct | absent | Bun aspd | absent |
| fronted | `{bunSocketPath, label}` | raspd `--upstream aspd-bun.sock` | Bun aspd |
| sole | `{bunSocketPath, label, sole: true}` | raspd, no `--upstream` | absent, and no Bun process or job |

In sole, `bunSocketPath` is where `front-door-enable` puts Bun back. The role
belongs to the namespace, not the release: every verb keeps the role it finds.
`start`, `stop` and `restart` act on both processes when fronted and on raspd
alone when sole. `activate` stops raspd, selects, and starts raspd last on the
new release; when sole it never starts Bun. `supervise` hands raspd its own
launchd job when fronted or sole (and Bun its job when direct or fronted).

```bash
just aspd-front-door-enable  <absolute-ns> [label]   # direct -> fronted, or sole -> fronted
just aspd-sole-enable        <absolute-ns>           # fronted -> sole
just aspd-front-door-status  <absolute-ns>
just aspd-front-door-disable <absolute-ns>           # fronted -> direct; refuses from sole
```

`aspd-sole-enable` is entered only from fronted (never direct to sole in one
step). It stops raspd and Bun, removes `aspd-bun.sock` and, under supervision,
Bun's launchd job and plist, records `sole: true`, and starts raspd without
`--upstream`. It fails unless no Bun aspd process belongs to the namespace and
`aspd-bun.sock` is gone afterwards. `aspd-front-door-enable` on a sole
namespace starts Bun aspd from the active release on `aspd-bun.sock` (its
launchd job back when supervised) while sole raspd still serves, then restarts
raspd with `--upstream`. `aspd-front-door-disable` on a sole namespace refuses:
run `aspd-front-door-enable` first.

A release declares sole support with the release capability `raspd.sole/v1`
in `release.json` (`asp-release inspect` reports it under `capabilities`).
Releases built from this change on carry it. A raspd older than sole mode reads
a missing `--upstream` as `<run>/aspd-bun.sock`, so it is never started without
one: `aspd-sole-enable`, and `aspd-activate` in a sole namespace, refuse a
release without the capability before stopping anything, and `startRaspd`
refuses it in a sole namespace whatever verb asks.

Rollback from sole is `aspd-front-door-enable` on the active release: the same
raspd, forwarding the refuse rows to Bun again. If the release itself is at
fault, `aspd-activate` of the previous release follows, as in any fronted
namespace. Every release serves either role until all three nodes have run
sole for seven days (T-13018 section 4); switching a real node is mable's.

Under launchd supervision, raspd is its own job (default label
`com.praesidium.raspd`, script `<ns>/service/raspd-launchd-run.sh`). Clients are
unchanged, and no HRC restart is needed. Go-live on a real node is plan R4. The
scratch proofs are `bun scripts/raspd-front-door-e2e.ts` (direct, fronted and
back; artifacts under `var/wrkq-artifacts/T-11835/e2e/`) and
`bun scripts/raspd-sole-role-e2e.ts` (fronted, sole and back, unsupervised;
artifacts under `var/wrkq-artifacts/T-13055/e2e/`).
`bun scripts/raspd-sole-supervised-e2e.ts --release <artifact> --out <evidence>`
walks scratch launchd supervision, fronted-to-supervised, sole activation,
crash recovery, restart and rollback. It records `launchctl print` beside each
step and always unloads its randomly named scratch jobs and removes their plists.
The release smoke and real HRC births are recorded under
`var/wrkq-artifacts/T-13057/README.md` (including the rerun scripts).
