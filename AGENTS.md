## Build & Run

Agent Spaces composes spaces into executable agent environments in a Bun monorepo.
Run `bun install` to install dependencies and `bun run build` to build all packages.
See the [workspace map](docs/architecture-brief.md#layers) for package and fixture locations.

## Install and Publish Contract

Push before `just install`. On the main checkout it publishes a coherent ASP
package set, synchronizes HRC by default, and activates the configured system
aspd. ACP pins its producers separately. Linked worktrees publish in isolation
by default. Read the [install and publication contract](docs/standalone-asp-releases.md#canonical-install-and-package-publication)
before installing, publishing, or syncing.

## Codex Overlay

When changing Codex-facing agent defaults, edit the source under
`~/praesidium/var/agents/` first. Do not edit generated Codex home files or
materialized bundle copies directly.

After changing agent source files, run the ASP overlay recipe from this repo:

```bash
just overlay-codex
```

This overlays **stella**, the dedicated Codex desktop-app agent (cody stays the HRC-managed CLI worker). It runs `scripts/sync-agent-to-codex-default.ts --install-hooks --apply`,
updates the managed block in `~/.codex/AGENTS.md`, syncs managed skills into
`~/.codex/skills`, retires any previous agent's managed block/skills/manifest from that home, and leaves unmanaged Codex config/skills alone.

## Build & deploy

Read `~/praesidium/build_deploy_guide.md` before building, installing, or promoting anything in agent-spaces, hrc-runtime, or agent-control-plane. It is the agent digest of the published references `/a/hrc-build-deploy-guide` and `/a/asp-hrc-acp-dev-guide` on the taskboard. The rules that bite most: push before `just install` (a main-checkout install refuses an unpushed or non-clean tree); install ≠ activate (`hrc server restart --reason …`, then read back `runningEqualsInstalled`); an HRC install before `just pull-deps` ships the OLD agent-spaces tuple — and so does one after a `pull-deps` that did not move `bun.lock`, so read back `git log -1 -- bun.lock` before installing; never `bun update`/`bun add` a synced package (`check-lock-coherence` refuses the split lock it leaves); fleet promotion is `just deploy-*` / `just fleet-status`, never by hand.

## Validation

Use the [documentation index](docs/README.md) for references and runbooks; run these after implementing:

- Only run tests (`bun run test`) **after modifying workspace package files AND after manually testing if possible**.
- Tests: `bun run test`; full gate `just verify` (takes the shared verify lock itself; stop one with `just verify-cancel`, never pkill)
- Typecheck: `bun run typecheck` (run `bun run build` first if workspace typings are missing)
- Lint: `bun run lint` (fix with `bun run lint:fix`)
- Boundary checks: `bun run check:boundaries`, `bun run check:manifests`
- Closeout evidence tiers: see [docs/closeout-evidence.md](docs/closeout-evidence.md)
- Agent enablement changelog / retro step: see [docs/agent-enablement-changelog.md#retro-cadence](docs/agent-enablement-changelog.md#retro-cadence)
- Pack smoke: `bun scripts/smoke-pack-cross-repo.ts` (verifies cross-repo published tarballs don't carry `exports.bun → ./src/*.ts`)
- Run the [harness broker matrix](docs/closeout-evidence.md#harness-broker-matrix)
  from a clean Ghostty terminal for harness-broker changes.
- Pack smoke for `@lherron/agent-spaces` (`cd apps/cli; bun scripts/smoke-test-pack.ts`) — required after packaging changes → see [apps/cli/AGENTS.md](apps/cli/AGENTS.md)
- Pi harness env/runtime flags (`--harness pi`: `PI_CODING_AGENT_DIR`, `--no-skills`, hooks-scripts) → see [drivers/harness-pi/AGENTS.md](drivers/harness-pi/AGENTS.md)

Every ASP owner-surface change must state in its delivery evidence:
"projected in the praesidium kernel or declared human-only" (strangler rule S3).
Include the concrete `prae describe <type>` or document readback showing the
changed field/operation; for human-only coverage, cite the explicit ruling and scope.

## Broker Injection Doors

Ruled by Lance 2026-09-16 (H-00440): **steer = send now, enqueue = send after.** A steer joins the running turn; if no turn is running it STARTS one. Never spec "steer has no turn of its own" again. A client that enqueues its first message is wrong, not the host.

Ruled by Lance 2026-11-17 (T-13668): **callers never choose a door from seat state.** "If they want to steer, they send steer and the broker makes it work regardless of seat busy/idle." HRC and mail delivery keep no seat-state door choice, steer-to-enqueue fallback, or retry hold for steer. Making a steer land is the broker's job, and "brokers should never refuse a steer beyond" the four cases below. Architecture record: `agent-spaces.broker-steer-one-door`.

| Seat state | What the broker does with a steer | Live? |
|---|---|---|
| **Idle** (ready, no turn) | Starts a turn whose input is the steer. Codex decides at actuation (`resolvesSteerAtActuation`) and starts an own turn when Codex has none. `arris-resident` (`steerNeverStartsTurn`) forwards the steer, and its host starts the turn. | Live |
| **Busy** (turn running) | Injects into the running turn: Claude by paste, Codex by `turn/steer`. | Live |
| **Handed over, turn not started** | Waits for that turn, then injects. Codex signals it per attempt; for the Claude paste drivers the broker holds the steer while the own-turn slot is pending and no turn runs, so it never merges into the queued prompt. `arris-resident` injects at once (host-owned window). | T-13687, T-13689 |
| **Invocation starting** | Held until the invocation is ready, then idle or busy as above. | T-13689 |
| **Guarded turn** | Never steered into. Waits for the turn's terminal, then starts its own turn. | T-13689 |
| **Open permission request or question** (a `permission.requested` without its resolution, or an open `AskUserQuestion`/`request_user_input` tool call) | Held until the request resolves, because injected text must never answer a prompt. | T-13689 |
| **Pane not ready before paste** (Claude `pane_not_quiescent`, `before_paste`) | Nothing was written, so the broker holds and retries until the input box is ready. | T-13689 |
| **Driver without the steer class** (codex-desktop) | Admitted through that driver's own queue. | T-13689 |
| **Cold** (not yet born) | HRC births the runtime and the steer rides the birth turn with the priming. | Live |

**The only steer refusals.** Anything else is a broker defect:
1. The invocation is stopping, exited, failed or disposed. The refusal is `not_written`, and HRC lifecycle carries the message to the next generation.
2. Fresh context is requested. That is a new session, which belongs to HRC lifecycle.
3. The host's authorization hook denies it. The hook defaults to allow, and mail fails such an envelope plainly.
4. The harness write itself fails. The evidence is `not_written` before any write, and `possibly_written` after. Recovery after a possible write is unchanged (`agent-spaces.harness-broker-turn-evidence`). After an ambiguous failed `turn/steer` RPC, Codex still re-sends the same submission as an own turn, accepting a possible duplicate rather than a dropped steer. A Claude pane failure after submit is not re-pasted.

Every steer reaches exactly one submission terminal (executed, absorbed, rejected, withdrawn, cancelled or lost). The admission reply returns before any hold ends, and no hold or retry emits `input.rejected`. A steer still held when the invocation stops is `cancelled` (`teardown`). Every `submission.*` request takes an optional caller-minted `submissionId`: a repeat with the same id and request returns the first admission reply and creates nothing; the same id with a different request is refused invalid params (T-13689). A Codex TUI delivery returns once Codex acknowledges it, and attribution settles the fate later. Attribution never holds the queue (T-13687).

Explicit doors stay for callers who want their semantics on purpose: **enqueue** (an own turn after the current one, waitable), **invoke** (exclusive; on a seat without the exclusive class HRC admits it through queue), and **preempt** (authority-gated, for holds). `hrc turn` steers by default and enqueues only with an explicit flag. ACP and agent-loop dispatch through HRC `POST /v1/turns`, which starts a guarded turn.

## aspd operations

Use the [namespaced aspd service recipes](docs/aspd.md#current-service-operations).
For live status, use `just aspd-status <absolute-namespace>` and check the
running process, the serving release, and whether it matches the selected release.

## Repo Boundaries

This repo is the ASP layer of the three-repo split (ASP / HRC / ACP). Boundaries
enforced by `bun run check:boundaries`:

- ASP source **must not** import any `hrc-*`, `acp-*`, `gateway-*`,
  `coordination-substrate`, `wrkq-lib`, or `wlearn` package.
- ASP may compile placement policy and task defaults as intent, but HRC's
  binding registry and local placement ledger remain authority. ASP must not
  infer node identity from a host or mutate established placement.
- Cross-repo publishable boundary packages (10 of them — agent-scope, cli-kit,
  spaces-{config,runtime,execution,harness-*}, agent-spaces) MUST publish without
  `exports.*.bun` (the publisher strips it in its staged copy, scripts/lib/asp-publish/
  pack.ts; no per-package prepack/postpack) so Bun consumers resolve `dist/*.js`.

## Smoke Testing the CLI

Use the [CLI dry-run smoke](docs/closeout-evidence.md#cli-dry-run-smoke) for
`asp run` changes. Use a writable `ASP_HOME`. `asp run` has no `--prompt` flag.

## Error Handling

`asp run` must never silently swallow errors — exit immediately, let errors
propagate visibly, and throw explicit errors for invalid states.

## Pi Harness

When running with `--harness pi`, follow the env/runtime flags in
[drivers/harness-pi/AGENTS.md](drivers/harness-pi/AGENTS.md)
(`PI_CODING_AGENT_DIR`, `--no-extensions`, `--no-skills`, hooks-scripts).
