# 8. The harness broker

`harness-broker` hosts one harness invocation per process behind the `harness-broker/0.3` JSON-RPC protocol
(stdio for tools and tests, unix socket for HRC's durable runtimes) and normalizes the harness's native events into
the invocation event vocabulary. Code: `harness/harness-broker/src/{cli.ts,broker.ts,broker-methods.ts,
operator-cli.ts,invocation-*.ts,drivers/}`, protocol in `contracts/harness-broker-protocol`, client in
`contracts/harness-broker-client`, the matrix in `scripts/pre-hrc-broker-matrix-e2e.ts`. Repo notes: `AGENTS.md`
"Broker Injection Doors" and `harness/harness-broker/AGENTS.md`.

## Sub-features

- `harness-broker run --transport stdio|unix`; `broker.hello` answers `brokerInfo`, `protocolVersion`,
  `capabilities` (transports, inspection) and `drivers[]` (`codex-app-server`, `codex-desktop`, `muse-serve`,
  `muse-cli-tmux`, `arris-resident`, `claude-code-tmux`) each with `version`, admission classes, steer/queue/preempt
  evidence, lifecycle and `evidenceAuthority` (14 families; `turn-bracket` is `hook` for claude-code-tmux, `native`
  for the rest).
- Operator verbs against a unix socket: `capture status`, `submission withdraw`, and `capture release`, which is
  retained on the wire but a no-op since T-07883 (every release is refused). `harness-broker drivers [--json]` lists
  the six drivers without a socket. `run --transport unix` needs `--socket <path>`.
- The other `cli.ts` verbs are not operator-facing: `run-once` and `validate-start-request` are developer/test debug
  (`validate-start-request --file <json>` refuses an invalid start request, exit 1); `evidence-read` (HRC),
  `desktop-join` (the Codex overlay's discovery hook), `claude-hook`, `claude-hook-decision`, `codex-hook`,
  `codex-tui-wrapper`, `tmux-launch` and `renderer` are harness plumbing that drivers and hooks invoke.
- The pre-HRC matrix (`bun run smoke:matrix [--config row] [--compile-transport sdk|aspc-rpc] [--json]`): compiles a
  v2 request, starts the broker through the compiled dispatch request, drives a turn, and checks the event types,
  terminal turns and continuation. Rows: `fake-codex`, `unix-jsonrpc-ndjson` (shim-backed, no model), and
  `real-codex`, `codex-tui`, `real-claude-tmux`, `real-muse-serve`, `muse-tmux` (real harnesses and logins).

## How to get to it

`avs broker-hello` for the handshake. The matrix runs from `~/praesidium/agent-spaces` with the Claude seat
variables stripped (`env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u
CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u TMUX`), or from a ghostmux surface (skill `ghoste2e`). The real
rows belong to a harness-broker change's own acceptance; a verification pass drives the two shim rows.

## Driving it

```bash
avs broker-hello                                            # harness-broker/0.3, six drivers available
harness-broker drivers --json                               # the same six, available: true
env -u CLAUDECODE … bun run smoke:matrix --config fake-codex --json
env -u CLAUDECODE … bun run smoke:matrix --config unix-jsonrpc-ndjson --compile-transport aspc-rpc --json   # flag redundant: the row forces aspc-rpc
harness-broker capture status --socket /tmp/avs-no-such.sock --invocation inv-none --json   # one-line error naming the path, exit 1
harness-broker submission withdraw x --socket /tmp/avs-no-such.sock --reason avs           # same one-line error, exit 1
harness-broker run --transport bogus                        # Unknown or missing transport: bogus, exit 1
harness-broker bogus-verb                                   # usage, exit 1
```

## Gotchas

- **The installed broker is the checkout.** `~/.bun/bin/harness-broker` resolves to `harness/harness-broker` in the
  canonical checkout and runs `src/` (its stack traces name `agent-spaces/harness/harness-broker/src/…`), so the
  shim rows and `broker-hello` exercise whatever is saved in the shared tree. HRC's durable runtimes run the aspd
  release's `libexec/harness-broker` instead (2026-10-05, `T-10300/08-harness-broker/drive.txt`).
- Inline from a Claude seat, the leaked `CLAUDE_CODE_*` variables make a child `claude` skip transcript persistence
  and a real claude-tmux mid-turn check false-negatives (`AGENTS.md`); strip them as above. `AGENTS.md` calls that
  check `real-claude-tmux-midturn`, which is not a matrix row: `--config real-claude-tmux-midturn` throws `--config
  must name one of: …`, exit 1 (2026-10-19, `T-11375/08-harness-broker/drive.txt`).
- The matrix does not use `~/.bun/bin/harness-broker`; it spawns `harness/harness-broker/bin/harness-broker.js`
  next to the script, so a run from a scratch clone tests that clone (source, `pre-hrc-broker-matrix-e2e.ts:648-652`).
- `smoke:matrix --json` stdout starts with a `<row>: OK` status line before the JSON report; parse from the first
  `{`. Its `eventTypes` is the sorted set of types seen, not arrival order (2026-10-05,
  `T-10364/08-harness-broker/drive.txt`, `matrix-summary.py` there).
- Bare `harness-broker` (or an unknown verb) prints three `Usage:` blocks: `run --transport stdio`, `capture` and
  `submission`; `drivers` and the plumbing verbs are unlisted. Product gap, T-10365 (open).
- `--compile-transport aspc-rpc` spawns a checkout aspc-facade over stdio; it does not go through aspd. The
  `unix-jsonrpc-ndjson` row forces it (the name is the compile transport, not a broker socket); to compile
  `fake-codex` over aspc-rpc pass the flag to that row.

## Proven when

`broker-hello` returns protocol 0.3 with every driver `available: true`; each shim row reports `status: OK`, 26
events, 1 terminal turn, `continuationObserved: true`, no failures, and the 17-type set (`admission.*`,
`assistant.message.{started,delta,completed}`, `continuation.updated`, `input.accepted`, `invocation.{started,ready}`,
`provider.transcript.reported`, `submission.executed`, `tool.call.{started,delta,completed}`, `turn.{started,
completed}`, `user.message`; no `usage.updated`, since the fixture reports no tokens); the operator verb refusals
exit 1.

Driven 2026-10-19 against checkout f8c96a5e (T-11375): `var/wrkq-artifacts/T-11375/08-harness-broker/drive.txt`
(row JSON beside it).
Not driven: the five real-harness matrix rows (they need model logins and, for tmux rows, a ghostmux surface).
