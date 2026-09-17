# Standalone ASP releases

ASP can stage its existing preparation facade and harness broker as one immutable,
explicitly selected artifact. This release path is intentionally separate from
`just install`: it does not publish packages, link global commands, select a
current release, synchronize a consumer, or touch HRC/ACP.

```bash
just build-asp-release /absolute/build-root
just install-asp-release /absolute/build-root/<release-id> /absolute/install-root
just inspect-asp-release /absolute/install-root/<release-id>
```

The release root contains `aspc-facade`, `aspd`, `harness-broker`,
`release.json`, immutable assets, and the Bun-compiled payloads under
`libexec/`. The launchers export the selected release identity and source
commit, then execute only the sibling payload. Every identity-bound launcher
supports `--release-info`; the worker also supports `drivers --json`.

Builds require a clean checkout so `sourceCommit` names the exact input. The
builder installs no dependencies and the compiled payloads embed their runtime
module closure. `release.json` binds supported broker drivers to workers and
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
