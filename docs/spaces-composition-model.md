---
id: agent-spaces/spaces-composition-model
title: Spaces Composition Model
kind: reference
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# Spaces Composition Model

A **Space** is a reusable, versioned bundle of Claude-Code-style plugin
components — commands, skills, agents, hooks, and MCP server configs —
described by a `space.toml` manifest. A **Run Target** is a named
composition profile in a project's `asp-targets.toml` that lists which
spaces to compose, plus harness selection and priming-prompt overrides.
`asp run`/`asp install`/`asp build` resolve the composition deterministically
and materialize it into a harness-specific plugin bundle.

## Anatomy of a space

A space is a directory containing a `space.toml` manifest (schema in
`packages/config/src/core/schemas/space.schema.json`) plus any of:

- `commands/` — slash-command markdown files
- `skills/` — skill directories (`SKILL.md` + supporting files)
- `agents/` — subagent persona markdown
- `hooks/` — hook definitions
- `mcp/` — MCP server configs (auto-discovered, or listed explicitly under `claude.mcp`)

Minimal `space.toml`:

```toml
schema = 1
id = "project-defaults"
version = "0.1.0"
description = "Default configuration for this project"

[plugin]
name = "project-defaults"
```

Notable manifest sections (all optional beyond `schema`/`id`):

- `deps.spaces` — transitive space-ref dependencies
- `settings.permissions.allow` / `.deny`, `settings.env`, `settings.model` —
  Claude settings applied when running with this space
- `harness.supports` — which public harness identities the space supports:
  `agent-harness`, `claude`, `codex`, and `muse`. This is a closed vocabulary;
  it is not a driver or provider routing table.
- `claude.model`, `claude.mcp` — retained Claude materialization settings
- `pi.model`, `pi.extensions`, `pi.build` — retained Pi implementation settings
  (extension bundling: `bundle`, `format` esm/cjs, `target` bun/node, `external`)
- `codex.config`, `codex.model`, `codex.prompts.enabled`, `codex.skills.enabled`
  — retained Codex materialization settings

Those implementation-specific sections shape generated artifacts only; none is
a public harness ID, provider route, or execution-recipe selector.

`id` and `plugin.name` both match `^[a-z0-9]+(?:-[a-z0-9]+)*$`.

## Space refs and locality

A space ref carries both an identity and a source locality
(`packages/config/src/resolver/space-classification.ts`):

| Kind | Ref form | Source | Lock commit marker |
| --- | --- | --- | --- |
| registry | `space:<id>@<selector>` | content-addressed store, resolved from git tag / dist-tag / sha | real git sha |
| dev | `space:<id>@dev` | registry working directory | `dev` |
| project | `space:project:<id>[@dev]` | `<projectRoot>/spaces/<id>/` | `project` |
| agent | `space:agent:<id>[@dev]` | `<agentRoot>/spaces/<id>/` | `agent` |

There is also `space:path:<path>@dev` for an explicit filesystem path (used
by `asp run ./path/to/my-space` in dev mode). The git-backed registry
workflow (`asp repo …`, dist-tags, semver-range selectors, `git:<sha>` pins)
is retired for new spaces but still parses for legacy lockfiles. New spaces
should live under the shared agents root (`<agentsRoot>/spaces/<id>/`), a
project (`<projectRoot>/spaces/<id>/`), or an agent root
(`<agentRoot>/spaces/<id>/`).

Project- and agent-local spaces use the same manifest schema and directory
layout as registry spaces but are read directly from the filesystem — only
`@dev` is a meaningful selector for them. Integrity is computed from
directory content; the lock entry records the marker commit plus a relative
`path` (`spaces/<id>`).

### Dependency edge rules

Locality constrains which spaces may depend on which, enforced at closure
time (`packages/config/src/resolver/closure.ts`). Disallowed edges:

- registry → agent
- registry → project
- agent → project
- project → agent

Registry spaces must stay standalone (no dependency on local spaces). Local
spaces may depend on registry spaces and on same-locality local spaces
(project → project, agent → agent). A violation throws a
`Disallowed dependency edge` error at resolution time.

## Run targets: `asp-targets.toml`

A project declares its composition profiles in `asp-targets.toml`
(schema in `packages/config/src/core/schemas/targets.schema.json`):

```toml
schema = 2

[targets.default]
description = "Default development environment"
compose = [
  "space:defaults@dev",          # shared space from the agents root
  "space:project:my-helpers",    # project-local space in ./spaces/my-helpers/
]
priming_prompt_append = """

## Project notes for the agent
"""
```

Per-target fields include `description`, `priming_prompt` /
`priming_prompt_append`, `compose` (ordered space-ref list — later entries
are higher precedence for collision warnings and load order), and
`compose_mode` (`replace` or `merge`). Selection scalars live only in
`[targets.<name>.provisioning]`: `harness`, `model_provider`, `model`,
`reasoning_effort`, and boolean `presentation`. The harness field accepts
exactly `agent-harness`, `claude`, `codex`, or `muse`; omission defaults through
the compiler catalog to `agent-harness`. Omitted `presentation` defaults to
`true`, while an explicit `presentation = false` remains explicit through
every merge. Provider/model compatibility and every execution recipe remain
compiler decisions, never TOML routing.

`asp-targets.toml` accepts only `schema = 2`; schema 1, `viewer`, aliases,
provider-prefixed model strings, and retired family/runtime/frontend/controller
selectors fail at parsing. This version gate concerns target selection only:
the independent `space.toml` content-manifest schema above remains `schema = 1`.
`agents-root` at the top level declares a project-local agents root layered over
the canonical one (see `agent-spaces/materialization-install-flow`).

Real per-agent target examples exist in this repo's own
`asp-targets.toml`, e.g.:

```toml
[targets.smokey]
description = "Smokey for agent-spaces"
compose = ["space:smokey@dev", "space:defaults@dev"]
priming_prompt_append = """

## Project: agent-spaces
- Uses Bun workspace, TypeScript. Run `just verify` before accepting changes.
- This project uses red/green TDD.
"""

[targets.smokey.provisioning]
harness = "codex"
model_provider = "openai-codex"
model = "gpt-5.6-terra"
reasoning_effort = "high"
presentation = false
```

## Resolution outputs

Resolving a project's targets against the space refs produces `asp-lock.json`
(schema `lock.schema.json`) — the pinned, integrity-hashed closure and load
order for each target. `asp diff` previews pending lock changes without
writing; `asp upgrade` re-resolves selectors to their latest matching
version. See `agent-spaces/materialization-install-flow` for what happens
after resolution (snapshotting, materialization, bundle assembly).
