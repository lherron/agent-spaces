# 1. Target composition and inspection

A project declares targets in `asp-targets.toml` (schema 2). Each target composes space refs:
`space:project:<id>` (a space under the project's `spaces/`), `space:<id>@dev` (a shared space under
`~/praesidium/var/agents/spaces/<id>`), and `compose_mode = "merge"` to append to an agent profile's own spaces.
The read verbs resolve that against the lock and report it. Code: `apps/cli/src/commands/{lint,explain,describe,
list,path,diff}.ts`, `apps/cli/src/commands/{repo,spaces}/`, resolution in `core/config` (`spaces-config`). Docs:
`docs/spaces-composition-model.md`. Use `asp --help` for CLI syntax.

## Sub-features

- `asp lint [target] [--json]`: target and conflict warnings (`W101` lock missing, collisions, `W204` a `hooks/`
  dir with no hooks config, severity error). The header counts errors, warnings and info (`Found 2 error(s):`;
  W101 counts as info, `Found 1 info:`). Exit 0 always, even with error rows; `--json` gives `{warnings: [...]}`.
- `asp explain [target] [--json]`: `Spaces root:` (the resolved shared root, not the lock's registry remote), lock version, per-target compose, env hash, load order (key,
  commit, selector, components, hooks) and the composed commands, skills and hooks. Needs a lock with that target.
- `asp describe [target] --harness <h>`: hooks, skills, tools and lint warnings as the harness would materialize
  them. `<h>` is any of the seven harness ids (`agent-harness`, `claude`, `claude-hrcpty`, `codex`, `codex-hrcpty`,
  `antigravity-hrcpty`, `muse`). For an hrcpty id it still lists `supports`-gated spaces that `install` drops
  (T-12329, feature 2). `antigravity-hrcpty` (e5b290be) compiles only in raspd: `describe --harness
  antigravity-hrcpty` refuses `asp: unsupported_harness: Antigravity compilation requires raspd.` exit 1
  (`drivers/execution/src/harness/antigravity.ts`), while `explain --harness antigravity-hrcpty` prints the usual
  report (2026-11-23, `T-14445/01-composition/drive.txt`).
- Since aa3bb12d (T-12326) `explain` reads each locked space's `space.toml` for an optional `[path] exclude` list and
  prints the sorted union as `PATH exclude: …` under Composed content (the PATH filter itself is compile-side). `lint`
  does not read it: adding `[path] exclude` to a scratch space left `lint --json` byte-identical. `prae-only` declares
  one (`wrkq wrkc wrkf wrkp hrc asp aspc`), so canonical `explain clod` shows it. A synthetic agent plugin with no
  `space.toml` counts as no exclusion (source) (2026-11-16, `T-13644/01-composition/drive.txt`).
- `asp list`: targets (locked or unlocked, env hash), paths (project, ASP_HOME, store, cache) and every agent root
  found (`canonical` for `~/praesidium/var/agents/<id>`).
- `asp path <spaceId>`: the filesystem path of a shared space.
- `asp diff [--json]`: pending lock changes without writing. It compares each space's locked `commit` only, and
  `@dev` and project spaces always lock as `dev`/`project`, so it sees compose-list changes (`added`/`removed`) but
  never an edit inside such a space. Exit 0 either way.
- `asp repo init|new-space|status` and `asp spaces init|list`: the shared spaces root (`<agentsRoot>/spaces/`,
  `--registry <path>` or `ASP_AGENTS_ROOT` overrides). `repo init` installs the generated `agent-spaces-manager`
  space (hook script 0755) or prints `Manager space already present`. `new-space` writes `space.toml` plus
  `commands/ skills/ agents/ mcp/`, no `hooks/` (an empty one trips W204). `repo status` lists every directory under
  `spaces/`; `spaces list` only those whose `space.toml` parses (14 vs 13 on 2026-10-19: `archived-unused`; 13 and 13
  on 2026-11-16; 7 and 7 on 2026-11-23 after the prae collapse, var/agents 57c5312). The git
  registry verbs `asp repo publish|tags|gc` were removed (T-10367) and exit 2 `unknown command '<verb>'`.
- `describe` on a target of only `@dev` and project spaces skips the shared root's registry fetch since 15dbde97
  (`~/praesidium/var/agents/.git/FETCH_HEAD` mtime unchanged; a `materialize.registry-fetch` `skipped` path row).

## How to get to it

`avs scratch up --name <task>`, `cd <project>`, `ASP_HOME=<asp_home> asp install` (feature 2) so a lock exists,
then the verbs below. For the real project, run them read-only from `~/praesidium/agent-spaces` (its targets are
agent overlays; its lock is `asp-lock.json`).

## Driving it

```bash
cd $AVS_PROJECT
asp lint                         # before install: [W101] lock not found, exit 0
asp install                      # feature 2
asp explain demo                 # load order avs-demo@project then defaults@dev; Skills: avs-probe (from avs-demo), frontend-design
asp explain demo --json          # keys spacesRoot, lockVersion, generatedAt, targets
asp describe local-only --harness claude   # skills: avs-probe
asp list                         # demo/local-only locked, env hashes, agent roots
asp path defaults                # ~/praesidium/var/agents/spaces/defaults
asp path avs-demo                # refuses: project spaces have no registry path
asp diff --json                  # {"diffs": []} right after install
asp spaces list; asp repo status # the shared root ~/praesidium/var/agents and its spaces (read-only)
cd ~/praesidium/agent-spaces && asp lint --json
```

## Gotchas

- `explain` marks project (`@project`) and `@dev` spaces `[NOT IN STORE]`: they are read from source, never
  snapshotted. Not an error (2026-10-05, `T-10300/01-composition/drive.txt`).
- `explain` exits 1 `Target not found in lock` when the target is in `asp-targets.toml` but not the lock (a
  hand-edited targets file, or a canonical lock rewritten by a single-target `asp run` dry-run); rerun `asp install`.
  On 2026-11-02 the canonical lock lacked animata, animan, locallarry and foundry
  (`T-12323/01-composition/canonical-explain-per-target.txt`); on 2026-11-16 it still did, and it also held stale
  `muse` and `mux` targets that `asp-targets.toml` no longer has (`T-13644/01-composition/drive.txt`).
- A `deps.spaces` cycle between project spaces refuses at `install`: `✘ Cyclic dependency detected: avs-a@project ->
  avs-b@project -> avs-a@project` (2026-11-23, scratch copy, `T-14445/01-composition/drive.txt`).
- Canonical `asp lint --json` warnings follow `var/agents` content: 2 `W204` on 2026-11-23 (clod's and cody's, both
  from `console-defaults`; `prae-console-defaults` is gone); 3 `W204` errors on 2026-11-02 (the
  `console-defaults` space has a `hooks/` dir with no hooks config; on 2026-11-16 clod's comes from
  `prae-console-defaults`, muse's and cody's from `console-defaults`), `[]` on 2026-10-26. During T-12326's pre-landing
  work it failed `{"error":{"message":"File not found"}}` exit 1; fixed before aa3bb12d (`T-12323/01-composition/drive.txt`).
- `asp path` resolves only shared spaces; a project space refuses `Space "<id>" not found`.
- `asp repo init`, `asp repo new-space` and `asp spaces init` WRITE into the resolved shared root, which is the
  live `~/praesidium/var/agents` even on a scratch ASP_HOME. Drive them only with `--registry <tmpdir>`.
- `asp repo status` lists `git.changes` for `spaces/` only; other dirt in the agents repo is not shown.
- `asp diff --json` stays `{"diffs": []}` after editing a project space's files; it is not a no-change proof for
  `@dev` or project spaces (2026-10-19, `T-11375/01-composition/drive.txt`).
- larry, smokey and curly were archived from `var/agents` (fdff852, P-01214; `spaces/smokey` too), but their targets
  stay in the canonical `asp-targets.toml`. `explain` still prints them from the lock; launching them refuses
  (feature 3; product gap T-14446). Use clod and cody as canonical subjects.
- The canonical project's targets larry, smokey, curly and animan compose `praesidium-defaults@dev` after
  `defaults@dev` (9f1eb3d9); `asp explain larry --no-lint | grep Key:` shows both.
- `asp explain clod` from `~/praesidium/foundry` printed `No lock file found` with exit 0 inside a pipe; read
  exit codes from a bare command.

## Proven when

On a fresh scratch: `lint` reports W101 before install and nothing after; `explain demo` shows both spaces in load
order with the defaults hooks and lists `avs-probe (from avs-demo)` under composed skills; `describe local-only
--harness claude` names `avs-probe`; `list` shows both targets locked; `diff --json` is empty; the registry verbs
refuse with exit 2; `asp lint --json` on the canonical project exits 0 with its warnings array (2 W204 on
2026-11-23).

Driven 2026-11-23 on scratch `t-14445` against checkout 33556b1c (T-14445):
`var/wrkq-artifacts/T-14445/01-composition/drive.txt` (canonical lint: 2 `W204`; the lock lacked animata, animan,
locallarry and foundry at pass start, and the pass's dry-runs added locallarry; antigravity-hrcpty `describe` refusal and the dependency-cycle refusal driven).
