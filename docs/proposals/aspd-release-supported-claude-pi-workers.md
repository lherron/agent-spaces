# T-08561 — Package supported Claude and Pi workers in immutable ASP releases

Status: Daedalus-approved specification (EN-13188); implementation opened as
T-08561. The task specification field is the implementation contract.

## 1. Outcome and boundary

An immutable ASP release can prepare and execute every currently supported
compiler-backed Claude/Pi broker profile without resolving ASP-owned code from
PATH, `import.meta`, a checkout, or another release:

- `claude-code-tmux`;
- `pi-tui-tmux`;
- `pi-sdk` non-interactive.

Each release built with this change chooses the worker executable for the
selected profile and stamps that absolute choice into the existing
per-preparation `executionRelease.worker.executable`. A selected broker profile
that this release has no declared worker binding for is refused by aspd before
the compile response can become launchable. No worker or native harness starts
on refusal.

This task is ASP producer work only. It does not migrate HRC doors, remove HRC
resolvers, activate max3, publish packages, run `just install`, advance ACP,
change placement/lifecycle authority, add a feature flag, add any ASPC field
besides the one optional metadata field specified below, add any verb, retire a
harness, or reconcile the stale agent-harness invariant. Mable owns later
shared max3 activation. T-08558 M14/M15 remain later closure work:
HRC still has 20 locked ASP packages including `cli-kit` (19 excluding it), of
which 14 are implementation-bearing.

Implementation and landing are isolated from the live shared checkout. Every
non-aspd birth on max3 currently executes the shared
`/Users/lherron/praesidium/agent-spaces` checkout through Bun links and PATH
hook bridges, so the implementer works only in the task's linked worktree on a
task branch. After all isolated acceptance passes, the pushed task commit lands
on `origin/main` only by fast-forward during a supervisor-agreed window; Mable
then pulls the shared checkout. The implementer never edits or pulls the shared
checkout directly.

## 2. Settled probe facts

The reproducible evidence is in
`/Users/lherron/praesidium/var/wrkq-artifacts/T-08561/probes/REPORT.md` and its
raw sidecars.

1. A compiled pi-sdk preparation selects `brokerDriver: pi-sdk` with
   `process.command: "in-process"` and `process.args: []`. It contains no Pi
   SDK runner argv. The current aspd incorrectly stamps the stock
   `<releaseRoot>/harness-broker`, whose compiled driver inventory omits
   `pi-sdk`. The existing `harness-broker-pi` composition is the same broker CLI
   and protocol plus `createPiSdkDriver`.
2. Compiled `claude-code-tmux` emits runner
   `exec bun '/$bunfs/root/tmux-launch-runner' ...` and bare PATH hook commands
   `harness-broker claude-hook{,-decision}`.
3. Compiled `pi-tui-tmux` emits the same nonexistent runner and a generated
   wrapper that executes bare PATH `harness-broker pi-hook`.
4. An anthropic headless request with no profile selector selects no driver. It
   returns `ok:false` with `unsupported_provider`, `unsupported_harness`, and
   `unsupported_runtime`; there is no implicit fallback profile.
5. The compiled Claude materialization contains neither `statusline.sh` nor a
   `statusLine` setting. Its compiled import-meta source path is exactly
   `/assets/statusline.sh`. No absolute helper path is durably embedded; the
   best-effort copy silently disappears instead.
6. The stock release worker currently registers `codex-app-server`,
   `codex-desktop`, `arris-resident`, `claude-code-tmux`, `codex-cli-tmux`, and
   `pi-tui-tmux`. The existing Pi worker adds `pi-sdk`.

## 3. Producer design

### 3.1 Release manifest and per-profile worker selection

Add a producer-internal worker-binding declaration to `release.json`, mapping a
supported broker driver to one executable already named by the manifest. This
is release metadata, not ASPC wire. For the release produced by this task:

| Broker driver | Release executable |
| --- | --- |
| `codex-app-server` | `harness-broker` |
| `claude-code-tmux` | `harness-broker` |
| `pi-tui-tmux` | `harness-broker` |
| `pi-sdk` | `harness-broker-pi` |

Do not declare a release binding for `codex-cli-tmux`: it remains registered in
the stock broker and deprecated in place, but this task neither repairs nor
retires it. Do not newly bind `codex-desktop` or `arris-resident`; their route
migrations belong to later legs.

Package a fourth identity-bound executable, `harness-broker-pi`, using a release
entrypoint that calls the existing `runBrokerCli` with
`additionalDrivers: [createPiSdkDriver]`. It uses the same CLI flags and
`harness-broker/0.2` protocol as the stock worker, reports the same embedded
release identity, and is inspected/digested like the other release payloads.
This preserves the existing Pi-specific composition and avoids adding the
heavy Pi SDK/session closure to every stock worker. It uses the existing
per-preparation executable field exactly as designed; there is no new wire
field for executable selection.

For releases built with this change, the release inspector must prove that every
declared binding names an identity-bound executable inside the release and that
the executable's compiled `drivers --json` inventory contains the declared
driver. Extra registered drivers are allowed and are not thereby release-bound.
This validation is a build/inspection gate for new artifacts, not a runtime
enforcement point.

Retained pre-T-08561 v1 releases remain immutable, inspectable, activatable, and
valid rollback targets. They keep the semantics of their own compiled aspd:
nothing in this task or a newer inspector retrofits a binding lookup, refusal,
or hosting-evidence field into those historical payloads. In particular, such
an aspd may still stamp its stock `harness-broker` for a selected Claude/Pi
profile even though that worker cannot host every selection. Rollback restores
those compiled semantics; this task neither rewrites historical artifacts nor
forbids activating them.

After the compiler returns one selected profile, aspd looks up its
`brokerDriver` in the serving release's binding table. On success it stamps the
chosen launcher's canonical absolute path, the profile's existing protocol, and
the unchanged `['run','--transport','unix']` argv prefix. It also emits exactly
one optional additive metadata field on the existing response:

```ts
executionRelease.worker.hostedDrivers?: string[]
```

For a release built with this change, `hostedDrivers` is the sorted set of
driver IDs that the inspected `release.json` binding table assigns to the
selected executable. It is positive hosting evidence frozen with the
preparation; it is not inferred from the executable's extra registered drivers.
The dispatch/start payload remains byte-for-byte intact.

The consumer admission rule lands in T-08562, not this producer task. Before
HRC launches any selected driver other than `codex-app-server` through the aspd
route, it must require `hostedDrivers` to be present and contain the selected
profile's `brokerDriver`; absence or mismatch refuses before any worker, pane,
or native harness starts. `codex-app-server` remains admissible when a retained
release omits the field, preserving the already-proven legacy binding and old
worker control. Old clients ignore the optional metadata.

### 3.2 Named refusal on the existing response path

For a release built with this change, if the selected profile has no worker
binding, aspd returns the existing `AspcCompileHarnessInvocationResponse`
failure envelope before adding an `executionRelease` and before any hosting
effect. The named diagnostic is:

```json
{
  "level": "error",
  "code": "release_worker_driver_unavailable",
  "message": "Selected broker driver is not hosted by this ASP release",
  "plane": "asp-compiler",
  "details": {
    "releaseId": "<serving release id>",
    "brokerDriver": "<selected profile driver>"
  }
}
```

The complete current error shape, which must be reused, is:

```json
{
  "schemaVersion": "aspc-compile-harness-invocation-response/v1",
  "ok": false,
  "compileResponse": {
    "schemaVersion": "agent-runtime-compile-response/v1",
    "ok": false,
    "diagnostics": [{
      "level": "error",
      "code": "release_worker_driver_unavailable",
      "message": "Selected broker driver is not hosted by this ASP release",
      "plane": "asp-compiler",
      "details": {
        "releaseId": "<serving release id>",
        "brokerDriver": "<selected profile driver>"
      }
    }]
  },
  "diagnostics": [{
    "level": "error",
    "code": "release_worker_driver_unavailable",
    "message": "Selected broker driver is not hosted by this ASP release",
    "plane": "asp-compiler",
    "details": {
      "releaseId": "<serving release id>",
      "brokerDriver": "<selected profile driver>"
    }
  }]
}
```

`release_worker_driver_unavailable` is a new diagnostic code/value, but not a
new error type, field, union branch, RPC verb, protocol version, or broker
error. The code fields are already open strings. It is an additive named
refusal on the existing failure path plus a deliberate semantic tightening:
an unhostable selected profile changes from a misleading compile success to a
pre-launch failure. Daedalus should rule this classification and the additive
release-manifest metadata.

### 3.3 Release-bound Claude and Pi TUI helpers

Add one explicit same-payload tmux-helper launcher, following
`codexTuiLauncher`, and thread it from the release entrypoints through
`runBrokerCli` to `createDefaultBroker` and the two driver factories. Checkout
and package entrypoints omit it and preserve their current source/dist/PATH
fallbacks.

For a release worker:

- Claude hook settings call
  `<worker payload> claude-hook --socket ...` and
  `<worker payload> claude-hook-decision --socket ...`;
- Pi's generated hook wrapper calls `<worker payload> pi-hook --socket ...`;
- both tmux drivers launch through
  `<worker payload> tmux-launch --launch-file ...`.

Use the executing payload (`process.execPath`), not the outer launcher, so every
helper remains the exact compiled payload whose `broker.hello` identified the
release. Quote it with the existing shell helpers. No bare `harness-broker`,
`exec bun /$bunfs/...`, checkout path, `current` link, or ambient helper PATH is
allowed in generated settings, wrappers, or pane launch lines.

`harness-broker-pi` threads the same helper launcher because its composition
also contains the stock driver set, even though this task selects it only for
`pi-sdk`.

### 3.4 Claude statusline asset closure

Stage the exact `spaces-harness-claude` statusline asset under the immutable
release root, include its path and digest in inspected release metadata, and
make the release aspd compiler supply that explicit source path to the Claude
adapter. The adapter gains an optional injected statusline source; checkout and
published-package construction keep the current package-relative default.

The release compiler must derive the source from its verified release binding,
not from ambient PATH, `import.meta`, a checkout, or caller input. The adapter
still copies the bytes into the materialized Claude bundle and writes the
bundle-local absolute command (`bash <bundle>/statusline.sh`) into
`settings.json`; rotation therefore cannot leave a durable reference to a
retired release. The copy is required for a release build: missing/digest-wrong
release asset is a compile failure, not the current best-effort warning. The
best-effort behavior remains only for non-release/package compatibility.

MCP files remain user/space-authored configuration. A real fixture containing
an MCP declaration must be materialized and scanned to prove this task adds no
release, checkout, PATH helper, or `/$bunfs` path to it.

## 4. Preserved behavior and exclusions

- The seven ASPC compile verbs, `aspc/0.1`, broker protocol negotiation,
  `dispatchRequest`, profile/start hashes, event semantics, admission classes,
  and HRC hosting authority are unchanged. The only response-shape addition is
  optional `executionRelease.worker.hostedDrivers`; no verb, envelope, union
  arm, or protocol version changes.
- Native `claude`, `pi`, and Codex binaries, credentials, agent/project roots,
  mutable ASP content, and per-run state remain explicit external inputs; the
  helper-closure rule does not move those native executables into the ASP
  release.
- `claude-code-tmux` and `pi-tui-tmux` retain their current admission and
  evidence behavior. This task changes only how their ASP-owned helpers are
  located.
- `pi-sdk` stays an in-process driver; do not package or launch the direct
  adapter's import-meta `RUNNER_PATH` for this broker route.
- `codex-cli-tmux` remains deprecated in place with no new release binding and
  no retirement.
- No automatic release deletion. Retain every release referenced by a prepared
  operation, live execution, or unresolved recovery.
- A binding-table-absent retained release remains activatable and can serve new
  preparations with its historical compiled behavior. The producer refusal and
  hosting evidence specified here apply only to releases built with this
  change; T-08562 supplies the later fail-closed consumer rule for non-Codex
  launches with absent evidence.
- The stale active `agent-spaces.agent-harness-runtime-boundary` record is a
  producer-owner follow-on from T-08558 Q5. Reconcile it separately; do not
  expand this implementation to revive or remove agent-harness paths.

## 5. Implementation validation

Before real turns, run build, typecheck, lint, boundary/manifests checks, the
affected unit/integration tests, release build/inspect, and the required
harness-broker MATRIX from a real Ghostty terminal through `ghostmux`. This is
an isolated-task gate, not authorization for `just install` or shared service
activation.

Every proof below runs against installed immutable artifacts in a new task
namespace, with isolated ASP home, sockets, ledgers, tmux server/socket, agent
roots, project root, and client state. Record release IDs, source commits,
payload digests, aspd PID/socket/log, worker PIDs/sockets, tmux server/session/
window/pane IDs, native child PIDs, and teardown results. The T-08561 direct
worker executes all isolated proofs. Mable independently reviews evidence and
owns any later shared max3 activation, which is outside this task.

| Proof | Executor | Action and required observation command |
| --- | --- | --- |
| Reproduction baseline | T-08561 direct worker | Run the retained `probes/driver-path-probe` and compiled-aspd preparations at `90dd7508`; preserve the exact `/$bunfs`, bare-PATH, missing-statusline, and wrong Pi-worker outputs before implementation. |
| Release build/inspection | T-08561 direct worker | `just build-asp-release <A-build>` then `just install-asp-release <A> <ns>/releases` and `just inspect-asp-release <ns>/releases/<A>`; inspect `release.json`, `sha256`, `<release>/harness-broker{,-pi} --release-info`, and each `drivers --json`. Both worker payloads report A; the new binding table and asset digest validate. Separately inspect and activate a retained pre-T-08561 v1 release, verify its manifest/payload is unchanged and its compile response omits `hostedDrivers`, and record that its own compiled semantics remain in force. Do not launch a legacy non-Codex preparation. |
| Claude real turn | T-08561 direct worker | Prepare via isolated aspd, assert `hostedDrivers` contains `claude-code-tmux`, persist, launch selected worker, handshake, start, and send a unique real Claude prompt through the broker/pane. Observe `broker.hello.release`, `ps -axo pid,ppid,command`, `tmux -S <socket> list-panes -a -F ...`, generated `*.settings.json`, `*.launch.json`, bundle `settings.json`, and ledger events. Worker/helper argv is under A; native Claude is the explicit configured external path; marker completes. |
| Pi TUI real turn | T-08561 direct worker | Same flow with a real Pi scope and prompt, first asserting `hostedDrivers` contains `pi-tui-tmux`. Observe worker hello, process tree, pane command, generated `*.pi-hook.ts`/`*.pi.launch.json`, bundle, and ledger. Worker/hook/runner are under A; native Pi is the explicit configured path; marker completes. |
| Pi SDK real turn | T-08561 direct worker | Prepare non-interactive `pi-sdk`, verify `worker.executable=<A>/harness-broker-pi` and `hostedDrivers` contains `pi-sdk`, launch/hello/start, and send a unique prompt. Observe `broker.hello`, `broker.listInvocations`, `ps -axo pid,ppid,command`, and ledger. There is no runner child/argv; the in-process driver completes the marker under A. |
| Complete helper closure | T-08561 direct worker | For all three attempts, scan the persisted preparation, release manifest, bundle tree, Claude hook settings, Pi wrapper, launch JSON, pane commands, and process tree with `rg -n '/\$bunfs|under-construction|/agent-spaces/|harness-broker|tmux-launch-runner' <evidence-paths>`. Every `harness-broker`/helper match must resolve beneath recorded A; the bad-path patterns have zero matches. Native executable paths are separately allowlisted and recorded. Confirm Claude `statusline.sh` digest equals A's asset and MCP fixture config contains only its declared native/external values. |
| Unhosted-driver refusal | T-08561 direct worker | Use a compiled fixture compiler that returns one valid broker profile named `unhosted-probe` against a real inspected A binding, call `aspc.compileHarnessInvocation`, and capture the exact `release_worker_driver_unavailable` failure envelope. Record `pgrep`/process-tree and worker socket directory before/after: no worker, tmux pane, or native harness is created. Also test a manifest binding to an executable whose `drivers --json` omits that driver is rejected by release inspection. |
| Codex regressions | T-08561 direct worker | Repeat one real isolated headless Codex turn and one real isolated `codexTui` turn through A. Assert the new release's headless response lists `codex-app-server` in `hostedDrivers`; observe otherwise unchanged selected driver/protocol, hello identity, renderer/wrapper/hook/runner paths under A, pane/process argv, marker, and normalized terminal events. Diff persisted start/dispatch payloads against the pre-change fixture excluding identities/paths/hashes justified by release identity. Also perform a Codex turn after activating the retained release with `hostedDrivers` absent, proving historical rollback behavior remains usable. |
| Upgrade A→B | T-08561 direct worker | Reuse `docs/aspd.md` acceptance shape with one fixed compiled pilot client and two newly built binding-aware releases: run live A workers for Claude, Pi TUI, Pi SDK and Codex; save a never-started A preparation; activate inspected B; verify old connection admission closes, new preparations/hellos are B, all live A workers still turn, and saved A preparation launches A while B serves. Observe `just aspd-status <ns>`, activation log, client state, worker hellos, process/pane argv, and per-driver markers. Then activate the retained pre-T-08561 release, verify a Codex preparation/turn succeeds with the field absent, and record that the historical producer has its original semantics; do not launch a legacy non-Codex preparation. Reactivate B for teardown. |
| aspd outage | T-08561 direct worker | Stop isolated aspd with A/B workers live. A new preparation must report service unavailability with no facade/source/PATH fallback; existing A/B workers complete another real turn. Restart via the namespaced recipe and verify `runningEqualsSelected`. Observe `just aspd-status <ns>`, socket absence/presence, worker PIDs before/after, hellos and markers. |
| Teardown | T-08561 direct worker | Stop every worker through broker control, terminate native children, kill only the recorded isolated tmux server, `just aspd-stop <ns>`, and verify all recorded PIDs dead and sockets absent. Retain release/evidence files; do not touch shared max3 processes or namespaces. |

No test-only shim counts as a real-turn proof. The compiled fixture is allowed
only for the otherwise-unreachable unhosted-driver refusal.

## 6. Documentation and invariant updates

Implementation must update these now-stale sentences in the same commit set:

- `docs/aspd.md`: workers are not only the singular existing
  `harness-broker` (lines 10–12); the bounded path is no longer Codex-only
  (14–16); `worker.executable` is not necessarily the `harness-broker` launcher
  (42–46); release helper closure must add Claude/Pi/statusline beside the Codex
  paragraphs (53–67); external inputs must include explicit native Claude/Pi
  executables (187–193); and “One route… Other harnesses… out of scope” is
  superseded (203–208). Add the producer refusal and binding/asset inspection
  rules to preparation and acceptance. Document optional
  `executionRelease.worker.hostedDrivers`, historical releases' unchanged
  compiled semantics, and T-08562's later non-Codex consumer admission rule.
- `contracts/aspc-protocol/src/types.ts:127`: replace “Absolute
  `harness-broker` launcher” with “absolute selected release worker launcher”
  and add the single optional `hostedDrivers?: string[]` property to `worker`,
  documented as the selected executable's declared release bindings.
- `docs/standalone-asp-releases.md`: the fixed three-launcher release-root
  inventory and two `--release-info` examples are incomplete once
  `harness-broker-pi` and immutable assets are present; matrix wording must
  acknowledge per-profile worker selection.
- `docs/harness-architecture.md`: refresh the incomplete stock driver list and
  the `harness-broker-pi` migration wording to say the compatibility worker is
  release-packaged and selected per preparation.
- `agent-spaces.codex-tui-app-server-presentation.yaml`: no semantic amendment;
  retain the explicit `codex-cli-tmux` deprecation sentence and Codex required
  tests. Add only a source/evidence reference if local record convention
  requires it.
- `agent-spaces.harness-broker-admission.yaml` and
  `agent-spaces.harness-broker-turn-evidence.yaml`: no predicate change. Their
  driver capability/evidence matrix remains mandatory for the real Claude/Pi
  regression runs.
- `agent-spaces.agent-harness-runtime-boundary.yaml`: stale after T-08537/
  T-08538 and T-08558 Q5, but reconciliation is an explicit follow-on, not part
  of T-08561.

## 7. Completion evidence and delivery

The implementer records source commit/push, exact release identities, manifest
and asset digests, validation commands, real-turn markers, process/pane
identities, refusal envelope, A→B/outage results, retained releases, and cleanup
in the task artifact directory and final wrkq comment. Completion requires a
pushed commit and the isolated installed acceptance above. It does not include
shared max3 activation or downstream producer advancement.

The producer release for T-08561 is built, installed into its task namespace,
and inspected only in isolation. Shared max3 activation, `just install`, and
any HRC `pull-deps` belong to Mable and are sequenced on the supervisor ledger
T-08571; none is an implementation-task completion step.

## 8. Open review questions

No implementation fact remains unresolved. Daedalus ruled the new diagnostic
value plus success-to-refusal tightening additive within the existing
open-string failure envelope. The remaining review classification is additive
`release.json` worker-binding/asset metadata under manifest schema v1 plus the
single optional additive response field
`executionRelease.worker.hostedDrivers`. Neither adds a verb, union arm, or
protocol version. New producer releases enforce their binding table and emit
positive evidence; retained releases keep their compiled behavior and may omit
it. T-08562 makes that evidence a consumer admission requirement for non-Codex
aspd launches while preserving legacy Codex admission. The inspector validates
new builds only; it is not an enforcement point. If Daedalus requires a
manifest schema bump, revise this document only after supervisor review; do not
infer one in code.
