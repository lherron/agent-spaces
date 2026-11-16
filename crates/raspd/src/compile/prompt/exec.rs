//! The exec a section runs: `execFile('bash', ['-c', command], { cwd, env,
//! timeout, maxBuffer: 1 MiB })` and `formatExecFailure`, measured against
//! Bun 1.3 (T-13048).
use super::Ctx;
use crate::compile::util::js_trim;
use crate::json::J;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Node's name for a signal, for the ones raspd words.
fn signal_name(signal: i32) -> Option<&'static str> {
    Some(match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        _ => return None,
    })
}

/// The trimmed stdout on exit 0, else `formatExecFailure` of the error Bun's
/// execFile raises (unbounded), or `None` where raspd has no wording for it.
pub(super) fn run_exec(
    command: &str,
    timeout_ms: f64,
    ctx: &Ctx,
) -> Result<String, Option<String>> {
    use std::os::unix::process::ExitStatusExt;
    const MAX_BUFFER: usize = 1024 * 1024;
    let mut cmd = Command::new("bash");
    // Bun: `execCwd ?? projectRoot ?? agentRoot` (no execCwd on a compile).
    let cwd = ctx
        .pinned
        .as_ref()
        .and_then(|p| p.context.get("execInputs"))
        .and_then(|i| i.get("cwd"))
        .and_then(J::as_str)
        .unwrap_or_else(|| ctx.project_root.as_deref().unwrap_or(&ctx.agent_root));
    cmd.arg("-c").arg(command).current_dir(cwd);
    if let Some(env) = &ctx.exec_env {
        cmd.env_clear().envs(env);
    }
    // Node leaves the child's stdin pipe open and unwritten.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|_| None)?;
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take().ok_or(None)?;
    let mut stderr = child.stderr.take().ok_or(None)?;
    let out_reader = std::thread::spawn(move || {
        let mut buf = vec![];
        let _ = (&mut stdout)
            .take(MAX_BUFFER as u64 + 1)
            .read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = vec![];
        let _ = (&mut stderr)
            .take(MAX_BUFFER as u64 + 1)
            .read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(0.0) as u64);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline && timeout_ms > 0.0 => {
                // SIGTERM, as Node's timeout kill does.
                unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
                timed_out = true;
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(2)),
            Err(_) => break None,
        }
    };
    drop(stdin);
    let out = out_reader.join().map_err(|_| None)?;
    let err = err_reader.join().map_err(|_| None)?;
    let status = status.ok_or(None)?;
    let stderr_text = String::from_utf8_lossy(&err).into_owned();
    // `stderr || error.message`; the message is `Command failed: <cmd>` (Bun
    // appends stderr to it only when there is some).
    let failure = |code: String, signal: &str, killed: bool| {
        let detail = if stderr_text.is_empty() {
            format!("Command failed: bash -c {command}")
        } else {
            stderr_text.clone()
        };
        Some(format!(
            "Exec failed; exit code: {code}; signal: {signal}; timeout: {killed}; stderr: {detail}"
        ))
    };
    if err.len() > MAX_BUFFER {
        return Err(None);
    }
    if out.len() > MAX_BUFFER {
        return Err(if stderr_text.is_empty() {
            Some(
                "Exec failed; exit code: ERR_CHILD_PROCESS_STDIO_MAXBUFFER; signal: none; \
                 timeout: false; stderr: stdout maxBuffer length exceeded"
                    .to_owned(),
            )
        } else {
            None
        });
    }
    if timed_out {
        return Err(failure("unknown".into(), "SIGTERM", true));
    }
    if let Some(code) = status.code() {
        if code != 0 {
            return Err(failure(code.to_string(), "none", false));
        }
    } else {
        let name = status.signal().and_then(signal_name).ok_or(None)?;
        return Err(failure("unknown".into(), name, false));
    }
    Ok(js_trim(&String::from_utf8_lossy(&out)).to_owned())
}

#[cfg(test)]
mod tests {
    use super::super::test_ctx;
    use super::*;

    #[test]
    fn exec_runs_bash_with_trimmed_stdout() {
        let mut c = test_ctx();
        c.agent_root = "/".into();
        c.project_root = None;
        assert_eq!(
            run_exec("printf '  hi \\n'", 5000.0, &c).ok().as_deref(),
            Some("hi")
        );
        // Bun 1.3's execFile errors, as formatExecFailure words them (T-13048).
        let reason = |cmd: &str, ms: f64| run_exec(cmd, ms, &c).err().flatten();
        assert_eq!(
            reason("exit 3", 5000.0).as_deref(),
            Some(
                "Exec failed; exit code: 3; signal: none; timeout: false; stderr: Command failed: bash -c exit 3"
            )
        );
        assert_eq!(
            reason("echo oops >&2; exit 3", 5000.0).as_deref(),
            Some("Exec failed; exit code: 3; signal: none; timeout: false; stderr: oops\n")
        );
        assert_eq!(
            reason("sleep 2", 100.0).as_deref(),
            Some(
                "Exec failed; exit code: unknown; signal: SIGTERM; timeout: true; stderr: Command failed: bash -c sleep 2"
            )
        );
        assert_eq!(
            reason("kill -9 $$", 5000.0).as_deref(),
            Some(
                "Exec failed; exit code: unknown; signal: SIGKILL; timeout: false; stderr: Command failed: bash -c kill -9 $$"
            )
        );
    }

    /// T-12023: exec runs in the project root when one is known, else agentRoot,
    /// matching Bun's `execCwd ?? projectRoot ?? agentRoot`.
    #[test]
    fn exec_runs_in_project_root_else_agent_root() {
        let base = std::env::temp_dir().join(format!("raspd-exec-cwd-{}", std::process::id()));
        let (project, agent) = (base.join("project"), base.join("agent"));
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&agent).unwrap();
        let real = |p: &std::path::Path| p.canonicalize().unwrap().to_string_lossy().into_owned();
        let (project_real, agent_real) = (real(&project), real(&agent));
        let mut c = test_ctx();
        c.agent_root = agent.to_string_lossy().into_owned();
        c.project_root = Some(project.to_string_lossy().into_owned());
        let in_project = run_exec("pwd -P", 5000.0, &c).ok();
        c.project_root = None;
        let no_project = run_exec("pwd -P", 5000.0, &c).ok();
        std::fs::remove_dir_all(&base).unwrap();
        assert_eq!(in_project, Some(project_real));
        assert_eq!(no_project, Some(agent_real));
    }
}
