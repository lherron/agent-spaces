# agent-spaces feature map

One file per feature. Each has the same sections: Sub-features, How to get to it, Driving it, Gotchas and
Proven when. The last line of each file names the drive that last proved it and where its evidence is.

| # | Feature | File | Drive on |
| --- | --- | --- | --- |
| 1 | Target composition and inspection (`asp-targets.toml`, `lint`, `explain`, `describe`, `list`, `path`, `diff`, the retired `repo`/`spaces` registry verbs) | [01-composition.md](01-composition.md) | scratch project; read-only on the canonical project |
| 2 | Install and materialization (`install`, `build`, `gc`, `init`, `add`, `remove`, `upgrade`, the lock and the bundle under ASP_HOME) | [02-install-build.md](02-install-build.md) | scratch project |
| 3 | Run and launch (`asp run` per harness, `asp agent`, `asp gui`, `--dry-run`/`--print-command`) | [03-run-launch.md](03-run-launch.md) | scratch ASP_HOME; dry-run only |
| 4 | Agent introspection (`asp self`, `resolve-reminder`, `agents catalog`/`inspect`, `resources plan`) | [04-agent-introspection.md](04-agent-introspection.md) | live seat, read-only |
| 5 | Doctor and hygiene (`asp doctor`, `harnesses`, `lint --hygiene`, `token-rent`) | [05-doctor-hygiene.md](05-doctor-hygiene.md) | scratch; read-only HRC DB |
| 6 | The aspd compile service (system namespace status and RPC, an isolated namespace's init/activate/stop, the request log) | [06-aspd.md](06-aspd.md) | scratch namespace; read-only on the system namespace |
| 7 | Releases and publish (`build-asp-release`, `inspect-asp-release`, `install-asp-release`, `publish-*-dry-run`, `just install`) | [07-releases.md](07-releases.md) | scratch clone and scratch release root |
| 8 | The harness broker (`harness-broker run` over stdio, `broker.hello`, `capture`, the pre-HRC matrix) | [08-harness-broker.md](08-harness-broker.md) | stdio broker; shim rows of the matrix |
| 9 | The Codex overlay (`sync-agent-to-codex-default`, `just overlay-codex`) | [09-codex-overlay.md](09-codex-overlay.md) | scratch Codex home |

## Keeping the map honest

- Change a feature, change its file in the same commit. A file with no drive behind it is a draft: say so at its
  end.
- When a drive turns up something the file doesn't say, add it to Gotchas with the date and the evidence path.
  When a Gotcha stops being true, delete it, or say which commit ended it.
- Re-drive a feature after any change to its code. Put the evidence under your task's `artifact_dir` in
  SKILL.md's "Evidence" layout (`NN-<feature>/drive.txt`), and update the file's last line.
- The docs (`docs/cli-reference.md`, `docs/aspd.md`, `docs/materialization-install-flow.md`) and the
  architecture records say what was specified. These files say what the installed surface does and how to
  watch it do it.
