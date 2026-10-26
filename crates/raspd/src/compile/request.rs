//! The compile request: aspc params validation (compile-params.ts), the
//! shapes raspd compiles natively, provisioning sources
//! (harness-selection/compile-provisioning.ts), harness selection
//! (harness-selection/resolve.ts + catalog.ts), and the agent-profile and
//! project-target reads the compile makes (agent-project-merge.ts,
//! placement-resolver.ts).
use super::{Fwd, fwd};
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

/// The request shapes raspd compiles natively (what Bun and Rust HRC send
/// for a birth). Anything else is relayed to Bun.
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
    let placement = req.get("placement").expect("validated");
    let abs = |v: Option<&J>| matches!(v, Some(J::Str(s)) if s.starts_with('/'));
    let bundle_ok = placement.get("bundle").is_some_and(|b| {
        b.get("kind") == Some(&J::str("agent-project"))
            && matches!(b.get("agentName"), Some(J::Str(s)) if !s.is_empty())
            && (b.get("projectRoot").is_none() || abs(b.get("projectRoot")))
            && only(b, &["kind", "agentName", "projectRoot"])
    });
    let correlation_ok = placement.get("correlation").is_none_or(|c| {
        c.is_record()
            && c.get("sessionRef").is_none_or(|s| {
                is_str(s.get("scopeRef"))
                    && is_str(s.get("laneRef"))
                    && only(s, &["scopeRef", "laneRef"])
            })
            && [
                "hostSessionId",
                "runId",
                "runtimeId",
                "invocationId",
                "initialInputId",
            ]
            .iter()
            .all(|k| opt_str(c.get(k)))
            && c.get("generation")
                .is_none_or(|g| matches!(g, J::Num(n) if n.fract() == 0.0 && n.abs() < 1e15))
            && only(
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
            )
    });
    let placement_ok = abs(placement.get("agentRoot"))
        && (placement.get("projectRoot").is_none() || abs(placement.get("projectRoot")))
        && (placement.get("cwd").is_none() || abs(placement.get("cwd")))
        && matches!(placement.get("runMode"), Some(J::Str(m)) if RUN_MODES.contains(&m.as_str()))
        && bundle_ok
        && correlation_ok
        && placement
            .get("dryRun")
            .is_none_or(|d| matches!(d, J::Bool(_)))
        && str_map(placement.get("dispatchEnv"))
        && only(
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
        );
    if !placement_ok {
        return Err(fwd("placement_shape"));
    }
    let material = req.get("materialization").expect("validated");
    let task_ok = material.get("taskContext").is_none_or(|t| {
        is_str(t.get("taskId"))
            && matches!(t.get("requiredEvidenceKinds"), Some(J::Arr(k)) if k.iter().all(|x| matches!(x, J::Str(_))))
            && ["phase", "role", "hintsText"].iter().all(|k| t.get(k).is_none_or(|v| matches!(v, J::Str(_) | J::Null)))
            && only(t, &["taskId", "phase", "role", "requiredEvidenceKinds", "hintsText"])
    });
    let attachments_ok = material
        .get("attachments")
        .is_none_or(|a| matches!(a, J::Arr(x) if x.is_empty()));
    if !(opt_str(material.get("initialPrompt"))
        && material
            .get("omitPriming")
            .is_none_or(|o| matches!(o, J::Bool(_)))
        && attachments_ok
        && task_ok
        && only(
            material,
            &["initialPrompt", "omitPriming", "attachments", "taskContext"],
        ))
    {
        return Err(fwd("materialization_shape"));
    }
    let policy = req.get("hrcPolicy").expect("validated");
    let limits_ok = policy.get("resourceLimits").is_none_or(|l| {
        l.is_record()
            && [
                "startupTimeoutMs",
                "turnTimeoutMs",
                "stopGraceMs",
                "maxEventBytes",
            ]
            .iter()
            .all(|k| l.get(k).is_none_or(|v| matches!(v, J::Num(_))))
    });
    let tools_ok = policy
        .get("disallowedTools")
        .is_none_or(|t| matches!(t, J::Arr(x) if x.iter().all(|i| matches!(i, J::Str(_)))));
    if !(limits_ok
        && tools_ok
        && opt_rec(policy.get("permissionPolicy"))
        && opt_rec(policy.get("inputPolicy"))
        && opt_rec(policy.get("exposurePolicy"))
        && only(
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
        ))
    {
        return Err(fwd("hrc_policy_shape"));
    }
    if let Some(c) = req.get("continuation") {
        let hrc_ok = c.get("hrc").is_some_and(|h| {
            is_str(h.get("provider")) && opt_str(h.get("key")) && opt_str(h.get("continuationId"))
        });
        if !(c.is_record() && hrc_ok && opt_rec(c.get("broker")) && is_str(c.get("source"))) {
            return Err(fwd("continuation_shape"));
        }
    }
    let correlation = req.get("correlation").expect("validated");
    if !([
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
    .all(|k| opt_str(correlation.get(k))))
    {
        return Err(fwd("correlation_shape"));
    }
    Ok(())
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
        return Err(fwd("recipe_not_native"));
    }
    let provider = scalar("modelProvider");
    let provider_id = provider
        .as_ref()
        .and_then(|(v, _)| v.as_str())
        .unwrap_or("anthropic");
    if provider_id != "anthropic" {
        return Err(fwd("unsupported_model_provider"));
    }
    let model = scalar("model");
    let model_id = match &model {
        Some((J::Str(m), _)) => m.clone(),
        Some(_) => return Err(fwd("model_shape")),
        None => "opus[1m]".into(),
    };
    if !CLAUDE_MODELS.contains(&model_id.as_str()) {
        return Err(fwd("unsupported_model"));
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
