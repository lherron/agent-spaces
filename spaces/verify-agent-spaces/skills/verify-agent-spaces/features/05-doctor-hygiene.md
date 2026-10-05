# 5. Doctor and hygiene

The product's own health and quality checks: environment (`asp doctor`), harness detection (`asp harnesses`),
the agent-hygiene lint over skills and agent roots (`asp lint --hygiene`), and the resident-prompt cost report
(`asp token-rent`). Code: `apps/cli/src/commands/{doctor,harnesses,lint-hygiene,token-rent}.ts`. Docs:
`docs/agent-hygiene/README.md`, `docs/agent-hygiene/lint-rules.md`.

## Sub-features

- `asp doctor [--json]`: claude binary and version, ASP_HOME, cache and snapshot writability, the agents registry
  and its remote, the project, agent roots, the profile-model audit.
- `asp harnesses [--json]`: each harness (`agent-harness` default, `claude`, `codex` experimental, `muse`) with
  path, version, capabilities and models per provider. JSON shape `{harnesses: [{id, name, detection: {available,
  version, path, capabilities}, …}]}`.
- `asp lint --hygiene [path] [--strict] [--baseline f] [--update-baseline] [--judge f]`: advisory `W4xx` findings
  with file:line; `--strict` exits nonzero on error severity.
- `asp token-rent [--agent a] [--json] [--now iso] [--usage-since iso] [--since ref]`: resident system-prompt tokens
  per agent priced against HRC run frequency from `var/state/hrc/state.sqlite`. The prompt comes from the agent's
  newest `broker_invocations` spec: `launch.systemPromptFile` (claude, muse), or for codex the praesidium-context
  block of `$CODEX_HOME/AGENTS.md`. Agents with no such invocation report 0 with `missingPromptArtifact`.

## How to get to it

`asp doctor` from the scratch project with its `ASP_HOME`. `harnesses`, `token-rent` and hygiene need no scratch;
token-rent reads the HRC DB read-only. Pass `--now` to token-rent so two runs compare.

## Driving it

```bash
cd $AVS_PROJECT && asp doctor                                   # All checks passed!
asp harnesses                                                    # 4/4 available
asp lint --hygiene ~/praesidium/var/agents/clod | tail           # W415/W422 info findings
asp lint --hygiene $AVS_PROJECT/spaces/avs-demo/skills/avs-probe # Scanned 1 unit, no findings
asp lint --hygiene $AVS_PROJECT/spaces/avs-demo --strict; echo $? # Scanned 0 units, exit 0
asp token-rent --agent clod --now 2026-10-05T20:00:00Z
asp token-rent --json --now 2026-10-05T20:00:00Z | python3 -c '…count agents with residentTokens > 0…'
sqlite3 -readonly ~/praesidium/var/state/hrc/state.sqlite \
  "select broker_driver, count(*), sum(json_extract(spec_projection_json, '$.launch.systemPromptFile') is not null)
     from broker_invocations group by 1;"
```

## Gotchas

- `asp lint --hygiene <space dir>` scans 0 units and passes, even with `--strict`. Point it at a skill directory,
  an agent root or `var/agents`, never at a space root.
- `asp doctor` checks the claude binary only; codex, muse and pi detection is `asp harnesses`.

## Proven when

`asp doctor` passes on the scratch; `asp harnesses` shows 4/4 with a default per provider; hygiene on a real agent
root returns findings with file:line and on the probe skill scans 1 unit; token-rent prices every agent whose
newest invocation carries a prompt (claude, muse, codex drivers in the count above) and one agent's
`residentTokens` equals the sum of `ceil(section chars / 4)` over its prompt file.

Driven 2026-10-05 on scratch `t-10300` against checkout dc5e8bf (T-10300):
`var/wrkq-artifacts/T-10300/05-doctor-hygiene/drive.txt`.
