# Proposal: Muse Serve driver (`muse-serve`), broker-hooked

## Status

Implemented (campaign P-00522, T-08585–T-08592). The driver
(`harness/harness-broker/src/drivers/muse-serve/`), protocol spec
(`MuseServeDriverSpec`), composer (`drivers/harness-muse/`), CLI adapter
(`asp run --harness muse`), no-creds smoke (`scripts/smoke-muse-serve.ts`),
and the `real-muse-serve` matrix row
(`scripts/pre-hrc-broker-matrix-e2e.ts --config real-muse-serve`, green
via ghostmux) are delivered; evidence authority lives in
`harness/harness-broker/AUTHORITY.md` under `### muse-serve`. Everything
under "MSP wire shape" below was probe-reported and each item names the
spike that confirmed it. T-08592 corrections to the proposal: the driver
sends `clientInfo.name: harness_broker` (hyphens are rejected by SS1.4.1);
`--no-session-log` disables the read/view surface, so the smoke uses
durable sessions under a disposable HOME; keychain-bound oauth does not
leave the operator HOME, hence spec `homeMode: 'operator'` (isolated stays
the default); `responseFormat json_schema` is refused by the broker because
MSP `turn/start` has no providerRequestOptions by rule, so the structured
turn is asserted behaviorally.

## 0. Goal and non-goals

**Goal:** a serve-only **broker driver** (`kind: 'muse-serve'`) that spawns an
owned `muse serve` host over stdio and speaks MSP, modeled directly on
`harness/harness-broker/src/drivers/codex-app-server/`, plus the workspace
composition helpers it needs. Broker steer/enqueue doors work natively
because MSP's dispositions (`started` / `queued` / `steered`, per the
official
[queue/steer/reclaim recipe](https://meta-models.github.io/muse-code-sdk/next/cookbook/queue-steer-and-reclaim-turns/))
are the AGENTS.md broker-doors ruling in wire form.

**Non-goals (explicit):** no broker-door policy work — the doors ruling
already matches MSP dispositions one-for-one.

**Campaign deliverable:** `asp run --harness muse` ships within this
campaign (final spike), not as a follow-up. Sequencing is deliberate: the
bundle shape stays open through the discovery spikes (skill discovery is the
long pole; settings.json and auth are unresolved), so the CLI contract —
`HarnessId`, adapter, `register()` — locks in AFTER those resolve, falling
out of a stabilized composer. The composer itself is still built first
(spike 1) and proven by unit tests; the broker driver and the CLI adapter
both consume it.

**The constraining finding:** `session-message` ingress is closed
(`external_agent_ingress_closed`, independently corroborated), so there is no
side-door — owning the host via `serve` is the only injection path.

## 1. Touch points

`HarnessDescriptor.frontend` is a free string (`'muse-cli'`), and the broker
driver kind is a registry key, not a catalog entry. The CLI surface DOES need
harness-identity changes (final spike): `'muse'` added to the `HarnessId` union
(`core/config/src/core/types/harness.ts`, currently `'claude' |
'claude-agent-sdk' | 'pi' | 'pi-sdk' | 'codex'`), the `supports` union and
target options (`MuseOptions`) it implies, and the `run.ts` help text
(currently `supported: claude, codex, pi`). Validation needs no new code —
`validateHarness`/`validateOptionalHarness` accept anything `isHarnessId`
accepts.

Required changes, across CLI + broker + protocol + one helper package:

- **New broker driver** `harness/harness-broker/src/drivers/muse-serve/`
  (`driver.ts`, `rpc-client.ts`, `event-map.ts`, `capabilities.ts`,
  `input.ts`, `permissions.ts`) exposing `createMuseServeDriver()`.
  Smaller than `codex-app-server/` (7,559 lines total, of which ~2.9k is
  presentation + transcript: `renderer*.ts`, `status-line.ts`,
  `pane-output.ts`, `queue-drawer.ts`, `transcript.ts`,
  `codex-tui-wrapper.ts` — the bulk is `driver.ts` at 2.5k and `event-map.ts`
  at 1.2k): a protocol-native driver needs no presentation files, but it
  still needs the full lifecycle/event-map/permission core.
- **Register** in `harness/harness-broker/src/default-broker.ts`
  (`createDefaultBroker` driver list, codex-app-server precedent). Stage
  behind `additionalDrivers` until the MATRIX row is green, then promote to
  the default list.
- **Protocol** (`contracts/harness-broker-protocol/src/invocation.ts`):
  extend the `driver` union on `HarnessInvocationSpec` (currently
  `CodexAppServerDriverSpec | UnknownDriverSpec`) with a
  `MuseServeDriverSpec` mirroring the codex shape — sketch:
  ```ts
  interface MuseServeDriverSpec {
    kind: 'muse-serve'
    serveBin?: string | undefined
    workspace?: string | undefined
    model?: string | undefined
    reasoningEffort?: string | undefined
    approvalPolicy?: string | undefined
    permissionPolicy?: DriverPermissionPolicy | undefined
    resumeSessionId?: string | undefined
    resumeFallback?: 'start-fresh' | 'fail' | undefined
  }
  ```
  (`HarnessDescriptor.driver` already accepts `'muse-serve'` via `| string`,
  and `HarnessTransportSpec` already has `jsonrpc-stdio` — both fit as-is.)
  Continuation is a `ContinuationSpec` with `provider: 'muse'`,
  `kind: 'session'`.
- **Workspace composition + CLI adapter** in a new `drivers/harness-muse`
  package: pure functions `detectMuse()`, `composeMuseWorkspace()`,
  `buildMuseServeDescriptor()`, PLUS a `HarnessAdapter` with `register()`
  (the `drivers/harness-codex/src/adapters/` + `register.ts` pattern) that
  composes the bundle and execs `muse serve --workspace <bundle>
  --trust-workspace …` (adapter lands in the final spike, §6.11; the pure
  functions land in spike 1). Boundary direction is legal (harness → drivers:
  `aspRootDag` in `scripts/lib/import-graph.ts` orders harness before
  drivers); verify with `bun run check:boundaries` plus the
  runtime-contract harness-boundary check. Rationale for a package instead
  of driver-local code: the bundle builder is independently testable and
  shared by BOTH surfaces — the CLI adapter (spike 1) and the broker driver
  (§3) consume the same composer; the broker driver itself stays
  protocol-only.
- **Evidence authority**: declare the per-family matrix in the driver and
  update `harness/harness-broker/AUTHORITY.md` — new family column in the
  matrix plus an exception-matrix entry (the published prose must agree;
  codex precedent lives in its `driver.ts`).
- **MATRIX smoke**: new `muse-serve` row in
  `scripts/lib/admission-matrix/rows.ts` (`compiledRecipe({ kind:
  'muse-serve', … })`, codex-app-server precedent), following the established
  probe shape (`resolveBin` + `authProbe`, creds-gated, `available: false`
  with reason when absent). Run from ghostmux per AGENTS.md — never inline,
  or the CLAUDE_CODE_* leak false-negatives transcript tailing.

## 2. What carries over from the CLI probes

- **Isolated writable HOME is mandatory.** `serve` constructs its sandbox
  posture and session durability for its lifetime; state, skills, plugins,
  and session logs live under `~/.config/muse` + `~/.local/share/muse`. The
  driver prepares a fingerprinted runtime home per invocation (Codex
  `run-codex.ts` pattern: canonical-hash fingerprint + lock + metadata) and
  spawns with `HOME=<isolated>`; best-effort auth seeding (symlink real
  `~/.config/muse/auth.json`, exact filename TBD — spike 9) with
  warning-never-error semantics. Session logs stay ON (resume/export and any
  `--session-id` equivalent need them).
- **Workspace bundle for `--workspace`.** Verified: `--workspace PATH` sets
  an explicit tool root while launch cwd stays the project dir;
  `--trust-workspace` (`trusted source=run-flag`) enables delegation.
  Composition output: `<bundle>/muse.workspace/` with concatenated
  `AGENTS.md`, merged `skills/`, generated `settings.json` (space
  `mcp/mcp.json` merged via `composeMcpFromSpaces`, `W_MCP` warnings), and a
  Codex-schema `manifest.json`. Open problem (spike 7): project-scope skill
  discovery failed for `skills/`, `.muse/skills/`, `.config/muse/skills/` —
  fallback is materializing into the isolated HOME's `$CONFIG_DIR/skills/` at
  prep time (no cross-target leakage exactly because HOME is
  per-invocation).
- **SKILL.md frontmatter lint** (`name` + `description`, else
  `invalid-skill-package`) belongs in the composer as warnings.
- **`--json` transcript shape** (JSONL session-event envelopes) is
  superseded by the MSP stream, but the payload vocabulary observed there
  (`session.run.linked`, `run.lifecycle.started`, `task.stream.linked`, …)
  seeds the event-map spike.

## 3. Driver contract (codex-app-server mapping)

| Lifecycle | muse-serve behavior |
|---|---|
| `start(spec, ctx)` | Validate `spec.driver.kind === 'muse-serve'`; spawn `muse serve --workspace <bundle> --trust-workspace` (approval is wire-side — serve takes no approval flag — via `session/setApprovalMode`; model/effort via `session/setModel`, `session/setReasoningEffort`; all three method names spike-1 to confirm); stdio-pipe JSON-RPC client; `initialize` (check schema fingerprint against the committed bundle, SDK `checkServedFingerprint` precedent) → `session/start` (or `session/resume` for continuations). |
| `applyInputNow(input)` | `turn/start` with `TurnInputPart[]` built by `input.ts`; the response `turnId` is the ONLY id returned (codex-app-server driver.ts precedent: the provider's `turn/start` response is the delivery acknowledgement); `bracketMintingMode: 'delivery-acknowledged'`. Broker owns queueing — never pass `ifBusy`; an own turn is always a fresh `turn/start`. |
| `applySteerNow(input)` | Narrow contract copied from codex-app-server `applySteerNow`: active turn or throw (`not_written` evidence), input id required (`not_written`), `turn/steer` with `expectedTurnId` = armed turn (the race fence — a turn that ended mid-flight fails the RPC instead of leaking text). Response `turnId` equal to the armed turn is the fast path; an accepted response naming a DIFFERENT turn means the native turn rolled between admission and landing and muse absorbed the input into the now-running turn (schema: "the running turn that absorbed the input") — re-arm to the absorbing turn and report delivery with an info diagnostic, since the text demonstrably did not leak. Only a missing/empty `turnId` throws (`possibly_written`) with the armed-identity error diagnostic. Never starts a turn, never queues. |
| `interrupt` / `stop` / `dispose` | `turn/cancel` + `turn/interrupt` both exist on the wire — spike 6 picks which maps to broker interrupt. Proposed: `interruptLandingEvidence: 'ack'` pending verification (codex precedent). |
| `event-map.ts` | MSP notifications → broker `InvocationEvent`s (turn lifecycle, assistant deltas, tool calls, usage, diagnostics, approval/request, userInput). `steerLandingEvidence: 'transcript'` with a pending-steer table tracking native observation (codex `pendingSteers` precedent) — a steered input isn't dispositioned until the transcript shows it. `nativeSourceKind: 'provider-jsonrpc'`. `captureNormalizer()` returns the SAME closure live ingest uses (restart-replay contract, `Driver.captureNormalizer` docs) — no second implementation. |
| `permissions.ts` | `approval/request` → `ctx.requestPermission` when `brokerOwnsPermissionLifecycle` (driver emits `permission.requested`, awaits the final decision, imposes no timeout); else driver-owned timeout + self resolution (`DriverPermissionPolicy`: `deny` \| `allow` \| `ask-client`, codex `permissions.ts` precedent). |
| `capabilities.ts` | `MUSE_CAPABILITIES` mirroring `CODEX_CAPABILITIES` — admission `['steer','queue','exclusive','preempt']`, `turns.concurrency: 'single'`, continuation `{ supported: true, provider: 'muse', keyKind: 'session' }`, events `{ assistantDeltas, toolCalls, usage, diagnostics }`, `interrupt: 'protocol'`. **Every value provisional** until its spike confirms it: preempt is `atomic` iff `turn/cancel` proves atomic, else null; the `input.*` flags (localImages, fileRefs, …) wait on spike 3. No `steerNeverStartsTurn` (arris-only); no downgrade path — the driver HAS the steer class, so the mail kicker steers on idle AND busy and enqueues only as an explicit own-turn. |

## 4. Renderer (reused plumbing, muse-specific projection)

No TUI means the operator view comes from the broker renderer — and that path
is reusable by construction. The codex-app-server renderer (`renderer*.ts`,
`transcript.ts`, `pane-output.ts`) is driver-agnostic at every layer except
one:

- Reused as-is: `RendererDurableReadSurface` (bootstrap from
  `invocation.eventsSince`, then live `invocation.event` — the renderer is
  NEVER fed a driver-pushed private stream, so its output stays coherent with
  durable attach/replay), `RendererProjection`, `pane-output`, the
  `renderer-entry` launch shape (`--invocation-id/--observer-socket/
  --control-socket` into the HRC-leased `tmux-tui` pane), the
  `RendererLauncher` injection (`default-broker.ts`, absent keeps
  `bun <entry>`), and the presentation-only contract (no mutating broker
  methods; the serve stdio child stays the authoritative transport).
- Muse-specific: the projection itself. `CodexTranscriptModel`,
  `CodexStatusRow`, the queue drawer, and the reasoning-summary flattening
  are codex-specific. `muse-serve` needs `createMuseTranscriptModel` + a muse
  `renderer-entry` projecting the same harness-agnostic broker events
  (user.message, turn lifecycle, assistant deltas, tool calls, usage).
  The muse model speaks the same forge-lanes render language as codex: the
  band/keyline/ANSI primitives are shared via `createCodexStyler`
  (codex-app-server/transcript), enabled on a TTY unless NO_COLOR is set
  (codex entry precedent); off-TTY output stays the historical plain lines.
  Consecutive duplicate assistant texts without an intervening turn.started
  are folded out of the render (muse re-emits an agent item with identical
  text when a steered duplicate lands).
  New-projection risk is low: broker events are already normalized, so this
  is restyle plus whatever muse-native params surface.

## 5. Tests and gates

- Unit: RPC framing (newline-delimited JSON-RPC 2.0 per cookbook
  transcripts), event-map fixtures generated from the local schema export,
  steer race/mismatch evidence annotations (`not_written` vs
  `possibly_written`), disposition mapping, `loadTargetBundle`-style bundle
  assertions, composer determinism (canonical-hash, byte-identical output).
- Credential-free smoke where possible: `initialize` + `session/start`
  against a local `muse serve` should work pre-auth (spike 1 confirms or
  kills this); model-calling rows need creds and run in the MATRIX row via
  ghostmux.
- Gates: package tests, `typecheck`, `lint`, `check:boundaries`,
  `check:manifests`, MATRIX `muse-serve` row green, AUTHORITY.md agreement.

## 6. Spikes (ordered)

Each spike ends in a confirm-or-kill decision recorded in §7 of the
implementation change; a killed spike removes the feature that depended on
it, it doesn't block the driver.

1. **Workspace composer as pure functions.** `detectMuse()`,
   `composeMuseWorkspace()`, `buildMuseServeDescriptor()` in
   `drivers/harness-muse` — NO `HarnessAdapter`, NO `register()`, NO
   `HarnessId` yet. Acceptance is unit-level: composer determinism
   (canonical-hash, byte-identical output for the fixture space) plus
   `loadTargetBundle`-style bundle assertions (layout, AGENTS.md concat,
   skills merge, settings.json, manifest). No binary, no creds, no CLI
   contract — the composer shape is allowed to churn through the discovery
   spikes below without touching any public surface.
2. MSP framing over serve stdio + `initialize` handshake without credentials
   (wire guide: framing/four frame shapes; verify against the local binary).
   Kills credential-free smoke if `serve` requires auth to handshake.
3. Notification vocabulary for text/toolcalls/usage from the local schema
   export (offline-enumerable) → event-map table.
4. `TurnInputPart` shapes (text/image/file-refs?) → `input.ts` +
   capabilities `input.*` flags.
5. `approval/request` payload shape → `permissions.ts` mapping.
6. Turn-terminal payloads → transcript landing evidence + bracket minting.
7. `turn/cancel` vs `turn/interrupt` semantics → interrupt mapping (atomicity
   decides the preempt mode).
8. Project-scope skill discovery (§2) — still blocks bundle composition; the
   long pole.
9. `settings.json` resolution for `--workspace` runs → MCP merge path.
10. Auth filename/behavior under isolated HOME.
11. **CLI adapter + `asp run --harness muse --dry-run`.** NOW the bundle
    shape is stable (spikes 8–10 resolved), so lock the CLI contract:
    `HarnessId` `'muse'`, `supports`/`MuseOptions`, `HarnessAdapter` +
    `register()` in `drivers/harness-muse` (the
    `drivers/harness-codex/src/adapters/` + `register.ts` pattern),
    `run.ts` help text. Acceptance (AGENTS.md smoke pattern, no build step,
    no binary, no creds):
    ```bash
    ASP_HOME=/tmp/asp-test bun apps/cli/bin/asp.js run \
      integration-tests/fixtures/sample-registry/spaces/base \
      --harness muse --dry-run
    ```
    must print the composed `muse serve --workspace <bundle>
    --trust-workspace …` command. A live (non-dry) run additionally waits on
    spikes 8 and 10 at runtime — dry-run prints the command without
    executing, so those only bite on real runs.

Estimate: spike 1 ~1 day (composer + unit tests); spikes 2–10 ~1–2 days
(spike 8 is the long pole); spike 11 ~1–2 days (adapter + HarnessId
plumbing); broker driver + tests ~1 week; MATRIX row + AUTHORITY.md in the
same change. No broker-door policy work.

## 7. Open questions

- Exact auth filename/behavior under isolated HOME (spike 10).
- Wire method names for approval/model/effort (`session/setApprovalMode`,
  `session/setModel`, `session/setReasoningEffort` — spike 2).
- Whether `serve` exposes a `--session-id`-style resume the session logs can
  support (spike 2).
- Whether the SDK `checkServedFingerprint` precedent applies to the local
  `muse` binary's schema (spike 2).
