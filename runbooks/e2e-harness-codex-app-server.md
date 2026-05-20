# Runbook — Harness Broker e2e smoke against real Codex app-server

End-to-end verification that `spaces-harness-broker` drives a real `codex app-server` process through full turn lifecycle, including tool execution.

**Last validated:** 2026-05-20 against codex-cli 0.130.0.

---

## Prerequisites

- `codex` binary installed and on PATH (`codex --version` returns `codex-cli 0.130.0` or newer).
- `codex login` already completed (auth credentials present in `~/.codex/`).
- `bun` installed.
- Working tree at the project root with `feat-harness-broker` (or wherever the broker now lives) checked out.
- Broker source built / runnable from `packages/harness-broker/bin/harness-broker.js`.

## Step 1 — Confirm the broker sees the driver

```sh
bun packages/harness-broker/bin/harness-broker.js drivers --json | jq '.[0]'
```

Expected: `codex-app-server` driver listed with `available: true` and the spec §8 v0 capability matrix. If `available: false`, the broker build is out of date — rebuild before continuing.

## Step 2 — Prepare a working dir + spec + input

```sh
mkdir -p /tmp/clod-broker-smoke

cat > /tmp/clod-broker-smoke/spec.json <<'JSON'
{
  "specVersion": "harness-broker.invocation/v1",
  "harness": {
    "frontend": "codex",
    "provider": "openai",
    "driver": "codex-app-server"
  },
  "process": {
    "command": "codex",
    "args": ["app-server"],
    "cwd": "/tmp/clod-broker-smoke",
    "harnessTransport": { "kind": "jsonrpc-stdio" },
    "limits": {
      "startupTimeoutMs": 30000,
      "turnTimeoutMs": 120000,
      "stopGraceMs": 5000
    }
  },
  "interaction": {
    "mode": "headless",
    "turnConcurrency": "single",
    "inputQueue": "none"
  },
  "driver": {
    "kind": "codex-app-server",
    "approvalPolicy": "never",
    "sandboxMode": "workspace-write",
    "resumeFallback": "start-fresh",
    "permissionPolicy": { "mode": "deny" }
  }
}
JSON
```

Pick ONE input scenario per run.

### Scenario A — message-only (no tool execution)

```sh
cat > /tmp/clod-broker-smoke/input.json <<'JSON'
{
  "kind": "user",
  "content": [
    { "type": "text", "text": "Respond with exactly the word HELLO and nothing else." }
  ]
}
JSON
```

### Scenario B — tool execution (pwd + ls)

```sh
cat > /tmp/clod-broker-smoke/input.json <<'JSON'
{
  "kind": "user",
  "content": [
    { "type": "text", "text": "Run `pwd` and then `ls` in the current working directory. After both commands complete, tell me what's in this directory in one short sentence." }
  ]
}
JSON
```

## Step 3 — Run the broker

```sh
timeout 120 bun packages/harness-broker/bin/harness-broker.js run-once \
  --spec /tmp/clod-broker-smoke/spec.json \
  --input /tmp/clod-broker-smoke/input.json
```

Each line of stdout is one normalized broker event (NDJSON). Stderr is diagnostics only.

## Step 4 — Verify the event stream

### Scenario A (message-only) — expected event types in order

```
seq  1  invocation.started          (real pid, command, args, cwd)
seq  2  continuation.updated        (provider:"codex", kind:"thread", real thread UUID)
seq  3  invocation.ready
seq  4  input.accepted
seq  5  turn.started
seq  6  assistant.message.started
seq  7  assistant.message.delta      (text fragment, e.g. "HEL")
seq  8  assistant.message.delta      (text fragment, e.g. "LO")
seq  9  assistant.message.completed  (content: [{type:"text", text:"HELLO"}], final:true)
seq 10  usage.updated                (real token counts)
seq 11  turn.completed               (status:"completed")
seq 12  invocation.stopping          (reason:"run-once complete")
seq 13  invocation.exited            (exitCode:0, signal:null)
```

Total elapsed: ~4–6 seconds.

### Scenario B (tool exec) — expected event types in order

```
seq  1-5   invocation.started → continuation.updated → invocation.ready → input.accepted → turn.started
seq  6     usage.updated         (early model planning tokens)
seq  7     tool.call.started     (name:"command")         ← pwd
seq  8     tool.call.completed   (isError:false)
seq  9     tool.call.started     (name:"command")         ← ls
seq 10     tool.call.completed   (isError:false)
seq 11     assistant.message.started
seq 12-N   assistant.message.delta (token-by-token streaming of the answer)
seq N+1    assistant.message.completed
            (content includes the real cwd "/private/tmp/clod-broker-smoke" and the real file list "input.json"/"spec.json")
seq N+2    usage.updated         (final token counts)
seq N+3    turn.completed
seq N+4    invocation.stopping
seq N+5    invocation.exited     (exitCode:0)
```

Total elapsed: ~10–15 seconds.

### Pass criteria

- Exactly one terminal event (`invocation.exited` with `exitCode:0`).
- `seq` is monotonically increasing starting at 1 with no gaps.
- `invocation.started.payload` contains `pid`, `command`, `args`, `cwd` but **no env values** (security check).
- For Scenario B, the assistant's final `content[0].text` references the real cwd AND the real file list (proves codex actually executed the commands, not hallucinated).
- `turn.completed.payload.status === "completed"` (not `"failed"` or `"interrupted"`).

### Quick automated pass check

```sh
timeout 120 bun packages/harness-broker/bin/harness-broker.js run-once \
  --spec /tmp/clod-broker-smoke/spec.json \
  --input /tmp/clod-broker-smoke/input.json \
  | jq -s '
    {
      total: length,
      types: [.[].type],
      final_text: (map(select(.type == "assistant.message.completed")) | .[-1].payload.content[0].text // null),
      turn_status: (map(select(.type == "turn.completed")) | .[-1].payload.status // null),
      exit_code: (map(select(.type == "invocation.exited")) | .[-1].payload.exitCode // null),
      env_in_started: (map(select(.type == "invocation.started")) | .[-1].payload | has("env"))
    }
  '
```

Pass: `turn_status == "completed"`, `exit_code == 0`, `env_in_started == false`, `final_text` matches expected.

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `BrokerError: Invalid request: invalid type: string "workspace-write", expected internally tagged enum SandboxPolicyDeserialize` | sandboxMode encoding drift between broker and codex (regression of T-01550) | Re-check `packages/harness-broker/src/drivers/codex-app-server/sandbox-policy.ts` translation — codex expects internally-tagged enum, not bare string. |
| Stream ends at `input.accepted` followed immediately by `invocation.stopping` (no turn events, all 6 events within ~5ms) | run-once not awaiting turn completion (regression of T-01551) | Check run-once orchestration in `packages/harness-broker/src/cli.ts` — must await `turn.completed`/`failed`/`interrupted` before stopping. |
| Stream stops at `invocation.failed` during startup with no `continuation.updated` | Codex auth missing or stale | Run `codex login`, retry. |
| `Cannot find module '../src/drivers/codex-app-server/driver'` when running `bun test` | Phase 2 impl missing on this branch | `git checkout feat-harness-broker` or whatever branch holds Phase 0–4 commits. |
| Driver shows `available: false` in `drivers --json` | Broker built without Phase 2 driver registration | Pull the latest `feat-harness-broker` HEAD. |
| Tool calls emit `tool.call.started` + `tool.call.completed` but no `tool.call.delta` for short commands | Known limitation against codex 0.130.0 — codex does not emit `outputDelta` items for short commands. Not a defect. | Consumers needing delta visibility should test against a long-running command (e.g., `find /usr -type f`). |
| `tool.call.completed.payload.durationMs == 0` | Broker doesn't compute tool duration; codex doesn't expose start→end timestamps. Cosmetic. | Open a follow-up if duration matters; otherwise ignore. |

## Cleanup

```sh
rm -rf /tmp/clod-broker-smoke
```

## Related

- Spec: `harness-broker-spec.md` §10, §10.4 (Codex event mapping), §10.5 (resume fallback), §16.3 (driver scenarios)
- Implementation plan: `harness-broker-impl.md` § Phase 2, § Phase 5 (HRC migration)
- Defects fixed during initial validation: T-01550 (sandboxMode), T-01551 (run-once lifecycle)
