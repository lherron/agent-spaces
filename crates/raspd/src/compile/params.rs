//! The aspc params verdict: compile-params.ts
//! `validateAspcCompileHarnessInvocationRequest`, judged before raspd decides
//! whether it compiles the request natively.
use super::selection::{DIRECTIVES, REQUESTED};
use crate::json::J;
use crate::reads::profile;

fn only(v: &J, keys: &[&str]) -> bool {
    v.js_entries().iter().all(|(k, _)| keys.contains(k))
}
fn is_str(v: Option<&J>) -> bool {
    matches!(v, Some(J::Str(_)))
}
fn opt_str(v: Option<&J>) -> bool {
    v.is_none() || is_str(v)
}
fn opt_rec(v: Option<&J>) -> bool {
    v.is_none_or(J::is_record)
}
fn str_map(v: Option<&J>) -> bool {
    v.is_none_or(|v| matches!(v, J::Obj(f) if f.iter().all(|(_, x)| matches!(x, J::Str(_)))))
}

fn selection_ok(v: &J, keys: [&str; 5]) -> bool {
    let [harness, provider, model, effort, presentation] = keys;
    v.is_record()
        && v.get(harness)
            .is_none_or(|h| matches!(h, J::Str(s) if profile::HARNESS_IDS.contains(&s.as_str())))
        && opt_str(v.get(provider))
        && opt_str(v.get(model))
        && v.get(effort).is_none_or(
            |e| matches!(e, J::Str(s) if ["low", "medium", "high", "xhigh"].contains(&s.as_str())),
        )
        && v.get(presentation).is_none_or(|p| matches!(p, J::Bool(_)))
        && only(v, &keys)
}

/// `validateAspcCompileHarnessInvocationRequest`, as a verdict.
pub fn params_valid(params: Option<&J>) -> bool {
    let Some(p) = params.filter(|p| p.is_record()) else {
        return false;
    };
    let Some(req) = p.get("compileRequest").filter(|r| r.is_record()) else {
        return false;
    };
    let context_ok = opt_rec(p.get("compileContext"))
        && p.get("compileContext").is_none_or(|c| {
            opt_str(c.get("nowIso"))
                && opt_str(c.get("idSalt"))
                && opt_rec(c.get("toolchainManifest"))
        });
    let selection_context_ok = opt_rec(req.get("selectionContext"))
        && req.get("selectionContext").is_none_or(|s| {
            s.get("summonDirectives")
                .is_none_or(|d| selection_ok(d, DIRECTIVES))
                && only(s, &["summonDirectives"])
        });
    req.get("schemaVersion") == Some(&J::str("agent-runtime-compile-request/v2"))
        && [
            "agent",
            "identity",
            "placement",
            "requested",
            "materialization",
            "hrcPolicy",
            "correlation",
        ]
        .iter()
        .all(|k| req.get(k).is_some_and(J::is_record))
        && req
            .get("agent")
            .is_some_and(|a| is_str(a.get("id")) && only(a, &["id"]))
        && req
            .get("requested")
            .is_some_and(|r| selection_ok(r, REQUESTED))
        && selection_context_ok
        && only(
            req,
            &[
                "schemaVersion",
                "agent",
                "identity",
                "placement",
                "selectionContext",
                "requested",
                "materialization",
                "hrcPolicy",
                "continuation",
                "correlation",
            ],
        )
        && opt_str(p.get("aspHome"))
        && context_ok
        && str_map(p.get("dispatchEnv"))
        && opt_rec(p.get("runtime"))
        && opt_rec(p.get("lifecyclePolicy"))
        && only(
            p,
            &[
                "compileRequest",
                "aspHome",
                "compileContext",
                "dispatchEnv",
                "runtime",
                "lifecyclePolicy",
            ],
        )
}
