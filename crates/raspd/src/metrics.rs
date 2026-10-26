//! Usage metrics day files in T-11824's format (core/config/src/usage-metrics):
//! `<var root>/state/agent-spaces/metrics/<component>-<YYYY-MM-DD>.ndjson`, one
//! row per (kind, key, UTC minute) with exact counts and `<measure>Sum/Max`.
//! 14-day retention by filename, a 64 MiB day-file cap, bounded state, and a
//! recording call that never fails and never touches the disk.
use crate::json::J;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const SUBDIR: &str = "state/agent-spaces/metrics";
pub const VAR_ROOT_ENV: &str = "ASP_USAGE_METRICS_VAR_ROOT";
const RETENTION_DAYS: i64 = 14;
const MAX_DAY_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_KEYS_PER_MINUTE: usize = 5_000;
const MAX_STRING_CHARS: usize = 128;
const MINUTE_MS: u64 = 60_000;

pub type Warn = Arc<dyn Fn(&str, Vec<(String, J)>) + Send + Sync>;

struct Bucket {
    kind: String,
    key: Vec<(String, String)>,
    count: u64,
    measures: Vec<(String, f64, f64)>,
}

struct State {
    buckets: BTreeMap<u64, BTreeMap<String, Bucket>>,
    unreported: u64,
    day_sizes: BTreeMap<String, u64>,
    cap_warned: Vec<String>,
    write_fail_warned: bool,
    pruned_day: Option<String>,
}

#[derive(Clone)]
pub struct Metrics {
    component: String,
    product: String,
    node: String,
    dir: PathBuf,
    warn: Warn,
    state: Arc<Mutex<State>>,
}

/// `label()`: line-safe and bounded.
pub fn label(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .take(64)
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._:/@+-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "unknown".into()
    } else {
        cleaned
    }
}

/// `usageMetricsLabel`: the first whitespace-separated token, labelled.
pub fn client_label(value: &str) -> String {
    match value.split_whitespace().next() {
        Some(token) => label(token),
        None => "unknown".into(),
    }
}

fn clean(value: &str) -> String {
    value
        .chars()
        .take(MAX_STRING_CHARS)
        .map(|c| if c.is_control() { '_' } else { c })
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn iso_ms(ms: u64) -> String {
    crate::logs::iso(chrono::DateTime::from_timestamp_millis(ms as i64).unwrap_or_default())
}

fn round1(value: f64) -> f64 {
    // JS Math.round: halves round toward +infinity.
    (value * 10.0 + 0.5).floor() / 10.0
}

fn hostname() -> String {
    let mut buf = [0u8; 256];
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return "unknown".into();
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

/// `<var root>/state/agent-spaces/metrics`: the scratch env override, then the
/// release's var root, then `~/praesidium/var`.
pub fn resolve_dir(var_root: Option<&Path>) -> PathBuf {
    let override_root = std::env::var(VAR_ROOT_ENV)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let root = override_root
        .or_else(|| var_root.map(Path::to_path_buf))
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("praesidium/var")
        });
    root.join(SUBDIR)
}

impl Metrics {
    pub fn new(component: &str, product: &str, dir: PathBuf, warn: Warn) -> Metrics {
        let metrics = Metrics {
            component: label(component),
            product: label(product),
            node: hostname(),
            dir,
            warn,
            state: Arc::new(Mutex::new(State {
                buckets: BTreeMap::new(),
                unreported: 0,
                day_sizes: BTreeMap::new(),
                cap_warned: vec![],
                write_fail_warned: false,
                pruned_day: None,
            })),
        };
        let flusher = metrics.clone();
        std::thread::Builder::new()
            .name("raspd-metrics".into())
            .spawn(move || {
                loop {
                    let delay = MINUTE_MS - (now_ms() % MINUTE_MS) + 100;
                    std::thread::sleep(Duration::from_millis(delay));
                    flusher.drain(false);
                }
            })
            .expect("spawn metrics thread");
        metrics
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Add one occurrence of `key` to the current minute.
    pub fn count(&self, kind: &str, key: &[(&str, &str)], measures: &[(&str, f64)]) {
        let minute = now_ms() / MINUTE_MS;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut sorted: Vec<_> = key.to_vec();
        sorted.sort_by(|a, b| a.0.cmp(b.0));
        let id = format!("{kind}\0{sorted:?}");
        let full = state
            .buckets
            .get(&minute)
            .is_some_and(|b| b.len() >= MAX_KEYS_PER_MINUTE && !b.contains_key(&id));
        if full {
            state.unreported += 1;
            return;
        }
        let bucket = state
            .buckets
            .entry(minute)
            .or_default()
            .entry(id)
            .or_insert_with(|| Bucket {
                kind: kind.to_owned(),
                key: key
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                    .collect(),
                count: 0,
                measures: vec![],
            });
        bucket.count += 1;
        for (name, value) in measures {
            if !value.is_finite() {
                continue;
            }
            match bucket.measures.iter_mut().find(|(n, _, _)| n == name) {
                Some(stat) => {
                    stat.1 += value;
                    stat.2 = stat.2.max(*value);
                }
                None => bucket.measures.push(((*name).to_owned(), *value, *value)),
            }
        }
    }

    fn row(&self, kind: &str, ts: &str, fields: Vec<(String, J)>) -> String {
        let mut body = vec![
            ("v".to_owned(), J::Num(1.0)),
            ("kind".to_owned(), J::str(kind)),
            ("ts".to_owned(), J::str(ts)),
            ("component".to_owned(), J::str(&self.component)),
            ("product".to_owned(), J::str(&self.product)),
            ("host".to_owned(), J::str("raspd")),
            ("pid".to_owned(), J::Num(std::process::id() as f64)),
            ("node".to_owned(), J::str(&self.node)),
        ];
        body.extend(fields.into_iter().map(|(k, v)| match v {
            J::Str(s) => (k, J::Str(clean(&s))),
            other => (k, other),
        }));
        let mut line = J::Obj(body).to_json();
        line.push('\n');
        line
    }

    /// Write completed minutes, or every minute when `all` (exit path).
    pub fn drain(&self, all: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let current = now_ms() / MINUTE_MS;
        let minutes: Vec<u64> = state
            .buckets
            .keys()
            .copied()
            .filter(|m| all || *m < current)
            .collect();
        // (day, line, is drop report)
        let mut rows: Vec<(String, String, u64)> = vec![];
        for minute in minutes {
            let Some(buckets) = state.buckets.remove(&minute) else {
                continue;
            };
            let start = minute * MINUTE_MS;
            let ts = iso_ms(start);
            for bucket in buckets.into_values() {
                let mut fields: Vec<(String, J)> = bucket
                    .key
                    .into_iter()
                    .map(|(k, v)| (k, J::Str(v)))
                    .collect();
                fields.push(("count".into(), J::Num(bucket.count as f64)));
                for (name, sum, max) in bucket.measures {
                    fields.push((format!("{name}Sum"), J::Num(round1(sum))));
                    fields.push((format!("{name}Max"), J::Num(round1(max))));
                }
                rows.push((ts[..10].to_owned(), self.row(&bucket.kind, &ts, fields), 0));
            }
        }
        if state.unreported > 0 {
            let ts = iso_ms(now_ms());
            let count = state.unreported;
            let line = self.row(
                "metrics.dropped",
                &ts,
                vec![("count".into(), J::Num(count as f64))],
            );
            rows.push((ts[..10].to_owned(), line, count));
        }
        if rows.is_empty() {
            return;
        }
        if let Err(error) = self.prepare(&mut state) {
            self.failed(&mut state, &rows, &error);
            return;
        }
        let mut days: BTreeMap<String, Vec<(String, u64)>> = BTreeMap::new();
        for (day, line, report) in rows {
            days.entry(day).or_default().push((line, report));
        }
        for (day, lines) in days {
            self.append(&mut state, &day, lines);
        }
    }

    fn file(&self, day: &str) -> PathBuf {
        self.dir.join(format!("{}-{day}.ndjson", self.component))
    }

    fn prepare(&self, state: &mut State) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let today = iso_ms(now_ms())[..10].to_owned();
        if state.pruned_day.as_deref() != Some(today.as_str()) {
            state.pruned_day = Some(today.clone());
            if let Err(error) = self.prune(&today) {
                (self.warn)(
                    "metrics.prune_failed",
                    vec![
                        ("component".into(), J::str(&self.component)),
                        ("dir".into(), J::str(self.dir.display().to_string())),
                        ("error".into(), J::Str(error)),
                    ],
                );
            }
        }
        Ok(())
    }

    fn prune(&self, today: &str) -> Result<(), String> {
        let today =
            chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d").map_err(|e| e.to_string())?;
        let cutoff = (today - chrono::Duration::days(RETENTION_DAYS - 1))
            .format("%Y-%m-%d")
            .to_string();
        let prefix = format!("{}-", self.component);
        for entry in std::fs::read_dir(&self.dir).map_err(|e| e.to_string())? {
            let name = entry.map_err(|e| e.to_string())?.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(date) = name
                .strip_prefix(&prefix)
                .and_then(|r| r.strip_suffix(".ndjson"))
            else {
                continue;
            };
            let is_date = date.len() == 10
                && date.bytes().enumerate().all(|(i, b)| {
                    if i == 4 || i == 7 {
                        b == b'-'
                    } else {
                        b.is_ascii_digit()
                    }
                });
            if is_date && date < cutoff.as_str() {
                std::fs::remove_file(self.dir.join(name)).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn append(&self, state: &mut State, day: &str, lines: Vec<(String, u64)>) {
        let file = self.file(day);
        let size = *state
            .day_sizes
            .entry(day.to_owned())
            .or_insert_with(|| std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0));
        let mut chunk = String::new();
        let mut capped = 0;
        let mut reported = 0;
        for (line, report) in &lines {
            if size + (chunk.len() + line.len()) as u64 > MAX_DAY_FILE_BYTES {
                if *report == 0 {
                    capped += 1;
                }
                continue;
            }
            chunk.push_str(line);
            reported += report;
        }
        if capped > 0 {
            state.unreported += capped;
            if !state.cap_warned.iter().any(|d| d == day) {
                state.cap_warned.push(day.to_owned());
                (self.warn)(
                    "metrics.cap_reached",
                    vec![
                        ("component".into(), J::str(&self.component)),
                        ("file".into(), J::str(file.display().to_string())),
                        ("maxBytes".into(), J::Num(MAX_DAY_FILE_BYTES as f64)),
                        ("dropped".into(), J::Num(capped as f64)),
                    ],
                );
            }
        }
        if chunk.is_empty() {
            return;
        }
        use std::io::Write;
        let written = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
            .and_then(|mut f| f.write_all(chunk.as_bytes()));
        match written {
            Ok(()) => {
                state
                    .day_sizes
                    .insert(day.to_owned(), size + chunk.len() as u64);
                state.unreported = state.unreported.saturating_sub(reported);
                state.write_fail_warned = false;
            }
            Err(error) => {
                state.day_sizes.remove(day);
                let rows: Vec<_> = lines
                    .into_iter()
                    .map(|(l, r)| (day.to_owned(), l, r))
                    .collect();
                self.failed(state, &rows, &error.to_string());
            }
        }
    }

    fn failed(&self, state: &mut State, rows: &[(String, String, u64)], error: &str) {
        let lost = rows.iter().filter(|(_, _, report)| *report == 0).count() as u64;
        state.unreported += lost;
        if !state.write_fail_warned {
            state.write_fail_warned = true;
            (self.warn)(
                "metrics.write_failed",
                vec![
                    ("component".into(), J::str(&self.component)),
                    ("dir".into(), J::str(self.dir.display().to_string())),
                    ("dropped".into(), J::Num(lost as f64)),
                    ("error".into(), J::str(error)),
                ],
            );
        }
    }
}
