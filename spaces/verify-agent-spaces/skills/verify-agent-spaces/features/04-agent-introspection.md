# 4. Agent introspection

Read-only views of an agent: what launched this seat (`asp self`), what its session reminder renders to
(`resolve-reminder`), what the catalog and a full inspection say (`asp agents`), and its agent-authored runtime
resources (`asp resources plan`). Code: `apps/cli/src/commands/self/`, `apps/cli/src/commands/resolve-reminder.ts`,
`apps/cli/src/commands/agents.ts`, `apps/cli/src/commands/resources/`; inspection in
`compiler/agent-spaces` (`inspectAgentForContext`) and the wire types in `contracts/spaces-runtime-contracts`
(`agent-inspection.ts`).

## Sub-features

- `asp self inspect|paths|prompt [system|reminder|priming]|explain [which]|memory`: identity from the live env
  (`HRC_*`, `ASP_*`, `AGENT_*`), wrkq client wiring, and each runtime path classified `EDIT`/`SHRD`/`DRVD`/`EPHM`
  (`--kind editable|shared-editable|derived|ephemeral`; a Claude seat now lists a `bundle-statusline` DRVD row).
  `asp self prompt reminder --recompute` re-renders the reminder from the current template (`source: template
  recompute`). A bad kind, topic or `--kind` is a usage error, exit 2.
- `asp resolve-reminder [target]`: the context template's reminder sections, as JSON `{content}` blocks.
- `asp agents catalog --context <ctx.json> [--json]`: every agent under the agents root with source availability,
  default context and diagnostic counts. Input schema `agent-inspection-evaluation-context/v2`.
- `asp agents inspect --request <req.json> --context <ctx.json> [--json]`: one agent's parts (prompt, capability)
  each with a disposition (`effective`, `failed` with a reason) and provenance. JSON is `{ok, inspection: {parts,
  diagnostics, …}}`; it exits 1 when not ok. Request schema
  `agent-inspection-request/v2`. It compiles the runtime plan (silently: the compiler writes nothing to stderr).
- `asp resources plan <agent> --project p [--agent-root d] [--include path…]`:
  `agent-authored-runtime-resources.plan/v1` JSON on stdout, the `Compiled resources plan for a@p: N resources
  (scheduled-job=…)` summary on stderr. `--project` is required (exit 2 without it). Every resource must target
  `--project`: a schedule for another project refuses `target project <x> does not match the planned project <p>`,
  exit 1. `[trigger].timezone` (IANA) projects to `desiredJson.schedule.timezone`; a bad zone refuses `must be an
  IANA time zone`, a top-level `timezone` refuses `set [trigger].timezone instead`, and `--include hooks/…` refuses
  as a reserved directory, each exit 1.

## How to get to it

`asp self` needs a live seat (it reads the HRC env, and `AGENT_LAUNCH_FILE` when one is set); run it from inside one. The catalog
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
asp resources plan clod --project infra                 # 1 resource (disk-sample schedule) on 2026-10-19
asp resources plan clod --project agent-spaces          # refuses: that schedule targets infra, exit 1
asp resources plan clod                                 # required option '--project <project>', exit 2
asp resources plan foundry --project foundry --include schedules/foundry-daily-report.toml   # timezone America/Chicago
asp agents catalog --context $CTX --json        # 50 agents, 0 errors on 2026-10-19
asp agents inspect --request $REQ --context $CTX --json
```

## Gotchas

- `asp self inspect` reports `harness: (unknown)` and `asp self explain prompt` warns that no system prompt was
  extracted from the launch argv because current broker seats have no `AGENT_LAUNCH_FILE` (`envSource: live-env`);
  harness, provider and prompts come only from a launch artifact. `asp self prompt reminder` reads an empty
  `session-reminder.md` from a Claude seat's bundle. The reminder a seat actually received comes from `asp
  resolve-reminder` or `asp self prompt reminder --recompute` (2026-10-19, `T-11375/04-agent-introspection/drive.txt`).
- `resources plan` counts follow `var/agents` content, not the code: clod gained an `infra` schedule on 2026-10-13
  (T-10808), so `--project agent-spaces` now refuses. Plan each agent with the project its resources target.
- `asp agents inspect` resolves templates that probe services. With `serviceProbeInputs.responses: []` the prompt
  part is `failed`: `Missing recorded service probe response for "HRC" at "unix://…/hrc.sock", occurrence 1`, while
  `ok` stays `true` and the other six parts are `effective`. Record probe
  responses in the context for an `effective` prompt.
- `asp resolve-reminder` prints one JSON object per section, back to back, not one JSON document: `json.load` fails
  `Extra data`. Count `"content"` lines or parse object by object (2026-10-05,
  `T-10364/04-agent-introspection/drive.txt`).
- The catalog's `defaultContextSummary` matched the context file's identifiers (project, mode, harness `codex`)
  for every agent on 2026-10-05; don't read it as each agent's profile default without checking the profile.

## Proven when

`asp self inspect` names this seat's scope and task; `asp self paths` resolves the agent root; `resolve-reminder`
prints the wrkq and wrkc guides; `agents catalog` returns every agent root with `errorCount` 0; `agents inspect`
returns `ok: true` with parts and dispositions; `resources plan` prints a v1 plan for the project its resources
target, projects `[trigger].timezone`, and refuses a mismatched project, a bad zone and a top-level `timezone`.

Driven 2026-10-19 from seat `clod@agent-spaces:T-11375` against checkout f8c96a5e (T-11375):
`var/wrkq-artifacts/T-11375/04-agent-introspection/` (`drive.txt`, the two input files, and the `tz-*.toml` probe
schedules, run from a scratch agent root under the scratch).
