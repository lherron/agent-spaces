# `acp monitor` / `hrc monitor` — Proposal

Status: Design review complete (2026-04-27). Ready for V1 spec authorship.
Reviewers: cody@acp-spec
Author: clod@agent-spaces (coordinator)
Triggering session: COMMANDER_CLI_UPGRADE.md Phase 6 multi-task coordination

## 1. Motivation — what went wrong in the Phase 6 session

While coordinating wrkq tasks T-01280..T-01283 (Commander CLI Upgrade Phase 6), the coordinator (Claude Code agent `clod`) dispatched work to implementer agents (`curly`, `larry`) via `hrcchat dm --wait`, then tracked task closure with a polling shell (`until wrkq cat T-XXXXX | grep "state: completed"; do sleep 60; done`) armed via Claude Code's Monitor tool.

Five recurring problems made the coordination noticeably slower than necessary:

### 1.1 Stalled assignee with no signal (the costly one)

For T-01282, the assignee (`curly`) successfully migrated all 6 top-level commands but never closed the wrkq task and never sent a clear completion DM. The runtime transitioned to `ready` (idle) silently. The coordinator's polling watcher checked task state every 60s and saw no transition; the user prompted twice ("Status?", then "It's hung or already finished") before the coordinator noticed and nudged curly to close.

**Approximate wall-clock cost: ~40 minutes of avoidable latency per stall.**

### 1.2 Polling lag

The `until ... grep "state: completed"; do sleep 60` pattern means up to 60 seconds between actual state transition and coordinator notification. Across four task closures that's up to four wasted minutes — small per task, large in aggregate.

### 1.3 `hrcchat dm --wait` correlation timeout is noise

Every dispatch produced a `failed` notification on the `--wait` background task (the local correlation gives up well before `--timeout` says it should). The coordinator learned to recognize this as routine, but it still costs context every time and conditions the coordinator to ignore real `failed` notifications.

### 1.4 DM truncation = extra round trips

Every assignee reply over ~1.5KB came through as `(truncated; hrcchat show <seq>)`, forcing an extra Bash call before the coordinator could verify the deliverable. Hit this on messages #742, #745, #748, #750, #756.

### 1.5 `hrc events --follow` exits early

The agent-tasker skill notes this as a known issue; observed it again here. The coordinator never had reliable real-time event streaming and fell back to polling.

## 2. Boundary — where the new surface lives

The task / DM / dispatch / agent surface is **ACP** semantics (the control-plane). Pure runtime / session / turn lifecycle is **HRC** semantics (the harness). Coordinator workflows consume mostly ACP; HRC is for low-level runtime debugging.

Mixed pieces (e.g. folding runtime liveness into a task monitor) are ACP's responsibility, sourced from HRC events upstream.

## 3. Proposed surface

### 3.1 `acp monitor task <task-id> --stall-after <duration>` (ship-first)

Streams task lifecycle events; exits when the task hits a terminal state. Each line of stdout is one event:

```
task.dispatched: agent=curly@agent-spaces:T-01282
message.received: from=clod to=curly@agent-spaces:T-01282 seq=747 messageId=msg-... bodyBytes=4231
task.state: in_progress
message.sent: from=curly@agent-spaces:T-01282 to=clod seq=748 messageId=msg-... bodyBytes=12849
task.runtime.busy: rt-2e6976ae
task.runtime.idle: rt-2e6976ae idle_for=2s
message.sent: from=curly@agent-spaces:T-01282 to=clod seq=750 messageId=msg-... bodyBytes=1240
task.stalled: non-terminal, last_activity=2026-04-27T06:12:09Z, since=10m12s
task.state: completed
```

**Stall definition (broadened per cody review):** non-terminal task AND (assigned runtime idle OR no task-linked message / state / runtime activity for `--stall-after` duration). **Tool activity counts** — an agent doing tool calls (Bash, Read, Edit) is not stalled even if no DM is in flight.

V1: client-derived inside `acp monitor task`. Server-emitted/persisted stall events deferred to V2 — only worth it when alerting-without-an-active-monitor becomes a use case. If/when server-side, single-fire-per-window with explicit unstall recovery semantics.

### 3.2 `acp monitor dispatch <correlation-id> --until-reply [--stall-after N]`

Replaces `hrcchat dm --wait`'s lying correlation timeout. Keyed by **correlation id** (`coordinationEventId` / `inputAttemptId` / `runId` / `messageId`) — **not** the agent handle. The handle is selection; the correlation id is what we're actually waiting on.

```
dispatch.sent: messageId=msg-abc seq=741
dispatch.runtime.busy: rt-eab76059
message.received: from=curly seq=742 messageId=msg-... bodyBytes=1240
dispatch.completed: turnaround=10m12s
```

Exit codes: `0` = reply received, `1` = stalled past threshold, `2` = runtime crashed, `3` = transport error.

### 3.3 `acp monitor agent <handle>`

Agent-centric stream — assignment changes, message in/out, runtime liveness (folded in from HRC), idle/busy transitions across multiple tasks. Useful when watching an agent run a sequence of dispatches.

### 3.4 `hrc monitor runtime <runtime-id>` (companion, low-level)

Pure runtime lifecycle: `runtime.busy`, `runtime.idle idle_for=N`, `runtime.crashed exit=N signal=SIGKILL`, `runtime.surface.bound`, `runtime.surface.unbound`. No task / message semantics.

### 3.5 `hrc monitor events` (replaces `hrc events --follow`)

Auto-reconnecting live tail of HRC's event log. Persistent. ACP layers task / message context on top to produce its own monitor streams. Fixes the early-exit-1 issue called out in the agent-tasker skill.

(Originally proposed as `hrc monitor outbox`; renamed per cody's review — "outbox" implies queue, this is event-log tailing.)

### 3.6 Ergonomic sugar: `acp message send --dispatch --monitor`

Chains a send into the dispatch monitor using the correlation id returned by send. Removes the two-step "send, then monitor" pattern from common scripts.

## 4. Design contract — what makes this Monitor-tool friendly

The Claude Code Monitor tool consumes one stdout line as one notification. These six rules turn the surface into something Monitor consumes cleanly:

1. **One stdout line per event.** No multi-line messages. Long fields previewed (text mode) or chunked (JSON mode).
2. **Line-buffered by default.** No flag — opinionated for streaming consumers. Matches Monitor's "always use `--line-buffered` in pipes" guidance.
3. **Stable event names** (`task.state`, `task.stalled`, `dispatch.completed`, `message.received`, `runtime.crashed`) so users grep with confidence:
   ```bash
   acp monitor task T-01282 --stall-after 10m | \
     grep -E --line-buffered "task\.(state:|stalled|crashed|completed)"
   ```
4. **Exit ends the watch.** Single-shot subcommands (`task`, `dispatch`) exit on terminal state. Persistent ones (`agent`, `hrc monitor events`) exit only on socket loss (Monitor restarts).
5. **`--json` mode** for programmatic consumers (one JSON object per line, jq-friendly). **JSON mode never truncates the body** — emits full `body` plus `bodyBytes`, `bodyPreview`, `bodyTruncated`. Directly fixes the "every long DM costs an extra `hrcchat show` round-trip" problem from §1.4.
6. **Coverage for failure modes.** Every command emits stalled / crashed / disconnected events, not just the happy path. Silence is not success.

### 4.1 Naming (perspective-neutral)

Prefer `message.received` / `message.sent` with explicit `from` / `to` / `seq` / `messageId` fields, NOT perspective-encoded `dm.in` / `dm.out`. The latter only makes sense from the monitor's viewpoint, breaks when the same stream is consumed by tooling that has a different perspective.

### 4.2 Cursor / replay contract (V1)

V1 polling join MUST preserve per-source cursors across reconnects:

- `taskTransitionEventId` / task version (task-transitions source)
- coordination-substrate `seq` (DM / coordination source)
- HRC `hrcSeq` (runtime events source)
- system-event cursor (admin events source)

Replay lines flagged explicitly (`replayed=true` field in JSON, `[replay]` prefix in text). Without this, Monitor-tool consumers see duplicate event lines on every reconnect.

Side benefit: when V2 introduces a unified projection route, the cursor contract is already stable, so existing consumers don't break on migration.

## 5. Discovery — current ACP event surface

ACP does not have a single `hrc events`-equivalent unified event bus today. Verified pieces:

- `/v1/sessions/:id/events` — proxies HRC events scoped to a session
- `/v1/ops/session-dashboard/events` — projects HRC events for ops dashboard
- admin `system-events` — listable, no live feed
- task transitions — listable
- coordination-substrate — durable event table, no live monitor / timeline route exposed as a general semantic bus

**V1 of `acp monitor` joins existing sources in the CLI** rather than adding a new projection route. A dedicated projection endpoint is V2 — only worthwhile when monitoring volume justifies the daemon-side complexity.

## 6. Folding HRC runtime events into task / dispatch monitors

`acp monitor task` and `acp monitor dispatch` MUST fold in upstream HRC runtime events (busy / idle / crashed) for the task's assigned runtime. Reason: the exact failure mode that bit the Phase 6 session — runtime idle while task non-terminal — requires correlating ACP and HRC, and forcing the user to run two parallel monitors and correlate by hand defeats the purpose.

Escape hatch: `--runtime-events none|summary|all` flag. Default `summary` (busy/idle/crashed). `all` includes turn / launch lifecycle. `none` for ACP-pure consumers.

## 7. V1 ship plan

### 7.1 Ship first

`acp monitor task <task-id> --stall-after <duration>` — client-derived stall, V1 polling join over existing ACP sources + folded HRC runtime events (`--runtime-events summary` default).

Rationale: directly fixes the highest-cost failure mode (silent stall) from the triggering session, smallest surface area, implementable without daemon changes, forces the right projection (task transition / state, coordination messages linked to task / session, HRC idle/crash).

### 7.2 Then

`acp monitor dispatch <correlation-id>` — same polling-join machinery, scoped to a single correlation id. Replaces `hrcchat dm --wait`.

### 7.3 Then

`acp monitor agent <handle>` and `acp message send --dispatch --monitor`.

### 7.4 In parallel (independent of acp work)

`hrc monitor events` (replacing/fixing `hrc events --follow`) and `hrc monitor runtime <runtime-id>`. Pure HRC scope, no ACP dependency.

## 8. How this would have changed the Phase 6 session

```bash
# Before:
hrcchat dm curly@agent-spaces:T-01282 ...                              # dispatch
until wrkq cat T-01282 | grep "state: completed"; do sleep 60; done    # poll
# (40+ minutes later: user pings "Status?" because curly stalled)

# After:
hrcchat dm curly@agent-spaces:T-01282 ...
acp monitor task T-01282 --stall-after 10m | \
  grep -E --line-buffered "task\.(state|stalled|crashed)"
```

The single Monitor-armed call would have fired:

- `task.state: in_progress` ~06:00 (curly accepted)
- `message.sent: ...analysis...` ~06:12 (curly's progress message)
- **`task.stalled: ... since=10m` ~06:22** ← the missing notification
- `task.state: completed` (after my proactive nudge, ~06:25 instead of ~07:??)

Estimated wall-clock saved per stall: ~30–40 minutes. More importantly, removes the "is the user watching me drift?" failure mode entirely.

## 9. Open questions for implementation

These were noted but not fully resolved in the design review and should be answered when the V1 spec is authored:

1. **What determines the `assignedRuntime` for a wrkq task?** The stall heuristic needs to know which runtime is "assigned" to a task. Today the binding is implicit (the agent that received the dispatch DM). Does ACP have a durable assignment record, or does the monitor infer from the most recent message-routing pair?

2. **Stall threshold defaults.** `--stall-after 10m` is the proposed default. Reasonable for typical implementer tasks; might be too aggressive for spike tasks involving a long build. Should the default be tunable per-project, or just per-invocation?

3. **Is `acp message send --dispatch --monitor` chained synchronously or backgrounded?** Synchronous matches the existing `hrcchat dm --wait` UX; backgrounded matches `Monitor`-tool consumption. Probably the latter, with the former as a `--wait-foreground` opt-in.

4. **`replayed=true` semantics on reconnect.** If a consumer reconnects and replays N events, should the consumer be expected to dedupe on `(source, sourceSeq)`, or does the CLI dedupe internally and emit replays only when the consumer explicitly asks (`--include-replay`)? Lean: CLI dedupes by default; opt-in to see replay.

5. **Persistence of stall state across `acp monitor task` restarts.** If the monitor process restarts mid-task, does the freshly-launched monitor immediately re-emit `task.stalled` based on the wall-clock idle window, or does it wait `--stall-after` from process start? V1 client-derived implies the latter (simpler); a server-emitted V2 would handle this naturally.

## 10. References

- Triggering session timeline: see hrcchat messages #741..#760 (range covering T-01280..T-01283 plus this design review)
- Spec being implemented in the triggering session: `COMMANDER_CLI_UPGRADE.md`
- Claude Code Monitor tool contract: see system prompt's Monitor description (one stdout line = one notification, exit ends watch, line-buffered required, must cover failure paths)
- HRC event log: `hrc events --follow` (currently buggy, see §1.5)
- ACP existing event surfaces: `/v1/sessions/:id/events`, `/v1/ops/session-dashboard/events`, admin system-events list, coordination-substrate event table

## 11. Review history

- 2026-04-27 — Initial proposal drafted by clod@agent-spaces (post Phase 6 retro)
- 2026-04-27 — Reviewed by cody@acp-spec; six revisions accepted (correlation-id keying, client-derived V1 stall, no JSON truncation, perspective-neutral message naming, broadened stall definition, drop "outbox" naming) plus the cursor/replay contract
- 2026-04-27 — Consensus closed; ready for V1 spec authorship
