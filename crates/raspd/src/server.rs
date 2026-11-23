//! The aspc listener. Each client connection is framed with Bun's rules; each
//! frame is routed on its own: the four native methods are answered here, the
//! native reads and compiles on a blocking thread beside the read loop, and
//! everything else is a forward. With an upstream (fronted mode) a forward is
//! relayed verbatim to Bun over an upstream connection tied to this client
//! connection (order of requests and their ids preserved, replies
//! unmodified), with its fallback reason logged and counted. Without one
//! (sole mode) `disposition::decide` answers it from the table.
//! The relay lives in `relay`; every reply's log line and metrics row in
//! `telemetry`.
mod relay;
mod telemetry;

use crate::disposition::{self, Decision, Reason};
use crate::json::J;
use crate::logs::Log;
use crate::metrics::Metrics;
use crate::native::{self, FrontDoor};
use crate::protocol::{self, Frame, MAX_FRAME_BYTES};
use crate::reads::{self, Answer};
use crate::release::Release;
use aspd_domain::Observations;
use relay::{Pending, Upstream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use telemetry::{Fallback, ReplyRoute, ReplyTelemetry};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Notify, mpsc};

pub struct Shared {
    pub release: Release,
    /// Bun aspd behind raspd (fronted mode); `None` is sole mode.
    pub upstream: Option<PathBuf>,
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
        upstream: Option<PathBuf>,
        log: Log,
        metrics: Option<Metrics>,
        observations: Arc<Observations>,
    ) -> Arc<Shared> {
        Arc::new(Shared {
            release,
            upstream_display: upstream
                .as_ref()
                .map(|u| u.display().to_string())
                .unwrap_or_default(),
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

    pub fn sole(&self) -> bool {
        self.upstream.is_none()
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
            if conn.reading.load(Ordering::Acquire) == 0 && conn.pending().is_empty() {
                break;
            }
            notified.await;
        }
        conn.close_upstream().await;
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
        let message = protocol::frame_refusal_message(reason);
        let bytes = protocol::reply_body_bytes(line.as_bytes());
        self.send(line.into_bytes());
        self.complete(
            "unmatched",
            "unknown",
            Duration::ZERO,
            ReplyTelemetry {
                completion: &protocol::unmatched_completion(&message),
                bytes,
                phases: None,
            },
            ReplyRoute::Native,
        );
    }

    fn admitting(&self) -> bool {
        self.shared.admitting.load(Ordering::Acquire)
    }

    /// Write a reply raspd produced for `request` and report it. The request
    /// is observed before the reply leaves, so a client that has its answer
    /// can rely on the kernel's next run including it.
    fn answer(
        &self,
        request: &protocol::Request,
        reply: String,
        started: Instant,
        phases: Option<J>,
        route: ReplyRoute<'_>,
    ) {
        let completion =
            protocol::completion(&serde_json::from_str(&reply).unwrap_or(serde_json::Value::Null));
        let bytes = protocol::reply_body_bytes(reply.as_bytes());
        self.shared.observations.native(&request.method);
        self.send(reply.into_bytes());
        self.complete(
            &request.method,
            &request.client,
            started.elapsed(),
            ReplyTelemetry {
                completion: &completion,
                bytes,
                phases,
            },
            route,
        );
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
                    upstream_socket: (!self.shared.sole())
                        .then_some(self.shared.upstream_display.as_str()),
                    upstream_state: self.shared.observations.upstream_state(),
                };
                let reply =
                    native::answer(&door, &request.id, &request.method, request.params.as_ref());
                self.answer(&request, reply, started, None, ReplyRoute::Native);
            }
            Frame::Request(request)
                if reads::is_read(&request.method)
                    || crate::compile::is_compile(&request.method) =>
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
                let reason = match request.method.as_str() {
                    "aspc.catalogAgentInspection" => {
                        crate::reason!("catalog_agent_inspection_unavailable")
                    }
                    "aspc.inspectAgentSelection" => {
                        crate::reason!("inspect_agent_selection_unavailable")
                    }
                    "aspc.prepareProcessInvocation" => {
                        crate::reason!("prepare_process_invocation_unsupported")
                    }
                    _ => crate::reason!("(non_native_method)"),
                };
                self.dispose(request, line, Instant::now(), reason, None)
                    .await;
            }
            Frame::Silent => {}
            Frame::Malformed if at_eof => {}
            Frame::Malformed => self.refuse_frame("parse_error"),
            Frame::Unjudged if at_eof => {}
            // Text JSON.parse throws on: Bun's parse error, in both modes.
            Frame::Unjudged => self.refuse_frame("parse_error"),
        }
    }

    /// A forward: relayed in fronted mode, answered from the disposition
    /// table in sole mode (and in both modes where its row says so).
    async fn dispose(
        self: &Arc<Self>,
        request: protocol::Request,
        line: Vec<u8>,
        started: Instant,
        reason: Reason,
        detail: Option<String>,
    ) {
        let decision = disposition::decide(
            self.shared.sole()
                || matches!(
                    request.method.as_str(),
                    "aspc.catalogAgents" | "aspc.inspectAgent"
                ),
            &request.id,
            &request.method,
            reason,
            detail.as_deref(),
        );
        let fallback = Fallback::of(reason, detail);
        let mut data = vec![
            ("conn".into(), J::Num(self.id as f64)),
            ("op".into(), J::str(&request.method)),
            ("reason".into(), J::str(fallback.reason)),
        ];
        if let Some(context) = reason.context() {
            data.push(("context".into(), J::str(context.as_str())));
        }
        if let Some(detail) = &fallback.detail {
            data.push(("fallbackDetail".into(), J::str(detail)));
        }
        match decision {
            // A method raspd never serves is relayed as before, unlabelled.
            Decision::Relay if reason.as_str().starts_with('(') => {
                self.forward(request, line, None).await;
            }
            Decision::Relay => {
                self.shared
                    .log
                    .event("info", "rpc", "native.fallback", data);
                self.forward(request, line, Some(fallback)).await;
            }
            Decision::Answer {
                line: reply,
                defect,
            } => {
                if defect {
                    self.shared.log.event("error", "rpc", "raspd.defect", data);
                } else {
                    self.shared.log.event("info", "rpc", "native.refused", data);
                }
                self.answer(
                    &request,
                    reply,
                    started,
                    None,
                    ReplyRoute::Refused(&fallback),
                );
            }
        }
    }

    /// Answer a native read, or relay it when raspd will not judge the input.
    async fn read_natively(self: &Arc<Self>, request: protocol::Request, line: Vec<u8>) {
        let started = Instant::now();
        let (method, params) = (request.method.clone(), request.params.clone());
        let release = self.shared.release.clone();
        let answer = tokio::task::spawn_blocking(move || {
            if crate::compile::is_compile(&method) {
                crate::compile::handle_method(&method, params.as_ref(), &release)
            } else {
                crate::compile::Compiled {
                    answer: reads::handle(&method, params.as_ref()),
                    fallback_detail: None,
                    phases: None,
                }
            }
        })
        .await;
        let (reason, detail) = match answer {
            Ok(crate::compile::Compiled {
                answer: Answer::Result(result),
                phases,
                ..
            }) => {
                let reply = protocol::result_line(&request.id, &result);
                self.answer(&request, reply, started, phases, ReplyRoute::Native);
                return;
            }
            Ok(crate::compile::Compiled {
                answer: Answer::Forward(reason),
                fallback_detail,
                ..
            }) => (reason, fallback_detail),
            // A panic is a raspd defect, answered -32603 in both modes.
            Err(_) => (crate::reason!("native_panic"), None),
        };
        self.dispose(request, line, started, reason, detail).await;
    }
}
