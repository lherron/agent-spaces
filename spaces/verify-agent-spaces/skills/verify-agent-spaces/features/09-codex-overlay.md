# 9. The Codex overlay

`just overlay-codex` materializes an agent (default `stella`, the Codex desktop agent) and overlays it onto a Codex
home: a managed block in `AGENTS.md`, managed skills under `skills/`, and, with `--install-hooks`, the Praesidium
hook entries in `config.toml` and `hooks.json`. Code: `scripts/sync-agent-to-codex-default.ts`,
`scripts/codex-default-overlay/` (`hooks-config.ts`). Repo notes: `AGENTS.md` "Codex Overlay".

## Sub-features

- Options: `--agent`, `--to <codex home>` (default `~/.codex`), `--asp-home`, `--agents-root`, `--project-root`,
  `--fetch`, `--install-hooks`, `--apply`, `--json`. Without `--apply` it only plans.
- The plan (`--json`): `applied`, and `plan.{agentId, agentRoot, codexHome, aspHome, projectId, taskId,
  targetName, refs, materializedHome, agents, skills, hooks, staleManagedSkills, retire, priming, warnings}`.
  `agents.action` is `create|update|unchanged`; each skill is `copy|update`.
- Invariants: `projectId=praesidium`, `taskId=primary`, `runMode=query`; markerless skill collisions warn and
  skip; managed skills are overwritten only while their marker hash matches; a previous agent's managed block and
  skills are retired.
- `just overlay-codex` is `--install-hooks --apply` against `~/.codex`.

## How to get to it

A scratch Codex home and the scratch ASP_HOME: `--to <scratch>/codex-home --asp-home <scratch>/asp-home`. Never the
recipe or `~/.codex` in a drive: that rewrites the real desktop agent's home.

## Driving it

```bash
cd ~/praesidium/agent-spaces
X=<scratch>/codex-home; H=<scratch>/asp-home; mkdir -p $X
bun scripts/sync-agent-to-codex-default.ts --to $X --asp-home $H --json            # plan; applied false
find $X                                                                              # still empty
bun scripts/sync-agent-to-codex-default.ts --to $X --asp-home $H --install-hooks --apply --json
ls $X; ls $X/skills | wc -l; grep -n hook $X/config.toml                            # AGENTS.md, config.toml, hooks.json, 26 skills
bun scripts/sync-agent-to-codex-default.ts --to $X --asp-home $H --install-hooks --json   # agents unchanged
```

## Gotchas

- A replan of an unchanged home reports `agents: unchanged` but every skill as `update`: skills have no
  `unchanged` action, so the plan can't show skill drift. Compare files instead (2026-10-05,
  `T-10300/09-codex-overlay/drive.txt`).
- The plan materializes the agent under `--asp-home` even without `--apply` (`codex-homes/praesidium_codex-default-
  <agent>/…`); a dry run is not write-free for ASP_HOME, only for the Codex home.
- Source edits go under `~/praesidium/var/agents/`; the overlay only renders. Don't edit the Codex home's files.

## Proven when

The plan run leaves the Codex home empty; the apply run creates `AGENTS.md`, `config.toml` with `hooks = true` and
three `hooks.state` entries, `hooks.json`, and one directory per planned skill; the replan reports `agents:
unchanged`.

Driven 2026-10-05 on scratch `t-10300` against checkout dc5e8bf (T-10300):
`var/wrkq-artifacts/T-10300/09-codex-overlay/drive.txt`.
