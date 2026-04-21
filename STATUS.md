# ACP Interface — session hand-off 2026-04-20 end-of-day

## TL;DR

Phases 1–7 of ACP_MINIMAL_INTERFACE.md are shipped and closed. Single-turn Discord replies from the real HRC-backed launcher work. The blocker for multi-turn continuity is **not** an ACP bug — it's that HRC does not capture headless codex assistant output into the per-run `events` table. **T-01155** is filed with a verified JSONL schema and dispatched to a fresh `cody@agent-spaces:T-01155`. Pick up from there.

T-01152 (the original continuity task) is tainted by false starts and should not be resumed — treat T-01155 as the replacement.

## Shipped + closed

| Phase | Task | Deliverable |
|---|---|---|
| P1 | T-01145 | `packages/acp-core/src/interface/` — types + `resolveBinding` |
| P2 | T-01146 | `packages/acp-interface-store/` — SQLite bindings/deliveries/message-sources |
| P3 | T-01147 | `packages/acp-server/src/handlers/interface-*.ts` + `gateway-deliveries-*.ts` — 6 HTTP endpoints |
| P4 | T-01148 | `packages/acp-server/src/delivery/{interface-response-capture,visible-assistant-messages}.ts` |
| P5 | T-01149 | `packages/acp-e2e/test/e2e-interface.test.ts` |
| P6 | T-01150 | `packages/gateway-discord/` — ported from legacy CP |
| P7 | T-01151 | `packages/acp-server/src/real-launcher.ts` — real HRC-backed launcher |

`echo-launcher.ts` gated behind `ACP_DEV_ECHO_LAUNCHER=1`; `real-launcher.ts` gated behind `ACP_REAL_HRC_LAUNCHER=1`. Both resolved in `packages/acp-server/src/deps.ts` via `resolveLauncherDeps`.

## Verified operational state (2026-04-20 ~19:00 UTC)

- **Legacy CP stack is DOWN** (`stackctl down dev`). Do NOT restart — would race on the Discord bot token.
- **HRC daemon is UP** at `/Users/lherron/praesidium/var/run/hrc/hrc.sock`.
- **HRC SQLite DB**: `/Users/lherron/praesidium/var/state/hrc/state.sqlite` (not `/var/db/hrc.db` — that's stale).
- **ACP binding** `ifb_ed707cf0a311` → `gatewayId: acp-discord-smoke`, `conversationRef: channel:1455324822623092856` (#agent-spaces), `scopeRef: agent:cody:project:agent-spaces`, `laneRef: main`, status active. Stored in `/Users/lherron/praesidium/var/db/acp-interface.db`. Binding was retargeted from rex to cody during this session to exercise the codex path.
- **Legacy binding** for agent-spaces (`f14f854c-...`) was deleted via legacy CP admin API earlier. Other legacy bindings untouched (legacy gateway isn't running anyway).
- **virtu scripts**: `agent-spaces/scripts/virtu-{send,thread}.sh`.

## Uncommitted changes (review before resuming)

`packages/acp-server/src/real-launcher.ts` (and its test) contains a refactor from this session:
- `client.ensureRuntime` pre-call removed (was redundant; headless `dispatchTurn` allocates its own runtime).
- Long-lived `client.watch({follow:true})` for completion replaced with short SQLite poll of the `runs` table.

**Decision for next session:** the refactor is correct in isolation, but the downstream bug it tried to paper over (codex missing assistant events) is what T-01155 actually fixes. If you want a minimal landing, keep the refactor; if you want to revert to main and land only T-01155's changes, that's fine too — either way T-01155 is the gating fix.

## Open blocker — T-01155 (dispatched)

**Problem.** When HRC spawns codex via `executeHeadlessCliTurn` → `launch/exec.ts`, codex emits JSONL on stdout (it's already invoked with `--json`, see `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts:269-274`). The launch wrapper parses the stream but only captures `thread.started` for the `/continuation` callback; `packages/hrc-server/src/launch/exec.ts:219-221` short-circuits (`if (deliveredContinuation) continue`) and drops every subsequent event, including the `item.completed` record that carries the assistant text.

**Verified JSONL schema** (codex-cli 0.121.0, both fresh and `--resume`):

```
{"type":"thread.started","thread_id":"019dac38-..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{...}}
```

Text lives at `item.text` when `item.type === "agent_message"`. OTEL does **not** carry the text — verified by dumping `codex.sse_event` entries in `state.sqlite` for a real run; only flow metadata + token counts. Do not try to extract from OTEL.

**Fix shape** (full detail in T-01155):
1. Remove the `continue` short-circuit in `exec.ts`; keep parsing for the life of the subprocess.
2. On `item.completed` with `item.type === 'agent_message'`, POST `{ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }` to a new `/v1/internal/launches/<launchId>/event` HRC endpoint (route it beside `/continuation`, `/exited` at `hrc-server/src/index.ts:594-650` and the spool replay at `:5879-6008`).
3. Handler in `index.ts` appends to the per-run `events` table via `this.db.events.append(...)`.
4. No changes needed in `packages/acp-server` — `real-launcher.ts:120` (`toUnifiedAssistantMessageEndFromRawEvents`) already consumes that shape.

## Related tickets

- **T-01154** — Anthropic SDK `runtime_buffers` chunk_seq collision on reused runtime. Separate HRC bug. Will need to be fixed before ACP can target an anthropic agent (e.g. Rex). Out of scope for the codex path.

## Useful reference commands

```bash
# Snapshot services
ps -ef | grep -E "bun run.*acp-server|bun run.*gateway-discord" | grep -v grep

# Bring our stack up (after T-01155 lands)
WRKQ_DB_PATH=/Users/lherron/praesidium/var/db/wrkq.db ACP_REAL_HRC_LAUNCHER=1 \
  bun run packages/acp-server/src/cli.ts > /tmp/acp-server.log 2>&1 &

DISCORD_TOKEN=$(consul kv get cfg/dev/_global/discord/master_token) \
DISCORD_VIRTU_BOT_ID=1165644636807778414 \
ACP_BASE_URL=http://127.0.0.1:18470 \
ACP_GATEWAY_ID=acp-discord-smoke \
  bun run packages/gateway-discord/src/main.ts > /tmp/gateway-discord.log 2>&1 &

# Two-turn continuity smoke
CP_CHANNEL_ID=1455324822623092856 ./scripts/virtu-send.sh "t1: my color is chartreuse. reply ok."
sleep 75
CP_CHANNEL_ID=1455324822623092856 ./scripts/virtu-send.sh "t2: what was my color? reply with just the color."

# Recent Discord messages in #agent-spaces
curl -s -H "Authorization: Bot $(consul kv get cfg/dev/_global/discord/master_token)" \
  "https://discord.com/api/v10/channels/1455324822623092856/messages?limit=6" | python3 -m json.tool

# Inspect ACP delivery queue
sqlite3 /Users/lherron/praesidium/var/db/acp-interface.db \
  "select delivery_request_id, status, substr(body_text,1,60), created_at \
   from delivery_requests order by created_at desc limit 5;"

# Inspect HRC per-run events (where T-01155's fix will land new message_end rows)
sqlite3 /Users/lherron/praesidium/var/state/hrc/state.sqlite \
  "select run_id, event_kind, substr(event_json,1,100) from events \
   where run_id='<run-id>' order by seq asc;"

# Verify codex JSONL schema locally
codex exec --json "reply with only: ok"
codex exec --json resume <thread_id> "what word did I ask you to reply with?"
```

## How to resume

1. Read T-01155 via `wrkq cat T-01155`.
2. Check cody@agent-spaces:T-01155 progress via `hrcchat messages`.
3. On green (two-turn smoke with t2 recalling "chartreuse"): commit, close T-01155, then decide whether to close T-01152 as superseded or re-scope it.
