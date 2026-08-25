# HRC-operated agent-harness interactive TUI

- **Status:** proposed; submitted to Daedalus for verification
- **Date:** 2026-08-25
- **Author:** clod@agent-spaces
- **Tracking:** (campaign to be derived on approval)
- **Architecture authority:** `agent-spaces.agent-harness-runtime-boundary`
- **Supersedes scope in:** `docs/proposals/agent-harness.md` (two-outer-surface clause)

## Decision

Add a third outer surface to the direct `agent-harness` runtime: an interactive
Pi TUI launched and owned by HRC inside a broker-leased tmux pane, exposed as
`hrc run <agent>`. It reuses the same runtime factory as the other two surfaces
and participates in the HRC event stream through the same event mapper the
headless broker service already uses.

Concretely: a new `agent-harness-tmux` broker driver, a direct structural analog
of the existing `pi-tui-tmux` driver, plus the HRC admission, contract, and plan
plumbing required to route an `agent-harness` intent to it.

## Problem

`asp run sparky` starts the Pi TUI. `hrc run sparky` fails:

```
hrc: cannot run "sparky": interactive runtime is not broker-admissible
  route: interactive-broker
```

The failure originates at `hrc-server/src/runtime-io-handlers.ts:499`.
`resolveInteractiveBrokerAdmissionDriver`
(`hrc-server/src/broker-decisions.ts:462-508`) admits exactly three interactive
drivers, each keyed on harness id: `claude-code`, `codex-cli`, and `pi`/`pi-cli`.
Sparky's profile declares `harness = "agent-harness"`, which
`core/config/src/core/types/harness.ts:64` registers as
`provider: openai, transport: sdk`, with **no** `frontend`. No frontend means no
interactive identity, so nothing matches and the guard throws.

### What already works (verified, not assumed)

Headless `agent-harness` under HRC is functional. A live DM to
`sparky@agent-spaces:primary` on 2026-08-25 returned the requested sentinel
(`hrcchat#20884`). That path works because:

- `hrc-server/src/broker-headless-handlers.ts:473` special-cases
  `harness.id === 'agent-harness'`,
- `hrc-server/src/agent-spaces-adapter/direct-agent-harness.ts` hand-builds an
  in-process `BrokerExecutionProfile` rather than compiling one, and
- `hrc-server/src/broker-interactive-handlers/substrate-allocator.ts:133`
  resolves the broker binary for driver kind `agent-harness` to the
  **`agent-harness` executable**, which is the only broker process that
  registers the `agent-harness` driver
  (`harness/agent-harness/src/cli.ts:24`). The stock `harness-broker` binary
  does not (`harness/harness-broker/src/default-broker.ts:42-46`).

`asp run sparky` works for an unrelated reason: `apps/cli/src/commands/run.ts:129`
builds a *direct foreground plan* that execs `agent-harness tui …` as a child
process. It bypasses the compiler, the broker, the invocation spec, and the event
stream entirely. Nothing about that path is reusable by HRC.

## Invariant impact

`agent-spaces.agent-harness-runtime-boundary` currently fixes:

> The direct runtime has two outer surfaces: local foreground TUI/print
> execution selected by `asp run`, and the HRC-operated `agent-harness` broker
> service; both use the same runtime factory.

This proposal extends that to **three** outer surfaces. The third is the
HRC-operated interactive TUI. All three continue to use one runtime factory
(`createAgentHarnessRuntime`).

Two clauses this proposal deliberately does **not** touch:

1. *"foreground `asp run` is a separate local session and does not attach to an
   existing HRC runtime."* Unchanged. HRC **launches a fresh TUI it owns**; it
   never adopts a foreground session. The `agent-harness.md:97` non-goal
   ("attaching a foreground TUI to an already running HRC broker session")
   likewise stands unreversed — nothing here attaches.
2. *"Broker-selected auth path, provider, mode, and composed environment bind
   the shared `ModelRuntime` before model lookup and session creation, without
   fallback to the foreground auth store."* This binds the new surface: see D5.

The invariant's *"broker wire/process topology … remain implementation choices"*
clause covers D2 and D3 without amendment.

## Design

### D1 — New driver kind `agent-harness-tmux`

A new interactive tmux driver at
`harness/harness-broker/src/drivers/agent-harness-tmux/`, structurally mirroring
`pi-tui-tmux`: tmux pane lease consumption, `terminal.surface.reported`,
paste-then-delayed-Enter input submission, Esc-based interrupt, pane dispose on
stop.

Capabilities match `pi-tui-tmux`: `input.user: true`, `input.steer: false`,
`turns.concurrency: 'single'`, `continuation.supported: true`,
`control.attach: true`, `driverAttachExistingSurface: false`.

The driver kind is distinct from the existing `agent-harness` (in-process,
service-mode) kind. One harness, two driver kinds, exactly as `pi` has
`pi-sdk` and `pi-tui-tmux`.

### D2 — Event egress: the TUI emits mapped broker events

The existing three tmux drivers observe their harness through a hook bridge:
the harness process shells out to a bridge CLI which posts an envelope to a
driver-owned socket, and the driver normalizes it. For `pi-tui-tmux` this
requires the `asp-hrc-events.bridge.js` Pi extension generated by
`drivers/harness-pi/src/adapters/pi-adapter.ts:553`.

`agent-harness` cannot use that: it consumes no adapter lowering and no
generated bundle, by invariant. It also does not need to — the TUI is
first-party and already holds the live `AgentSession`.

**Design:** the driver creates a unix socket and passes its path to the TUI
process as `--broker-events-socket <path>`. In broker mode the TUI constructs a
`PiSdkTurnEventMapper` — *the same class the headless driver uses*
(`harness/harness-broker-pi-sdk/src/event-mapper.ts`) — over a `DriverContext`
shim whose `emit` serializes to NDJSON on that socket. It then wires
`session.subscribe(event => mapper.handle(event))`, exactly as
`harness-broker-pi-sdk/src/driver.ts:306` does.

The wire therefore carries **already-mapped `InvocationEventEnvelope` payloads**
under a versioned contract `agent-harness-events/v1`, not raw SDK objects. The
driver validates each against the broker protocol schema, assigns sequence
numbers with the existing `createInvocationEventSequencer`, and emits.

Rationale for mapping TUI-side rather than driver-side:

- Interactive and headless event mapping become identical *by construction* —
  same class, same input events — rather than by two normalizers kept in sync.
- Only a schema-validated, already-serializable contract crosses a process
  boundary. Raw `AgentSessionEvent` has no serialization contract and shipping
  it would invent one.
- Sequencing stays driver-owned, so ledger ordering is unaffected.

Events the driver originates itself (not the TUI): `terminal.surface.reported`
(the driver owns the pane lease) and lifecycle transitions.

### D3 — Process topology: keep the two-binary split

`resolveBrokerBinary` gains `agent-harness-tmux → 'agent-harness'`. The
`agent-harness` executable remains the broker process for both agent-harness
driver kinds.

Registering the agent-harness driver in the stock `harness-broker` binary was
considered and rejected: it would make `spaces-harness-broker` depend on
`agent-harness`, which depends on `agent-harness-runtime`, inverting the
dependency direction the accepted proposal fixes
(`agent-harness -> spaces-harness-broker-pi-sdk`) into a cycle.

The consequence — two broker binaries with divergent driver registries selected
by driver kind — is pre-existing and is not made worse by this change. It is
named here so it is not mistaken for an oversight.

### D4 — Plan construction stays in HRC

`direct-agent-harness.ts` gains an interactive variant. Where the headless plan
emits `process.command: 'in-process'`, `harnessTransport: {kind:'in-process'}`,
`interaction.mode: 'service'`, the interactive plan emits:

- `process.command`: the `agent-harness` executable,
- `process.args`: `['tui', '--agent-id', …, '--broker-events-socket', …]`,
- `process.harnessTransport`: `{kind: 'pty'}`,
- `interaction.mode`: `'interactive'`,
- `driver.kind`: `'agent-harness-tmux'`, `driver.terminalHost`: `'tmux'`.

Teaching ASPC to lower `agent-harness` was rejected: the invariant makes the
direct runtime's resource delivery non-compiler-owned, and the headless surface
already precedent-sets a hand-built plan in HRC. This does duplicate a small
amount of plan-shaping logic between the compiler and HRC; that duplication is
accepted and confined to `direct-agent-harness.ts`.

The interactive path (`runtime-io-handlers.ts`, `broker-interactive-handlers.ts`)
currently has no direct-plan escape hatch — it always goes through the ASPC
facade. It gains one, mirroring `broker-headless-handlers.ts:473`.

### D5 — Auth binding (invariant-mandated)

Presence of `--broker-events-socket` selects broker mode in
`harness/agent-harness/src/cli.ts`. In broker mode `runAgentHarnessTui`:

- **must not** call `resolveForegroundAuthStorePath`
  (`harness/agent-harness/src/foreground/auth-store.ts`), and
- **must** bind the broker-supplied auth path, provider, and mode before model
  lookup and session creation, failing closed if absent.

Bare `asp run <agent>` foreground behavior is unchanged. This is asserted
mechanically, not by convention: a test breaks the binding and confirms broker
mode refuses rather than silently falling back.

### D6 — HRC admission and routing

In `hrc-server/src/broker-decisions.ts`:

- `InteractiveTmuxBrokerDriver` (:232) gains `'agent-harness-tmux'`.
- `resolveInteractiveBrokerAdmissionDriver` (:462) gains a branch for
  `harness.id === 'agent-harness'`.
- New `shouldConsiderAgentHarnessTmuxBrokerDispatch`, mirroring :817, plus a
  case in `decideInteractiveTmuxBrokerStartRoute` (:510).
- `deriveInteractiveHarness` (:42) gains `agent-harness`. Today it falls through
  to `codex-cli` for any OpenAI intent, which would mislabel the runtime.

Elsewhere: `broker/runtime-state.ts:330` (`runtimeHarness`) and
`substrate-allocator.ts:133` (`resolveBrokerBinary`) map the new kind.

A new flag `HRC_AGENT_HARNESS_TMUX_BROKER_ENABLED` follows the established
default-on pattern (`server-constants.ts`, `option-resolvers.ts`,
`server-types.ts`).

### D7 — Contracts

- `core/config/src/core/types/harness.ts:64` — `agent-harness` gains an
  interactive frontend identity (`agent-harness-tui`). It currently has none,
  which is the proximate cause of the failure.
- `contracts/spaces-runtime-contracts/src/route-catalog.ts` — no row exists for
  `agent-harness` at all. Add
  `controller: harness-broker / harnessFamily: pi / interactionMode: interactive /
  driver: agent-harness-tmux / processTransport: pty`.
- `contracts/spaces-runtime-contracts/src/validate-execution-profile.ts:156,172`
  — `agent-harness` is hard-wired into the `pi-sdk` legality lane, which
  mandates in-process transport and `nonInteractive` mode. An interactive
  profile trips those rules today. Add a distinct rule array for
  `agent-harness-tmux` (terminalHost `tmux`, pty transport, hookBridge absent).
- `contracts/harness-broker-protocol/src/schemas.ts:381,1130,1719` —
  `agent-harness` is treated as SDK-backed (`sdk` block permitted, in-process
  transport permitted), and the tmux terminal-surface gates whitelist only the
  three existing tmux kinds. Add `agent-harness-tmux` to the tmux gates; it
  carries no `sdk` block.

### D8 — Continuation

The TUI reports its session file path in its ready event; the driver feeds it to
the mapper's existing `sessionFile: () => string | undefined` seam. Session
files already live at `aspHome/agent-harness/sessions/<agentId>`
(`harness/agent-harness-runtime/src/session-manager.ts:13`). Resume uses the
existing `--resume` argv the foreground TUI already accepts.

### D9 — Permission policy and structured output

`spec.driver.permissionPolicy` is derived from profile `yolo`, as the headless
plan already does. Structured output / `responseFormat` is **not supported** on
this surface — it is an operator TUI — and the capability set says so rather
than accepting and ignoring the field.

## Rejected alternatives

**Broker-hosted session with a thin attaching viewer.** The broker would keep
owning the `AgentSessionRuntime` in-process (as headless does today) and the
tmux pane would run a rendering client, following the codex-app-server
headless-viewer pattern. This is architecturally cleaner — one session owner, no
new egress channel — but Pi's `InteractiveMode` constructs and owns an
`AgentSessionRuntime` in-process and cannot render a remote session. Adopting it
means writing a new TUI rather than reusing `InteractiveMode`, which
contradicts the accepted proposal's reuse premise.

**Pi extension hook bridge.** Reuse `asp-hrc-events.bridge.js` and
`harness-broker pi-hook`. Rejected: that artifact is generated by the
`harness-pi` adapter lowering, which the direct runtime consumes by invariant
not at all.

**Shipping raw `AgentSessionEvent` over the socket.** Rejected in favor of
TUI-side mapping — see D2.

## Conformance

Per the pre-HRC certification doctrine, `agent-harness-tmux` becomes a
**required row** in the harness-agnostic driver matrix — every scenario and
every event assertion, no exemptions. A missing event is a driver gap to close,
not a row to exempt.

Expected to surface real gaps, since the TUI has never been driven
programmatically: input submission timing, interrupt semantics, and turn
settlement under `InteractiveMode`.

Additional required evidence:

1. Event parity: the same prompt through headless `agent-harness` and through
   `agent-harness-tmux` produces the same mapped event sequence, modulo
   surface-origin events. This is the load-bearing assertion for D2.
2. Auth containment (D5): broker mode with a broken binding fails closed and
   does not reach the foreground auth store.
3. Real-terminal validation via ghostmux: `hrc run sparky` boots a live pane,
   accepts a dispatched turn, and the turn appears in `hrc monitor`.
4. `asp run sparky` foreground behavior unchanged.

## Out of scope

- Attaching HRC to a TUI started by `asp run`.
- Changing foreground `asp run` semantics, auth, or resource loading.
- Collapsing the two broker binaries into one registry.
- Structured output on the interactive surface.
- Any change to `claude-code-tmux`, `codex-cli-tmux`, or `pi-tui-tmux`.

## Delivery waves

1. Contracts: catalog frontend, route-catalog row, execution-profile rules,
   protocol schema gates.
2. TUI broker mode: `--broker-events-socket`, TUI-side mapper, auth binding
   (D5), ready/continuation reporting.
3. Broker driver `agent-harness-tmux` + binary resolution.
4. HRC admission, routing, flag, interactive direct-plan builder.
5. Pre-HRC matrix row + event-parity and auth-containment assertions.
6. Invariant amendment (two → three outer surfaces) and real-terminal
   validation.
