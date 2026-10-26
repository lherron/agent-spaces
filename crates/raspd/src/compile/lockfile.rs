//! ASP_HOME's cross-process locks: `withLock` (core/config/src/core/locks.ts)
//! over proper-lockfile 4.1.2, reproduced so Bun and raspd exclude each other.
//!
//! The protocol: the locked file is created if missing and canonicalized with
//! realpath; the lock is the directory `<realpath>.lock`, taken by `mkdir`.
//! An existing lock is stale when its mtime is older than `stale` ms; a stale
//! lock is removed and the `mkdir` retried once. A held lock is refreshed by
//! touching its mtime every `update` ms (stale/2, clamped to [1000, stale/2]).
//! Acquisition retries `retries` times, 100 ms apart (retry with
//! minTimeout 100, maxTimeout 200, factor 1). Release removes the directory.
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

pub struct LockOptions {
    pub stale_ms: u64,
    pub retries: u32,
}

/// The materialization locks (`{ stale: 60_000, retries: 600 }`).
pub const MATERIALIZATION: LockOptions = LockOptions {
    stale_ms: 60_000,
    retries: 600,
};

#[derive(Debug)]
pub enum LockError {
    /// Still held by another process after every retry (`LockTimeoutError`).
    Held(String),
    Io(String),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            LockError::Held(p) => write!(f, "lock held: {p}"),
            LockError::Io(m) => write!(f, "{m}"),
        }
    }
}

struct Held {
    dir: PathBuf,
    done: Arc<(Mutex<bool>, Condvar)>,
    compromised: Arc<AtomicBool>,
    refresher: Option<thread::JoinHandle<()>>,
}

impl Drop for Held {
    fn drop(&mut self) {
        {
            let (lock, cvar) = &*self.done;
            *lock.lock().unwrap_or_else(|e| e.into_inner()) = true;
            cvar.notify_all();
        }
        if let Some(t) = self.refresher.take() {
            let _ = t.join();
        }
        if !self.compromised.load(Ordering::Acquire) {
            let _ = std::fs::remove_dir(&self.dir);
        }
    }
}

fn ensure_lock_file(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::metadata(path).is_err() {
        std::fs::write(path, b"")?;
    }
    Ok(())
}

fn mtime(meta: &std::fs::Metadata) -> SystemTime {
    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)
}

enum Attempt {
    Acquired,
    Locked,
}

fn try_acquire(dir: &Path, stale: Duration, check_stale: bool) -> io::Result<Attempt> {
    match std::fs::create_dir(dir) {
        Ok(()) => return Ok(Attempt::Acquired),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    if !check_stale {
        return Ok(Attempt::Locked);
    }
    let meta = match std::fs::metadata(dir) {
        Ok(m) => m,
        // Removed meanwhile: retry once without the stale check.
        Err(e) if e.kind() == io::ErrorKind::NotFound => return try_acquire(dir, stale, false),
        Err(e) => return Err(e),
    };
    let age = SystemTime::now()
        .duration_since(mtime(&meta))
        .unwrap_or_default();
    if age <= stale {
        return Ok(Attempt::Locked);
    }
    match std::fs::remove_dir(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    try_acquire(dir, stale, false)
}

fn set_mtime_now(dir: &Path) -> io::Result<()> {
    let file = std::fs::File::open(dir)?;
    let now = SystemTime::now();
    file.set_times(
        std::fs::FileTimes::new()
            .set_accessed(now)
            .set_modified(now),
    )
}

/// Run `f` holding the lock on `path`.
pub fn with_lock<T>(
    path: &str,
    options: &LockOptions,
    f: impl FnOnce() -> T,
) -> Result<T, LockError> {
    let held = acquire(path, options)?;
    let out = f();
    drop(held);
    Ok(out)
}

fn acquire(path: &str, options: &LockOptions) -> Result<Held, LockError> {
    let file = Path::new(path);
    ensure_lock_file(file).map_err(|e| LockError::Io(format!("{path}: {e}")))?;
    let canonical =
        std::fs::canonicalize(file).map_err(|e| LockError::Io(format!("{path}: {e}")))?;
    let mut dir = canonical.into_os_string();
    dir.push(".lock");
    let dir = PathBuf::from(dir);
    let stale_ms = options.stale_ms.max(2000);
    let stale = Duration::from_millis(stale_ms);
    let update = Duration::from_millis((stale_ms / 2).max(1000));
    let mut retries_left = options.retries;
    loop {
        match try_acquire(&dir, stale, true) {
            Ok(Attempt::Acquired) => break,
            Ok(Attempt::Locked) if retries_left > 0 => {
                retries_left -= 1;
                thread::sleep(Duration::from_millis(100));
            }
            Ok(Attempt::Locked) => return Err(LockError::Held(path.to_owned())),
            Err(e) => return Err(LockError::Io(format!("{}: {e}", dir.display()))),
        }
    }
    let done = Arc::new((Mutex::new(false), Condvar::new()));
    let compromised = Arc::new(AtomicBool::new(false));
    let refresher = {
        let (done, compromised, dir) = (done.clone(), compromised.clone(), dir.clone());
        thread::spawn(move || {
            let (lock, cvar) = &*done;
            let mut finished = lock.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                // Release may have notified before this thread first waited.
                if *finished {
                    return;
                }
                let (guard, timeout) = cvar
                    .wait_timeout(finished, update)
                    .unwrap_or_else(|e| e.into_inner());
                finished = guard;
                if *finished {
                    return;
                }
                if timeout.timed_out() && set_mtime_now(&dir).is_err() {
                    // proper-lockfile marks the lock compromised; the
                    // directory is no longer ours to remove.
                    compromised.store(true, Ordering::Release);
                    return;
                }
            }
        })
    };
    Ok(Held {
        dir,
        done,
        compromised,
        refresher: Some(refresher),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excludes_and_releases() {
        let base = std::env::temp_dir().join(format!("raspd-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let path = base.join("locks/x.lock");
        let path_s = path.to_string_lossy().into_owned();
        let quick = LockOptions {
            stale_ms: 10_000,
            retries: 0,
        };
        let inner = with_lock(&path_s, &quick, || {
            assert!(base.join("locks/x.lock.lock").is_dir());
            matches!(with_lock(&path_s, &quick, || ()), Err(LockError::Held(_)))
        })
        .unwrap();
        assert!(inner);
        assert!(!base.join("locks/x.lock.lock").exists());
        // A stale lock directory is taken over.
        std::fs::create_dir(base.join("locks/x.lock.lock")).unwrap();
        let old = SystemTime::now() - Duration::from_secs(60);
        std::fs::File::open(base.join("locks/x.lock.lock"))
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        assert!(with_lock(&path_s, &quick, || ()).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A release that lands before the refresher's first wait must not leave
    /// the lock held for a whole refresh interval (T-11882: 30 s stalls).
    #[test]
    fn release_is_prompt_when_it_beats_the_refresher() {
        let base = std::env::temp_dir().join(format!("raspd-lock-prompt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let path_s = base.join("locks/y.lock").to_string_lossy().into_owned();
        let options = LockOptions {
            stale_ms: 60_000,
            retries: 0,
        };
        for _ in 0..200 {
            let began = std::time::Instant::now();
            with_lock(&path_s, &options, || ()).unwrap();
            assert!(
                began.elapsed() < Duration::from_secs(1),
                "release took {:?}",
                began.elapsed()
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
