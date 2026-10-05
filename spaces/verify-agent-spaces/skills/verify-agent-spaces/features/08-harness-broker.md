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
  `muse-cli-tmux`, `arris-resident`, `claude-code-tmux`) each with admission classes, steer/queue/preempt
  evidence and lifecycle.
- Operator verbs against a unix socket: `capture status|release`, `submission withdraw`.
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
env -u CLAUDECODE … bun run smoke:matrix --config fake-codex --json
env -u CLAUDECODE … bun run smoke:matrix --config unix-jsonrpc-ndjson --compile-transport aspc-rpc --json
harness-broker capture status --socket /tmp/avs-no-such.sock --invocation inv-none --json   # exit 1
harness-broker bogus-verb                                   # usage, exit 1
```

## Gotchas

- **The installed broker is the checkout.** `~/.bun/bin/harness-broker` resolves to `harness/harness-broker` in the
  canonical checkout and runs `src/` (its stack traces name `agent-spaces/harness/harness-broker/src/…`), so the
  shim rows and `broker-hello` exercise whatever is saved in the shared tree. HRC's durable runtimes run the aspd
  release's `libexec/harness-broker` instead (2026-10-05, `T-10300/08-harness-broker/drive.txt`).
- `capture status` against a missing socket dies with a raw Bun stack trace (`connect ENOENT`) instead of a typed
  error. Product gap.
- Inline from a Claude seat, the leaked `CLAUDE_CODE_*` variables make a child `claude` skip transcript persistence
  and the `real-claude-tmux-midturn` check false-negatives (`AGENTS.md`); strip them as above.
- `--compile-transport aspc-rpc` spawns a checkout aspc-facade over stdio; it does not go through aspd.

## Proven when

`broker-hello` returns protocol 0.3 with every driver `available: true`; each shim row reports `status: OK`, 26
events, 1 terminal turn, `continuationObserved: true`, no failures, and an event-type set running from
`invocation.started` through `turn.completed` with tool and assistant events; the operator verb refusals exit 1.

Driven 2026-10-05 against checkout dc5e8bf (T-10300): `var/wrkq-artifacts/T-10300/08-harness-broker/drive.txt`.
Not driven: the five real-harness matrix rows (they need model logins and, for tmux rows, a ghostmux surface).
