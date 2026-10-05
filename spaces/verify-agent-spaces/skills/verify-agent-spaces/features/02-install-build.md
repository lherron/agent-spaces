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
asp add space:project:avs-extra --target local-only        # space missing: install fails, exit 1
mkdir -p spaces/avs-extra && printf '…space.toml…'          # create it, add again: "already in target"
asp remove avs-extra --target local-only                    # "not found in target", exit 0
asp remove space:project:avs-extra --target local-only      # removes, reinstalls
python3 -c "import json;print(sorted(json.load(open('asp-lock.json'))['targets']))"   # only ['local-only']
asp install                                                 # back to ['demo', 'local-only']
asp upgrade                                                 # Targets updated: demo, local-only
mkdir <root>/init-probe && cd <root>/init-probe && asp init && cat asp-targets.toml
```

## Gotchas

- **`asp add`/`asp remove --target X` rewrite the lock with only target X.** After either, `asp-lock.json`
  holds `['local-only']`, `asp list` shows `demo (unlocked)` and `asp explain demo` exits 1 until a full `asp
  install` (2026-10-05, `T-10300/02-install-build/drive.txt`). Product gap.
- **`asp add` writes the ref before it validates it.** Adding a project space that doesn't exist exits 1 (`Space
  manifest not found`) but leaves the ref in `asp-targets.toml`. Product gap.
- **`asp remove` matches only `space:<id>@<selector>` by bare id.** For `space:project:<id>` it prints `not found
  in target` and exits 0; pass the full ref (`remove.ts` `extractSpaceId`). The help says "Space ID (e.g.
  my-space)". Product gap.
- `asp add`/`remove` re-serialize `asp-targets.toml` and drop its comments.
- The install summary for agent-harness says `0 plugins` and prints flags without values (`--extension`,
  `--skill`, `--session-id`); the bundle still holds the skills and `asp run --dry-run` prints the full argv.
- The project id in bundle paths and `ASP_PROJECT` is the project directory's basename (`project` on a scratch).
- `asp init`'s "Next steps" says `asp run --target dev`; `asp run` takes the target positionally.

## Proven when

`asp install` writes a lock naming both targets and the probe skill appears in each harness layout; `build --output`
writes `settings.json`; `gc --dry-run` deletes nothing; `upgrade` updates both targets; the add/remove legs show
the lock and file effects above.

Driven 2026-10-05 on scratch `t-10300` against checkout dc5e8bf (T-10300):
`var/wrkq-artifacts/T-10300/02-install-build/drive.txt`.
