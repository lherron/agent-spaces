# 6. The aspd compile service

`aspd` serves the ASPC compile and inspection plane (`aspc/0.1`, NDJSON JSON-RPC over a Unix socket) from one
immutable release in an explicit namespace. HRC compiles every launch through it. Code: `scripts/aspd-service.ts`
(the verbs: init, start, stop, restart, supervise, activate, log-dir, status, front-door-*, sole-enable; Bun aspd, raspd, launchd
jobs and namespace records under `scripts/aspd-service/`), `harness/aspc-facade/src/aspd.ts`, methods and
validators in `contracts/aspc-protocol/src/{types,schemas,inspection-params}.ts`, the client
`spaces-aspc-protocol/unix-client`. Doc: `docs/aspd.md`.

## Sub-features

- Namespace layout: `releases/<releaseId>`, `bin/{aspd,raspd}` (the stable executables, below), `service/config.json`
  (plus `active.json`, `activations.ndjson`, and `launchd-run.sh`/`raspd-launchd-run.sh` once supervised),
  `run/aspd.sock`, `run/aspd.json` (the running record), `state/asp-home`, `logs/`. `aspd-init` writes the config (socket path, `ASP_HOME=<ns>/state/asp-home`, `inheritEnv` HOME PATH USER
  LOGNAME SHELL TMPDIR LANG) and no `supervisor`. The system namespace's config sets `ASP_HOME` to
  `var/spaces-repo` by hand, not the init default.
- `aspd-activate <ns> <releaseId>`: retire the running daemon, record the selection, start the release, and finish
  only when `aspc.hello` answers with that release's identity; it returns `{activation, beganAt, retired, started,
  completedAt, executableMode, retention}` plus `stableExecutables` in fixed mode and `raspdRetired`/`raspdStarted` when fronted. `aspd-start` (a second start returns `alreadyRunning`; a running release other than the selection
  refuses `activate instead`), `aspd-stop` (`{stopped: false, reason: "not running"}` when stopped), `aspd-restart`.
- `supervise <ns> <label>` (script only, no recipe) hands the namespace to launchd (the system namespace is
  `com.praesidium.aspd`): it writes `~/Library/LaunchAgents/<label>.plist` and `service/launchd-run.sh`, adopts the
  plist with `praesidium-adopt` (ProgramArguments start with `~/.local/bin/praesidium-launch`;
  `AssociatedBundleIdentifiers` `com.praesidium.AgentHost`), re-adopts before every bootstrap, and retries a
  bootstrap error 5 for up to 4 attempts in all, 2 s apart (`BOOTSTRAP_ATTEMPTS`, `aspd-service/launchd.ts:22-23`;
  T-10818). Both plists set `ProcessType` `Interactive` (9f963a91, T-12535; without it launchd ran the daemons at
  PRI 20). Then stop is `bootout`, restart `kickstart -k`.
- **Stable executables (T-12225, d6e8c923/c9f35e8f).** Activating a release whose `release.json` `capabilities` lists
  `aspd.fixed-executable-release-root/v1` (built at or after c9f35e8f) stops the daemons, copies
  `<release>/libexec/{aspd,raspd}` to `<ns>/bin/`, re-signs them `codesign -i com.praesidium.{aspd,raspd}` (ad hoc
  unless `config.codeSigningIdentity` or `PRAESIDIUM_CODE_SIGNING_IDENTITY`), and runs them as `serve --socket …
  --release-root <releasePath>`: `executableMode: "fixed"`. Any older release runs in place from its own launcher
  (`<release>/libexec/aspd serve --socket …`, no `--release-root`, no `executablePath`): `executableMode:
  "legacy-release"` and one `{"event":"stable-exec.legacy-fallback",…}` line in `activations.ndjson`. Rolling back to
  a pre-c9f35e8f release takes that path. The release top-level `aspd`/`raspd` are now small launcher scripts
  (`--release-info`, then `exec libexec/<name>`), so `cmp <release>/aspd <ns>/bin/aspd` always differs.
- **Release retention at activation (21f205f3, R-00600).** After a successful activation, `<ns>/releases` is pruned
  to the active release, the previous selection, the newest 3 by release-id timestamp, and any release whose path a
  running process names on its command line (`ps -Ao command`; `scripts/aspd-service/release-retention.ts`). The
  activation result's `retention` is `{kept, removed, inUse, failed}`, also in `activations.ndjson`; `aspd-status`
  does not show it. A failed `ps` removes nothing and never fails the activation. So a rollback reaches only releases
  retention kept, and any seat's `just install` prunes the system namespace: on 2026-11-08 it kept 8, all in use by
  long-lived seats' `harness-broker` processes, and 057de3dc (the last legacy system release) was gone.
- `aspd-status <ns>`: `namespace`, `socketPath`, `supervisor` and `launchdPid` (both null when unsupervised),
  installed releases, `selectedRelease`, `runningProcess` (with `executablePath` in fixed mode), `serving` (the live
  `aspc.hello` reply, or `{unavailable}`), `runningEqualsSelected`, `frontDoor` (`{mode: "direct", bunSocket,
  publicFrontDoor: null}` unfronted). It sends `aspc.hello` and `version`, so it adds `rpc.request` lines and usage
  rows on that daemon (on raspd's `raspd.log` when fronted). A relative namespace refuses `namespace must be absolute`; an
  uninitialized one `namespace not initialized: <ns>/service/config.json`, exit 1.
- Front door (raspd, P-00890): `just aspd-front-door-enable <ns> [label]` / `aspd-front-door-disable <ns>` /
  `aspd-front-door-status <ns>` (`aspd-service.ts front-door-*`). Enable needs a selected release containing `raspd`,
  moves Bun to `run/aspd-bun.sock`, starts raspd on `run/aspd.sock` (plus `run/raspd.json`, `run/raspd-kernel.sock`,
  `<logDir>/raspd{,.err}.log`) and records `frontDoor {bunSocketPath, label}` in the config; the label is used only
  when supervised. Status then reads `mode: "fronted"`, `bunAnswering`, `raspd.executablePath`, `raspdLaunchdPid`,
  `publicFrontDoor.native` (the 11 ops raspd answers itself: `aspc.hello`, `health`, `version`, `surface`,
  `catalogAgents`, `inspectAgent` (333d21e7, T-13054: never relayed), `resolveRuntimeDeclaration`,
  `observeRuntimeCapability`, `observeContinuationArtifact`, `compileHarnessInvocation`, `inspectRuntimePlacement`)
  and both releases; `raspd.log` lines carry `servedBy: native|bun` and `relay`. raspd refuses `catalogAgentInspection`,
  `inspectAgentSelection` (-32603 `AGENT_INSPECTION_PRODUCER_UNAVAILABLE`) and `prepareProcessInvocation` (-32601
  `op_unsupported`) itself in every role (`servedBy: native`, `relay: refused`; hello reports them false). Only unknown
  methods and compile fallbacks still reach Bun when fronted (`servedBy: bun`, `relay: relayed`). Disable stops raspd
  and puts Bun back on the public socket (`mode: "direct"`); it refuses while sole.
- **Roles: direct, fronted, sole (a7bc2bf7/a17fa694, T-13055/T-13039).** `status.role` and the activate result's
  `role` name it. `just aspd-sole-enable <ns>` (`aspd-service.ts sole-enable`) works only from fronted (from direct:
  `namespace is direct; run front-door-enable first, sole is entered from fronted`) and only on a release whose
  `capabilities` list `raspd.sole/v1` (every build since a7bc2bf7; older: `predates raspd sole mode (no raspd.sole/v1
  capability)`). It stops Bun and raspd and restarts raspd alone on `run/aspd.sock` with no upstream: `aspd-bun.sock`
  gone, `status.runningProcess` and `launchdPid` null, `frontDoor {mode: sole, bunSocketExists: false, bunJobLoaded:
  null}`, `version.frontDoor.role: sole`; an unknown method is refused natively (`op_unknown`, `relay: refused`). In
  sole, `start` reports `raspd.alreadyRunning`, `activate` of a pre-sole release refuses before anything stops, and
  `activate` of a sole release returns `raspdRetired`/`raspdStarted` with no `retired`/`started`.
  `front-door-enable` is the way back (`from: sole`); with a label other than the recorded one it refuses `… front-door-enable
  keeps it`.
- Methods: `aspc.hello`, `catalogAgents`, `inspectAgent`, `catalogAgentInspection`, `inspectAgentSelection`,
  `compileHarnessInvocation` (v2 requests only), `resolveRuntimeDeclaration`, `inspectRuntimePlacement`,
  `observeRuntimeCapability`, `observeContinuationArtifact`, `prepareProcessInvocation`. Refusals: `-32601 Method
  not found`, `-32602 Invalid params` with `data.issues[]`, each `{path, code, message}` rooted at `params.` with the
  message leading with that path (`params.evaluationContext must be an object`). Every refusal also carries
  `data.reason` and `data.advice` (`op_unknown`, `invalid_params`); a bad frame is `-32700` with `empty_frame` or
  `frame_too_large` (over 16777216 bytes) (f6acf0ee). Through raspd (fronted or sole), a params refusal on a native
  op comes from raspd's disposition table instead: `-32602 Invalid params: raspd refused: Params fail Bun's aspc params
  validator … [invalid_params]` with `data {reason, advice}` and no `issues[]` (2026-11-16, `T-13644/06-aspd/drive.txt`).
- Discovery: `health`, `version`, `surface` accept absent or empty params. Health is process-only; version reports
  the serving build/interface/capabilities; surface projects registered ops with summaries and stream declarations.
- Request log: one canonical JSON `rpc.request` per complete request (listener, op, client, outcome, durationMs),
  including malformed frames and unknown ops. Registered compile calls additionally retain operational
  `request.answered` (method, startedAt, durationMs, outcome, replyBytes; error on refusal, phases on compilation).
  New lines in `aspd.log` and `aspd.err.log` are L2 JSON (`{ts, level, component, event, data}`); read `data.*`. The
  system `aspd.err.log` still holds 1731 plain pre-L2 lines from before 2026-10-26 (and `raspd.err.log` 33), so filter
  `^{` before parsing (2026-11-16).
- **Observation kernel (d6417322, cardo protocol 3).** raspd also serves a cardo kernel on `run/raspd-kernel.sock`
  and writes a registry record for mount `aspd` (pid, socket, `protocol {major: 3}`, cardo rev, graphs) at
  `<kernel root>/run/cardo/kernels/aspd.json`, removed when raspd stops. raspd takes `--kernel-root`/`--kernel-instance`,
  but aspd-service passes neither, so the root is cardo's default `$HOME/praesidium/var`: the system record is
  `~/praesidium/var/run/cardo/kernels/aspd.json` (pid = `raspdLaunchdPid`), and its kernel log is the shared
  `$HOME/praesidium/var/logs/aspd/kernel.log`. The kernel is observation only; aspc serves if it fails. On 2026-11-23
  the system record was **absent** while raspd 40019 served (Gotchas, T-13646). `just conform-aspd` grades it on a built release (feature 7).
- `aspc manifest|verify-release` (the compiler CLI) produces and checks the frozen release manifest.
- `just build-aspd-pilot-client <abs root>` builds the T-08539 aspd pilot client (the historical HRC stand-in for
  `scripts/aspd-pilot/scenario.ts --client`) after a source-closure gate; it refuses a dirty checkout (source,
  `scripts/aspd-pilot/build-client.ts`; not driven).

## How to get to it

System namespace, read-only: `just aspd-status ~/praesidium/var/aspd` (or `bun scripts/aspd-service.ts status …`,
which posts no wrkp fact) and `avs aspc ~/praesidium/var/aspd/run/aspd.sock <method>`. Isolated namespace:
`<scratch>/aspd-ns`, filled with `just install-asp-release <release dir> <ns>/releases` (feature 7).

## Driving it

```bash
just aspd-status ~/praesidium/var/aspd                     # role fronted; runningEqualsSelected; executablePath <ns>/bin/aspd
avs aspc ~/praesidium/var/aspd/run/aspd.sock version       # frontDoor.sourceCommit == release.sourceCommit, role front, 11 native ops
codesign -dv ~/praesidium/var/aspd/bin/aspd                # Identifier=com.praesidium.aspd, Signature=adhoc
avs aspc ~/praesidium/var/aspd/run/aspd.sock aspc.hello    # catalogAgentInspection/inspectAgentSelection/prepareProcessInvocation false
avs aspc ~/praesidium/var/aspd/run/aspd.sock aspc.catalogAgents "{\"evaluationContext\": $(cat $CTX)}"
grep '"aspc.catalogAgents"' ~/praesidium/var/logs/agent-spaces/raspd.log | tail -1   # listener raspd, servedBy native
avs aspc ~/praesidium/var/aspd/run/aspd.sock aspc.noSuchMethod          # -32601 op_unknown; raspd.log servedBy bun, relay relayed
avs aspc ~/praesidium/var/aspd/run/aspd.sock aspc.catalogAgents '{}'    # -32602 "Invalid params: raspd refused: …", no issues[]
jq '{pid,socket,state}' ~/praesidium/var/run/cardo/kernels/aspd.json    # pid == raspdLaunchdPid, or absent (T-13646); note it and the mtime
NS=<scratch>/aspd-ns   # run every scratch verb through a wrapper that sets HOME=<scratch>/khome (Gotchas: kernel record)
just install-asp-release ~/praesidium/var/aspd/releases/<sole-capable id> $NS/releases   # and a pre-sole one (no raspd.sole/v1)
just aspd-init $NS; just aspd-status $NS                  # serving unavailable, selectedRelease null
just aspd-activate $NS <sole-capable id>                   # role direct, executableMode fixed, retention
just aspd-sole-enable $NS                                  # refuses: namespace is direct
just aspd-front-door-enable $NS; just aspd-front-door-status $NS   # fronted, 11 native; scratch record under <scratch>/khome
avs aspc $NS/run/aspd.sock aspc.catalogAgents "{\"evaluationContext\": $(cat $CTX)}"   # $NS/logs/raspd.log servedBy native
just aspd-activate $NS <pre-sole id>; just aspd-sole-enable $NS    # activates while fronted; sole-enable refuses (no raspd.sole/v1)
just aspd-activate $NS <sole-capable id>; just aspd-sole-enable $NS   # mode sole; status role sole, runningProcess null
just aspd-start $NS; just aspd-stop $NS; just aspd-start $NS       # raspd.alreadyRunning / raspd stopped / raspd started
just aspd-activate $NS <pre-sole id>                       # refuses; still serving sole
just aspd-front-door-disable $NS                           # refuses while sole
just aspd-front-door-enable $NS; just aspd-front-door-disable $NS  # from sole -> fronted -> direct
just install-asp-release $LEGACY $NS/releases                # a pre-c9f35e8f release; see Gotchas for where one survives
sh -c 'sleep 300; :' $NS/releases/<older id>/libexec/harness-broker >/dev/null 2>&1 &   # holds one release "in use"
just aspd-activate $NS <legacy id>                         # executableMode legacy-release; one legacy-fallback line; retention keeps the held one
just aspd-activate $NS <fixed id>                          # after killing the sleeper: retention.removed names it
just aspd-stop $NS; just aspd-status $NS                   # runningProcess null, unavailable
just aspd-status ~/praesidium/var/aspd                     # same launchdPid and raspdLaunchdPid: untouched
jq .pid ~/praesidium/var/run/cardo/kernels/aspd.json; stat -f %m ~/praesidium/var/run/cardo/kernels/aspd.json   # unchanged
bun test scripts/aspd-service.test.ts scripts/aspd-service-retention.test.ts   # 15 across both: launch script, stable exec, adoption, error-5 retry, retention
plutil -extract ProcessType raw ~/Library/LaunchAgents/com.praesidium.aspd.plist   # Interactive (raspd too)
```

Run the scratch verbs as `bun scripts/aspd-service.ts <verb> $NS` (the `just` recipes post a `run.settled` fact) with
a stripped environment (`env -i HOME=<scratch>/khome PATH=… USER=… LOGNAME=… SHELL=… TMPDIR=… LANG=…`) so the daemon
inherits no seat variables and its kernel record stays in the scratch; `T-13644/06-aspd/svc.sh` is that wrapper.

## Gotchas

- **The system kernel record was deleted (T-13646 fired).** On 2026-11-23 `kernels/aspd.json` was absent while system
  raspd 40019 (started 2026-11-21T16:50Z) served and `run/raspd-kernel.sock` existed. The shared
  `~/praesidium/var/logs/aspd/kernel.log` ends with two `kernel.stopped` lines (2026-11-22T20:33:35Z, 20:39:28Z) from
  some other raspd run with the real `HOME`; raspd never rewrites the record, so it stays absent until the next
  activation. Record "absent" before and after a drive; unchanged-absent is the pass condition then
  (`T-14445/live/aspd-system.txt`; evidence on T-13646).
- **A scratch raspd with the real `HOME` overwrites the system kernel record, then deletes it on stop (T-13646).**
  aspd-service starts raspd without `--kernel-root`, the kernel lock is per kernel socket, and the record path is per
  mount (`aspd`) under `$HOME/praesidium/var`. Mable seats read that record. So every scratch `front-door-enable`,
  `sole-enable`, `start` or `stop` that runs raspd must run with `HOME=<scratch>/khome`; `inheritEnv` passes it
  through. On 2026-11-16 the scratch record landed at `<scratch>/khome/praesidium/var/run/cardo/kernels/aspd.json`
  (pid 87108) while the system record stayed pid 12821 at the same mtime, and the catalog still answered 33 agents
  (`T-13644/06-aspd/drive.txt`). Do not run `scripts/raspd-sole-role-e2e.ts` or `raspd-sole-supervised-e2e.ts` on a
  shared host until T-13646 lands; they have the same hazard.
- **Three identities; keep them apart.** Deployed = `selectedRelease.releaseId` (active.json). Served =
  `serving.release` / `frontDoor.publicRelease` (raspd reads `release.json` at `--release-root`) and
  `frontDoor.bunRelease` (Bun's compiled-in identity, which Bun checks against the root at startup). Code identity of
  the public listener = `frontDoor.publicFrontDoor.sourceCommit` (compiled into `bin/raspd`; raspd does not check it
  against the release), also `version.frontDoor.sourceCommit` over the socket. The signing identity is only in the
  activation record and `codesign -dv <ns>/bin/<prog>`. `just install`'s post-check reads only
  `runningEqualsSelected` and `serving.release.sourceCommit`. On 2026-11-23 all three named c842914d
  (`asp-c842914dbbc6-20261121T165030Z-391d01`, fixed, ad hoc, role fronted); HEAD 33556b1c (claimsTask retirement,
  the raspd telemetry split) was not deployed. Another seat's `just install` can move them mid-pass (it
  did at 10:04Z on 2026-11-02); re-read status at the end of a pass before quoting the deployed release
  (`T-12763/06-aspd/drive.txt`, `live/system-aspd-final.txt`).
- `$CTX` for the catalog is feature 4's evaluation-context file; over the socket the same agents come back as from
  `asp agents catalog`, from both the system and the scratch daemon: 23 on 2026-11-23 (33 on 2026-11-16)
  (`T-14445/06-aspd/drive.txt`).
- **The system namespace is fronted and supervised** (since 2026-10-26T13:04Z, `activations.ndjson`): config
  `frontDoor {bunSocketPath: run/aspd-bun.sock, label: com.praesidium.raspd}`, plists `com.praesidium.aspd` and
  `com.praesidium.raspd`, both execing `<ns>/bin/*` with `--release-root`. Bun answers on `aspd-bun.sock`; the public
  `aspd.sock` is raspd. Check `git merge-base --is-ancestor <commit> <serving sourceCommit>` before crediting a
  change to the system daemon. Its pids to compare before and after a drive are `launchdPid` and
  `frontDoor.raspdLaunchdPid` (`T-12323/live/system-aspd.txt`).
- **Never `supervise` a scratch namespace.** Nothing checks whether a label is in use: with `com.praesidium.aspd` it
  would overwrite the system plist with the scratch launch script, and the next system activation or a scratch
  `stop` (a `bootout` of that label) would hit the system daemon. A unique label still registers a real RunAtLoad +
  KeepAlive job, and `stop` leaves its plist behind. Prove supervision with the unit test, or drive it with a
  scratch `HOME` (the plist lands in `$HOME/Library/LaunchAgents`), `PRAESIDIUM_LAUNCH_SHIM` set to the real shim, and
  a stub `launchctl` first on PATH that runs the plist's ProgramArguments into its StandardOutPath; keep the scratch
  socket path under 104 bytes (`T-11719` artifacts). Fronting a scratch namespace is safe unsupervised with an isolated `HOME` (the raspd label
  is used only when supervised; the kernel record is the first Gotcha); a supervised scratch with the default label would collide with `com.praesidium.raspd`.
- **No legacy release is left on the system namespace or the default build root** (retention, above), and the T-12156
  scratch copy is gone. A pre-c9f35e8f release survives at
  `~/praesidium/var/asp-release-builds/asp-61486292ffee-20260929T233520Z-570989`. It has no raspd, so use it as `$LEGACY`
  only while the namespace is direct (2026-11-16: `legacy-release`, one fallback line, `T-13644/06-aspd/drive.txt`).
  Otherwise build one in a scratch clone at a commit before c9f35e8f. **No pre-sole release with raspd survives**:
  `asp-335e40112306-…` was pruned, and every one of the 11 system releases (b38dbf57 through c842914d) lists
  `raspd.sole/v1` (2026-11-23). On a fronted namespace the legacy release refuses first (`namespace is fronted and
  release … does not contain raspd`), so the "sole-enable refuses on a pre-sole release" leg needs a scratch-clone build
  at a commit before a7bc2bf7 that has raspd.
- To see retention on a scratch namespace, install more than five releases first: with seven installed, activating
  the legacy one while a sleeper held af8c8306 removed 2336a218 and 356f3344 and kept af8c8306 as `inUse`; the next
  fixed activation then removed af8c8306 (2026-11-09, `T-12763/06-aspd/activate-{legacy,fixed}.json`). Detach any such
  sleeper (`>/dev/null 2>&1 &`) or `avs rec` waits on it.
- A scratch activation in fixed mode writes and ad-hoc signs `<ns>/bin/*` inside the scratch: no keychain, no system
  write (2026-11-02, `T-12323/06-aspd/drive.txt`).
- An unsupervised namespace logs to `<logDir>/aspd-<releaseId>-<startedAt>.log`, not `aspd.log`; `logDir` is
  `config.logDir` (`aspd-service.ts log-dir`), default `<ns>/logs`. The system namespace's is `~/praesidium/var/logs/agent-spaces`: `raspd.log` is the public listener's
  request log (`listener: raspd`, `servedBy: native|bun`, `relay`, `fallback`, `phases`) and `aspd.log`
  is Bun's request log on `aspd-bun.sock` (`runningProcess.requestLogPath`; the collective L4 job rotates it, aspd does not;
  `.1`–`.3` are pre-T-11829 leftovers) and `aspd.err.log` the
  supervisor output (`runningProcess.logPath`); `~/praesidium/var/aspd/logs/` holds only stale files from before
  T-11719. A fronted namespace adds `raspd.log` and `raspd.err.log` in the same `logDir`.
- An unknown method is answered `-32601` and has a canonical `rpc.request` line, but no legacy `request.answered`.
  Params refusals have both; legacy outcome remains `error:INVALID_ASPC_COMMAND`.
- Grep the request log a moment after the call: the `--log` sink buffers 250 ms (`docs/aspd.md`), so a grep in
  the same second can miss the refusal's `error:INVALID_ASPC_COMMAND` line (2026-10-05, `T-10364/06-aspd/drive.txt`).
  The system `aspd.log` and `raspd.log` held 0 non-JSON lines on 2026-11-02 (the prefixed pre-T-11829 lines have
  rotated out).
- `aspc --help` is "Unknown command"; run `aspc` bare for usage.
- Never activate, restart, stop or `supervise` the system namespace. `just install` in the canonical checkout
  activates it (any seat may run that): it now also re-copies and re-signs `var/aspd/bin/*` and restarts the
  `com.praesidium.raspd` job. Standalone activation is Mable primary's.

## Proven when

The system status shows `role: fronted`, `runningEqualsSelected: true`, `frontDoor.mode: "fronted"` with 11 native
ops, a `serving.release.sourceCommit` that `git log` resolves and equals `version.frontDoor.sourceCommit`, and
`runningProcess.executablePath` under `<ns>/bin`; hello and catalog answer over the socket, the refusals carry their
codes, and `raspd.log` shows the catalog call `servedBy: native` and the unknown method `servedBy: bun` (the only
`bun` line since the 2026-11-21 rotation is the probe's own: 182996 native, 1 bun on 2026-11-23). The scratch
namespace, run with an isolated `HOME`, goes unavailable → activated on a fixed-exec release (`role: direct`,
`executableMode: fixed`, ad-hoc `com.praesidium.aspd` copy, `--release-root`) → sole-enable refused → fronted (11
native ops, catalog `servedBy: native`) → sole-enable refused on a pre-sole release → sole (no Bun socket,
`runningProcess` null, unknown method refused natively) → the sole-mode refusals → fronted from sole → direct →
activated on a pre-c9f35e8f release (`legacy-release`, one fallback line, in-place launcher) → stopped → `not
running`. Across all of it both system pids and the system kernel record's pid and mtime (or its absence) are unchanged. Both system
plists' ProgramArguments start with `praesidium-launch` and carry `ProcessType` `Interactive`, and the aspd-service unit
tests pass (15).

Driven 2026-11-23 against system release asp-c842914dbbc6-20261121T165030Z-391d01 (source c842914d, role fronted,
supervised, fixed exec; read-only, `T-14445/live/aspd-system.txt`) and a scratch namespace holding the system's
sole-capable c842914d and legacy 61486292, through `T-14445/06-aspd/svc.sh` (`env -i`, `HOME=<scratch>/khome`)
(T-14445): `var/wrkq-artifacts/T-14445/06-aspd/drive.txt`, `activate-{sole-cap,legacy}.json`, `sole-enable.json`. The
system kernel record was absent throughout (T-13646). Not driven: the sole-enable refusal on a pre-sole release (no
such release with raspd remains; legacy refuses earlier, on the fronted precondition), retention at depth (seven-release
drive `T-12763/06-aspd`), a live `supervise` (see Gotchas), a codesign failure (activation would leave the namespace
stopped on the old selection; source `aspd-service/launchd.ts:72-74`), retention's failed-`ps` path (source,
`release-retention.ts:47-50`), a scratch raspd with the real `HOME` (T-13646), `log-dir`, `build-aspd-pilot-client`,
`compileHarnessInvocation` against aspd (it needs a full v2 compile request), and `aspc manifest|verify-release` (they
need a request file and a corpus). Source only (`T-14445/sources/06.md`): `rpc.request` may carry `fallbackDetail`,
`code`, `message` and `relay: upstream_failed`, a `parse_error` frame logs op `unmatched`, and Antigravity compiles are
raspd-native (Bun refuses `unsupported_harness`).
