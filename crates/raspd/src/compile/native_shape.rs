//! The request shapes raspd compiles natively (what Bun and Rust HRC send for
//! a birth). Each gate names the first key or value it rejects as
//! `<path>:<problem>`, the forward's detail; anything rejected is relayed to Bun.
use super::{Fwd, fwd, fwd_at};
use crate::json::J;

const RUN_MODES: [&str; 4] = ["query", "heartbeat", "task", "maintenance"];

/// What the gate found wrong with one value, as `<path>:<problem>` (the
/// relay's `fallbackDetail`); `None` when it is acceptable.
type Problem = Option<String>;

/// A value's JS kind problem, for the messages below.
fn kind(v: Option<&J>, path: &str, ok: fn(&J) -> bool, want: &str) -> Problem {
    match v {
        None => Some(format!("{path}:missing")),
        Some(v) if ok(v) => None,
        Some(_) => Some(format!("{path}:not_{want}")),
    }
}

fn want_str(v: Option<&J>, path: &str) -> Problem {
    kind(v, path, |v| matches!(v, J::Str(_)), "string")
}

fn opt(v: Option<&J>, check: impl FnOnce(Option<&J>) -> Problem) -> Problem {
    v.and_then(|_| check(v))
}

fn opt_str_at(v: Option<&J>, path: &str) -> Problem {
    opt(v, |v| want_str(v, path))
}

fn opt_rec_at(v: Option<&J>, path: &str) -> Problem {
    opt(v, |v| kind(v, path, J::is_record, "record"))
}

fn opt_bool_at(v: Option<&J>, path: &str) -> Problem {
    opt(v, |v| kind(v, path, |v| matches!(v, J::Bool(_)), "boolean"))
}

fn str_map_at(v: Option<&J>, path: &str) -> Problem {
    match v {
        None => None,
        Some(J::Obj(f)) => f
            .iter()
            .find(|(_, x)| !matches!(x, J::Str(_)))
            .map(|(k, _)| format!("{path}.{k}:not_string")),
        Some(_) => Some(format!("{path}:not_record")),
    }
}

fn absolute(v: Option<&J>, path: &str) -> Problem {
    want_str(v, path).or_else(|| {
        matches!(v, Some(J::Str(s)) if !s.starts_with('/')).then(|| format!("{path}:not_absolute"))
    })
}

fn opt_absolute(v: Option<&J>, path: &str) -> Problem {
    opt(v, |v| absolute(v, path))
}

/// A value outside an allowed set is named by the value itself.
fn one_of(v: Option<&J>, allowed: &[&str], path: &str) -> Problem {
    want_str(v, path).or_else(|| match v {
        Some(J::Str(s)) if !allowed.contains(&s.as_str()) => Some(format!("{path}:{s}")),
        _ => None,
    })
}

fn placement_problem(placement: &J) -> Problem {
    let p = |k: &str| placement.get(k);
    absolute(p("agentRoot"), "placement.agentRoot")
        .or_else(|| opt_absolute(p("projectRoot"), "placement.projectRoot"))
        .or_else(|| opt_absolute(p("cwd"), "placement.cwd"))
        .or_else(|| one_of(p("runMode"), &RUN_MODES, "placement.runMode"))
        .or_else(|| bundle_problem(p("bundle")))
        .or_else(|| opt(p("correlation"), placement_correlation_problem))
        .or_else(|| opt_bool_at(p("dryRun"), "placement.dryRun"))
        .or_else(|| str_map_at(p("dispatchEnv"), "placement.dispatchEnv"))
        .or_else(|| locked_env_problem(p("lockedEnv")))
        .or_else(|| scaffold_packets_problem(p("scaffoldPackets")))
}

/// placement.lockedEnv folds into the plan's lockedEnv (compose-agent-env.ts),
/// which validateInvocationSpec judges with `validateEnv`: a key Bun refuses
/// there (compiler_exception, after its writes) refuses here before any.
fn locked_env_problem(env: Option<&J>) -> Problem {
    let path = "placement.lockedEnv";
    let fields = match env {
        None | Some(J::Null) => return None,
        Some(J::Obj(fields)) => fields,
        Some(_) => return Some(format!("{path}:not_record")),
    };
    fields.iter().find_map(|(k, v)| {
        let problem = if !env_key_shaped(k) {
            Some("invalid_env_key")
        } else if env_key_ambient(k) {
            Some("ambient_env_key")
        } else if env_key_credential(k) {
            Some("credential_env_key")
        } else if env_key_reserved(k) {
            Some("reserved_env_key")
        } else if !matches!(v, J::Str(_)) {
            Some("not_string")
        } else {
            None
        };
        problem.map(|p| format!("{path}.{k}:{p}"))
    })
}

/// env-keys.ts ENV_KEY_PATTERN, `^[A-Za-z_][A-Za-z0-9_]*$`.
fn env_key_shaped(k: &str) -> bool {
    let mut chars = k.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// env-keys.ts `isAmbientEnvKey`.
fn env_key_ambient(k: &str) -> bool {
    [
        "HOME", "PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "USER", "USERNAME", "TERM", "LANG", "TZ",
    ]
    .contains(&k)
        || k.starts_with("LC_")
}

/// env-keys.ts `isCredentialEnvKey`.
fn env_key_credential(k: &str) -> bool {
    [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "GITHUB_TOKEN",
    ]
    .contains(&k)
        || k.ends_with("_TOKEN")
        || k.ends_with("_PASSWORD")
}

/// env-keys.ts `isReservedEnvKey`.
fn env_key_reserved(k: &str) -> bool {
    [
        "SSH_AUTH_SOCK",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ]
    .contains(&k)
        || ["NODE_", "npm_", "NPM_", "XDG_"]
            .iter()
            .any(|p| k.starts_with(p))
}

/// placement.scaffoldPackets (RunScaffoldPacket[]): the system prompt's
/// scaffold sections and the plan's scaffold instruction slots. raspd compiles
/// the typed shape only.
fn scaffold_packets_problem(packets: Option<&J>) -> Problem {
    let ok = match packets {
        None => true,
        Some(J::Arr(items)) => items.iter().all(|p| {
            p.is_record()
                && matches!(p.get("slot"), Some(J::Str(_)))
                && ["content", "ref"]
                    .iter()
                    .all(|k| p.get(k).is_none_or(|v| matches!(v, J::Str(_))))
        }),
        Some(_) => false,
    };
    (!ok).then(|| "placement.scaffoldPackets:invalid".to_owned())
}

fn bundle_problem(bundle: Option<&J>) -> Problem {
    let path = "placement.bundle";
    let Some(b) = bundle else {
        return Some(format!("{path}:missing"));
    };
    kind(Some(b), path, J::is_record, "record")
        .or_else(|| one_of(b.get("kind"), &["agent-project"], "placement.bundle.kind"))
        .or_else(|| {
            want_str(b.get("agentName"), "placement.bundle.agentName").or_else(|| {
                (b.get("agentName") == Some(&J::str("")))
                    .then(|| "placement.bundle.agentName:empty".to_owned())
            })
        })
        .or_else(|| opt_absolute(b.get("projectRoot"), "placement.bundle.projectRoot"))
}

fn placement_correlation_problem(correlation: Option<&J>) -> Problem {
    let path = "placement.correlation";
    let Some(c) = correlation else {
        return Some(format!("{path}:missing"));
    };
    kind(Some(c), path, J::is_record, "record")
        .or_else(|| {
            c.get("sessionRef").and_then(|s| {
                let path = "placement.correlation.sessionRef";
                want_str(s.get("scopeRef"), &format!("{path}.scopeRef"))
                    .or_else(|| want_str(s.get("laneRef"), &format!("{path}.laneRef")))
            })
        })
        .or_else(|| {
            [
                "hostSessionId",
                "runId",
                "runtimeId",
                "invocationId",
                "initialInputId",
            ]
            .iter()
            .find_map(|k| opt_str_at(c.get(k), &format!("{path}.{k}")))
        })
        .or_else(|| {
            opt(c.get("generation"), |g| {
                (!matches!(g, Some(J::Num(n)) if n.fract() == 0.0 && n.abs() < 1e15))
                    .then(|| format!("{path}.generation:not_integer"))
            })
        })
}

fn materialization_problem(material: &J) -> Problem {
    opt_str_at(material.get("initialPrompt"), "materialization.initialPrompt")
        .or_else(|| opt_bool_at(material.get("omitPriming"), "materialization.omitPriming"))
        .or_else(|| match material.get("attachments") {
            None | Some(J::Arr(_)) => None,
            Some(_) => Some("materialization.attachments:not_array".to_owned()),
        })
        .or_else(|| {
            material.get("taskContext").and_then(|t| {
                let path = "materialization.taskContext";
                want_str(t.get("taskId"), &format!("{path}.taskId"))
                    .or_else(|| {
                        let kinds = t.get("requiredEvidenceKinds");
                        let ok = matches!(kinds, Some(J::Arr(k)) if k.iter().all(|x| matches!(x, J::Str(_))));
                        (!ok).then(|| format!("{path}.requiredEvidenceKinds:invalid"))
                    })
                    .or_else(|| {
                        ["phase", "role", "hintsText"].iter().find_map(|k| {
                            t.get(k)
                                .filter(|v| !matches!(v, J::Str(_) | J::Null))
                                .map(|_| format!("{path}.{k}:not_string"))
                        })
                    })
            })
        })
}

fn hrc_policy_problem(policy: &J) -> Problem {
    policy
        .get("resourceLimits")
        .and_then(|l| {
            let path = "hrcPolicy.resourceLimits";
            kind(Some(l), path, J::is_record, "record").or_else(|| {
                [
                    "startupTimeoutMs",
                    "turnTimeoutMs",
                    "stopGraceMs",
                    "maxEventBytes",
                ]
                .iter()
                .find_map(|k| {
                    opt(l.get(k), |v| {
                        kind(
                            v,
                            &format!("{path}.{k}"),
                            |v| matches!(v, J::Num(_)),
                            "number",
                        )
                    })
                })
            })
        })
        .or_else(|| {
            let ok = policy
                .get("disallowedTools")
                .is_none_or(|t| matches!(t, J::Arr(x) if x.iter().all(|i| matches!(i, J::Str(_)))));
            (!ok).then(|| "hrcPolicy.disallowedTools:invalid".to_owned())
        })
        .or_else(|| opt_rec_at(policy.get("permissionPolicy"), "hrcPolicy.permissionPolicy"))
        .or_else(|| opt_rec_at(policy.get("inputPolicy"), "hrcPolicy.inputPolicy"))
        .or_else(|| opt_rec_at(policy.get("exposurePolicy"), "hrcPolicy.exposurePolicy"))
}

fn continuation_problem(c: &J) -> Problem {
    let path = "continuation";
    kind(Some(c), path, J::is_record, "record")
        .or_else(|| match c.get("hrc") {
            None => Some("continuation.hrc:missing".to_owned()),
            Some(h) => want_str(h.get("provider"), "continuation.hrc.provider")
                .or_else(|| opt_str_at(h.get("key"), "continuation.hrc.key"))
                .or_else(|| opt_str_at(h.get("continuationId"), "continuation.hrc.continuationId")),
        })
        .or_else(|| opt_rec_at(c.get("broker"), "continuation.broker"))
        .or_else(|| want_str(c.get("source"), "continuation.source"))
}

fn correlation_problem(correlation: &J) -> Problem {
    [
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
    ]
    .iter()
    .find_map(|k| opt_str_at(correlation.get(k), &format!("correlation.{k}")))
}

/// The request shapes raspd compiles natively (what Bun and Rust HRC send
/// for a birth). Anything else is relayed to Bun, with the first key or value
/// that decided it as the forward's detail.
pub fn shape_supported(p: &J) -> Result<(), Fwd> {
    // `clientAspHome ? … : …` drops an empty aspHome in one place and keeps
    // it in another; raspd does not judge that request.
    if p.get("aspHome") == Some(&J::str("")) {
        return Err(fwd(crate::reason!("empty_asp_home")));
    }
    let req = p
        .get("compileRequest")
        .ok_or_else(|| fwd(crate::reason!("invalid_params")))?;
    let gates: [(crate::disposition::Reason, Problem); 5] = [
        (
            crate::reason!("placement_shape"),
            placement_problem(
                req.get("placement")
                    .ok_or_else(|| fwd(crate::reason!("invalid_params")))?,
            ),
        ),
        (
            crate::reason!("materialization_shape"),
            materialization_problem(
                req.get("materialization")
                    .ok_or_else(|| fwd(crate::reason!("invalid_params")))?,
            ),
        ),
        (
            crate::reason!("hrc_policy_shape"),
            hrc_policy_problem(
                req.get("hrcPolicy")
                    .ok_or_else(|| fwd(crate::reason!("invalid_params")))?,
            ),
        ),
        (
            crate::reason!("continuation_shape"),
            req.get("continuation").and_then(continuation_problem),
        ),
        (
            crate::reason!("correlation_shape"),
            correlation_problem(
                req.get("correlation")
                    .ok_or_else(|| fwd(crate::reason!("invalid_params")))?,
            ),
        ),
    ];
    match gates.into_iter().find_map(|(r, p)| p.map(|d| (r, d))) {
        // Bun compiles a relative placement path into a plan of relative
        // paths; raspd refuses it as invalid params (T-13048).
        Some((reason, detail)) if detail.ends_with(":not_absolute") => Err(fwd_at(
            reason.within(crate::disposition::Context::RelativePath),
            detail,
        )),
        Some((reason, detail)) => Err(fwd_at(reason, detail)),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::compile::params::params_valid;

    fn parse(s: &str) -> J {
        crate::json::parse(s.as_bytes()).expect("json")
    }

    /// A birth request raspd compiles natively.
    fn params() -> J {
        parse(
            r#"{"compileRequest":{"schemaVersion":"agent-runtime-compile-request/v2",
            "agent":{"id":"clod"},"identity":{},
            "placement":{"agentRoot":"/a/clod","projectRoot":"/p","cwd":"/p","runMode":"task",
              "bundle":{"kind":"agent-project","agentName":"clod","projectRoot":"/p"},
              "correlation":{"sessionRef":{"scopeRef":"agent:clod","laneRef":"main"},"generation":1}},
            "requested":{},"materialization":{"initialPrompt":"hi"},
            "hrcPolicy":{"resourceLimits":{"startupTimeoutMs":1}},
            "correlation":{"runtimeId":"rt-1"}},
            "aspHome":"/h"}"#,
        )
    }

    fn edit(path: &[&str], value: Option<J>) -> J {
        fn walk(v: &mut J, path: &[&str], value: Option<J>) {
            if path.len() == 1 {
                match value {
                    Some(x) => v.set(path[0], x),
                    None => {
                        v.remove(path[0]);
                    }
                }
                return;
            }
            let J::Obj(fields) = v else {
                panic!("not a record")
            };
            let (_, child) = fields.iter_mut().find(|(k, _)| k == path[0]).expect("path");
            walk(child, &path[1..], value);
        }
        let mut p = params();
        walk(&mut p, path, value);
        p
    }

    fn verdict(p: &J) -> Result<(), (&'static str, Option<String>)> {
        assert!(
            params_valid(Some(p)),
            "fixture must pass aspc params validation"
        );
        shape_supported(p).map_err(|f| (f.reason.as_str(), f.detail))
    }

    fn detail(reason: &'static str, d: &str) -> Result<(), (&'static str, Option<String>)> {
        Err((reason, Some(d.to_owned())))
    }

    #[test]
    fn the_baseline_is_native() {
        assert_eq!(verdict(&params()), Ok(()));
    }

    #[test]
    fn placement_details_name_the_key_or_value() {
        let cr = "compileRequest";
        let pl = "placement";
        assert_eq!(
            verdict(&edit(&[cr, pl, "image"], Some(J::str("x")))),
            Ok(())
        );
        assert_eq!(
            verdict(&edit(&[cr, pl, "cwd"], Some(J::str("rel/dir")))),
            detail("placement_shape", "placement.cwd:not_absolute")
        );
        assert_eq!(
            verdict(&edit(&[cr, pl, "runMode"], Some(J::str("bogus")))),
            detail("placement_shape", "placement.runMode:bogus")
        );
        assert_eq!(
            verdict(&edit(&[cr, pl, "runMode"], None)),
            detail("placement_shape", "placement.runMode:missing")
        );
        assert_eq!(
            verdict(&edit(&[cr, pl, "agentRoot"], Some(J::Num(1.0)))),
            detail("placement_shape", "placement.agentRoot:not_string")
        );
        assert_eq!(
            verdict(&edit(
                &[cr, pl, "bundle", "kind"],
                Some(J::str("agent-only"))
            )),
            detail("placement_shape", "placement.bundle.kind:agent-only")
        );
        assert_eq!(
            verdict(&edit(&[cr, pl, "bundle", "extra"], Some(J::Bool(true)))),
            Ok(())
        );
        assert_eq!(
            verdict(&edit(
                &[cr, pl, "correlation", "sessionRef", "laneRef"],
                None
            )),
            detail(
                "placement_shape",
                "placement.correlation.sessionRef.laneRef:missing"
            )
        );
        assert_eq!(
            verdict(&edit(
                &[cr, pl, "correlation", "generation"],
                Some(J::Num(1.5))
            )),
            detail(
                "placement_shape",
                "placement.correlation.generation:not_integer"
            )
        );
        assert_eq!(
            verdict(&edit(&[cr, pl, "dryRun"], Some(J::str("yes")))),
            detail("placement_shape", "placement.dryRun:not_boolean")
        );
        assert_eq!(
            verdict(&edit(&[cr, pl, "dispatchEnv"], Some(parse(r#"{"A":1}"#)))),
            detail("placement_shape", "placement.dispatchEnv.A:not_string")
        );
    }

    #[test]
    fn the_other_gate_reasons_name_their_key() {
        let cr = "compileRequest";
        assert_eq!(
            verdict(&edit(&[cr, "materialization", "x"], Some(J::Null))),
            Ok(())
        );
        assert_eq!(
            verdict(&edit(
                &[cr, "hrcPolicy", "resourceLimits", "turnTimeoutMs"],
                Some(J::str("9"))
            )),
            detail(
                "hrc_policy_shape",
                "hrcPolicy.resourceLimits.turnTimeoutMs:not_number"
            )
        );
        assert_eq!(
            verdict(&edit(&[cr, "hrcPolicy", "y"], Some(J::Null))),
            Ok(())
        );
        assert_eq!(
            verdict(&edit(
                &[cr, "continuation"],
                Some(parse(r#"{"source":"hrc"}"#))
            )),
            detail("continuation_shape", "continuation.hrc:missing")
        );
        assert_eq!(
            verdict(&edit(&[cr, "correlation", "traceId"], Some(J::Num(3.0)))),
            detail("correlation_shape", "correlation.traceId:not_string")
        );
        assert_eq!(
            verdict(&edit(&["aspHome"], Some(J::str("")))),
            Err(("empty_asp_home", None))
        );
    }
}
