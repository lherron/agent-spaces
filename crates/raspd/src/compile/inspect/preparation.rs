//! The placement side of preparation-execution-context.ts: the placement a
//! declaration resolves to (`placementFromDeclaration`), the execution
//! context prepared for it (`buildPreparationExecutionContext`) and the
//! system prompt report over that preparation's prompt input.
use super::PromptReport;
use crate::compile::prompt::{self, discovery, template, zones};
use crate::compile::scope::{agent_session_env, handle_parts, parse_scope_ref};
use crate::compile::util::{exec_environment, hash};
use crate::compile::{Fwd, s};
use crate::json::J;
use crate::reads::jspath::{basename, resolve};

/// `buildPreparationExecutionContext`'s outputs an inspection reads.
pub(super) struct Preparation {
    pub agent_id: String,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub lane: Option<String>,
    pub exec_env: prompt::EnvMap,
    pub effective_environment_hash: String,
}

/// `placementFromDeclaration(resolvedPlacement, context, correlation)`.
pub(super) fn placement_from_declaration(resolved: &J, context: &J, correlation: J) -> J {
    let mut placement = resolved.clone();
    if let Some(root) = crate::reads::truthy_str(context.get("agentRoot")) {
        placement.set("agentRoot", J::str(root));
    }
    let project = context.get("project");
    let project_root = (project.and_then(|p| s(p.get("mode"))) == Some("root"))
        .then(|| project.and_then(|p| p.get("projectRoot")).cloned())
        .flatten();
    if let Some(root) = &project_root {
        placement.set("projectRoot", root.clone());
    }
    if let Some(bundle) = placement.get("bundle").cloned()
        && s(bundle.get("kind")) == Some("agent-project")
    {
        let mut bundle = bundle;
        if let Some(root) = &project_root {
            bundle.set("projectRoot", root.clone());
        }
        placement.set("bundle", bundle);
    }
    placement.set("cwd", context.get("cwd").cloned().unwrap_or(J::str("")));
    placement.set("correlation", correlation);
    placement
}

/// `PreparationContextMismatchError`'s message.
fn mismatch(field: &str, scoped: &str, hinted: &str) -> String {
    format!(
        "sessionRef {field} {} conflicts with context {field} {}",
        J::str(scoped).to_json(),
        J::str(hinted).to_json()
    )
}

/// `buildPreparationExecutionContext(placement, inputs)`: `Ok(Err(message))`
/// is its `PreparationContextMismatchError`.
pub(super) fn preparation(
    placement: &J,
    hints: (&str, Option<&str>, Option<&str>),
    task_context: Option<&J>,
) -> Result<Result<Preparation, String>, Fwd> {
    let agent_root = s(placement.get("agentRoot")).unwrap_or_default();
    let session = placement
        .get("correlation")
        .and_then(|c| c.get("sessionRef"));
    let parts = handle_parts(
        &{
            let mut p = placement.clone();
            p.remove("projectRoot");
            p
        },
        false,
    )?;
    let canonical = session
        .and_then(|x| s(x.get("scopeRef")))
        .is_some_and(|scope| parse_scope_ref(scope).is_some());
    let (hint_agent, hint_project, hint_task) = hints;
    if canonical {
        let checks = [
            ("agentId", parts.agent_id.as_deref(), Some(hint_agent)),
            ("projectId", parts.project_id.as_deref(), hint_project),
            ("taskId", parts.task_id.as_deref(), hint_task),
        ];
        for (field, scoped, hinted) in checks {
            if let (Some(scoped), Some(hinted)) = (scoped, hinted)
                && scoped != hinted
            {
                return Ok(Err(mismatch(field, scoped, hinted)));
            }
        }
        // assertPreparationTaskContext.
        if let (Some(scoped), Some(tc)) = (parts.task_id.as_deref(), task_context)
            && let Some(hinted) = s(tc.get("taskId"))
            && scoped != hinted
        {
            return Ok(Err(mismatch("taskId", scoped, hinted)));
        }
    }
    let agent_id = match (&session, &parts.agent_id) {
        (Some(_), Some(a)) if !a.is_empty() => a.clone(),
        _ => basename(agent_root),
    };
    let project_id = parts
        .project_id
        .clone()
        .or_else(|| hint_project.map(str::to_owned))
        .or_else(|| s(placement.get("projectRoot")).map(|p| basename(&resolve(&[p]))));
    let task_id = parts
        .task_id
        .clone()
        .or_else(|| hint_task.map(str::to_owned));
    let mut exec_env = exec_environment().clone();
    for (k, v) in agent_session_env(placement)? {
        exec_env.insert(k, v);
    }
    exec_env.insert("AGENTCHAT_ID".into(), basename(agent_root));
    if let Some(p) = &project_id {
        exec_env.insert("ASP_PROJECT".into(), p.clone());
    }
    let env_json = env_object(&exec_env);
    let effective_environment_hash = match task_context {
        None => hash(&env_json, false),
        Some(tc) => hash(
            &J::obj([("environment", env_json), ("taskContext", tc.clone())]),
            false,
        ),
    };
    Ok(Ok(Preparation {
        agent_id,
        project_id,
        task_id,
        lane: parts.lane,
        exec_env,
        effective_environment_hash,
    }))
}

pub(super) fn env_object(env: &prompt::EnvMap) -> J {
    J::Obj(env.iter().map(|(k, v)| (k.clone(), J::str(v))).collect())
}

/// `inspectAgentSystemPrompt(preparation.promptInput)`: `None` when the agent
/// declares no template and has no SOUL.md.
pub(super) fn placement_prompt(
    placement: &J,
    prep: &Preparation,
    task_context: Option<&J>,
    sources: (&str, Option<&str>),
) -> Result<PromptReport, Fwd> {
    let agent_root = s(placement.get("agentRoot")).unwrap_or_default();
    let project_root = s(placement.get("projectRoot"));
    let (asp_home, agents_root) = sources;
    let discovered = discovery::discover(agent_root, project_root, asp_home, Some(agents_root))?;
    if !discovered.has_prompt(agent_root) {
        return Ok(None);
    }
    let agent_profile = discovered.agent_profile();
    let template = match discovered.template {
        Some(t) => t,
        None => template::default_template(discovered.base()),
    };
    let ctx = prompt::Ctx {
        agent_root: agent_root.to_owned(),
        agents_root: discovered.agents_root.clone(),
        search_path: discovered.search_path.clone(),
        project_root: project_root.map(str::to_owned),
        cwd: s(placement.get("cwd")).map(str::to_owned),
        project_id: prep.project_id.clone(),
        agent_id: Some(prep.agent_id.clone()),
        agent_name: Some(basename(agent_root)),
        task_id: prep.task_id.clone(),
        task_context: task_context.cloned(),
        lane: prep.lane.clone(),
        run_mode: s(placement.get("runMode")).map(str::to_owned),
        agent_profile,
        env: Some(prep.exec_env.clone()),
        exec_env: Some(prep.exec_env.clone()),
        pinned: None,
    };
    let (resolved, inspected) = zones::resolve_inspected(&template, &ctx)?;
    Ok(Some((resolved, inspected, template.append)))
}
