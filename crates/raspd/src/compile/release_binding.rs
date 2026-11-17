//! What the selected release's release.json binds a compile to: the Claude
//! statusline asset and the selected driver's worker (`executionRelease`).
use super::{Fwd, claude_bundle, fwd, s};
use crate::json::J;
use crate::reads::jspath::{join, resolve};
use crate::release::Release;

pub(super) fn release_statusline(release: &Release) -> Result<claude_bundle::Statusline, Fwd> {
    let manifest = release_manifest(release)?;
    let asset = manifest
        .get("assets")
        .and_then(|a| a.get("claude-statusline"));
    let (Some(path), Some(sha)) = (
        s(asset.and_then(|a| a.get("path"))),
        s(asset.and_then(|a| a.get("sha256"))),
    ) else {
        return Err(fwd(crate::reason!("release_statusline_missing")));
    };
    let root = release.root.to_string_lossy().into_owned();
    let full = resolve(&[&root, path]);
    if !full.starts_with(&format!("{root}/")) {
        return Err(fwd(crate::reason!("release_statusline_escapes")));
    }
    Ok(claude_bundle::Statusline {
        path: full,
        sha256: sha.to_owned(),
    })
}

fn release_manifest(release: &Release) -> Result<J, Fwd> {
    let bytes = std::fs::read(release.root.join("release.json"))
        .map_err(|_| fwd(crate::reason!("release_manifest")))?;
    crate::json::parse(&bytes).ok_or_else(|| fwd(crate::reason!("release_manifest")))
}

/// `executionRelease` for the selected driver's worker, from release.json's
/// worker bindings (aspd.ts `resolveAspdReleaseBinding`).
pub(super) fn execution_release(release: &Release, protocol: &str, driver: &str) -> Result<J, Fwd> {
    let manifest = release_manifest(release)?;
    let root = release.root.to_string_lossy().into_owned();
    let bindings = manifest
        .get("workerBindings")
        .filter(|b| b.is_record())
        .ok_or_else(|| fwd(crate::reason!("release_workers")))?;
    let mut workers: Vec<(String, String)> = vec![];
    for (driver, executable) in bindings.js_entries() {
        let name = executable
            .as_str()
            .ok_or_else(|| fwd(crate::reason!("release_workers")))?;
        let launcher = s(manifest
            .get("executables")
            .and_then(|e| e.get(name))
            .and_then(|e| e.get("launcher")))
        .ok_or_else(|| fwd(crate::reason!("release_workers")))?;
        let real = std::fs::canonicalize(join(&[&root, launcher]))
            .map_err(|_| fwd(crate::reason!("release_workers")))?
            .to_string_lossy()
            .into_owned();
        workers.push((driver.to_owned(), real));
    }
    let Some((_, executable)) = workers.iter().find(|(d, _)| d == driver) else {
        return Err(fwd(crate::reason!("release_worker_driver_unavailable")));
    };
    let mut hosted: Vec<String> = workers
        .iter()
        .filter(|(_, e)| e == executable)
        .map(|(d, _)| d.clone())
        .collect();
    hosted.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(J::obj([
        ("releaseId", J::str(&release.release_id)),
        ("sourceCommit", J::str(&release.source_commit)),
        ("builtAt", J::str(&release.built_at)),
        ("releaseRoot", J::str(&root)),
        (
            "worker",
            J::obj([
                ("protocol", J::str(protocol)),
                ("executable", J::str(executable)),
                (
                    "hostedDrivers",
                    J::Arr(hosted.into_iter().map(J::Str).collect()),
                ),
                (
                    "argvPrefix",
                    J::Arr(["run", "--transport", "unix"].map(J::str).to_vec()),
                ),
            ]),
        ),
    ]))
}
