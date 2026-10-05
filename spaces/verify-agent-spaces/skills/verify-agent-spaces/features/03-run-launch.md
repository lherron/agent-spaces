# 3. Run and launch

`asp run <target>` materializes a target and execs the harness with the bundle's argv and environment. `asp agent
<scope> <mode>` does the same from a placement scope and an agent profile; `asp gui <agent>` opens Codex.app on an
agent's Codex home. Each takes `--dry-run` or `--print-command`. Code: `apps/cli/src/commands/run.ts`,
`apps/cli/src/commands/agent/`, `apps/cli/src/commands/gui.ts`; harness argv in `drivers/harness-{claude,codex,
muse,pi}`. Repo notes: `AGENTS.md` "Smoke Testing the CLI".

## Sub-features

- `asp run <target|space ref|path> [prompt] --harness agent-harness|claude|codex|muse`, plus `--model`,
  `--model-reasoning-effort`, `--permission-mode`, `--yolo`, `--inherit-*`, `--no-refresh`, `--no-interactive`.
- `--dry-run` prints the assembled system prompt (for profiled agents) and `── command ──` with the env prefix and
  argv; `--print-command` prints only the command.
- `asp agent <agent@project:task|agent:… ScopeRef> <query|heartbeat|task|maintenance|resolve> [prompt]`: profile-
  driven launch with `--harness`, `--model`, `--project-root`, `--prompt-file`, `--continue-*`.
- `asp gui <agent>`: `/usr/bin/open -n -a Codex` with `CODEX_HOME` and a per-agent Electron profile.

## How to get to it

A scratch (`avs scratch up`, `asp install`) for plain targets; the canonical project (`cd ~/praesidium/agent-spaces`)
with a scratch `ASP_HOME` for agent targets, so bundles land in the scratch. Never run without `--dry-run` or
`--print-command` in a drive: that launches a real harness.

## Driving it

```bash
cd $AVS_PROJECT
for h in claude codex muse; do asp run local-only --harness $h --dry-run; done
asp run local-only --dry-run                       # agent-harness refuses a profileless target, exit 1
cd ~/praesidium/agent-spaces
asp run larry --dry-run                            # system prompt block, then the codex argv
asp run larry --harness agent-harness --dry-run    # Dry run - direct agent-harness launch: agent-harness tui …
asp run larry --harness agent-harness --yolo --dry-run   # refuses compiler-only option --yolo, exit 1
asp agent larry@agent-spaces:avs-probe query 'hello' --print-command --project-root ~/praesidium/agent-spaces
asp agent larry@agent-spaces:avs-probe query 'hello' --harness claude --print-command …   # refuses: model gpt-5.6-terra
asp agent smokey@agent-spaces:avs-probe query 'hello' --harness claude --model sonnet --print-command …
asp gui larry --print-command
```

## Gotchas

- `agent-harness` (the default) requires a validated agent profile: `asp run <plain target>` refuses `global, dev,
  and arbitrary project-space targets are unsupported`. Pass `--harness` for a scratch target (2026-10-05,
  `T-10300/03-run-launch/drive.txt`).
- A profile's harness wins over the default: `asp run larry --dry-run` printed a codex command.
- `--harness claude` with a profile whose model is a GPT model refuses `Harness claude does not support model …`;
  pass `--model` too.
- The claude argv carries the priming prompt twice (`ASP_PRIMING_PROMPT` and the trailing positional) and the full
  system prompt inline: a profiled `--print-command` is tens of KB. Grep the drive, don't print it.
- agent-harness direct execution refuses compiler-only options (`--yolo`, `--permission-mode`, `--inherit-*`,
  `--no-refresh`, `--settings`, `--extra-args`, `--debug`, `--remote-control`, `--name-prefix`): `agent-harness
  direct execution does not support compiler-only option: --yolo`, exit 1 (`run.ts:268-288`). They work with
  `--harness claude|codex|muse` (2026-10-05, `T-10364/03-run-launch/drive.txt`).
- An agent-harness dry-run prints `Dry run - direct agent-harness launch:` and an `agent-harness tui …` line, not
  `── command ──`; grep for the right marker per harness.
- `asp run` has no `--prompt` flag (the prompt is positional); `asp agent` has both.
- Set `ASP_HOME` to a writable scratch, or temp-dir creation fails with EPERM (`AGENTS.md`).

## Proven when

Each harness's dry-run prints `── command ──` with the bundle path under the scratch ASP_HOME and exit 0; the
agent-harness refusal and the model refusal print their reasons with exit 1; `asp agent … --print-command` puts
the prompt after the profile priming; `asp gui --print-command` names the scratch `CODEX_HOME`.

Driven 2026-10-05 on scratch `t-10364` against checkout 062f293b (T-10364):
`var/wrkq-artifacts/T-10364/03-run-launch/drive.txt`. Not driven: a real (non-dry-run) launch, which needs a model
login and belongs to HRC's own verification.
