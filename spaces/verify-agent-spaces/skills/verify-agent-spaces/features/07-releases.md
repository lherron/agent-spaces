# 7. Releases and publish

Two delivery paths leave this repo. An **ASP release** is an immutable, bun-compiled directory (`aspd`, `aspc-facade`,
`harness-broker`, `agent-harness`, `libexec/`, `assets/`, `release.json`) that aspd serves. The **published package
set** is one timestamped version of every ASP package pushed to the Verdaccio at `http://mini:4873/`, which
hrc-runtime follows. `just install` on the canonical checkout does both and activates the system aspd. Code:
`scripts/asp-release.ts` (build, install, inspect), `scripts/publish-local-verdaccio.ts`,
`scripts/lib/asp-publish/pack.ts`, the `install` recipe in `justfile`. Docs: `docs/standalone-asp-releases.md`,
`AGENTS.md` "Install and Publish Contract".

## Sub-features

- `just build-asp-release [output_root]`: refuses a dirty checkout; prints the release's inspection
  (`releaseId` `asp-<sha12>-<UTC stamp>-<rand>`, `sourceCommit`, `executableResolution`, `workerBindings`,
  `assetResolution`, `runtimeClosure: bun-compiled`, `mutableCheckoutReferences: false`). The root defaults to
  `$ASP_RELEASE_BUILD_ROOT` or `~/.local/state/praesidium/asp-release-builds`; a relative root refuses `output root
  must be absolute`, exit 1, before the clean check.
- `just inspect-asp-release <release>`: identity, immutability, digests and in-artifact executable resolution.
- `just install-asp-release <artifact> [release_root]`: copy into a release root; never selects (feature 6
  activates). Installing the same release again is a no-op that returns the existing inspection.
- `just publish-dev-dry-run` (`publish-local-verdaccio.ts --dry-run`): a `NON_CANONICAL publication channel=dev …`
  line, then either `SKIPPED 22 ASP package(s): active tag latest already contains a coherent unchanged ASP
  publish set` with no `DRY_RUN` lines (2026-10-19) or `PUBLISHING full ASP wave: …` and one `DRY_RUN
  <pkg>@<version> --tag latest` per package (22 on 2026-10-05). `publish-canonical-dry-run` prints 22 `DRY_RUN`
  lines and no wave, SKIPPED or NON_CANONICAL line; it runs `git fetch --prune origin` first and refuses a dirty
  tree (`Canonical publication requires a clean source tree`) or a HEAD not on `origin/main`.
  `publish-semver-dry-run <version> <tag>` adds `@lherron/agent-spaces` (apps/cli): 23 packages, no wave line.
  `publish-worktree-dry-run` likewise (not driven). A dry run needs Verdaccio reachable (`npm ping`). The real
  publishes (`publish-dev`, `publish-canonical`, `publish-worktree`, `publish-semver`) are operator-only, never
  part of a drive.
- `bun run check:packs`: packs the 15 boundary packages through the publisher's staged copy and prints `PASS
  <pkg>` (stops at the first `FAIL`); no registry, never writes the checkout.
- `just install [no-sync=1] [force-sync=1] [force-link=1]`: depends on `check-manager-space`, then clean, `bun
  install`, `workspace-doctor`, build, `bun link` of six packages (apps/cli, harness-broker, harness-broker-pi-sdk,
  agent-harness, aspc, aspc-facade), `publish-canonical` (`publish-worktree` in a linked worktree), hrc-runtime
  `pull-deps` and build, then build, install and `aspd-activate` a system aspd release and verify its source
  commit. Operator-scale; not part of a verification drive unless the task says so.

## How to get to it

Release builds run in a scratch clone: `git clone ~/praesidium/agent-spaces <scratch>/clone && cd
<scratch>/clone && bun install && bun run build` (about 50 s). Publish dry-runs pack each package from a staged copy
under `$TMPDIR` and leave the worktree clean; run them in the clone too, since the canonical dry-run fetches into
`.git` (in a clone, `origin` is the local checkout). Inspect and install use an existing release, e.g. the system
one under `~/praesidium/var/aspd/releases/`, into a scratch release root.

## Driving it

```bash
cd <scratch>/clone && touch avs-dirty && bun scripts/asp-release.ts build --output-root <scratch>/refuse; rm avs-dirty  # refuses, exit 1
bun scripts/asp-release.ts build --output-root rel                            # output root must be absolute, exit 1
just inspect-asp-release ~/praesidium/var/aspd/releases/<releaseId>
just install-asp-release ~/praesidium/var/aspd/releases/<releaseId> <scratch>/aspd-ns/releases   # twice: no-op
cd <scratch>/clone && git status --porcelain --untracked-files=all | wc -l      # 0
just build-asp-release <scratch>/release-build                                # ok, sourceCommit = clone HEAD
just publish-dev-dry-run; git status --porcelain | wc -l                      # SKIPPED 22 or 22 DRY_RUN lines; 0
just publish-canonical-dry-run | grep -c '^DRY_RUN'                            # 22
touch zz && bun scripts/publish-local-verdaccio.ts --channel canonical --dry-run; rm zz   # clean source tree refusal, exit 1
bun scripts/publish-local-verdaccio.ts --dry-run --version 0.0.0-avs.1 --tag avs | grep -c '^DRY_RUN'   # 23
bun run check:packs | grep -c '^PASS'                                          # 15
```

## Gotchas

- `build-asp-release` refuses `source checkout must be clean` when any path is dirty or untracked, including other
  seats' work. Build from a scratch clone, and run the refusal probe there with a planted untracked file: when the
  shared checkout is clean (as on 2026-10-19), `bun scripts/asp-release.ts build` there builds a real release
  instead of refusing. Through `just` in the canonical root a refusal posts a failed `run.settled` for recipe
  `build-asp-release` (`T-10300/07-releases/drive.txt` shows the fact it posted). The output root is created even
  on refusal.
- The publish version stamp is local wall-clock time (`0.1.1-dev.20261005150449` at 20:04 UTC), unlike the
  release id's UTC stamp.
- In the scratch clone `just` prints `wrkp just: … is not a registered project root; skipping`: no fact is posted
  there.
- `inspect-asp-release` reports `aspc-facade` with `embeddedIdentity: false`; the other three executables carry an
  embedded identity.

## Proven when

The dirty-tree and relative-root refusals exit 1 with their messages; inspect and install print `ok: true` with
matching `releaseId` and `sourceCommit` and every executable resolved inside the release, and a second install is a
no-op; the clone build prints a release whose `sourceCommit` is the clone's HEAD; the dev dry-run skips or lists
every package, the canonical one lists 22 and refuses a dirty tree, semver lists 23, `check:packs` passes 15, and
the clone stays clean.

Driven 2026-10-19 against checkout f8c96a5e, scratch clone of f8c96a5e, system release
asp-25445c159b76-20261017T140543Z-7cb338 (T-11375): `var/wrkq-artifacts/T-11375/07-releases/drive.txt`. Not driven:
`just install` (operator-scale; publishes, syncs hrc-runtime and activates the system aspd),
`publish-worktree-dry-run`, the canonical refusal of a HEAD not on `origin/main`, and any non-dry-run publish.
