# Steering E2E Manual Validation Plan

Date: 2026-05-07

## Goal

Validate Discord ingress from a real Discord channel using `virtu-send.sh` through ACP/HRC and the installed Discord gateway. The validation must prove:

- Ordinary Discord messages start or queue normal ACP work when active-run contribution is unavailable.
- There is no Discord steering command; ordinary Discord messages steer when active-run contribution is available.
- Ordinary Discord messages steer by default when ACP reports an active runtime with `capabilities.input=true` and an active turn.
- Contribution attempts preserve Discord interface metadata and do not use the old raw `/v1/inputs` shortcut.
- Accepted in-flight or pending contribution responses do not leave a stale `Processing` placeholder waiting for a new run id.
- Replays with the same Discord message id do not dispatch duplicate work.

## Setup

Use the dev gateway and a disposable Discord smoke channel/thread.

```bash
stackctl status dev --brief

CHANNEL_ID=$(discord-chat channels list | jq -r '.data[] | select(.name=="<channel-name>") | .id')

acp admin interface binding set \
  --gateway acp-discord-smoke \
  --conversation-ref channel:$CHANNEL_ID \
  --project agent-spaces \
  --scope-ref agent:cody:project:agent-spaces:task:<task-id> \
  --lane-ref main \
  --json
```

Record the returned `bindingId`; every inbound run checked below must include it at `metadata.meta.interfaceSource.bindingId`.

## Case 1: Normal Prompt Starts Work

```bash
CP_CHANNEL_ID=$CHANNEL_ID ./scripts/virtu-send.sh "steering e2e normal prompt $(date +%s): reply with exactly NORMAL_OK"
```

Evidence:

- Discord shows one agent placeholder, then the final reply in the same message.
- `acp session runs --session <sessionId> --json` shows one new run.
- The run has `metadata.meta.interfaceSource.messageRef=discord:message:<virtu-message-id>`.
- The run content does not include any command prefix.

## Case 2: Contribution-Unavailable Messages Queue Normally

Use this while the target agent/harness does not advertise active-run contribution support.

```bash
CP_CHANNEL_ID=$CHANNEL_ID ./scripts/virtu-send.sh "steering e2e fallback $(date +%s): reply with exactly FALLBACK_OK"
```

Evidence:

- ACP does not create a raw `/v1/inputs` admission missing interface metadata.
- The created run content is the exact Discord message content.
- `metadata.meta.interfaceSource.bindingId` matches the binding under test.
- If the session is busy, the admission is `queued_run`; if idle, it is `started_run`.

## Case 3: Busy FIFO Queueing

Send a long-running prompt, then immediately send two normal follow-ups:

```bash
CP_CHANNEL_ID=$CHANNEL_ID ./scripts/virtu-send.sh "steering e2e busy holder $(date +%s): wait briefly, then reply HOLDER_OK"
CP_CHANNEL_ID=$CHANNEL_ID ./scripts/virtu-send.sh "steering e2e queued one $(date +%s): reply QUEUE_ONE_OK"
CP_CHANNEL_ID=$CHANNEL_ID ./scripts/virtu-send.sh "steering e2e queued two $(date +%s): reply QUEUE_TWO_OK"
```

Evidence:

- The second and third inputs are durable queued work, not failed runs with `runtime_busy`.
- Queue order is FIFO by `input_queue.seq`.
- Discord receives final replies in order after the holder completes.

## Case 4: Steering Available by Default

Use an AgentSpaces SDK-capable runtime or test harness that reports:

```json
{
  "capabilities": { "input": true },
  "activeTurnId": "<active-run-id>",
  "status": "active"
}
```

Then send an ordinary Discord message:

```bash
CP_CHANNEL_ID=$CHANNEL_ID ./scripts/virtu-send.sh "steering e2e default contribution $(date +%s): incorporate this into the active run"
```

Evidence:

- Gateway first checks `/v1/mobile/sessions?scopeRef=...&laneRef=...`.
- Ingress posts to `/v1/interface/messages` with intent `contribute_to_active_run`, not `/v1/inputs`.
- ACP creates an `InputApplication` and an `InputAdmission` of `accepted_in_flight` or `admission_pending`.
- Discord placeholder is edited to a steering acknowledgement when no new `runId` is returned.
- No queued fallback run is created for accepted or ambiguous contribution.

## Case 5: Idempotent Replay

Resend or replay the same Discord message id through virtu/gateway if available, or re-run the captured ACP request with the same `idempotencyKey`.

Evidence:

- ACP returns HTTP 200 for the replay.
- No second run, queue item, or input application is created.
- The original admission decision is unchanged.

## Completion Gate

The implementation is ready only when all cases have real Discord evidence and the focused automated checks pass:

```bash
bun run --filter gateway-discord test -- app.e2e.test.ts hrc-event-adapter.test.ts app.live-progress.e2e.test.ts
bun run --filter acp-server test -- input-admission-queue.test.ts interface-messages.test.ts inputs.test.ts contribution-reconcile.test.ts
bun run --filter hrc-server test -- server-inflight.test.ts
bun run --filter acp-state-store test -- migration.test.ts smoke.test.ts
bun run --filter gateway-discord typecheck
bun run --filter acp-server typecheck
```
