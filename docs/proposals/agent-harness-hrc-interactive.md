# HRC-operated agent-harness interactive TUI

- **Status:** proposed (r2); r1 rejected in `hrcchat#20910`, resubmitted
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

### D2 — Bidirectional control channel `agent-harness-control/v1`

The existing three tmux drivers observe their harness through a hook bridge:
the harness process shells out to a bridge CLI which posts an envelope to a
driver-owned socket, and the driver normalizes it. For `pi-tui-tmux` this
requires the `asp-hrc-events.bridge.js` Pi extension generated by
`drivers/harness-pi/src/adapters/pi-adapter.ts:553`.

`agent-harness` cannot use that: it consumes no adapter lowering and no
generated bundle, by invariant. It also does not need to — the TUI is
first-party and already holds the live `AgentSession`.

**The seam is bidirectional.** The broker-authoritative turn identity is
allocated in the outer driver and must reach the child before any session event
is mapped; an outbound-only socket cannot carry it. The channel is therefore a
small request/response protocol, not an event firehose.

The driver creates a unix socket and passes its path to the TUI as
`--broker-control-socket <path>`. Framing is NDJSON. The verb set is closed and
minimal:

| Direction | Verb | Payload | Response |
| --- | --- | --- | --- |
| TUI → driver | `ready` | `{sessionFile}` | — |
| driver → TUI | `turn.begin` | `{turnId, inputId, structured:false}` | `ack` (required) |
| TUI → driver | `event` | one mapped `InvocationEventEnvelope` payload | — |

In broker mode the TUI constructs a `PiSdkTurnEventMapper` — *the same class the
headless driver uses* (`harness/harness-broker-pi-sdk/src/event-mapper.ts`) —
over a minimal `DriverContext` shim whose `emit` serializes an `event` frame. It
then wires `session.subscribe(event => mapper.handle(event))`, exactly as
`harness-broker-pi-sdk/src/driver.ts:306` does.

**Turn handshake and ordering.** `mapper.handle` discards every event while
`#turnId` is undefined (`event-mapper.ts:132-134`), so `beginTurn` must land
first. The driver's `applyInputNow` therefore:

1. allocates `turnId` via its own `allocateTurnId()`, as `pi-tui-tmux` does
   (`drivers/pi-tui-tmux/driver.ts:255-259`);
2. sends `turn.begin` and **awaits the ack**, which is the child calling
   `mapper.beginTurn({turnId, inputId, structured:false})`;
3. only then pastes the input line into the pane;
4. returns `{turnId}`, from which the broker synthesizes the `turn.started`
   bracket (`harness/harness-broker/src/invocation-manager.ts:462-496`).

Pasting before the ack would race the mapper into dropping the turn body; the
awaited ack makes the ordering a protocol guarantee rather than a timing
assumption. This mirrors the headless driver, which defers the prompt behind
`schedule()` for the same reason (`harness-broker-pi-sdk/src/driver.ts:329-343`).

**Outbound gate.** The driver queues inbound `event` frames while an
`applyInputNow` call is in flight and flushes on return. The broker emits
`turn.started` *after* `applyInputNow` returns, so this keeps body events
strictly behind the bracket by construction instead of relying on the model
being slower than a function return.

The wire carries **already-mapped `InvocationEventEnvelope` payloads**, not raw
SDK objects. The driver validates each against the broker protocol schema,
assigns sequence numbers with the existing `createInvocationEventSequencer`, and
emits.

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
- `process.args`: `['tui', '--agent-id', …, '--broker-control-socket', …]`,
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

Presence of `--broker-control-socket` selects broker mode in
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
  `agent-harness-tmux` (terminalHost `tmux`, pty transport, hookBridge absent),
  **including a rule rejecting `spec.driver.permissionPolicy.mode ===
  'ask-client'`** for this driver kind (D9).
- `contracts/harness-broker-protocol/src/schemas.ts:381,1130,1719` —
  `agent-harness` is treated as SDK-backed (`sdk` block permitted, in-process
  transport permitted), and the tmux terminal-surface gates whitelist only the
  three existing tmux kinds. Add `agent-harness-tmux` to the tmux gates; it
  carries no `sdk` block.

### D8 — Continuation

The mapper lives in the TUI process, so it reads `session.sessionFile` directly
through its existing `sessionFile: () => string | undefined` seam — no crossing
required. The TUI additionally reports the path in its `ready` frame so the
driver can capture continuation. Session files already live at
`aspHome/agent-harness/sessions/<agentId>`
(`harness/agent-harness-runtime/src/session-manager.ts:13`). Resume uses the
existing `--resume` argv the foreground TUI already accepts.

### D9 — Permission enforcement in the session-owning process

Declaring `spec.driver.permissionPolicy` is not enforcement. The process that
owns the live session is the TUI, and the foreground TUI creates its runtime
with no broker permission extension
(`harness/agent-harness/src/foreground/tui.ts:29-41`), so a policy declared only
on the outer spec would be unenforced.

**Design:** in broker mode the TUI installs the permission bridge itself, using
the identical code path as headless — `createPiSdkPermissionBridge` registered
as a `tool_call` extension factory **before session creation**
(`harness/harness-broker-pi-sdk/src/driver.ts:287-305`), with
`activeTurnId: () => mapper.activeTurnId` resolving against the same in-process
mapper. `mode: 'deny'` blocks the call at
`harness/harness-broker-pi-sdk/src/permissions.ts:27-33`, in the process that
would otherwise have run the tool.

`DriverPermissionPolicy.mode` is `deny | allow | ask-client`
(`contracts/harness-broker-protocol/src/invocation.ts:335-339`). This surface
supports `deny` and `allow` only:

- `deny`/`allow` are decided entirely inside the bridge and return before
  touching `ctx.emit` or `ctx.requestPermission`. The `DriverContext` shim
  therefore needs nothing beyond `emit` and `invocationId`, and no permission
  round-trip crosses the process boundary.
- `ask-client` is **rejected by the execution-profile validator** for driver
  kind `agent-harness-tmux` (see D7), so an unenforceable policy cannot be
  lowered. It is refused at compile time rather than downgraded silently at
  runtime.

`spec.driver.permissionPolicy` continues to derive from profile `yolo`, which is
binary and therefore only ever produces `allow` or `deny` — so refusing
`ask-client` costs no currently reachable behavior. Broker-mediated interactive
approval on this surface is deliberately deferred: it needs a contract for Pi
`InteractiveMode`'s own in-pane approval UI, or it would double-prompt the
operator.

Structured output / `responseFormat` is **not supported** on this surface — it
is an operator TUI — and the capability set says so rather than accepting and
ignoring the field. `turn.begin` accordingly always carries
`structured: false`.

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

**One-way event egress.** The first revision of this proposal specified an
outbound-only socket. Rejected: the broker-authoritative turn id is allocated in
the outer driver and the permission decision must be taken in the session-owning
process, so both control handoffs need the seam to carry traffic inbound. See
the flaw disposition below.

**Proxying permission decisions to the driver.** The TUI could forward every
`tool_call` to the driver and await a decision. Rejected: for the only reachable
policies (`allow`/`deny`, derived from binary `yolo`) the decision is a pure
function of the spec the TUI already holds, so the round trip would add a
failure mode and a latency hazard on every tool call while changing no outcome.

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
2. **Turn-identity handshake (D2, Flaw 1).** A prompt-bearing turn produces
   `turn.started` / assistant / tool / terminal events all carrying the
   broker-allocated `turnId`, and the turn settles. Mutation test: suppress the
   `turn.begin` ack so the child mapper never begins a turn, and confirm the
   turn fails to settle — a handshake that cannot fail is decorative.
3. **Ordering gate (D2).** Assert no body event reaches the ledger before the
   `turn.started` bracket, exercised against a synthetic child that emits
   immediately on ack.
4. **Permission enforcement (D9, Flaw 2).** An invocation lowered
   `permissionPolicy: deny` has its tool call blocked *inside the TUI process*.
   Mutation test: remove the permission extension from broker-mode session
   creation and confirm the deny assertion fails.
5. **Policy admissibility (D9).** A profile carrying `mode: 'ask-client'` for
   `agent-harness-tmux` is refused by the execution-profile validator, not
   silently downgraded.
6. Auth containment (D5): broker mode with a broken binding fails closed and
   does not reach the foreground auth store.
7. Real-terminal validation via ghostmux: `hrc run sparky` boots a live pane,
   accepts a dispatched turn, and the turn appears in `hrc monitor`.
8. `asp run sparky` foreground behavior unchanged.

## Out of scope

- Attaching HRC to a TUI started by `asp run`.
- Changing foreground `asp run` semantics, auth, or resource loading.
- Collapsing the two broker binaries into one registry.
- Structured output on the interactive surface.
- Any change to `claude-code-tmux`, `codex-cli-tmux`, or `pi-tui-tmux`.

## Delivery waves

1. Contracts: catalog frontend, route-catalog row, execution-profile rules
   (incl. the `ask-client` refusal), protocol schema gates.
2. `agent-harness-control/v1`: the control channel contract and its framing,
   with the `turn.begin`/`ack` handshake specified independently of either end.
3. TUI broker mode: `--broker-control-socket`, TUI-side mapper and
   `beginTurn` handling, TUI-side permission extension (D9), auth binding (D5),
   `ready`/continuation reporting.
4. Broker driver `agent-harness-tmux` + outbound gate + binary resolution.
5. HRC admission, routing, flag, interactive direct-plan builder.
6. Pre-HRC matrix row + the conformance assertions above, including the two
   mutation tests.
7. Invariant amendment (two → three outer surfaces) and real-terminal
   validation.

## Revision history

**r2 (this document)** — rejected at r1 by Daedalus (`hrcchat#20910`) on two
flaws, both rooted in the same error: r1 specified a one-way egress socket
across a boundary that carries two control handoffs.

- *Flaw 1 (turn identity).* Resolved by D2. The seam is now a bidirectional
  request/response channel; the driver allocates the turn id exactly as
  `pi-tui-tmux` does, sends `turn.begin`, and **awaits an ack** — the child
  calling `mapper.beginTurn` — before pasting input. An outbound gate holds
  `event` frames until `applyInputNow` returns, so body events cannot precede
  the broker's `turn.started` bracket. A mutation test suppressing the ack
  proves the handshake is load-bearing.
- *Flaw 2 (permission authority).* Resolved by D9. Enforcement moves into the
  session-owning process: broker mode installs `createPiSdkPermissionBridge` as
  a `tool_call` extension before session creation, the identical path headless
  uses, so `deny` blocks in the process that would run the tool. `ask-client` —
  the only mode requiring a decision the child cannot take alone — is refused by
  the execution-profile validator rather than silently downgraded. A mutation
  test removing the extension proves the enforcement is load-bearing.

**r1** — `e4939d7`. Rejected.
