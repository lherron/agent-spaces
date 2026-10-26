# aspd Rust front door

Status: r1, 2026-10-26, draft for Daedalus review. Owner mable@agent-spaces:primary. Campaign P-00890. Lance directed this on 2026-10-26: implement in Rust the known-live aspc endpoints that Rust HRC calls, using HRC's front-door pattern (hrc-runtime `docs/proposals/hrc-rust-parity.md`, F package). Lance delegated decisions within that scope to Mable. Go-live on each node is coordinated with mable@hrc-runtime.

This replaces the August raspc plan (`agent-spaces.raspc-migration-contract`, held 2026-08-21). That plan's byte-oracle corpus, three-host reproducibility gate and repo split are not carried forward. Its four dormant drafts (T-07307, T-07311, T-07312, T-07434) close as superseded.

## Scope: the endpoints Rust HRC calls

aspd serves 11 `aspc.*` methods plus `health`, `version` and `surface`. Retained request logs across max3, svc and hrcdev (2026-10-08 → 10-26) show traffic on five methods only:

| Method | Share of traffic | Caller |
|---|---|---|
| `aspc.hello` | ~55% (sent before every call) | every client |
| `aspc.resolveRuntimeDeclaration` | ~33% | HRC, both Bun and Rust |
| `aspc.observeContinuationArtifact` | ~12% | HRC, both Bun and Rust |
| `aspc.compileHarnessInvocation` | ~0.2%, but it is the birth path | HRC, both Bun and Rust |
| `aspc.inspectRuntimePlacement` | rare, max3 only | Bun HRC only |

Rust HRC calls `hello`, `compileHarnessInvocation`, `resolveRuntimeDeclaration` and `observeContinuationArtifact` (hrc-runtime `crates/hrc-native` `aspc.rs`, `compile.rs`, `runtime_views.rs`). mable@hrc-runtime confirms the list and its request shapes (P-00890 room). Those four, plus `health`/`version`/`surface`, are the native set. HRC's N4 adds `aspc.inspectRuntimePlacement` (POST /v1/previews/run; reads `ok` and `prompt`) and `aspc.observeRuntimeCapability` (federation summon; reads `ok`, `{credentials,nativeRuntime,preparation,registration}.{code,state}`, `diagnostics` and `failure.message`). Both stay forwarded and working until rusthrc calls them, then join the next open package. Every response field Bun HRC reads today stays byte-compatible, because rusthrc mirrors Bun (mable@hrc-runtime:primary-comet, P-00890 room). Every other method stays Bun and is forwarded verbatim. The list is re-read before each package grade. A method that Rust HRC starts calling joins the next open package.

Compile scope is set by data, not by guesswork. D0 (T-11824, T-11825) records exact per-minute counts for 36 code-path markers in the compile engine: recipe, harness source, cache and bundle reuse, materialization kinds, continuation formats, and suspected-dead compat branches. A compile branch is native only if its marker shows live use. Rust classifies each `compileHarnessInvocation` before it writes anything. A request that needs a branch Rust does not implement is forwarded whole to Bun.

## Why aspd is simpler than HRC

HRC needs a single execution owner per node because its claims, broker control and event wakeups live in process memory. aspd has none of that. Its only process-local state is harness-detection caches and counters, which can be rebuilt. Every durable write goes to ASP_HOME, and the asp CLI, ACP's in-process compiler and aspd already write ASP_HOME concurrently today:

- The plugin cache and bundle `.versions` are content-addressed, staged and renamed under proper-lockfile locks in `tmp/locks`.
- The codex runtime home is fingerprint-gated, under `.asp-runtime.lock`.
- Snapshots and system-prompt artifacts are content-addressed.

So Rust and Bun can both serve natively on one node, provided Rust uses the same lock protocol and the same content addressing. There is no ownership flip. A node moves forward by installing a release whose native set is larger.

Two existing Bun races become more likely with a second writer implementation, and they are fixed in Bun first (R0):

1. `global-lock.json` is read, merged and written with no lock (`materialize-refs.ts:174-215`).
2. The snapshot staging directory is named `snapshot-${Date.now()}` (`store/snapshot.ts:101-123`).

## Cardo kernel

Lance directed on 2026-10-26 that raspd includes a cardo kernel, as HRC includes `hrc-kernel`. The kernel is an observation surface beside the request path, not under it:

- The aspc request path is plain Rust: a tokio listener, the frame codec, native handlers and forwarding. It never goes through cardo's owner thread, so a slow compile can't stall the kernel and the kernel can't stall a request.
- raspd embeds a kernel in the one style cardo supports (`~/praesidium/cardo/docs/cardo-embedding-guide.md`; foundry is the worked example). Cardo is pinned by git rev, every crate at one rev, in the agent-spaces workspace. An `aspd-domain` crate holds the domain and declarations, and the binary composes `RuntimeOwner` and serves cardo wire on its own socket, `var/aspd/run/raspd-kernel.sock`.
- The domain is aspd's service state, fed from raspd's own events in the way hrc-kernel is API-fed: the serving release (`releaseId`, `sourceCommit`), front-door role and Bun upstream health, per-op counts split native vs forwarded, and recent compiles (`compileId`, `planHash`, recipe, outcome, duration). There is no request content and nothing L5 forbids.
- Its gate is cardo's own wire conformance suite (`conformance/wire_suite.py`) passing against the installed raspd kernel socket, the same way foundry runs `just wire-conformance`.

## Topology

`raspd` binds the node's public `var/aspd/run/aspd.sock`. Bun aspd binds `var/aspd/run/aspd-bun.sock` in the same namespace and keeps the same ASP_HOME. Clients don't change: HRC's `HRC_ASPD_SOCKET`, `avs` and the scripts still name `aspd.sock`. Methods carry no per-connection state (hello is an ordinary method), so raspd routes each frame on its own. It answers native methods itself and relays everything else to Bun over an upstream connection tied to the client connection, preserving order and ids.

raspd enforces the same frame rules as Bun (T-11728): a 16 MiB limit, immediate refusal of empty frames, and the same `data.reason`/`advice` refusal envelopes.

**Release.** raspd is built into the aspd release next to the four Bun binaries (`scripts/asp-release.ts`). Activation installs both together, and `release.json` names both. svc and hrcdev pick it up through the existing aspd deploy paths. Brokers keep running from the release's Bun harness-broker. `executionRelease.worker` in compile responses still names that release's broker, so Rust reads it from the same `release.json`.

**Service roles.** These follow hrc-runtime's `front-door-enable/disable/status` recipes. A fronted node runs launchd `com.praesidium.raspd` (public socket) and `com.praesidium.aspd` (private socket). Bun's listen socket is set by the role, not by a flag. Rollback is `front-door-disable`: stop raspd, and Bun takes the public socket back. No HRC restart is needed; HRC reconnects each call.

**Access logging.** raspd logs every request it receives:
- L3 `rpc.request` lines in `var/logs/agent-spaces/raspd.log` (L2 JSON, listener `raspd`).
- Rows in `var/state/agent-spaces/metrics/raspd-<day>.ndjson`, in T-11824's aspd row schema plus `servedBy: native|bun`.

Bun keeps logging what it receives in its own files, unchanged. The two never share a file. Per op and per hour, raspd's `servedBy: bun` count equals Bun's count, exactly, because both are unsampled per-minute aggregates. The usage audit counts raspd's file as a fronted node's request population and never sums the two. Foundry validates these files against the fitkit logging standard, as it did for D0.

## Packages

Clod task seats implement each package. Mable grades from runner artifacts and git. Daedalus reviews this plan once, and a package design only when it departs from this plan.

| Package | Delivers | Closes when (each a real workflow on isolated scratch) |
|---|---|---|
| **R0 Ground** | The two Bun race fixes above. A socket-parameterized compare runner that drives one case set against two aspd subjects on cloned scratch namespaces and ASP_HOMEs, and diffs responses and materialized trees case by case. It reuses T-11825's deterministic tree harness and T-11824's release E2E. Volatile fields (timestamps, uuids, pids, release ids) are an enumerated mask in the runner. Plan hashes, fingerprints and worker paths are never masked. | (1) Bun vs Bun passes on every case. (2) A deliberately altered subject fails it. (3) Concurrent Bun compiles on one ASP_HOME leave `global-lock.json` with every merged entry. |
| **R1 Front door** | An agent-spaces Cargo workspace: the `raspd` binary and an `aspd-domain` crate for the embedded cardo kernel, the aspc listener, the frame codec, native `hello`/`health`/`version`/`surface`, verbatim forwarding, access logging, release build integration, service roles and front-door recipes. Native `hello` matches rusthrc's admission (hrc-runtime `aspc.rs:66-168`): `protocolVersion` `aspc/0.1`, a `capabilities` flag for EVERY method including forwarded ones, `transports` containing `unix-jsonrpc-ndjson`, and `release.{releaseId,sourceCommit,builtAt}` as strings from `release.json`. | (1) On scratch, unchanged HRC TS `AspcUnixClient`, rusthrc's `AspSession`, and `avs` all work through raspd: native answers natively, everything else is forwarded. (2) The two logs reconcile exactly per op and per minute, and no file is written by both. (3) Rollback restores Bun on the public socket with clients unaffected. (4) `version` reports raspd's own source commit, so a proxy cannot pass. (5) Concurrent in-flight requests, including a slow forwarded compile, never stall a native `hello` or `health`. (6) cardo's wire suite passes against raspd's kernel socket, and its document shows the serving release and the native vs forwarded counts. |
| **R2 Native reads** | `resolveRuntimeDeclaration` and `observeContinuationArtifact` in Rust: agent roots, profile and targets resolution, codex and claude session lookup. Both are read-only. | (1) The compare runner matches Bun on every R2 case, including the refusal codes (`agent_not_found`, `*_invalid`) and the not-found continuation tail. (2) A real Bun `hrc` and rusthrc on scratch resolve and observe through raspd. |
| **R3 Native compile** | `compileHarnessInvocation` for the branches D0 shows live: resolution, lock and snapshot, plugin cache, bundles, codex home and prompt artifacts under the shared lock protocol, plus harness emission for the live recipes. Pre-classification forwards everything else. This splits by family (R3a resolution and lock, R3b materialization, R3c harness emission) if it's large. | (1) The compare runner matches Bun, byte for byte under the mask, on every live recipe. (2) A real `hrc start` on scratch births a seat from a Rust compile, through both Bun hrc and rusthrc. (3) A Bun asp CLI compile and a Rust compile racing on one ASP_HOME both succeed and leave a consistent store. (4) A request needing an unimplemented branch is forwarded before any write. |
| **R4 Go-live** | Per-node rollout hrcdev → svc → max3. Stage A: front door with native hello/health/version/surface. Stage B: R2. Stage C: R3. Each stage is a release install; there are no switches. **One change per node at a time:** a node's aspd cutover never overlaps that node's HRC F enable, its 24h fronted window or its N6 flip. Each cutover is announced in hrc-runtime/rust-native-parity before it runs, and agreed with mable@hrc-runtime. Any HRC restart is run by mable@hrc-runtime:primary. None is expected, because HRC_ASPD_SOCKET is unchanged and HRC reconnects per call. | Each node, each stage: install; `front-door-status`; raspd and Bun logs reconcile; then HRC's smoke: (1) `hrc server status --json` shows `.api.aspd.reachable == true` with raspd's release id, (2) a cold `hrc start -p` of a blank tabularasa seat on a scratch project plus a second turn, (3) `hrc runtime list` agrees, then terminate. Once HRC N1 is graded, the same birth also goes through `rusthrc server`. A 24h soak on hrcdev precedes svc and max3. Rollback is rehearsed once on hrcdev. |

The critical path is R0 → R1 → R2 → R3 → R4. R0 and R1 run in parallel. R4 stage A can go live once R1 closes, while R2 and R3 continue.

## Semantics

Bun owns the semantics. Rust reproduces current Bun behaviour, including known defects. A defect is fixed in Bun first, and Rust follows in the same landing. The T-11825 defects (harness not forwarded to `materializeTarget`, the git-pinned codex closure throw, the stale `hooks.state` key, the per-compile registry fetch) stay as they are until the D0 window closes. Each fix is then made in both implementations together.

## Explicitly unsupported

These are never gates:

- Methods Rust HRC does not call. They are forwarded to Bun indefinitely.
- The asp CLI, ACP's in-process compiler, `aspc` CLI and `aspc-facade` stdio. They stay Bun.
- harness-broker. It stays Bun and ships in the same release.
- A Rust port of compile branches with no live use in D0. They are forwarded.
- Mechanism races no product path exhibits, and fallback to any other Bun release.
- Fixed latency budgets. R2 and R3 record latency against Bun for Mable to judge.
- Frozen inventories, source-hash pins and SHA receipts.

## Authority

Lance delegated decisions within this scope to Mable (2026-10-26). Installs and service changes follow the Mable-primary doctrine. Each R4 node step is agreed with mable@hrc-runtime before it runs. This plan authorizes no fleet change before R1 closes.
