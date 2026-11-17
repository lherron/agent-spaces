//! One space as a Claude plugin directory, with Bun's write rules
//! (ClaudeAdapter.materializeSpace in drivers/harness-claude, and the
//! materializer's plugin-json and hooks-builder): `.claude-plugin/plugin.json`,
//! the component directories, CLAUDE.md, permissions.toml, the hooks.json
//! translated from hooks.toml, and executable hook scripts.
use super::Fwd;
use super::fs_tree::{copy_dir, copy_file, is_dir_follow, mkdirp, write_json};
use super::space_plan::SpacePlan;
use crate::json::J;
use crate::reads::jspath::join;
use std::fs;
use std::os::unix::fs::PermissionsExt;

const PLUGIN_COMPONENT_DIRS: [&str; 6] =
    ["commands", "skills", "agents", "hooks", "scripts", "mcp"];

/// The string elements of an optional array.
pub(super) fn str_list(v: Option<&J>) -> Vec<String> {
    v.and_then(J::as_arr)
        .map(|a| a.iter().filter_map(J::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// `generatePluginJson(manifest)`.
fn plugin_json(manifest: &J) -> J {
    let (name, version) = super::spaces::plugin_identity(manifest);
    let plugin = manifest.get("plugin");
    let mut out = J::obj([("name", J::str(name))]);
    if let Some(v) = version {
        out.set("version", J::str(v));
    }
    let desc = plugin
        .and_then(|p| p.get("description"))
        .or_else(|| manifest.get("description"));
    if let Some(d) = desc {
        out.set("description", d.clone());
    }
    if let Some(author) = plugin.and_then(|p| p.get("author")) {
        let mut a = J::Obj(vec![]);
        for key in ["name", "email", "url"] {
            if let Some(v) = author.get(key) {
                a.set(key, v.clone());
            }
        }
        out.set("author", a);
    }
    for key in ["homepage", "repository", "license"] {
        if let Some(v) = plugin.and_then(|p| p.get(key)) {
            out.set(key, v.clone());
        }
    }
    if let Some(J::Arr(k)) = plugin.and_then(|p| p.get("keywords"))
        && !k.is_empty()
    {
        out.set("keywords", J::Arr(k.clone()));
    }
    out
}

/// ClaudeAdapter.materializeSpace(input, cacheDir, { force: false, useHardlinks: false }).
pub(super) fn materialize_space(plan: &SpacePlan, dir: &str) -> Result<(), Fwd> {
    let result = (|| {
        let src = &plan.input.content_dir;
        mkdirp(dir)?;
        mkdirp(&join(&[dir, ".claude-plugin"]))?;
        write_json(
            &join(&[dir, ".claude-plugin", "plugin.json"]),
            &plugin_json(&plan.manifest),
        )?;
        for component in PLUGIN_COMPONENT_DIRS {
            let s = join(&[src, component]);
            if is_dir_follow(&s) {
                copy_dir(&s, &join(&[dir, component]), false)?;
            }
        }
        // AGENT.md, else CLAUDE.md, becomes CLAUDE.md (access(): follows links).
        for name in ["AGENT.md", "CLAUDE.md"] {
            let s = join(&[src, name]);
            if fs::metadata(&s).is_ok() {
                copy_file(&s, &join(&[dir, "CLAUDE.md"]))?;
                break;
            }
        }
        if plan.permissions.is_some() {
            copy_file(
                &join(&[src, "permissions.toml"]),
                &join(&[dir, "permissions.toml"]),
            )?;
        }
        if let Some(hooks) = &plan.hooks
            && !hooks.is_empty()
        {
            write_json(
                &join(&[dir, "hooks", "hooks.json"]),
                &claude_hooks_config(hooks),
            )?;
        }
        ensure_hooks_executable(dir);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(dir);
    }
    result
}

const CLAUDE_EVENTS: [(&str, &str); 12] = [
    ("pre_tool_use", "PreToolUse"),
    ("post_tool_use", "PostToolUse"),
    ("post_tool_use_failure", "PostToolUseFailure"),
    ("permission_request", "PermissionRequest"),
    ("notification", "Notification"),
    ("user_prompt_submit", "UserPromptSubmit"),
    ("stop", "Stop"),
    ("subagent_start", "SubagentStart"),
    ("subagent_stop", "SubagentStop"),
    ("pre_compact", "PreCompact"),
    ("session_start", "SessionStart"),
    ("session_end", "SessionEnd"),
];

/// `toClaudeHooksConfig(hooks)`.
fn claude_hooks_config(hooks: &[J]) -> J {
    fn normalize(h: &str) -> &str {
        match h {
            "claude-agent-sdk" => "claude",
            "pi-sdk" => "pi",
            other => other,
        }
    }
    // event -> [(matcher, hooks)] in first-seen order.
    type Groups<'a> = Vec<(Option<String>, Vec<&'a J>)>;
    let mut by_event: Vec<(String, Groups)> = vec![];
    for hook in hooks {
        if let Some(h) = hook.get("harness").and_then(J::as_str)
            && !h.is_empty()
            && normalize(h) != "claude"
        {
            continue;
        }
        let event = hook.get("event").and_then(J::as_str).unwrap_or_default();
        let Some((_, claude_event)) = CLAUDE_EVENTS.iter().find(|(a, _)| *a == event) else {
            continue;
        };
        let matcher = if matches!(*claude_event, "PreToolUse" | "PostToolUse") {
            let tools = str_list(hook.get("tools"));
            Some(if tools.is_empty() || tools.iter().any(|t| t == "*") {
                "*".to_owned()
            } else {
                tools.join("|")
            })
        } else {
            hook.get("matcher").and_then(J::as_str).map(str::to_owned)
        };
        let slot = match by_event.iter().position(|(e, _)| e == claude_event) {
            Some(i) => i,
            None => {
                by_event.push(((*claude_event).to_owned(), vec![]));
                by_event.len() - 1
            }
        };
        let groups = &mut by_event[slot].1;
        match groups.iter_mut().find(|(m, _)| *m == matcher) {
            Some((_, list)) => list.push(hook),
            None => groups.push((matcher, vec![hook])),
        }
    }
    let events = by_event
        .into_iter()
        .map(|(event, groups)| {
            let entries = groups
                .into_iter()
                .map(|(matcher, list)| {
                    let commands = list
                        .iter()
                        .map(|h| {
                            J::obj([
                                ("type", J::str("command")),
                                (
                                    "command",
                                    J::str(format!(
                                        "${{CLAUDE_PLUGIN_ROOT}}/{}",
                                        h.get("script").and_then(J::as_str).unwrap_or_default()
                                    )),
                                ),
                            ])
                        })
                        .collect();
                    let mut entry = J::obj([("hooks", J::Arr(commands))]);
                    if let Some(m) = matcher.filter(|m| !m.is_empty()) {
                        entry.set("matcher", J::str(m));
                    }
                    entry
                })
                .collect();
            (event, J::Arr(entries))
        })
        .collect();
    J::obj([("hooks", J::Obj(events))])
}

/// `ensureHooksExecutable(dir)`: only the legacy array form of hooks.json.
fn ensure_hooks_executable(dir: &str) {
    let path = join(&[dir, "hooks", "hooks.json"]);
    let Ok(text) = fs::read(&path) else { return };
    let Some(config) = crate::json::parse(&text) else {
        return;
    };
    let Some(J::Arr(hooks)) = config.get("hooks") else {
        return;
    };
    let native = hooks
        .first()
        .is_some_and(|h| matches!(h.get("hooks"), Some(J::Arr(_))));
    let mut scripts = vec![];
    for h in hooks {
        if native {
            for cmd in h.get("hooks").and_then(J::as_arr).into_iter().flatten() {
                if let Some(c) = cmd
                    .get("command")
                    .and_then(J::as_str)
                    .filter(|c| !c.is_empty())
                {
                    let c = c.strip_prefix("${CLAUDE_PLUGIN_ROOT}/").unwrap_or(c);
                    scripts.push(c.strip_prefix("hooks/").unwrap_or(c).to_owned());
                }
            }
        } else if let Some(s) = h.get("script").and_then(J::as_str) {
            scripts.push(s.to_owned());
        }
    }
    for script in scripts.iter().filter(|s| !s.is_empty()) {
        let p = join(&[dir, "hooks", script]);
        let executable = std::ffi::CString::new(p.clone())
            .map(|c| unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0)
            .unwrap_or(false);
        if !executable && let Ok(meta) = fs::metadata(&p) {
            let _ = fs::set_permissions(
                &p,
                fs::Permissions::from_mode(meta.permissions().mode() | 0o111),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hooks_config_groups_by_event_then_matcher() {
        let hooks: Vec<J> = vec![
            J::obj([
                ("event", J::str("pre_tool_use")),
                ("script", J::str("a.sh")),
                ("tools", J::Arr(vec![J::str("Bash")])),
            ]),
            J::obj([
                ("event", J::str("session_start")),
                ("script", J::str("b.sh")),
                ("matcher", J::str("compact")),
            ]),
            J::obj([
                ("event", J::str("pre_tool_use")),
                ("script", J::str("c.sh")),
                ("tools", J::Arr(vec![J::str("Bash")])),
            ]),
            J::obj([
                ("event", J::str("stop")),
                ("script", J::str("d.sh")),
                ("harness", J::str("pi")),
            ]),
        ];
        assert_eq!(
            claude_hooks_config(&hooks).to_json(),
            r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/a.sh"},{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/c.sh"}],"matcher":"Bash"}],"SessionStart":[{"hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/b.sh"}],"matcher":"compact"}]}}"#
        );
    }
}
