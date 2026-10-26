//! The compile request: aspc params validation (compile-params.ts), the
//! shapes raspd compiles natively, provisioning sources
//! (harness-selection/compile-provisioning.ts), harness selection
//! (harness-selection/resolve.ts + catalog.ts), and the agent-profile and
//! project-target reads the compile makes (agent-project-merge.ts,
//! placement-resolver.ts).
use super::{Fwd, fwd, fwd_at};
use crate::json::J;
use crate::reads::jspath::{basename, join, read_text};
use crate::reads::patterns::validate_token;
use crate::reads::{profile, targets};

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

const REQUESTED: [&str; 5] = [
    "harness",
    "modelProvider",
    "model",
    "reasoningEffort",
    "presentation",
];
const DIRECTIVES: [&str; 5] = [
    "harness",
    "model_provider",
    "model",
    "reasoning_effort",
    "presentation",
];

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

const RUN_MODES: [&str; 4] = ["query", "heartbeat", "task", "maintenance"];

/// What the gate found wrong with one value, as `<path>:<problem>` (the
/// relay's `fallbackDetail`); `None` when it is acceptable.
type Problem = Option<String>;

/// `<path>.<key>:unexpected_key` for the first key outside `keys`.
fn unexpected_key(v: &J, keys: &[&str], path: &str) -> Problem {
    v.js_entries()
        .into_iter()
        .find(|(k, _)| !keys.contains(k))
        .map(|(k, _)| format!("{path}.{k}:unexpected_key"))
}

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
        .or_else(|| {
            unexpected_key(
                placement,
                &[
                    "agentRoot",
                    "projectRoot",
                    "cwd",
                    "runMode",
                    "bundle",
                    "correlation",
                    "dryRun",
                    "dispatchEnv",
                ],
                "placement",
            )
        })
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
        .or_else(|| unexpected_key(b, &["kind", "agentName", "projectRoot"], path))
}

fn placement_correlation_problem(correlation: Option<&J>) -> Problem {
    let path = "placement.correlation";
    let c = correlation.expect("present");
    kind(Some(c), path, J::is_record, "record")
        .or_else(|| {
            opt(c.get("sessionRef"), |s| {
                let s = s.expect("present");
                let path = "placement.correlation.sessionRef";
                want_str(s.get("scopeRef"), &format!("{path}.scopeRef"))
                    .or_else(|| want_str(s.get("laneRef"), &format!("{path}.laneRef")))
                    .or_else(|| unexpected_key(s, &["scopeRef", "laneRef"], path))
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
        .or_else(|| {
            unexpected_key(
                c,
                &[
                    "hostSessionId",
                    "runId",
                    "generation",
                    "sessionRef",
                    "runtimeId",
                    "invocationId",
                    "initialInputId",
                ],
                path,
            )
        })
}

fn materialization_problem(material: &J) -> Problem {
    let path = "materialization";
    opt_str_at(material.get("initialPrompt"), "materialization.initialPrompt")
        .or_else(|| opt_bool_at(material.get("omitPriming"), "materialization.omitPriming"))
        .or_else(|| match material.get("attachments") {
            None => None,
            Some(J::Arr(x)) if x.is_empty() => None,
            Some(J::Arr(_)) => Some("materialization.attachments:not_empty".to_owned()),
            Some(_) => Some("materialization.attachments:not_array".to_owned()),
        })
        .or_else(|| {
            opt(material.get("taskContext"), |t| {
                let t = t.expect("present");
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
                    .or_else(|| {
                        unexpected_key(
                            t,
                            &["taskId", "phase", "role", "requiredEvidenceKinds", "hintsText"],
                            path,
                        )
                    })
            })
        })
        .or_else(|| {
            unexpected_key(
                material,
                &["initialPrompt", "omitPriming", "attachments", "taskContext"],
                path,
            )
        })
}

fn hrc_policy_problem(policy: &J) -> Problem {
    let path = "hrcPolicy";
    opt(policy.get("resourceLimits"), |l| {
        let l = l.expect("present");
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
    .or_else(|| {
        unexpected_key(
            policy,
            &[
                "permissionPolicy",
                "inputPolicy",
                "exposurePolicy",
                "resourceLimits",
                "observability",
                "capabilityPolicy",
                "disallowedTools",
            ],
            path,
        )
    })
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
        return Err(fwd("empty_asp_home"));
    }
    if p.get("compileContext").is_some() {
        return Err(fwd("compile_context"));
    }
    let req = p.get("compileRequest").expect("validated");
    let gates: [(&'static str, Problem); 5] = [
        (
            "placement_shape",
            placement_problem(req.get("placement").expect("validated")),
        ),
        (
            "materialization_shape",
            materialization_problem(req.get("materialization").expect("validated")),
        ),
        (
            "hrc_policy_shape",
            hrc_policy_problem(req.get("hrcPolicy").expect("validated")),
        ),
        (
            "continuation_shape",
            req.get("continuation").and_then(continuation_problem),
        ),
        (
            "correlation_shape",
            correlation_problem(req.get("correlation").expect("validated")),
        ),
    ];
    match gates.into_iter().find_map(|(r, p)| p.map(|d| (r, d))) {
        Some((reason, detail)) => Err(fwd_at(reason, detail)),
        None => Ok(()),
    }
}

// -- the agent profile and project target ------------------------------------

/// The validated agent profile: the raw TOML plus R2's typed reads.
pub struct Profile {
    pub raw: J,
    pub typed: profile::Profile,
}

pub fn read_profile(agent_root: &str) -> Result<Profile, Fwd> {
    let path = join(&[agent_root, "agent-profile.toml"]);
    let content = if std::path::Path::new(&path).exists() {
        read_text(&path).map_err(|_| fwd("source_read_unavailable"))?
    } else {
        "version = 4\n".to_owned()
    };
    let typed = match profile::parse(&content) {
        Ok(p) => p,
        Err(profile::ProfileError::Forward(r)) => return Err(fwd(r)),
        Err(profile::ProfileError::Invalid(_)) => return Err(fwd("agent_profile_invalid")),
    };
    let raw = crate::reads::toml::parse(&content).map_err(|_| fwd("profile_toml_syntax"))?;
    Ok(Profile { raw, typed })
}

/// The project's `asp-targets.toml` and this agent's target in it.
pub struct ProjectTargets {
    pub target: Option<J>,
}

pub fn read_targets(project_root: Option<&str>, agent_name: &str) -> Result<ProjectTargets, Fwd> {
    let Some(project_root) = project_root else {
        return Ok(ProjectTargets { target: None });
    };
    let path = join(&[project_root, "asp-targets.toml"]);
    if !std::path::Path::new(&path).exists() {
        return Ok(ProjectTargets { target: None });
    }
    let content = read_text(&path).map_err(|_| fwd("source_read_unavailable"))?;
    let manifest = match targets::parse(&content) {
        Ok(m) => m,
        Err(targets::TargetsError::Forward(r)) => return Err(fwd(r)),
        Err(targets::TargetsError::Invalid(_)) => return Err(fwd("project_targets_invalid")),
    };
    let target = manifest
        .get("targets")
        .and_then(|t| t.get(agent_name))
        .cloned();
    Ok(ProjectTargets { target })
}

/// `session.metadata` leaves of profile then target, as `layerSessionMetadata`.
pub fn session_metadata(profile: &J, target: Option<&J>) -> (J, Vec<J>) {
    fn flatten(v: &J, prefix: &str, out: &mut Vec<(String, J)>) {
        for (k, leaf) in v.js_entries() {
            let path = if prefix.is_empty() {
                k.to_owned()
            } else {
                format!("{prefix}.{k}")
            };
            if leaf.is_record() {
                flatten(leaf, &path, out);
            } else {
                match out.iter_mut().find(|(p, _)| *p == path) {
                    Some(slot) => slot.1 = leaf.clone(),
                    None => out.push((path, leaf.clone())),
                }
            }
        }
    }
    let mut leaves = vec![];
    if let Some(m) = profile.get("session").and_then(|s| s.get("metadata")) {
        flatten(m, "", &mut leaves);
    }
    if let Some(m) = target
        .and_then(|t| t.get("session"))
        .and_then(|s| s.get("metadata"))
    {
        flatten(m, "", &mut leaves);
    }
    let key_ok = |k: &str| {
        k.len() <= 128
            && k.split('.').count() <= 4
            && k.split('.').all(|seg| {
                let mut chars = seg.chars();
                chars.next().is_some_and(|c| c.is_ascii_lowercase())
                    && seg.len() <= 64
                    && chars.all(|c| c.is_ascii_alphanumeric())
            })
    };
    let scalar = |v: &J| {
        matches!(v, J::Null | J::Str(_) | J::Bool(_)) || matches!(v, J::Num(n) if n.is_finite())
    };
    let mut accepted: Vec<(String, J)> = vec![];
    let mut diagnostics = vec![];
    for (key, value) in leaves {
        let reason = if !key_ok(&key) {
            Some("invalid metadata key")
        } else if !scalar(&value) && !matches!(&value, J::Arr(items) if items.iter().all(scalar)) {
            Some("value must be a JSON scalar or array of scalars")
        } else if value.to_json().len() > 4096 {
            Some("value exceeds 4096 bytes")
        } else if accepted
            .iter()
            .any(|(e, _)| e.starts_with(&format!("{key}.")) || key.starts_with(&format!("{e}.")))
        {
            Some("metadata prefix collision")
        } else if accepted.len() >= 64 {
            Some("metadata exceeds 64 keys")
        } else {
            None
        };
        match reason {
            Some(r) => diagnostics.push(J::obj([
                ("level", J::str("warning")),
                ("code", J::str("session_metadata_rejected")),
                ("message", J::str(format!("{key}: {r}"))),
                ("plane", J::str("asp-compiler")),
            ])),
            None => accepted.push((key, value)),
        }
    }
    (J::Obj(accepted), diagnostics)
}

// -- harness selection ---------------------------------------------------------

pub struct Selection {
    pub selection: J,
    pub model: String,
    pub reasoning_effort: Option<String>,
}

const CLAUDE_MODELS: [&str; 6] = [
    "opus[1m]",
    "opus",
    "fable",
    "sonnet",
    "haiku",
    "claude-sonnet-4-5",
];

/// One wire-spelled provisioning layer (`toWireLayer`).
fn wire_layer(source: Option<&J>, snake: bool) -> Vec<(String, J)> {
    let Some(source) = source else { return vec![] };
    let mut out = vec![];
    for (wire, key) in REQUESTED
        .iter()
        .zip(if snake { DIRECTIVES } else { REQUESTED })
    {
        if let Some(v) = source.get(key) {
            out.push(((*wire).to_owned(), v.clone()));
        }
    }
    out
}

/// `selection.<key>:<value>@<layer that set it>`, a selection forward's detail.
fn picked(key: &str, value: &str, from: &Option<(J, &str)>) -> String {
    let source = from.as_ref().map_or("catalog-default", |(_, s)| *s);
    format!("selection.{key}:{value}@{source}")
}

/// `resolveHarnessExecution` for the claude-code recipe; any other recipe or
/// any refusal is relayed to Bun.
pub fn resolve_selection(req: &J, profile: &Profile, target: Option<&J>) -> Result<Selection, Fwd> {
    let agent_id = req
        .get("agent")
        .and_then(|a| a.get("id"))
        .and_then(J::as_str)
        .unwrap_or_default();
    let placement = req.get("placement").expect("validated");
    let agent_root = placement
        .get("agentRoot")
        .and_then(J::as_str)
        .unwrap_or_default();
    let agent_name = placement
        .get("bundle")
        .and_then(|b| b.get("agentName"))
        .and_then(J::as_str);
    if basename(agent_root) != agent_id || agent_name.is_some_and(|n| n != agent_id) {
        return Err(fwd("configured_context_mismatch"));
    }
    let profile_layer: Vec<(String, J)> = {
        let scalars = J::Obj(profile.typed.provisioning.clone().unwrap_or_default());
        wire_layer(profile.typed.provisioning.as_ref().map(|_| &scalars), true)
    };
    let target_layer = wire_layer(target.and_then(|t| t.get("provisioning")), true);
    let summon_layer = wire_layer(
        req.get("selectionContext")
            .and_then(|s| s.get("summonDirectives")),
        true,
    );
    let requested: Vec<(String, J)> = match req.get("requested") {
        Some(J::Obj(f)) => f.clone(),
        _ => vec![],
    };
    let layers: [(&str, &Vec<(String, J)>); 4] = [
        ("compile-request", &requested),
        ("summon-directive", &summon_layer),
        ("project-target", &target_layer),
        ("agent-profile", &profile_layer),
    ];
    let scalar = |key: &str| -> Option<(J, &str)> {
        layers.iter().find_map(|(source, layer)| {
            layer
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| (v.clone(), *source))
        })
    };
    let harness = scalar("harness");
    let harness_id = harness
        .as_ref()
        .and_then(|(v, _)| v.as_str())
        .unwrap_or("agent-harness");
    if harness_id != "claude" {
        return Err(fwd_at(
            "recipe_not_native",
            picked("harness", harness_id, &harness),
        ));
    }
    let provider = scalar("modelProvider");
    let provider_id = provider
        .as_ref()
        .and_then(|(v, _)| v.as_str())
        .unwrap_or("anthropic");
    if provider_id != "anthropic" {
        return Err(fwd_at(
            "unsupported_model_provider",
            picked("modelProvider", provider_id, &provider),
        ));
    }
    let model = scalar("model");
    let model_id = match &model {
        Some((J::Str(m), _)) => m.clone(),
        Some(_) => return Err(fwd("model_shape")),
        None => "opus[1m]".into(),
    };
    if !CLAUDE_MODELS.contains(&model_id.as_str()) {
        return Err(fwd_at(
            "unsupported_model",
            picked("model", &model_id, &model),
        ));
    }
    let presentation = layers.iter().find_map(|(source, layer)| {
        layer
            .iter()
            .find(|(k, _)| k == "presentation")
            .and_then(|(_, v)| matches!(v, J::Bool(_)).then(|| (v.clone(), *source)))
    });
    let effort = scalar("reasoningEffort");
    let effort_id = match &effort {
        Some((J::Str(e), _)) => Some(e.clone()),
        Some(_) => return Err(fwd("reasoning_effort_shape")),
        None => None,
    };
    let source =
        |s: &Option<(J, &str)>| J::str(s.as_ref().map_or("catalog-default", |(_, src)| *src));
    let mut selection = J::obj([
        ("harness", J::str("claude")),
        ("modelProvider", J::str(provider_id)),
        ("model", J::str(&model_id)),
    ]);
    if let Some(e) = &effort_id {
        selection.set("reasoningEffort", J::str(e));
    }
    selection.set(
        "presentation",
        presentation
            .as_ref()
            .map_or(J::Bool(true), |(v, _)| v.clone()),
    );
    let mut provenance = J::obj([
        ("harness", source(&harness)),
        ("modelProvider", source(&provider)),
        ("model", source(&model)),
    ]);
    if effort_id.is_some() {
        provenance.set("reasoningEffort", source(&effort));
    }
    provenance.set("presentation", source(&presentation));
    selection.set("provenance", provenance);
    Ok(Selection {
        selection,
        model: model_id,
        reasoning_effort: effort_id,
    })
}

/// `validateToken` on a scope segment: `None` when valid.
pub fn token_error(value: &str, label: &str) -> Option<String> {
    validate_token(value, label)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        shape_supported(p).map_err(|f| (f.reason, f.detail))
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
            detail("placement_shape", "placement.image:unexpected_key")
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
            detail("placement_shape", "placement.bundle.extra:unexpected_key")
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
            verdict(&edit(
                &[cr, "materialization", "attachments"],
                Some(parse("[1]"))
            )),
            detail(
                "materialization_shape",
                "materialization.attachments:not_empty"
            )
        );
        assert_eq!(
            verdict(&edit(&[cr, "materialization", "x"], Some(J::Null))),
            detail("materialization_shape", "materialization.x:unexpected_key")
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
            detail("hrc_policy_shape", "hrcPolicy.y:unexpected_key")
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

    #[test]
    fn selection_forwards_name_the_value_and_its_layer() {
        let req = edit(
            &["compileRequest", "requested", "harness"],
            Some(J::str("codex")),
        );
        let profile = Profile {
            raw: parse("{}"),
            typed: profile::parse("version = 4\n").ok().expect("profile"),
        };
        let target = parse(r#"{"provisioning":{"model":"gpt-9"}}"#);
        let fail = |req: &J, target: Option<&J>| {
            resolve_selection(req.get("compileRequest").unwrap(), &profile, target)
                .err()
                .map(|f| (f.reason, f.detail.unwrap_or_default()))
        };
        assert_eq!(
            fail(&req, None),
            Some((
                "recipe_not_native",
                "selection.harness:codex@compile-request".to_owned()
            ))
        );
        assert_eq!(
            fail(
                &edit(
                    &["compileRequest", "requested", "harness"],
                    Some(J::str("claude"))
                ),
                Some(&target)
            ),
            Some((
                "unsupported_model",
                "selection.model:gpt-9@project-target".to_owned()
            ))
        );
    }
}
