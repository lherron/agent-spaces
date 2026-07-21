## Build & Run

This is a Bun monorepo with packages in `packages/*`.

```bash
bun install       # Install dependencies
bun run build     # Build all packages
```

## Install and Publish Contract

On the main checkout, `just install` cleans, installs, and builds; links both
the `asp` CLI and `harness-broker`; publishes one coherent timestamped ASP
package set to the producer's loopback Verdaccio; and synchronizes HRC/ACP consumers
unless `no-sync=1` is passed. All packages in a published ASP set must share the
same version.

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

## Validation

Run these after implementing to get immediate feedback:

- Only run tests (`bun run test`) **after modifying files under `packages/*` AND after manually testing if possible**.
- Tests: `bun run test`
- Typecheck: `bun run typecheck` (run `bun run build` first if workspace typings are missing)
- Lint: `bun run lint` (fix with `bun run lint:fix`)
- Boundary checks: `bun run check:boundaries`, `bun run check:manifests`
- Closeout evidence tiers: see [docs/closeout-evidence.md](docs/closeout-evidence.md)
- Agent enablement changelog / retro step: see [docs/agent-enablement-changelog.md#retro-cadence](docs/agent-enablement-changelog.md#retro-cadence)
- Pack smoke: `bun scripts/smoke-pack-cross-repo.ts` (verifies cross-repo published tarballs don't carry `exports.bun → ./src/*.ts`)
- Harness broker MATRIX smoke (`bun run smoke:matrix`, single row via `--config <name>`) — required for any harness-broker change. **Run it from a real terminal via ghostmux — use the `ghoste2e` skill — NOT inline in your own agent session.** A `ghostmux new` surface is a clean login shell; running inline from a Claude Code session leaks `CLAUDE_CODE_CHILD_SESSION`/`CLAUDE_CODE_SESSION_ID`/`CLAUDECODE` into the child `claude`, which then treats itself as a nested child and skips its own session-transcript persistence. The `real-claude-tmux-midturn` row tails that transcript for the mid-turn `queue-operation`/`enqueue` line, so it then **false-negatives with `midturn_user_prompt_capture: got 0`** even though the steered prompt visibly enqueued — a harness-env artifact, not a code defect. If you must run inline, strip the vars: `env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u TMUX bun run smoke:matrix --config real-claude-tmux-midturn`.
- Pack smoke for `@lherron/agent-spaces` (`cd packages/cli; bun scripts/smoke-test-pack.ts`) — required after packaging changes → see [packages/cli/AGENTS.md](packages/cli/AGENTS.md)
- Pi harness env/runtime flags (`--harness pi`: `PI_CODING_AGENT_DIR`, `--no-skills`, hooks-scripts) → see [packages/harness-pi/AGENTS.md](packages/harness-pi/AGENTS.md)

## Project Structure

```
packages/
├── agent-scope/      # ScopeRef/ScopeHandle/SessionRef/SessionHandle utilities
├── cli-kit/          # Shared Commander helpers, validators, CLI utilities
├── config/           # spaces-config: config-time determinism, resolution, locks, materialization
├── runtime/          # spaces-runtime: harness-agnostic runtime/session contracts
├── execution/        # spaces-execution: run-time orchestration and harness dispatch
├── harness-claude/   # Claude CLI + Agent SDK adapters
├── harness-codex/    # Codex adapter
├── harness-pi/       # Pi CLI adapter
├── harness-pi-sdk/   # Pi SDK adapter
├── agent-spaces/     # Public host-facing client surface
└── cli/              # `asp` CLI entry point (@lherron/agent-spaces)
```

Integration tests live in `integration-tests/`.

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

**Always test `asp run` changes with `--dry-run`** to verify the generated Claude command without actually launching Claude.

Run CLI commands with `--dry-run` to verify behavior without launching Claude:

```bash
# Run CLI directly with bun (no build step needed)
bun packages/cli/bin/asp.js <command>

# Set ASP_HOME to a writable path (avoids EPERM creating temp dirs)
ASP_HOME=/tmp/asp-test

# Test with a local space (dev mode)
ASP_HOME=/tmp/asp-test bun packages/cli/bin/asp.js run \
  integration-tests/fixtures/sample-registry/spaces/base --dry-run

# For codex harness dry-runs without a local Codex install
PATH=integration-tests/fixtures/codex-shim:$PATH \
  ASP_HOME=/tmp/asp-test bun packages/cli/bin/asp.js run \
  integration-tests/fixtures/sample-registry/spaces/base --dry-run --harness codex

# Test inherit flags
bun packages/cli/bin/asp.js run <space-path> --dry-run --inherit-all
bun packages/cli/bin/asp.js run <space-path> --dry-run --inherit-project --inherit-user

# Test settings composition (add [settings] to a space.toml first)
bun packages/cli/bin/asp.js run <space-path> --dry-run  # should show --settings flag
```

Note: `asp run` does not accept a `--prompt` flag.

Test fixtures are in `integration-tests/fixtures/`:
- `sample-registry/spaces/` - Various test spaces (base, frontend, backend, etc.)
- `sample-project/` - Project with asp-targets.toml
- `claude-shim/` - Mock claude binary for tests

For the harness-broker MATRIX smoke (`bun run smoke:matrix`, required for any
harness-broker change) see [packages/harness-broker/AGENTS.md](packages/harness-broker/AGENTS.md).
For the published-CLI pack smoke (`cd packages/cli; bun scripts/smoke-test-pack.ts`)
see [packages/cli/AGENTS.md](packages/cli/AGENTS.md).

## Codebase Patterns

- TypeScript with strict mode and `exactOptionalPropertyTypes`
- Optional properties use `prop?: T | undefined` pattern
- Biome for linting/formatting
- JSON schemas in `packages/config/src/core/schemas/`
- Error classes in `packages/config/src/core/errors.ts`

## Error Handling

`asp run` should **never** silently capture errors. It should always exit immediately when an error occurs.

- Do not use try/catch blocks that swallow errors
- Let filesystem errors propagate naturally
- Throw explicit errors for invalid states (e.g., missing bundle)
- Errors should be visible to the user, not hidden

## Pi Harness

When running with `--harness pi`, follow the env/runtime flags in
[packages/harness-pi/AGENTS.md](packages/harness-pi/AGENTS.md)
(`PI_CODING_AGENT_DIR`, `--no-extensions`, `--no-skills`, hooks-scripts).
