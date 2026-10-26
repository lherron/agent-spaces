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
ls -A $X; ls $X/skills | wc -l; grep -c trusted_hash $X/config.toml               # .asp-agent-sync, AGENTS.md, config.toml, hooks.json, skills; = planned skills (26); 3
ls $X/.asp-agent-sync                     # desktop-registration-discovery.mjs, pre-tool-use-praesidium-env.mjs, stella.json
bun scripts/sync-agent-to-codex-default.ts --to $X --asp-home $H --install-hooks --json   # agents unchanged; plan.hooks *Action all unchanged
M=<plan.materializedHome>; grep -c pkill-guard $M/hooks.json $X/hooks.json        # 1 and 0: T-11380
bun scripts/sync-agent-to-codex-default.ts --to $X --bogus                          # Unknown option: --bogus, exit 1
```

## Gotchas

- A replan of an unchanged home reports `agents: unchanged` but every skill as `update`: skills have no
  `unchanged` action, so the plan can't show skill drift. Compare files instead (2026-10-05,
  `T-10300/09-codex-overlay/drive.txt`). The hooks plan does: `hooksAction`, `configAction`, `scriptAction` and
  `discoveryScriptAction` all read `unchanged` on a replan (2026-10-19, `T-11375/09-codex-overlay/drive.txt`).
- **Space hooks don't reach the overlaid home** (product gap T-11380): stella composes `praesidium-defaults`, whose
  codex `pkill-guard` pre_tool_use hook is in the materialized home (`space-hooks/praesidium-defaults/`, 1 entry in
  its `hooks.json`), but the overlay writes `hooks.json` from its own two scripts only: 0 entries, no `space-hooks/`
  (2026-10-19, `T-11375/09-codex-overlay/drive.txt`).
- `--asp-home` and `--agents-root` default to env `ASP_HOME`/`ASP_AGENTS_ROOT`, which a seat exports: drop
  `--asp-home` and the plan materializes into the seat's real ASP_HOME (source, `sync-agent-to-codex-default.ts:118-119`;
  both variables are set in a clod seat). The script writes usage `paths` rows like `asp` does; export the
  scratch `ASP_USAGE_METRICS_VAR_ROOT` (`avs env`) first.
- The plan materializes the agent under `--asp-home` even without `--apply` (`codex-homes/praesidium_codex-default-
  <agent>/…`); a dry run is not write-free for ASP_HOME, only for the Codex home.
- The skill count (26 for stella on 2026-10-05, 25 on 2026-10-19, 26 on 2026-10-26) follows stella's content in `var/agents`, not
  the code; check "one directory per planned skill", not the number.
- The two hook scripts and the agent's manifest live in `$X/.asp-agent-sync/`. The discovery hook reads
  `~/praesidium/var/aspd/service/active.json` when it runs and spawns that release's `harness-broker`, so an aspd
  activation changes the broker a desktop conversation joins without re-running the overlay (source,
  `scripts/codex-default-overlay/constants.ts`; not driven).
- Source edits go under `~/praesidium/var/agents/`; the overlay only renders. Don't edit the Codex home's files.

## Proven when

The plan run leaves the Codex home empty; the apply run creates `AGENTS.md`, `config.toml` with `hooks = true` and
three `hooks.state` entries, `hooks.json`, and one directory per planned skill; the replan reports `agents:
unchanged` and every hooks action `unchanged`; `plan.priming.text` names stella.

Driven 2026-10-26 on scratch `t-11875` against checkout b32c6e05 (T-11875):
`var/wrkq-artifacts/T-11875/09-codex-overlay/drive.txt`.
