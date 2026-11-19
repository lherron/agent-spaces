//! Antigravity named hook groups and the static broker bridge.
use super::HOOK_COMMAND;
use crate::compile::{Fwd, fwd};
use crate::json::J;

pub(in crate::compile) fn bridge() -> J {
    let mut events = J::Obj(vec![]);
    for event in [
        "SessionStart",
        "PreInvocation",
        "PostInvocation",
        "PreToolUse",
        "PostToolUse",
        "Stop",
    ] {
        let handler = command(HOOK_COMMAND);
        let entry = match event {
            "PreToolUse" | "PostToolUse" => matched("*", handler),
            _ => handler,
        };
        events.set(event, J::Arr(vec![entry]));
    }
    J::obj([("praesidium-broker", events)])
}

pub(super) fn space(name: &str, hooks: &[J]) -> Result<Option<J>, Fwd> {
    let mut groups = vec![];
    for hook in hooks {
        if hook.get("event").and_then(J::as_str) != Some("pre_tool_use")
            || !matches!(
                hook.get("harness").and_then(J::as_str),
                None | Some("antigravity" | "antigravity-hrcpty")
            )
        {
            continue;
        }
        let script = hook.get("script").and_then(J::as_str).unwrap_or_default();
        if !super::super::codex::hooks::safe_hook_path(script) || script.starts_with('/') {
            return Err(fwd(crate::reason!("antigravity_space_hook_unsafe")));
        }
        let matchers = match hook.get("tools").and_then(J::as_arr) {
            None => vec!["*"],
            Some(tools) => tools.iter().filter_map(J::as_str).map(tool_name).collect(),
        };
        for matcher in matchers {
            groups.push(matched(matcher, command(&format!("exec ./hooks/{script}"))));
        }
    }
    Ok((!groups.is_empty()).then(|| J::obj([(name, J::obj([("PreToolUse", J::Arr(groups))]))])))
}

fn command(value: &str) -> J {
    J::obj([("type", J::str("command")), ("command", J::str(value))])
}

fn matched(matcher: &str, handler: J) -> J {
    J::obj([
        ("matcher", J::str(matcher)),
        ("hooks", J::Arr(vec![handler])),
    ])
}

fn tool_name(tool: &str) -> &str {
    match tool {
        "Bash" => "run_command",
        "Read" => "view_file",
        "Write" => "write_to_file",
        "Edit" => "replace_file_content",
        "Grep" => "grep_search",
        "Glob" => "find_by_name",
        _ => tool,
    }
}
