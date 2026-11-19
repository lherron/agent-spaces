//! Emit the Antigravity CLI's PTY launch and bind it to the selected release.
use super::antigravity::{DRIVER, FRONTEND, HOOK_BIN_DIR};
use super::broker_spec::{
    EnvPairs, broker_correlation, continuation_key, locked_env, process_limits, process_spec,
    spec_header,
};
use super::finalize::finalize;
use super::plan::{Launch, Plan};
use super::{Fwd, fwd};
use crate::json::J;
use crate::release::Release;

pub(super) fn emit(
    plan: &Plan,
    release: &Release,
    bundle_root: &str,
    home: &str,
    system_prompt_path: Option<String>,
    tool_env: EnvPairs,
    path_prepend: Vec<String>,
) -> Result<J, Fwd> {
    let Launch::Antigravity {
        path, hook_bin_dir, ..
    } = &plan.launch
    else {
        return Err(fwd(crate::reason!("launch_mismatch")));
    };
    let req = &plan.req;
    let policy = req
        .get("hrcPolicy")
        .ok_or_else(|| fwd(crate::reason!("invalid_params")))?;
    let mut args = vec![
        format!("--gemini_dir={home}"),
        "--model".into(),
        plan.selection.model.clone(),
    ];
    if let Some(effort) = &plan.selection.reasoning_effort {
        args.extend(["--effort".into(), effort.clone()]);
    }
    args.push("--dangerously-skip-permissions".into());
    let mut spec = spec_header(req)?;
    if let Some(key) = continuation_key(req).filter(|key| !key.is_empty()) {
        args.extend(["--conversation".into(), key.to_owned()]);
        spec.set(
            "continuation",
            J::obj([
                ("provider", J::str("google")),
                ("kind", J::str("conversation")),
                ("key", J::str(key)),
            ]),
        );
    }
    let mut launch = J::obj([("systemPromptMode", J::str("append"))]);
    if let Some(file) = &system_prompt_path {
        launch.set("systemPromptFile", J::str(file));
    }
    if let Some(prompt) = &plan.expanded_prompt {
        launch.set("initialPrompt", J::str(prompt));
        if !prompt.is_empty() {
            args.extend(["-i".into(), prompt.clone()]);
        }
    }

    let locked = locked_env(
        plan,
        vec![],
        tool_env
            .into_iter()
            .chain([
                ("AGY_CLI_DISABLE_AUTO_UPDATE".into(), "true".into()),
                ("AGY_CLI_HIDE_ACCOUNT_INFO".into(), "true".into()),
                (HOOK_BIN_DIR.into(), hook_bin_dir.clone()),
                ("HARNESS_BROKER_SEAT_DIRECTORY".into(), plan.cwd.clone()),
            ])
            .collect(),
    );
    let mut process = process_spec(path, &args, &plan.cwd, &locked, &path_prepend, "pty");
    if let Some(limits) = process_limits(policy) {
        process.set("limits", limits);
    }
    spec.set(
        "harness",
        J::obj([
            ("frontend", J::str(FRONTEND)),
            ("provider", J::str("google")),
            ("driver", J::str(DRIVER)),
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
    spec.set(
        "driver",
        J::obj([("kind", J::str(DRIVER)), ("terminalHost", J::str("hrcpty"))]),
    );
    spec.set("launch", launch);
    spec.set("correlation", broker_correlation(req)?);

    let mut warnings = plan.tool_warnings.clone();
    if plan
        .system_prompt
        .as_ref()
        .is_some_and(|prompt| !prompt.append)
    {
        warnings.push(
            "Antigravity applies the system prompt as append. Replace mode is unavailable.".into(),
        );
    }
    finalize(
        plan,
        release,
        J::obj([("spec", spec)]),
        locked,
        &mut warnings,
        system_prompt_path,
        bundle_root,
    )
}
