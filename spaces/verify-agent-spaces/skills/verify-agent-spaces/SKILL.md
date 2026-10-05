---
name: verify-agent-spaces
description: Launch, check, drive and prove any agent-spaces feature (target composition, install and materialization, asp run and agent launch, agent introspection, doctor and hygiene, the aspd compile service, releases and publish, the harness broker, the Codex overlay) against the installed surface, with evidence that survives. Use when changing, operating, debugging or grading agent-spaces, or before claiming an agent-spaces change works.
---

# verify-agent-spaces

An agent-spaces claim is proven by driving the installed surface and keeping the evidence. This skill gives
the one way to do that. `features/README.md` maps the nine features; each feature file tells you how to reach
the feature, drive it, what bites, and what "proven" looks like: [composition](features/01-composition.md),
[install and build](features/02-install-build.md), [run and launch](features/03-run-launch.md),
[agent introspection](features/04-agent-introspection.md), [doctor and hygiene](features/05-doctor-hygiene.md),
[aspd](features/06-aspd.md), [releases](features/07-releases.md), [harness broker](features/08-harness-broker.md),
[Codex overlay](features/09-codex-overlay.md).

Only the agent-spaces project composes this skill: `asp-targets.toml` in this repo merges it into clod, cody
and the agent-spaces resident when they run in project agent-spaces.

## Launch

What "installed" means here differs per surface, and that decides what a drive proves:

- **`asp` runs the canonical checkout's source.** `~/.local/bin/asp` is `exec bun run
  ~/praesidium/agent-spaces/apps/cli/bin/asp.js`. Every edit in the shared checkout, committed or not, is live
  in `asp` the moment it is saved. `avs doctor`'s `asp-source` row says so.
- **`harness-broker` also runs the checkout.** `~/.bun/bin/harness-broker` links through
  `~/.bun/install/global/node_modules/spaces-harness-broker` to `harness/harness-broker` in the checkout, and
  its bin prefers `src/` (a stack trace from it names `agent-spaces/harness/harness-broker/src/…`). `aspc` is
  linked the same way.
- **`aspd` runs an immutable release.** The system namespace `~/praesidium/var/aspd` serves one release under
  `releases/<releaseId>` built from a commit (`serving.release.sourceCommit`). It moves only when someone runs
  `just install` in the canonical checkout (any seat may; Lance ruling 2026-10-01). Standalone `aspd-activate`
  and `aspd-restart` on the system namespace stay with Mable primary.

Scratch or live:

- **Scratch (the default for anything that writes).** `avs scratch up --name <task>` makes
  `~/praesidium/var/state/avs/<name>/` with a `project/` (an `asp-targets.toml` with targets `demo` and
  `local-only`, and a project space `avs-demo` holding the `avs-probe` skill) and an empty `asp-home/`. Point
  every `asp` call at it with `cd <project>` and `ASP_HOME=<asp_home>` (`eval "$(avs env <name> --sh)"` exports
  `ASP_HOME` and `AVS_PROJECT`). Isolated aspd namespaces, scratch Codex homes, release builds and a scratch clone
  all live under the same root, so `avs scratch down` removes them together.
- **Scratch clone.** Anything that needs a clean tree (`just build-asp-release`) runs in
  `git clone ~/praesidium/agent-spaces <root>/clone`, then `bun install` and `bun run build` there (about 20 s). Never in the shared checkout.
- **Live (read-only).** The system aspd (`just aspd-status ~/praesidium/var/aspd`, `avs aspc
  ~/praesidium/var/aspd/run/aspd.sock <read method>`), `asp self` from inside a seat, `asp explain`/`lint` on
  the canonical project, `asp token-rent`, and the HRC state DB opened `-readonly`. Never `aspd-activate`,
  `aspd-restart`, `aspd-stop` or `supervise` the system namespace, and never run the overlay against `~/.codex`
  unless your task says so.

## Doctor

Always start with `avs doctor` (read-only; it starts nothing). It prints `{verdict, rows}`: `asp` (version),
`asp-source` (whether `asp` runs the canonical checkout), `checkout` (HEAD and dirty-path count), `harnesses`
(`asp harnesses --json`), `aspd` (the system namespace's serving release, `runningEqualsSelected`, and the
checkout HEAD when they differ), and `harness-broker` (a stdio `broker.hello`). Each row that isn't ok carries
the `next` command. Run it again after anything surprising. `asp doctor` (feature 5) is the product's own check
and runs per project and `ASP_HOME`.

```bash
~/praesidium/agent-spaces/spaces/verify-agent-spaces/skills/verify-agent-spaces/avs doctor
```

An aspd source commit behind checkout HEAD is normal: the release moves only on `just install`.

## Drive

1. Find the feature in [features/README.md](features/README.md) and read its file.
2. Doctor.
3. Drive it as the file's "Driving it" shows, capturing each command with `avs rec
   <artifact_dir>/NN-<feature>/drive.txt -- '<command>'` as you go ("Evidence" below).
4. Check the file's "Proven when" against what you captured.
5. If the drive disagreed with the file, fix the file (Gotchas, with date and evidence) in the same change.

`asp --help`, `asp <verb> --help`, `harness-broker` (no args) and `just --list` give the live verbs.

**`just` posts facts.** In a registered project root, `just` is wrapped by wrkp: every recipe posts a
`run.settled` fact (`recipe`, `status`, `duration_ms`) to the project, which fitkit reads as `check.run`. A
deliberately failing recipe (a refusal probe) posts a failed `check.run` for that recipe. Run refusal probes
through the script the recipe wraps (`bun scripts/aspd-service.ts …`, `bun scripts/asp-release.ts …`) or in the
scratch clone, which is not a registered root.

## Evidence

- **The installed surface, not a unit test.** A claim is proven by `asp`, `harness-broker`, the aspd socket and
  the files they write, driven end to end and observed in their own outputs: the lock, the materialized bundle,
  the dry-run argv, the RPC reply, the aspd request log, the broker event types.
- **An artifact that survives,** under your task's `artifact_dir` (`~/praesidium/var/wrkq-artifacts/<task>/`),
  in one layout:
  - `NN-<feature>/drive.txt` per feature, written by `avs rec`: each command after a `## <UTC time>` line and
    `$ <command>`, then its output and `[exit N]`, so the file reruns as written. Put pipes inside the recorded
    command only when the last stage keeps the exit code you are proving; otherwise record the bare command;
  - input files a drive writes for itself (an evaluation-context JSON and a request JSON for feature 4; you pick
    the filenames, written here as `$CTX` and `$REQ`) next to the drive.txt that uses them;
  - `live/` for read-only reads of the system aspd and other shared state (`live/doctor.txt`).

  Never put evidence inside the scratch root, which `avs scratch down` removes.
- **Repeatable.** Someone else can rerun `<artifact_dir>/NN-<feature>/drive.txt` on a fresh `avs scratch up` and
  see the same end state.
- **Reproduce before you fix.** For a defect, capture the failing drive first. If you can't reproduce it, say so
  and show what you ran.
- **Name what you couldn't drive,** and the concrete prerequisite that stopped you (a model login, an operator
  restart, a clean tree).
- **Prove an absence with a count:** `grep -c`, a JSON length, or `git status --porcelain | wc -l`, not "nothing
  printed".

## Cleanup

`avs scratch down <name>` removes `~/praesidium/var/state/avs/<name>` (project, ASP_HOME, aspd namespace, clone,
Codex home). Built and installed releases are read-only, so `down` makes the tree writable before it removes
it; a bare `rm -rf` of a scratch with a release in it fails `Permission denied`. Stop a scratch aspd first (`just aspd-stop <root>/aspd-ns`), or its process outlives the directory.
`avs scratch down <name> --dry-run` shows the path first; `avs scratch list` shows what exists. The evidence under
`artifact_dir` stays. Kill any ghostmux surface you opened (`ghostmux kill-surface -t <id>`).

## Maintain

The upkeep pass keeps this skill true: index hygiene, one source read per feature, a scratch drive of every
feature, triage (doc drift, harness gap, product gap), at most one commit, and a `verify.upkeep` fact at the end.
The procedure is [MAINTAIN.md](MAINTAIN.md).

## Helpers

`avs` (this directory, executable) is the one helper. Every verb but `rec` prints one JSON object. A refusal
prints `{error, message, next}` and exits 1.

| Verb | Invocation | Does |
| --- | --- | --- |
| `doctor` | `avs doctor` | Read-only rows: asp, asp-source, checkout, harnesses, system aspd (`AVS_ASPD_NS` overrides), harness-broker |
| `scratch up` | `avs scratch up [--name N]` | Writes the scratch project (targets `demo`, `local-only`; space `avs-demo` with skill `avs-probe`) and an empty ASP_HOME under `$AVS_ROOT/N` (default `~/praesidium/var/state/avs`), prints root, project, asp_home |
| `scratch down` | `avs scratch down N [--dry-run]` | Removes that scratch root |
| `scratch list` | `avs scratch list` | The scratch roots that exist |
| `env` | `avs env N [--sh]` | The scratch's paths as JSON, or `export ASP_HOME=… AVS_PROJECT=…` lines |
| `rec` | `avs rec FILE -- 'CMD'` | Runs CMD under bash, appends `## <UTC>`, `$ CMD`, output and `[exit N]` to FILE, and echoes them |
| `aspc` | `avs aspc SOCKET METHOD ['<json>']` | One NDJSON JSON-RPC call to an aspd socket; `aspc.hello` params are filled in |
| `broker-hello` | `avs broker-hello` | Spawns `harness-broker run --transport stdio`, sends `broker.hello`, prints the reply |

Product verbs the features drive: `asp` (`run`, `init`, `install`, `build`, `describe`, `explain`, `lint`,
`list`, `path`, `doctor`, `gc`, `gui`, `add`, `remove`, `upgrade`, `diff`, `harnesses`, `resolve-reminder`,
`self`, `repo`, `spaces`, `resources`, `agent`, `agents`, `token-rent`), `harness-broker` (`run`, `capture`,
`submission`), `aspc` (`manifest`, `verify-release`), and the `just` recipes `aspd-*`, `*-asp-release`,
`publish-*`, `install`, `overlay-codex`, `smoke:matrix` (a `bun run` script).
