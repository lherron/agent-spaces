//! `compileBrokerPlan` for codex-app-server: the Codex adapter's argv and
//! env, the broker start request (`toHarnessBrokerStartRequest`) and its
//! initial input, then the shared plan tail.
use super::broker_spec::{
    EnvPairs, broker_correlation, broker_permission_policy, continuation_key, default_limits,
    locked_env, process_limits, process_spec, spec_header,
};
use super::finalize::finalize;
use super::plan::{Launch, Plan};
use super::util::hash;
use super::{Fwd, codex, fwd, s};
use crate::json::J;
use crate::release::Release;

/// Published Codex runtime artifacts, produced together by materialization.
/// The shared home and bundle stay borrowed; the per-invocation prompt path
/// is consumed when the plan is finalized.
pub(super) struct CodexArtifacts<'a> {
    pub bundle_root: &'a str,
    pub home: &'a str,
    pub system_prompt_path: Option<String>,
}

pub(super) fn emit_codex(
    plan: &Plan,
    release: &Release,
    artifacts: CodexArtifacts<'_>,
    warnings: &mut [String],
    tool_env: EnvPairs,
    path_prepend: Vec<String>,
) -> Result<J, Fwd> {
    let req = &plan.req;
    let material = req
        .get("materialization")
        .ok_or_else(|| super::fwd(crate::reason!("invalid_params")))?;
    let policy = req
        .get("hrcPolicy")
        .ok_or_else(|| super::fwd(crate::reason!("invalid_params")))?;
    let Launch::Codex {
        defaults,
        path: command,
    } = &plan.launch
    else {
        return Err(fwd(crate::reason!("launch_mismatch")));
    };
    let continuation_key = continuation_key(req);
    let interactive = plan.selection.interactive();
    let prompt = plan.expanded_prompt.clone();
    let model = plan.selection.model.clone();
    let effort = plan
        .selection
        .reasoning_effort
        .clone()
        .or_else(|| defaults.reasoning_effort.clone());
    let approval = defaults.approval_policy.clone();
    let sandbox = defaults.sandbox_mode.clone();

    // CodexAdapter.buildRunArgs(bundle, runOptions).
    let mut args: Vec<String> = vec![];
    let features = |args: &mut Vec<String>| {
        for f in codex::DEFAULT_FEATURES {
            args.extend(["--enable".to_owned(), f.to_owned()]);
        }
    };
    let launch_prompt = prompt.as_deref().filter(|p| !p.is_empty());
    let resume_key = continuation_key.filter(|k| !k.is_empty());
    if !interactive {
        features(&mut args);
        args.push("app-server".into());
    } else {
        if let Some(key) = resume_key {
            args.push("resume".into());
            features(&mut args);
            args.push(key.to_owned());
        } else {
            features(&mut args);
        }
        if let Some(p) = launch_prompt {
            args.push(p.to_owned());
        }
        args.extend([
            "--no-alt-screen".to_owned(),
            "--model".into(),
            model.clone(),
        ]);
        if let Some(e) = effort.as_deref().filter(|e| !e.is_empty()) {
            args.extend(["-c".to_owned(), format!("model_reasoning_effort=\"{e}\"")]);
        }
        if let Some(a) = approval.as_deref().filter(|a| !a.is_empty()) {
            args.extend(["--ask-for-approval".to_owned(), a.to_owned()]);
        }
        if let Some(m) = sandbox.as_deref().filter(|m| !m.is_empty()) {
            args.extend(["--sandbox".to_owned(), m.to_owned()]);
        }
        args.push("--dangerously-bypass-hook-trust".into());
    }

    let locked = locked_env(
        plan,
        vec![("CODEX_HOME".into(), artifacts.home.to_owned())],
        tool_env,
    );

    let mut driver = J::obj([("kind", J::str("codex-app-server"))]);
    if interactive {
        driver.set("presentation", J::str("codex-tui"));
        driver.set("transport", J::str("websocket-unix"));
    }
    if let Some(k) = continuation_key {
        driver.set("resumeThreadId", J::str(k));
    }
    driver.set("model", J::str(&model));
    if let Some(e) = &effort {
        driver.set("modelReasoningEffort", J::str(e));
    }
    driver.set("approvalPolicy", J::str("never"));
    if let Some(m) = &sandbox {
        driver.set("sandboxMode", J::str(m));
    }
    driver.set("permissionPolicy", broker_permission_policy(policy)?);
    driver.set("resumeFallback", J::str("fail"));
    if let Some(t) = plan
        .system_prompt
        .as_ref()
        .and_then(|sp| sp.task_scoped.as_ref())
    {
        driver.set("developerInstructions", J::str(&t.content));
    }

    let mut spec = spec_header(req)?;
    spec.set(
        "harness",
        J::obj([
            ("frontend", J::str("codex")),
            ("provider", J::str("openai")),
            ("driver", J::str("codex-app-server")),
        ]),
    );
    let mut process = process_spec(
        command,
        &args,
        &plan.cwd,
        &locked,
        &path_prepend,
        "jsonrpc-stdio",
    );
    process.set(
        "limits",
        process_limits(policy).unwrap_or_else(default_limits),
    );
    spec.set("process", process);
    spec.set(
        "interaction",
        J::obj([
            (
                "mode",
                J::str(if interactive {
                    "interactive"
                } else {
                    "headless"
                }),
            ),
            ("turnConcurrency", J::str("single")),
            ("inputQueue", J::str("fifo")),
        ]),
    );
    if let Some(k) = continuation_key {
        spec.set(
            "continuation",
            J::obj([
                ("provider", J::str("codex")),
                ("kind", J::str("thread")),
                ("key", J::str(k)),
            ]),
        );
    }
    spec.set("driver", driver);
    spec.set("correlation", broker_correlation(req)?);
    let mut start_request = J::obj([("spec", spec)]);

    // buildInitialInput: the priming/caller prompt only, never the system prompt.
    let items = initial_content(material, prompt.as_deref());
    if !items.is_empty() {
        let content = J::Arr(items);
        let identity = req
            .get("identity")
            .ok_or_else(|| super::fwd(crate::reason!("invalid_params")))?;
        let input_id = match identity.get("initialInputId") {
            Some(id) => id.clone(),
            None => {
                // deriveInitialInputId: {idSalt, generation, content}.
                let mut material = J::Obj(vec![]);
                if let Some(salt) = plan
                    .params
                    .get("compileContext")
                    .and_then(|c| c.get("idSalt"))
                {
                    material.set("idSalt", salt.clone());
                }
                if let Some(g) = identity.get("generation") {
                    material.set("generation", g.clone());
                }
                material.set("content", content.clone());
                J::str(format!("input_{}", &hash(&material, true)[..32]))
            }
        };
        let mut input = J::obj([
            ("inputId", input_id),
            ("kind", J::str("user")),
            ("content", content),
        ]);
        // T-03779: a per-turn response format rides on the initial turn only
        // when there is one; a format alone never synthesizes an input.
        if let Some(format) = material.get("responseFormat") {
            input.set("responseFormat", format.clone());
        }
        start_request.set("initialInput", input);
    }

    finalize(
        plan,
        release,
        start_request,
        locked,
        warnings,
        artifacts.system_prompt_path,
        artifacts.bundle_root,
    )
}

/// buildInitialInput's content: the launch prompt unless the caller's is
/// empty or priming is omitted without one, then the image attachments.
pub(super) fn initial_content(material: &J, prompt: Option<&str>) -> Vec<J> {
    let caller = s(material.get("initialPrompt"));
    let omit_priming = matches!(material.get("omitPriming"), Some(J::Bool(true)));
    let text = if caller == Some("") || (omit_priming && caller.is_none()) {
        None
    } else {
        prompt.filter(|p| !p.is_empty())
    };
    let mut items = Vec::new();
    if let Some(text) = text {
        items.push(J::obj([("type", J::str("text")), ("text", J::str(text))]));
    }
    for path in image_attachment_paths(material) {
        items.push(J::obj([
            ("type", J::str("local_image")),
            ("path", J::str(path)),
        ]));
    }
    items
}

/// prepare-cli-runtime.ts `extractImageAttachmentPaths` over
/// broker-request-projection.ts `toBrokerAttachments`: image and local-file
/// attachments become file refs, and those an image by content type or
/// extension reach the initial input. Other kinds are dropped.
fn image_attachment_paths(material: &J) -> Vec<String> {
    const IMAGE: [&str; 11] = [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".heic", ".heif",
        ".avif",
    ];
    let Some(J::Arr(attachments)) = material.get("attachments") else {
        return vec![];
    };
    attachments
        .iter()
        .filter(|a| matches!(s(a.get("kind")), Some("image" | "local-file")))
        .filter_map(|a| {
            let path = s(a.get("path")).filter(|p| !p.is_empty())?;
            let by_type =
                s(a.get("mimeType")).is_some_and(|t| t.to_lowercase().starts_with("image/"));
            let clean = path.split('?').next().unwrap_or(path);
            let clean = clean.split('#').next().unwrap_or(clean);
            let ext = crate::reads::jspath::extname(clean).to_lowercase();
            (by_type || IMAGE.contains(&ext.as_str())).then(|| path.to_owned())
        })
        .collect()
}
