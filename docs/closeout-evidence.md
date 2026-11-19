# Closeout Evidence

Core rule: closeout evidence must match the strongest surface touched or claimed.
For any completion claim C, the cited evidence tier must be >= the strongest
changed-or-claimed surface in C. If the required evidence cannot be run, the
closeout must say BLOCKED / not fully validated instead of claiming done. A
real-behavior claim closed on weaker evidence is NOT done.

| Claim class | Minimum evidence |
| --- | --- |
| Docs / router / convention-only change | `bun scripts/check-doc-reachability.ts` plus prose review. No product-behavior claim may be closed from this alone. |
| Pure logic / refactor with no protocol or runtime surface | Relevant unit or contract tests green. Include typecheck when TS types or exported internals moved. |
| Protocol / DTO / public contract surface | A covering contract test or matrix row. The S7 public-surface sensor is necessary GUARD coverage: it proves presence, not semantic correctness. |
| Packaging / distribution / installability surface | Pack smoke evidence: root `bun scripts/smoke-pack-cross-repo.ts` for cross-repo package/export-boundary changes, and `cd apps/cli; bun scripts/smoke-test-pack.ts` for `@lherron/agent-spaces` package/CLI packaging changes. |
| Harness / broker behavior | The existing harness-broker matrix bar, `bun run smoke:matrix`; see [harness/harness-broker/AGENTS.md](../harness/harness-broker/AGENTS.md). If a row is unavailable, name the unavailable row/blocker. For harness-broker changes, the package guidance remains the stronger local rule. |
| Real integration / installed-runtime behavior: HRC, ACP, Discord, Ghostty, installed binaries, launchd, live services | Real e2e evidence against the installed/running system. Mock-only or unit-only evidence cannot close that claim. |

## Smoke procedures

### Harness broker matrix

Run the matrix after any harness-broker change. Use `bun run smoke:matrix` for
the full matrix or `--config <name>` for one row. Follow the
[broker matrix instructions](../harness/harness-broker/AGENTS.md) and use the
`ghoste2e` skill to run from a clean `ghostmux new` terminal.

A shell inside Claude Code can leak `CLAUDE_CODE_CHILD_SESSION`,
`CLAUDE_CODE_SESSION_ID`, and `CLAUDECODE` into the child Claude process.
The child then treats itself as nested and skips persisting its transcript.
The `real-claude-tmux-midturn` row looks for the mid-turn
`queue-operation`/`enqueue` transcript line, so nested execution can report
`midturn_user_prompt_capture: got 0` even when the steer enqueued.

If inline execution is unavoidable, clear the inherited session variables:

```bash
env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
  -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u TMUX \
  bun run smoke:matrix --config real-claude-tmux-midturn
```

### CLI dry-run smoke

Test `asp run` changes from the repository root against the fixture spaces.
The default `agent-harness` requires a validated agent profile, so select
Codex explicitly for this bare fixture space.

```bash
ASP_HOME=/tmp/asp-test ASP_CODEX_PATH="$PWD/integration-tests/fixtures/codex-shim/codex" \
  bun apps/cli/bin/asp.js run integration-tests/fixtures/sample-registry/spaces/base \
  --harness codex --dry-run
```

Choose a writable `ASP_HOME` to avoid `EPERM` during temporary directory
creation. See the
[CLI package instructions](../apps/cli/AGENTS.md) for the published CLI pack smoke.
