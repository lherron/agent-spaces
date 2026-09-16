# Standalone ASP releases

ASP can stage its existing preparation facade and harness broker as one immutable,
explicitly selected artifact. This release path is intentionally separate from
`just install`: it does not publish packages, link global commands, select a
current release, synchronize a consumer, or touch HRC/ACP.

```bash
just build-asp-release output_root=/absolute/build-root
just install-asp-release /absolute/build-root/<release-id> /absolute/install-root
just inspect-asp-release /absolute/install-root/<release-id>
```

The release root contains `aspc-facade`, `harness-broker`, `release.json`, and
the Bun-compiled payloads under `libexec/`. The launchers export the selected
release identity and source commit, then execute only the sibling payload. Use
`<release>/aspc-facade --release-info` or
`<release>/harness-broker --release-info` to read the identity bound to either
executable.

Builds require a clean checkout so `sourceCommit` names the exact input. The
builder installs no dependencies and the compiled payloads embed their runtime
module closure. The inspector rejects symlinks, writable content, digest drift,
path escape, or a directory name that does not match `releaseId`.

Installation is staging only. Consumers must select the absolute release path
explicitly; there is no `current` link or activation/rollback protocol in this
step. Native harness binaries, authentication, mutable ASP configuration, and
per-run state remain intentional external inputs.
