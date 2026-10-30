# 2. Install and materialization

`asp install` resolves every target in `asp-targets.toml`, writes `asp-lock.json` beside it, and materializes one
bundle per target and harness under `ASP_HOME/codex-homes/<projectId>_<target>/bundles/.versions/<hash>/<target>/
<harness>/`. The other verbs edit the targets file or the lock and reinstall. Code: `apps/cli/src/commands/{install,
build,gc,init,add,remove,upgrade}.ts`, materialization in `core/config/src/orchestration/{install,materialize-target,
plugin-artifacts,build}.ts` and `core/config/src/materializer/`, harness layouts in `drivers/harness-*`. Doc:
`docs/materialization-install-flow.md`.

## Sub-features

- `asp install [--targets …] [--harness h] [--update] [--refresh]`: lock plus bundles; prints per-target plugin
  count and the run line. The default harness is `agent-harness` (pi layout: `<bundle>/pi/skills/…`); `--harness
  claude` lays out `<bundle>/claude/plugins/NNN-<space>/…` plus `settings.json`, which always carries
  `idleCompaction: false`, `skipDangerousModePermissionPrompt: true`, `tui: "fullscreen"`, `askUserQuestionTimeout: "60s"` and a `statusLine`. A space whose
  `[harness] supports` omits the harness is skipped silently (`defaults` supports claude and agent-harness only, so
  a codex or muse bundle of `demo` holds `avs-probe` alone). Each bundle's `.asp-materialized.json` names the
  `materializerVersion` (`target-materializer-v7-claude-skip-bypass-consent` on 2026-10-30); a version bump
  rematerializes every bundle once. Install prunes old bundle versions itself (keeps 3, 15 min).
- `asp build [target] --harness h --output <dir>`: materializes without launching; plugin dirs live in
  `ASP_HOME/cache/<hash>`, `--output` gets `settings.json`.
- `asp gc [--dry-run]`: unreferenced snapshots, cache entries and bundle versions.
- `asp init [-t name] [--force]`: a new `asp-targets.toml` with one target composing `space:defaults@dev`.
- `asp add <ref> --target t [--no-install]` / `asp remove <id> --target t [--no-install]`: edit only the target's
  compose list (comments kept), then install that target; other targets keep their lock entries. `add` validates
  and resolves the ref before writing: a malformed ref refuses `Invalid space reference` (exit 2), a missing space
  `Space manifest not found` (exit 1), file unchanged either way; an exact duplicate prints `already in target`,
  exit 0. `remove` matches the exact ref or a bare id against any ref form and removes every match; no match is
  `not found in target`, exit 1; removing the last space refuses `Cannot remove last space from target`, exit 1.
  An unknown target is exit 2 from `add` and exit 1 from `remove`. Both reinstall with the default harness only.
- `asp upgrade [spaceIds…] [--target t]`: re-resolve selectors and rewrite the lock (all targets and spaces by
  default).

## How to get to it

`avs scratch up --name <task>`, then from `<project>` with `ASP_HOME=<asp_home>` (and the scratch
`ASP_USAGE_METRICS_VAR_ROOT` that `avs env` exports). Nothing here touches the canonical project or the shared
ASP_HOME (`~/praesidium/var/spaces-repo`) as long as `ASP_HOME` is set, with one exception: `install` (without
`--no-fetch`) and `upgrade` run `git fetch origin --all` in the shared spaces root `~/praesidium/var/agents`
(`install.ts:147-166,278`); its `.git/FETCH_HEAD` moved under `asp upgrade` and plain `asp install`, not under
`asp install --no-fetch` (2026-10-26, `T-11875/02-install-build/drive.txt`). Use `--no-fetch` when the drive
doesn't need fresh remote refs.

## Driving it

```bash
cd $AVS_PROJECT
asp install                                   # 2 targets; lock written
grep -rl AVS-PROBE-MARKER $ASP_HOME           # pi/skills/avs-probe/SKILL.md per target
asp install --harness claude                  # demo: 2 plugins; local-only: 1 plugin
asp build local-only --harness claude --output <root>/build-out
asp gc --dry-run
asp add space:project:avs-extra --target local-only        # space missing: exit 1, asp-targets.toml unchanged
asp add 'not a ref!!' --target local-only                   # Invalid space reference, exit 2, unchanged (shasum)
mkdir -p spaces/avs-extra && printf '…space.toml…'          # create it, add again: added, reinstalls
asp remove nope --target local-only                         # "not found in target", exit 1
asp add space:project:avs-extra --target local-only        # again: already in target, exit 0
asp remove avs-extra --target local-only                    # bare id matches space:project:avs-extra; reinstalls
asp add space:project:avs-extra --target local-only --no-install   # edits the file only
python3 -c "import json;print(sorted(json.load(open('asp-lock.json'))['targets']))"   # still ['demo', 'local-only']
asp upgrade                                                 # Targets updated: demo, local-only
mkdir <root>/init-probe && cd <root>/init-probe && asp init && cat asp-targets.toml   # next steps: asp run dev
```

## Gotchas

- The install summary for agent-harness says `0 plugins` and prints flags without values (`--extension`,
  `--skill`, `--session-id`); the bundle still holds the skills and `asp run --dry-run` prints the full argv.
- **`asp gc` never loads the lock** (product gap T-11376): `gc.ts:42` passes the project directory to
  `readLockJson`, which fails `EISDIR` and is swallowed, so every snapshot and cache entry counts as unreferenced.
  `Cache entries removed: 1` after a `build --output` is that bug; with the lock loaded the count is 0
  (`T-11375/02-install-build/gc-lock-probe.ts` and drive.txt). Only ever run `asp gc --dry-run`, never a bare `asp
  gc` on a shared ASP_HOME, until T-11376 lands.
- **`asp build` writes empty plugins for project spaces** (product gap T-11377): it reads them from store snapshots
  that install never makes, so the cache dir holds only `.asp-cache.json` and `.claude-plugin/plugin.json`, and
  `--output/settings.json` is `{}`. `@dev` spaces build complete. Check plugin content, not that the file exists
  (2026-10-19, `T-11375/02-install-build/drive.txt`).
- The project id in bundle paths and `ASP_PROJECT` is the project directory's basename (`project` on a scratch).

## Proven when

`asp install` writes a lock naming both targets and the probe skill appears in each harness layout; the claude
`settings.json` has `idleCompaction: false`; `build --output` writes `settings.json` (and, until T-11377, empty
project-space plugins); `gc --dry-run` deletes nothing; `upgrade` updates both targets; the add/remove legs keep
the other target locked, leave the file unchanged on failure and keep its comments.

Driven 2026-10-26 on scratch `t-11875` against checkout b32c6e05 (T-11875):
`var/wrkq-artifacts/T-11875/02-install-build/drive.txt`.
