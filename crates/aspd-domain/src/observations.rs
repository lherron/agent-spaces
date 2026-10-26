//! raspd's service state, recorded by the request path and projected by the
//! `aspd.observe` ingest operation.
//!
//! The cursor is the state's version. A run with the current version returns
//! no edits; any other cursor (including bootstrap's `null`) returns every
//! node, which is idempotent under upsert, plus a remove for each compile that
//! has left the recent window. Each answer is complete, so it reports
//! `caught_up` (the document's `bootstrapping` clears on the first run).
use cardo_runtime::{core_adapter::WorkerCall, service::DispatchFailure};
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Recent compiles kept in the document.
pub const RECENT_COMPILES: usize = 32;
/// Evicted compile ids still removed on every run, so a run that missed an
/// eviction catches up.
const EVICTION_MEMORY: usize = 256;
/// Distinct op names tracked; further unknown method names share one row.
const MAX_OPS: usize = 64;
const OTHER_OP: &str = "(other)";

#[derive(Clone, Debug)]
pub struct ServiceInfo {
    pub role: String,
    pub release_id: String,
    pub source_commit: String,
    pub built_at: String,
    pub raspd_source_commit: String,
    pub socket: String,
    pub upstream_socket: String,
    pub pid: u32,
    pub started_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Served {
    Native,
    Relayed,
    UpstreamFailed,
}

#[derive(Clone, Debug)]
pub struct CompileRecord {
    pub compile_id: String,
    pub plan_hash: Option<String>,
    pub recipe: Option<String>,
    pub outcome: String,
    pub served_by: String,
    pub duration_ms: u64,
    pub completed_at: String,
}

#[derive(Default, Clone, Copy)]
struct OpCounts {
    native: u64,
    relayed: u64,
    upstream_failed: u64,
}

struct Upstream {
    state: &'static str,
    last_ok_at: Option<String>,
    last_failure_at: Option<String>,
    last_error: Option<String>,
    failures: u64,
}

struct State {
    version: u64,
    service: ServiceInfo,
    upstream: Upstream,
    ops: BTreeMap<String, OpCounts>,
    compiles: VecDeque<CompileRecord>,
    evicted: VecDeque<String>,
}

pub struct Observations {
    state: Mutex<State>,
    dirty: AtomicBool,
}

impl Observations {
    pub fn new(service: ServiceInfo) -> Self {
        Self {
            state: Mutex::new(State {
                version: 1,
                service,
                upstream: Upstream {
                    state: "unknown",
                    last_ok_at: None,
                    last_failure_at: None,
                    last_error: None,
                    failures: 0,
                },
                ops: BTreeMap::new(),
                compiles: VecDeque::new(),
                evicted: VecDeque::new(),
            }),
            dirty: AtomicBool::new(true),
        }
    }

    fn update(&self, change: impl FnOnce(&mut State)) {
        // A poisoned lock only means a panic elsewhere already ended a recording;
        // the counters are still the best record there is.
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        change(&mut state);
        state.version += 1;
        drop(state);
        self.dirty.store(true, Ordering::Release);
    }

    /// A request raspd answered itself.
    pub fn native(&self, op: &str) {
        self.update(|state| count(state, op, Served::Native));
    }

    /// A request Bun answered, and the compile it produced, as one change.
    pub fn relayed(&self, op: &str, at: &str, compile: Option<CompileRecord>) {
        self.update(|state| {
            count(state, op, Served::Relayed);
            state.upstream.state = "healthy";
            state.upstream.last_ok_at = Some(at.to_owned());
            if let Some(record) = compile {
                remember(state, record);
            }
        });
    }

    /// A forwarded request Bun never answered: Bun unreachable or gone.
    pub fn upstream_failed(&self, op: &str, at: &str, error: &str) {
        self.update(|state| {
            count(state, op, Served::UpstreamFailed);
            state.upstream.state = "unavailable";
            state.upstream.last_failure_at = Some(at.to_owned());
            state.upstream.last_error = Some(error.chars().take(500).collect());
            state.upstream.failures += 1;
        });
    }

    /// The last observed upstream state: `unknown`, `healthy` or `unavailable`.
    pub fn upstream_state(&self) -> &'static str {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .upstream
            .state
    }

    /// True once per batch of changes; the kernel's wake thread polls this.
    pub fn take_dirty(&self) -> bool {
        self.dirty.swap(false, Ordering::AcqRel)
    }

    /// The ingest operation's answer for `cursor` (cardo ingest v1 §3.1).
    pub fn ingest(&self, cursor: &Value) -> Value {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let next = json!({ "version": state.version });
        if *cursor == next {
            return json!({"cursor": next, "edits": [], "more": false, "caught_up": true});
        }
        let mut edits = Vec::with_capacity(2 + state.ops.len() + state.compiles.len());
        let s = &state.service;
        edits.push(upsert(
            "aspd.service",
            json!({"name": "raspd"}),
            json!({
                "name": "raspd",
                "role": s.role,
                "releaseId": s.release_id,
                "sourceCommit": s.source_commit,
                "builtAt": s.built_at,
                "raspdSourceCommit": s.raspd_source_commit,
                "socket": s.socket,
                "upstreamSocket": s.upstream_socket,
                "pid": s.pid,
                "startedAt": s.started_at,
            }),
        ));
        let u = &state.upstream;
        edits.push(upsert(
            "aspd.upstream",
            json!({"name": "bun"}),
            json!({
                "name": "bun",
                "socket": s.upstream_socket,
                "state": u.state,
                "lastOkAt": u.last_ok_at,
                "lastFailureAt": u.last_failure_at,
                "lastError": u.last_error,
                "failures": u.failures,
            }),
        ));
        for (op, counts) in &state.ops {
            edits.push(upsert(
                "aspd.op",
                json!({"op": op}),
                json!({
                    "op": op,
                    "native": counts.native,
                    "relayed": counts.relayed,
                    "upstreamFailed": counts.upstream_failed,
                }),
            ));
        }
        for c in &state.compiles {
            edits.push(upsert(
                "aspd.compile",
                json!({"compileId": c.compile_id}),
                json!({
                    "compileId": c.compile_id,
                    "planHash": c.plan_hash,
                    "recipe": c.recipe,
                    "outcome": c.outcome,
                    "servedBy": c.served_by,
                    "durationMs": c.duration_ms,
                    "completedAt": c.completed_at,
                }),
            ));
        }
        for id in &state.evicted {
            edits.push(
                json!({"kind": "remove_by_key", "type": "aspd.compile", "key": {"compileId": id}}),
            );
        }
        // Every run answers the whole state, so it is always caught up.
        json!({"cursor": next, "edits": edits, "more": false, "caught_up": true})
    }
}

fn count(state: &mut State, op: &str, served: Served) {
    let key = if state.ops.contains_key(op) || state.ops.len() < MAX_OPS {
        op
    } else {
        OTHER_OP
    };
    let counts = state.ops.entry(key.to_owned()).or_default();
    match served {
        Served::Native => counts.native += 1,
        Served::Relayed => counts.relayed += 1,
        Served::UpstreamFailed => counts.upstream_failed += 1,
    }
}

fn remember(state: &mut State, record: CompileRecord) {
    state.compiles.retain(|c| c.compile_id != record.compile_id);
    state.evicted.retain(|id| *id != record.compile_id);
    state.compiles.push_back(record);
    while state.compiles.len() > RECENT_COMPILES {
        if let Some(old) = state.compiles.pop_front() {
            state.evicted.push_back(old.compile_id);
        }
    }
    while state.evicted.len() > EVICTION_MEMORY {
        state.evicted.pop_front();
    }
}

fn upsert(node_type: &str, key: Value, payload: Value) -> Value {
    json!({"kind": "upsert", "type": node_type, "key": key, "payload": payload, "domain": {}})
}

/// The in-process `aspd` provider: answers `aspd.observe` from [`Observations`].
pub struct Observer(pub std::sync::Arc<Observations>);

impl WorkerCall for Observer {
    fn call(
        &mut self,
        operation: &str,
        input: Value,
        _timeout: Duration,
    ) -> Result<Value, DispatchFailure> {
        if operation != crate::OPERATION {
            return Err(DispatchFailure {
                code: "unknown_operation".into(),
                message: format!("the aspd provider has no operation {operation}"),
                details: json!({}),
            });
        }
        Ok(self.0.ingest(&input["cursor"]))
    }
    fn shutdown(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> ServiceInfo {
        ServiceInfo {
            role: "front".into(),
            release_id: "asp-x".into(),
            source_commit: "c".repeat(40),
            built_at: "2026-10-26T00:00:00.000Z".into(),
            raspd_source_commit: "d".repeat(40),
            socket: "/s/aspd.sock".into(),
            upstream_socket: "/s/aspd-bun.sock".into(),
            pid: 7,
            started_at: "2026-10-26T00:00:01.000Z".into(),
        }
    }

    #[test]
    fn same_cursor_is_unchanged_and_any_change_moves_it() {
        let o = Observations::new(info());
        let first = o.ingest(&Value::Null);
        assert_eq!(first["edits"].as_array().unwrap().len(), 2);
        let again = o.ingest(&first["cursor"]);
        assert!(again["edits"].as_array().unwrap().is_empty());
        o.native("health");
        let next = o.ingest(&first["cursor"]);
        assert_ne!(next["cursor"], first["cursor"]);
        assert_eq!(next["edits"][2]["payload"]["native"], 1);
    }

    #[test]
    fn evicted_compiles_are_removed() {
        let o = Observations::new(info());
        for n in 0..(RECENT_COMPILES + 2) {
            let record = CompileRecord {
                compile_id: format!("c{n}"),
                plan_hash: None,
                recipe: None,
                outcome: "ok".into(),
                served_by: "bun".into(),
                duration_ms: 1,
                completed_at: "t".into(),
            };
            o.relayed("aspc.compileHarnessInvocation", "t", Some(record));
        }
        let out = o.ingest(&Value::Null);
        let removes: Vec<_> = out["edits"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["kind"] == "remove_by_key")
            .map(|e| e["key"]["compileId"].clone())
            .collect();
        assert_eq!(removes, vec![json!("c0"), json!("c1")]);
    }
}
