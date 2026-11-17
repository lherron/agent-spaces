//! The target bundle's publish protocol (materialize-target.ts from the
//! fingerprint on), shared by both harnesses: the content hash of each staged
//! artifact, the target fingerprint, the `.asp-materialized.json` manifest
//! that validates a published version, and the publish itself under the
//! bundle-scope lock (compose into staging, rename into `.versions/<fp>`,
//! prune, then drop the staged artifacts).
use super::bundle_prune::prune_bundle_versions;
use super::fs_tree::{io_fwd, mkdirp, write_json};
use super::lockfile::{self, MATERIALIZATION};
use super::stage::Artifact;
use super::temp_lifecycle::{materialization_lock_path, unique_staging_dir};
use super::util::{canonicalize, js_sort, now_iso, sanitize_segment, sha256_hex};
use super::{Fwd, fwd};
use crate::json::J;
use crate::reads::jspath::{join, relative};
use std::fs;
use std::os::unix::fs::MetadataExt;

/// `DEFAULT_HARNESS`: materializeFromRefs is not given the selected harness
/// (the T-11825 defect Bun keeps until the D0 window closes), so the bundle
/// fingerprint, manifest and space support check name `agent-harness`.
pub const DEFAULT_HARNESS: &str = "agent-harness";
pub const TARGET_MATERIALIZER_VERSION: &str = "target-materializer-v8-claude-no-suggestions-recap";

pub struct TargetInput<'a> {
    pub target_name: &'a str,
    pub identity: &'a J,
    pub lock_target: &'a J,
    pub codex_options: Option<&'a J>,
    pub public_scope_root: String,
    pub path_exclude: Vec<String>,
}

/// `hashDirectory(root, { excludeRelativePaths: {'.asp-cache.json'} })`.
pub fn hash_directory(root: &str) -> Result<String, Fwd> {
    let mut entries = vec![];
    hash_visit(root, "", &mut entries)?;
    Ok(sha256_hex(entries.join("\n").as_bytes()))
}

fn hash_visit(dir: &str, prefix: &str, out: &mut Vec<String>) -> Result<(), Fwd> {
    let mut names: Vec<(String, fs::FileType)> = fs::read_dir(dir)
        .map_err(io_fwd)?
        .map(|e| {
            let e = e.map_err(io_fwd)?;
            Ok((
                e.file_name().to_string_lossy().into_owned(),
                e.file_type().map_err(io_fwd)?,
            ))
        })
        .collect::<Result<_, Fwd>>()?;
    names.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    for (name, ft) in names {
        let full = join(&[dir, &name]);
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if rel == ".asp-cache.json" {
            continue;
        }
        let mode = fs::symlink_metadata(&full).map_err(io_fwd)?.mode();
        if ft.is_dir() {
            out.push(format!("dir {rel} {mode}"));
            hash_visit(&full, &rel, out)?;
        } else if ft.is_symlink() {
            let target = fs::read_link(&full).map_err(io_fwd)?;
            out.push(format!("symlink {rel} {mode} {}", target.to_string_lossy()));
        } else if ft.is_file() {
            let content = fs::read(&full).map_err(io_fwd)?;
            out.push(format!("file {rel} {mode} {}", sha256_hex(&content)));
        }
    }
    Ok(())
}

/// `computeTargetFingerprint`.
pub fn fingerprint(input: &TargetInput, artifacts: &[Artifact], hashes: &[String]) -> String {
    let arr = |k: &str| input.lock_target.get(k).cloned().unwrap_or(J::Arr(vec![]));
    let mut material = J::obj([
        ("schemaVersion", J::str(TARGET_MATERIALIZER_VERSION)),
        ("harnessId", J::str(DEFAULT_HARNESS)),
        ("targetName", J::str(input.target_name)),
        ("identity", input.identity.clone()),
        ("compose", arr("compose")),
        ("roots", arr("roots")),
        ("loadOrder", arr("loadOrder")),
        (
            "artifacts",
            J::Arr(
                artifacts
                    .iter()
                    .zip(hashes)
                    .map(|(a, h)| {
                        J::obj([
                            ("spaceKey", J::str(&a.space_key)),
                            ("spaceId", J::str(&a.space_id)),
                            ("pluginName", J::str(&a.plugin_name)),
                            ("pluginVersion", J::str(&a.plugin_version)),
                            ("contentHash", J::str(h)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "settingsInputs",
            J::Arr(artifacts.iter().map(|a| a.settings.clone()).collect()),
        ),
    ]);
    if !input.path_exclude.is_empty() {
        material.set(
            "pathExclude",
            J::Arr(input.path_exclude.iter().map(J::str).collect()),
        );
    }
    if let Some(codex) = input.codex_options {
        material.set("codexOptions", codex.clone());
    }
    sha256_hex(canonicalize(&material, false).as_bytes())
}

/// `validateMaterializedTarget(outputPath, fingerprint)`.
fn validate_target(output: &str, fingerprint: &str) -> bool {
    let Ok(text) = fs::read(join(&[output, ".asp-materialized.json"])) else {
        return false;
    };
    let Some(manifest) = crate::json::parse(&text) else {
        return false;
    };
    if manifest.get("fingerprint").and_then(J::as_str) != Some(fingerprint)
        || manifest.get("complete") != Some(&J::Bool(true))
    {
        return false;
    }
    manifest
        .get("requiredPaths")
        .and_then(J::as_arr)
        .into_iter()
        .flatten()
        .all(|p| {
            p.as_str()
                .is_some_and(|p| fs::metadata(join(&[output, p])).is_ok())
        })
}

/// The `.asp-materialized.json` a published version is validated by.
fn manifest(input: &TargetInput, fingerprint: &str, mut required: Vec<String>) -> J {
    js_sort(&mut required);
    required.dedup();
    let mut manifest = J::obj([
        ("schemaVersion", J::Num(1.0)),
        ("complete", J::Bool(true)),
        ("materializerVersion", J::str(TARGET_MATERIALIZER_VERSION)),
        ("fingerprint", J::str(fingerprint)),
        ("harnessId", J::str(DEFAULT_HARNESS)),
        ("targetName", J::str(input.target_name)),
    ]);
    manifest.set("identity", input.identity.clone());
    manifest.set("generatedAt", J::str(now_iso()));
    manifest.set(
        "requiredPaths",
        J::Arr(required.into_iter().map(J::Str).collect()),
    );
    // materialize-target.ts writes pathExclude last.
    if !input.path_exclude.is_empty() {
        manifest.set(
            "pathExclude",
            J::Arr(input.path_exclude.iter().map(J::str).collect()),
        );
    }
    manifest
}

/// Publish the target bundle (`materializeTarget` from the fingerprint on):
/// `compose(stagingOutput, publishedOutput)` composes the adapter's bundle
/// and returns the paths its manifest requires. Returns the published output.
pub fn publish_target(
    input: &TargetInput,
    artifacts: &[Artifact],
    fingerprint: &str,
    asp_home: &str,
    harness_dir: &str,
    compose: impl Fn(&str, &str) -> Result<Vec<String>, Fwd>,
) -> Result<String, Fwd> {
    let versions = join(&[&input.public_scope_root, "bundles", ".versions"]);
    let version_root = join(&[&versions, fingerprint]);
    let output = join(&[&version_root, input.target_name, harness_dir]);
    let scope_key = format!(
        "bundle-scope-{}",
        &sha256_hex(join(&[&input.public_scope_root, "bundles"]).as_bytes())[..32]
    );
    let lock_path = materialization_lock_path(asp_home, &scope_key);
    let published = lockfile::with_lock(&lock_path, &MATERIALIZATION, || -> Result<(), Fwd> {
        if !validate_target(&output, fingerprint) {
            let staging_root = unique_staging_dir(
                asp_home,
                &format!(
                    "bundle-{}-{}",
                    sanitize_segment(input.target_name),
                    &fingerprint[..16]
                ),
            );
            let staging_output = join(&[&staging_root, input.target_name, harness_dir]);
            let _ = fs::remove_dir_all(&staging_root);
            let result = (|| {
                let required = compose(&staging_output, &output)?
                    .iter()
                    .map(|p| relative(&staging_output, p))
                    .collect();
                write_json(
                    &join(&[&staging_output, ".asp-materialized.json"]),
                    &manifest(input, fingerprint, required),
                )?;
                mkdirp(&versions)?;
                if !validate_target(&output, fingerprint) {
                    let _ = fs::remove_dir_all(&version_root);
                }
                match fs::rename(&staging_root, &version_root) {
                    Ok(()) => Ok(()),
                    Err(e) => {
                        let _ = fs::remove_dir_all(&staging_root);
                        // Content-addressed: losing the rename to a valid peer is success.
                        if matches!(e.raw_os_error(), Some(libc::EEXIST | libc::ENOTEMPTY))
                            && validate_target(&output, fingerprint)
                        {
                            Ok(())
                        } else {
                            Err(io_fwd(e))
                        }
                    }
                }
            })();
            if result.is_err() {
                let _ = fs::remove_dir_all(&staging_root);
            }
            result?;
        }
        prune_bundle_versions(&versions, fingerprint, &join(&[asp_home, "tmp"]));
        Ok(())
    })
    .map_err(super::lock_fwd(crate::reason!("bundle_scope_lock")))?;
    published?;
    if !validate_target(&output, fingerprint) {
        return Err(fwd(crate::reason!("bundle_invalid_after_publish")));
    }
    let staging = join(&[asp_home, "tmp", ".staging"]);
    for a in artifacts.iter().filter(|a| a.path.starts_with(&staging)) {
        let _ = fs::remove_dir_all(&a.path);
    }
    Ok(output)
}
