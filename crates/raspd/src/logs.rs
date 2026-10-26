//! raspd's own log, in the collective's L2 shape (`{ts, level, component,
//! event, data}`), written like Bun's `createAspdFileLog`: buffered off the
//! request path, appended (O_APPEND) every 250 ms so copytruncate rotation
//! leaves no gap, never rotated by raspd itself.
use crate::json::J;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAX_BUFFERED_BYTES: usize = 8 * 1024 * 1024;

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    iso(chrono::Utc::now())
}

pub fn iso(at: chrono::DateTime<chrono::Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn line(level: &str, component: &str, event: &str, data: Vec<(String, J)>) -> String {
    let mut fields = vec![
        ("ts".to_owned(), J::Str(now_iso())),
        ("level".to_owned(), J::str(level)),
        ("component".to_owned(), J::str(component)),
        ("event".to_owned(), J::str(event)),
    ];
    if !data.is_empty() {
        fields.push(("data".to_owned(), J::Obj(data)));
    }
    J::Obj(fields).to_json()
}

#[derive(Default)]
struct Pending {
    lines: Vec<String>,
    bytes: usize,
    dropped: u64,
}

#[derive(Clone)]
pub struct Log {
    path: Option<PathBuf>,
    pending: Arc<Mutex<Pending>>,
}

impl Log {
    /// A file log, or stderr when `path` is `None`.
    pub fn open(path: Option<PathBuf>) -> Log {
        let log = Log {
            path,
            pending: Arc::default(),
        };
        if log.path.is_some() {
            let flusher = log.clone();
            std::thread::Builder::new()
                .name("raspd-log".into())
                .spawn(move || {
                    loop {
                        std::thread::sleep(Duration::from_millis(250));
                        flusher.flush();
                    }
                })
                .expect("spawn log thread");
        }
        log
    }

    pub fn write(&self, line: String) {
        if self.path.is_none() {
            eprintln!("{line}");
            return;
        }
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let bytes = line.len() + 1;
        if pending.bytes + bytes > MAX_BUFFERED_BYTES {
            pending.dropped += 1;
            return;
        }
        pending.bytes += bytes;
        pending.lines.push(line);
    }

    pub fn event(&self, level: &str, component: &str, event: &str, data: Vec<(String, J)>) {
        self.write(line(level, component, event, data));
    }

    /// Lifecycle lines also go synchronously to stderr, the supervisor's file.
    pub fn lifecycle(&self, level: &str, event: &str, data: Vec<(String, J)>) {
        let text = line(level, "raspd", event, data);
        if self.path.is_some() {
            eprintln!("{text}");
        }
        self.write(text);
    }

    pub fn flush(&self) {
        let Some(path) = &self.path else { return };
        let chunk = {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            if pending.dropped > 0 {
                let dropped = pending.dropped;
                pending.dropped = 0;
                pending.lines.push(line(
                    "warn",
                    "log",
                    "log.dropped",
                    vec![("lines".into(), J::Num(dropped as f64))],
                ));
            }
            if pending.lines.is_empty() {
                return;
            }
            let mut chunk = pending.lines.join("\n");
            chunk.push('\n');
            pending.lines.clear();
            pending.bytes = 0;
            chunk
        };
        let written = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| f.write_all(chunk.as_bytes()));
        if let Err(error) = written {
            eprintln!(
                "{}",
                line(
                    "error",
                    "log",
                    "log.write_failed",
                    vec![
                        ("path".into(), J::str(path.display().to_string())),
                        ("error".into(), J::str(error.to_string())),
                    ],
                )
            );
            eprint!("{chunk}");
        }
    }
}
