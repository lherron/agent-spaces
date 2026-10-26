//! The two native read ops (R2): `aspc.resolveRuntimeDeclaration` and
//! `aspc.observeContinuationArtifact`, ported from Bun with Bun's semantics,
//! read-only.
//!
//! Each answer is either the result Bun would return, byte for byte, or a
//! `Forward` naming why raspd will not judge this input; the request is then
//! relayed to Bun unchanged (reads are safe to forward) and counted. raspd
//! never answers approximately.
//!
//! Params validation mirrors harness/aspc/src/registration.ts
//! (`registerAspcObservationMethod`): valid params are handled; params whose
//! `schemaVersion` is a string other than the method's are handled raw (Bun's
//! fallback, which answers `unsupported_schema`); any other invalid params are
//! Bun's JSON-RPC validation error, which raspd forwards.
mod continuation;
mod declaration;
mod hash;
mod jspath;
mod patterns;
mod profile;
mod targets;
mod toml;

use crate::json::J;
use std::collections::BTreeMap;
use std::sync::OnceLock;

pub const METHODS: [&str; 2] = [
    "aspc.resolveRuntimeDeclaration",
    "aspc.observeContinuationArtifact",
];

pub fn is_read(method: &str) -> bool {
    METHODS.contains(&method)
}

/// Why an input is relayed to Bun instead of answered.
pub type Forward = &'static str;

pub enum Answer {
    Result(J),
    Forward(Forward),
}

/// A JS environment record: a key can be set, or present and `undefined`.
#[derive(Clone)]
pub struct Env {
    vars: BTreeMap<String, Option<String>>,
}

impl Env {
    /// The daemon's `process.env`. Bun aspd and raspd run with one
    /// environment (aspd-service renders both from the same service env).
    pub fn process() -> &'static Env {
        static ENV: OnceLock<Env> = OnceLock::new();
        ENV.get_or_init(|| Env {
            vars: std::env::vars_os()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        Some(v.to_string_lossy().into_owned()),
                    )
                })
                .collect(),
        })
    }
    pub fn get(&self, key: &str) -> Option<&str> {
        self.vars.get(key).and_then(|v| v.as_deref())
    }
    pub fn with(&self, key: &str, value: Option<&str>) -> Env {
        let mut copy = self.clone();
        copy.vars.insert(key.to_owned(), value.map(str::to_owned));
        copy
    }
}

/// `os.homedir()`: `$HOME`, else the passwd entry.
pub fn homedir() -> String {
    if let Some(home) = Env::process().get("HOME") {
        return home.to_owned();
    }
    // SAFETY: getpwuid returns a pointer into static storage or null.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_dir.is_null() {
            return String::new();
        }
        std::ffi::CStr::from_ptr((*pw).pw_dir)
            .to_string_lossy()
            .into_owned()
    }
}

/// A string value that JavaScript treats as truthy (non-empty).
pub fn truthy_str(v: Option<&J>) -> Option<&str> {
    match v {
        Some(J::Str(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

pub fn js_truthy(v: &J) -> bool {
    match v {
        J::Null => false,
        J::Bool(b) => *b,
        J::Num(n) => *n != 0.0 && !n.is_nan(),
        J::Str(s) => !s.is_empty(),
        J::Arr(_) | J::Obj(_) => true,
    }
}

pub fn handle(method: &str, params: Option<&J>) -> Answer {
    let (valid, expected) = match method {
        "aspc.resolveRuntimeDeclaration" => (valid_resolve(params), declaration::REQUEST_VERSION),
        _ => (valid_observe(params), continuation::REQUEST_VERSION),
    };
    if !valid {
        let fallback = matches!(
            params.and_then(|p| p.get("schemaVersion")),
            Some(J::Str(s)) if s != expected
        ) && params.is_some_and(J::is_record);
        if !fallback {
            return Answer::Forward("invalid_params");
        }
    }
    let params = params.expect("validated or fallback params are a record");
    match method {
        "aspc.resolveRuntimeDeclaration" => declaration::answer(params, Env::process()),
        _ => continuation::observe(params, Env::process()),
    }
}

// -- params validators (runtime-observation-params.ts), as verdicts ----------------

fn is_str(v: Option<&J>) -> bool {
    matches!(v, Some(J::Str(_)))
}
fn opt_str(v: Option<&J>) -> bool {
    v.is_none() || is_str(v)
}
fn rec(v: Option<&J>) -> Option<&J> {
    v.filter(|v| v.is_record())
}
fn opt_rec(v: Option<&J>) -> Result<Option<&J>, ()> {
    match v {
        None => Ok(None),
        Some(v) if v.is_record() => Ok(Some(v)),
        Some(_) => Err(()),
    }
}
fn only(v: &J, allowed: &[&str]) -> bool {
    v.js_entries().iter().all(|(k, _)| allowed.contains(k))
}
fn is_enum(v: Option<&J>, allowed: &[&str]) -> bool {
    matches!(v, Some(J::Str(s)) if allowed.contains(&s.as_str()))
}

fn valid_resolve(params: Option<&J>) -> bool {
    let Some(request) = rec(params) else {
        return false;
    };
    if request.get("schemaVersion") != Some(&J::str(declaration::REQUEST_VERSION)) {
        return false;
    }
    let Some(context) = rec(request.get("context")) else {
        return false;
    };
    let project_ok = rec(context.get("project")).is_some_and(|project| {
        is_enum(project.get("mode"), &["root", "infer-from-cwd", "none"])
            && if project.get("mode") == Some(&J::str("root")) {
                is_str(project.get("projectRoot"))
                    && opt_str(project.get("projectId"))
                    && only(project, &["mode", "projectRoot", "projectId"])
            } else {
                only(project, &["mode"])
            }
    });
    let sources_ok = match opt_rec(context.get("agentSources")) {
        Err(()) => false,
        Ok(None) => true,
        Ok(Some(s)) => {
            opt_str(s.get("aspHome"))
                && opt_str(s.get("agentsRoot"))
                && only(s, &["aspHome", "agentsRoot"])
        }
    };
    let directives_ok = match opt_rec(context.get("provisionDirectives")) {
        Err(()) => false,
        Ok(None) => true,
        Ok(Some(d)) => d
            .js_entries()
            .iter()
            .all(|(_, v)| matches!(v, J::Str(_) | J::Num(_) | J::Bool(_))),
    };
    is_str(context.get("agentId"))
        && opt_str(context.get("agentRoot"))
        && is_str(context.get("cwd"))
        && is_enum(
            context.get("runMode"),
            &["query", "heartbeat", "task", "maintenance"],
        )
        && opt_str(context.get("taskId"))
        && project_ok
        && sources_ok
        && directives_ok
        && only(
            context,
            &[
                "agentId",
                "agentRoot",
                "project",
                "cwd",
                "runMode",
                "taskId",
                "agentSources",
                "provisionDirectives",
            ],
        )
        && only(request, &["schemaVersion", "context"])
}

const BROKER_DRIVERS: [&str; 7] = [
    "codex-app-server",
    "claude-code-tmux",
    "codex-cli-tmux",
    "pi-tui-tmux",
    "pi-sdk",
    "agent-harness",
    "agent-harness-tmux",
];

fn valid_observe(params: Option<&J>) -> bool {
    let Some(request) = rec(params) else {
        return false;
    };
    if request.get("schemaVersion") != Some(&J::str(continuation::REQUEST_VERSION)) {
        return false;
    }
    let Some(c) = rec(request.get("continuation")) else {
        return false;
    };
    let continuation_ok = is_str(c.get("provider"))
        && is_str(c.get("key"))
        && (c.get("artifactFormat").is_none()
            || is_enum(c.get("artifactFormat"), &["claude", "codex", "pi"]))
        && only(c, &["provider", "key", "artifactFormat"]);
    let historical_ok = match opt_rec(request.get("historicalExecution")) {
        Err(()) => false,
        Ok(None) => true,
        Ok(Some(h)) => {
            let frozen_ok = match opt_rec(h.get("frozenStartRequest")) {
                Err(()) => false,
                Ok(None) => true,
                Ok(Some(f)) => {
                    f.get("keyBinding") == Some(&J::str("runtime-continuation"))
                        && rec(f.get("placement")).is_some()
                        && rec(f.get("startRequest")).is_some()
                        && (f.get("brokerDriver").is_none()
                            || is_enum(f.get("brokerDriver"), &BROKER_DRIVERS))
                        && [
                            "compileId",
                            "planHash",
                            "selectedProfileHash",
                            "startRequestHash",
                        ]
                        .iter()
                        .all(|k| opt_str(f.get(k)))
                        && opt_rec(f.get("executionRelease")).is_ok()
                }
            };
            let recorded_ok = match opt_rec(h.get("recordedPlacement")) {
                Err(()) => false,
                Ok(None) => true,
                Ok(Some(r)) => {
                    rec(r.get("placement")).is_some()
                        && rec(r.get("bundle")).is_some()
                        && opt_str(r.get("aspHome"))
                        && ["compileId", "planHash", "selectedProfileHash"]
                            .iter()
                            .all(|k| opt_str(r.get(k)))
                }
            };
            frozen_ok && recorded_ok && only(h, &["frozenStartRequest", "recordedPlacement"])
        }
    };
    continuation_ok
        && historical_ok
        && only(
            request,
            &["schemaVersion", "continuation", "historicalExecution"],
        )
}
