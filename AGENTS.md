## Build & Run

This is a Bun monorepo with packages grouped under `contracts/*`, `core/*`,
`drivers/*`, `compiler/*`, `harness/*`, and `apps/*`.

```bash
bun install       # Install dependencies
bun run build     # Build all packages
```

## Install and Publish Contract

On the main checkout, `just install` cleans, installs, and builds; links both
the `asp` CLI and `harness-broker`; publishes one coherent timestamped ASP
package set to the producer's loopback Verdaccio; and synchronizes the one
consumer that follows `latest` — **hrc-runtime** — unless `no-sync=1` is passed.
All packages in a published ASP set must share the same version.

That sync runs `just pull-deps` in hrc-runtime, so expect it to advance and
**commit `bun.lock` in that repo** — an install here leaves a commit to push
there. It fails loudly if that lock is already dirty. Do not weaken it back to a
bare `bun run sync:asp`: without `--pull` that only reports staleness and exits
0, which silently published hrc-runtime against a stale ASP lock (T-07727).

**ACP is not a sync target.** agent-control-plane pins ASP and HRC as
operator-managed *producer tuples* and advances them only through its own
governed `just advance-producers` inside a coordinated deployment window. Its own
`docs/producer-advance.md` (in the agent-control-plane repo) names producer
`sync-downstream` — along with `just pull-deps`, routine `just install`,
and a moving `latest` tag — as a mechanism that must never move that tuple: a
producer's install publishes a node-local set and moves `latest`, and that side
effect is not a release signal for ACP. T-07626 deleted ACP's `sync:asp` script
and pinned exact versions in the same commit, so anything here that calls it
fails the whole install. ACP sitting behind the registry is the intended steady
state, not staleness — the `PRODUCER_PINNED` advisory lines exist so registry
movement stays visible without changing the deployed tuple.

Linked worktrees default to the isolated worktree publication channel and do
not repoint global wrappers or synchronize consumer checkouts. Use
`force-link=1` / `force-sync=1` only for an intentional cutover.

The estate has multiple registry stores, and each consumer resolves the endpoint
in its own `.npmrc`. Publish the coherent set once, then mirror those exact
immutable package tarballs into any other store that must satisfy the lock.
Running producer `just install` independently on each node creates timestamp
churn rather than deploying the same artifact.

## Codex Overlay

When changing Codex-facing agent defaults, edit the source under
`~/praesidium/var/agents/` first. Do not edit generated Codex home files or
materialized bundle copies directly.

After changing agent source files, run the ASP overlay recipe from this repo:

```bash
just overlay-codex
```

This runs `scripts/sync-agent-to-codex-default.ts --install-hooks --apply`,
updates the managed block in `~/.codex/AGENTS.md`, syncs managed skills into
`~/.codex/skills`, and leaves unmanaged Codex config/skills alone.

## Build & deploy

Read `~/praesidium/build_deploy_guide.md` before building, installing, or promoting anything in agent-spaces, hrc-runtime, or agent-control-plane. It is the agent digest of the published references `/a/hrc-build-deploy-guide` and `/a/asp-hrc-acp-dev-guide` on the taskboard. The rules that bite most: push before `just install` (a main-checkout install refuses an unpushed or non-clean tree); install ≠ activate (`hrc server restart --reason …`, then read back `runningEqualsInstalled`); an HRC install before `just pull-deps` ships the OLD agent-spaces tuple — and so does one after a `pull-deps` that did not move `bun.lock`, so read back `git log -1 -- bun.lock` before installing; never `bun update`/`bun add` a synced package (`check-lock-coherence` refuses the split lock it leaves); fleet promotion is `just deploy-*` / `just fleet-status`, never by hand.

## Validation

Run these after implementing to get immediate feedback:

- Only run tests (`bun run test`) **after modifying workspace package files AND after manually testing if possible**.
- Tests: `bun run test`
- Typecheck: `bun run typecheck` (run `bun run build` first if workspace typings are missing)
- Lint: `bun run lint` (fix with `bun run lint:fix`)
- Boundary checks: `bun run check:boundaries`, `bun run check:manifests`
- Closeout evidence tiers: see [docs/closeout-evidence.md](docs/closeout-evidence.md)
- Agent enablement changelog / retro step: see [docs/agent-enablement-changelog.md#retro-cadence](docs/agent-enablement-changelog.md#retro-cadence)
- Pack smoke: `bun scripts/smoke-pack-cross-repo.ts` (verifies cross-repo published tarballs don't carry `exports.bun → ./src/*.ts`)
- Harness broker MATRIX smoke (`bun run smoke:matrix`, single row via `--config <name>`) — required for any harness-broker change. **Run it from a real terminal via ghostmux — use the `ghoste2e` skill — NOT inline in your own agent session.** A `ghostmux new` surface is a clean login shell; running inline from a Claude Code session leaks `CLAUDE_CODE_CHILD_SESSION`/`CLAUDE_CODE_SESSION_ID`/`CLAUDECODE` into the child `claude`, which then treats itself as a nested child and skips its own session-transcript persistence. The `real-claude-tmux-midturn` row tails that transcript for the mid-turn `queue-operation`/`enqueue` line, so it then **false-negatives with `midturn_user_prompt_capture: got 0`** even though the steered prompt visibly enqueued — a harness-env artifact, not a code defect. If you must run inline, strip the vars: `env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u TMUX bun run smoke:matrix --config real-claude-tmux-midturn`.
- Pack smoke for `@lherron/agent-spaces` (`cd apps/cli; bun scripts/smoke-test-pack.ts`) — required after packaging changes → see [apps/cli/AGENTS.md](apps/cli/AGENTS.md)
- Pi harness env/runtime flags (`--harness pi`: `PI_CODING_AGENT_DIR`, `--no-skills`, hooks-scripts) → see [drivers/harness-pi/AGENTS.md](drivers/harness-pi/AGENTS.md)

## Project Structure

Directory names under the six workspace roots differ from published package names
(`core/config` = `spaces-config`, `apps/cli` = `@lherron/agent-spaces`, etc.) —
read the package.json when in doubt. Integration tests live in
`integration-tests/`, with fixtures (sample registry/spaces, claude/codex shims)
in `integration-tests/fixtures/`.

## Repo Boundaries

This repo is the ASP layer of the three-repo split (ASP / HRC / ACP). Boundaries
enforced by `bun run check:boundaries`:

- ASP source **must not** import any `hrc-*`, `acp-*`, `gateway-*`,
  `coordination-substrate`, `wrkq-lib`, or `wlearn` package.
- ASP may compile placement policy and task defaults as intent, but HRC's
  binding registry and local placement ledger remain authority. ASP must not
  infer node identity from a host or mutate established placement.
- Cross-repo publishable boundary packages (10 of them — agent-scope, cli-kit,
  spaces-{config,runtime,execution,harness-*}, agent-spaces) MUST have a
  `prepack` step that strips `exports.*.bun` from the published manifest so
  Bun consumers in the HRC/ACP repos resolve `dist/*.js`, not unshipped `src/`.

## Smoke Testing the CLI

Test `asp run` changes with `--dry-run` against the fixture spaces
(`bun apps/cli/bin/asp.js run integration-tests/fixtures/sample-registry/spaces/base --dry-run`
— no build step needed; prefix the codex-shim fixture onto PATH for codex
dry-runs). Two gotchas:

- Set `ASP_HOME` to a writable path (e.g. `/tmp/asp-test`) or temp-dir creation fails with EPERM.
- `asp run` does not accept a `--prompt` flag.

For the harness-broker MATRIX smoke (`bun run smoke:matrix`, required for any
harness-broker change) see [harness/harness-broker/AGENTS.md](harness/harness-broker/AGENTS.md).
For the published-CLI pack smoke (`cd apps/cli; bun scripts/smoke-test-pack.ts`)
see [apps/cli/AGENTS.md](apps/cli/AGENTS.md).

## Error Handling

`asp run` must never silently swallow errors — exit immediately, let errors
propagate visibly, and throw explicit errors for invalid states.

## Pi Harness

When running with `--harness pi`, follow the env/runtime flags in
[drivers/harness-pi/AGENTS.md](drivers/harness-pi/AGENTS.md)
(`PI_CODING_AGENT_DIR`, `--no-extensions`, `--no-skills`, hooks-scripts).
