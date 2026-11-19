# Standalone ASP releases

ASP can stage its existing preparation facade and harness broker as one immutable,
explicitly selected artifact. The explicit staging recipes below do not publish
packages, link global commands, select a current release, synchronize a
consumer, or touch HRC/ACP. Canonical `just install` also builds and activates
an immutable release when the system aspd namespace is configured; see
[aspd](aspd.md) and
[canonical install and package publication](#canonical-install-and-package-publication)
for that integrated path.

```bash
just build-asp-release /absolute/build-root
just install-asp-release "/absolute/build-root/<release-id>" /absolute/install-root
just inspect-asp-release "/absolute/install-root/<release-id>"
```

The release root contains `aspc-facade`, `aspd`, `raspd`, `harness-broker`,
`agent-harness`, `release.json`, immutable assets, and payloads under
`libexec/`. `raspd` is Cargo-native; the other payloads are Bun-compiled.
The launchers export the selected release identity and source
commit, then execute only the sibling payload. Every identity-bound launcher
supports `--release-info`; the worker also supports `drivers --json`.

Builds require a clean checkout so `sourceCommit` names the exact input. The
builder does not install Bun dependencies; prepare those before building.
After a successful build and inspection, the builder prunes its output root,
keeping the newest five releases, the build just completed, and any older release
named in a running process's command line. This reuses aspd activation's reference
scan, covering both the configured root and its real path. A failed reference or
directory scan skips pruning. Hidden in-progress staging directories are untouched.
Retention results or scan errors go to stderr; stdout remains the release inspection.
The native `raspd` build requires Cargo and its locked dependencies.
On Apple silicon, an available `rbuild` sends the native build to build1 and pulls
the macOS binary back; it falls back locally when build1 is unavailable. Without
`rbuild`, or on other platforms, the native build runs locally.
Bun-compiled payloads embed their runtime module closure. `release.json` binds supported broker drivers to workers and
records the Claude statusline asset digest. The inspector rejects symlinks,
writable content, executable/asset digest drift, path escape, identity mismatch,
bindings to non-identity-bound or missing executables, and bindings absent from
the selected worker's compiled `drivers --json` inventory. Historical v1
releases may omit the additive binding/asset metadata and retain their compiled
semantics.

Installation is staging only. Consumers must select the absolute release path
explicitly; there is no `current` link or activation/rollback protocol in this
step. Native harness binaries, authentication, mutable ASP configuration, and
per-run state remain intentional external inputs.

The real broker matrix can select one release without changing shared links:

```bash
ASP_MATRIX_ASPC_FACADE_BIN=/absolute/release/aspc-facade \
ASP_MATRIX_HARNESS_BROKER_BIN=/absolute/release/harness-broker \
bun run smoke:matrix:aspc --config real-codex --keep-artifacts
```

Codex, Claude, and Pi TUI preparations select `harness-broker`; matrix/evidence
reports record the selected executable and `hostedDrivers`. Pi SDK remains
unbound pending a hermetic release compilation surface, so binding-aware aspd
refuses it before `executionRelease`. Compile RPCs run through the release
facade/aspd and command turns through the selected release worker.

## Canonical install and package publication

On the main checkout, `just install` cleans, installs, and builds; links both
the `asp` CLI and `harness-broker`; publishes one coherent timestamped ASP
package set to the producer's loopback Verdaccio; and synchronizes the one
consumer that follows `latest` — **hrc-runtime** — unless `no-sync=1` is passed.
All packages in a published ASP set must share the same version.

If the system namespace at `../var/aspd` is configured, a main-checkout
`just install` also builds and installs an immutable ASP release, activates
it through `aspd-activate` (restarting the service), and verifies that the
serving source commit matches the installed checkout. Linked worktrees never
activate the system aspd. Any seat may run this install from the main checkout,
including its aspd activation (Lance ruling 2026-10-01). Standalone
`aspd-activate` or `aspd-restart` stays with Mable primary. See the
[aspd service operations](aspd.md#current-service-operations).

Both the install sync and `just sync-downstream` use the
[HRC sync script](../scripts/sync-hrc-downstream.sh). It runs `just pull-deps` in
HRC, delivers any generated `bun.lock` commit to HRC's `origin/main`, notifies
`mable@hrc-runtime:primary` of the push, then runs `bun run build` in HRC.
It refuses dirty locks, unpublished consumer history and incomplete commits.
It does not select or publish an HRC release: the HRC owner runs `just install`,
then the canonical publisher runs `just publish`. Do not weaken it to bare
`bun run sync:asp`: without `--pull` that only reports staleness and exits 0,
silently building against a stale ASP lock (T-07727; delivery: T-11729).

**ACP is not a sync target.** agent-control-plane pins ASP and HRC as
operator-managed *producer tuples* and advances them only through its own
governed `just advance-producers` inside a coordinated deployment window. Its own
`docs/producer-advance.md` (in the agent-control-plane repo) names producer
`sync-downstream` — along with `just pull-deps`, routine `just install`,
and a moving `latest` tag — as a mechanism that must never move that tuple: a
producer's install publishes a node-local set and moves `latest`, and that side
effect is not a release signal for ACP. T-07626 deleted ACP's `sync:asp` script
and pinned exact versions in the same commit, so anything here that calls it
fails the whole install. ACP sitting behind the registry is the intended steady
state, not staleness — the `PRODUCER_PINNED` advisory lines exist so registry
movement stays visible without changing the deployed tuple.

Linked worktrees default to the isolated worktree publication channel and do
not repoint global wrappers or synchronize consumer checkouts. Use
`force-link=1` / `force-sync=1` only for an intentional cutover.

The estate has multiple registry stores, and each consumer resolves the endpoint
in its own `.npmrc`. Publish the coherent set once, then mirror those exact
immutable package tarballs into any other store that must satisfy the lock.
Running producer `just install` independently on each node creates timestamp
churn rather than deploying the same artifact.
