# 1. Target composition and inspection

A project declares targets in `asp-targets.toml` (schema 2). Each target composes space refs:
`space:project:<id>` (a space under the project's `spaces/`), `space:<id>@dev` (a shared space under
`~/praesidium/var/agents/spaces/<id>`), and `compose_mode = "merge"` to append to an agent profile's own spaces.
The read verbs resolve that against the lock and report it. Code: `apps/cli/src/commands/{lint,explain,describe,
list,path,diff}.ts`, `apps/cli/src/commands/{repo,spaces}/`, resolution in `core/config` (`spaces-config`). Docs:
`docs/spaces-composition-model.md`, `docs/cli-reference.md`.

## Sub-features

- `asp lint [target] [--json]`: target and conflict warnings (`W101` lock missing, collisions). Exit 0 with
  warnings; `--json` gives `{warnings: [...]}`.
- `asp explain [target] [--json]`: registry, lock version, per-target compose, env hash, load order (key,
  commit, selector, components, hooks) and the composed commands, skills and hooks. Needs a lock with that target.
- `asp describe [target] --harness <h>`: hooks, skills, tools and lint warnings as the harness would materialize
  them.
- `asp list`: targets (locked or unlocked, env hash), paths (project, ASP_HOME, store, cache) and every agent root
  found (`canonical` for `~/praesidium/var/agents/<id>`).
- `asp path <spaceId>`: the filesystem path of a shared space.
- `asp diff [--json]`: pending lock changes without writing.
- `asp repo …` and `asp spaces …`: the git spaces registry verbs. The registry was retired (T-04144); they refuse
  without one.

## How to get to it

`avs scratch up --name <task>`, `cd <project>`, `ASP_HOME=<asp_home> asp install` (feature 2) so a lock exists,
then the verbs below. For the real project, run them read-only from `~/praesidium/agent-spaces` (its targets are
agent overlays; its lock is `asp-lock.json`).

## Driving it

```bash
cd $AVS_PROJECT
asp lint                         # before install: [W101] lock not found, exit 0
asp install                      # feature 2
asp explain demo                 # load order avs-demo@project then defaults@dev, composed skills/hooks
asp explain demo --json          # keys registryUrl, lockVersion, generatedAt, targets
asp describe local-only --harness claude   # skills: avs-probe
asp list                         # demo/local-only locked, env hashes, agent roots
asp path defaults                # ~/praesidium/var/agents/spaces/defaults
asp path avs-demo                # refuses: project spaces have no registry path
asp diff --json                  # {"diffs": []} right after install
asp spaces list; asp repo status # refuse: registry not initialized
cd ~/praesidium/agent-spaces && asp lint --json
```

## Gotchas

- `explain` marks project (`@project`) and `@dev` spaces `[NOT IN STORE]`: they are read from source, never
  snapshotted. Not an error (2026-10-05, `T-10300/01-composition/drive.txt`).
- `explain demo` listed the composed content of `defaults` but no skills for `avs-demo`, while `describe
  local-only` lists `avs-probe` and the bundle holds it. Read `describe` or the bundle for project-space content
  (2026-10-05, same drive).
- `explain` exits 1 `Target not found in lock` when the target is in `asp-targets.toml` but not the lock (a
  hand-edited targets file); rerun `asp install`.
- `asp path` resolves only shared spaces; a project space refuses `Space "<id>" not found`.
- `asp spaces list` and `asp repo status` refuse with "Registry not initialized" / "No registry found … Run asp
  repo init". The registry is retired; don't init one to make them pass.
- `asp explain clod` from `~/praesidium/foundry` printed `No lock file found` with exit 0 inside a pipe; read
  exit codes from a bare command.

## Proven when

On a fresh scratch: `lint` reports W101 before install and nothing after; `explain demo` shows both spaces in load
order with the defaults hooks; `describe local-only --harness claude` names `avs-probe`; `list` shows both targets
locked; `diff --json` is empty; the registry verbs refuse; `asp lint --json` on the canonical project prints its
warnings array.

Driven 2026-10-05 on scratch `t-10300` against checkout dc5e8bf (T-10300):
`var/wrkq-artifacts/T-10300/01-composition/drive.txt`.
