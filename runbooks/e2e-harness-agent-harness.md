# Runbook — Native agent-harness release worker e2e

End-to-end verification for the first-party `agent-harness` and
`agent-harness-tmux` drivers after T-08680. This runbook tests the architecture,
not only model output: aspd must select one immutable release executable, that
worker must speak the standard broker protocol directly, and interactive mode
must not use `agent-harness-control/v1` or launch a TUI child.

**Validation status:** blocked before first successful run. Earendil 0.86.1
retains build-host Photon/esbuild paths in the compiled worker and its
`InteractiveMode` has no non-exiting embedded lifecycle. Do not mark this
runbook validated until both fixed points pass.

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

Stop here if the inspector finds Photon, esbuild, the agent-spaces checkout, or
another build-host absolute path. A successful `drivers --json` alone does not
prove a shippable worker.

## 2. Install and start an isolated aspd namespace

```sh
just aspd-init "$AH_E2E_NS"
just install-asp-release "$RELEASE" "$AH_E2E_NS/releases"
just aspd-start "$AH_E2E_NS"
just aspd-status "$AH_E2E_NS" | tee "$AH_E2E_ROOT/aspd-status.json"
```

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

## 5. Interactive real tmux proof

Create a real tmux surface and launch the exact returned worker itself as the
pane process, keeping its Unix broker socket reachable. Do not paste
`agent-harness tui`, a runner, or a control-socket argument into the pane.

Start the frozen `agent-harness-tmux` invocation over the ordinary broker
socket. Then perform, in order:

1. Submit a broker input requesting exact sentinel `BROKER-TURN`.
2. Type an operator prompt in the TUI requesting exact sentinel
   `OPERATOR-TURN`.
3. Detach and reattach the tmux client.
4. Enter `/quit` in the TUI.
5. Query the broker and then issue broker stop.

Pass only if:

- the pane process is the immutable release worker, not a TUI child;
- `terminal.surface.reported` names the leased surface;
- broker and operator prompts use one invocation identity and one gap-free
  sequence;
- each prompt has exactly one turn bracket and one terminal;
- no frame, socket, argv, event, or log contains
  `agent-harness-control/v1`, `--broker-control-socket`, `session.config`, or
  `turn.begin`;
- `/quit` restores the terminal and returns from the embedded presentation
  without disposing Pi or exiting the broker;
- the broker answers after `/quit` and exits only on broker stop; and
- detach/reattach does not change broker identity or continuation.

The current `scripts/agent-harness-tmux-integration-e2e.ts` is historical until
rewritten: it deliberately tests the retired child/control-socket topology and
must not be accepted as T-08680 evidence.

## 6. Regression gates

After the two real turns:

```sh
bun run build
bun run typecheck
bun run lint
bun run check:boundaries
bun run check:manifests
just architecture-records
bun run test
```

Run the `agent-harness-tmux` harness matrix row from a real Ghostty terminal and
run the published CLI pack smoke. Existing Codex, Claude, generic Pi, Muse,
Arris, Desktop, and direct foreground `asp run` rows must remain green.

## 7. Cleanup

```sh
just aspd-stop "$AH_E2E_NS"
just aspd-status "$AH_E2E_NS" | tee "$AH_E2E_ROOT/aspd-stopped.json"
```

Require no running aspd process, no serving RPC, no broker socket, and no live
tmux pane or worker PID. Retain the immutable release and evidence directory;
do not activate this namespace in production.
