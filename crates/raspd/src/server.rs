//! The aspc listener. Each client connection is framed with Bun's rules; each
//! frame is routed on its own: the four native methods are answered here, the
//! two native reads (R2) on a blocking thread beside the read loop, and
//! everything else is relayed verbatim to Bun over an upstream connection tied
//! to this client connection (order of requests and their ids preserved,
//! replies unmodified). A read raspd will not judge is relayed the same way,
//! with its fallback reason logged and counted.
use crate::json::{J, js_number, quoted};
use crate::logs::{Log, now_iso};
use crate::metrics::{Metrics, client_label};
use crate::native::{self, FrontDoor};
use crate::protocol::{self, Completion, Frame, MAX_FRAME_BYTES};
use crate::reads::{self, Answer};
use crate::release::Release;
use aspd_domain::{CompileRecord, Observations};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Notify, mpsc};

const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Shared {
    pub release: Release,
    pub upstream: PathBuf,
    pub upstream_display: String,
    pub log: Log,
    pub metrics: Option<Metrics>,
    pub observations: Arc<Observations>,
    admitting: AtomicBool,
    /// Relayed requests not yet answered, plus reply lines not yet written.
    outstanding: AtomicUsize,
    drained: Notify,
    next_conn: AtomicU64,
    next_entry: AtomicU64,
    rejected_compiles: AtomicU64,
}

impl Shared {
    pub fn new(
        release: Release,
        upstream: PathBuf,
        log: Log,
        metrics: Option<Metrics>,
        observations: Arc<Observations>,
    ) -> Arc<Shared> {
        Arc::new(Shared {
            release,
            upstream_display: upstream.display().to_string(),
            upstream,
            log,
            metrics,
            observations,
            admitting: AtomicBool::new(true),
            outstanding: AtomicUsize::new(0),
            drained: Notify::new(),
            next_conn: AtomicU64::new(1),
            next_entry: AtomicU64::new(1),
            rejected_compiles: AtomicU64::new(0),
        })
    }

    fn acquire(&self) {
        self.outstanding.fetch_add(1, Ordering::AcqRel);
    }
    fn release_one(&self) {
        if self.outstanding.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.drained.notify_waiters();
        }
    }

    /// Stop admitting, then wait until every relayed request has its reply and
    /// every reply is written (or `limit` passes).
    pub async fn retire(&self, limit: Duration) {
        self.admitting.store(false, Ordering::Release);
        let deadline = Instant::now() + limit;
        loop {
            let notified = self.drained.notified();
            if self.outstanding.load(Ordering::Acquire) == 0 || Instant::now() >= deadline {
                return;
            }
            let _ = tokio::time::timeout(Duration::from_millis(100), notified).await;
        }
    }

    pub fn outstanding(&self) -> usize {
        self.outstanding.load(Ordering::Acquire)
    }
}

/// Reclaim a stale socket node; refuse one a live listener answers on.
pub fn reclaim_stale_socket(path: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_err() {
        return Ok(());
    }
    if std::os::unix::net::UnixStream::connect(path).is_ok() {
        return Err(format!(
            "aspd socket already served by a live listener: {}",
            path.display()
        ));
    }
    let _ = std::fs::remove_file(path);
    Ok(())
}

pub async fn serve(shared: Arc<Shared>, listener: UnixListener, stop: Arc<Notify>) {
    loop {
        tokio::select! {
            _ = stop.notified() => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    if !shared.admitting.load(Ordering::Acquire) {
                        continue;
                    }
                    let id = shared.next_conn.fetch_add(1, Ordering::Relaxed);
                    tokio::spawn(Connection::run(shared.clone(), stream, id));
                }
                Err(error) => {
                    shared.log.event("error", "rpc", "rpc.accept_failed", vec![("error".into(), J::str(error.to_string()))]);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        }
    }
}

/// One relayed request awaiting Bun's reply.
struct Entry {
    seq: u64,
    generation: u64,
    method: String,
    client: String,
    id: Option<J>,
    started: Instant,
    /// Why a native read was relayed instead.
    fallback: Option<&'static str>,
}

#[derive(Default)]
struct Pending {
    by_id: HashMap<String, VecDeque<Entry>>,
    /// Frames raspd could not parse: matched to replies Bun sends for ids it
    /// has nothing pending under.
    unjudged: VecDeque<Entry>,
}

impl Pending {
    fn take(&mut self, key: Option<&str>) -> Option<Entry> {
        if let Some(key) = key
            && let Some(queue) = self.by_id.get_mut(key)
        {
            let entry = queue.pop_front();
            if queue.is_empty() {
                self.by_id.remove(key);
            }
            if entry.is_some() {
                return entry;
            }
        }
        self.unjudged.pop_front()
    }
    fn remove_seq(&mut self, seq: u64) -> Option<Entry> {
        if let Some(pos) = self.unjudged.iter().position(|e| e.seq == seq) {
            return self.unjudged.remove(pos);
        }
        for queue in self.by_id.values_mut() {
            if let Some(pos) = queue.iter().position(|e| e.seq == seq) {
                return queue.remove(pos);
            }
        }
        None
    }
    fn drain_generation(&mut self, generation: u64) -> Vec<Entry> {
        let mut out = vec![];
        for queue in self.by_id.values_mut() {
            let (gone, keep): (Vec<_>, Vec<_>) =
                queue.drain(..).partition(|e| e.generation == generation);
            out.extend(gone);
            queue.extend(keep);
        }
        self.by_id.retain(|_, q| !q.is_empty());
        let (gone, keep): (Vec<_>, Vec<_>) = self
            .unjudged
            .drain(..)
            .partition(|e| e.generation == generation);
        out.extend(gone);
        self.unjudged.extend(keep);
        out
    }
    fn is_empty(&self) -> bool {
        self.by_id.is_empty() && self.unjudged.is_empty()
    }
}

struct Upstream {
    generation: u64,
    alive: Arc<AtomicBool>,
    frames: mpsc::UnboundedSender<Vec<u8>>,
    reader: tokio::task::AbortHandle,
}

struct Connection {
    shared: Arc<Shared>,
    id: u64,
    replies: mpsc::UnboundedSender<Vec<u8>>,
    pending: Mutex<Pending>,
    settled: Notify,
    upstream: tokio::sync::Mutex<Option<Upstream>>,
    generations: AtomicU64,
    usage: Mutex<(u64, String)>,
    /// Native reads still running.
    reading: AtomicUsize,
}

fn id_key_json(id: &J) -> String {
    match id {
        J::Str(s) => quoted(s),
        J::Num(n) => js_number(*n),
        _ => "null".into(),
    }
}

/// Where the id token ends in `rest` (what follows `"id":`).
fn id_token_end(rest: &[u8]) -> Option<usize> {
    if rest.first() == Some(&b'"') {
        let mut i = 1;
        while i < rest.len() {
            match rest[i] {
                b'\\' => i += 2,
                b'"' => return Some(i + 1),
                _ => i += 1,
            }
        }
        None
    } else {
        rest.iter().position(|b| *b == b',' || *b == b'}')
    }
}

/// The id token of a reply line. Bun writes `{"jsonrpc":"2.0","id":…`, so the
/// id is read from that prefix and the (possibly large) body is not needed.
fn reply_id_key(line: &[u8]) -> Option<String> {
    let rest = line.strip_prefix(br#"{"jsonrpc":"2.0","id":"#)?;
    let end = id_token_end(rest)?;
    let token = rest.get(..end)?;
    match serde_json::from_slice::<serde_json::Value>(token).ok()? {
        serde_json::Value::String(s) => Some(quoted(&s)),
        serde_json::Value::Number(n) => Some(js_number(n.as_f64()?)),
        serde_json::Value::Null => Some("null".into()),
        _ => None,
    }
}

/// The byte length of a reply line's `result` or `error` value: Bun's
/// `replyBytes`, without re-serializing a (possibly large) compile result.
fn reply_body_bytes(line: &[u8]) -> Option<usize> {
    let rest = line.strip_prefix(br#"{"jsonrpc":"2.0","id":"#)?;
    let id_end = id_token_end(rest)?;
    let after = rest.get(id_end..)?;
    let body = after
        .strip_prefix(br#","result":"#)
        .or_else(|| after.strip_prefix(br#","error":"#))?;
    body.len().checked_sub(1)
}

impl Connection {
    async fn run(shared: Arc<Shared>, stream: UnixStream, id: u64) {
        let (mut reader, mut writer) = stream.into_split();
        let (replies, mut queue) = mpsc::unbounded_channel::<Vec<u8>>();
        let writer_shared = shared.clone();
        let writer_task = tokio::spawn(async move {
            let mut broken = false;
            while let Some(line) = queue.recv().await {
                if !broken && writer.write_all(&line).await.is_err() {
                    broken = true;
                }
                writer_shared.release_one();
            }
            let _ = writer.shutdown().await;
        });
        let conn = Arc::new(Connection {
            shared: shared.clone(),
            id,
            replies,
            pending: Mutex::new(Pending::default()),
            settled: Notify::new(),
            upstream: tokio::sync::Mutex::new(None),
            generations: AtomicU64::new(0),
            usage: Mutex::new((0, "unknown".into())),
            reading: AtomicUsize::new(0),
        });
        conn.read_loop(&mut reader).await;
        // EOF: answer what is in flight, then close.
        loop {
            let notified = conn.settled.notified();
            if conn.reading.load(Ordering::Acquire) == 0
                && conn
                    .pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_empty()
            {
                break;
            }
            notified.await;
        }
        if let Some(upstream) = conn.upstream.lock().await.take() {
            // Nothing is pending on it: close it, and drop the reader's hold
            // on this connection so the reply queue can close.
            upstream.alive.store(false, Ordering::Release);
            upstream.reader.abort();
        }
        let (requests, client) = conn.usage.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(metrics) = &shared.metrics {
            metrics.count(
                "connection",
                &[("client", &client)],
                &[("requests", requests as f64)],
            );
        }
        drop(conn);
        let _ = writer_task.await;
    }

    async fn read_loop(self: &Arc<Self>, reader: &mut tokio::net::unix::OwnedReadHalf) {
        let mut buf = vec![0u8; 64 * 1024];
        let mut frame: Vec<u8> = vec![];
        let mut frame_bytes = 0usize;
        let mut discarding = false;
        loop {
            let n = match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let mut offset = 0;
            while offset < n {
                let chunk = &buf[offset..n];
                let newline = chunk.iter().position(|b| *b == b'\n');
                let part = &chunk[..newline.unwrap_or(chunk.len())];
                if !discarding {
                    frame_bytes += part.len();
                    if frame_bytes > MAX_FRAME_BYTES {
                        frame.clear();
                        frame.shrink_to(64 * 1024);
                        discarding = true;
                        self.refuse_frame("frame_too_large");
                    } else {
                        frame.extend_from_slice(part);
                    }
                }
                if newline.is_some() {
                    if !discarding {
                        let line = std::mem::take(&mut frame);
                        if line.is_empty() || line == b"\r" {
                            self.refuse_frame("empty_frame");
                        } else {
                            self.dispatch(line, false).await;
                        }
                    }
                    frame.clear();
                    frame_bytes = 0;
                    discarding = false;
                }
                offset += part.len() + usize::from(newline.is_some());
            }
        }
        // Bun's EOF rule: a bounded trailing partial frame is decoded; one that
        // does not parse is dropped without a reply.
        if !discarding && !frame.is_empty() {
            self.dispatch(frame, true).await;
        }
    }

    fn send(&self, mut line: Vec<u8>) {
        line.push(b'\n');
        self.shared.acquire();
        if self.replies.send(line).is_err() {
            self.shared.release_one();
        }
    }

    fn refuse_frame(&self, reason: &str) {
        if !self.admitting() {
            return;
        }
        let line = protocol::frame_refusal(reason);
        let message = match reason {
            "empty_frame" => "Empty NDJSON frame".to_owned(),
            "frame_too_large" => format!("NDJSON frame exceeds {MAX_FRAME_BYTES} bytes"),
            _ => "Parse error".to_owned(),
        };
        let bytes = reply_body_bytes(line.as_bytes());
        self.send(line.into_bytes());
        self.complete(
            "unmatched",
            "unknown",
            Duration::ZERO,
            &protocol::unmatched_completion(&message),
            "native",
            None,
            None,
            bytes,
        );
    }

    fn admitting(&self) -> bool {
        self.shared.admitting.load(Ordering::Acquire)
    }

    async fn dispatch(self: &Arc<Self>, line: Vec<u8>, at_eof: bool) {
        if !self.admitting() {
            self.shared.log.event(
                "warn",
                "rpc",
                "request.refused-retiring",
                vec![("conn".into(), J::Num(self.id as f64))],
            );
            return;
        }
        match protocol::classify(&line) {
            Frame::Request(request) if native::is_native(&request.method) => {
                let started = Instant::now();
                let door = FrontDoor {
                    release: &self.shared.release,
                    upstream_socket: &self.shared.upstream_display,
                    upstream_state: self.shared.observations.upstream_state(),
                };
                let reply =
                    native::answer(&door, &request.id, &request.method, request.params.as_ref());
                let completion = protocol::completion(
                    &serde_json::from_str(&reply).unwrap_or(serde_json::Value::Null),
                );
                let bytes = reply_body_bytes(reply.as_bytes());
                // Observed before the reply leaves, so a client that has its
                // answer can rely on the kernel's next run including it.
                self.shared.observations.native(&request.method);
                self.send(reply.into_bytes());
                self.complete(
                    &request.method,
                    &request.client,
                    started.elapsed(),
                    &completion,
                    "native",
                    None,
                    None,
                    bytes,
                );
            }
            Frame::Request(request)
                if reads::is_read(&request.method) || request.method == crate::compile::METHOD =>
            {
                self.reading.fetch_add(1, Ordering::AcqRel);
                self.shared.acquire();
                let conn = self.clone();
                tokio::spawn(async move {
                    conn.read_natively(request, line).await;
                    conn.reading.fetch_sub(1, Ordering::AcqRel);
                    conn.shared.release_one();
                    conn.settled.notify_waiters();
                });
            }
            Frame::Request(request) => {
                self.forward(Some(request), line, None).await;
            }
            Frame::Silent => {}
            Frame::Malformed if at_eof => {}
            Frame::Malformed => self.refuse_frame("parse_error"),
            Frame::Unjudged if at_eof => {}
            Frame::Unjudged => self.forward(None, line, None).await,
        }
    }

    /// Answer a native read, or relay it when raspd will not judge the input.
    async fn read_natively(self: &Arc<Self>, request: protocol::Request, line: Vec<u8>) {
        let started = Instant::now();
        let (method, params) = (request.method.clone(), request.params.clone());
        let release = self.shared.release.clone();
        let answer = tokio::task::spawn_blocking(move || {
            if method == crate::compile::METHOD {
                crate::compile::handle(params.as_ref(), &release)
            } else {
                reads::handle(&method, params.as_ref())
            }
        })
        .await;
        let fallback = match answer {
            Ok(Answer::Result(result)) => {
                let reply = protocol::result_line(&request.id, &result);
                let completion = protocol::completion(
                    &serde_json::from_str(&reply).unwrap_or(serde_json::Value::Null),
                );
                let bytes = reply_body_bytes(reply.as_bytes());
                self.shared.observations.native(&request.method);
                self.send(reply.into_bytes());
                self.complete(
                    &request.method,
                    &request.client,
                    started.elapsed(),
                    &completion,
                    "native",
                    None,
                    None,
                    bytes,
                );
                return;
            }
            Ok(Answer::Forward(reason)) => reason,
            // A panic is a raspd defect; Bun still answers.
            Err(_) => "native_panic",
        };
        self.shared.log.event(
            "info",
            "rpc",
            "native.fallback",
            vec![
                ("conn".into(), J::Num(self.id as f64)),
                ("op".into(), J::str(&request.method)),
                ("reason".into(), J::str(fallback)),
            ],
        );
        self.forward(Some(request), line, Some(fallback)).await;
    }

    async fn forward(
        self: &Arc<Self>,
        request: Option<protocol::Request>,
        mut frame: Vec<u8>,
        fallback: Option<&'static str>,
    ) {
        let (method, client, id) = match &request {
            Some(r) => (r.method.clone(), r.client.clone(), Some(r.id.clone())),
            None => ("unparsed".to_owned(), "unknown".to_owned(), None),
        };
        let started = Instant::now();
        let upstream = match self.upstream().await {
            Ok(u) => u,
            Err(error) => {
                self.upstream_failed(method, client, id, started, &error, fallback);
                return;
            }
        };
        let seq = self.shared.next_entry.fetch_add(1, Ordering::Relaxed);
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            let entry = Entry {
                seq,
                generation: upstream.0,
                method: method.clone(),
                client: client.clone(),
                id: id.clone(),
                started,
                fallback,
            };
            match &id {
                Some(id) => pending
                    .by_id
                    .entry(id_key_json(id))
                    .or_default()
                    .push_back(entry),
                None => pending.unjudged.push_back(entry),
            }
        }
        self.shared.acquire();
        frame.push(b'\n');
        let sent =
            upstream.1.alive.load(Ordering::Acquire) && upstream.1.frames.send(frame).is_ok();
        if !sent {
            // Whoever removes the entry owns its reply; the upstream's own
            // failure sweep may already have answered it.
            let entry = self
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove_seq(seq);
            if let Some(entry) = entry {
                self.shared.release_one();
                self.upstream_failed(
                    entry.method,
                    entry.client,
                    entry.id,
                    entry.started,
                    "upstream connection closed",
                    entry.fallback,
                );
                self.settled.notify_waiters();
            }
        }
    }

    /// The live upstream for this connection, connecting a new one if needed.
    async fn upstream(self: &Arc<Self>) -> Result<(u64, UpstreamRef), String> {
        let mut slot = self.upstream.lock().await;
        if let Some(u) = slot.as_ref()
            && u.alive.load(Ordering::Acquire)
        {
            return Ok((
                u.generation,
                UpstreamRef {
                    alive: u.alive.clone(),
                    frames: u.frames.clone(),
                },
            ));
        }
        let stream = match tokio::time::timeout(
            UPSTREAM_CONNECT_TIMEOUT,
            UnixStream::connect(&self.shared.upstream),
        )
        .await
        {
            Ok(Ok(stream)) => stream,
            Ok(Err(error)) => {
                return Err(format!("connect {}: {error}", self.shared.upstream_display));
            }
            Err(_) => {
                return Err(format!(
                    "connect {}: timed out",
                    self.shared.upstream_display
                ));
            }
        };
        let generation = self.generations.fetch_add(1, Ordering::Relaxed) + 1;
        let alive = Arc::new(AtomicBool::new(true));
        let (frames, mut queue) = mpsc::unbounded_channel::<Vec<u8>>();
        let (read_half, mut write_half) = stream.into_split();
        let writer_alive = alive.clone();
        tokio::spawn(async move {
            while let Some(frame) = queue.recv().await {
                if write_half.write_all(&frame).await.is_err() {
                    writer_alive.store(false, Ordering::Release);
                    break;
                }
            }
            let _ = write_half.shutdown().await;
        });
        let conn = self.clone();
        let reader_alive = alive.clone();
        let reader = tokio::spawn(async move {
            conn.relay_replies(read_half, generation).await;
            reader_alive.store(false, Ordering::Release);
            let failed = conn
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .drain_generation(generation);
            if !failed.is_empty() {
                let reason = "upstream closed before replying";
                for entry in failed {
                    conn.shared.release_one();
                    conn.upstream_failed(
                        entry.method,
                        entry.client,
                        entry.id,
                        entry.started,
                        reason,
                        entry.fallback,
                    );
                }
            }
            conn.settled.notify_waiters();
        });
        *slot = Some(Upstream {
            generation,
            alive: alive.clone(),
            frames: frames.clone(),
            reader: reader.abort_handle(),
        });
        Ok((generation, UpstreamRef { alive, frames }))
    }

    async fn relay_replies(
        self: &Arc<Self>,
        read_half: tokio::net::unix::OwnedReadHalf,
        generation: u64,
    ) {
        let mut reader = BufReader::with_capacity(256 * 1024, read_half);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            if line.last() != Some(&b'\n') {
                return; // a torn final line is not a reply
            }
            line.pop();
            let key = reply_id_key(&line);
            let entry = self
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take(key.as_deref());
            let reply: serde_json::Value =
                serde_json::from_slice(&line).unwrap_or(serde_json::Value::Null);
            let bytes = reply_body_bytes(&line);
            let Some(entry) = entry else {
                self.send(std::mem::take(&mut line));
                continue;
            };
            debug_assert_eq!(entry.generation, generation);
            let completion = protocol::completion(&reply);
            let elapsed = entry.started.elapsed();
            let compile = (entry.method == "aspc.compileHarnessInvocation")
                .then(|| self.compile_record(&reply, &completion, elapsed));
            self.shared
                .observations
                .relayed(&entry.method, &now_iso(), compile);
            self.send(std::mem::take(&mut line));
            self.shared.release_one();
            self.complete(
                &entry.method,
                &entry.client,
                elapsed,
                &completion,
                "bun",
                Some("relayed"),
                entry.fallback,
                bytes,
            );
            self.settled.notify_waiters();
        }
    }

    fn compile_record(
        &self,
        reply: &serde_json::Value,
        completion: &Completion,
        elapsed: Duration,
    ) -> CompileRecord {
        let plan = &reply["result"]["plan"];
        let text = |v: &serde_json::Value| v.as_str().map(str::to_owned);
        let compile_id = text(&plan["compileId"]).unwrap_or_else(|| {
            format!(
                "rejected-{}",
                self.shared
                    .rejected_compiles
                    .fetch_add(1, Ordering::Relaxed)
                    + 1
            )
        });
        CompileRecord {
            compile_id,
            plan_hash: text(&plan["planHash"]),
            recipe: text(&plan["execution"]["recipeId"]),
            outcome: completion.outcome.clone(),
            served_by: "bun".into(),
            duration_ms: elapsed.as_millis() as u64,
            completed_at: now_iso(),
        }
    }

    fn upstream_failed(
        &self,
        method: String,
        client: String,
        id: Option<J>,
        started: Instant,
        detail: &str,
        fallback: Option<&'static str>,
    ) {
        let id = id.unwrap_or(J::Null);
        let reply = protocol::upstream_refusal(&id, &method, detail);
        let bytes = reply_body_bytes(reply.as_bytes());
        self.shared
            .observations
            .upstream_failed(&method, &now_iso(), detail);
        self.send(reply.into_bytes());
        self.shared.log.event(
            "warn",
            "rpc",
            "upstream.failed",
            vec![
                ("conn".into(), J::Num(self.id as f64)),
                ("op".into(), J::str(&method)),
                ("upstream".into(), J::str(&self.shared.upstream_display)),
                ("error".into(), J::str(detail)),
            ],
        );
        let completion = Completion {
            outcome: "-32603".into(),
            error_code: Some(-32603),
            message: Some(format!("aspd upstream unavailable: {detail}")),
        };
        self.complete(
            &method,
            &client,
            started.elapsed(),
            &completion,
            "bun",
            Some("upstream_failed"),
            fallback,
            bytes,
        );
    }

    /// The L3 `rpc.request` line and the metrics row, as Bun's
    /// `onRequestComplete` writes them, plus `servedBy` (and `relay` for Bun,
    /// and `fallback` for a native read relayed instead).
    #[allow(clippy::too_many_arguments)]
    fn complete(
        &self,
        op: &str,
        client: &str,
        elapsed: Duration,
        c: &Completion,
        served_by: &str,
        relay: Option<&str>,
        fallback: Option<&str>,
        reply_bytes: Option<usize>,
    ) {
        let ms = elapsed.as_secs_f64() * 1000.0;
        let level = if c.outcome == "ok" {
            "info"
        } else if c.error_code == Some(-32603) {
            "error"
        } else {
            "warn"
        };
        let mut data = vec![
            ("listener".to_owned(), J::str("raspd")),
            ("op".to_owned(), J::str(op)),
            ("client".to_owned(), J::str(client)),
            ("durationMs".to_owned(), J::Num((ms * 10.0).round() / 10.0)),
            ("outcome".to_owned(), J::str(&c.outcome)),
            ("servedBy".to_owned(), J::str(served_by)),
        ];
        if let Some(relay) = relay {
            data.push(("relay".into(), J::str(relay)));
        }
        if let Some(fallback) = fallback {
            data.push(("fallback".into(), J::str(fallback)));
        }
        if let Some(message) = &c.message {
            data.push(("code".into(), J::str(&c.outcome)));
            data.push(("message".into(), J::str(protocol::clip(message))));
        }
        self.shared.log.event(level, "rpc", "rpc.request", data);
        if let Some(metrics) = &self.shared.metrics {
            let label = client_label(client);
            {
                let mut usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
                usage.0 += 1;
                if usage.1 == "unknown" {
                    usage.1 = label.clone();
                }
            }
            let mut key = vec![
                ("op", op),
                ("client", label.as_str()),
                ("outcome", c.outcome.as_str()),
                ("servedBy", served_by),
            ];
            if let Some(relay) = relay {
                key.push(("relay", relay));
            }
            if let Some(fallback) = fallback {
                key.push(("fallback", fallback));
            }
            match reply_bytes {
                Some(bytes) => {
                    metrics.count("request", &key, &[("ms", ms), ("replyBytes", bytes as f64)])
                }
                None => metrics.count("request", &key, &[("ms", ms)]),
            }
        }
    }
}

struct UpstreamRef {
    alive: Arc<AtomicBool>,
    frames: mpsc::UnboundedSender<Vec<u8>>,
}

#[cfg(test)]
mod tests {
    use super::reply_id_key;

    #[test]
    fn reads_the_id_from_bun_reply_prefix() {
        assert_eq!(
            reply_id_key(br#"{"jsonrpc":"2.0","id":"a\"b","result":1}"#).as_deref(),
            Some(r#""a\"b""#)
        );
        assert_eq!(
            reply_id_key(br#"{"jsonrpc":"2.0","id":12,"result":1}"#).as_deref(),
            Some("12")
        );
        assert_eq!(
            reply_id_key(br#"{"jsonrpc":"2.0","id":null,"error":{}}"#).as_deref(),
            Some("null")
        );
    }
}
