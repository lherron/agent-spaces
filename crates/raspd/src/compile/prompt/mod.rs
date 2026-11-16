//! The system prompt (core/runtime/src), ported module by module:
//!
//! - `discovery`: template discovery and the agent-root search path
//!   (system-prompt.ts, agent-root search).
//! - `template`: `parseContextTemplate` and the built-in default template
//!   (context-template.ts, system-prompt.ts).
//! - `when`: `matchesWhenPredicate` (when-predicate.ts).
//! - `vars`: task facts and `interpolateVariables` (task-prompt-facts.ts,
//!   template-vars.ts).
//! - `refs`: template and root-relative file refs (template-ref.ts,
//!   resolver/root-relative-refs.ts).
//! - `sections`, `exec`, `probe`: one section's content (section-resolution.ts,
//!   service-probe*.ts).
//! - `zones`: zone and template resolution with inspection reports
//!   (context-resolver.ts).
//!
//! This module holds the resolver context every stage reads. Exec sections and
//! service probes run for real, with Bun's command, cwd, environment, timeout
//! and failure handling. A template or input raspd will not judge is a
//! `Forward`; resolution happens before any write.
pub mod discovery;
mod exec;
mod probe;
pub mod refs;
mod sections;
pub mod template;
pub mod vars;
mod when;
pub mod zones;

use super::{Fwd, fwd};
use crate::json::J;
use std::cell::RefCell;
use std::collections::BTreeMap;

pub type EnvMap = BTreeMap<String, String>;

/// `ContextResolverContext`, as a compile builds it.
#[derive(Clone)]
pub struct Ctx {
    pub agent_root: String,
    pub agents_root: String,
    pub search_path: Vec<String>,
    pub project_root: Option<String>,
    /// The placement's working folder; `when.exists` resolves against it, else
    /// `project_root`, never the daemon's own cwd (T-12027).
    pub cwd: Option<String>,
    pub project_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub task_id: Option<String>,
    pub task_context: Option<J>,
    pub lane: Option<String>,
    /// `undefined` renders as `''` and fails every `when.runMode`.
    pub run_mode: Option<String>,
    pub agent_profile: Option<J>,
    /// `context.env` (`undefined` reads `process.env`).
    pub env: Option<EnvMap>,
    pub exec_env: Option<EnvMap>,
    pub pinned: Option<Pinned>,
}

impl Ctx {
    /// `context.env[key]`, or the daemon's `process.env[key]` without one.
    fn env_var(&self, key: &str) -> Option<String> {
        match &self.env {
            Some(env) => env.get(key).cloned(),
            None => crate::reads::Env::process().get(key).map(str::to_owned),
        }
    }

    /// The roots a search-path ref tries in order: the search path, else the
    /// agents root alone.
    fn search_roots(&self) -> Vec<&String> {
        if self.search_path.is_empty() {
            vec![&self.agents_root]
        } else {
            self.search_path.iter().collect()
        }
    }
}

/// Explicit inspection inputs; compilation and placement inspection use ambient inputs.
#[derive(Clone)]
pub struct Pinned {
    pub context: J,
    /// The `serviceProbeInputs.responses` indexes a probe section has consumed.
    used: RefCell<Vec<usize>>,
}

impl Pinned {
    pub fn new(context: J) -> Self {
        Self {
            context,
            used: RefCell::new(vec![]),
        }
    }

    /// `serviceProbeInputs.responses`, which an inspection must carry.
    fn probe_responses(&self) -> Result<&Vec<J>, Fwd> {
        self.context
            .get("serviceProbeInputs")
            .and_then(|i| i.get("responses"))
            .and_then(J::as_arr)
            .ok_or_else(|| fwd(crate::reason!("invalid_params")))
    }
}

/// An environment record's string entries.
pub fn context_env(value: &J) -> EnvMap {
    value
        .js_entries()
        .into_iter()
        .filter_map(|(k, v)| v.as_str().map(|v| (k.into(), v.into())))
        .collect()
}

/// Names a JS lookup would find on `Object.prototype`; a template naming one
/// refuses rather than reading it.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

/// The resolver context the module's tests start from.
#[cfg(test)]
fn test_ctx() -> Ctx {
    Ctx {
        agent_root: "/a/clod".into(),
        agents_root: "/a".into(),
        search_path: vec![],
        project_root: Some("/p".into()),
        cwd: None,
        project_id: Some("proj".into()),
        agent_id: Some("clod".into()),
        agent_name: None,
        task_id: Some("T-1".into()),
        task_context: None,
        lane: Some("main".into()),
        run_mode: Some("task".into()),
        agent_profile: None,
        env: Some(EnvMap::from([("X".to_owned(), "1".to_owned())])),
        exec_env: None,
        pinned: None,
    }
}
