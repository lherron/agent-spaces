# `hrc run` — Implementation Status

## Completed Commits

| Commit | Description | Cycle |
|--------|------------|-------|
| `5091b9c` | Add `hrc run` convenience command | 1 |
| `fe9335b` | Auto-dispatch first harness turn with `initialPrompt` | 1 |
| `b98906e` | Fix `aspHome: ''` empty string poisoning space resolution | 2 |
| `a4322c8` | Fix stale tmux reuse + promptless interactive auto-dispatch | 3 |
| `b98f07f` | Extend `/v1/status` with session→runtime view (server/SDK) | 4 |
| `8b583ba` | Add session-centric human output to status command (CLI) | 4 |
| `a0b132b` | Add initial prompt to runtime contracts (typecheck fix) | 4 |

## In Progress

### Reattach regression (cycle 5)
**Problem**: `hrc run rex` after detach creates a new runtime instead of reattaching to the still-running one. The session is correctly reused, but a fresh claude process is spun up every time — losing conversation history.

**Root cause**: Commit `a4322c8` made `handleEnsureAppSession` always call `ensureRuntimeForSession` for interactive sessions. This was needed for stale tmux recovery and promptless auto-dispatch, but it's too aggressive — it replaces live runtimes too.

**Fix needed**: Before calling `ensureRuntimeForSession`, check if the existing runtime is still alive (tmux pane exists + child process running). If alive, skip re-ensure and return the existing runtime for reattach. Only re-ensure if the runtime is actually dead/stale.

**File**: `packages/hrc-server/src/index.ts` — `handleEnsureAppSession`

**Status**: Dispatched to ani workbench cycle 5. Curly owns the fix, Smokey on RED tests.

## Known Issues

### `just verify` not fully green
- Pre-existing failure in `packages/cli/src/__tests__/m6-agent-cli.test.ts` (`"--lane-ref overrides default lane"`)
- Unrelated to `hrc run` work

### Runtime status stuck on `busy`
- After harness completes initial dispatch and returns to idle prompt, server still shows `status: busy`
- The `busy` → `ready` transition doesn't fire when the harness finishes a turn
- Cosmetic — doesn't affect functionality

## Architecture Summary

```
hrc run <scope> [prompt]
  │
  ├─ Parse scope handle (agent-scope package)
  ├─ Resolve agentRoot/projectRoot (spaces-config)
  ├─ Build RuntimePlacement + HrcRuntimeIntent
  │
  ├─ ensureAppSession(intent) ──────► hrc-server
  │                                    ├─ handleEnsureAppSession
  │                                    │   ├─ [TODO] Check runtime liveness before re-ensure
  │                                    │   ├─ ensureRuntimeForSession (creates tmux pane)
  │                                    │   └─ dispatchTurnForSession (launches harness)
  │                                    │       └─ buildCliInvocation → agent-spaces client
  │                                    │           └─ buildPlacementInvocationSpec
  │                                    │               └─ aspHome: getAspHome() (fixed in b98906e)
  │                                    └─ tmux.sendKeys(buildLaunchCommand)
  │
  ├─ attachAppSession() ──────────► tmux attach descriptor
  └─ exec(tmux attach) or printJson (--no-attach)
```

## Key Files

| File | Role |
|------|------|
| `packages/hrc-cli/src/cli.ts` | `cmdRun` + `cmdStatus` (unified view) |
| `packages/hrc-core/src/contracts.ts` | `HrcRuntimeIntent` with `initialPrompt` |
| `packages/hrc-core/src/http-contracts.ts` | `EnsureAppSessionRequest` with `initialPrompt` |
| `packages/hrc-server/src/index.ts` | `handleEnsureAppSession`, `ensureRuntimeForSession`, `dispatchTurnForSession` |
| `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts` | `buildCliInvocation` with `aspHome: getAspHome()` |
| `packages/hrc-sdk/src/client.ts` | SDK client with `listSurfaces`, widened `getStatus` |

## E2E Verification Results

- `hrc run rex@agent-spaces "Who are you?"` → Rex responds ✅
- `hrc run rex` (no prompt) → Claude launches in tmux, ready for input ✅
- `hrc run rex --force-restart` → Creates new runtime ✅
- `hrc status` → Unified session + runtime + tmux + surface view ✅
- `hrc status --json` → Full joined JSON structure ✅
- `hrc run rex` reattach after detach → **BROKEN** (creates new runtime, fix in progress)
