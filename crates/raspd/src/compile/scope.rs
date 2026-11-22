//! Agent scope refs (contracts/agent-scope): `parseScopeRef`,
//! `deriveHandleParts`, `buildAgentSessionEnv`, and the lockedEnv
//! `ASP_PROJECT` they decide.
use super::{Fwd, fwd, s};
use crate::json::J;
use crate::reads::jspath::{basename, resolve};
use crate::reads::patterns::validate_token;

pub(super) struct Scope {
    pub(super) agent_id: String,
    pub(super) project_id: Option<String>,
    pub(super) task_id: Option<String>,
}

/// `parseScopeRef`, or `None` where Bun would throw.
pub(super) fn parse_scope_ref(scope: &str) -> Option<Scope> {
    let parts: Vec<&str> = scope.split(':').collect();
    let tok = |v: &str| validate_token(v, "x").is_none();
    if parts.len() < 2 || parts[0] != "agent" || !tok(parts[1]) {
        return None;
    }
    let agent_id = parts[1].to_owned();
    if parts.len() == 2 {
        return Some(Scope {
            agent_id,
            project_id: None,
            task_id: None,
        });
    }
    if parts.len() < 4 || parts[2] != "project" || !tok(parts[3]) {
        return None;
    }
    let project_id = Some(parts[3].to_owned());
    if parts.len() == 4 {
        return Some(Scope {
            agent_id,
            project_id,
            task_id: None,
        });
    }
    match parts[4] {
        "role" if parts.len() == 6 && tok(parts[5]) => Some(Scope {
            agent_id,
            project_id,
            task_id: None,
        }),
        "task" if parts.len() >= 6 && tok(parts[5]) => {
            let task_id = Some(parts[5].to_owned());
            match parts.len() {
                6 => Some(Scope {
                    agent_id,
                    project_id,
                    task_id,
                }),
                8 if parts[6] == "role" && tok(parts[7]) => Some(Scope {
                    agent_id,
                    project_id,
                    task_id,
                }),
                _ => None,
            }
        }
        _ => None,
    }
}

#[derive(Default, Clone)]
pub(super) struct Handle {
    pub(super) agent_id: Option<String>,
    pub(super) project_id: Option<String>,
    pub(super) task_id: Option<String>,
    pub(super) lane: Option<String>,
}

/// `deriveHandleParts(placement)` (canonical scope refs only).
pub(super) fn handle_parts(placement: &J, with_project_root: bool) -> Result<Handle, Fwd> {
    let correlation = placement.get("correlation");
    let session = correlation.and_then(|c| c.get("sessionRef"));
    let mut h = Handle::default();
    if let Some(scope) = s(session.and_then(|x| x.get("scopeRef"))).filter(|x| !x.is_empty()) {
        let parsed =
            parse_scope_ref(scope).ok_or_else(|| fwd(crate::reason!("scope_ref_shorthand")))?;
        h.agent_id = Some(parsed.agent_id);
        h.project_id = parsed.project_id;
        h.task_id = parsed.task_id;
    }
    let agent_root = s(placement.get("agentRoot")).unwrap_or_default();
    if h.agent_id.is_none() {
        h.agent_id = Some(basename(agent_root));
    }
    if with_project_root
        && h.project_id.is_none()
        && let Some(root) = s(placement.get("projectRoot")).filter(|r| !r.is_empty())
    {
        h.project_id = Some(basename(&resolve(&[root])));
    }
    if let Some(lane) = s(session.and_then(|x| x.get("laneRef"))).filter(|l| !l.is_empty()) {
        h.lane = Some(lane.strip_prefix("lane:").unwrap_or(lane).to_owned());
    }
    Ok(h)
}

/// `buildAgentSessionEnv(placement)`, in insertion order.
pub(super) fn agent_session_env(placement: &J) -> Result<Vec<(String, String)>, Fwd> {
    let mut env: Vec<(String, String)> = vec![];
    let mut put = |k: &str, v: String| match env.iter_mut().find(|(e, _)| e == k) {
        Some(slot) => slot.1 = v,
        None => env.push((k.to_owned(), v)),
    };
    let correlation = placement.get("correlation");
    let session = correlation.and_then(|c| c.get("sessionRef"));
    let mut ids: (Option<String>, Option<String>, Option<String>) = (None, None, None);
    if let Some(session) = session {
        let scope = s(session.get("scopeRef")).unwrap_or_default();
        let lane_ref = s(session.get("laneRef")).unwrap_or_default();
        let normalized = if lane_ref == "main" || lane_ref.starts_with("lane:") {
            lane_ref.to_owned()
        } else {
            format!("lane:{lane_ref}")
        };
        if normalized != "main" {
            let lane_id = &normalized["lane:".len()..];
            if validate_token(lane_id, "laneId").is_some() {
                return Err(fwd(crate::reason!("lane_ref_invalid")));
            }
        }
        put("AGENT_SCOPE_REF", scope.to_owned());
        put("AGENT_LANE_REF", lane_ref.to_owned());
        let lane = if normalized == "main" {
            "main"
        } else {
            &normalized["lane:".len()..]
        };
        put(
            "AGENT_LANE",
            if lane.is_empty() {
                "main".into()
            } else {
                lane.to_owned()
            },
        );
        let parsed =
            parse_scope_ref(scope).ok_or_else(|| fwd(crate::reason!("scope_ref_shorthand")))?;
        ids = (Some(parsed.agent_id), parsed.project_id, parsed.task_id);
        let session_ref = format!("{scope}/lane:{lane}");
        put("AGENT_SESSION_REF", session_ref.clone());
        put("HRC_SESSION_REF", session_ref);
    }
    if let Some(a) = &ids.0 {
        put("AGENT_ID", a.clone());
    }
    if let Some(p) = &ids.1 {
        put("AGENT_PROJECT", p.clone());
    }
    if let Some(t) = &ids.2 {
        put("AGENT_TASK", t.clone());
    }
    let c = |k: &str| s(correlation.and_then(|c| c.get(k))).map(str::to_owned);
    if let Some(run) = c("runId") {
        put("AGENT_RUN_ID", run.clone());
        put("HRC_RUN_ID", run);
    }
    if let Some(host) = c("hostSessionId") {
        put("AGENT_HOST_SESSION_ID", host.clone());
        put("HRC_HOST_SESSION_ID", host);
    }
    if let Some(J::Num(g)) = correlation.and_then(|c| c.get("generation")) {
        let g = crate::json::js_number(*g);
        put("AGENT_GENERATION", g.clone());
        put("HRC_GENERATION", g);
    }
    if let Some(v) = c("runtimeId") {
        put("HRC_RUNTIME_ID", v);
    }
    if let Some(v) = c("invocationId") {
        put("HRC_INVOCATION_ID", v);
    }
    if let Some(v) = c("initialInputId") {
        put("HRC_INITIAL_INPUT_ID", v);
    }
    if let Some(root) = s(placement.get("projectRoot")) {
        put("AGENT_PROJECT_ROOT", root.to_owned());
    }
    if let Some(actor) = ids.0.filter(|a| !a.is_empty()) {
        put("AGENT_ACTOR", actor.clone());
        let principal = if actor.starts_with("agent:") {
            actor
        } else {
            format!("agent:{actor}")
        };
        put("WRKQ_PRINCIPAL_REF", principal);
    }
    Ok(env)
}

/// lockedEnv's ASP_PROJECT, the contract's project discovery id: written only
/// with a project root, the scope's project id or else the root's basename
/// (contracts/agent-scope/conformance `locked` env cases).
pub(super) fn locked_asp_project(handle: &Handle, project_root: Option<&str>) -> Option<String> {
    let root = project_root?;
    Some(
        handle
            .project_id
            .clone()
            .unwrap_or_else(|| basename(&resolve(&[root]))),
    )
}

#[cfg(test)]
mod env_conformance {
    //! The `locked` cases of contracts/agent-scope/conformance/env-cases.json,
    //! through the same steps `compile` takes: `handle_parts` then
    //! `locked_asp_project`. Bun runs the same cases.
    use super::{handle_parts, locked_asp_project};
    use crate::json::{self, J};

    const ENV_CASES: &str =
        include_str!("../../../../contracts/agent-scope/conformance/env-cases.json");

    #[test]
    fn locked_env_cases() {
        let doc = json::parse(ENV_CASES.as_bytes()).expect("env-cases.json parses");
        let cases: Vec<&J> = doc
            .get("cases")
            .and_then(J::as_arr)
            .expect("cases")
            .iter()
            .filter(|c| c.get("kind").and_then(J::as_str) == Some("locked"))
            .collect();
        assert!(!cases.is_empty(), "the fixture has locked cases");
        let mut failures = vec![];
        for case in cases {
            let id = case.get("id").and_then(J::as_str).unwrap_or("?");
            let input = case.get("in").expect("in");
            let scope = input.get("scopeRef").and_then(J::as_str).expect("scopeRef");
            let root = input.get("projectRoot").and_then(J::as_str);
            let mut placement = J::obj([
                (
                    "agentRoot",
                    J::str("/home/operator/praesidium/var/agents/alice"),
                ),
                (
                    "correlation",
                    J::obj([(
                        "sessionRef",
                        J::obj([("scopeRef", J::str(scope)), ("laneRef", J::str("main"))]),
                    )]),
                ),
            ]);
            if let Some(root) = root {
                placement.set("projectRoot", J::str(root));
            }
            let handle = handle_parts(&placement, true)
                .unwrap_or_else(|_| panic!("{id}: handle_parts refused"));
            let actual = locked_asp_project(&handle, root);
            let expected = case
                .get("expected")
                .and_then(|e| e.get("ASP_PROJECT"))
                .and_then(J::as_str)
                .map(str::to_owned);
            if actual != expected {
                failures.push(format!("{id}: expected {expected:?}, got {actual:?}"));
            }
        }
        assert!(
            failures.is_empty(),
            "locked env cases failed:\n{}",
            failures.join("\n")
        );
    }
}
