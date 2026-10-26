# aspd Rust front door

Status: r3, 2026-10-26, revised for Daedalus REJECT F2/F3 second cycle (EN-35838, T-11832). F1 approved as design at r2.1. Owner mable@agent-spaces:primary. Campaign P-00890. Lance directed this on 2026-10-26: implement in Rust the known-live aspc endpoints that Rust HRC calls, using HRC's front-door pattern (hrc-runtime `docs/proposals/hrc-rust-parity.md`, F package). Lance delegated decisions within that scope to Mable. Go-live on each node is coordinated with mable@hrc-runtime.

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

Three existing Bun publication races become more likely with a second writer implementation. R0 fixes all three in Bun first, and Rust implements the same rules:

1. `global-lock.json` is read, merged and written with no lock (`materialize-refs.ts:174-215`). Fix: hold the merge under the shared lock protocol.
2. The snapshot staging directory is named `snapshot-${Date.now()}` (`store/snapshot.ts:101-123`). Fix: use a collision-free staging name.
3. **Final-path collision.** `createSnapshot` checks for the integrity path and then renames a staging directory into it. Two cold writers of the same immutable snapshot can both pass the check, and the second rename fails with `ENOTEMPTY`, which becomes `SnapshotError` (`snapshot.ts:91-130`). This is reached through `populateSnapshotsFromLock` (`install.ts:174-202`), which install, populateStore and materializeFromRefs all share, outside any merge lock. Fix: a rename that loses to an existing integrity directory is success. The path is content-addressed, so the existing integrity check applies. The loser removes its staging directory and continues.

The shared-writer premise holds once all three rules are in place. R0 proves it with two cold writers racing to publish the same snapshot.

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

Bun keeps logging what it receives in its own files, unchanged. The two never share a file. Each process buckets a request by its own completion time, so one request can land in different minutes on each side. Per-minute counts are therefore reported side by side, not reconciled. raspd records each forwarded request with an outcome: `relayed` (Bun answered) or `upstream_failed` (Bun was never reached, or did not answer). Reconciliation is per op over a closed window, once both processes have drained and flushed. **relayed ≤ Bun total ≤ relayed + upstream_failed.** Bun counts a request when it completes, even if the reply never reaches raspd (protocol-server.ts:83-85,150-167; aspd.ts:489-506). So an `upstream_failed` request may or may not appear in Bun's file. With no upstream failures, the bounds collapse to equality. A relayed request missing from Bun breaks the lower bound. A Bun request raspd never forwarded breaks the upper bound. The usage audit counts raspd's file as a fronted node's request population and never sums the two. Foundry validates these files against the fitkit logging standard, as it did for D0.

## Packages

Clod task seats implement each package. Mable grades from runner artifacts and git. Daedalus reviews this plan once, and a package design only when it departs from this plan.

| Package | Delivers | Closes when (each a real workflow on isolated scratch) |
|---|---|---|
| **R0 Ground** | The three Bun publication fixes above. A socket-parameterized compare runner. Comparison identity: both subjects run against the **same absolute scratch paths**, one after the other. The runner seeds the root, runs subject A, restores the identical seed at the same path, runs subject B, and diffs case by case (responses and materialized trees). Both subjects are served from **one release directory**, as in production, where raspd and Bun ship together, so `executionRelease` and the worker paths match by construction. Absolute paths are semantic inputs to planHash (`compile-plan-finalize.ts:316-344`) and to the codex fingerprints (`run-codex.ts:108-123`), so they are held equal, never masked. The **mask is measured**: two Bun runs at identical paths with nothing pinned. Every field that differs between them (compileId, createdAt, uuids, staging names) is enumerated in a committed mask file with that evidence. Nothing outside the measured set is masked. **Measured: planHash varies Bun vs Bun for fresh claude recipes** (T-11833). claude-adapter.ts:649 puts `--session-id <randomUUID()>` in the launch argv, and planHash, profileHash, compatibilityHash and startRequestHash all cover it. codex-tui is stable apart from createdAt. So derived hashes are **verified, never masked**, in two steps. **(a) Self-consistency.** For each subject, the runner recomputes every derived hash (planHash, profileHash, compatibilityHash, startRequestHash) from that subject's reported body, **as reported, with its actual uuid**, using ASP's canonical hasher (`contracts/spaces-runtime-contracts/src/hash.ts`). It asserts each one equals the hash the subject reported. **(b) Body equality.** Only after (a) passes on both sides does the runner replace each measured volatile input (that session uuid, and nothing unmeasured) with a token in both bodies, leave out the derived-hash fields already verified in (a), and diff A vs B. A wrong hash recipe fails (a). A wrong body fails (b). Since every derived hash is a verified function of a body that matches the other side's, the hashes are correct. Bun's session-id semantics are unchanged. | (1) Bun vs Bun passes on every case under the measured mask. (2) A deliberately altered subject fails, naming the case. (3) Concurrent Bun compiles on one ASP_HOME leave `global-lock.json` with every merged entry, red before the fix and green after. (4) Two processes cold-publishing the same snapshot concurrently both succeed, red before the fix and green after. |
| **R1 Front door** | An agent-spaces Cargo workspace: the `raspd` binary and an `aspd-domain` crate for the embedded cardo kernel, the aspc listener, the frame codec, native `hello`/`health`/`version`/`surface`, verbatim forwarding, access logging, release build integration, service roles and front-door recipes. Native `hello` matches rusthrc's admission (hrc-runtime `aspc.rs:66-168`): `protocolVersion` `aspc/0.1`, a `capabilities` flag for EVERY method including forwarded ones, `transports` containing `unix-jsonrpc-ndjson`, and `release.{releaseId,sourceCommit,builtAt}` as strings from `release.json`. | (1) On scratch, unchanged HRC TS `AspcUnixClient`, rusthrc's `AspSession`, and `avs` all work through raspd: native answers natively, everything else is forwarded. (2) After a drained run, per op, relayed ≤ Bun total ≤ relayed + upstream_failed, with equality on a run that has no upstream failures. With Bun stopped mid-run, the bounds hold and raspd records `upstream_failed`. Per-minute counts are reported, not gated. No file is written by both. (3) Rollback restores Bun on the public socket with clients unaffected. (4) `version` reports raspd's own source commit, so a proxy cannot pass. (5) Concurrent in-flight requests, including a slow forwarded compile, never stall a native `hello` or `health`. (6) cardo's wire suite passes against raspd's kernel socket, and its document shows the serving release and the native vs forwarded counts. |
| **R2 Native reads** | `resolveRuntimeDeclaration` and `observeContinuationArtifact` in Rust: agent roots, profile and targets resolution, codex and claude session lookup. Both are read-only. | (1) The compare runner matches Bun on every R2 case, including the refusal codes (`agent_not_found`, `*_invalid`) and the not-found continuation tail. (2) A real Bun `hrc` and rusthrc on scratch resolve and observe through raspd. |
| **R3 Native compile** | `compileHarnessInvocation` for the branches D0 shows live: resolution, lock and snapshot, plugin cache, bundles, codex home and prompt artifacts under the shared lock protocol, plus harness emission for the live recipes. Pre-classification forwards everything else. This splits by family (R3a resolution and lock, R3b materialization, R3c harness emission) if it's large. | (1) The compare runner matches Bun, byte for byte under the mask, on every live recipe. (2) A real `hrc start` on scratch births a seat from a Rust compile, through both Bun hrc and rusthrc. (3) A Bun asp CLI compile and a Rust compile racing on one ASP_HOME, including a cold publish of the same snapshot, both succeed and leave a consistent store. (4) A request needing an unimplemented branch is forwarded before any write. (5) The compare runner fully re-derives the codex runtime-home fingerprint and the muse-serve metadata fingerprint per side, using a recipe exported from Bun, as `derivePlanHashes` does for plan hashes. Until R3, those two fingerprints are checked for internal consistency (codex: `.asp-runtime.json` equals the managed-directory names and symlink targets) and tokenized as derived. R0 measured that both vary Bun vs Bun only through the bundle staging path (`tmp/.staging/bundle-…-<pid>-<uuid>`), which T-11825's held `hooks.state` defect bakes into codex `config.toml`, and which muse's fingerprint hashes as `skillsDir`. If that defect is fixed before R3, the fingerprints become stable and are byte-compared instead. |
| **R4 Go-live** | Per-node rollout hrcdev → svc → max3. **Amended 2026-10-26 (after R1-R3a graded): one cutover per node, not three stages.** The installed release already carries R1, R2 and R3a, so the only per-node act is `just aspd-front-door-enable`, which serves hello/health/version/surface, the R2 reads and the R3a claude-code compiles natively at once. Staging A to C would mean installing deliberately older releases. Every native path was already graded on scratch against live Bun: the compare runner fixture plus the 185-case live corpus, real births through Bun hrc and rusthrc, the mixed-writer race, and forward-before-write. Rollback is `just aspd-front-door-disable`, one command with no HRC restart. The 24h hrcdev soak, a rollback rehearsal on hrcdev, and per-node agreement with mable@hrc-runtime are unchanged. **One change per node at a time:** a node's aspd cutover never overlaps that node's HRC F enable, its 24h fronted window or its N6 flip. Each cutover is announced in hrc-runtime/rust-native-parity before it runs, and agreed with mable@hrc-runtime. Any HRC restart is run by mable@hrc-runtime:primary. None is expected, because HRC_ASPD_SOCKET is unchanged and HRC reconnects per call. | Each node, each stage: install; `front-door-status`; raspd and Bun per-op totals reconcile over the soak window (relayed ≤ Bun ≤ relayed + upstream_failed); then HRC's smoke: (1) `hrc server status --json` shows `.api.aspd.reachable == true` with raspd's release id, (2) a cold `hrc start -p` of a blank tabularasa seat on a scratch project plus a second turn, (3) `hrc runtime list` agrees, then terminate. Once HRC N1 is graded, the same birth also goes through `rusthrc server`. A 24h soak on hrcdev precedes svc and max3. Rollback is rehearsed once on hrcdev. |

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
