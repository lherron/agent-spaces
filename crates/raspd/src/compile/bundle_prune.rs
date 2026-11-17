//! `pruneBundleVersions` (materialize-target.ts): after a publish, remove
//! bundle versions that are not current, not among the three most recent,
//! not referenced from any file under ASP_HOME's tmp/, and older than 15
//! minutes.
use super::fs_tree::mtime_ms;
use super::util::now_ms;
use crate::reads::jspath::{basename, join, relative};
use std::fs;

fn is_fingerprint(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `pruneBundleVersions({ versionsRoot, currentFingerprints: [fp], referenceRoots: [tmp] })`.
pub(super) fn prune_bundle_versions(versions_root: &str, current: &str, reference_root: &str) {
    let Ok(read) = fs::read_dir(versions_root) else {
        return;
    };
    let mut versions: Vec<(String, String, f64)> = vec![];
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type().is_ok_and(|t| t.is_dir()) || !is_fingerprint(&name) {
            continue;
        }
        let path = join(&[versions_root, &name]);
        if let Ok(meta) = fs::symlink_metadata(&path)
            && meta.is_dir()
        {
            versions.push((name.to_lowercase(), path, mtime_ms(&meta)));
        }
    }
    if versions.is_empty() {
        return;
    }
    let current = current.to_lowercase();
    versions.sort_by(|a, b| {
        b.2.partial_cmp(&a.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.cmp(&a.0))
    });
    let mut recent: Vec<String> = vec![];
    for (hash, _, _) in &versions {
        if *hash == current {
            continue;
        }
        if recent.len() >= 3 {
            break;
        }
        recent.push(hash.clone());
    }
    let candidates: Vec<String> = versions
        .iter()
        .map(|v| v.0.clone())
        .filter(|h| *h != current && !recent.contains(h))
        .collect();
    if candidates.is_empty() {
        return;
    }
    let mut referenced: Vec<String> = vec![];
    scan_references(reference_root, versions_root, &candidates, &mut referenced);
    let now = now_ms();
    for (hash, path, mtime) in &versions {
        if *hash == current || recent.contains(hash) || referenced.contains(hash) {
            continue;
        }
        if now - mtime < 15.0 * 60.0 * 1000.0 {
            continue;
        }
        let _ = fs::remove_dir_all(path);
    }
}

fn reference_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    [
        "json", "jsonl", "ndjson", "toml", "yaml", "yml", "md", "txt", "log",
    ]
    .iter()
    .any(|ext| lower.ends_with(&format!(".{ext}")))
}

fn scan_references(path: &str, versions_root: &str, candidates: &[String], out: &mut Vec<String>) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    let rel = relative(versions_root, path);
    if rel.is_empty() || (!rel.starts_with("..") && !rel.contains("../")) {
        return;
    }
    if meta.is_dir() {
        if let Ok(read) = fs::read_dir(path) {
            for entry in read.flatten() {
                scan_references(
                    &join(&[path, &entry.file_name().to_string_lossy()]),
                    versions_root,
                    candidates,
                    out,
                );
            }
        }
        return;
    }
    if !meta.is_file() || meta.len() > 10 * 1024 * 1024 || !reference_file(&basename(path)) {
        return;
    }
    let Ok(bytes) = fs::read(path) else { return };
    let text = String::from_utf8_lossy(&bytes);
    let marker = format!("{versions_root}/");
    for hash in candidates {
        if out.contains(hash) {
            continue;
        }
        if text.contains(&format!("{marker}{hash}/")) || text.contains(&format!("{marker}{hash}\""))
        {
            out.push(hash.clone());
            continue;
        }
        // /(?:^|[/\\])\.versions[/\\]([a-f0-9]{64})(?:[/\\]|"|'|$)/gi
        let lower = text.to_lowercase();
        for (at, _) in lower.match_indices(".versions") {
            let before_ok = at == 0 || matches!(lower.as_bytes()[at - 1], b'/' | b'\\');
            let rest = &lower[at + ".versions".len()..];
            let Some(sep) = rest.chars().next() else {
                continue;
            };
            if !before_ok || !matches!(sep, '/' | '\\') || rest.len() < 65 {
                continue;
            }
            let found = &rest[1..65];
            let after = rest[65..].chars().next();
            if found == hash.as_str() && after.is_none_or(|c| matches!(c, '/' | '\\' | '"' | '\''))
            {
                out.push(hash.clone());
                break;
            }
        }
    }
}
