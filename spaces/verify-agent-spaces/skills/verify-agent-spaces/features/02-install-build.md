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
- `--harness` accepts seven ids (`--help` still lists four): `claude-hrcpty` and `codex-hrcpty` lay out
  `<bundle>/<target>/claude-hrcpty|codex-hrcpty/` with the base adapter's content, but the `[harness] supports`
  filter is an exact match (`plugin-artifacts.ts:149-155`) and no space lists an hrcpty id, so every
  `supports`-declaring space is dropped: the scratch `demo` claude-hrcpty bundle holds `000-avs-demo` only, against
  `000-avs-demo 001-defaults` for claude (product gap T-12329). HRC compiles materialize hrcpty seats as `claude`/`codex`
  (live clod and smokey bundles), so this hits only the direct CLI (2026-11-02, `T-12323/02-install-build/drive.txt`).
- `--harness antigravity-hrcpty` (e5b290be) is accepted but the TS compiler refuses it: `✘ unsupported_harness:
  Antigravity compilation requires raspd.`, exit 1, nothing written (2026-11-23, `T-14445/02-install-build/drive.txt`).
  Only raspd compiles Antigravity seats, into `ASP_HOME/antigravity-bundles/` and `antigravity-homes/`, not
  `codex-homes/`. raspd filters `supports` on the exact id, so neon's bundles carry neither `defaults` (supports claude,
  agent-harness) nor `prae-only` (claude, codex, agent-harness) (read-only, source note `T-14445/sources/02.md`).
- Plain `install` reuses the existing lock's selector graph (T-11963); only `asp upgrade` (`--update` without ids)
  re-resolves. It validates the lock first: a reordered `loadOrder` refuses `Inconsistent lock load order for target
  demo; run a full update`, exit 1. A partial install (`--targets`, add, remove, run) that would change a shared space
  refuses `Partial install changes shared space …`.
- `asp build [target] --harness h --output <dir>`: materializes without launching; plugin dirs live in
  `ASP_HOME/cache/<hash>`, `--output` gets `settings.json`. With no lock it installs first and warns `[W101] Lock file
  was missing and has been auto-generated`; `--no-install` refuses instead: `No lock file found. Run install first or
  set autoInstall: true`, exit 1 (2026-11-23, `T-14445/02-install-build/drive.txt`).
- `asp gc [--dry-run] [--project-only] [--scope-roots [--min-age-days N]]`: prints its root locks under `Roots:`
  (project `asp-lock.json`, `ASP_HOME/global-lock.json`), keeps snapshots and cache entries unless `--project-only`,
  prunes stale bundle versions (keep 3, 15 min: `store/gc.ts:26-27`), and with `--scope-roots` retires unused
  `codex-homes/<scope>` roots. An unreadable or unparseable lock refuses `gc refused: <kind> lock <path> exists but
  cannot be read: …`, exit 1. Per scope root the first rule that keeps it wins (`scope-root-gc.ts:197-229`):
  `kept (not-scope-root)` (name not `<project>_<agent>` or a runtime key), live reference (a running process's argv/env names a path under it; summary bucket `kept by live
  reference`), `kept (age)` (newest bundle version younger than `--min-age-days`, default 30), `kept
  (history)` (non-empty `sessions/`, 480d69ec), else `would retire` / `retired` (rename to `.retiring-*`, then rm). A
  negative `--min-age-days` refuses `must be a non-negative number`, exit 1. A root the project lock still names but no
  process uses is retired; the next `install` recreates it (2026-11-16, `T-13644/02-install-build/drive.txt`).
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
- **`asp gc` roots** (fixed T-11376): gc reads `<project>/asp-lock.json` and `ASP_HOME/global-lock.json` and prints
  both under `Roots:`. Before the fix it read the project directory, swallowed `EISDIR`, and `Cache entries removed: 1`
  after a `build --output` was that bug. It now keeps every snapshot and cache entry unless `--project-only`, so
  `Cache entries removed: 0` is expected either way on this drive. Never run a real `asp gc --scope-roots` against
  a shared ASP_HOME; that is Mable's call. Use the dry run (`T-11376/c1-*.sh`..`c5-*`).
- **`asp build` writes empty plugins for project spaces** (product gap T-11377): it reads them from store snapshots
  that install never makes, so the cache dir holds only `.asp-cache.json` and `.claude-plugin/plugin.json`, and
  `--output/settings.json` is `{}`. `@dev` spaces build complete. Check plugin content, not that the file exists
  (2026-10-19, `T-11375/02-install-build/drive.txt`; unchanged 2026-11-02).
- The project id in bundle paths and `ASP_PROJECT` is the project directory's basename (`project` on a scratch).
- **`install --asp-home` also creates `$HOME/.asp`** (product gap T-13647, same shape as doctor's T-11378): with
  `ASP_HOME` unset, bundles land in the flag dir but `cache projects repo snapshots sources tmp` appear under
  `$HOME/.asp` (`install.ts:146` calls `ensureAspHome()` with no argument). Drive with `env -u ASP_HOME HOME=<tmp>`
  (2026-11-16, `T-13644/02-install-build/drive.txt`).

## Proven when

`asp install` writes a lock naming both targets and the probe skill appears in each harness layout; the claude
`settings.json` has `idleCompaction: false`; `build --output` writes `settings.json` (and, until T-11377, empty
project-space plugins); `gc --dry-run` deletes nothing and prints both locks under `Roots:`, a broken lock refuses
it, and `--scope-roots` keeps by age, history and not-a-scope-root and retires the rest; `upgrade` updates both targets; the add/remove legs keep
the other target locked, leave the file unchanged on failure and keep its comments.

Driven 2026-11-16 on scratch `t-13644` against checkout e805b5cb (T-13644):
`var/wrkq-artifacts/T-13644/02-install-build/drive.txt` (T-11376's fix driven: roots, both refusals, every scope-root
rule, one real retire on the scratch; T-11377, T-12329 and the new T-13647 reproduce; shared-root `FETCH_HEAD` mtime
unchanged across the drive). Source only: the `add`/`remove` reinstall fetch (driven with `--no-install` to keep the
shared root unwritten), the bundle prune constants (`store/gc.ts:26-27`: keep 3, 15 min) and the `live` scope-root
rule (needs a process naming a scratch scope root).
