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
[harness architecture](harness-architecture.md).

## Pipeline

This adapter-backed pipeline applies to external-harness homes and project
bundles. The first-party `agent-harness` runtime instead loads ordered ASP
resources directly through `AgentSpacesResourceLoader`; it does not consume
a compiler-built merged Pi bundle or generated external-harness home. See the
[native release-worker design](proposals/agent-harness-native-release-worker.md).

1. **Parse manifests** — `asp-targets.toml` (or an agent's
   `agent-profile.toml` / a bare space ref / a filesystem path) and every
   `space.toml` in the composition.
2. **Resolve selectors** — `space:<id>@<selector>` refs resolve to exact
   commits/content against the applicable locality (registry, dev, project,
   agent) per the [composition model](spaces-composition-model.md).
3. **Compute dependency closure and load order** — walks `deps.spaces`,
   enforcing the locality dependency-edge rules; later `compose` entries win
   collisions.
4. **Generate/update `asp-lock.json`** — pinned closure, integrity hashes,
   locality markers (`dev`, `project`, `agent`, or a real git sha).
5. **Snapshot resolved space content** into a content-addressed store under
   `ASP_HOME`.
6. **Materialize harness-specific artifacts** — `core/config/src/materializer`
   builds plugin manifests (`plugin-json.ts`), links commands/skills/agents
   (`link-components.ts`), composes hooks (`hooks-builder.ts`,
   `hooks-toml.ts`), composes MCP configs (`mcp-composer.ts`), composes
   settings/permissions (`settings-composer.ts`, `permissions-toml.ts`), and
   runs the agent-hygiene gate (`hygiene-gate.ts`).
7. **Compose target bundles** under the fingerprinted `ASP_HOME/codex-homes/`
   scope described below — the final, harness-ready directory tree for a target.
   `asp build` instead writes to its explicitly requested output directory.
8. **Hand the bundle to the selected implementation** — foreground execution
   uses the requested public harness identity (`agent-harness`, `claude`,
   `codex`, or `muse`). Ordinary compilation resolves the implementation's
   driver and terminal recipe only in the compiler catalog; materialization
   never infers a route from a provider or model.

`asp install` runs steps 1-7 without launching (materializes bundles under
`ASP_HOME`). `asp build [target] --output <dir>` also materializes without launching;
`--output` is required (`--no-clean`, `--no-install`, and `--no-lint` are optional).
`asp run` runs the full pipeline and then launches. `asp diff` runs steps
1-4 only and reports what would change without writing the lock. Always
validate a materialization change with `asp run <target> --dry-run` (prints
the generated harness invocation without spawning) before trusting it.

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

A project can additionally declare `agents-root = "<relative-path>"` at the
top level of its `asp-targets.toml` to layer a project-local agents root
over the canonical one. Resolution becomes a search path conditioned on the
placement's project — `roots(placement) = [<projectRoot>/<agents-root> (iff declared), canonicalAgentsRoot]` — and `resolveAgentRoot(agentId, placement)` returns the first root containing
`<agentId>/agent-profile.toml`. This gives canonical-agent-to-local-agent
delegation for free: an agent running under a project's scopes sees that
project's local agent cohort as well as the canonical root, while the same
agent handle resolved under a different project's scope correctly fails.
An agent exists iff `<root>/<agentId>/agent-profile.toml` exists — there is
no separate agent registry.

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
beneath that version root. Without an explicit materialization identity, the
scope uses the project-directory basename and target name. This makes bundles
portable across different agents-root locations. Agent-local components (an agent's own `spaces/<id>/`) enter the
bundle as a synthetic plugin keyed by `basename(agentRoot)`. Skills from all
composed plugins (space plugins plus the agent-local synthetic plugin) must
have globally unique names within one composed target — `discoverSkills()`
enforces this and fails materialization on a collision.

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
