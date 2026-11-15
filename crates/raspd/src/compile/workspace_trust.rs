//! `ensureClaudeWorkspaceTrust(cwd)`: seed `hasTrustDialogAccepted` for the
//! launch cwd (and its real path) in the Claude config, retrying a write a
//! concurrent writer clobbered. Its outcome is warnings, never a failure.
use super::util;
use crate::json::J;
use crate::reads::Env;
use crate::reads::jspath::{dirname, join};

/// `ensureClaudeWorkspaceTrust(cwd)`: the warnings it reports.
pub(super) fn workspace_trust(cwd: &str) -> Vec<String> {
    let env = Env::process();
    let config = match env
        .get("CLAUDE_CONFIG_DIR")
        .map(util::js_trim)
        .filter(|d| !d.is_empty())
    {
        Some(dir) => join(&[dir, ".claude.json"]),
        None => join(&[&crate::reads::homedir(), ".claude.json"]),
    };
    let mut keys = vec![cwd.to_owned()];
    if let Ok(real) = std::fs::canonicalize(cwd) {
        let real = real.to_string_lossy().into_owned();
        if real != cwd {
            keys.push(real);
        }
    }
    let mut warnings = vec![];
    let trusted = |state: &J, key: &str| {
        state
            .get("projects")
            .filter(|p| p.is_record())
            .and_then(|p| p.get(key))
            .filter(|e| e.is_record())
            .and_then(|e| e.get("hasTrustDialogAccepted"))
            == Some(&J::Bool(true))
    };
    let read = |path: &str| -> Result<J, String> {
        match std::fs::read(path) {
            Ok(bytes) => match crate::json::parse(&bytes) {
                Some(v) if v.is_record() => Ok(v),
                Some(_) => Err(format!("{path} does not contain a JSON object")),
                None => Err("JSON Parse error".into()),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(J::Obj(vec![])),
            Err(e) => Err(e.to_string()),
        }
    };
    for attempt in 1..=3 {
        let outcome = (|| -> Result<bool, String> {
            let mut state = read(&config)?;
            let missing: Vec<&String> = keys.iter().filter(|k| !trusted(&state, k)).collect();
            if missing.is_empty() {
                return Ok(true);
            }
            let mut projects = state
                .get("projects")
                .filter(|p| p.is_record())
                .cloned()
                .unwrap_or(J::Obj(vec![]));
            for key in &missing {
                let mut entry = projects
                    .get(key)
                    .filter(|e| e.is_record())
                    .cloned()
                    .unwrap_or(J::Obj(vec![]));
                entry.set("hasTrustDialogAccepted", J::Bool(true));
                projects.set(key, entry);
            }
            state.set("projects", projects);
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mode = std::fs::metadata(&config)
                .map(|m| m.permissions().mode() & 0o777)
                .unwrap_or(0o600);
            let tmp = join(&[
                &dirname(&config),
                &format!(
                    ".claude.json.asp-trust-{}-{}.tmp",
                    std::process::id(),
                    util::hex_bytes(&util::random_bytes::<4>())
                ),
            ]);
            let written = (|| -> std::io::Result<()> {
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(mode)
                    .open(&tmp)?;
                f.write_all(format!("{}\n", state.to_json_pretty()).as_bytes())?;
                std::fs::rename(&tmp, &config)
            })();
            if let Err(e) = written {
                let _ = std::fs::remove_file(&tmp);
                return Err(e.to_string());
            }
            let verify = read(&config)?;
            let lost: Vec<&String> = keys.iter().filter(|k| !trusted(&verify, k)).collect();
            if lost.is_empty() {
                return Ok(true);
            }
            warnings.push(format!(
                "Workspace-trust write for {} was clobbered by a concurrent writer (attempt {attempt}/3)",
                lost.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
            ));
            Ok(false)
        })();
        match outcome {
            Ok(true) => return warnings,
            Ok(false) => {}
            Err(reason) => warnings.push(format!(
                "Workspace-trust seeding failed for {cwd} (attempt {attempt}/3): {reason}"
            )),
        }
        if attempt < 3 {
            std::thread::sleep(std::time::Duration::from_millis(50 * attempt as u64));
        }
    }
    warnings.push(format!(
        "Workspace trust for {cwd} could not be recorded in {config}; an interactive Claude launch may block on the trust prompt"
    ));
    warnings
}
