//! `compileTmuxBrokerPlan` for the claude-code recipe: the Claude adapter's
//! argv (`buildRunArgs`) and env, and the broker start request, then the
//! shared plan tail.
use super::broker_spec::{
    EnvPairs, broker_correlation, claude_driver, continuation_key, locked_env, process_limits,
    process_spec, spec_header, terminal_host,
};
use super::finalize::finalize;
use super::plan::{Launch, Plan};
use super::{Fwd, fwd, stage, util};
use crate::json::J;
use crate::reads::jspath::basename;
use crate::release::Release;

pub(super) fn emit_claude(
    plan: &Plan,
    release: &Release,
    bundle: &stage::Bundle,
    system_prompt_path: Option<String>,
    warnings: &mut [String],
    tool_env: EnvPairs,
    path_prepend: Vec<String>,
) -> Result<J, Fwd> {
    let req = &plan.req;
    let policy = req
        .get("hrcPolicy")
        .ok_or_else(|| super::fwd(crate::reason!("invalid_params")))?;
    let continuation_key = continuation_key(req);
    let prompt = plan.expanded_prompt.clone();
    let Launch::Claude {
        defaults: claude,
        path: claude_path,
        ..
    } = &plan.launch
    else {
        return Err(fwd(crate::reason!("launch_mismatch")));
    };

    // ClaudeAdapter.buildRunArgs(bundle, runOptions).
    let yolo = claude.yolo;
    let permission_mode = claude
        .permission_mode
        .clone()
        .or_else(|| yolo.then(|| "bypassPermissions".into()));
    let prompt_args: Vec<String> = match prompt.as_deref() {
        Some(p) if !p.is_empty() => vec![p.to_owned()],
        _ => vec![],
    };
    let session_args: Vec<String> = match continuation_key {
        Some(k) if !k.is_empty() => vec!["--resume".into(), k.to_owned()],
        _ => vec!["--session-id".into(), util::random_uuid()],
    };
    let mut extra: Vec<String> = vec!["--chrome".into()];
    if yolo {
        extra.push("--dangerously-skip-permissions".into());
    }
    if claude.remote {
        let project_segment = plan
            .handle
            .project_id
            .clone()
            .unwrap_or_else(|| basename(&plan.cwd));
        let parts: Vec<&str> = [
            Some(plan.agent_name.as_str()),
            Some(project_segment.as_str()),
            plan.handle.task_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect();
        let name = format!("{}-{}", parts.join("-"), remote_control_suffix());
        extra.extend([
            "--remote-control".into(),
            "--remote-control-session-name-prefix".into(),
            name.clone(),
            "--name".into(),
            name,
        ]);
    }
    if let Some(e) = &plan.selection.reasoning_effort
        && !e.is_empty()
    {
        extra.extend(["--effort".into(), e.clone()]);
    }
    extra.extend(claude.extra_args.iter().cloned());
    extra.extend(session_args);
    if prompt_args.len() == 1 {
        extra.push("--".into());
    }
    extra.extend(prompt_args);
    let disallowed_request: Vec<String> = policy
        .get("disallowedTools")
        .and_then(J::as_arr)
        .map(|a| a.iter().filter_map(J::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    let mut args: Vec<String> = vec![];
    for dir in &bundle.plugin_dirs {
        args.extend(["--plugin-dir".into(), dir.clone()]);
    }
    if let Some(mcp) = &bundle.mcp_config_path {
        args.extend(["--mcp-config".into(), mcp.clone()]);
    }
    args.extend(["--model".into(), plan.selection.model.clone()]);
    if let Some(mode) = permission_mode.filter(|m| !m.is_empty()) {
        args.extend(["--permission-mode".into(), mode]);
    }
    let mut disallowed = disallowed_request.clone();
    if claude.ask_user_question != Some(true) {
        disallowed.push("AskUserQuestion".into());
    }
    if !disallowed.is_empty() {
        args.push("--disallowedTools".into());
        args.extend(disallowed);
    }
    args.extend(["--setting-sources".into(), String::new()]);
    args.extend(["--settings".into(), bundle.settings_path.clone()]);
    if let Some(sp) = &plan.system_prompt
        && let Some(content) = sp.prompt.as_deref().filter(|c| !c.is_empty())
    {
        args.extend([
            if sp.append {
                "--append-system-prompt"
            } else {
                "--system-prompt"
            }
            .into(),
            content.to_owned(),
        ]);
    }
    args.extend(extra);

    let mut adapter_env: EnvPairs = vec![("ASP_PLUGIN_ROOT".into(), bundle.root_dir.clone())];
    if let Some(p) = prompt.as_deref().filter(|p| !p.is_empty()) {
        adapter_env.push(("ASP_PRIMING_PROMPT".into(), p.to_owned()));
    }
    let locked = locked_env(plan, adapter_env, tool_env);

    // The start request (compileTmuxBrokerPlan).
    let mut launch = J::Obj(vec![]);
    if let Some(path) = &system_prompt_path {
        launch.set("systemPromptFile", J::str(path));
    }
    if let Some(sp) = &plan.system_prompt {
        launch.set(
            "systemPromptMode",
            J::str(if sp.append { "append" } else { "replace" }),
        );
    }
    if let Some(p) = &prompt {
        launch.set("initialPrompt", J::str(p));
    }
    let mut process = process_spec(claude_path, &args, &plan.cwd, &locked, &path_prepend, "pty");
    if let Some(limits) = process_limits(policy) {
        process.set("limits", limits);
    }
    let hrcpty = plan.selection.hrcpty;
    let mut spec = spec_header(req)?;
    spec.set(
        "harness",
        J::obj([
            ("frontend", J::str("claude-code")),
            ("provider", J::str("anthropic")),
            ("driver", J::str(claude_driver(hrcpty))),
        ]),
    );
    spec.set("process", process);
    spec.set(
        "interaction",
        J::obj([
            ("mode", J::str("interactive")),
            ("turnConcurrency", J::str("single")),
            ("inputQueue", J::str("fifo")),
        ]),
    );
    if let Some(k) = continuation_key {
        spec.set(
            "continuation",
            J::obj([
                ("provider", J::str("anthropic")),
                ("key", J::str(k)),
                ("kind", J::str("session")),
            ]),
        );
    }
    spec.set(
        "driver",
        J::obj([
            ("kind", J::str(claude_driver(hrcpty))),
            ("terminalHost", J::str(terminal_host(hrcpty))),
        ]),
    );
    if matches!(&launch, J::Obj(f) if !f.is_empty()) {
        spec.set("launch", launch);
    }
    spec.set("correlation", broker_correlation(req)?);
    let start_request = J::obj([("spec", spec)]);

    finalize(
        plan,
        release,
        start_request,
        locked,
        warnings,
        system_prompt_path,
        &bundle.root_dir,
    )
}

/// The remote-control session name's suffix: four random base-36 digits.
fn remote_control_suffix() -> String {
    let b = util::random_bytes::<4>();
    let mut value = u32::from_be_bytes(b) % 36u32.pow(4);
    let mut digits = vec![];
    for _ in 0..4 {
        let d = (value % 36) as u8;
        digits.push(if d < 10 { b'0' + d } else { b'a' + d - 10 } as char);
        value /= 36;
    }
    digits.iter().rev().collect()
}
