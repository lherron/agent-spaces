//! The upstream relay (fronted mode). Each client connection has its own
//! connection to Bun aspd, opened on its first forward and reopened as a new
//! generation after it closes. Frames go to Bun verbatim and in order; each
//! reply is matched to its request by id (oldest first under a repeated id)
//! and written back unmodified. A request Bun cannot answer, because it was
//! never reached or closed first, gets raspd's own upstream refusal.
use super::Connection;
use super::telemetry::{Fallback, ReplyRoute, ReplyTelemetry};
use crate::json::{J, js_number, quoted};
use crate::logs::now_iso;
use crate::protocol::{self, Completion};
use aspd_domain::CompileRecord;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, MutexGuard};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// One relayed request awaiting Bun's reply.
pub(super) struct Entry {
    seq: u64,
    generation: u64,
    method: String,
    client: String,
    id: J,
    started: Instant,
    /// Why a native read was relayed instead.
    fallback: Option<Fallback>,
}

/// Relayed requests awaiting replies, by id key.
#[derive(Default)]
pub(super) struct Pending(HashMap<String, VecDeque<Entry>>);

impl Pending {
    fn push(&mut self, entry: Entry) {
        self.0
            .entry(id_key_json(&entry.id))
            .or_default()
            .push_back(entry);
    }
    fn take(&mut self, key: &str) -> Option<Entry> {
        let queue = self.0.get_mut(key)?;
        let entry = queue.pop_front();
        if queue.is_empty() {
            self.0.remove(key);
        }
        entry
    }
    fn remove_seq(&mut self, seq: u64) -> Option<Entry> {
        for queue in self.0.values_mut() {
            if let Some(pos) = queue.iter().position(|e| e.seq == seq) {
                return queue.remove(pos);
            }
        }
        None
    }
    fn drain_generation(&mut self, generation: u64) -> Vec<Entry> {
        let mut out = vec![];
        for queue in self.0.values_mut() {
            let (gone, keep): (Vec<_>, Vec<_>) =
                queue.drain(..).partition(|e| e.generation == generation);
            out.extend(gone);
            queue.extend(keep);
        }
        self.0.retain(|_, q| !q.is_empty());
        out
    }
    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// How a request id is keyed: as `protocol::reply_id_key` reads a reply's.
fn id_key_json(id: &J) -> String {
    match id {
        J::Str(s) => quoted(s),
        J::Num(n) => js_number(*n),
        _ => "null".into(),
    }
}

/// The sending side of one upstream connection.
#[derive(Clone)]
struct Link {
    generation: u64,
    alive: Arc<AtomicBool>,
    frames: mpsc::UnboundedSender<Vec<u8>>,
}

/// A connection's current upstream: its link and its reply reader.
pub(super) struct Upstream {
    link: Link,
    reader: tokio::task::AbortHandle,
}

impl Connection {
    pub(super) fn pending(&self) -> MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Relay a forward to Bun, verbatim.
    pub(super) async fn forward(
        self: &Arc<Self>,
        request: protocol::Request,
        mut frame: Vec<u8>,
        fallback: Option<Fallback>,
    ) {
        let started = Instant::now();
        let link = match self.upstream().await {
            Ok(link) => link,
            Err(error) => {
                self.upstream_failed(
                    &request.method,
                    &request.client,
                    &request.id,
                    started,
                    &error,
                    fallback.as_ref(),
                );
                return;
            }
        };
        let seq = self.shared.next_entry.fetch_add(1, Ordering::Relaxed);
        self.pending().push(Entry {
            seq,
            generation: link.generation,
            method: request.method,
            client: request.client,
            id: request.id,
            started,
            fallback,
        });
        self.shared.acquire();
        frame.push(b'\n');
        let sent = link.alive.load(Ordering::Acquire) && link.frames.send(frame).is_ok();
        if !sent {
            // Whoever removes the entry owns its reply; the upstream's own
            // failure sweep may already have answered it.
            let entry = self.pending().remove_seq(seq);
            if let Some(entry) = entry {
                self.fail(entry, "upstream connection closed");
                self.settled.notify_waiters();
            }
        }
    }

    /// Close the upstream once nothing is pending on it, dropping the reader's
    /// hold on this connection so the reply queue can close.
    pub(super) async fn close_upstream(&self) {
        if let Some(upstream) = self.upstream.lock().await.take() {
            upstream.link.alive.store(false, Ordering::Release);
            upstream.reader.abort();
        }
    }

    /// The live upstream for this connection, connecting a new one if needed.
    async fn upstream(self: &Arc<Self>) -> Result<Link, String> {
        let Some(path) = self.shared.upstream.clone() else {
            return Err("sole mode: no upstream".into());
        };
        let mut slot = self.upstream.lock().await;
        if let Some(u) = slot.as_ref()
            && u.link.alive.load(Ordering::Acquire)
        {
            return Ok(u.link.clone());
        }
        let stream = match tokio::time::timeout(
            UPSTREAM_CONNECT_TIMEOUT,
            UnixStream::connect(&path),
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
            let failed = conn.pending().drain_generation(generation);
            for entry in failed {
                conn.fail(entry, "upstream closed before replying");
            }
            conn.settled.notify_waiters();
        });
        let link = Link {
            generation,
            alive,
            frames,
        };
        *slot = Some(Upstream {
            link: link.clone(),
            reader: reader.abort_handle(),
        });
        Ok(link)
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
            let entry = protocol::reply_id_key(&line).and_then(|key| self.pending().take(&key));
            let reply: serde_json::Value =
                serde_json::from_slice(&line).unwrap_or(serde_json::Value::Null);
            let bytes = protocol::reply_body_bytes(&line);
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
                ReplyTelemetry {
                    completion: &completion,
                    bytes,
                    phases: None,
                },
                ReplyRoute::Relayed(entry.fallback.as_ref()),
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

    /// Answer a relayed request Bun will not: release its hold on the drain.
    fn fail(&self, entry: Entry, detail: &str) {
        self.shared.release_one();
        self.upstream_failed(
            &entry.method,
            &entry.client,
            &entry.id,
            entry.started,
            detail,
            entry.fallback.as_ref(),
        );
    }

    fn upstream_failed(
        &self,
        method: &str,
        client: &str,
        id: &J,
        started: Instant,
        detail: &str,
        fallback: Option<&Fallback>,
    ) {
        let reply = protocol::upstream_refusal(id, method, detail);
        let bytes = protocol::reply_body_bytes(reply.as_bytes());
        self.shared
            .observations
            .upstream_failed(method, &now_iso(), detail);
        self.send(reply.into_bytes());
        self.shared.log.event(
            "warn",
            "rpc",
            "upstream.failed",
            vec![
                ("conn".into(), J::Num(self.id as f64)),
                ("op".into(), J::str(method)),
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
            method,
            client,
            started.elapsed(),
            ReplyTelemetry {
                completion: &completion,
                bytes,
                phases: None,
            },
            ReplyRoute::UpstreamFailed(fallback),
        );
    }
}
