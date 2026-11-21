//! Native `aspc.compileHarnessInvocation` for the claude-code (R3a) and
//! codex-app-server (R3b) recipes over mutable spaces
//! (docs/aspd.md).
//!
//! Bun owns the semantics; this is compiler/agent-spaces/src
//! (compile-runtime-plan.ts, compile-tmux-broker-plan.ts,
//! compile-broker-plan.ts, broker-invocation.ts, prepare-cli-runtime.ts,
//! compile-plan-finalize.ts) and what they call, reproduced byte for byte. The request is classified before anything is
//! written: every read, every validation and the whole system prompt resolve
//! first, and anything raspd does not implement (another recipe, a registry
//! space, a missing snapshot, an input it will not judge) is a `Forward`
//! relayed to Bun unchanged. Writes then follow Bun's rules under ASP_HOME's
//! shared lock protocol. raspd never fetches the registry.
//!
//! A compile runs `plan::classify` (every read and decision), then
//! `preflight` (refusals Bun reaches only after writing), then
//! `materialize::materialize_and_emit` (the writes, then `emit_claude` or
//! `emit_codex`, both ending in `finalize`).
mod agent_tools;
pub(crate) mod antigravity;
mod broker_spec;
mod bundle_audit;
mod bundle_prune;
mod bundle_publish;
mod claude_bundle;
mod claude_plugin;
mod codex;
mod emit_antigravity;
mod emit_claude;
mod emit_codex;
mod finalize;
mod fs_tree;
mod iarna;
mod inspect;
mod lock_schema;
mod lockfile;
mod materialize;
mod path_filter;
mod plan;
mod plugin_conflicts;
mod preflight;
mod prompt;
mod provisioning;
mod release_binding;
mod request;
mod scope;
mod space_plan;
mod spaces;
mod stage;
mod temp_lifecycle;
pub(crate) mod util;
mod workspace_trust;

use crate::json::J;
use crate::reads::Answer;
use crate::release::Release;

pub use crate::disposition::Fwd;
use crate::disposition::{Context, Reason};

pub fn fwd(reason: Reason) -> Fwd {
    Fwd {
        reason,
        detail: None,
    }
}

/// The forward for a request whose params fail validation.
pub fn invalid_params() -> Fwd {
    fwd(crate::reason!("invalid_params"))
}

pub fn fwd_at(reason: Reason, detail: String) -> Fwd {
    Fwd {
        reason,
        detail: Some(detail),
    }
}

/// A lock wait's forward: a lock still held after the one wait (60 s) is
/// `lock_timeout`; an I/O failure taking it is the reason's own.
pub(crate) fn lock_fwd(reason: Reason) -> impl Fn(lockfile::LockError) -> Fwd {
    move |error| match error {
        lockfile::LockError::Held(path) => fwd_at(reason.within(Context::Held), path),
        lockfile::LockError::Io(message) => fwd_at(reason, message),
    }
}

pub const METHOD: &str = "aspc.compileHarnessInvocation";
/// The ops answered through the native compile: the compile itself, and
/// runtime placement inspection, which compiles (and materializes) too.
pub const METHODS: [&str; 4] = [
    METHOD,
    inspect::METHOD,
    inspect::AGENT_METHOD,
    inspect::CATALOG_METHOD,
];

pub fn is_compile(method: &str) -> bool {
    METHODS.contains(&method)
}

/// Answer one of `METHODS`.
pub fn handle_method(method: &str, params: Option<&J>, release: &Release) -> Compiled {
    if matches!(method, inspect::AGENT_METHOD | inspect::CATALOG_METHOD) {
        inspect::handle_agent(method, params, release)
    } else if method == inspect::METHOD {
        inspect::handle(params, release)
    } else {
        handle(params, release)
    }
}

/// JS truthiness of a JSON value.
pub fn truthy(v: &J) -> bool {
    crate::reads::js_truthy(v)
}

/// A compile's answer, with what its `rpc.request` line logs beside it.
pub struct Compiled {
    pub answer: Answer,
    /// The forward's `fallbackDetail`, when its reason has one.
    pub fallback_detail: Option<String>,
    /// Per-stage timings of a native answer (`phases`).
    pub phases: Option<J>,
}

impl Compiled {
    /// A native answer with its phases, or the forward it refused with.
    fn from_result(result: Result<J, Fwd>, phases: Phases) -> Self {
        match result {
            Ok(result) => Compiled {
                answer: Answer::Result(result),
                fallback_detail: None,
                phases: Some(phases.finish()),
            },
            Err(f) => Compiled {
                answer: Answer::Forward(f.reason),
                fallback_detail: f.detail,
                phases: None,
            },
        }
    }

    /// An answer given before any stage ran: no phases.
    fn unstaged(answer: Answer) -> Self {
        Compiled {
            answer,
            fallback_detail: None,
            phases: None,
        }
    }
}

pub fn handle(params: Option<&J>, release: &Release) -> Compiled {
    let mut phases = Phases::start();
    let Some(params) = params.filter(|p| request::params_valid(Some(*p))) else {
        return Compiled::unstaged(Answer::Forward(crate::reason!("invalid_params")));
    };
    let result = compile(params, release, &mut phases);
    Compiled::from_result(result, phases)
}

/// Wall time per compile stage, in ms to one decimal like Bun's
/// `timeCompilePhase`. Stages run in sequence, so each `lap` closes the one
/// that began at the previous lap. Names are Bun's where the stage does the
/// same work (resolve, placement-context, harness-detect, agent-local,
/// plan-runtime, system-prompt, temp-sweep, materialize); raspd-only stages
/// keep their own (gate, environment, spaces-plan, statusline, emit). `build`
/// is the whole native compile, gate included.
struct Phases {
    started: std::time::Instant,
    last: std::time::Instant,
    laps: Vec<(&'static str, f64)>,
}

impl Phases {
    fn start() -> Self {
        let now = std::time::Instant::now();
        Phases {
            started: now,
            last: now,
            laps: vec![],
        }
    }

    fn lap(&mut self, name: &'static str) {
        let now = std::time::Instant::now();
        let ms = (now - self.last).as_secs_f64() * 1000.0;
        self.last = now;
        match self.laps.iter_mut().find(|(n, _)| *n == name) {
            Some(lap) => lap.1 += ms,
            None => self.laps.push((name, ms)),
        }
    }

    fn finish(self) -> J {
        let round = |ms: f64| J::Num((ms * 10.0).round() / 10.0);
        let build = self.started.elapsed().as_secs_f64() * 1000.0;
        J::Obj(
            self.laps
                .into_iter()
                .map(|(n, ms)| (n.to_owned(), round(ms)))
                .chain([("build".to_owned(), round(build))])
                .collect(),
        )
    }
}

fn s(v: Option<&J>) -> Option<&str> {
    v.and_then(J::as_str)
}

fn compile(params: &J, release: &Release, phases: &mut Phases) -> Result<J, Fwd> {
    request::shape_supported(params)?;
    phases.lap("gate");
    let plan = plan::classify(params, release, phases)?;
    preflight::preflight(&plan)?;
    materialize::materialize_and_emit(plan, release, phases)
}
