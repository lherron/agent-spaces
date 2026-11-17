//! ASP_HOME's tmp/ layout and lifecycle (store/temp-lifecycle.ts and the
//! paths it sweeps): unique staging directories under tmp/.staging, the
//! materialization lock files under tmp/locks, the sweep of stale staging
//! and launch overlays, and the content-addressed system prompt artifact.
use super::Fwd;
use super::fs_tree::{mkdirp, mtime_ms, write};
use super::util::{now_ms, random_uuid, sanitize_segment, sha256_hex};
use crate::reads::jspath::join;
use std::fs;
use std::io;

/// `uniqueStagingDir(paths, prefix)`: `<prefix>-<pid>-<uuid>`, which the
/// sweep parses back (`staging_pid`).
pub fn unique_staging_dir(asp_home: &str, prefix: &str) -> String {
    join(&[
        asp_home,
        "tmp",
        ".staging",
        &format!("{prefix}-{}-{}", std::process::id(), random_uuid()),
    ])
}

/// `materializationLockPath(paths, key)`.
pub fn materialization_lock_path(asp_home: &str, key: &str) -> String {
    join(&[
        asp_home,
        "tmp",
        "locks",
        &format!("{}.lock", sanitize_segment(key)),
    ])
}

/// `sweepAspTempArtifacts({ aspHome })`.
pub fn sweep_temp(asp_home: &str) {
    let now = now_ms();
    sweep_children(
        &join(&[asp_home, "tmp", "launch-overlays"]),
        now,
        15.0 * 60.0 * 1000.0,
        false,
    );
    sweep_children(
        &join(&[asp_home, "tmp", ".staging"]),
        now,
        60.0 * 60.0 * 1000.0,
        true,
    );
}

fn staging_pid(name: &str) -> Option<i32> {
    // /-(\d+)-<uuid>$/i
    if name.len() < 38 {
        return None;
    }
    let (head, uuid) = name.split_at(name.len() - 36);
    let uuid_ok = uuid.char_indices().all(|(i, c)| {
        if matches!(i, 8 | 13 | 18 | 23) {
            c == '-'
        } else {
            c.is_ascii_hexdigit()
        }
    });
    let head = head.strip_suffix('-')?;
    let digits_start = head.rfind(|c: char| !c.is_ascii_digit())?;
    if !uuid_ok || head.as_bytes()[digits_start] != b'-' {
        return None;
    }
    head[digits_start + 1..]
        .parse::<i32>()
        .ok()
        .filter(|p| *p > 0)
}

fn sweep_children(root: &str, now: f64, max_age: f64, skip_live: bool) {
    let Ok(read) = fs::read_dir(root) else { return };
    for entry in read.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = join(&[root, &name]);
        let Ok(meta) = fs::symlink_metadata(&child) else {
            continue;
        };
        if !meta.is_dir() || now - mtime_ms(&meta) < max_age {
            continue;
        }
        if skip_live
            && let Some(pid) = staging_pid(&name)
            && (unsafe { libc::kill(pid, 0) } == 0
                || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
        {
            continue;
        }
        let _ = fs::remove_dir_all(&child);
    }
}

/// `writeRuntimeSystemPromptArtifact({ aspHome, artifactRoot, content })`.
pub fn write_prompt_artifact(artifact_root: &str, content: &str) -> Result<String, Fwd> {
    // Node writes and hashes a lone surrogate as U+FFFD.
    let content = &*crate::json::well_formed(content);
    let hash = sha256_hex(content.as_bytes());
    let dir = join(&[artifact_root, "system-prompts", &hash[..2], &hash]);
    mkdirp(&dir)?;
    let path = join(&[&dir, "system-prompt.md"]);
    write(&path, content)?;
    if let Ok(file) = fs::File::options().write(true).open(&path) {
        let now = std::time::SystemTime::now();
        let _ = file.set_times(fs::FileTimes::new().set_accessed(now).set_modified(now));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staging_pid_matches_bun_pattern() {
        assert_eq!(
            staging_pid("space-x-dev-123-1b4e28ba-2fa1-41d2-883f-0016d3cca427"),
            Some(123)
        );
        assert_eq!(
            staging_pid("space-x-1b4e28ba-2fa1-41d2-883f-0016d3cca427"),
            None
        );
    }
}
