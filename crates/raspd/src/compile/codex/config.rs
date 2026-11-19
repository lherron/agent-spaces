//! config.toml (codex-config.ts): raspd's defaults, the spaces' MCP servers,
//! the spaces' `[codex.config]` and the target's codex options as dotted
//! overrides, `features.hooks` forced on, rendered through a canonical JSON
//! round trip and the iarna stringifier.
use crate::compile::space_plan::SpacePlan;
use crate::compile::util::canonicalize;
use crate::compile::{Fwd, fwd, iarna, truthy};
use crate::json::J;
use crate::reads::jspath::join;
use std::fs;

/// `applyDottedKey(target, dottedKey, value)`.
fn apply_dotted(target: &mut J, dotted: &str, value: J) -> Result<(), Fwd> {
    let parts: Vec<&str> = dotted.split('.').filter(|p| !p.is_empty()).collect();
    let Some((last, path)) = parts.split_last() else {
        return Ok(());
    };
    let mut cursor = target;
    for part in path {
        if !matches!(cursor.get(part), Some(J::Obj(_))) {
            cursor.set(part, J::Obj(vec![]));
        }
        let J::Obj(fields) = cursor else {
            return Ok(());
        };
        let (_, child) = fields
            .iter_mut()
            .find(|(k, _)| k == part)
            .ok_or_else(|| fwd(crate::reason!("invalid_params")))?;
        cursor = child;
    }
    cursor.set(last, value);
    Ok(())
}

fn non_empty(v: &J) -> bool {
    match v {
        J::Arr(a) => !a.is_empty(),
        J::Str(s) => !s.is_empty(),
        J::Obj(f) => !f.is_empty(),
        _ => false,
    }
}

/// `buildCodexConfig(mcpConfig, overrides)`.
pub(super) fn codex_config(servers: &[(String, J)], overrides: &[J]) -> Result<J, Fwd> {
    let mut base = J::obj([
        ("model", J::str("gpt-5.6-terra")),
        ("model_reasoning_effort", J::str("high")),
        ("model_reasoning_summary", J::str("detailed")),
        ("sandbox_mode", J::str("workspace-write")),
        ("approval_policy", J::str("on-request")),
        (
            "project_doc_fallback_filenames",
            J::Arr(vec![J::str("AGENTS.md"), J::str("AGENT.md")]),
        ),
        ("check_for_update_on_startup", J::Bool(false)),
        (
            "tui",
            J::obj([(
                "status_line",
                J::Arr(
                    ["model-with-reasoning", "context-remaining", "current-dir"]
                        .map(J::str)
                        .to_vec(),
                ),
            )]),
        ),
    ]);
    if !servers.is_empty() {
        let mut mcp = J::Obj(vec![]);
        for (name, server) in servers {
            let mut entry = J::Obj(vec![]);
            if let Some(c) = server.get("command") {
                entry.set("command", c.clone());
            }
            entry.set("enabled", J::Bool(true));
            if let Some(a) = server.get("args").filter(|a| non_empty(a)) {
                entry.set("args", a.clone());
            }
            if let Some(e) = server.get("env").filter(|e| non_empty(e)) {
                entry.set("env", e.clone());
            }
            mcp.set(name, entry);
        }
        base.set("mcp_servers", mcp);
    }
    for o in overrides {
        for (k, v) in o.js_entries() {
            apply_dotted(&mut base, k, v.clone())?;
        }
    }
    let mut features = match base.get("features") {
        Some(f @ J::Obj(_)) => f.clone(),
        _ => J::Obj(vec![]),
    };
    features.set("hooks", J::Bool(true));
    base.set("features", features);
    Ok(base)
}

/// The target's codex options as a config override (composeTarget).
pub(super) fn target_overrides(codex_options: Option<&J>) -> Option<J> {
    let options = codex_options?;
    let mut target = J::Obj(vec![]);
    for (field, key) in [
        ("model", "model"),
        ("model_reasoning_effort", "model_reasoning_effort"),
        ("model_reasoning_summary", "model_reasoning_summary"),
        ("status_line", "tui.status_line"),
        ("approval_policy", "approval_policy"),
        ("sandbox_mode", "sandbox_mode"),
    ] {
        if let Some(v) = options.get(field).filter(|v| truthy(v)) {
            target.set(key, v.clone());
        }
    }
    matches!(&target, J::Obj(f) if !f.is_empty()).then_some(target)
}

/// composeMcpFromSpaces over each directory's `mcp/mcp.json`: a missing or
/// unparsable file is skipped, and later servers override earlier ones of
/// the same name.
pub(super) fn mcp_servers<'a>(
    dirs: impl IntoIterator<Item = &'a str>,
) -> Result<Vec<(String, J)>, Fwd> {
    let mut servers: Vec<(String, J)> = vec![];
    for dir in dirs {
        let path = join(&[dir, "mcp", "mcp.json"]);
        if !fs::metadata(&path).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let Some(config) = fs::read(&path).ok().and_then(|t| crate::json::parse(&t)) else {
            continue;
        };
        let Some(J::Obj(entries)) = config.get("mcpServers") else {
            return Err(fwd(crate::reason!("mcp_config_shape")));
        };
        for (name, server) in entries {
            match servers.iter_mut().find(|(n, _)| n == name) {
                Some(slot) => slot.1 = server.clone(),
                None => servers.push((name.clone(), server.clone())),
            }
        }
    }
    Ok(servers)
}

/// Render the target's config.toml from the spaces' sources before anything
/// is written: the stringify refusals (`toml_mixed_array`,
/// `toml_stringify_type`) depend only on the inputs (T-13018 r2 2.1).
/// The same servers and overrides `compose_target` reads from the staged
/// copies (`materialize_space` copies mcp/mcp.json and writes `[codex.config]`
/// verbatim); hook trust entries are raspd's own strings and tables.
pub fn preflight_config(plans: &[SpacePlan], codex_options: Option<&J>) -> Result<(), Fwd> {
    let mut overrides = vec![];
    for plan in plans {
        if let Some(config @ J::Obj(fields)) =
            plan.manifest.get("codex").and_then(|c| c.get("config"))
            && !fields.is_empty()
        {
            overrides.push(config.clone());
        }
    }
    let servers = mcp_servers(plans.iter().map(|p| p.input.content_dir.as_str()))?;
    overrides.extend(target_overrides(codex_options));
    render_config(&codex_config(&servers, &overrides)?).map(|_| ())
}

/// `renderCodexConfigToml(config)`: canonical JSON round trip, then iarna.
pub(super) fn render_config(config: &J) -> Result<String, Fwd> {
    let canonical = crate::json::parse(canonicalize(config, false).as_bytes())
        .ok_or_else(|| fwd(crate::reason!("codex_config_json")))?;
    let text = iarna::stringify(&canonical)?;
    Ok(format!("{}\n", text.trim_end_matches('\n')))
}
