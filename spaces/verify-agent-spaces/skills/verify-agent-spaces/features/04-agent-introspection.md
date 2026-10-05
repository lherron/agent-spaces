# 4. Agent introspection

Read-only views of an agent: what launched this seat (`asp self`), what its session reminder renders to
(`resolve-reminder`), what the catalog and a full inspection say (`asp agents`), and its agent-authored runtime
resources (`asp resources plan`). Code: `apps/cli/src/commands/self/`, `apps/cli/src/commands/resolve-reminder.ts`,
`apps/cli/src/commands/agents.ts`, `apps/cli/src/commands/resources/`; inspection in
`compiler/agent-spaces` (`inspectAgentForContext`) and the wire types in `contracts/spaces-runtime-contracts`
(`agent-inspection.ts`).

## Sub-features

- `asp self inspect|paths|prompt [system|reminder|priming]|explain [which]|memory`: identity from the live env
  (`HRC_*`, `ASP_*`, `AGENT_*`), wrkq client wiring, and each runtime path classified `EDIT`/`SHRD`/`DRVD`.
- `asp resolve-reminder [target]`: the context template's reminder sections, as JSON `{content}` blocks.
- `asp agents catalog --context <ctx.json> [--json]`: every agent under the agents root with source availability,
  default context and diagnostic counts. Input schema `agent-inspection-evaluation-context/v2`.
- `asp agents inspect --request <req.json> --context <ctx.json> [--json]`: one agent's parts (prompt, capability)
  each with a disposition (`effective`, `failed` with a reason) and provenance. Request schema
  `agent-inspection-request/v2`. It compiles the runtime plan (`[asp-timing] compileRuntimePlan …`).
- `asp resources plan <agent> [--project p]`: `agent-authored-runtime-resources.plan/v1`.

## How to get to it

`asp self` needs a live seat (it reads `AGENT_LAUNCH_FILE` and the HRC env); run it from inside one. The catalog
and inspect inputs are files: copy `context.json` and `request.json` from the last drive's
`04-agent-introspection/` directory, or build them from `integration-tests/tests/agent-inspection-dry-run-parity
.red.test.ts`. The same catalog over aspd is feature 6.

## Driving it

```bash
asp self inspect                     # identity source live-env, scope, task, lane, wrkq client
asp self paths                       # SOUL, profile, context-template EDIT; bundle-* DRVD
asp self prompt reminder
asp self explain prompt
cd ~/praesidium/agent-spaces && asp resolve-reminder clod
asp resources plan clod --project agent-spaces          # 0 resources for clod
asp agents catalog --context context.json --json        # 48 agents, 0 errors on 2026-10-05
asp agents inspect --request request.json --context context.json --json
```

## Gotchas

- `asp self inspect` reports `harness: (unknown)` and `asp self prompt reminder` reads an empty
  `session-reminder.md` from a Claude seat's bundle; `asp self explain prompt` warns that no system prompt was
  extracted from the launch argv. The reminder a seat actually received comes from `asp resolve-reminder`
  (2026-10-05, `T-10300/04-agent-introspection/drive.txt`).
- `asp agents inspect` resolves templates that probe services. With `serviceProbeInputs.responses: []` the prompt
  part is `failed`: `Missing recorded service probe response for "HRC" at "unix://…/hrc.sock"`. Record probe
  responses in the context for an `effective` prompt.
- The catalog's `defaultContextSummary` matched the context file's identifiers (project, mode, harness `codex`)
  for every agent on 2026-10-05; don't read it as each agent's profile default without checking the profile.

## Proven when

`asp self inspect` names this seat's scope and task; `asp self paths` resolves the agent root; `resolve-reminder`
prints the wrkq and wrkc guides; `agents catalog` returns every agent root with `errorCount` 0; `agents inspect`
returns `ok: true` with parts and dispositions; `resources plan` prints a v1 plan.

Driven 2026-10-05 from seat `clod@agent-spaces:T-10300` against checkout dc5e8bf (T-10300):
`var/wrkq-artifacts/T-10300/04-agent-introspection/` (`drive.txt`, `context.json`, `request.json`).
