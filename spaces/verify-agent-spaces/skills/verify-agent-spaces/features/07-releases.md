# 7. Releases and publish

Two delivery paths leave this repo. An **ASP release** is an immutable, bun-compiled directory (`aspd`,
`aspc-facade`, `harness-broker`, `agent-harness`, `libexec/`, `assets/`, `release.json`) that aspd serves. The
**published package set** is one timestamped version of every ASP package pushed to the loopback Verdaccio, which
hrc-runtime follows. `just install` on the canonical checkout does both and activates the system aspd. Code:
`scripts/asp-release.ts` (build, install, inspect), `scripts/publish-local-verdaccio.ts`,
`scripts/lib/asp-publish/pack.ts`, the `install` recipe in `justfile`. Docs: `docs/standalone-asp-releases.md`,
`AGENTS.md` "Install and Publish Contract".

## Sub-features

- `just build-asp-release [output_root]`: refuses a dirty checkout; prints the release's inspection
  (`releaseId` `asp-<sha12>-<UTC stamp>-<rand>`, `sourceCommit`, `executableResolution`, `workerBindings`,
  `assetResolution`, `runtimeClosure: bun-compiled`, `mutableCheckoutReferences: false`).
- `just inspect-asp-release <release>`: identity, immutability, digests and in-artifact executable resolution.
- `just install-asp-release <artifact> [release_root]`: copy into a release root; never selects (feature 6
  activates).
- `just publish-dev-dry-run` (`publish-local-verdaccio.ts --dry-run`): `DRY_RUN <pkg>@<version> --tag latest`
  for each package (22 on 2026-10-05); `publish-canonical-dry-run`, `publish-worktree-dry-run`, `publish-semver-dry-run`
  likewise.
- `just install [no-sync=1] [force-sync=1] [force-link=1]`: clean, build, link `asp` and `harness-broker`,
  publish, sync hrc-runtime (commits its `bun.lock`), build and activate a system aspd release, verify its source
  commit. Operator-scale; not part of a verification drive unless the task says so.

## How to get to it

Release builds run in a scratch clone: `git clone ~/praesidium/agent-spaces <scratch>/clone && cd
<scratch>/clone && bun install && bun run build`. Publish dry-runs only read the checkout (each package is
packed from a staged copy under `$TMPDIR`), so they also run in the built shared checkout. Inspect and install
use an existing release, e.g. the system one under `~/praesidium/var/aspd/releases/`, into a scratch release root.

## Driving it

```bash
cd ~/praesidium/agent-spaces && bun scripts/asp-release.ts build --output-root <scratch>/release-build  # refuses on a dirty tree
just inspect-asp-release ~/praesidium/var/aspd/releases/<releaseId>
just install-asp-release ~/praesidium/var/aspd/releases/<releaseId> <scratch>/aspd-ns/releases
cd <scratch>/clone && git status --porcelain --untracked-files=all | wc -l      # 0
just build-asp-release <scratch>/release-build                                # ok, ~5 s
just publish-dev-dry-run; git status --porcelain | wc -l                      # 22 DRY_RUN lines; 0
```

## Gotchas

- `build-asp-release` refuses `source checkout must be clean` when any path is dirty or untracked, including other
  seats' work. Build from a scratch clone. Through `just` in the canonical root that refusal posts a failed
  `run.settled` for recipe `build-asp-release`; call `bun scripts/asp-release.ts build` for the refusal probe
  (`T-10300/07-releases/drive.txt` shows the fact it posted).
- The publish version stamp is local wall-clock time (`0.1.1-dev.20261005150449` at 20:04 UTC), unlike the
  release id's UTC stamp.
- In the scratch clone `just` prints `wrkp just: … is not a registered project root; skipping`: no fact is posted
  there.
- `inspect-asp-release` reports `aspc-facade` with `embeddedIdentity: false`; the other three executables carry an
  embedded identity.

## Proven when

The dirty-tree refusal exits 1 with its message; inspect and install print `ok: true` with matching `releaseId`
and `sourceCommit` and every executable resolved inside the release; the clone build prints a release whose
`sourceCommit` is the clone's HEAD; the publish dry-run lists every package and leaves the clone clean.

Driven 2026-10-05 against checkout dc5e8bf, scratch clone of dc5e8bf, system release asp-a17d0215a29b (T-10300):
`var/wrkq-artifacts/T-10300/07-releases/drive.txt`. Not driven: `just install` (operator-scale; publishes,
syncs hrc-runtime and activates the system aspd) and any non-dry-run publish.
