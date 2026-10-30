//! `raspd`: aspd's Rust front door (docs/proposals/aspd-rust-front-door.md).
//!
//! raspd binds the node's public aspd socket. It answers `aspc.hello`,
//! `health`, `version` and `surface` itself and relays every other method,
//! verbatim, to Bun aspd on a private socket in the same namespace. It logs
//! every request it receives to its own files and serves an observation-only
//! cardo kernel on its own socket.
//!
//!     raspd serve --socket <abs> [--upstream <abs>] [--log <abs>]
//!                 [--kernel-socket <abs>] [--release-root <dir>]
//!                 [--metrics-dir <abs>]
//!
//! `--metrics-dir` puts the usage rows somewhere other than the release's
//! var root without touching the environment, which compiles hash (a raspd
//! compared against a node's own Bun aspd, T-11932).
mod compile;
mod json;
mod kernel;
mod logs;
mod metrics;
mod native;
mod protocol;
mod reads;
mod release;
mod server;

use aspd_domain::{Observations, ServiceInfo};
use json::J;
use logs::{Log, now_iso};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

const USAGE: &str = "raspd serve --socket <absolute-path> [--upstream <absolute-path>] [--log <absolute-path>] [--kernel-socket <absolute-path>] [--release-root <dir>] [--metrics-dir <absolute-path>]";
/// Bun's own retire bound (launchd ExitTimeOut is 180 s).
const RETIRE_LIMIT: Duration = Duration::from_secs(175);

struct Options {
    socket: PathBuf,
    upstream: PathBuf,
    log: Option<PathBuf>,
    kernel_socket: PathBuf,
    release_root: Option<PathBuf>,
    metrics_dir: Option<PathBuf>,
}

/// A supervised daemon: even a refused invocation is an L2 line on stderr.
fn refuse_usage(args: &[String]) -> ! {
    eprintln!(
        "{}",
        logs::line(
            "error",
            "raspd",
            "raspd.usage",
            vec![
                ("usage".into(), J::str(USAGE)),
                ("args".into(), J::Arr(args.iter().map(J::str).collect())),
            ],
        )
    );
    std::process::exit(1);
}

fn parse(args: &[String]) -> Options {
    let Some((command, rest)) = args.split_first() else {
        refuse_usage(args)
    };
    if command != "serve" {
        refuse_usage(args);
    }
    let mut socket = None;
    let mut upstream = None;
    let mut log = None;
    let mut kernel_socket = None;
    let mut release_root = None;
    let mut metrics_dir = None;
    let mut it = rest.iter();
    while let Some(flag) = it.next() {
        let value = it.next().map(PathBuf::from);
        let slot = match flag.as_str() {
            "--socket" => &mut socket,
            "--upstream" => &mut upstream,
            "--log" => &mut log,
            "--kernel-socket" => &mut kernel_socket,
            "--release-root" => &mut release_root,
            "--metrics-dir" => &mut metrics_dir,
            _ => refuse_usage(args),
        };
        match value {
            Some(v) if v.is_absolute() => *slot = Some(v),
            _ => refuse_usage(args),
        }
    }
    let socket: PathBuf = socket.unwrap_or_else(|| refuse_usage(args));
    let dir = socket.parent().map(Path::to_path_buf).unwrap_or_default();
    Options {
        upstream: upstream.unwrap_or_else(|| dir.join("aspd-bun.sock")),
        kernel_socket: kernel_socket.unwrap_or_else(|| dir.join("raspd-kernel.sock")),
        socket,
        log,
        release_root,
        metrics_dir,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--help" | "-h") => {
            println!("{USAGE}");
            return;
        }
        Some("--version") => {
            println!(
                "raspd {} ({})",
                env!("CARGO_PKG_VERSION"),
                native::RASPD_SOURCE_COMMIT
            );
            return;
        }
        _ => {}
    }
    let options = parse(&args);
    let log = Log::open(options.log.clone());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .expect("tokio runtime");
    let code = runtime.block_on(async {
        match serve(options, log.clone()).await {
            Ok(()) => 0,
            Err(error) => {
                log.lifecycle(
                    "error",
                    "raspd.fatal",
                    vec![("error".into(), J::Str(error))],
                );
                1
            }
        }
    });
    log.flush();
    std::process::exit(code);
}

async fn serve(options: Options, log: Log) -> Result<(), String> {
    let release_root = release::locate(options.release_root.as_deref())?;
    let release = release::read(&release_root)?;
    let warn_log = log.clone();
    let metrics = metrics::Metrics::new(
        "raspd",
        &format!("raspd/{}", release.release_id),
        options
            .metrics_dir
            .clone()
            .unwrap_or_else(|| metrics::resolve_dir(release::var_root(&release.root).as_deref())),
        Arc::new(move |event: &str, data| warn_log.event("warn", "metrics", event, data)),
    );
    let observations = Arc::new(Observations::new(ServiceInfo {
        role: "front".into(),
        release_id: release.release_id.clone(),
        source_commit: release.source_commit.clone(),
        built_at: release.built_at.clone(),
        raspd_source_commit: native::RASPD_SOURCE_COMMIT.into(),
        socket: options.socket.display().to_string(),
        upstream_socket: options.upstream.display().to_string(),
        pid: std::process::id(),
        started_at: now_iso(),
    }));

    server::reclaim_stale_socket(&options.socket)?;
    let listener = tokio::net::UnixListener::bind(&options.socket)
        .map_err(|e| format!("bind {}: {e}", options.socket.display()))?;
    let bound_inode = std::fs::metadata(&options.socket)
        .map(|m| std::os::unix::fs::MetadataExt::ino(&m))
        .ok();
    log.event(
        "info",
        "rpc",
        "rpc.listen",
        vec![
            ("listener".into(), J::str("raspd")),
            (
                "address".into(),
                J::str(options.socket.display().to_string()),
            ),
            (
                "upstream".into(),
                J::str(options.upstream.display().to_string()),
            ),
        ],
    );

    // The kernel is observation only: if it can't start, aspc still serves.
    // It goes first so tokio's signal handlers, registered right after it,
    // chain to the kernel's (kernel::start).
    let kernel = match kernel::start(observations.clone(), &options.kernel_socket, RETIRE_LIMIT) {
        Ok(kernel) => Some(kernel),
        Err(error) => {
            log.lifecycle(
                "error",
                "raspd.kernel_failed",
                vec![
                    (
                        "socket".into(),
                        J::str(options.kernel_socket.display().to_string()),
                    ),
                    ("error".into(), J::Str(error)),
                ],
            );
            None
        }
    };
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|e| e.to_string())?;
    let mut int = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(|e| e.to_string())?;

    let shared = server::Shared::new(
        release.clone(),
        options.upstream.clone(),
        log.clone(),
        Some(metrics.clone()),
        observations,
    );
    let stop = Arc::new(Notify::new());
    let accept = tokio::spawn(server::serve(shared.clone(), listener, stop.clone()));
    // The ready line (cardo embedding guide §3): accepting on both sockets.
    // One L2 line on stdout, which launchd sends to raspd.err.log.
    println!(
        "{}",
        logs::line(
            "info",
            "raspd",
            "raspd.ready",
            vec![
                ("status".into(), J::str("serving")),
                (
                    "socket".into(),
                    J::str(options.socket.display().to_string())
                ),
                (
                    "kernelSocket".into(),
                    J::str(options.kernel_socket.display().to_string())
                ),
                ("pid".into(), J::Num(std::process::id() as f64)),
            ],
        )
    );
    log.lifecycle(
        "info",
        "raspd.serving",
        vec![
            ("release".into(), J::str(&release.release_id)),
            ("sourceCommit".into(), J::str(&release.source_commit)),
            (
                "raspdSourceCommit".into(),
                J::str(native::RASPD_SOURCE_COMMIT),
            ),
            (
                "socket".into(),
                J::str(options.socket.display().to_string()),
            ),
            (
                "upstream".into(),
                J::str(options.upstream.display().to_string()),
            ),
            (
                "kernelSocket".into(),
                J::str(options.kernel_socket.display().to_string()),
            ),
            (
                "metricsDir".into(),
                J::str(metrics.dir().display().to_string()),
            ),
            ("pid".into(), J::Num(std::process::id() as f64)),
        ],
    );

    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }

    // Retire like Bun: stop admitting, remove our socket node (only if it is
    // still ours), let in-flight requests finish, then exit.
    log.event(
        "info",
        "raspd",
        "retire.begin",
        vec![("outstanding".into(), J::Num(shared.outstanding() as f64))],
    );
    stop.notify_waiters();
    let _ = accept.await;
    let still_ours = std::fs::metadata(&options.socket)
        .map(|m| Some(std::os::unix::fs::MetadataExt::ino(&m)) == bound_inode)
        .unwrap_or(false);
    if still_ours {
        let _ = std::fs::remove_file(&options.socket);
    }
    shared.retire(RETIRE_LIMIT).await;
    // The same signal stopped the kernel; its teardown removes its socket.
    if let Some(Err(error)) = kernel.map(kernel::Kernel::join) {
        log.lifecycle(
            "error",
            "raspd.kernel_teardown_failed",
            vec![("error".into(), J::Str(error))],
        );
    }
    metrics.drain(true);
    log.event("info", "raspd", "retire.drained", vec![]);
    log.lifecycle(
        "info",
        "raspd.exit",
        vec![("release".into(), J::str(&release.release_id))],
    );
    Ok(())
}
