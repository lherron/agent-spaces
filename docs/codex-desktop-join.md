# Codex Desktop self-join

How a Codex Desktop thread gets its registered Stella address, how to read the
trail it leaves, and what happens to mail across the switch. The design is
`docs/proposals/codex-desktop-driver.md` §4/§6. This page covers operation.

## Path

1. The overlay's discovery hook (`~/.codex/.asp-agent-sync/desktop-registration-discovery.mjs`)
   runs on `SessionStart` and on every `UserPromptSubmit`. It resolves the
   active aspd release and spawns `<release>/harness-broker desktop-join`
   detached, then exits 0. The joiner's stdout/stderr are appended to
   `~/.codex/hrc-desktop/<thread>/joiner.stderr.log`.
2. The joiner admits the thread from its rollout's first line, then claims
   `~/.codex/hrc-desktop/<thread>/broker.pid`, the per-thread door.
3. It resolves the project from `wrkq projects --json`. That command is an RPC
   client of the remote ledger. Each successful read is saved to
   `~/.codex/hrc-desktop-registry.json`. When wrkq is slow or down, the joiner
   uses that last-good copy.
4. It serves the broker socket, registers and attaches with HRC, writes
   `join.json` and the address cache `~/.codex/hrc-desktop-scopes/<thread>.json`,
   and logs `joined`. From then on it serves until it is killed.

## Bounds

The joiner has one deadline, `--deadline-ms`, which defaults to 60 s. The wrkq
read is bounded at 5 s and each HRC request at 10 s. A failure inside the
deadline is retried with backoff (0.5 s, 1 s, 2 s and so on, capped at 5 s). A
joiner that has not reached `joined` by the deadline logs `join-deadline`,
releases `broker.pid` and exits. The next hook then tries again.

A later joiner treats a live holder of `broker.pid` as one of:

- **serving**: `join.json` says `joined` for that pid. The later joiner logs
  `already-serving` and exits, whatever the claim's age.
- **joining**: the claim is younger than deadline + 15 s. The later joiner logs
  `join-in-progress` and exits.
- **stalled**: the claim is older than that and the holder never joined. The
  later joiner logs `stalled-holder` and takes over the claim. It sends SIGKILL
  only when `ps` shows the holder is a `desktop-join` for this thread, so a
  reused pid is never signalled.

## join.log

Each line is one JSON object. `pid` is always the process that wrote the line,
and a process it refers to appears as `holderPid`.

| event | meaning |
|---|---|
| `not-admitted` | not a registrable Desktop user thread, e.g. a subagent. Normal. |
| `claimed` | this joiner holds `broker.pid`. `previousHolder` is `dead` or `stalled` when it took over a claim. |
| `already-serving` / `join-in-progress` | another joiner owns the door. This one exits. |
| `stalled-holder` | the previous claim was replaced (see Bounds). |
| `registry-unavailable` | the wrkq read failed and no last-good copy exists. `retryable` says whether another attempt fits inside the deadline. |
| `registry-last-good` | wrkq failed. The joiner used the saved registry; `ageMs` is that copy's age. |
| `join-transport-error` | an HRC request failed or timed out. It is retried like `registry-unavailable`. |
| `join-deadline` | the joiner gave up at `phase`. `broker.pid` was released. |
| `no-project`, `join-refused`, `serve-failed`, `socket-path-over-budget` | typed refusals. The joiner exits 0. |
| `joined` | registered. `elapsedMs` is the time since the joiner started. |
| `signal` / `crashed` | termination by signal, or by an uncaught throw or rejection. The `phase` field says where. |
| `exit` | the last line from every joiner, with `code` and `phase`. |

Only SIGKILL ends a joiner without an `exit` line. For that, read
`joiner.stderr.log` and the next joiner's `claimed` line.

## Mail across the switch

Until `joined`, the PreToolUse hook gives each managed command the provisional
address `<agent>@<project>:codex-<thread>`. It reports `HRC registration:
pending`. Every command that starts after the address cache exists gets the
registered address.

- A command keeps the address it started with. A `wrkc say … --wait` begun
  while pending waits as `codex-<thread>` and consumes a reply sent to that
  address, even after the thread has switched. Incident 2026-10-01: EN-21812
  was `consumed_by_wait` 39 s after the switch.
- HRC persists mail sent to a `codex-<uuid>` address but never summons a
  runtime for it or delivers it (`isCodexAppOwnedScopeRef`, hrc-core). Only a
  live waiter or a poll from the thread consumes it.
- Nothing forwards or re-addresses provisional mail (§4: earlier addresses
  remain historical). Mail sent to the provisional address after the switch,
  with no waiter alive, stays pending there. Address new mail to the
  registered scope.
