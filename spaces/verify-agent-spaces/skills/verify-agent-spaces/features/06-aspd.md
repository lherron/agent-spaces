# 6. The aspd compile service

`aspd` serves the ASPC compile and inspection plane (`aspc/0.1`, NDJSON JSON-RPC over a Unix socket) from one
immutable release in an explicit namespace. HRC compiles every launch through it. Code: `scripts/aspd-service.ts`
(the verbs: init, start, stop, restart, supervise, activate, log-dir, status, front-door-*; Bun aspd, raspd, launchd
jobs and namespace records under `scripts/aspd-service/`), `harness/aspc-facade/src/aspd.ts`, methods and
validators in `contracts/aspc-protocol/src/{types,schemas,inspection-params}.ts`, the client
`spaces-aspc-protocol/unix-client`. Doc: `docs/aspd.md`.

## Sub-features

- Namespace layout: `releases/<releaseId>`, `service/config.json` (plus `active.json`, `activations.ndjson`, and
  `launchd-run.sh` once supervised), `run/aspd.sock`, `run/aspd.json` (the running record), `state/asp-home`,
  `logs/`. `aspd-init` writes the config (socket path, `ASP_HOME=<ns>/state/asp-home`, `inheritEnv` HOME PATH USER
  LOGNAME SHELL TMPDIR LANG) and no `supervisor`. The system namespace's config sets `ASP_HOME` to
  `var/spaces-repo` by hand, not the init default.
- `aspd-activate <ns> <releaseId>`: retire the running daemon, record the selection, start the release, and finish
  only when `aspc.hello` answers with that release's identity; it returns `{activation, beganAt, retired, started,
  completedAt}`. `aspd-start` (a second start returns `alreadyRunning`; a running release other than the selection
  refuses `activate instead`), `aspd-stop` (`{stopped: false, reason: "not running"}` when stopped), `aspd-restart`.
- `supervise <ns> <label>` (script only, no recipe) hands the namespace to launchd (the system namespace is
  `com.praesidium.aspd`): it writes `~/Library/LaunchAgents/<label>.plist` and `service/launchd-run.sh`, adopts the
  plist with `praesidium-adopt` (ProgramArguments start with `~/.local/bin/praesidium-launch`;
  `AssociatedBundleIdentifiers` `com.praesidium.AgentHost`), re-adopts before every bootstrap, and retries a
  bootstrap error 5 for up to 4 attempts in all, 2 s apart (`BOOTSTRAP_ATTEMPTS`, `aspd-service/launchd.ts:15-16`;
  T-10818). Then stop is `bootout`, restart `kickstart -k`.
- `aspd-status <ns>`: `namespace`, `socketPath`, `supervisor` and `launchdPid` (both null when unsupervised),
  installed releases, `selectedRelease`, `runningProcess`, `serving` (the live `aspc.hello` reply, or
  `{unavailable}`), `runningEqualsSelected`, `frontDoor` (`{mode: "direct", bunSocket, publicFrontDoor: null}`
  unfronted). It sends `aspc.hello` and `version`, so it adds `rpc.request` lines and usage rows on that daemon. A relative namespace refuses `namespace must be absolute`; an
  uninitialized one `namespace not initialized: <ns>/service/config.json`, exit 1.
- Front door (raspd, P-00890): `just aspd-front-door-enable <ns> [label]` / `aspd-front-door-disable <ns>` /
  `aspd-front-door-status <ns>` (`aspd-service.ts front-door-*`). Enable needs a selected release containing `raspd`,
  moves Bun to `run/aspd-bun.sock`, starts raspd on `run/aspd.sock` (plus `run/raspd.json`, `run/raspd-kernel.sock`,
  `<logDir>/raspd{,.err}.log`) and records `frontDoor {bunSocketPath, label}` in the config; the label is used only
  when supervised. Status then reads `mode: "fronted"`, `bunAnswering`, `publicFrontDoor.native` (the ops raspd
  answers itself) and both releases; `raspd.log` lines carry `servedBy: native|bun`. Disable stops raspd and puts
  Bun back on the public socket (`mode: "direct"`).
- Methods: `aspc.hello`, `catalogAgents`, `inspectAgent`, `catalogAgentInspection`, `inspectAgentSelection`,
  `compileHarnessInvocation` (v2 requests only), `resolveRuntimeDeclaration`, `inspectRuntimePlacement`,
  `observeRuntimeCapability`, `observeContinuationArtifact`, `prepareProcessInvocation`. Refusals: `-32601 Method
  not found`, `-32602 Invalid params` with `data.issues[]`, each `{path, code, message}` rooted at `params.` with the
  message leading with that path (`params.evaluationContext must be an object`). Every refusal also carries
  `data.reason` and `data.advice` (`op_unknown`, `invalid_params`); a bad frame is `-32700` with `empty_frame` or
  `frame_too_large` (over 16777216 bytes) (f6acf0ee).
- Discovery: `health`, `version`, `surface` accept absent or empty params. Health is process-only; version reports
  the serving build/interface/capabilities; surface projects registered ops with summaries and stream declarations.
- Request log: one canonical JSON `rpc.request` per complete request (listener, op, client, outcome, durationMs),
  including malformed frames and unknown ops. Registered compile calls additionally retain operational
  `request.answered` (method, startedAt, durationMs, outcome, replyBytes; error on refusal, phases on compilation).
  Every line in `aspd.log` and `aspd.err.log` is L2 JSON (`{ts, level, component, event, data}`); read `data.*`.
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
just aspd-status ~/praesidium/var/aspd                     # runningEqualsSelected true, serving.release.sourceCommit
avs aspc ~/praesidium/var/aspd/run/aspd.sock aspc.hello
avs aspc ~/praesidium/var/aspd/run/aspd.sock aspc.catalogAgents "{\"evaluationContext\": $(cat $CTX)}"
avs aspc ~/praesidium/var/aspd/run/aspd.sock aspc.noSuchMethod          # -32601
avs aspc ~/praesidium/var/aspd/run/aspd.sock aspc.catalogAgents '{}'    # -32602, issues[0].message params.evaluationContext must be an object
grep catalogAgents ~/praesidium/var/logs/agent-spaces/aspd.log | tail -2
NS=<scratch>/aspd-ns
just install-asp-release ~/praesidium/var/aspd/releases/<releaseId> $NS/releases
just aspd-init $NS; just aspd-status $NS                  # serving unavailable, selectedRelease null
just aspd-activate $NS <releaseId>                         # started pid, serving hello, readyAt
avs aspc $NS/run/aspd.sock aspc.catalogAgents "{\"evaluationContext\": $(cat $CTX)}"
just aspd-stop $NS; just aspd-status $NS                   # runningProcess null, unavailable
just aspd-status ~/praesidium/var/aspd                     # same pid as before: untouched
bun test scripts/aspd-service.test.ts                      # supervise, adoption, error-5 retry against a fake launchctl
```

Run the scratch verbs as `bun scripts/aspd-service.ts <verb> $NS` (the `just` recipes post a `run.settled` fact) with
a stripped environment (`env -i HOME=… PATH=… USER=… LOGNAME=… SHELL=… TMPDIR=… LANG=…`) so the daemon inherits no
seat variables.

## Gotchas

- `$CTX` for the catalog is feature 4's evaluation-context file; over the socket the same 50 agents came back as from
  `asp agents catalog`, from both the system and the scratch daemon (2026-10-26, `T-11875/06-aspd/drive.txt`).
- **Installed is not source for the front door.** On 2026-10-26 the system namespace ran Bun aspd directly
  (`service/launchd-run.sh` execs `<release>/aspd serve`; no `frontDoor` in its config; no raspd plist) on release
  `asp-a34f6e14bf5a-…`, which ships `raspd` (`cargo-native`) unused. A scratch namespace fronted on that release
  answered `aspc.hello`, `health`, `version`, `surface`, `resolveRuntimeDeclaration` and
  `observeContinuationArtifact` natively and relayed `catalogAgents` to Bun; native `compileHarnessInvocation`
  (b32c6e05) is checkout-only until a release past it is activated. Check `git merge-base --is-ancestor <commit>
  <serving sourceCommit>` before crediting a raspd change to the system daemon (`T-11875/06-aspd/drive.txt`).
- **Never `supervise` a scratch namespace.** Nothing checks whether a label is in use: with `com.praesidium.aspd` it
  would overwrite the system plist with the scratch launch script, and the next system activation or a scratch
  `stop` (a `bootout` of that label) would hit the system daemon. A unique label still registers a real RunAtLoad +
  KeepAlive job, and `stop` leaves its plist behind. Prove supervision with the unit test, or drive it with a
  scratch `HOME` (the plist lands in `$HOME/Library/LaunchAgents`), `PRAESIDIUM_LAUNCH_SHIM` set to the real shim, and
  a stub `launchctl` first on PATH that runs the plist's ProgramArguments into its StandardOutPath; keep the scratch
  socket path under 104 bytes (`T-11719` artifacts).
- An unsupervised namespace logs to `<logDir>/aspd-<releaseId>-<startedAt>.log`, not `aspd.log`; `logDir` is
  `config.logDir` (`aspd-service.ts log-dir`), default `<ns>/logs`. The system namespace's is `~/praesidium/var/logs/agent-spaces`: `aspd.log`
  is its launchd request log (`runningProcess.requestLogPath`; the collective L4 job rotates it, aspd does not;
  `.1`–`.3` are pre-T-11829 leftovers) and `aspd.err.log` the
  supervisor output (`runningProcess.logPath`); `~/praesidium/var/aspd/logs/` holds only stale files from before
  T-11719. A fronted namespace adds `raspd.log` and `raspd.err.log` in the same `logDir`.
- An unknown method is answered `-32601` and has a canonical `rpc.request` line, but no legacy `request.answered`.
  Params refusals have both; legacy outcome remains `error:INVALID_ASPC_COMMAND`.
- Grep the request log a moment after the call: the `--log` sink buffers 250 ms (`docs/aspd.md`), so a grep in
  the same second can miss the refusal's `error:INVALID_ASPC_COMMAND` line (2026-10-05, `T-10364/06-aspd/drive.txt`).
  The system `aspd.log` still holds prefixed `<iso> [aspd] <LEVEL> …` lines from before the T-11829 release (the
  last at 2026-10-26T06:05:41Z); everything after is whole-line L2 JSON, as are all scratch logs (0 non-JSON lines,
  2026-10-26). Filter with `grep '^{'` before `jq` when reading old history.
- `aspc --help` is "Unknown command"; run `aspc` bare for usage.
- Never activate, restart, stop or `supervise` the system namespace. `just install` in the canonical checkout
  activates it (any seat may run that); standalone activation is Mable primary's.

## Proven when

The system status shows `runningEqualsSelected: true` and a `serving.release.sourceCommit` that `git log` resolves;
hello and catalog answer over the socket, the two refusals carry their codes, and the request log shows the
catalog call. The scratch namespace goes unavailable → activated (hello with the installed release) → serving the
catalog → `alreadyRunning` → fronted (status `mode: "fronted"`, `bunAnswering: true`, the release's native op list,
catalog relayed `servedBy: bun`) → direct again → stopped → `not running`, and the system daemon's pid is unchanged
across all of it; the system namespace's `front-door-status` reads `direct`; the
system plist's ProgramArguments start with `praesidium-launch`; the aspd-service unit test passes.

Driven 2026-10-26 against system release asp-a34f6e14bf5a-20261026T083841Z-6c5d79 (source a34f6e14, direct mode)
and a scratch namespace on the same release, fronted and unfronted, through `bun scripts/aspd-service.ts`
(T-11875): `var/wrkq-artifacts/T-11875/06-aspd/drive.txt`. Not driven: a live `supervise` (see Gotchas), a
supervised front door (raspd launchd job), `log-dir`, `build-aspd-pilot-client`,
`compileHarnessInvocation` against aspd (it needs a full v2 compile request; feature 8's `--compile-transport
aspc-rpc` row compiles through a checkout aspc-facade over stdio, not through aspd) and `aspc manifest|verify-release`
(they need a request file and a corpus).
