# Runbook — Native agent-harness release worker e2e

End-to-end verification for the first-party `agent-harness` and
`agent-harness-tmux` drivers after T-08680. This runbook tests the architecture,
not only model output: aspd must select one immutable release executable, that
worker must speak the standard broker protocol directly. The interactive
driver consumes a tmux pane lease and launches a child of the same release
executable with `--agent-harness-role tui-child`. Parent and child communicate
over the standard broker protocol, not a private relay.

**Review status (2026-10-18):** source and the installed release driver inventory
report `agent-harness` and `agent-harness-tmux` available. Interactive execution
uses the child topology described above; the earlier unavailable-driver
baseline is obsolete. This documentation review did not run model turns or
exercise tmux lifecycle. The steps below define the evidence needed for a new
full e2e claim. Photon remains a digested sibling release asset.

## Safety and prerequisites

- Run from a clean, pushed agent-spaces commit. The release builder refuses a
  dirty or unpushed main checkout.
- Use an isolated absolute namespace under the task artifact directory. Never
  activate the production aspd namespace.
- `tmux`, `jq`, Bun, real OpenAI OAuth credentials, and a valid test agent must
  be available.
- Run the interactive section from a real terminal through ghostmux. Do not run
  it inside a nested Claude session.
- Retain the release inspection, preparation JSON, broker events, pane capture,
  process tree, and cleanup readback under the task artifact directory.

Example roots:

```sh
export AH_E2E_ROOT=/Users/lherron/praesidium/var/wrkq-artifacts/T-08680/e2e
export AH_E2E_NS="$AH_E2E_ROOT/ns"
mkdir -p "$AH_E2E_ROOT"
```

## 1. Build and inspect the immutable release

```sh
just build-asp-release "$AH_E2E_ROOT/build"
find "$AH_E2E_ROOT/build" -maxdepth 1 -type d -name 'asp-*' -print
just inspect-asp-release "$AH_E2E_ROOT/build/<release-id>" \
  | tee "$AH_E2E_ROOT/release-inspection.json"
```

The inspection must prove all of the following:

- `agent-harness` is identity-bound and resolves inside the release;
- both `agent-harness` and `agent-harness-tmux` bind explicitly to that one
  executable;
- the executable's real `drivers --json` advertises both names;
- payload digests and embedded release identity match; and
- `mutableCheckoutReferences` is `false`.

Independent readback:

```sh
RELEASE="$AH_E2E_ROOT/build/<release-id>"
"$RELEASE/agent-harness" --release-info | tee "$AH_E2E_ROOT/worker-release.json"
"$RELEASE/agent-harness" drivers --json | tee "$AH_E2E_ROOT/worker-drivers.json"
jq '[.[].kind] | sort' "$AH_E2E_ROOT/worker-drivers.json"
```

Stop here if the inspector finds an absolute Photon/esbuild path, the
agent-spaces checkout, another build-host path, or either bound driver is
absent. Both `agent-harness` and `agent-harness-tmux` must report available.
Inventory and binding checks prove registration and ownership; they do not
replace the invocation and lifecycle checks below.

## 2. Install and start an isolated aspd namespace

```sh
just aspd-init "$AH_E2E_NS"
just install-asp-release "$RELEASE" "$AH_E2E_NS/releases"
just aspd-activate "$AH_E2E_NS" "$(basename "$RELEASE")"
just aspd-status "$AH_E2E_NS" | tee "$AH_E2E_ROOT/aspd-status.json"
```

Standalone activation is performed by Mable primary or Lance under the service
ownership rule. Installation only stages bytes; `aspd-start` cannot select the
first release in a fresh namespace. Run later worker commands from the installed
copy by setting `RELEASE="$AH_E2E_NS/releases/$(basename "$RELEASE")"`.

Require `runningProcess`, RPC `serving`, and `runningEqualsSelected: true`.
Installed or selected state without those three observations is not a live
daemon.

## 3. Prepare both routes through aspd

Compile the same semantic agent declaration twice through the real aspd RPC:
noninteractive and interactive. Save both complete responses.

The headless response must contain:

```text
profile = nonInteractive
spec.harness.driver = agent-harness
spec.process.execution = native-worker
spec.process.harnessTransport.kind = native-worker
spec.process.command and args absent
spec.interaction.mode = headless
spec.runtime.terminalSurface absent
executionRelease.worker.executable = <RELEASE>/agent-harness
executionRelease.worker.hostedDrivers includes agent-harness
```

The interactive response must differ only where presentation requires:

```text
profile = interactive
spec.harness.driver = agent-harness-tmux
spec.process.execution = native-worker
spec.process.harnessTransport.kind = native-worker
spec.process.command and args absent
spec.interaction.mode = interactive
spec.driver.terminalHost = tmux
executionRelease.worker.executable = <RELEASE>/agent-harness
executionRelease.worker.hostedDrivers includes agent-harness-tmux
```

For both responses verify semantic agent/project roots, run mode,
scope/lane/run/host-session/generation identities, declared and resolved model,
reasoning level, OAuth provider binding, permission policy, continuation, and
invocation hash inputs. A missing binding must return
`release_worker_driver_unavailable` before `executionRelease` and before any
worker or pane exists.

## 4. Headless real turn

Launch exactly the returned executable with the ordinary release-worker argv:

```sh
"$(jq -r '.executionRelease.worker.executable' headless-preparation.json)" \
  run --transport unix --socket "$AH_E2E_ROOT/headless.sock"
```

Through the standard broker client, start the frozen headless spec and submit:

```text
Reply with exactly HEADLESS-AGENT-HARNESS and nothing else. Do not use tools.
```

Save the NDJSON stream. Pass only if:

- `broker.hello` release identity matches the inspected release;
- the final text is exact;
- one turn starts and reaches exactly one terminal;
- event `seq` starts at 1 and is gap-free and monotonic;
- continuation is reusable for a second turn;
- interrupt remains ack-backed; and
- the worker process tree contains no agent-harness child.

## 5. Interactive lifecycle proof

Use a real terminal through ghostmux and a valid isolated tmux pane lease.
Start the returned interactive spec through its selected release worker. The
outer driver launches the same executable in that pane as a `tui-child` broker;
the child owns Pi and `InteractiveMode`.

Capture the parent/child process tree, standard broker handshake, pane output,
and outer invocation events. Require one outer invocation identity and a
gap-free outer event sequence across broker and operator input. Broker-delivered
turn brackets must not be duplicated by child forwarding. Exercise interrupt
and `/quit`: a clean child exit clears continuation with `prompt_input_exit`
and exits the outer invocation without reporting an unexpected disconnect.
Confirm no child, pane lease, or socket remains after cleanup. A single-process
assertion applies only to the headless route.

## 6. Regression gates

After the release proof, headless real turn, and interactive lifecycle proof:

```sh
bun run build
bun run typecheck
bun run lint
bun run check:boundaries
bun run check:manifests
just architecture-records
bun run test
```

Run the applicable interactive matrix coverage from the broker guidance and
the published CLI pack smoke. Existing Codex, Claude, generic Pi, Muse,
Arris, Desktop, and direct foreground `asp run` rows must remain green.

## 7. Cleanup

```sh
just aspd-stop "$AH_E2E_NS"
just aspd-status "$AH_E2E_NS" | tee "$AH_E2E_ROOT/aspd-stopped.json"
```

Require no running aspd process, no serving RPC, no broker socket, and no live
tmux pane or worker PID. Retain the immutable release and evidence directory;
do not activate this namespace in production.
