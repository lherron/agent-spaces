//! `CodexAdapter.detect()` (codex-discovery.ts): the first candidate binary
//! whose `--version` is at least 0.124.0 and whose `app-server --help`
//! succeeds, each probe bounded at 15 s. Successful probes are cached by the
//! binary's identity; failures never are, as in Bun's long-lived compiler.
use crate::compile::util::{exec_environment, js_trim};
use crate::compile::{Fwd, fwd};
use crate::reads::capability::{MIN_CODEX_VERSION, compare_semver, parse_semver};
use crate::reads::jspath::{exists, join};
use std::fs;
use std::sync::Mutex;

/// Successful probes by candidate, keyed by the binary's (target, mtime, size).
static DETECTED: Mutex<Vec<(String, String)>> = Mutex::new(vec![]);

fn binary_fingerprint(candidate: &str) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let target = fs::canonicalize(candidate).ok()?;
    let meta = fs::metadata(&target).ok()?;
    Some(format!(
        "{}:{}:{}:{}",
        target.to_string_lossy(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.size()
    ))
}

fn candidates() -> Vec<String> {
    let env = exec_environment();
    let home = crate::reads::homedir();
    let mut out: Vec<String> = vec![env.get("ASP_CODEX_PATH").cloned().unwrap_or_default()];
    if env.get("ASP_CODEX_SKIP_COMMON_PATHS").map(String::as_str) != Some("1") {
        out.push(join(&[&home, ".local", "bin", "codex"]));
        out.push(join(&[&home, ".bun", "bin", "codex"]));
        let nvm = join(&[&home, ".nvm", "versions", "node"]);
        if let Ok(read) = fs::read_dir(&nvm) {
            for entry in read.flatten() {
                if entry.file_type().is_ok_and(|t| t.is_dir()) {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    out.push(join(&[&nvm, &name, "bin", "codex"]));
                }
            }
        }
        out.push("/opt/homebrew/bin/codex".into());
        out.push("/usr/local/bin/codex".into());
    }
    for dir in env
        .get("PATH")
        .map(String::as_str)
        .unwrap_or_default()
        .split(':')
        .filter(|d| !d.is_empty())
    {
        out.push(join(&[dir, "codex"]));
    }
    let mut seen: Vec<String> = vec![];
    out.into_iter()
        .filter(|c| {
            if c.is_empty() || seen.contains(c) {
                return false;
            }
            seen.push(c.clone());
            true
        })
        .collect()
}

/// `runCommand(argv)`: exit code and stdout, with a 15 s deadline and the
/// process env minus `HARNESS_BROKER_*`.
fn run(argv: &[&str]) -> Option<(i32, String, String)> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let env = exec_environment();
    let mut child = Command::new(argv[0])
        .args(&argv[1..])
        .env_clear()
        .envs(
            env.iter()
                .filter(|(k, _)| !k.starts_with("HARNESS_BROKER_")),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let mut err = child.stderr.take()?;
    let out_reader = std::thread::spawn(move || {
        let mut b = vec![];
        let _ = out.read_to_end(&mut b);
        String::from_utf8_lossy(&b).into_owned()
    });
    let err_reader = std::thread::spawn(move || {
        let mut b = vec![];
        let _ = err.read_to_end(&mut b);
        String::from_utf8_lossy(&b).into_owned()
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    status.map(|s| (s.code().unwrap_or(0), stdout, stderr))
}

fn probe(candidate: &str) -> bool {
    let Some((code, stdout, stderr)) = run(&[candidate, "--version"]) else {
        return false;
    };
    if code != 0 {
        return false;
    }
    let output = if js_trim(&stdout).is_empty() {
        js_trim(&stderr)
    } else {
        js_trim(&stdout)
    };
    if !parse_semver(output).is_some_and(|v| compare_semver(v, MIN_CODEX_VERSION).is_ge()) {
        return false;
    }
    matches!(run(&[candidate, "app-server", "--help"]), Some((0, _, _)))
}

/// `codexAdapter.detect()`: the first available candidate's path, or a
/// forward where Bun throws "Harness codex is not available".
pub fn detect() -> Result<String, Fwd> {
    for candidate in candidates() {
        if !exists(&candidate) {
            continue;
        }
        let fingerprint = binary_fingerprint(&candidate);
        if let Some(fp) = &fingerprint {
            let cache = DETECTED.lock().unwrap_or_else(|e| e.into_inner());
            if cache.iter().any(|(c, f)| *c == candidate && f == fp) {
                return Ok(candidate);
            }
        }
        if probe(&candidate) {
            if let Some(fp) = fingerprint {
                let mut cache = DETECTED.lock().unwrap_or_else(|e| e.into_inner());
                cache.retain(|(c, _)| *c != candidate);
                cache.push((candidate.clone(), fp));
            }
            return Ok(candidate);
        }
    }
    Err(fwd(crate::reason!("codex_unavailable")))
}
