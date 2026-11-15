//! The refusals the request's inputs decide that Bun reaches only after
//! writing, judged before the first write so a refused request leaves
//! ASP_HOME and the agent root as they were (T-13018 r2 section 2.1).
use super::agent_tools::agent_var_dirs;
use super::broker_spec::{broker_permission_policy, path_filter_scope};
use super::emit_codex::initial_content;
use super::plan::{Launch, Plan};
use super::{Fwd, codex, fwd_at, request, spaces};
use crate::reads::jspath::join;

/// The path filter's zdotdir, the agent var dirs, and for codex the broker
/// permission policy, the config.toml render and the response format.
pub(super) fn preflight(plan: &Plan) -> Result<(), Fwd> {
    let path_exclude = spaces::path_exclude(&plan.closure);
    if !path_exclude.is_empty() && !plan.codex_home_read_only {
        let zdotdir = join(&[&path_filter_scope(plan), "zdotdir"]);
        if !dir_creatable(&zdotdir) {
            return Err(fwd_at(crate::reason!("path_filter_mkdir"), zdotdir));
        }
    }
    for dir in agent_var_dirs(plan) {
        if !dir_creatable(&dir) {
            return Err(fwd_at(crate::reason!("agent_var_dirs"), dir));
        }
    }
    if matches!(plan.launch, Launch::Codex { .. }) {
        broker_permission_policy(
            plan.req
                .get("hrcPolicy")
                .ok_or_else(|| super::fwd(crate::reason!("invalid_params")))?,
        )?;
        codex::preflight_config(&plan.space_plans, plan.codex_options.as_ref())?;
        // validateInvocationInput judges a format only on an initial input
        // that exists (compiler_exception, after Bun's writes).
        let material = plan
            .req
            .get("materialization")
            .ok_or_else(|| super::fwd(crate::reason!("invalid_params")))?;
        if let Some(format) = material.get("responseFormat")
            && !request::response_format_valid(format)
            && !initial_content(material, plan.expanded_prompt.as_deref()).is_empty()
        {
            return Err(fwd_at(
                crate::reason!("materialization_shape"),
                "materialization.responseFormat:invalid".to_owned(),
            ));
        }
    }
    Ok(())
}

/// A directory `create_dir_all` can make: its nearest existing ancestor (or
/// itself) is a directory. Permissions are the write's to find out.
fn dir_creatable(path: &str) -> bool {
    for p in std::path::Path::new(path).ancestors() {
        match std::fs::metadata(p) {
            Ok(m) => return m.is_dir(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
    }
    true
}
