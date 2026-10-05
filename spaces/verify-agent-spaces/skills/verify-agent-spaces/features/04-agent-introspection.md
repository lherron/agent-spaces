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
  each with a disposition (`effective`, `failed` with a reason) and provenance. JSON is `{ok, inspection: {parts,
  diagnostics, …}}`; it exits 1 when not ok. Request schema
  `agent-inspection-request/v2`. It compiles the runtime plan (`[asp-timing] compileRuntimePlan …`).
- `asp resources plan <agent> --project p`: `agent-authored-runtime-resources.plan/v1`. `--project` is required;
  without it commander refuses, exit 2.

## How to get to it

`asp self` needs a live seat (it reads `AGENT_LAUNCH_FILE` and the HRC env); run it from inside one. The catalog
and inspect inputs are files you write: `$CTX` (an `agent-inspection-evaluation-context/v2` JSON) and `$REQ` (an
`agent-inspection-request/v2` JSON), both under `<artifact_dir>/04-agent-introspection/` with names you choose.
Copy them from the last drive's `04-agent-introspection/` directory, or build them from
`integration-tests/tests/agent-inspection-dry-run-parity.red.test.ts`. The same catalog over aspd is feature 6.

## Driving it

```bash
asp self inspect                     # identity source live-env, scope, task, lane, wrkq client
asp self paths                       # SOUL, profile, context-template EDIT; bundle-* DRVD
asp self prompt reminder
asp self explain prompt
cd ~/praesidium/agent-spaces && asp resolve-reminder clod
asp resources plan clod --project agent-spaces          # 0 resources for clod
asp resources plan clod                                 # required option '--project <project>', exit 2
asp agents catalog --context $CTX --json        # 48 agents, 0 errors on 2026-10-05
asp agents inspect --request $REQ --context $CTX --json
```

## Gotchas

- `asp self inspect` reports `harness: (unknown)` and `asp self prompt reminder` reads an empty
  `session-reminder.md` from a Claude seat's bundle; `asp self explain prompt` warns that no system prompt was
  extracted from the launch argv. The reminder a seat actually received comes from `asp resolve-reminder`
  (2026-10-05, `T-10300/04-agent-introspection/drive.txt`).
- `asp agents inspect` resolves templates that probe services. With `serviceProbeInputs.responses: []` the prompt
  part is `failed`: `Missing recorded service probe response for "HRC" at "unix://…/hrc.sock"`. Record probe
  responses in the context for an `effective` prompt.
- `asp resolve-reminder` prints one JSON object per section, back to back, not one JSON document: `json.load` fails
  `Extra data`. Count `"content"` lines or parse object by object (2026-10-05,
  `T-10364/04-agent-introspection/drive.txt`).
- The catalog's `defaultContextSummary` matched the context file's identifiers (project, mode, harness `codex`)
  for every agent on 2026-10-05; don't read it as each agent's profile default without checking the profile.

## Proven when

`asp self inspect` names this seat's scope and task; `asp self paths` resolves the agent root; `resolve-reminder`
prints the wrkq and wrkc guides; `agents catalog` returns every agent root with `errorCount` 0; `agents inspect`
returns `ok: true` with parts and dispositions; `resources plan` prints a v1 plan.

Driven 2026-10-05 from seat `clod@agent-spaces:T-10364` against checkout 062f293b (T-10364):
`var/wrkq-artifacts/T-10364/04-agent-introspection/` (`drive.txt` and the two input files it used).
