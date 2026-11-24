# Claude Desktop self-join

Claude Desktop Code-tab sessions on max3 join HRC as Vega participants.
Run `just install` and then `just overlay-claude` from the canonical
agent-spaces checkout. The overlay requires macOS and Node. It adds four
command hooks to `~/.claude/settings.json`, preserving the existing MOTD hook
and all unrelated settings bytes. An unchanged rerun leaves the files in place.

Use `just overlay-claude --to /path/to/scratch-home/.claude` to apply the same
overlay to a copy of the settings. The commands resolve the installed helper
from `$HOME/.claude`, so set `HOME` to the scratch home when driving the copy.

## What runs

- The shell gate returns silently on a broker-managed Claude seat. Other
  calls must have a `claude-desktop` entrypoint in the parent PID's registry
  row, or in the `CLAUDE_PID` row when the parent row is unavailable.
- SessionStart and UserPromptSubmit start a detached joiner when no live
  broker PID holds that session. The hook resolves the active ASP release on
  each join attempt. Claude's messaging socket and token stay in the
  environment.
- SessionStart injects `var/agents/vega/DESKTOP_SESSION.md` and a join report
  through `additionalContext`. The report uses a live joined record when
  available. Otherwise the joiner's project resolver produces a provisional
  `vega@<project>:claude-<sessionId>` address, with `praesidium` for an
  unbound cwd. If the registry and its last good copy are both unavailable,
  the report says the provisional address is unavailable. The first
  UserPromptSubmit after registration adds the registered address to the
  session context. A marker in the session state directory keeps later
  prompts from repeating it.
- UserPromptSubmit, Stop and Notification send best-effort hints over
  `~/.claude/hrc-desktop/<sessionId>/hook.sock` when it exists. The hook
  exits successfully even when a hint fails or the broker is unavailable.
- SessionStart adds a shell snippet to Claude's `CLAUDE_ENV_FILE`. Each
  Bash tool call uses that snippet to source the joiner's private
  `caller-env.sh` in the session state directory once the broker registers.
  The snippet supplies the joined runtime and Vega seat to `prae` and
  `asp self inspect` while the broker PID is alive. Open a fresh Desktop
  tab after installing the overlay so Claude loads the snippet at startup.

## Mail delivery

HRC mail reaches a joined session as a steer through Claude's cross-session
messaging socket (`messagingSocketPath` in the registry row). An idle session
starts a turn on the message. A busy session reads it between tool calls and
absorbs it into the running turn. The written content begins with an
`[HRC delivery from <sender>, envelope <EN>]` line and ends with
`[hrc:input <inputId>]`. The session records only the broker's pid as the
sender, so these lines identify the real sender and the submission.

- A session has one unresolved attempt at a time. Each write is made once and
  never resent.
- The marker in the transcript's peer row or `queued_command` row settles the
  submission as executed or absorbed. A UserPromptSubmit `prompt` carrying the
  marker settles it as executed.
- With no marker after 30 s, the submission is settled `submission.lost`, a
  `CLAUDE_DESKTOP_DELIVERY_UNCONFIRMED` notice records the receiver's registry
  status, and delivery continues.
- When the latest hook or prompt row reports `bypassPermissions`, nothing is
  written and the steer is rejected with `receiver_bypass_permissions`. The
  envelope stays pending until the session leaves bypass mode.
  `crossSessionInbound` is never set.
- The Stop hook asks HRC's stop-decision endpoint, using the `runtimeId` in
  `join.json`, whether presented, reply-required mail is still unanswered. If
  so, it blocks the turn's end with HRC's reason. Every failure allows the turn
  to end. This gate only enforces replies and never delivers mail.

## Session end

Archiving a Desktop session fires no SessionEnd hook, so the broker watches
the session itself. Every 2 s it checks the claude pid from the admitted
registry row. The session has ended when the pid is gone, when its
`~/.claude/sessions/<pid>.json` row is gone or names another session, or
when `ps -o lstart` (C locale, UTC) differs from the row's `procStart`,
which means the pid was reused. A row caught mid-write gives no verdict.

- The broker publishes what the transcript still holds, then emits
  `driver.notice` `CLAUDE_DESKTOP_SESSION_ENDED` and `invocation.exited`.
  HRC records the runtime `terminated` with `external_participant_exit`.
- Once HRC acks the exit, the joiner moves the binding to
  `~/.claude/hrc-desktop-ended/<sessionId>.json`, removes the state
  directory and scope cache, releases `broker.pid`, adds one line to
  `~/.claude/hrc-desktop-ended.log` and exits. Without an ack within 60 s, it
  leaves the state in place and exits.
- A reopened app can resume the same session under a new pid. Its joiner
  reads the ended record and registers as the replacement
  (`expectedPredecessor`), because HRC refuses a fresh attach for a binding
  whose broker is gone (`participant_established_endpoint_dead`).
- SIGTERM ends only the broker. HRC detaches the runtime
  (`broker_transport_closed`), and the session's next hook respawns it.
- SessionStart and UserPromptSubmit sweep `~/.claude/hrc-desktop/*/` for
  sessions with no live registry row and no live broker, and remove that
  state. They also prune ended records older than 30 days whose session is
  not live. An unreadable registry row skips the sweep.

## Check a session

Read `~/.claude/hrc-desktop/<sessionId>/hook.log` for typed hook events and
`join.log` for the broker's admission and registration. A successful join
writes `join.json` and appears in `prae seat list --agent vega`. When testing
an HRC Claude seat, count its hook log rows across a normal turn. The shell
gate exits before any hook log can be written.
