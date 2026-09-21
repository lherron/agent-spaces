# Native release worker for agent-harness

- **Status:** accepted by owner ruling (Lance, 2026-09-21); the single
  owner-permitted Daedalus advisory pass found one conflicting historical
  `turn.begin` clause, reconciled in the canonical records
- **Date:** 2026-09-21
- **Author:** astra@agent-spaces
- **Tracking:** T-08680
- **Architecture authority:** `agent-spaces.agent-harness-runtime-boundary` and
  `agent-spaces.aspd-release-worker-hosting`
- **Supersedes:** the broker-child topology in
  `docs/proposals/agent-harness-hrc-interactive.md`

## Decision

`agent-harness` and `agent-harness-tmux` are two drivers hosted by one
identity-bound, immutable-release `agent-harness` executable. In both modes HRC
launches exactly `executionRelease.worker.executable` returned by aspd and
talks ordinary `harness-broker/0.2` to that worker. HRC does not register either
driver, build either plan, import agent-harness code, or select a binary from
PATH.

The two modes differ only in presentation:

```text
headless
  HRC -> release/agent-harness -> agent-harness driver -> Pi runtime

interactive
  HRC -> release/agent-harness in leased tmux pane
       -> agent-harness-tmux driver -> Pi runtime + embedded TUI
```

The interactive worker owns the broker server, Pi runtime, TUI, broker input,
operator input, invocation identity, and event sequence in one process. It does
not launch `agent-harness tui` as a child. `agent-harness-control/v1`, its Unix
socket, session projection, turn handshake, acknowledgement frames, surrogate
driver context, event relay, and second sequencer are retired.

This is the same *outer* boundary as `codex-app-server`: aspd selects a frozen
release worker and HRC hosts it generically. It deliberately does not copy the
Codex worker's internal JSON-RPC child. That adapter exists because Codex source
is external; agent-harness is first-party and emits broker events directly.

## Thin-contract shape

The process member of an agent-harness invocation describes worker-local
runtime configuration, not the executable HRC must launch. The executable has
one authority: `executionRelease.worker.executable`.

Add a closed native-worker alternative:

```ts
type HarnessProcessSpec = ChildHarnessProcessSpec | NativeWorkerProcessSpec;

interface NativeWorkerProcessSpec {
  execution: "native-worker";
  cwd: string;
  lockedEnv?: Record<string, string>;
  pathPrepend?: string[];
  limits?: ProcessLimits;
  harnessTransport: { kind: "native-worker" };
  command?: never;
  args?: never;
}
```

`native-worker` means the already-external, release-owned worker directly owns
the selected driver and serves the standard broker protocol. It is not an IPC
transport and it does not mean HRC-local execution. Both agent-harness drivers
require this shape. They reject `in-process`, `pty`, `jsonrpc-stdio`, a command,
arguments, or a private control-protocol declaration. Existing uses of those
shapes are unchanged.

The runtime vocabulary gains `agent-harness` under the Pi family, separate
from generic `pi-sdk`. The invocation still carries an `sdk` block with
`runtime: "pi-sdk"` because that block describes the model API used inside the
first-party runtime; it does not select the outer worker or collapse the route.
Both driver specs also require the semantic `agent` block.

- noninteractive intent lowers to driver `agent-harness`, interaction
  `headless`, and no broker terminal;
- interactive intent lowers to driver `agent-harness-tmux`, interaction
  `interactive`, and an HRC-owned tmux terminal surface.

`agent-harness-tmux` may not request `ask-client` permission policy because no
broker-mediated approval surface is defined for the TUI. No feature flag or
fallback route exists.

## Compiler and preparation authority

ASPC interprets the mutable declaration and emits the complete hash-covered
profile. It preserves semantic agent/project roots, run mode, scope/lane/run
and host-session identities, generation, declared model, resolved qualified
Pi SDK model/provider/auth binding, reasoning level, permission policy, and
continuation inputs.

aspd resolves only an inspected binding from the selected immutable release.
The release binds both drivers to `agent-harness`; `hostedDrivers` is the sorted
positive set derived from that binding table. Missing binding, inventory,
identity, digest, or release-local path proof fails before execution release is
returned. There is no registry inference or executable fallback.

HRC remains authoritative for placement, terminal lease, worker lifecycle,
routing, and durable messaging. For the interactive route HRC must start the
exact worker itself inside the leased pane while preserving its ordinary Unix
broker endpoint. That generic hosting change is downstream HRC work; it does
not grant HRC agent-harness-specific planning or registry authority.

## Worker composition

The headless driver continues to compose the shared Pi driver with
`createResolvedAgentSession`. The interactive driver uses that same session,
permission bridge, mapper, and lifecycle authority, adding an embedded
presentation hook. Broker-submitted turns call the session directly. Operator
submissions observed from the TUI mint a turn only when no broker turn is
active, then use the same real `DriverContext` and mapper. Exactly one component
allocates event sequence numbers.

The TUI lifecycle must be embeddable. Earendil 0.86.1's current
`InteractiveMode.shutdown()` disposes its runtime and calls `process.exit`, and
its fatal handlers can exit the host. It therefore cannot be invoked unchanged
inside the broker worker. Before interactive cutover, the Pi surface must
provide a non-exiting lifecycle that:

- returns on `/quit`, Ctrl-D, or clean operator leave;
- restores the terminal and unregisters its signal/fatal handlers;
- does not call `process.exit`;
- leaves runtime disposal to the broker driver; and
- reports clean presentation exit to the driver.

A global `process.exit` monkeypatch, copied private Pi loop, or retained child
protocol is not an acceptable substitute. Until this lifecycle exists, the
headless route and release closure can be implemented and proven, but the
interactive cutover is not complete.

## Release fixed point

The standalone release adds an identity-bound `agent-harness` entry and binds
both driver names to it. Its embedded identity is supplied to `runBrokerCli`,
so `broker.hello`, `--release-info`, manifest identity, and digest agree.
`drivers --json` must advertise both names.

The release payload scan is an early gate. The prior compiled Pi worker leaked
build-host paths through Photon/esbuild; no deep-import alias workaround is
accepted. If the dedicated executable does not pass the existing hermetic
closure inspection, compiler exposure stops until its actual dependency path
is made releasable.

## Verification

Completion requires:

1. Schema and execution-profile tests for both valid native-worker shapes and
   rejection of child, in-process, terminal-mode, SDK/agent, permission, and
   driver/profile mismatches.
2. Compiler and inspection tests proving one `agent-harness` declaration
   produces the two interaction-selected drivers without falling through to
   Codex or generic Pi SDK.
3. Standalone release inspection proving embedded identity, immutable digests,
   hermetic closure, dual inventory, explicit dual bindings, and positive
   `hostedDrivers`.
4. A real isolated aspd preparation and headless broker turn from the exact
   returned executable.
5. A real tmux run in which that same worker serves standard broker traffic,
   accepts one broker input and one operator input, emits one monotonic event
   sequence, exits the TUI without exiting the broker, and remains controllable
   until broker stop.
6. The harness matrix row from a real terminal, the packed CLI smoke, and full
   repository validation.

Direct foreground `asp run` TUI/print remains a separate local surface.
Codex, Claude, generic Pi, Muse, Arris, and Desktop contracts remain unchanged.
