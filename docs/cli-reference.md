# CLI Reference

This document describes the current `asp` CLI shipped from `packages/cli`. Command
registration order (and therefore `asp --help` order) is defined in
`packages/cli/src/command-registry.ts`.

## Top-Level Commands

```text
asp run [options] <target> [prompt]
asp init [options]
asp install [options]
asp build [options] [target]
asp describe [options] [target]
asp explain [options] [target]
asp lint [options] [target]
asp list [options]
asp path [options] <spaceId>
asp doctor [options]
asp gc [options]
asp gui [options] <agentId>
asp add [options] <spaceRef>
asp remove [options] <spaceId>
asp upgrade [options] [spaceIds...]
asp diff [options]
asp harnesses [options]
asp resolve-reminder [options] [target]
asp self <subcommand>
asp repo <subcommand>
asp spaces <subcommand>
asp resources <subcommand>
asp agent [options] <scope> <mode> [prompt]
asp token-rent [options]
```

Common path options accepted by most project-facing commands:

- `--project <path>`: project directory (default: auto-detect from cwd)
- `--registry <path>`: registry path override
- `--asp-home <path>`: `ASP_HOME` override

## Space references

- `space:<id>@dev` — shared space resolved from the agents root (`<agentsRoot>/spaces/<id>/`)
- `space:project:<id>` — project-local space (`<projectRoot>/spaces/<id>/`)
- `space:agent:<id>` — agent-local space (`<agentRoot>/spaces/<id>/`)
- `space:path:<path>@dev` — explicit filesystem path
- Legacy git-registry selectors (`@stable`/`@latest` dist-tags, semver ranges, `git:<sha>`
  pins) still parse for old lockfiles, but the git-backed registry workflow is retired.

## `asp run`

Run a coding agent with a target, space reference, or filesystem path.

Accepts a target name from `asp-targets.toml`, a direct space ref such as
`space:my-space@dev`, or a filesystem path to a local space.

Key options:

- `--harness <id>`: harness implementation (default `claude`; also `claude-agent-sdk`, `codex`, `pi`, `pi-sdk`)
- `--model <model>`: model override (pi-sdk expects `provider:model`)
- `--model-reasoning-effort <effort>`: Codex reasoning effort override
- `--permission-mode <mode>`: Claude permission mode
- `--no-interactive`: run non-interactively
- `--dry-run` / `--print-command`: print the harness invocation without spawning
- `--no-refresh`: use cached project bundles
- `--yolo`: skip all permission prompts (`--dangerously-skip-permissions`)
- `--debug`: enable Claude hook debugging
- `--inherit-all`, `--inherit-project`, `--inherit-user`, `--inherit-local`: opt back into host settings inheritance (off by default)
- `--settings <file-or-json>`: explicit settings input
- `--resume [session-id]`: resume a previous session (picker if no ID)
- `--remote-control`: enable Claude remote control via TCP
- `--name-prefix <prefix>`: prefix for the auto-generated session name
- `--page-prompts`: page prompt output one screenful at a time
- `--extra-args <args...>`: additional harness CLI arguments

For CLI-facing `run`, `--resume` remains the user-facing flag. Internally the runtime
contract uses `continuationKey`; docs and APIs should use that name when referring to
programmatic continuation.

## `asp init`

Create a new `asp-targets.toml` with a default target composing `space:defaults@dev`.

- `-t, --target <name>`: name of the default target (default `dev`)
- `-f, --force`: overwrite an existing `asp-targets.toml`

## `asp install`

Resolve targets and materialize project bundles under `ASP_HOME`.

- `--targets <names...>`: restrict to specific targets
- `--harness <id>`: harness to materialize for
- `--update`: re-resolve selectors and update the lock
- `--refresh`: force re-copy from source (clear cache)
- `--no-fetch`: skip fetching registry updates

## `asp build`

Materialize plugins without launching. Optional `target` argument (default: all).

- `--output <dir>`: output directory
- `--harness <id>`: harness to materialize for
- `--no-clean`: keep existing output directory contents
- `--no-install`: do not auto-install if lock missing
- `--no-lint`: skip lint checks

## `asp describe`

Describe hooks, skills, tools, and lint warnings for targets.

- `--json`: JSON output
- `--harness <id>`: harness used when materializing (default `agent-sdk`)
- `--model <id>`: model to use (harness-specific)

## `asp explain`

Print resolved graph, pins, load order, and warnings.

- `--harness <id>`, `--json`, `--no-store-check`, `--no-lint`

## `asp lint`

Validate targets and detect conflicts. Also fronts the agent-hygiene linter:

- `--json`: JSON output
- `--hygiene [path]`: run agent-hygiene lint (W4xx) over a skill / prompt / agent root / var/agents tree
- `--strict`: with `--hygiene`, exit nonzero on error-severity findings
- `--baseline <path>` / `--update-baseline`: hygiene suppression baseline
- `--judge <path>`: run the tier-2 rubric judge over one unit; emit the §7 JSON scorecard
- `--agent-hygiene-root <path>`: override the agent-hygiene criteria source root

## `asp list`

List targets, resolved spaces, and cached environments. `--json` for JSON output.

## `asp path`

Print the filesystem path to a space by ID.

## `asp doctor`

Check Claude binary, registry reachability, and cache permissions. `--json` for JSON output.

## `asp gc`

Garbage collect unreferenced store and cache entries. `--dry-run` to preview deletions.

## `asp gui`

Launch Codex.app for an ASP agent target. Accepts an agent/target name or a scope handle
such as `cody@project:task`. Shares `run`'s inherit/settings/dry-run options.

## `asp add` / `asp remove`

Add a space reference to a target / remove a space from a target.

- `--target <name>`: which target to modify
- `--no-install`: skip running install after the change

## `asp upgrade`

Update lock file pins to latest versions matching selectors. Optional space IDs restrict
scope; `--target <name>` limits to one target.

## `asp diff`

Show pending lock changes without writing. `--target <name>`, `--json`.

## `asp harnesses`

List available harnesses and their status (version, path, capabilities, models). The
`codex` harness is marked experimental. `--json` for JSON output.

## `asp resolve-reminder`

Resolve session reminder sections from the context template for a target/agent.

- `--agent-root <path>`: explicit agent root
- `--agents-root <path>`: override agents root
- `--debug`: diagnostic info on stderr

## `asp self`

Introspect this agent's runtime launch and locate edit targets:

- `asp self inspect` — zero-arg overview of this agent's runtime launch
- `asp self paths` — list every path in the agent runtime, classified editable vs derived
- `asp self prompt [which]` — show effective system prompt, reminder, or priming prompt
- `asp self explain [which]` — diagnose why a prompt, reminder, or launch looks the way it does
- `asp self memory <subcommand>` — manage agent memory targets (memory, user, persona):
  `inspect`, `read`, `add`, `replace`, `remove`, `scan`, `snapshot`, `diff`, `paths`

## `asp repo` (legacy)

Git-registry management commands, retained for legacy registry workflows:

- `asp repo init [--clone <url>] [--no-manager]` — initialize or clone a spaces registry
- `asp repo new-space <spaceId>` — create a new space scaffold in the registry
- `asp repo status` — show registry status
- `asp repo publish <spaceId>` — create version tag and update dist-tags
- `asp repo tags <spaceId>` — list version tags for a space
- `asp repo gc` — garbage-collect the registry repository

New spaces should live in the agents root (`<agentsRoot>/spaces/`), a project
(`<projectRoot>/spaces/`), or an agent root — not in a git registry.

## `asp spaces`

- `asp spaces init <spaceId>` — create a new space in the registry (legacy placement)
- `asp spaces list` — list spaces

## `asp resources`

Agent-authored runtime resources:

- `asp resources plan <agent>` — compile an agent-authored runtime resources plan
  (schedules/channels/event-hooks declared under the agent home)

## `asp agent`

Placement-driven agent execution — the scope/session entry point:

```text
asp agent [options] <scope> <mode> [prompt]
```

Arguments:

- `scope`: `ScopeHandle` shorthand such as `alice@demo:T-1/reviewer` or canonical
  `ScopeRef` such as `agent:alice:project:demo`
- `mode`: `query`, `heartbeat`, `task`, `maintenance`, or `resolve`

Key options:

- `--agent-root <path>`, `--project-root <path>`, `--cwd <path>`: placement and execution roots
- `--harness <harness>`: `claude-code`, `codex-cli`, `agent-sdk`, `pi-sdk` (aliases: `claude`, `codex`, `claude-agent-sdk`)
- `--lane-ref <ref>`: lane selection for `SessionRef` (default `main`)
- `--host-session-id <id>` / `--run-id <id>`: host correlation
- `--scaffold-file <path>`: JSON file with scaffold packets
- `--model <model>`: model override
- `--prompt <text>` / `--prompt-file <path>` / `--attachment <path>` (repeatable): prompt input
- `--continue-provider <provider>` / `--continue-key <key>`: explicit continuation input
- `--interaction <mode>`: `interactive` or `headless`
- `--io <mode>`: `pty`, `pipes`, or `inherit`
- `--env <KEY=VALUE>` (repeatable): environment variables
- `--compose <ref>` (repeatable): explicit bundle selection; `agent-project` is implicit from the scope-ref agentId
- `--yolo`: skip permission prompts
- `--dry-run`, `--print-command`, `--json`: inspection and machine-readable output

## `asp token-rent`

Price agents' resident system-prompt sections against real HRC run frequency.

- `--agent <name>`: report one agent; `--fleet`: fleet rollup (default)
- `--json`: JSON instead of Markdown
- `--hrc-db <path>`: HRC state SQLite DB
- `--agents-root <path>`: agent source root
- `--usage-since <iso>` / `--since <git-ref>` / `--now <iso>`: reporting window controls

## Notes

- Validate `asp run` changes with `--dry-run` before treating them as correct.
- The public host-facing continuation term is `continuationKey`, not `resume`.
- `hostSessionId` is the canonical correlation field. `cpSessionId` remains deprecated
  compatibility input only.
