# CLI Reference

This document describes the current `asp` CLI shipped from `packages/cli`.

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
asp add [options] <spaceRef>
asp remove [options] <spaceId>
asp upgrade [options] [spaceIds...]
asp diff [options]
asp harnesses [options]
asp repo ...
asp spaces ...
asp agent [options] <scope> <mode> [prompt]
```

## `asp run`

`asp run` is the main entry point for target execution. It accepts:

- a target name from `asp-targets.toml`
- a direct space ref such as `space:frontend@stable`
- a filesystem path to a local space

Common options:

- `--harness <id>`: choose the harness implementation
- `--model <model>`: override the harness model
- `--dry-run`: print the generated harness invocation without spawning it
- `--print-command`: emit only the command, suitable for scripting
- `--resume [session-id]`: ask the CLI harness to continue a previous session
- `--inherit-all`, `--inherit-project`, `--inherit-user`, `--inherit-local`: opt back into host settings inheritance
- `--settings <file-or-json>`: provide explicit settings input
- `--project`, `--registry`, `--asp-home`: override path discovery

For CLI-facing `run`, `--resume` remains the user-facing flag. Internally the runtime contract has been renamed to `continuationKey`; docs and APIs should use that name when referring to programmatic continuation.

## `asp agent`

`asp agent` is the placement-driven entry point used by the newer scope/session model:

```text
asp agent [options] <scope> <mode> [prompt]
```

Key inputs:

- `scope`: `ScopeHandle` shorthand such as `alice@demo:T-1/reviewer` or canonical `ScopeRef`
- `mode`: `query`, `heartbeat`, `task`, `maintenance`, or `resolve`
- `--lane-ref <ref>`: lane selection for `SessionRef`
- `--host-session-id <id>` and `--run-id <id>`: host correlation
- `--continue-provider <provider>` and `--continue-key <key>`: explicit continuation input
- `--agent-root`, `--project-root`, `--cwd`: placement and execution roots
- `--compose`, `--agent-target`, `--project-target`, `--bundle`: bundle selection
- `--dry-run`, `--print-command`, `--json`: inspection and machine-readable output

## `asp repo`

Registry management:

- `asp repo init`
- `asp repo status`
- `asp repo publish <spaceId>`
- `asp repo tags <spaceId>`
- `asp repo gc`

## `asp spaces`

Space authoring helpers:

- `asp spaces init <spaceId>`
- `asp spaces list`

## Notes

- Validate `asp run` changes with `--dry-run` before treating them as correct.
- The public host-facing continuation term is `continuationKey`, not `resume`.
- `hostSessionId` is the canonical correlation field. `cpSessionId` remains deprecated compatibility input only.
