//! Codex hooks (codex-hooks.ts): the HRC capture hooks, the spaces' guarded
//! pre_tool_use commands, their merge into one hooks.json, and the trust
//! state config.toml carries for each command handler.
use crate::compile::util::{hash, js_trim};
use crate::compile::{Fwd, fwd, iarna};
use crate::json::J;
use crate::reads::jspath::resolve;
use std::fs;

const HRC_HOOK_COMMAND: &str =
    "if [ -n \"${HRC_LAUNCH_HOOK_CLI:-}\" ]; then bun \"$HRC_LAUNCH_HOOK_CLI\"; fi";
const EVENT_LABELS: [(&str, &str); 8] = [
    ("PreToolUse", "pre_tool_use"),
    ("PermissionRequest", "permission_request"),
    ("PostToolUse", "post_tool_use"),
    ("PreCompact", "pre_compact"),
    ("PostCompact", "post_compact"),
    ("SessionStart", "session_start"),
    ("UserPromptSubmit", "user_prompt_submit"),
    ("Stop", "stop"),
];
const EVENTS_WITH_MATCHERS: [&str; 6] = [
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SessionStart",
];

/// The record at `value`, or an empty one (`isRecord(x) ? x : {}`).
fn record(value: Option<&J>) -> J {
    match value {
        Some(r @ J::Obj(_)) => r.clone(),
        _ => J::Obj(vec![]),
    }
}

/// Append `groups` to `hooks[event]`.
fn append_groups(hooks: &mut J, event: &str, groups: impl IntoIterator<Item = J>) {
    let mut list = hooks
        .get(event)
        .and_then(J::as_arr)
        .cloned()
        .unwrap_or_default();
    list.extend(groups);
    hooks.set(event, J::Arr(list));
}

/// `buildHrcCodexHooksConfig(events)`.
pub(super) fn hrc_hooks_config(events: &[&str]) -> J {
    let mut hooks = J::Obj(vec![]);
    for event in events {
        let status = if *event == "Stop" {
            "capturing Codex turn".to_owned()
        } else {
            format!("capturing Codex {event}")
        };
        let handler = J::obj([
            ("type", J::str("command")),
            ("command", J::str(HRC_HOOK_COMMAND)),
            ("statusMessage", J::str(status)),
        ]);
        let group = if EVENTS_WITH_MATCHERS.contains(event) {
            J::obj([("matcher", J::str("")), ("hooks", J::Arr(vec![handler]))])
        } else {
            J::obj([("hooks", J::Arr(vec![handler]))])
        };
        hooks.set(event, J::Arr(vec![group]));
    }
    J::obj([("hooks", hooks)])
}

/// `/^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/`.
pub(in crate::compile) fn safe_hook_path(p: &str) -> bool {
    !p.is_empty()
        && p.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
        && !p.split('/').any(|seg| seg == "..")
}

/// `buildCodexSpaceHooksConfig(spaces)`; an unsafe path throws in Bun.
pub(super) fn space_hooks_config(spaces: &[(String, J)]) -> Result<J, Fwd> {
    let mut hooks = J::Obj(vec![]);
    for (space_id, list) in spaces {
        for hook in list.as_arr().into_iter().flatten() {
            if hook.get("event").and_then(J::as_str) != Some("pre_tool_use") {
                continue;
            }
            let script = hook.get("script").and_then(J::as_str).unwrap_or_default();
            if !safe_hook_path(space_id) || !safe_hook_path(script) {
                return Err(fwd(crate::reason!("codex_space_hook_unsafe")));
            }
            let command = format!(
                "p=\"${{CODEX_HOME:-}}/space-hooks/{space_id}/{script}\"; [ -x \"$p\" ] || exit 0; exec \"$p\""
            );
            let matcher = match hook.get("tools").and_then(J::as_arr) {
                None => String::new(),
                Some(tools) if tools.iter().any(|t| t.as_str() == Some("*")) => String::new(),
                Some(tools) => tools
                    .iter()
                    .map(|t| t.as_str().unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join("|"),
            };
            let handler = J::obj([("type", J::str("command")), ("command", J::str(command))]);
            let group = J::obj([
                ("matcher", J::str(matcher)),
                ("hooks", J::Arr(vec![handler])),
            ]);
            append_groups(&mut hooks, "PreToolUse", [group]);
        }
    }
    Ok(J::obj([("hooks", hooks)]))
}

/// `mergeCodexHooksConfigs(...configs)`.
pub(super) fn merge_hooks(configs: &[&J]) -> J {
    let mut merged = J::Obj(vec![]);
    for config in configs {
        let Some(root @ J::Obj(_)) = config.get("hooks") else {
            continue;
        };
        for (event, groups) in root.js_entries() {
            let J::Arr(groups) = groups else { continue };
            append_groups(&mut merged, event, groups.iter().cloned());
        }
    }
    J::obj([("hooks", merged)])
}

/// `canonicalHookTrustPath`: resolved, then realpath when it exists.
fn trust_path(hooks_path: &str) -> String {
    let resolved = resolve(&[hooks_path]);
    fs::canonicalize(&resolved)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(resolved)
}

/// `buildCodexHookTrustState(hooksPath, hooksConfig)`, in insertion order.
fn trust_state(hooks_path: &str, hooks_config: &J) -> Vec<(String, J)> {
    let root = record(hooks_config.get("hooks"));
    let source = trust_path(hooks_path);
    let mut out = vec![];
    for (event, label) in EVENT_LABELS {
        let Some(J::Arr(groups)) = root.get(event) else {
            continue;
        };
        for (gi, group) in groups.iter().enumerate() {
            if !group.is_record() {
                continue;
            }
            let matcher = match group.get("matcher") {
                Some(J::Str(m)) if EVENTS_WITH_MATCHERS.contains(&event) => Some(m.clone()),
                _ => None,
            };
            let Some(J::Arr(handlers)) = group.get("hooks") else {
                continue;
            };
            for (hi, handler) in handlers.iter().enumerate() {
                if !handler.is_record()
                    || handler.get("type") != Some(&J::str("command"))
                    || handler.get("async") == Some(&J::Bool(true))
                {
                    continue;
                }
                let Some(J::Str(command)) = handler.get("command") else {
                    continue;
                };
                if js_trim(command).is_empty() {
                    continue;
                }
                let timeout = match handler.get("timeout") {
                    Some(J::Num(n)) if n.is_finite() => n.trunc().max(1.0),
                    _ => 600.0,
                };
                let mut normalized = J::obj([
                    ("type", J::str("command")),
                    ("command", J::str(command)),
                    ("timeout", J::Num(timeout)),
                    ("async", J::Bool(false)),
                ]);
                if let Some(J::Str(s)) = handler.get("statusMessage") {
                    normalized.set("statusMessage", J::str(s));
                }
                let mut identity = J::obj([("event_name", J::str(label))]);
                if let Some(m) = &matcher {
                    identity.set("matcher", J::str(m));
                }
                identity.set("hooks", J::Arr(vec![normalized]));
                out.push((
                    format!("{source}:{label}:{gi}:{hi}"),
                    J::obj([(
                        "trusted_hash",
                        J::str(format!("sha256:{}", hash(&identity, false))),
                    )]),
                ));
            }
        }
    }
    out
}

/// `addCodexHookTrustState(config, hooksPath, hooksConfig, { replaceHooksPaths })`:
/// `None` when there is nothing to trust (Bun returns the config itself).
pub(super) fn add_trust_state(
    config: &J,
    hooks_path: &str,
    hooks_config: &J,
    stale: &[String],
) -> Option<J> {
    let trust = trust_state(hooks_path, hooks_config);
    if trust.is_empty() {
        return None;
    }
    let mut hooks = record(config.get("hooks"));
    let mut state = record(hooks.get("state"));
    let source = trust_path(hooks_path);
    for stale_path in stale {
        let stale_source = trust_path(stale_path);
        for (key, _) in &trust {
            state.remove(&format!("{stale_source}{}", &key[source.len()..]));
        }
    }
    for (key, value) in trust {
        let mut merged = record(state.get(&key));
        for (k, v) in value.js_entries() {
            merged.set(k, v.clone());
        }
        state.set(&key, merged);
    }
    hooks.set("state", state);
    let mut out = config.clone();
    out.set("hooks", hooks);
    Some(out)
}

/// `trustCodexHooksInConfigToml(configToml, hooksPath, hooksJson, { replaceHooksPaths })`.
pub(super) fn trust_config_toml(
    toml: &str,
    hooks_path: &str,
    hooks_config: &J,
    stale: &[String],
) -> Result<String, Fwd> {
    let parsed = match crate::reads::toml::parse(toml) {
        Ok(v) => v,
        Err(crate::reads::toml::TomlError::Unsupported(r)) => return Err(fwd(r)),
        Err(_) => return Err(fwd(crate::reason!("codex_config_toml_invalid"))),
    };
    match add_trust_state(&parsed, hooks_path, hooks_config, stale) {
        None => Ok(toml.to_owned()),
        Some(updated) => Ok(format!("{}\n", iarna::stringify(&updated)?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_paths_refuse_parent_segments() {
        assert!(safe_hook_path("guard/pre.sh"));
        assert!(!safe_hook_path("../x"));
        assert!(!safe_hook_path("a/../x"));
        assert!(safe_hook_path("a/..b"));
        assert!(!safe_hook_path("a b"));
    }
}
