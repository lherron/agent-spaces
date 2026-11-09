# 2. Install and materialization

`asp install` resolves every target in `asp-targets.toml`, writes `asp-lock.json` beside it, and materializes one
bundle per target and harness under `ASP_HOME/codex-homes/<projectId>_<target>/bundles/.versions/<hash>/<target>/
<harness>/`. The other verbs edit the targets file or the lock and reinstall. Code: `apps/cli/src/commands/{install,
build,gc,init,add,remove,upgrade}.ts`, materialization in `core/config/src/orchestration/{install,materialize-target,
plugin-artifacts,build}.ts` and `core/config/src/materializer/`, harness layouts in `drivers/harness-*`. Doc:
`docs/materialization-install-flow.md`.

## Sub-features

- `asp install [--targets …] [--harness h] [--update] [--refresh] [--no-fetch]`: lock plus bundles; prints per-target plugin
  count and the run line. The default harness is `agent-harness` (pi layout: `<bundle>/pi/skills/…`); `--harness
  claude` lays out `<bundle>/claude/plugins/NNN-<space>/…` plus `settings.json`, which always carries
  `idleCompaction: false`, `skipDangerousModePermissionPrompt: true`, `promptSuggestionEnabled: false`,
  `awaySummaryEnabled: false`, `tui: "fullscreen"`, `askUserQuestionTimeout: "60s"` and a `statusLine`. A space whose
  `[harness] supports` omits the harness is skipped silently (`defaults` supports claude and agent-harness only, so
  a codex or muse bundle of `demo` holds `avs-probe` alone). Each bundle's `.asp-materialized.json` names the
  `materializerVersion` (`target-materializer-v8-claude-no-suggestions-recap` on 2026-10-29); a version bump
  rematerializes every bundle once. Install prunes old bundle versions itself (keeps 3, 15 min).
- `--harness` accepts six ids (`--help` still lists four): `claude-hrcpty` and `codex-hrcpty` lay out
  `<bundle>/<target>/claude-hrcpty|codex-hrcpty/` with the base adapter's content, but the `[harness] supports`
  filter is an exact match (`plugin-artifacts.ts:149-155`) and no space lists an hrcpty id, so every
  `supports`-declaring space is dropped: the scratch `demo` claude-hrcpty bundle holds `000-avs-demo` only, against
  `000-avs-demo 001-defaults` for claude (product gap T-12329). HRC compiles materialize hrcpty seats as `claude`/`codex`
  (live clod and smokey bundles), so this hits only the direct CLI (2026-11-02, `T-12323/02-install-build/drive.txt`).
- Plain `install` reuses the existing lock's selector graph (T-11963); only `asp upgrade` (`--update` without ids)
  re-resolves. It validates the lock first: a reordered `loadOrder` refuses `Inconsistent lock load order for target
  demo; run a full update`, exit 1. A partial install (`--targets`, add, remove, run) that would change a shared space
  refuses `Partial install changes shared space …`.
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
`--no-fetch`), `upgrade`, and the reinstall of `add`/`remove` run `git fetch origin --all` in the shared spaces root
`~/praesidium/var/agents` (`core/config/src/orchestration/install.ts:150-156`; `add.ts:98`, `remove.ts:99` and
`upgrade` have no `--no-fetch`). Use `install --no-fetch`, `add`/`remove --no-install` followed by `install
--no-fetch`, and `ASP_AGENTS_ROOT=<root>/agents-clone asp upgrade` with `git clone ~/praesidium/var/agents
<root>/agents-clone` (the fetch then lands in the clone). Other seats fetch the shared root on their own (09:33Z and
09:45Z on 2026-11-02), so prove "my drive didn't fetch" with readings that bracket each leg
(`T-12323/live/fetch-head.txt`).

## Driving it

```bash
cd $AVS_PROJECT
asp install --no-fetch                        # 2 targets; lock written
grep -rl AVS-PROBE-MARKER $ASP_HOME           # pi/skills/avs-probe/SKILL.md per target
asp install --no-fetch --harness claude       # demo: 2 plugins; local-only: 1 plugin
asp install --no-fetch --harness claude-hrcpty   # demo: 000-avs-demo only (T-12329)
asp build local-only --harness claude --output <root>/build-out
asp gc --dry-run
asp add space:project:avs-extra --target local-only --no-install   # space missing: exit 1, asp-targets.toml unchanged
asp add 'not a ref!!' --target local-only                   # Invalid space reference, exit 2, unchanged (shasum)
mkdir -p spaces/avs-extra && printf '…space.toml…'          # create it, add again: added, reinstalls
asp remove nope --target local-only                         # "not found in target", exit 1
asp add space:project:avs-extra --target local-only        # again: already in target, exit 0
asp remove avs-extra --target local-only                    # bare id matches space:project:avs-extra; reinstalls
asp add space:project:avs-extra --target local-only --no-install   # edits the file only
python3 -c "import json;print(sorted(json.load(open('asp-lock.json'))['targets']))"   # still ['demo', 'local-only']
ASP_AGENTS_ROOT=<root>/agents-clone asp upgrade             # Targets updated: demo, local-only (fetches the clone)
mkdir <root>/init-probe && cd <root>/init-probe && asp init && cat asp-targets.toml   # next steps: asp run dev
```

## Gotchas

- The install summary for agent-harness says `0 plugins` and prints flags without values (`--extension`,
  `--skill`, `--session-id`); the bundle still holds the skills and `asp run --dry-run` prints the full argv.
- **`asp gc` never loads the lock** (product gap T-11376): `gc.ts:42` passes the project directory to
  `readLockJson`, which fails `EISDIR` and is swallowed, so every snapshot and cache entry counts as unreferenced.
  `Cache entries removed: 1` after a `build --output` is that bug; with the lock loaded the count is 0
  (`T-11375/02-install-build/gc-lock-probe.ts` and drive.txt; again 2026-11-02, `T-12323/02-install-build/drive.txt`).
  Only ever run `asp gc --dry-run`, never a bare `asp gc` on a shared ASP_HOME, until T-11376 lands.
- **`asp build` writes empty plugins for project spaces** (product gap T-11377): it reads them from store snapshots
  that install never makes, so the cache dir holds only `.asp-cache.json` and `.claude-plugin/plugin.json`, and
  `--output/settings.json` is `{}`. `@dev` spaces build complete. Check plugin content, not that the file exists
  (2026-10-19, `T-11375/02-install-build/drive.txt`; unchanged 2026-11-02).
- The project id in bundle paths and `ASP_PROJECT` is the project directory's basename (`project` on a scratch).

## Proven when

`asp install` writes a lock naming both targets and the probe skill appears in each harness layout; the claude
`settings.json` has `idleCompaction: false`; `build --output` writes `settings.json` (and, until T-11377, empty
project-space plugins); `gc --dry-run` deletes nothing; `upgrade` updates both targets; the add/remove legs keep
the other target locked, leave the file unchanged on failure and keep its comments.

Driven 2026-11-09 on scratch `t-12763` against checkout 93d96239 (T-12763):
`var/wrkq-artifacts/T-12763/02-install-build/drive.txt` (T-11376, T-11377 and T-12329 reproduce; shared-root
`FETCH_HEAD` mtime unchanged across the drive). Source only: the `add`/`remove` reinstall fetch (driven with
`--no-install` to keep the shared root unwritten) and the bundle prune constants (`store/gc.ts:18-19`: keep 3, 15 min).
