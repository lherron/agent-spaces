//! Harness selection: `resolveHarnessExecution` (harness-selection/resolve.ts)
//! over the native recipes of the catalog (catalog.ts), with each scalar's
//! provenance layer.
use super::profile_target::Profile;
use super::{Fwd, fwd, fwd_at};
use crate::json::J;
use crate::reads::jspath::basename;

/// The selection keys as the compile request spells them (`requested`) and as
/// summon directives and provisioning layers spell them.
pub(super) const REQUESTED: [&str; 5] = [
    "harness",
    "modelProvider",
    "model",
    "reasoningEffort",
    "presentation",
];
pub(super) const DIRECTIVES: [&str; 5] = [
    "harness",
    "model_provider",
    "model",
    "reasoning_effort",
    "presentation",
];

pub struct Selection {
    pub selection: J,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub harness: Harness,
    pub presentation: bool,
    /// The catalog's hrcpty variant (claude-hrcpty, codex-hrcpty): the same
    /// recipe hosted by hrc-pty's supervisor (catalog.ts).
    pub hrcpty: bool,
}

impl Selection {
    /// compile-broker-plan.ts `codexTui`: presented, or codex-hrcpty, whose
    /// two variants both compile the attachable codex-tui shape.
    pub fn interactive(&self) -> bool {
        self.presentation || self.hrcpty
    }
}

/// The two recipes raspd compiles natively.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Harness {
    Antigravity,
    /// claude-code (claude-code-tmux).
    Claude,
    /// codex-app-server, presented (codex-tui) or headless.
    Codex,
}

const ANTIGRAVITY_MODELS: [&str; 4] = [
    "gemini-4-neon",
    "gemini-4-argon",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
];

const CODEX_MODELS: [&str; 10] = [
    "gpt-5.6-terra",
    "gpt-6.2-sol",
    "gpt-6.2-astra",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.5",
];

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

/// `resolveHarnessExecution` for the claude-code and codex-app-server
/// recipes; any other recipe or any refusal is relayed to Bun.
pub fn resolve_selection(req: &J, profile: &Profile, target: Option<&J>) -> Result<Selection, Fwd> {
    let agent_id = req
        .get("agent")
        .and_then(|a| a.get("id"))
        .and_then(J::as_str)
        .unwrap_or_default();
    let placement = req
        .get("placement")
        .ok_or_else(|| fwd(crate::reason!("invalid_params")))?;
    let agent_root = placement
        .get("agentRoot")
        .and_then(J::as_str)
        .unwrap_or_default();
    let agent_name = placement
        .get("bundle")
        .and_then(|b| b.get("agentName"))
        .and_then(J::as_str);
    if basename(agent_root) != agent_id || agent_name.is_some_and(|n| n != agent_id) {
        return Err(fwd(crate::reason!("configured_context_mismatch")));
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
    let hrcpty = matches!(
        harness_id,
        "claude-hrcpty" | "codex-hrcpty" | "antigravity-hrcpty"
    );
    let (kind, default_provider, default_model, models): (Harness, &str, &str, &[&str]) =
        match harness_id {
            "antigravity-hrcpty" => (
                Harness::Antigravity,
                "google",
                ANTIGRAVITY_MODELS[0],
                &ANTIGRAVITY_MODELS,
            ),
            "claude" | "claude-hrcpty" => {
                (Harness::Claude, "anthropic", "opus[1m]", &CLAUDE_MODELS)
            }
            "codex" | "codex-hrcpty" => (
                Harness::Codex,
                "openai-codex",
                "gpt-5.6-terra",
                &CODEX_MODELS,
            ),
            _ => {
                return Err(fwd_at(
                    crate::reason!("recipe_not_native"),
                    picked("harness", harness_id, &harness),
                ));
            }
        };
    let provider = scalar("modelProvider");
    let provider_id = provider
        .as_ref()
        .and_then(|(v, _)| v.as_str())
        .unwrap_or(default_provider);
    if provider_id != default_provider {
        return Err(fwd_at(
            crate::reason!("unsupported_model_provider"),
            picked("modelProvider", provider_id, &provider),
        ));
    }
    let model = scalar("model");
    let model_id = match &model {
        Some((J::Str(m), _)) => m.clone(),
        Some(_) => return Err(fwd(crate::reason!("model_shape"))),
        None => default_model.into(),
    };
    if !models.contains(&model_id.as_str()) {
        return Err(fwd_at(
            crate::reason!("unsupported_model"),
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
        Some(_) => return Err(fwd(crate::reason!("reasoning_effort_shape"))),
        None => None,
    };
    let source =
        |s: &Option<(J, &str)>| J::str(s.as_ref().map_or("catalog-default", |(_, src)| *src));
    let mut selection = J::obj([
        ("harness", J::str(harness_id)),
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
        harness: kind,
        presentation: presentation.is_none_or(|(v, _)| v == J::Bool(true)),
        hrcpty,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reads::profile;

    fn parse(s: &str) -> J {
        crate::json::parse(s.as_bytes()).expect("json")
    }

    /// The selection inputs of a native birth request, with the requested harness.
    fn requesting(harness: &str) -> J {
        let mut req = parse(
            r#"{"agent":{"id":"clod"},
            "placement":{"agentRoot":"/a/clod","bundle":{"kind":"agent-project","agentName":"clod"}},
            "requested":{}}"#,
        );
        let mut requested = parse("{}");
        requested.set("harness", J::str(harness));
        req.set("requested", requested);
        req
    }

    #[test]
    fn selection_forwards_name_the_value_and_its_layer() {
        let profile = Profile {
            raw: parse("{}"),
            typed: profile::parse("version = 4\n").ok().expect("profile"),
        };
        let target = parse(r#"{"provisioning":{"model":"gpt-9"}}"#);
        let fail = |req: &J, target: Option<&J>| {
            resolve_selection(req, &profile, target)
                .err()
                .map(|f| (f.reason.as_str(), f.detail.unwrap_or_default()))
        };
        assert_eq!(
            fail(&requesting("muse"), None),
            Some((
                "recipe_not_native",
                "selection.harness:muse@compile-request".to_owned()
            ))
        );
        assert_eq!(
            fail(&requesting("agent-harness"), None),
            Some((
                "recipe_not_native",
                "selection.harness:agent-harness@compile-request".to_owned()
            ))
        );
        assert_eq!(
            fail(&requesting("claude"), Some(&target)),
            Some((
                "unsupported_model",
                "selection.model:gpt-9@project-target".to_owned()
            ))
        );
    }
}
