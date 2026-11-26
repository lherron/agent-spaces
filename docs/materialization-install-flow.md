---
id: agent-spaces/materialization-install-flow
title: Materialization and Install Flow
kind: guide
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# Materialization and Install Flow

This is the path from a project's declared composition
(`asp-targets.toml`) to a launched agent home a harness can actually run
against. The deterministic part of this pipeline is owned by
`spaces-config`; launching and session lifecycle are owned by
`spaces-execution` and the harness packages — see
[harness architecture](/docs/agent-spaces/harness-architecture).

## Pipeline

This adapter-backed pipeline applies to project bundles, including the Pi layout
produced by default by `asp install`. Native `agent-harness` execution takes a
separate path. It loads ordered ASP resources directly from a validated agent
profile through `AgentSpacesResourceLoader`. The runtime boundary is defined in
`architecture/records/invariants/agent-spaces.agent-harness-runtime-boundary.yaml`.
The completed native release-worker design is preserved as attachment `ATT-00423`
on T-08680. Retrieve it with `prae task attachment get ATT-00423`.

1. **Parse manifests** — `asp-targets.toml` (or an agent's
   `agent-profile.toml` / a bare space ref / a filesystem path) and every
   `space.toml` in the composition.
2. **Resolve selectors** — `space:<id>@<selector>` refs resolve to exact
   commits/content against the applicable locality (registry, dev, project,
   agent) per the [composition model](/docs/agent-spaces/spaces-composition-model).
3. **Compute dependency closure and load order** — walks `deps.spaces`,
   enforcing the locality dependency-edge rules; later `compose` entries win
   collisions.
4. **Prepare the lock** with the resolved closure, integrity hashes, and
   locality markers (`dev`, `project`, `agent`, or a Git commit SHA).
5. **Populate the store and write `asp-lock.json`** — registry-backed content
   is snapshotted under `ASP_HOME`. Filesystem-backed dev, project, and agent
   spaces are read from their source. Install lints the resolved spaces before
   writing the lock.
6. **Materialize harness-specific artifacts** — `core/config/src/materializer`
   builds plugin manifests (`plugin-json.ts`), links commands/skills/agents
   (`link-components.ts`), composes hooks (`hooks-builder.ts`,
   `hooks-toml.ts`), composes MCP configs (`mcp-composer.ts`), composes
   settings/permissions (`settings-composer.ts`, `permissions-toml.ts`), and
   runs the agent-hygiene gate (`hygiene-gate.ts`).
7. **Compose target bundles** under the fingerprinted `ASP_HOME/codex-homes/`
   scope described below — the final, harness-ready directory tree for a target.
8. **Hand the bundle to the selected implementation** — adapter-backed
   foreground runs use the bundle to prepare the command and environment.
   Ordinary compilation resolves the driver and terminal recipe using
   `compiler/agent-spaces/src/harness-selection/catalog.ts#HARNESS_CATALOG`.

`asp install` runs steps 1-7 without launching (materializes bundles under
`ASP_HOME`). `asp build [target] --output <dir>` materializes without launching.
It uses the existing lock or auto-installs when the lock is missing. It writes
composed settings and any MCP config to the requested output and reports the
plugin directories in `ASP_HOME/cache`. Use `--no-install` to require an
existing lock. `--no-clean` and `--no-lint` are also available.

`asp run` prepares and launches either an adapter-backed command or the
direct runtime for an `agent-harness` profile. For a plain project target,
`asp run <target> --harness claude --dry-run` prepares the bundle and prints
the invocation without spawning it. A dry run can write the lock and bundle.
`asp diff` compares a fresh resolution with the existing lock and reports
pending changes without writing the lock.

## Roots: `agentRoot`, `projectRoot`, `agentsRoot`

The v2 runtime model separates agent-local state from project-local state
via three distinct roots:

- **`agentRoot`** (`<agentsRoot>/<agentId>/`) owns reserved runtime files —
  `SOUL.md` (required), optional `HEARTBEAT.md`, `agent-profile.toml` —
  plus agent-local `spaces/<id>/`.
- **`projectRoot`** owns `asp-targets.toml` and project-local
  `spaces/<id>/`. Resolved by marker walk-up (`asp-targets.toml`, bounded by
  the git root) from cwd, or `ASP_PROJECT_ROOT_OVERRIDE`.
- **`agentsRoot`** (default `~/praesidium/var/agents`, override via
  `ASP_AGENTS_ROOT` env or `agents-root` in `$ASP_HOME/config.toml`) hosts
  agent homes and shared spaces under `<agentsRoot>/spaces/`.

A project can declare `agents-root = "<relative-path>"` at the top level of
`asp-targets.toml`. The resolver in
`core/config/src/store/runtime-placement.ts#resolveAgentPlacementPaths`
checks that project-local root first, followed by the canonical agents root,
and takes the first `<agentId>/agent-profile.toml` it finds. A missing declared
project-local root produces a warning. The same agent ID can resolve to a
different profile depending on the placement's project.

## Root-relative refs

`agent-root:///<relative-path>`, `agents-root:///<relative-path>`, and
`project-root:///<relative-path>` address files inside those roots with
escape-safe resolution (`core/config/src/resolver/root-relative-refs.ts`):
paths are normalized before access, `..` escapes are rejected, and symlink
or alias escapes outside the declared root are rejected. Target-based entry forms (bare relative paths, plain space refs) remain
available; selection-bearing TOML must still use agent-profile version 4 and
project-target schema 2. Runtime APIs also accept these explicit root schemes
with placement context.

## Materialized home layout

Materialized bundles are keyed by identity and content, not by the agents-root
path — `ASP_HOME/codex-homes/<project>_<agent>/bundles/.versions/<fingerprint>/`,
where the fingerprint includes harness, target, materialization identity,
lock target, per-artifact content hashes, settings, and Codex options
(`core/config/src/orchestration/materialize-target.ts`). Adapter output lives
beneath that version root, such as `<target>/pi/` for the default install
adapter or `<target>/claude/` for Claude. Without an explicit materialization
identity, the scope uses the project-directory basename and target name.
Agent-local components can enter the bundle as a synthetic plugin keyed by
`basename(agentRoot)`. When the agent runtime materializer discovers skills
across the composed plugins, `discoverSkills()` rejects duplicate skill names.

## Agent-local tools

Agent tools run from the agent's source `tools/bin` directory, prepended
to the launch `PATH`. This keeps one agent-owned copy across harnesses and
avoids creating a separate tool bundle lifecycle. Agent and project state
directories are exposed independently of whether the agent supplies tools.

## Codex overlay (persona sync, not the install pipeline)

`just overlay-codex` (`scripts/sync-agent-to-codex-default.ts --install-hooks --apply`) overlays
**stella**, the Codex desktop-app agent (cody remains HRC-managed). This is a
separate, one-directional sync: it takes agent persona source under
`~/praesidium/var/agents/<agent>/` and
materializes it into `~/.codex` (updates the managed block in
`~/.codex/AGENTS.md`, syncs managed skills into `~/.codex/skills`, leaves
unmanaged Codex config/skills alone, and retires the previous agent's managed
block, skills, and manifest). Persona edits belong in
`~/praesidium/var/agents/` first — never edit the generated Codex home
files or materialized bundle copies directly.
