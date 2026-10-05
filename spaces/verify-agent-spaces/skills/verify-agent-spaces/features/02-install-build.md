# 2. Install and materialization

`asp install` resolves every target in `asp-targets.toml`, writes `asp-lock.json` beside it, and materializes one
bundle per target and harness under `ASP_HOME/codex-homes/<projectId>_<target>/bundles/.versions/<hash>/<target>/
<harness>/`. The other verbs edit the targets file or the lock and reinstall. Code: `apps/cli/src/commands/{install,
build,gc,init,add,remove,upgrade}.ts`, materialization in `core/runtime` and `drivers/harness-*`. Doc:
`docs/materialization-install-flow.md`.

## Sub-features

- `asp install [--targets …] [--harness h] [--update] [--refresh]`: lock plus bundles; prints per-target plugin
  count and the run line. The default harness is `agent-harness` (pi layout: `<bundle>/pi/skills/…`); `--harness
  claude` lays out `<bundle>/claude/plugins/NNN-<space>/…` plus `settings.json`.
- `asp build [target] --harness h --output <dir>`: materializes without launching; plugin dirs live in
  `ASP_HOME/cache/<hash>`, `--output` gets `settings.json`.
- `asp gc [--dry-run]`: unreferenced snapshots, cache entries and bundle versions.
- `asp init [-t name] [--force]`: a new `asp-targets.toml` with one target composing `space:defaults@dev`.
- `asp add <ref> --target t` / `asp remove <id> --target t`: edit the target's compose list, then install.
- `asp upgrade [ids…]`: re-resolve selectors and rewrite the lock for every target.

## How to get to it

`avs scratch up --name <task>`, then from `<project>` with `ASP_HOME=<asp_home>`. Nothing here touches the
canonical project or the shared ASP_HOME (`~/praesidium/var/spaces-repo`) as long as `ASP_HOME` is set.

## Driving it

```bash
cd $AVS_PROJECT
asp install                                   # 2 targets; lock written
grep -rl AVS-PROBE-MARKER $ASP_HOME           # pi/skills/avs-probe/SKILL.md per target
asp install --harness claude                  # demo: 2 plugins; local-only: 1 plugin
asp build local-only --harness claude --output <root>/build-out
asp gc --dry-run
asp add space:project:avs-extra --target local-only        # space missing: exit 1, asp-targets.toml unchanged
mkdir -p spaces/avs-extra && printf '…space.toml…'          # create it, add again: added, reinstalls
asp remove nope --target local-only                         # "not found in target", exit 1
asp remove avs-extra --target local-only                    # bare id matches space:project:avs-extra; reinstalls
python3 -c "import json;print(sorted(json.load(open('asp-lock.json'))['targets']))"   # still ['demo', 'local-only']
asp upgrade                                                 # Targets updated: demo, local-only
mkdir <root>/init-probe && cd <root>/init-probe && asp init && cat asp-targets.toml
```

## Gotchas

- The install summary for agent-harness says `0 plugins` and prints flags without values (`--extension`,
  `--skill`, `--session-id`); the bundle still holds the skills and `asp run --dry-run` prints the full argv.
- The project id in bundle paths and `ASP_PROJECT` is the project directory's basename (`project` on a scratch).

## Proven when

`asp install` writes a lock naming both targets and the probe skill appears in each harness layout; `build --output`
writes `settings.json`; `gc --dry-run` deletes nothing; `upgrade` updates both targets; the add/remove legs keep
the other target locked, leave the file unchanged on failure and keep its comments.

Driven 2026-10-05 on scratch `t-10300` against checkout dc5e8bf (T-10300):
`var/wrkq-artifacts/T-10300/02-install-build/drive.txt`.
