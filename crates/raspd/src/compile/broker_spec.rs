//! The harness-broker start request pieces both recipes share
//! (broker-invocation.ts): the spec header and process block, lockedEnv
//! (`composeAgentLocalEnv`), correlation, process limits, the permission
//! policy, and the drivers' names.
use super::plan::{Launch, Plan};
use super::scope::locked_asp_project;
use super::{Fwd, codex, fwd, s, spaces};
use crate::json::J;
use crate::reads::jspath::{basename, join};

/// An env in insertion order.
pub(super) type EnvPairs = Vec<(String, String)>;

/// An env as its JSON object, in order.
pub(super) fn env_json(env: &EnvPairs) -> J {
    J::Obj(env.iter().map(|(k, v)| (k.clone(), J::str(v))).collect())
}

/// The request's `continuation.hrc.key`.
pub(super) fn continuation_key(req: &J) -> Option<&str> {
    s(req
        .get("continuation")
        .and_then(|c| c.get("hrc"))
        .and_then(|h| h.get("key")))
}

/// The spec's leading keys: its version, the invocation id, and the task label.
pub(super) fn spec_header(req: &J) -> Result<J, Fwd> {
    let material = req
        .get("materialization")
        .ok_or_else(|| super::fwd(crate::reason!("invalid_params")))?;
    let mut spec = J::obj([("specVersion", J::str("harness-broker.invocation/v1"))]);
    if let Some(inv) = req.get("identity").and_then(|i| i.get("invocationId")) {
        spec.set("invocationId", inv.clone());
    }
    if let Some(t) = s(material.get("taskContext").and_then(|t| t.get("taskId"))) {
        spec.set("labels", J::obj([("task", J::str(t))]));
    }
    Ok(spec)
}

/// The process block through its harness transport; the caller adds limits.
pub(super) fn process_spec(
    command: &str,
    args: &[String],
    cwd: &str,
    locked: &EnvPairs,
    path_prepend: &[String],
    transport: &str,
) -> J {
    let mut process = J::obj([
        ("command", J::str(command)),
        ("args", J::Arr(args.iter().map(J::str).collect())),
        ("cwd", J::str(cwd)),
        ("lockedEnv", env_json(locked)),
    ]);
    if !path_prepend.is_empty() {
        process.set(
            "pathPrepend",
            J::Arr(path_prepend.iter().map(J::str).collect()),
        );
    }
    process.set("harnessTransport", J::obj([("kind", J::str(transport))]));
    process
}

/// `brokerCorrelation(req)`.
pub(super) fn broker_correlation(req: &J) -> Result<J, Fwd> {
    let correlation = req
        .get("correlation")
        .ok_or_else(|| super::fwd(crate::reason!("invalid_params")))?;
    let mut out = J::Obj(vec![]);
    for k in [
        "requestId",
        "hostSessionId",
        "operationId",
        "runtimeId",
        "runId",
        "invocationId",
        "inputId",
        "traceId",
        "scopeRef",
        "laneRef",
    ] {
        if let Some(v) = correlation.get(k) {
            out.set(k, v.clone());
        }
    }
    Ok(out)
}

/// Same stable per-agent home used by Bun's preparePathFilter.
pub(super) fn path_filter_scope(plan: &Plan) -> String {
    let project_id = match plan.launch {
        Launch::Antigravity { ref seat_key, .. } => {
            return super::antigravity::runtime_home::artifact_scope(&plan.asp_home, seat_key);
        }
        Launch::Codex { .. } => plan.handle.project_id.as_deref().unwrap_or_default(),
        Launch::Claude { .. } => plan
            .identity
            .get("projectId")
            .and_then(J::as_str)
            .unwrap_or_default(),
    };
    codex::runtime_home::home_path(&plan.asp_home, project_id, &plan.agent_name)
}

/// `composeAgentLocalEnv`'s lockedEnv: the adapter env, the agentchat env,
/// the caller's placement.lockedEnv, ASP_HOME, then the tool runtime env.
pub(super) fn locked_env(plan: &Plan, adapter_env: EnvPairs, tool_env: EnvPairs) -> EnvPairs {
    let mut locked = adapter_env;
    locked.push(("AGENTCHAT_ID".into(), basename(&plan.agent_root)));
    if let Some(project) = locked_asp_project(&plan.handle, plan.project_root.as_deref()) {
        locked.push(("ASP_PROJECT".into(), project));
    }
    let mut set = |k: String, v: String| match locked.iter_mut().find(|(e, _)| *e == k) {
        Some(slot) => slot.1 = v,
        None => locked.push((k, v)),
    };
    let caller = plan.req.get("placement").and_then(|p| p.get("lockedEnv"));
    for (k, v) in caller.map(J::js_entries).unwrap_or_default() {
        if let J::Str(v) = v {
            set(k.to_owned(), v.clone());
        }
    }
    set("ASP_HOME".into(), plan.asp_home.clone());
    for (k, v) in tool_env {
        set(k, v);
    }
    if !spaces::path_exclude(&plan.closure).is_empty() {
        let zdotdir = join(&[&path_filter_scope(plan), "zdotdir"]);
        if matches!(plan.launch, Launch::Claude { .. }) {
            set(
                "CLAUDE_ENV_FILE".into(),
                join(&[&zdotdir, "claude-env.zsh"]),
            );
        }
        set("ZDOTDIR".into(), zdotdir);
    }
    locked
}

/// The broker's default process limits (broker-invocation.ts).
pub(super) fn default_limits() -> J {
    J::obj([
        ("startupTimeoutMs", J::Num(20_000.0)),
        ("turnTimeoutMs", J::Num(900_000.0)),
        ("stopGraceMs", J::Num(5_000.0)),
    ])
}

/// `toProcessLimits(resourceLimits)`, or `undefined` without them.
pub(super) fn process_limits(policy: &J) -> Option<J> {
    let limits = policy.get("resourceLimits")?;
    let mut l = J::Obj(vec![]);
    for k in [
        "startupTimeoutMs",
        "turnTimeoutMs",
        "stopGraceMs",
        "maxEventBytes",
    ] {
        if let Some(v) = limits.get(k) {
            l.set(k, v.clone());
        }
    }
    Some(l)
}

/// `toBrokerPermissionPolicy(hrcPolicy.permissionPolicy ?? { mode: 'deny', audit: true })`.
pub(super) fn broker_permission_policy(policy: &J) -> Result<J, Fwd> {
    let Some(p) = policy.get("permissionPolicy") else {
        return Ok(J::obj([("mode", J::str("deny"))]));
    };
    match p.get("mode").and_then(J::as_str) {
        Some("ask-client") => {
            let mut out = J::obj([("mode", J::str("ask-client"))]);
            for k in ["timeoutMs", "defaultDecision"] {
                if let Some(v) = p.get(k) {
                    out.set(k, v.clone());
                }
            }
            Ok(out)
        }
        Some(mode) => Ok(J::obj([("mode", J::str(mode))])),
        None => Err(fwd(crate::reason!("permission_policy_shape"))),
    }
}

/// The claude-code recipe's driver: claude-code-tmux, or claude-code-hrcpty
/// for claude-hrcpty (compile-hrcpty-broker-plan.ts).
pub(super) fn claude_driver(hrcpty: bool) -> &'static str {
    if hrcpty {
        "claude-code-hrcpty"
    } else {
        "claude-code-tmux"
    }
}

pub(super) fn terminal_host(hrcpty: bool) -> &'static str {
    if hrcpty { "hrcpty" } else { "tmux" }
}
