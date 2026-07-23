---
id: agent-spaces/cli-surface
title: asp CLI Surface
kind: reference
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# asp CLI Surface

The `asp` binary (`packages/cli`, `bin: asp`) is the top-level entry point
for Agent Spaces. Command registration order (and therefore `asp --help`
order) is defined in `packages/cli/src/command-registry.ts`. This page is a
navigational summary; the authoritative option-by-option reference lives in
this repo's own `docs/cli-reference.md`.

## Command groups

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
asp agents
asp token-rent [options]
```

Common path options accepted by most project-facing commands: `--project <path>` (project directory, default auto-detected from cwd),
`--registry <path>` (registry path override), `--asp-home <path>`
(`ASP_HOME` override).

## Two execution models

`asp` exposes two distinct ways to launch an agent:

1. **Target-oriented (`asp run <target|space-ref|path>`)** — classic mode.
   Accepts a target name from `asp-targets.toml`, a direct space ref such as
   `space:my-space@dev`, or a filesystem path to a local space
   (`asp run ./path/to/my-space`). Also runnable as `asp run space:my-space@dev`
   with no project (global mode).
2. **Placement-driven (`asp agent <scope> <mode> [prompt]`)** — the
   scope/session entry point. `scope` is a `ScopeHandle` shorthand
   (`alice@demo:T-1/reviewer`) or canonical `ScopeRef`
   (`agent:alice:project:demo`); `mode` is one of `query`, `heartbeat`,
   `task`, `maintenance`, `resolve`. Key options: `--agent-root`,
   `--project-root`, `--cwd`, `--harness` (`claude-code`, `codex-cli`,
   `agent-sdk`, `pi-sdk`; aliases `claude`, `codex`, `claude-agent-sdk`),
   `--lane-ref`, `--host-session-id`, `--run-id`, `--compose <ref>`
   (repeatable; `agent-project` is implicit from the scope-ref agentId),
   `--continue-provider`/`--continue-key`, `--interaction`
   (`interactive`/`headless`), `--io` (`pty`/`pipes`/`inherit`), `--env KEY=VALUE` (repeatable), `--yolo`, `--dry-run`, `--print-command`,
   `--json`.

Both models resolve, lock, and materialize spaces the same way; they differ
in whether the composition is named ahead of time in `asp-targets.toml` or
derived on the fly from a scope address.

## `asp run` highlights

`--harness <id>` (default `claude`; also `claude-agent-sdk`, `codex`, `pi`,
`pi-sdk`), `--model <model>` (pi-sdk expects `provider:model`),
`--model-reasoning-effort` (Codex), `--permission-mode` (Claude),
`--no-interactive`, `--dry-run` / `--print-command` (print the harness
invocation without spawning), `--no-refresh` (use cached project bundles),
`--yolo` (`--dangerously-skip-permissions`), `--inherit-all` /
`--inherit-project` / `--inherit-user` / `--inherit-local` (opt back into
host settings inheritance — off by default), `--settings <file-or-json>`,
`--resume [session-id]`, `--remote-control`, `--name-prefix`,
`--page-prompts`, `--extra-args <args...>`.

`--resume` is the harness-facing UX flag; the cross-package runtime
contract for continuation is `continuationKey`, not `resume` — see
`agent-spaces/identity-scope-and-env-contract`.

**Always validate `asp run` changes with `--dry-run`** before treating them
as correct; it prints the generated harness invocation without launching.

## Composition and lock lifecycle commands

- `asp init [-t <name>] [-f]` — scaffold `asp-targets.toml` with a default
  target composing `space:defaults@dev`.
- `asp install [--targets <names...>] [--harness <id>] [--update] [--refresh] [--no-fetch]` — resolve targets and materialize project bundles under
  `ASP_HOME`.
- `asp build [target] [--output <dir>] [--harness <id>] [--no-clean] [--no-install] [--no-lint]` — materialize plugins without launching.
- `asp add <spaceRef> [--target <name>] [--no-install]` / `asp remove <spaceId>` — modify a target's `compose` list.
- `asp upgrade [spaceIds...] [--target <name>]` — update lock pins to the
  latest versions matching selectors.
- `asp diff [--target <name>] [--json]` — show pending lock changes without
  writing.

## Inspection and diagnostics

- `asp describe [target] [--json] [--harness <id>] [--model <id>]` —
  hooks/skills/tools/lint-warnings for targets.
- `asp explain [target] [--harness <id>] [--json] [--no-store-check] [--no-lint]` — resolved graph, pins, load order, warnings.
- `asp lint [target] [--json] [--hygiene [path]] [--strict] [--baseline <path>] [--update-baseline] [--judge <path>] [--agent-hygiene-root <path>]` — target conflict/composition validation; also fronts the
  agent-hygiene linter (W4xx findings) and the tier-2 rubric judge.
- `asp list [--json]` — targets, resolved spaces, cached environments.
- `asp path <spaceId>` — filesystem path to a space by ID.
- `asp doctor [--json]` — Claude binary, registry reachability, cache
  permissions.
- `asp gc [--dry-run]` — garbage-collect unreferenced store/cache entries.
- `asp harnesses [--json]` — list available harnesses, versions, paths,
  capabilities, models (`codex` is marked experimental).

## Space and registry authoring

- `asp spaces init <spaceId>` / `asp spaces list` — create/list spaces.
- `asp repo init/new-space/status/publish/tags/gc` — legacy git-registry
  management, retained for old registry workflows. New spaces should live
  under the agents root, a project, or an agent root instead of the
  registry.

## Self-introspection and resources

- `asp self inspect|paths|prompt [which]|explain [which]|memory <subcommand>`
  — introspect this agent's own runtime launch, effective prompts, and
  memory targets (`memory`, `user`, `persona`: `inspect`, `read`, `add`,
  `replace`, `remove`, `scan`, `snapshot`, `diff`, `paths`).
- `asp resources plan <agent>` — compile an agent-authored runtime
  resources plan (schedules/channels/event-hooks declared under the agent
  home).
- `asp agents` — read-only agent catalog and inspection.
- `asp token-rent [--agent <name>|--fleet] [--json] [--hrc-db <path>] [--agents-root <path>] [--usage-since <iso>] [--since <git-ref>] [--now <iso>]` — price agents' resident system-prompt sections against real HRC
  run frequency.
- `asp gui <agentId|scope-handle> [options]` — launch Codex.app for an ASP
  agent target; shares `run`'s inherit/settings/dry-run options.
- `asp resolve-reminder [target] [--agent-root <path>] [--agents-root <path>] [--debug]` — resolve session reminder sections from the context
  template for a target/agent.

## Testing the CLI locally (no build step needed)

```bash
bun packages/cli/bin/asp.js <command>

# Set ASP_HOME to a writable scratch path to avoid EPERM creating temp dirs
ASP_HOME=/tmp/asp-test bun packages/cli/bin/asp.js run \
  integration-tests/fixtures/sample-registry/spaces/base --dry-run
```

Fixtures for local testing live in `integration-tests/fixtures/`:
`sample-registry/spaces/` (test spaces: base, frontend, backend, …),
`sample-project/` (a project with `asp-targets.toml`), `claude-shim/` (a
mock `claude` binary), `codex-shim/` (a mock Codex binary for `--harness codex` dry-runs). Note: `asp run` does not accept a `--prompt` flag.
