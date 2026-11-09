# 3. Run and launch

`asp run <target>` materializes a target and execs the harness with the bundle's argv and environment. `asp agent
<scope> <mode>` does the same from a placement scope and an agent profile; `asp gui <agent>` opens Codex.app on an
agent's Codex home. Each takes `--dry-run` or `--print-command`. Code: `apps/cli/src/commands/run.ts`,
`apps/cli/src/commands/agent/`, `apps/cli/src/commands/gui.ts`; harness argv in `drivers/harness-{claude,codex,
muse,pi}`. Repo notes: `AGENTS.md` "Smoke Testing the CLI".

## Sub-features

- `asp run <target|space ref|path> [prompt] --harness agent-harness|claude|claude-hrcpty|codex|codex-hrcpty|muse`
  (`--help` still lists four), plus `--model`,
  `--model-reasoning-effort`, `--permission-mode`, `--yolo`, `--inherit-*`, `--no-refresh`, `--no-interactive`,
  and the rest of `asp run --help` (`--resume`, `--remote-control`, `--name-prefix`, `--settings`, `--extra-args`,
  `--debug`, `--page-prompts`). Claude gets `--effort <e>` from `--model-reasoning-effort`; codex gets
  `-c 'model_reasoning_effort="<e>"'`, also from the profile.
- `--dry-run` prints the assembled system prompt (for profiled agents) and `── command ──` with the env prefix and
  argv; `--print-command` prints only the command (for agent-harness, a bare `agent-harness tui …` line).
- Claude argv always has `--chrome`, and `--disallowedTools AskUserQuestion` unless the profile or target sets
  `[claude] ask_user_question = true` (`claude-adapter.ts:500`; every profile that sets it, mable, rector and vesta, sets
  `false` on 2026-11-09; a scratch target with `true` drops the deny, `T-12763/03-run-launch/drive.txt`); a yolo profile adds
  `--dangerously-skip-permissions --permission-mode bypassPermissions`. Codex argv has `--enable goals` and
  `--dangerously-bypass-hook-trust`; a codex home of a target composing `praesidium-defaults` carries the
  `pkill-guard` space hook (`space-hooks/praesidium-defaults/`, `hooks.json`, `space-hooks.json`).
- `asp agent <agent@project:task|agent:… ScopeRef> <query|heartbeat|task|maintenance|resolve> [prompt]`: profile-
  driven launch with `--harness`, `--model`, `--project-root`, `--prompt-file`, `--continue-*`.
  `resolve` prints the placement and resolved bundle (instructions, spaces) without argv; `query` without a prompt
  refuses `Prompt required`, exit 1.
- The hrcpty ids launch directly with the base harness's argv (hrcpty hosting exists only in HRC/aspd broker plans):
  `claude-hrcpty` prints the `claude` argv with a `.../claude-hrcpty/` bundle and keeps the profile model (`asp run
  clod --harness claude-hrcpty` has clod's `--model opus`). Two divergences from the base harness (product gap
  T-12329): a profile or target whose harness is hrcpty loses every `supports`-gated space (`asp run clod`, profile
  `claude-hrcpty`, gets 5 plugins without `defaults`, `prae-tools` and `prae-only`; `--harness claude` gets 8 on 2026-11-09. `asp run smokey`, target
  `codex-hrcpty`, lacks `smoke-testing`), and `codex-hrcpty` sets `CODEX_HOME` to the immutable bundle template
  `<bundle>/codex-hrcpty/codex.home` instead of the per-project runtime home `codex-homes/<project>_<target>`
  (2026-11-02, `T-12323/03-run-launch/drive.txt`).
- `asp gui <agent>`: `/usr/bin/open -n -a Codex` with `CODEX_HOME` and a per-agent Electron profile, for any agent
  (a claude-profiled `clod` opens Codex too).

## How to get to it

A scratch (`avs scratch up`, `asp install`) for plain targets; the canonical project (`cd ~/praesidium/agent-spaces`)
with a scratch `ASP_HOME` for agent targets, so bundles land in the scratch. A dry-run there still rewrites the
canonical `~/praesidium/agent-spaces/asp-lock.json` (gitignored) whenever the scratch bundle is missing
(`drivers/execution/src/run.ts:284,293-298`; 2026-11-02 shasum changed again): on 2026-10-26 every `asp run larry --dry-run` into a fresh scratch ASP_HOME rewrote it with
only `generatedAt` changed (`T-11875/03-run-launch/drive.txt`). Harmless for content, but it is a write outside the
scratch; say so in the evidence. Never run without `--dry-run` or
`--print-command` in a drive: that launches a real harness.

## Driving it

```bash
cd $AVS_PROJECT
for h in claude claude-hrcpty codex codex-hrcpty muse; do asp run local-only --harness $h --dry-run; done   # codex-hrcpty: CODEX_HOME=<bundle template>
asp run local-only --dry-run                       # agent-harness refuses a profileless target, exit 1
cd ~/praesidium/agent-spaces
asp run larry --dry-run                            # system prompt block, then the codex argv
asp run larry --harness agent-harness --dry-run    # Dry run - direct agent-harness launch: agent-harness tui …
asp run larry --harness agent-harness --yolo --dry-run   # refuses compiler-only option --yolo, exit 1
asp agent larry@agent-spaces:avs-probe query 'hello' --print-command --project-root ~/praesidium/agent-spaces
asp agent larry@agent-spaces:avs-probe query 'hello' --harness claude --print-command …   # refuses: model gpt-5.6-terra
asp agent smokey@agent-spaces:avs-probe query 'hello' --harness claude --model sonnet --print-command …
asp run clod --print-command | tr ' ' '\n' | grep -A1 -- '^--plugin-dir$'   # 5 plugins, no defaults (T-12329); --harness claude: 8
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
  direct execution does not support compiler-only option: --yolo`, exit 1 (`run.ts:268-289`; `--yolo` and
  `--permission-mode` driven). They work with `--harness claude|codex|muse` (2026-10-19,
  `T-11375/03-run-launch/drive.txt`).
- A profile's `reasoning_effort` reaches a codex direct launch but not a Claude one (still so on 2026-11-02): `asp run larry --harness claude
  --model sonnet --print-command` has no `--effort` though larry says `high`; only the flag adds it (product gap
  T-11379; HRC compiles pass it). Assert the flag, not the profile (2026-10-19, `T-11375/03-run-launch/drive.txt`).
- An agent-harness dry-run prints `Dry run - direct agent-harness launch:` and an `agent-harness tui …` line, not
  `── command ──`; grep for the right marker per harness.
- `asp run` has no `--prompt` flag (the prompt is positional); `asp agent` has both.
- Set `ASP_HOME` to a writable scratch, or temp-dir creation fails with EPERM (`AGENTS.md`).

## Proven when

Each harness's dry-run prints `── command ──` with the bundle path under the scratch ASP_HOME and exit 0; the claude
`--settings` file has `idleCompaction: false`; `--model-reasoning-effort high` puts `--effort high` in the claude
argv; the agent-harness refusal and the model refusal print their reasons with exit 1; `asp agent … --print-command`
puts the prompt after the profile priming; `asp gui --print-command` names the scratch `CODEX_HOME`.

Driven 2026-11-09 on scratch `t-12763` against checkout 93d96239 (T-12763):
`var/wrkq-artifacts/T-12763/03-run-launch/drive.txt`. Not driven: a real (non-dry-run) launch, which needs a model
login and belongs to HRC's own verification.
