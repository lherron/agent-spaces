# HRC Interactive Session Busy Status Bug

## Problem

When an interactive TUI harness (e.g. `hrc run curly`) is started, the runtime
status is set to `busy` during the start launch and **never returns to `ready`**.
The session appears permanently busy for the entire lifetime of the harness,
even when Claude Code is idle at the TUI prompt waiting for user input.

## Root Cause

The start launch wrapper (`exec.ts`) stays alive for the entire duration of the
interactive session. It launches the harness process and then attaches to the
tmux session, blocking until the harness exits. Because the `/exited` callback
is only fired when the wrapper process terminates, `handleExited` →
`resolveRuntimeStatusAfterLaunchExit` is never called while the TUI is idle.

### Lifecycle (current, broken)

1. `ensureRuntimeForSession` → status: `ready`
2. `enqueueInteractiveStartLaunch` → status: `starting`
3. `handleWrapperStarted` / `handleChildStarted` → status: `busy`
4. TUI is now running, sitting at prompt — **status stays `busy` forever**
5. Only when user quits the TUI → wrapper exits → `handleExited` → `ready`/`dead`

### Expected Lifecycle

1. Start launch → `starting` → `busy` (during startup)
2. TUI reaches idle prompt → `ready`
3. User submits a prompt → `busy`
4. Agent finishes turn, back to idle prompt → `ready`
5. Repeat 3-4 for each turn
6. User quits → `dead`/`terminated`

## Impact

- `assertRuntimeNotBusy` will reject any attempt to dispatch a turn via the
  HRC API to a session that is actually idle
- Status endpoints report the agent as busy when it's not doing anything
- Other agents checking target status see a permanently busy peer

---

## Proposed Solution: Claude Code Hooks → HRC Ingest

### Overview

Use Claude Code's `UserPromptSubmit` (turn start) and `Stop` (turn end) hooks
to notify HRC of turn transitions. Hook scripts pipe JSON into the existing
`hrc-launch hook` CLI (`packages/hrc-server/src/launch/hook-cli.ts`), which
POSTs to `POST /v1/internal/hooks/ingest` via `$HRC_CALLBACK_SOCKET`. The
server-side ingest handler is extended to recognize turn lifecycle events and
update runtime status accordingly.

### Pieces

#### 1. Hook scripts (new)

Two small shell scripts in the defaults plugin:

**`turn-started.sh`** — triggered by `user_prompt_submit`
```bash
#!/bin/bash
# Notify HRC that a turn has started (agent is busy)
# Claude Code pipes hook event JSON to stdin; we wrap it for hrc-launch hook.
INPUT=$(cat)
echo "{\"kind\":\"turn.started\",\"hookEvent\":$INPUT}" \
  | bun run "$HRC_LAUNCH_HOOK_CLI" 2>/dev/null
exit 0
```

**`turn-stopped.sh`** — triggered by `stop`
```bash
#!/bin/bash
# Notify HRC that a turn has stopped (agent is idle)
INPUT=$(cat)
echo "{\"kind\":\"turn.stopped\",\"hookEvent\":$INPUT}" \
  | bun run "$HRC_LAUNCH_HOOK_CLI" 2>/dev/null
exit 0
```

Location: `asp_modules/claude/claude/plugins/000-defaults/hooks/`

The `$HRC_LAUNCH_HOOK_CLI` env var points to the hook-cli.ts entrypoint. It
needs to be added to exec.ts alongside the other `HRC_*` vars. Alternatively,
we can resolve the path relative to a known package root.

NOTE: The scripts must `exit 0` regardless of delivery success — a hook failure
should never block the agent's turn.

#### 2. hooks.toml entries (new)

Add to `asp_modules/claude/claude/plugins/000-defaults/hooks/hooks.toml`:

```toml
[[hook]]
event = "user_prompt_submit"
script = "hooks/turn-started.sh"
harness = "claude"

[[hook]]
event = "stop"
script = "hooks/turn-stopped.sh"
harness = "claude"
```

These use the abstract event names that the materializer translates to Claude-
native `UserPromptSubmit` and `Stop`.

#### 3. HRC server: handle turn lifecycle in ingest (modify)

In `handleHookIngest` (`packages/hrc-server/src/index.ts:3314`), after storing
the `hook.ingested` event, inspect `hookData.kind`:

```typescript
private async handleHookIngest(request: Request): Promise<Response> {
  const envelope = parseHookEnvelope(await parseJsonBody(request))
  const session = requireSession(this.db, envelope.hostSessionId)
  const now = timestamp()

  // Store the raw hook event (existing behavior)
  const event = this.db.events.append({
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: envelope.generation,
    runtimeId: envelope.runtimeId,
    source: 'hook',
    eventKind: 'hook.ingested',
    eventJson: {
      launchId: envelope.launchId,
      hookData: envelope.hookData,
    },
  })
  this.notifyEvent(event)

  // React to turn lifecycle hooks
  const kind = (envelope.hookData as any)?.kind
  if (envelope.runtimeId && (kind === 'turn.started' || kind === 'turn.stopped')) {
    const runtime = this.db.runtimes.findById(envelope.runtimeId)
    if (runtime && !isRuntimeUnavailableStatus(runtime.status)) {
      const nextStatus = kind === 'turn.started' ? 'busy' : 'ready'
      this.db.runtimes.update(runtime.runtimeId, {
        status: nextStatus,
        lastActivityAt: now,
        updatedAt: now,
      })
      const statusEvent = this.db.events.append({
        ts: now,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: envelope.generation,
        runtimeId: envelope.runtimeId,
        source: 'hook',
        eventKind: kind === 'turn.started' ? 'turn.started' : 'turn.stopped',
        eventJson: { launchId: envelope.launchId },
      })
      this.notifyEvent(statusEvent)
    }
  }

  return json({ ok: true })
}
```

#### 4. exec.ts: export hook-cli path (modify)

Add `HRC_LAUNCH_HOOK_CLI` to the env block in `exec.ts:289`:

```typescript
HRC_LAUNCH_HOOK_CLI: fileURLToPath(new URL('./hook-cli.ts', import.meta.url)),
```

#### 5. Initial status after child-started (modify)

In `handleChildStarted`, change the initial status from `busy` to `ready` for
interactive harnesses. The first `UserPromptSubmit` hook will set it to `busy`
when the user actually submits a prompt.

Alternatively, keep it as `busy` during startup and let the first `Stop` hook
(or a `SessionStart` hook) transition it to `ready`. This avoids a brief
window where the session appears ready before the TUI is actually responsive.

### Flow After Fix

```
Start launch → starting → busy (child-started callback)
  ↓
SessionStart hook fires → (optional: set ready here)
  ↓
User types prompt → UserPromptSubmit hook → turn-started.sh
  → hrc-launch hook → ingest → runtime.status = busy
  ↓
Agent finishes → Stop hook → turn-stopped.sh
  → hrc-launch hook → ingest → runtime.status = ready
  ↓
(repeat for each turn)
  ↓
User quits TUI → exec.ts exits → /exited → dead
```

### Edge Cases

- **Hook delivery failure**: Scripts exit 0 regardless; worst case is stale
  status. The spool mechanism in hook-cli.ts provides retry if the socket is
  temporarily unavailable.
- **Rapid successive turns**: Each UserPromptSubmit/Stop pair is atomic. No
  race condition since hooks execute sequentially within Claude Code.
- **Subagent turns**: SubagentStart/SubagentStop could also be wired in later,
  but the parent's Stop only fires when all subagents complete, so the simple
  UserPromptSubmit/Stop pair correctly brackets the entire turn.
- **Non-HRC sessions**: If `HRC_CALLBACK_SOCKET` is unset, `hrc-launch hook`
  exits with code 1, the script catches it and exits 0. No impact.
