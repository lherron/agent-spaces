# `hrc run` Manual E2E Verification

Manual verification plan for the canonical `hrc run` path after the client-side cutover is complete.

Scope:
- `hrc run` only
- canonical flow: `resolveSession -> ensureRuntime -> optional dispatchTurn -> getAttachDescriptor`
- post-cutover semantics:
  - no `--label`
  - `--dry-run` is local preview only, with no server calls
  - default restart behavior is `reuse_pty`
  - `--force-restart` maps to `fresh_pty`

Out of scope:
- legacy `app-session` verbs
- `bridge target` migration
- full `/v1/windows/*` coverage

## Preconditions

Use an isolated runtime/state root so the checks are repeatable.

```bash
export HRC_TMP="$(mktemp -d /tmp/hrc-run-e2e.XXXXXX)"
export HRC_RUNTIME_DIR="$HRC_TMP/runtime"
export HRC_STATE_DIR="$HRC_TMP/state"
mkdir -p "$HRC_RUNTIME_DIR" "$HRC_STATE_DIR"
```

Use the fixture harness shim so verification does not depend on a real Claude install.

```bash
export PATH="$PWD/integration-tests/fixtures/claude-shim:$PATH"
```

Run the CLI directly through Bun:

```bash
alias hrc='bun run packages/hrc-cli/src/cli.ts'
```

Start the server in a separate terminal:

```bash
HRC_RUNTIME_DIR="$HRC_RUNTIME_DIR" \
HRC_STATE_DIR="$HRC_STATE_DIR" \
hrc server
```

For the examples below, use a canonical agent session ref:

```bash
export HRC_SCOPE='agent:larry:project:agent-spaces:task:T-01082~main'
```

Note:
- If `~main` is no longer accepted by the rewritten parser, use the exact form the CLI help documents.
- If the rewritten `hrc run` expects bare positional prompt text instead of `-p`, use the form shown by `hrc run --help`.

## Case 1: Help Surface

Goal: verify the CLI advertises the new semantics.

```bash
hrc run --help
```

Expected:
- Help mentions `--dry-run`
- Help does not mention `--label`
- Help explains default reuse/reattach behavior
- Help explains `--force-restart` as fresh restart behavior

## Case 2: Local Dry Run

Goal: verify `--dry-run` is local-only and does not create server state.

```bash
hrc session list
hrc run "$HRC_SCOPE" --dry-run
hrc session list
```

Expected:
- `hrc run --dry-run` prints a local preview, not a server-evaluated runtime plan
- No session is created on the server
- The before/after `hrc session list` output is unchanged

## Case 3: First Launch Without Prompt

Goal: verify first launch creates a canonical session/runtime and attaches or prints attachable state.

If you want a non-interactive check first:

```bash
hrc run "$HRC_SCOPE" --no-attach
```

Expected:
- Command succeeds
- Output includes a stable `hostSessionId`
- Output includes a `runtimeId`
- Output reflects a ready tmux runtime

Then verify server state:

```bash
hrc session resolve --scope "agent:larry:project:agent-spaces:task:T-01082"
hrc runtime list
hrc status --json
```

Expected:
- Exactly one active session exists for the scope/lane
- A tmux runtime exists for that host session
- Status shows the session and active runtime joined correctly

## Case 4: First Launch With Prompt

Goal: verify prompt path uses `dispatchTurn` before attach and does not fail.

```bash
hrc run "$HRC_SCOPE" "who are you?" --no-attach
```

Expected:
- Command succeeds
- Session is reused if it already exists
- Runtime remains attached to the same host session unless `--force-restart` is used

Then inspect server state:

```bash
hrc status --json
```

Expected:
- The same session remains active
- A runtime is present for that session
- No stale-context or invalid-selector error is reported

If the shim/server emits events meaningfully in your environment:

```bash
hrc watch --from-seq 1
```

Expected:
- You see session/runtime activity corresponding to launch and prompt dispatch

## Case 5: Reattach Default Behavior

Goal: verify the new default is reuse, not fresh restart.

First launch:

```bash
hrc run "$HRC_SCOPE" --no-attach
```

Record:
- `hostSessionId`
- `runtimeId`

Run the same command again:

```bash
hrc run "$HRC_SCOPE" --no-attach
```

Expected:
- `hostSessionId` stays the same
- `runtimeId` stays the same, or the runtime clearly represents reuse of the same PTY
- No second fresh tmux session is created

Validation:

```bash
hrc status --json
```

Expected:
- One active session for the scope/lane
- Reused runtime/PTY rather than a duplicate fresh runtime

## Case 6: Explicit Fresh Restart

Goal: verify `--force-restart` replaces the runtime/PTY but preserves session continuity.

```bash
hrc run "$HRC_SCOPE" --no-attach --force-restart
```

Expected:
- Command succeeds
- `hostSessionId` stays the same
- `runtimeId` changes
- The old runtime is no longer the active one

Validation:

```bash
hrc runtime list
hrc status --json
```

Expected:
- Prior runtime is terminated or inactive
- New runtime is active
- Session continuity is preserved

## Case 7: Attach Path

Goal: verify the attach descriptor still works after the rewrite.

```bash
hrc run "$HRC_SCOPE"
```

Expected:
- CLI execs into tmux successfully
- You land in the existing session by default
- Detach and re-run `hrc run "$HRC_SCOPE"` to confirm reattach behavior

If you need a non-interactive descriptor check:

```bash
RUNTIME_ID="$(hrc run "$HRC_SCOPE" --no-attach | jq -r '.runtimeId')"
hrc attach "$RUNTIME_ID"
```

Expected:
- Attach descriptor is valid tmux argv

## Case 8: Error Surface

Goal: verify the rewritten command surfaces canonical errors cleanly.

Invalid scope:

```bash
hrc run 'not-a-valid-scope'
```

Expected:
- Fails with `INVALID_SELECTOR`-style messaging
- Does not mention legacy app-session recovery

No server:

Stop the server, then run:

```bash
hrc run "$HRC_SCOPE"
```

Expected:
- Fails cleanly with daemon/socket discovery guidance
- No legacy `app-session` hint appears

## Case 9: Regression Check for Removed Semantics

Goal: verify the old app-session-specific behavior is gone from `hrc run`.

Check:
- `hrc run --help` does not mention `--label`
- `hrc run --help` does not imply default fresh restart
- runtime/session output does not expose synthetic `appSessionKey`
- errors do not suggest `hrc app-session remove`

## Cleanup

Stop the server, then remove temp state:

```bash
rm -rf "$HRC_TMP"
unset HRC_TMP HRC_RUNTIME_DIR HRC_STATE_DIR HRC_SCOPE
unalias hrc 2>/dev/null || true
```

## Pass Criteria

The cutover is acceptable if all of the following hold:
- `hrc run --dry-run` performs no server-side mutation
- first launch succeeds through the canonical session/runtime path
- prompt launch succeeds through the dispatch path
- default repeated launch reuses the active PTY/session
- `--force-restart` creates a fresh runtime while preserving session continuity
- attach still works
- no `app-session` wording leaks through help, output, or error guidance
