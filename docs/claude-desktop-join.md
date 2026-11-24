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

## Check a session

Read `~/.claude/hrc-desktop/<sessionId>/hook.log` for typed hook events and
`join.log` for the broker's admission and registration. A successful join
writes `join.json` and appears in `prae seat list --agent vega`. When testing
an HRC Claude seat, count its hook log rows across a normal turn. The shell
gate exits before any hook log can be written.
