# 6. The aspd compile service

`aspd` serves the ASPC compile and inspection plane (`aspc/0.1`, NDJSON JSON-RPC over a Unix socket) from one
immutable release in an explicit namespace. HRC compiles every launch through it. Code: `scripts/aspd-service.ts`
(init, start, stop, restart, supervise, activate, status), `harness/aspc-facade/src/aspd.ts`, methods and
validators in `contracts/aspc-protocol/src/{types,schemas,inspection-params}.ts`, the client
`spaces-aspc-protocol/unix-client`. Doc: `docs/aspd.md`.

## Sub-features

- Namespace layout: `config.json`, `releases/<releaseId>`, `run/aspd.sock`, `state/`, `logs/`. `aspd-init` writes
  the config (socket path, `ASP_HOME=<ns>/state/asp-home`, inherited env).
- `aspd-activate <ns> <releaseId>`: retire the running daemon, record the selection, start the release, and finish
  only when `aspc.hello` answers with that release's identity. `aspd-start`/`stop`/`restart`; `supervise` hands
  the namespace to launchd (the system namespace is `com.praesidium.aspd`).
- `aspd-status <ns>`: installed releases, `selectedRelease`, `runningProcess`, `serving` (the live `aspc.hello`
  reply, or `{unavailable}`), `runningEqualsSelected`.
- Methods: `aspc.hello`, `catalogAgents`, `inspectAgent`, `catalogAgentInspection`, `inspectAgentSelection`,
  `compileHarnessInvocation` (v2 requests only), `resolveRuntimeDeclaration`, `inspectRuntimePlacement`,
  `observeRuntimeCapability`, `observeContinuationArtifact`, `prepareProcessInvocation`. Refusals: `-32601 Method
  not found`, `-32602 Invalid params` with `data.issues[]`.
- Request log: one `request.answered` line per call (method, durationMs, outcome, replyBytes).
- `aspc manifest|verify-release` (the compiler CLI) produces and checks the frozen release manifest.

## How to get to it

System namespace, read-only: `just aspd-status ~/praesidium/var/aspd` (or `bun scripts/aspd-service.ts status …`,
which posts no wrkp fact) and `avs aspc ~/praesidium/var/aspd/run/aspd.sock <method>`. Isolated namespace:
`<scratch>/aspd-ns`, filled with `just install-asp-release <release dir> <ns>/releases` (feature 7).

## Driving it

```bash
just aspd-status ~/praesidium/var/aspd                     # runningEqualsSelected true, serving.release.sourceCommit
avs aspc ~/praesidium/var/aspd/run/aspd.sock aspc.hello
avs aspc ~/praesidium/var/aspd/run/aspd.sock aspc.catalogAgents "{\"evaluationContext\": $(cat context.json)}"
avs aspc ~/praesidium/var/aspd/run/aspd.sock aspc.noSuchMethod          # -32601
avs aspc ~/praesidium/var/aspd/run/aspd.sock aspc.catalogAgents '{}'    # -32602, issues[]
grep catalogAgents ~/praesidium/var/aspd/logs/aspd.log | tail -2
NS=<scratch>/aspd-ns
just install-asp-release ~/praesidium/var/aspd/releases/<releaseId> $NS/releases
just aspd-init $NS; just aspd-status $NS                  # serving unavailable, selectedRelease null
just aspd-activate $NS <releaseId>                         # started pid, serving hello, readyAt
avs aspc $NS/run/aspd.sock aspc.catalogAgents "{\"evaluationContext\": $(cat context.json)}"
just aspd-stop $NS; just aspd-status $NS                   # runningProcess null, unavailable
just aspd-status ~/praesidium/var/aspd                     # same pid as before: untouched
```

## Gotchas

- The `context.json` for the catalog is feature 4's; over the socket the same 48 agents came back as from `asp agents
  catalog`, from both the system and the scratch daemon (2026-10-05, `T-10300/06-aspd/drive.txt`).
- An unsupervised namespace logs to `logs/aspd-<releaseId>-<startedAt>.log`, not `logs/aspd.log`; the system
  namespace's `aspd.log` is its launchd request log (`runningProcess.requestLogPath`) and rotates to `.1`–`.3`.
- An unknown method is answered `-32601` and not written to the request log; a params refusal is, as
  `error:INVALID_ASPC_COMMAND`.
- The invalid-params `message` for a missing `evaluationContext` reads `" must be an object"` (empty path prefix);
  the `path` field carries the name.
- `aspc --help` is "Unknown command"; run `aspc` bare for usage.
- Never activate, restart, stop or `supervise` the system namespace. `just install` in the canonical checkout
  activates it (any seat may run that); standalone activation is Mable primary's.

## Proven when

The system status shows `runningEqualsSelected: true` and a `serving.release.sourceCommit` that `git log` resolves;
hello and catalog answer over the socket, the two refusals carry their codes, and the request log shows the
catalog call. The scratch namespace goes unavailable → activated (hello with the installed release) → serving the
catalog → stopped, and the system daemon's pid is unchanged across all of it.

Driven 2026-10-05 against system release asp-a17d0215a29b (source a17d021) and a scratch namespace on the same
release (T-10300): `var/wrkq-artifacts/T-10300/06-aspd/drive.txt`. Not driven: `compileHarnessInvocation` against aspd (it
needs a full v2 compile request; feature 8's `--compile-transport aspc-rpc` row compiles through a checkout
aspc-facade over stdio, not through aspd) and `aspc manifest|verify-release` (they need a request file and a corpus).
