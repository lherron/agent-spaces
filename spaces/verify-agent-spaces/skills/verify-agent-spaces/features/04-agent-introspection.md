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
- `asp resolve-reminder [target]`: the rendered reminder text the SessionStart hook injects (`resolve-reminder.ts:200`
  writes it as is; exit 0 with empty stdout when nothing resolves).
- `asp self memory inspect|read|paths|snapshot|diff|scan` read the memory targets (MEMORY.md per agent, the shared
  USER.md, SOUL.md) with char budgets; `add`, `replace` and `remove` write them, so a drive uses only the read verbs.
- `asp agents catalog --context <ctx.json> [--json]`: every agent under the agents root with source availability,
  default context and diagnostic counts. Input schema `agent-inspection-evaluation-context/v2`.
- `asp agents inspect --request <req.json> --context <ctx.json> [--json]`: one agent's parts (prompt, capability)
  each with a disposition (`effective`, `failed` with a reason) and provenance. JSON is `{ok, inspection: {parts,
  diagnostics, …}}`; it exits 1 when not ok. Request schema
  `agent-inspection-request/v2`. It compiles the runtime plan (silently: the compiler writes nothing to stderr).
- `asp resources plan <agent> --project p [--agent-root d] [--include path…]`:
  `agent-authored-runtime-resources.plan/v1` JSON on stdout, the `Compiled resources plan for a@p: N resources
  (interface-binding=…, event-hook=…)` summary on stderr. `--project` is required (exit 2 without it). Every refusal
  prints `asp: <CODE>: <message>`, exit 1. Every resource must target `--project`: `mneme --project agent-spaces`
  refuses `CROSS_OWNER_TARGET: channels/discord-primary.toml: target project signal-pipeline does not match the planned
  project agent-spaces`. `--include hooks/…` refuses as a reserved directory. Since 1918213f (T-14268) schedules are
  not runtime resources: `--include schedules/…` refuses `SCHEDULE_MODULE_OWNED: … schedules are owned by the
  praesidium-kernel schedule module`, and the `[trigger].timezone` projection and its refusals are gone (2026-11-23,
  `T-14445/04-agent-introspection/drive.txt`).

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
asp resources plan mneme --project signal-pipeline      # 3 resources (interface-binding=1 event-hook=2) on 2026-11-23
asp resources plan mneme --project agent-spaces         # CROSS_OWNER_TARGET, exit 1
asp resources plan clod                                 # required option '--project <project>', exit 2
asp resources plan foundry --project foundry --include schedules/foundry-daily-report.toml   # SCHEDULE_MODULE_OWNED, exit 1
asp self memory paths; asp self memory inspect  # memory, user, persona with zone labels and chars/budget
asp agents catalog --context $CTX --json        # 23 agents, 0 errors on 2026-11-23 (33 on 2026-11-16)
asp agents inspect --request $REQ --context $CTX --json   # with foundry's ids/root: ok false, agent_self_brokered, exit 1 (stella: agent_participant_only)
asp agents inspect --request $REQ --context $CTX --json
```

## Gotchas

- `asp self inspect` reports `harness: (unknown)` and `asp self explain prompt` warns that no system prompt was
  extracted from the launch argv because current broker seats have no `AGENT_LAUNCH_FILE` (`envSource: live-env`);
  harness, provider and prompts come only from a launch artifact. `asp self prompt reminder` reads an empty
  `session-reminder.md` from a Claude seat's bundle. The reminder a seat actually received comes from `asp
  resolve-reminder` or `asp self prompt reminder --recompute` (2026-10-19, `T-11375/04-agent-introspection/drive.txt`).
- `resources plan` counts follow `var/agents` content, not the code: clod plans 0 resources for any project on
  2026-11-23 (its `infra` schedule no longer compiles, T-14268). Plan each agent with the project its resources target.
- An `antigravity-hrcpty` identity (neon) is valid inspection input, but the TS compiler refuses it: `ok: false`, 0
  parts, `unsupported_harness: Antigravity compilation requires raspd.`, exit 1 (2026-11-23).
- `asp agents inspect` replays the context file strictly. With `serviceProbeInputs.responses: []` it returns 8 parts for cody
  (7 for larry before 2026-11-23): the prompt part `failed` (`Missing recorded service probe response for "HRC" at
  "unix://…/hrc.sock", occurrence 1`), the rest `effective`, `ok: true`. Pin `{name, endpoint, up}` responses for HRC (`unix://…/var/run/hrc/hrc.sock`),
  ACP (`http://127.0.0.1:18470`) and taskboard (`http://127.0.0.1:18450`) and the prompt expands to 28 parts (19 effective / 8 skipped / 1 failed; 20 / 8 / 0 with HOME and PATH in
  `execInputs`, 2026-11-23).
- **CLI inspection runs exec sections for real.** The reminder's `just info`, `wrkq info` and `wrkc info` execute in
  `execInputs.cwd` with `execInputs.environment` as their whole env: with `{}` all three fail exit 127 (no PATH);
  with HOME and PATH they run and the result is 16 `effective`, 8 `skipped`. `project-tooling` (`just info`) now
  resolves for agent-spaces since exec sections run in the project root (4d0b5d4c, 15315fb0) (2026-11-02,
  `T-12323/04-agent-introspection/`). The aspd/ACP `inspectAgentSelection` path instead probes the three services
  live, connect-only (f675918e; source, feature 6).
- **The shared template is prae now (2026-11-23).** `var/agents/context-template.toml` has no `wrkq`/`wrkc` sections
  (`grep -c` 0) and clod has no agent-local template; `resolve-reminder clod` is 1582 bytes and `resolve-reminder cody`
  2132 bytes with or without `~/.local/bin` on PATH. The next bullet is the history before that.
- **From a prae seat `resolve-reminder` renders no wrkq or wrkc guide.** The shared template's `wrkq-context` and
  `wrkc-context` sections are exec sections (`wrkq info`, `wrkc info`, stderr dropped), and a prae seat has neither CLI
  on PATH (T-12654), so they render empty: `asp resolve-reminder larry` is 775 bytes with 0 `wrkq` lines, and 16270
  bytes with 2 once `~/.local/bin` is on PATH. clod's own template (rebuilt on prae, var/agents 08bd235) has no such
  sections at all. The `{"content": …}` objects earlier passes counted were that exec output, not the command's own
  format (2026-11-09, `T-12763/04-agent-introspection/drive.txt`).
- **`agents inspect` refuses agents HRC won't launch.** foundry (`[placement] launch = "self-brokered"`) returns `ok:
  false` with `agent_self_brokered` and stella (`participant-only`) with `agent_participant_only`, exit 1
  (`compile-runtime-plan.ts:22-60`), while `asp run`/`asp agent` still print a launch for both (feature 3). Their
  catalog rows have 0 errors (2026-11-16, `T-13644/04-agent-introspection/{request,context}-{foundry,stella}.json`).
- The prompt's scope line renders from the assigned scope (`ScopeRef: agent:cody:project:agent-spaces` in the pinned
  inspect, no literal `{{agentProjectScopeRef}}` there, in `resolve-reminder clod` or in `self prompt reminder
  --recompute`). `asp self inspect --raw-env` does not list `SCRATCH`, although HRC sets it on every seat (946d366c)
  (2026-11-23).
- The catalog's `defaultContextSummary` matched the context file's identifiers (project, mode, harness `codex`)
  for every agent on 2026-10-05; don't read it as each agent's profile default without checking the profile.

## Proven when

`asp self inspect` names this seat's scope and task; `asp self paths` resolves the agent root; `resolve-reminder`
prints the reminder text (the same bytes with or without the owner CLIs on PATH since the prae template); `self memory paths` lists the
three targets; `agents catalog` returns every agent root with `errorCount` 0; `agents inspect`
returns `ok: true` with parts and dispositions, and `ok: false` with the launch-mode code for foundry and stella; `resources plan` prints a v1 plan for the project its resources
target, and refuses a mismatched project (`CROSS_OWNER_TARGET`) and a schedule include (`SCHEDULE_MODULE_OWNED`).

Driven 2026-11-23 from seat `clod@agent-spaces:T-14445` against checkout 33556b1c (T-14445):
`var/wrkq-artifacts/T-14445/04-agent-introspection/` (`drive.txt`, the request/context files rebuilt for cody since larry
is archived, the foundry, stella and neon pairs and the three `inspect-*.json`; empty responses: 8 parts, prompt
`failed`; pinned: 28 parts, 19 effective / 8 skipped / 1 failed; pinned with env: 20 effective / 8 skipped; catalog 23).
