//! `aspc.inspectAgent` (`inspectAgentForContext` over a caller-supplied
//! evaluation context): the request's identifiers must match the context's,
//! then the prompt resolves pinned to that context and the one-compile core
//! runs with the context's own compile context.
use super::{PromptReport, evaluate};
use crate::compile::prompt::{self, discovery, template, zones};
use crate::compile::{Fwd, Phases, fwd, invalid_params, s};
use crate::json::J;
use crate::release::Release;

pub(super) fn inspect_agent(
    request: &J,
    context: &J,
    release: &Release,
    phases: &mut Phases,
) -> Result<J, Fwd> {
    let identifiers = request.get("identifiers").ok_or_else(invalid_params)?;
    let context_ids = context.get("identifiers").ok_or_else(invalid_params)?;
    if identifiers
        .js_entries()
        .iter()
        .any(|(k, v)| context_ids.get(k) != Some(v))
    {
        return Err(fwd(crate::reason!("inspection_identity_mismatch")));
    }
    let first = context_prompt(context)?;
    let inspection = evaluate::evaluate(request, context, &first, release, phases, true)?;
    Ok(J::obj([("ok", J::Bool(true)), ("inspection", inspection)]))
}

/// The system prompt report for the caller's paths, identifiers,
/// environments and scaffold packets, every value pinned to the context.
fn context_prompt(context: &J) -> Result<PromptReport, Fwd> {
    let paths = context.get("paths").ok_or_else(invalid_params)?;
    let path = |k| s(paths.get(k)).ok_or_else(invalid_params);
    let agent_root = path("agentRoot")?;
    let agents_root = path("agentsRoot")?;
    let discovered = discovery::discover_explicit(agent_root, agents_root)?;
    if !discovered.has_prompt(agent_root) {
        return Ok(None);
    }
    let template = match discovered.template {
        Some(t) => t,
        None => template::default_template_with_scaffold(
            discovered.base(),
            context.get("scaffoldPackets").ok_or_else(invalid_params)?,
        )?,
    };
    let id = context.get("identifiers").ok_or_else(invalid_params)?;
    let value = |k| s(id.get(k)).map(str::to_owned);
    let ctx = prompt::Ctx {
        agent_root: agent_root.into(),
        agents_root: agents_root.into(),
        search_path: vec![agent_root.into(), agents_root.into()],
        project_root: Some(path("projectRoot")?.into()),
        cwd: Some(path("cwd")?.into()),
        agent_id: value("agentId"),
        agent_name: value("agentName").or_else(|| value("agentId")),
        project_id: value("projectId"),
        task_id: value("taskId"),
        task_context: None,
        lane: value("lane"),
        run_mode: value("mode"),
        agent_profile: context.get("agentProfile").cloned(),
        env: Some(prompt::context_env(
            context.get("environment").ok_or_else(invalid_params)?,
        )),
        exec_env: Some(prompt::context_env(
            context
                .get("execInputs")
                .and_then(|i| i.get("environment"))
                .ok_or_else(invalid_params)?,
        )),
        pinned: Some(prompt::Pinned::new(context.clone())),
    };
    let (resolved, inspected) = zones::resolve_inspected(&template, &ctx)?;
    Ok(Some((resolved, inspected, template.append)))
}
