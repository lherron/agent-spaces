//! `aspc.observeRuntimeCapability` (compiler/agent-spaces/src/runtime-capability.ts):
//! whether a harness's native runtime is installed and runnable, by the same
//! bounded `--version` / `app-server --help` probes, and whether its
//! credentials are present. Read-only: the probes are the harness CLIs' own
//! version and help commands.
use super::jspath::join;
use super::{Answer, Forward, homedir};
use crate::compile::util::{exec_environment, js_trim};
use crate::json::J;
use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

pub const REQUEST_VERSION: &str = "aspc-observe-runtime-capability-request/v1";
const RESPONSE_VERSION: &str = "aspc-observe-runtime-capability-response/v1";

const PROBE_TIMEOUT_MS: u64 = 3_000;
const PROBE_OUTPUT_LIMIT: usize = 65_536;
const CODEX_OPERATION_TIMEOUT_MS: u64 = 12_000;
const CODEX_MAX_CANDIDATES: usize = 8;
const MIN_CODEX_VERSION: [f64; 3] = [0.0, 124.0, 0.0];

type Env = BTreeMap<String, String>;

#[derive(Clone, Copy, PartialEq)]
enum State {
    Present,
    Absent,
    Unknown,
}

struct Diagnostic {
    code: &'static str,
    probe: &'static str,
    message: String,
    candidate: Option<String>,
}

enum Probe {
    Ok { stdout: String, stderr: String },
    Failed { code: &'static str, message: String },
}

pub fn observe(request: &J) -> Answer {
    if request.get("schemaVersion") != Some(&J::str(REQUEST_VERSION)) {
        return Answer::Result(failure(
            "unsupported_schema",
            "Unsupported capability observation schema",
        ));
    }
    let requested = match request.get("harness") {
        Some(J::Str(s)) => s.as_str(),
        _ => "",
    };
    if !super::profile::HARNESS_IDS.contains(&requested) {
        return Answer::Result(failure(
            "unsupported_harness",
            &format!("Unsupported harness {requested}"),
        ));
    }
    let env = exec_environment();
    if requested == "agent-harness" {
        return Answer::Result(success(
            requested,
            State::Present,
            State::Present,
            vec![],
            env,
        ));
    }
    let mut diagnostics = vec![];
    if matches!(requested, "codex" | "codex-hrcpty") {
        let (native, preparation) = match observe_codex(&mut diagnostics, env) {
            Ok(states) => states,
            Err(reason) => return Answer::Forward(reason),
        };
        return Answer::Result(success(requested, native, preparation, diagnostics, env));
    }
    let command = if matches!(requested, "claude" | "claude-hrcpty") {
        find_command("ASP_CLAUDE_PATH", "claude", env)
    } else {
        find_command("ASP_MUSE_PATH", "muse", env)
    };
    let Some(command) = command else {
        return Answer::Result(success(
            requested,
            State::Absent,
            State::Absent,
            diagnostics,
            env,
        ));
    };
    let state = match bounded_probe(&command, &["--version"], PROBE_TIMEOUT_MS, env) {
        Err(reason) => return Answer::Forward(reason),
        Ok(Probe::Ok { .. }) => State::Present,
        Ok(Probe::Failed { code, message }) => {
            diagnostics.push(Diagnostic {
                code,
                probe: "version",
                message,
                candidate: Some(command),
            });
            State::Unknown
        }
    };
    Answer::Result(success(requested, state, state, diagnostics, env))
}

fn observe_codex(diagnostics: &mut Vec<Diagnostic>, env: &Env) -> Result<(State, State), Forward> {
    let candidates = codex_candidates(env);
    if candidates.is_empty() {
        return Ok((State::Absent, State::Absent));
    }
    let deadline = Instant::now() + Duration::from_millis(CODEX_OPERATION_TIMEOUT_MS);
    let remaining = || {
        deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u64
    };
    let mut saw_below_minimum = false;
    for candidate in candidates.into_iter().take(CODEX_MAX_CANDIDATES) {
        if remaining() == 0 {
            diagnostics.push(Diagnostic {
                code: "probe_timeout",
                probe: "version",
                message: "Codex observation deadline exceeded".into(),
                candidate: None,
            });
            return Ok((State::Unknown, State::Unknown));
        }
        let (stdout, stderr) = match bounded_probe(
            &candidate,
            &["--version"],
            PROBE_TIMEOUT_MS.min(remaining()),
            env,
        )? {
            Probe::Ok { stdout, stderr } => (stdout, stderr),
            Probe::Failed { code, message } => {
                diagnostics.push(Diagnostic {
                    code,
                    probe: "version",
                    message,
                    candidate: Some(candidate),
                });
                continue;
            }
        };
        let parsed = parse_semver(&format!("{stdout}\n{stderr}"));
        if !parsed.is_some_and(|v| compare_semver(v, MIN_CODEX_VERSION).is_ge()) {
            saw_below_minimum = true;
            diagnostics.push(Diagnostic {
                code: "version_below_minimum",
                probe: "version",
                message: "Codex version is below minimum 0.124.0".into(),
                candidate: Some(candidate),
            });
            continue;
        }
        if remaining() == 0 {
            return Ok((State::Present, State::Unknown));
        }
        return match bounded_probe(
            &candidate,
            &["app-server", "--help"],
            PROBE_TIMEOUT_MS.min(remaining()),
            env,
        )? {
            Probe::Ok { .. } => Ok((State::Present, State::Present)),
            Probe::Failed { code, message } => {
                diagnostics.push(Diagnostic {
                    code,
                    probe: "app-server-help",
                    message,
                    candidate: Some(candidate),
                });
                Ok((State::Present, State::Unknown))
            }
        };
    }
    if saw_below_minimum
        && diagnostics
            .iter()
            .all(|d| d.code == "version_below_minimum")
    {
        return Ok((State::Absent, State::Absent));
    }
    Ok((State::Unknown, State::Unknown))
}

/// Bun.spawn's error message for a failed spawn, for the errnos measured
/// against Bun 1.3 (T-13048); another errno still refuses.
fn spawn_error(error: &std::io::Error, command: &str) -> Option<String> {
    let (code, description) = match error.raw_os_error()? {
        libc::ENOENT => ("ENOENT", "no such file or directory"),
        libc::EACCES => ("EACCES", "permission denied"),
        libc::ENOTDIR => ("ENOTDIR", "not a directory"),
        libc::ENOEXEC => ("ENOEXEC", "unknown error"),
        libc::ELOOP => ("ELOOP", "too many symbolic links encountered"),
        _ => return None,
    };
    Some(format!("{code}: {description}, posix_spawn '{command}'"))
}

/// Whether execve would load `path` itself: a `#!` script or a Mach-O (thin
/// or fat) image. Anything unreadable is left to the spawn to report.
fn executable_format(path: &str) -> bool {
    // Permission is checked before the format: a non-executable file is EACCES.
    let Ok(c) = std::ffi::CString::new(path) else {
        return true;
    };
    // SAFETY: `c` is a valid NUL-terminated string for the call's duration.
    if unsafe { libc::access(c.as_ptr(), libc::X_OK) } != 0 {
        return true;
    }
    let mut head = [0u8; 4];
    let Ok(mut file) = std::fs::File::open(path) else {
        return true;
    };
    let n = file.read(&mut head).unwrap_or(0);
    if !std::fs::metadata(path).is_ok_and(|m| m.is_file()) {
        return true;
    }
    if n >= 2 && head[..2] == *b"#!" {
        return true;
    }
    n == 4
        && [
            [0xfe, 0xed, 0xfa, 0xce],
            [0xfe, 0xed, 0xfa, 0xcf],
            [0xce, 0xfa, 0xed, 0xfe],
            [0xcf, 0xfa, 0xed, 0xfe],
            [0xca, 0xfe, 0xba, 0xbe],
            [0xbe, 0xba, 0xfe, 0xca],
            [0xca, 0xfe, 0xba, 0xbf],
            [0xbf, 0xba, 0xfe, 0xca],
        ]
        .contains(&head)
}

/// `boundedProbe(command, args, timeoutMs)`. A failed spawn is
/// `probe_failed` with Bun's message; `Err` only for an errno raspd has no
/// message for.
fn bounded_probe(
    command: &str,
    args: &[&str],
    timeout_ms: u64,
    env: &Env,
) -> Result<Probe, Forward> {
    // Rust spawns through posix_spawnp, which runs a file of no known format
    // with /bin/sh; Bun's posix_spawn fails it ENOEXEC.
    if command.contains('/') && !executable_format(command) {
        return Ok(Probe::Failed {
            code: "probe_failed",
            message: format!("ENOEXEC: unknown error, posix_spawn '{command}'"),
        });
    }
    let child = Command::new(command)
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // `detached: true`: its own process group, killed as one.
        .process_group(0)
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(e) => {
            return match spawn_error(&e, command) {
                Some(message) => Ok(Probe::Failed {
                    code: "probe_failed",
                    message,
                }),
                None => Err(crate::reason!("capability_probe_spawn_failed")),
            };
        }
    };
    let bytes = Arc::new(AtomicUsize::new(0));
    let overflowed = Arc::new(AtomicBool::new(false));
    let reader = |stream: Option<Box<dyn Read + Send>>| {
        let (bytes, overflowed) = (bytes.clone(), overflowed.clone());
        std::thread::spawn(move || -> Vec<u8> {
            let Some(mut stream) = stream else {
                return vec![];
            };
            let mut out = vec![];
            let mut chunk = [0u8; 16 * 1024];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if bytes.fetch_add(n, Ordering::AcqRel) + n > PROBE_OUTPUT_LIMIT {
                            overflowed.store(true, Ordering::Release);
                            break;
                        }
                        out.extend_from_slice(&chunk[..n]);
                    }
                }
            }
            out
        })
    };
    let stdout = reader(
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let stderr = reader(
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let pid = child.id() as libc::pid_t;
    let terminate = |child: &mut std::process::Child| {
        // SAFETY: signals this probe's own process group, then the probe.
        unsafe {
            if libc::kill(-pid, libc::SIGKILL) != 0 {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        let until = Instant::now() + Duration::from_millis(250);
        while Instant::now() < until && !matches!(child.try_wait(), Ok(Some(_))) {
            std::thread::sleep(Duration::from_millis(2));
        }
    };
    let status = loop {
        if overflowed.load(Ordering::Acquire) {
            terminate(&mut child);
            return Ok(Probe::Failed {
                code: "probe_output_limit",
                message: format!("Probe output exceeded {PROBE_OUTPUT_LIMIT} bytes"),
            });
        }
        match child.try_wait() {
            Ok(Some(status)) if stdout.is_finished() && stderr.is_finished() => break status,
            Err(_) => return Err(crate::reason!("capability_probe_wait_failed")),
            _ => {}
        }
        if Instant::now() >= deadline {
            terminate(&mut child);
            return Ok(Probe::Failed {
                code: "probe_timeout",
                message: format!("Probe exceeded {timeout_ms}ms"),
            });
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    if overflowed.load(Ordering::Acquire) {
        return Ok(Probe::Failed {
            code: "probe_output_limit",
            message: format!("Probe output exceeded {PROBE_OUTPUT_LIMIT} bytes"),
        });
    }
    let stdout = String::from_utf8_lossy(&stdout.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&stderr.join().unwrap_or_default()).into_owned();
    // Bun's `exited` for a probe killed by a signal is 128 + the signal.
    let code = match (status.code(), status.signal()) {
        (Some(code), _) => code,
        (None, Some(signal)) => 128 + signal,
        (None, None) => return Err(crate::reason!("capability_probe_wait_failed")),
    };
    if code != 0 {
        let lower = stderr.to_lowercase();
        let spawn_failure = code == 127
            || ["not found", "bad interpreter", "enoent"]
                .iter()
                .any(|m| lower.contains(m));
        let message = [js_trim(&stderr), js_trim(&stdout)]
            .into_iter()
            .find(|m| !m.is_empty())
            .map_or_else(|| format!("Probe exited {code}"), str::to_owned);
        return Ok(Probe::Failed {
            code: if spawn_failure {
                "probe_failed"
            } else {
                "probe_exit_nonzero"
            },
            message,
        });
    }
    Ok(Probe::Ok { stdout, stderr })
}

/// `findCommand(envName, command)`: the override, else the first PATH entry
/// whose `Bun.file(candidate).size` is non-zero.
fn find_command(env_name: &str, command: &str, env: &Env) -> Option<String> {
    if let Some(o) = env.get(env_name).filter(|o| !o.is_empty()) {
        return Some(o.clone());
    }
    env.get("PATH")
        .map(String::as_str)
        .unwrap_or_default()
        .split(':')
        .filter(|d| !d.is_empty())
        .map(|d| join(&[d, command]))
        .find(|c| std::fs::metadata(c).is_ok_and(|m| m.len() > 0))
}

fn executable(path: &str) -> bool {
    let Ok(c) = std::ffi::CString::new(path) else {
        return false;
    };
    // SAFETY: a valid NUL-terminated path.
    unsafe { libc::access(c.as_ptr(), libc::X_OK) == 0 }
}

/// `codexCandidates()`.
fn codex_candidates(env: &Env) -> Vec<String> {
    if let Some(o) = env.get("ASP_CODEX_PATH").filter(|o| !o.is_empty()) {
        return vec![o.clone()];
    }
    let mut candidates = vec![];
    if env.get("ASP_CODEX_SKIP_COMMON_PATHS").map(String::as_str) != Some("1") {
        let home = homedir();
        candidates.push(join(&[&home, ".local/bin/codex"]));
        candidates.push(join(&[&home, ".bun/bin/codex"]));
        candidates.push("/opt/homebrew/bin/codex".into());
        candidates.push("/usr/local/bin/codex".into());
    }
    for d in env
        .get("PATH")
        .map(String::as_str)
        .unwrap_or_default()
        .split(':')
        .filter(|d| !d.is_empty())
    {
        candidates.push(join(&[d, "codex"]));
    }
    let mut unique: Vec<String> = vec![];
    for c in candidates {
        if !c.is_empty() && !unique.contains(&c) {
            unique.push(c);
        }
    }
    unique.into_iter().filter(|c| executable(c)).collect()
}

/// `value.match(/(\d+)\.(\d+)\.(\d+)/)`, leftmost.
fn parse_semver(value: &str) -> Option<[f64; 3]> {
    let b = value.as_bytes();
    let digits = |mut i: usize| {
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        (i > start).then_some((start, i))
    };
    for start in 0..b.len() {
        let Some((s0, e0)) = digits(start) else {
            continue;
        };
        if b.get(e0) != Some(&b'.') {
            continue;
        }
        let Some((s1, e1)) = digits(e0 + 1) else {
            continue;
        };
        if b.get(e1) != Some(&b'.') {
            continue;
        }
        let Some((s2, e2)) = digits(e1 + 1) else {
            continue;
        };
        let n = |s: usize, e: usize| value[s..e].parse::<f64>().unwrap_or(f64::NAN);
        return Some([n(s0, e0), n(s1, e1), n(s2, e2)]);
    }
    None
}

fn compare_semver(left: [f64; 3], right: [f64; 3]) -> std::cmp::Ordering {
    for i in 0..3 {
        let difference = left[i] - right[i];
        if difference != 0.0 {
            return difference
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Less);
        }
    }
    std::cmp::Ordering::Equal
}

fn fact(state: &str, code: &str) -> J {
    J::obj([("state", J::str(state)), ("code", J::str(code))])
}

/// `credentialFact(harness)`.
fn credentials(harness: &str, env: &Env) -> J {
    let set = |k: &str| env.get(k).is_some_and(|v| !v.is_empty());
    let home = env.get("HOME").cloned().unwrap_or_else(homedir);
    let path = match harness {
        "agent-harness" if set("OPENAI_API_KEY") || set("ANTHROPIC_API_KEY") => None,
        "agent-harness" => Some(join(&[&home, ".pi", "agent", "auth.json"])),
        "claude" if set("ANTHROPIC_API_KEY") => None,
        "claude" => Some(join(&[&home, ".claude.json"])),
        "codex" | "codex-hrcpty" if set("OPENAI_API_KEY") => None,
        "codex" | "codex-hrcpty" => Some(join(&[&home, ".codex", "auth.json"])),
        _ => return fact("present", "credentials_not_required"),
    };
    let Some(path) = path else {
        return fact("present", "credentials_present");
    };
    let Ok(c) = std::ffi::CString::new(path) else {
        return fact("unknown", "credential_source_unreadable");
    };
    // SAFETY: a valid NUL-terminated path.
    if unsafe { libc::access(c.as_ptr(), libc::R_OK) } == 0 {
        return fact("present", "credentials_present");
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ENOENT | libc::ENOTDIR) => fact("absent", "credentials_missing"),
        _ => fact("unknown", "credential_source_unreadable"),
    }
}

/// `capabilitySuccess(requested, harness, nativeState, preparationState, diagnostics)`.
fn success(
    requested: &str,
    native: State,
    preparation: State,
    diagnostics: Vec<Diagnostic>,
    env: &Env,
) -> J {
    let provider = match requested {
        "claude" | "claude-hrcpty" => "anthropic",
        "muse" => "meta",
        _ => "openai-codex",
    };
    let credentials = credentials(requested, env);
    let credential_state = credentials.get("state").and_then(J::as_str).unwrap_or("");
    let preparation = if preparation == State::Present && credential_state == "present" {
        fact("present", "preparation_ready")
    } else if preparation == State::Absent {
        fact("absent", "native_unavailable")
    } else if credential_state == "absent" {
        fact("absent", "credentials_missing")
    } else {
        fact("unknown", "preparation_unknown")
    };
    let diagnostics = diagnostics
        .into_iter()
        .map(|d| {
            let mut o = J::obj([
                ("code", J::str(d.code)),
                ("probe", J::str(d.probe)),
                ("message", J::Str(d.message)),
            ]);
            if let Some(c) = d.candidate {
                o.set("candidate", J::Str(c));
            }
            o
        })
        .collect();
    J::obj([
        ("schemaVersion", J::str(RESPONSE_VERSION)),
        ("ok", J::Bool(true)),
        (
            "harness",
            J::obj([
                ("requested", J::str(requested)),
                ("modelProvider", J::str(provider)),
            ]),
        ),
        ("registration", fact("present", "registered")),
        (
            "nativeRuntime",
            match native {
                State::Present => fact("present", "native_available"),
                State::Absent => fact("absent", "native_unavailable"),
                State::Unknown => fact("unknown", "detection_failed"),
            },
        ),
        ("credentials", credentials),
        ("preparation", preparation),
        ("diagnostics", J::Arr(diagnostics)),
    ])
}

fn failure(code: &str, message: &str) -> J {
    J::obj([
        ("schemaVersion", J::str(RESPONSE_VERSION)),
        ("ok", J::Bool(false)),
        (
            "failure",
            J::obj([
                ("kind", J::str("incompatible")),
                ("code", J::str(code)),
                ("message", J::str(message)),
            ]),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_hrcpty_uses_codex_credentials() {
        let env = Env::from([("HOME".into(), "/nonexistent/T-12163".into())]);
        assert_eq!(
            credentials("codex-hrcpty", &env),
            credentials("codex", &env)
        );
        let with_key = Env::from([("OPENAI_API_KEY".into(), "test".into())]);
        assert_eq!(
            credentials("codex-hrcpty", &with_key),
            credentials("codex", &with_key)
        );
    }

    #[test]
    fn semver_is_the_leftmost_match() {
        assert_eq!(parse_semver("codex-cli 0.144.4"), Some([0.0, 144.0, 4.0]));
        assert_eq!(parse_semver("v1.2 then 3.4.5.6"), Some([3.0, 4.0, 5.0]));
        assert_eq!(parse_semver("a12.3.4"), Some([12.0, 3.0, 4.0]));
        assert_eq!(parse_semver("1.2."), None);
        assert!(compare_semver([0.0, 124.0, 0.0], MIN_CODEX_VERSION).is_ge());
        assert!(compare_semver([0.0, 99.0, 9.0], MIN_CODEX_VERSION).is_lt());
    }

    #[test]
    fn probes_bound_time_and_output() {
        let env = exec_environment();
        let ok = bounded_probe("/bin/sh", &["-c", "echo hi; echo err >&2"], 3000, env).unwrap();
        assert!(
            matches!(ok, Probe::Ok { ref stdout, ref stderr } if stdout == "hi\n" && stderr == "err\n")
        );
        let slow = bounded_probe("/bin/sh", &["-c", "sleep 5"], 100, env).unwrap();
        assert!(
            matches!(slow, Probe::Failed { code: "probe_timeout", ref message } if message == "Probe exceeded 100ms")
        );
        let big = bounded_probe("/bin/sh", &["-c", "head -c 70000 /dev/zero"], 3000, env).unwrap();
        assert!(matches!(
            big,
            Probe::Failed {
                code: "probe_output_limit",
                ..
            }
        ));
        let bad = bounded_probe("/bin/sh", &["-c", "echo nope >&2; exit 3"], 3000, env).unwrap();
        assert!(
            matches!(bad, Probe::Failed { code: "probe_exit_nonzero", ref message } if message == "nope")
        );
        let missing = bounded_probe("/bin/sh", &["-c", "exit 127"], 3000, env).unwrap();
        assert!(
            matches!(missing, Probe::Failed { code: "probe_failed", ref message } if message == "Probe exited 127")
        );
        // Bun.spawn's own message for a spawn that fails (T-13048).
        let absent = bounded_probe("/nonexistent/probe", &[], 3000, env).unwrap();
        assert!(matches!(
            absent,
            Probe::Failed { code: "probe_failed", ref message }
                if message == "ENOENT: no such file or directory, posix_spawn '/nonexistent/probe'"
        ));
    }
}
