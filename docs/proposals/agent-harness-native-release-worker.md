# Native release worker for agent-harness

- **Status:** accepted by owner ruling (Lance, corrected 2026-09-21)
- **Tracking:** T-08680
- **Architecture authority:** `agent-spaces.agent-harness-runtime-boundary`

## Decision

`agent-harness` and `agent-harness-tmux` are registered drivers hosted by one
identity-bound executable in an immutable ASP release. aspd selects that
executable through explicit release bindings and returns it in
`executionRelease.worker.executable`. HRC launches it generically. HRC does not
gain an agent-harness registry branch, select a binary from PATH, import the
runtime, or speak an agent-harness-specific protocol.

Both frozen profiles use `process.execution: "native-worker"` and
`harnessTransport.kind: "native-worker"`, with no process command or arguments.
Those fields describe the HRC-to-release-worker boundary. They do not prohibit
a registered driver from launching a worker-local child.

```text
headless
  HRC -> exact release worker -> agent-harness driver -> Pi runtime

interactive
  HRC -> exact release worker -> agent-harness-tmux driver
                              -> same release executable as TUI child in HRC pane
                              <-> Unix socket, standard harness-broker protocol
```

The earlier amendment incorrectly removed the whole interactive child/socket
topology when only the legacy `agent-harness-control/v1` protocol had been
approved for removal. This correction restores the child and socket without
restoring that private protocol.

## Interactive ownership

The outer release worker is the durable endpoint HRC launches. Its registered
interactive driver:

1. consumes the HRC-supplied `terminalSurface` pane lease;
2. launches the same immutable release executable in that pane with a
   worker-local `tui-child` role;
3. connects to the child's Unix broker endpoint;
4. calls `broker.hello` and requires the `agent-harness-tmux` inventory plus an
   exact match to the outer worker's embedded release identity;
5. uses only standard `invocation.start`, `invocation.input`,
   `invocation.interrupt`, `invocation.stop`, `invocation.dispose`, permission
   requests, and `invocation.event`; and
6. re-sequences accepted child events through the outer real `DriverContext`.

The child registers a leaf `agent-harness-tmux` driver, creates the shared
first-party runtime, and owns Pi `InteractiveMode`. Broker-delivered and
operator-entered turns therefore pass through one Pi session and one child-side
mapper. The outer driver filters the child broker's duplicate delivery bracket;
the outer broker owns that HRC-facing bracket. Operator turns have no broker
input id and are relayed once.

There is no session projection, `turn.begin`, acknowledgement frame, surrogate
context, hook bridge, or extension-owned wire protocol. A small Pi extension is
permitted only to observe clean shutdown and give the standard socket write a
chance to drain.

Pi 0.86.1 may call `process.exit()` on `/quit` and fatal paths. That is safe
because Pi runs only in the child. A clean leave or crash can end the child but
cannot end the outer release worker. The outer driver reports the child fate
and remains available for broker lifecycle handling.

## Compiler and release authority

ASPC continues to own semantic lowering. Headless intent selects
`agent-harness` without a terminal. Interactive intent selects
`agent-harness-tmux` with an HRC-owned tmux terminal surface. Both carry the
semantic agent block and Pi SDK model/auth binding under the invocation hash.

The release manifest binds both names to the same executable. Release
inspection proves the embedded identity, digest, hermetic closure, inventory,
and binding table. `hostedDrivers` is derived only from that table. Missing or
mismatched evidence fails preparation before HRC launches anything.

## Verification fixed points

Completion requires durable evidence for:

1. both valid native-worker profiles and rejection of serialized child argv or
   private transport declarations;
2. one identity-bound executable, explicit dual bindings, and positive
   `hostedDrivers`;
3. `drivers --json` reporting both outer drivers available;
4. a child `broker.hello` with the same release identity and only standard
   broker methods/events;
5. a real HRC-style tmux pane lease where the exact child completes one
   broker-driven turn and one operator-driven turn exactly once;
6. standard interrupt, stop, dispose, permission, continuation, and child-crash
   behavior;
7. `/quit` exiting the child while the outer worker remains responsive; and
8. installed immutable-release, pack, boundary, type, unit, and real-terminal
   harness matrix validation.

Foreground `asp run` TUI/print remains separate. Existing Codex, Claude,
generic Pi, Muse, Arris, and Desktop contracts remain unchanged.
