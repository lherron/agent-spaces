//! The agent profile merged with its project target, as
//! `mergeAgentWithProjectTarget` and the adapters' `getDefaultRunOptions`
//! read it: priming, the composed space refs, the Claude and Codex run
//! defaults, and the codex options the fingerprint covers
//! (`loadEffectiveCodexOptions`).
use super::profile_target::Profile;
use super::{Fwd, fwd, fwd_at, s};
use crate::disposition::{Context, Reason};
use crate::json::J;
use crate::reads::jspath::join;

/// The adapter's `getDefaultRunOptions` on the synthetic agent-project manifest.
pub(super) struct ClaudeDefaults {
    pub(super) permission_mode: Option<String>,
    pub(super) extra_args: Vec<String>,
    pub(super) ask_user_question: Option<bool>,
    pub(super) yolo: bool,
    pub(super) remote: bool,
}

/// The Codex adapter's `getDefaultRunOptions` on the synthetic agent-project
/// manifest, with the run plan's `yolo` already applied to approval and
/// sandbox.
pub(super) struct CodexDefaults {
    pub(super) reasoning_effort: Option<String>,
    pub(super) approval_policy: Option<String>,
    pub(super) sandbox_mode: Option<String>,
}

/// The profile's priming (inline, else its file) under the target's
/// `priming` / `priming_append`.
pub(super) fn effective_priming(
    profile: &Profile,
    agent_root: &str,
    target: Option<&J>,
) -> Result<Option<String>, Fwd> {
    let priming = match profile.typed.priming.as_deref().filter(|p| !p.is_empty()) {
        Some(p) => Some(p.to_owned()),
        None => match profile
            .typed
            .priming_file
            .as_deref()
            .filter(|p| !p.is_empty())
        {
            Some(file) => Some(
                std::fs::read_to_string(join(&[agent_root, file]))
                    .map_err(|_| fwd(crate::reason!("priming_file_unreadable")))?,
            ),
            None => None,
        },
    };
    Ok(match target {
        None => priming,
        Some(t) => match (t.get("priming"), t.get("priming_append")) {
            (Some(_), Some(_)) => return Err(fwd(crate::reason!("priming_conflict"))),
            (Some(J::Str(p)), _) => Some(p.clone()),
            (_, Some(J::Str(a))) if priming.as_deref().is_some_and(|p| !p.is_empty()) => {
                Some(format!("{}\n{a}", priming.clone().unwrap_or_default()))
            }
            _ => priming,
        },
    })
}

/// The composed space refs: the profile's base and run-mode spaces, replaced
/// by (or, with `compose_mode = "merge"`, merged with) the target's compose.
pub(super) fn compose(raw: &J, run_mode: Option<&str>, target: Option<&J>) -> Vec<String> {
    let agent_compose = dedupe_spaces(
        raw.get("spaces")
            .and_then(|sp| sp.get("base"))
            .and_then(J::as_arr)
            .into_iter()
            .flatten()
            .filter_map(J::as_str)
            .map(str::to_owned)
            .chain(by_mode(
                raw.get("spaces").and_then(|sp| sp.get("modes")),
                run_mode,
            ))
            .collect(),
    );
    match target.and_then(|t| t.get("compose")).and_then(J::as_arr) {
        Some(c) if !c.is_empty() => {
            let target_compose: Vec<String> =
                c.iter().filter_map(J::as_str).map(str::to_owned).collect();
            if target.and_then(|t| s(t.get("compose_mode"))) == Some("merge") {
                dedupe_spaces(agent_compose.into_iter().chain(target_compose).collect())
            } else {
                target_compose
            }
        }
        _ => agent_compose,
    }
}

/// Merged provisioning: target scalars over profile scalars.
fn scalar(profile: &Profile, target: Option<&J>, k: &str) -> Option<J> {
    target
        .and_then(|t| t.get("provisioning"))
        .and_then(|p| p.get(k))
        .cloned()
        .or_else(|| profile.typed.scalar(k).cloned())
}

pub(super) fn claude_defaults(profile: &Profile, target: Option<&J>) -> ClaudeDefaults {
    let target_prov = target.and_then(|t| t.get("provisioning"));
    let effective = merge_claude(
        claude_opts(
            profile
                .raw
                .get("provisioning")
                .and_then(|p| p.get("claude")),
        ),
        claude_opts(target_prov.and_then(|p| p.get("claude"))),
    );
    ClaudeDefaults {
        permission_mode: effective
            .as_ref()
            .and_then(|c| c.1.as_ref())
            .and_then(J::as_str)
            .map(str::to_owned),
        extra_args: effective
            .as_ref()
            .and_then(|c| c.2.as_ref())
            .and_then(J::as_arr)
            .map(|a| a.iter().filter_map(J::as_str).map(str::to_owned).collect())
            .unwrap_or_default(),
        ask_user_question: effective.as_ref().and_then(|c| match c.3 {
            Some(J::Bool(b)) => Some(b),
            _ => None,
        }),
        yolo: matches!(scalar(profile, target, "yolo"), Some(J::Bool(true))),
        remote: matches!(scalar(profile, target, "remote"), Some(J::Bool(true))),
    }
}

/// mergeAgentWithProjectTarget's codex options through the synthetic
/// manifest's getEffectiveCodexOptions, then getDefaultRunOptions' yolo.
pub(super) fn codex_defaults(
    profile: &Profile,
    target: Option<&J>,
    yolo: bool,
) -> Result<CodexDefaults, Fwd> {
    let target_prov = target.and_then(|t| t.get("provisioning"));
    let mut synthetic = J::Obj(vec![]);
    if let Some(c) = target_prov.and_then(|p| p.get("codex")) {
        synthetic.set("codex", c.clone());
    }
    for k in ["model", "reasoning_effort", "approval", "sandbox"] {
        if let Some(v) = scalar(profile, target, k) {
            synthetic.set(k, v);
        }
    }
    let mut manifest = J::obj([(
        "targets",
        J::obj([("_", J::obj([("provisioning", synthetic)]))]),
    )]);
    if let Some(c) = profile.raw.get("provisioning").and_then(|p| p.get("codex")) {
        manifest.set("codex", c.clone());
    }
    let options = effective_codex_options(&manifest, "_");
    let text = |k: &str| match options.get(k) {
        None | Some(J::Null) => Ok(None),
        Some(J::Str(v)) => Ok(Some(v.clone())),
        Some(_) => Err(fwd_at(crate::reason!("codex_option_shape"), k.to_owned())),
    };
    Ok(CodexDefaults {
        reasoning_effort: text("model_reasoning_effort")?,
        approval_policy: if yolo {
            Some("never".into())
        } else {
            text("approval_policy")?
        },
        sandbox_mode: if yolo {
            Some("danger-full-access".into())
        } else {
            text("sandbox_mode")?
        },
    })
}

/// The fingerprint's codex options (`loadEffectiveCodexOptions`): only with
/// a project root holding asp-targets.toml.
pub(super) fn fingerprint_codex_options(
    project_root: Option<&str>,
    asp_home: &str,
    agent_name: &str,
) -> Result<Option<J>, Fwd> {
    let Some(root) = project_root
        .filter(|root| std::path::Path::new(&join(&[root, "asp-targets.toml"])).exists())
    else {
        return Ok(None);
    };
    // Bun reads this one outside the typed targets loader: its failures
    // throw (compiler_exception), hence PlacementTargets.
    let placed = |r: Reason| fwd(r.within(Context::PlacementTargets));
    // Lossy like Bun's read (targets_unreadable); a read error refuses.
    let content = crate::reads::jspath::read_text(&join(&[root, "asp-targets.toml"]))
        .map_err(|_| placed(crate::reason!("source_read_unavailable")))?;
    let manifest = match crate::reads::targets::parse(&content) {
        Ok(m) => m,
        Err(crate::reads::targets::TargetsError::Forward(r)) => return Err(placed(r)),
        Err(_) => return Err(placed(crate::reason!("project_targets_invalid"))),
    };
    Ok(Some(effective_codex_options(
        &project_manifest(manifest, asp_home)?,
        agent_name,
    )))
}

pub(super) fn by_mode(v: Option<&J>, mode: Option<&str>) -> Vec<String> {
    // `modes[undefined]` reads the key "undefined", which no valid mode is.
    let entry = mode.and_then(|mode| v.and_then(|m| m.get(mode)));
    let list = match entry {
        Some(J::Arr(items)) => Some(items),
        Some(o @ J::Obj(_)) => o.get("base").and_then(J::as_arr),
        _ => None,
    };
    list.into_iter()
        .flatten()
        .filter_map(J::as_str)
        .map(str::to_owned)
        .collect()
}

pub(super) fn dedupe_spaces(refs: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = vec![];
    let mut out = vec![];
    for r in refs {
        let key = r.strip_suffix("@dev").unwrap_or(&r).to_owned();
        if !seen.contains(&key) {
            seen.push(key);
            out.push(r);
        }
    }
    out
}

/// `mergeClaudeOptions(defaults, overrides)` as `(model, permission_mode, args, ask)`.
type ClaudeOpts = (Option<J>, Option<J>, Option<J>, Option<J>);

fn claude_opts(v: Option<&J>) -> Option<ClaudeOpts> {
    let v = v?;
    Some((
        v.get("model").cloned(),
        v.get("permission_mode").cloned(),
        v.get("args").cloned(),
        v.get("ask_user_question").cloned(),
    ))
}

fn merge_claude(d: Option<ClaudeOpts>, o: Option<ClaudeOpts>) -> Option<ClaudeOpts> {
    match (d, o) {
        (None, None) => None,
        (Some(d), None) => Some(d),
        (None, Some(o)) => Some(o),
        (Some(d), Some(o)) => Some((o.0.or(d.0), o.1.or(d.1), o.2.or(d.2), o.3.or(d.3))),
    }
}

/// `mergeCodexOptions` + `getEffectiveCodexOptions`, as `J` with only the
/// defined keys (the fingerprint's canonical JSON drops `undefined`).
fn effective_codex_options(manifest: &J, target_name: &str) -> J {
    const KEYS: [&str; 6] = [
        "model",
        "model_reasoning_effort",
        "model_reasoning_summary",
        "status_line",
        "approval_policy",
        "sandbox_mode",
    ];
    let target = manifest.get("targets").and_then(|t| t.get(target_name));
    let provisioning = target.and_then(|t| t.get("provisioning"));
    let defaults = manifest.get("codex");
    let overrides = provisioning.and_then(|p| p.get("codex"));
    let mut out = match (defaults, overrides) {
        (None, None) => J::Obj(vec![]),
        (Some(d), None) => d.clone(),
        (None, Some(o)) => o.clone(),
        (Some(d), Some(o)) => J::Obj(
            KEYS.iter()
                .filter_map(|k| {
                    o.get(k)
                        .or_else(|| d.get(k))
                        .map(|v| ((*k).to_owned(), v.clone()))
                })
                .collect(),
        ),
    };
    for (scalar, key) in [
        ("model", "model"),
        ("reasoning_effort", "model_reasoning_effort"),
        ("approval", "approval_policy"),
        ("sandbox", "sandbox_mode"),
    ] {
        if let Some(v) = provisioning.and_then(|p| p.get(scalar)) {
            out.set(key, v.clone());
        }
    }
    out
}

/// `loadProjectManifest(projectPath, aspHome)`: the project manifest merged
/// over `$ASP_HOME/default-targets.toml`.
fn project_manifest(project_manifest: J, asp_home: &str) -> Result<J, Fwd> {
    let default_path = join(&[asp_home, "default-targets.toml"]);
    if !std::path::Path::new(&default_path).exists() {
        return Ok(project_manifest);
    }
    let content = std::fs::read_to_string(&default_path)
        .map_err(|_| fwd(crate::reason!("default_targets_unreadable")))?;
    let defaults = match crate::reads::targets::parse(&content) {
        Ok(m) => m,
        Err(crate::reads::targets::TargetsError::Forward(r)) => return Err(fwd(r)),
        Err(_) => return Err(fwd(crate::reason!("default_targets_invalid"))),
    };
    let mut targets = defaults.get("targets").cloned().unwrap_or(J::Obj(vec![]));
    if let Some(J::Obj(fields)) = project_manifest.get("targets") {
        for (k, v) in fields {
            targets.set(k, v.clone());
        }
    }
    let mut merged = J::obj([("schema", J::Num(2.0)), ("targets", targets)]);
    let (dc, pc) = (defaults.get("codex"), project_manifest.get("codex"));
    if dc.is_some() || pc.is_some() {
        let codex = effective_codex_options(
            &J::obj([
                ("codex", dc.cloned().unwrap_or(J::Null)),
                (
                    "targets",
                    J::obj([(
                        "_",
                        J::obj([(
                            "provisioning",
                            J::obj([("codex", pc.cloned().unwrap_or(J::Null))]),
                        )]),
                    )]),
                ),
            ]),
            "_",
        );
        merged.set("codex", codex);
    }
    // mergeCodexOptions(undefined, X) keeps X's keys: rebuild faithfully.
    if let (None, Some(p)) = (dc, pc) {
        merged.set("codex", p.clone());
    }
    if let (Some(d), None) = (dc, pc) {
        merged.set("codex", d.clone());
    }
    Ok(merged)
}
