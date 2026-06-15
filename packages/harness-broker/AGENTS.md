## Harness Broker Smoke

For any harness-broker change, always run the pre-HRC broker MATRIX smoke before
declaring the work completed. ONE parameterized runner
(`scripts/pre-hrc-broker-matrix-e2e.ts`) iterates every implemented harness
configuration, drives the SAME canonical command turn through each, and validates
the SAME normalized broker event vocabulary. It compiles a `CompiledRuntimePlan`,
selects the `BrokerExecutionProfile`, verifies plan/profile/spec/start-request
hashes, and starts the broker via `BrokerClient.startInvocationFromRequest(...)` —
it never uses the legacy direct-builder path. (The old per-harness scripts —
`smoke-runtime-contract-broker-{fake,real}-codex` and the phase5
`real-claude-tmux` / `ghostmux-attach` runners — were retired in favor of this
matrix once it subsumed them; the signed interactive-tmux flow now lives in
`packages/agent-spaces/src/testing/pre-hrc-interactive-tmux-runner.ts` +
`pre-hrc-ghostmux-operator.ts`.)

Full matrix (every row gated on availability; each SKIPs cleanly when its
binary/auth/Ghostty is absent):

```bash
bun run smoke:matrix
```

Single row via the `--config` selector:

```bash
bun run smoke:matrix --config fake-codex           # deterministic CI (no auth/network)
bun run smoke:matrix --config real-codex           # real codex app-server (+ auth)
bun run smoke:matrix --config real-claude-tmux      # real claude, interactive-tmux
bun run smoke:matrix --config claude-tmux-ghostmux  # real claude + ghostmux operator-attach
```

Rows: (a) fake-codex (codex-app-server headless against an in-repo fixture), (b)
real-codex (real `codex`), (c) real-claude-tmux (claude-code-tmux interactive
against real `claude`), (d) claude-tmux-ghostmux (real ghostmux operator-attach).
Codex.app app-server shim experiment (T-04237) is off by default; enable by quitting Codex.app and copying `scripts/codex-app-bundle-wrapper` to `/Applications/Codex.app/Contents/Resources/codex` while `/Applications/Codex.app/Contents/Resources/codex.real` is the real binary.
Cross-harness floor on every row: compile/select/verify start-contract (hashes +
route invariants) + ledger integrity (monotonic seq / no dup / normalized vocab
only) + invocation.started/ready + `assertSharedCommandTurn` on the command turn.
The runner exercises `packages/harness-broker/bin/harness-broker.js run --transport
stdio`. Strict mode is on by default: native Codex event names fail the run, and
the legacy `invocation.permission.request` event is rejected unless the temporary
`--allow-legacy-permission-event` flag is passed. Do not report a harness-broker
change as complete unless this smoke has passed, or you have clearly reported the
blocker that prevented running it.

### Gotcha: do NOT run the claude-tmux rows from inside a Claude Code session

The `real-claude-tmux*` rows (especially `real-claude-tmux-midturn`) assert on
the child `claude`'s **session transcript** — the driver's hook-transcript reader
tails `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` for the mid-turn
`queue-operation`/`enqueue` line. If you launch the matrix from a shell that is
itself a Claude Code session (e.g. the `clod` agent), the spawned child `claude`
inherits `CLAUDECODE=1` + `CLAUDE_CODE_CHILD_SESSION=1` + `CLAUDE_CODE_SESSION_ID`
and treats itself as a nested child — it does **not** persist its own transcript
at the path its `SessionStart` hook reports. The reader then reads nothing
(`lines=0` every hook) and `real-claude-tmux-midturn` FAILS with
`midturn_user_prompt_capture: got 0` even though the steered prompt visibly
enqueued. This is a **false negative from the harness environment, not a code
defect**.

**Run the matrix from a real terminal via ghostmux — use the `ghoste2e` skill.**
A `ghostmux new` surface is a clean login shell that does NOT inherit the calling
agent's `CLAUDE_CODE_*` vars, so the child `claude` persists its transcript
normally and the claude-tmux rows behave correctly. This is the recommended way
for an agent to run `smoke:matrix`: drive it through ghostmux (the same harness
the `ghoste2e` skill uses) rather than executing `bun run smoke:matrix` inline in
your own session. Sketch:

```bash
SID=$(ghostmux new --json --cwd "$PWD" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
ghostmux send-keys -t "$SID" 'ASP_CODEX_PATH=$(command -v codex) bun run smoke:matrix --config real-claude-tmux-midturn'
# poll `ghostmux capture-pane -t "$SID"` for the row result; ghostmux kill-surface -t "$SID" when done
```

If you must run inline from a non-Claude-Code shell, strip the inherited vars
instead:

```bash
env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
    -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u TMUX \
    bun run smoke:matrix --config real-claude-tmux-midturn
```
