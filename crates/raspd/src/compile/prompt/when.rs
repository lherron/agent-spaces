//! `matchesWhenPredicate` (when-predicate.ts): whether a section or inline part
//! applies to this resolution.
use super::vars::task_facts;
use super::{Ctx, context_env};
use crate::compile::util::js_trim;
use crate::compile::{Fwd, fwd};
use crate::json::J;
use crate::reads::jspath::join;

/// A parsed `when` table; every condition present must hold.
#[derive(Clone, Default)]
pub(super) struct When {
    pub(super) run_mode: Option<String>,
    pub(super) exists: Option<String>,
    pub(super) env_set: Option<String>,
    pub(super) env_equals: Option<(String, String)>,
    pub(super) env_not_equals: Option<(String, String)>,
    pub(super) task_field: Option<String>,
}

/// `matchesWhenPredicate`. An inspection judges `cwd` and the environment from
/// its pinned `predicateInputs`.
pub(super) fn matches(when: Option<&When>, ctx: &Ctx) -> Result<bool, Fwd> {
    let Some(w) = when else { return Ok(true) };
    let mut predicate;
    let ctx = if let Some(p) = &ctx.pinned {
        predicate = ctx.clone();
        let i = p
            .context
            .get("predicateInputs")
            .ok_or_else(|| fwd(crate::reason!("invalid_params")))?;
        predicate.cwd = i.get("cwd").and_then(J::as_str).map(str::to_owned);
        predicate.env = Some(context_env(
            i.get("environment")
                .ok_or_else(|| fwd(crate::reason!("invalid_params")))?,
        ));
        &predicate
    } else {
        ctx
    };
    if w.run_mode
        .as_ref()
        .is_some_and(|m| Some(m) != ctx.run_mode.as_ref())
    {
        return Ok(false);
    }
    if let Some(e) = &w.exists {
        // Bun: `cwd ?? projectRoot ?? process.cwd()`.
        let cwd = match ctx.cwd.as_ref().or(ctx.project_root.as_ref()) {
            Some(c) => c.clone(),
            None => std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "/".into()),
        };
        if !std::path::Path::new(&join(&[&cwd, e])).exists() {
            return Ok(false);
        }
    }
    if let Some(field) = &w.task_field
        && !task_facts(ctx).is_some_and(|f| f.has(field))
    {
        return Ok(false);
    }
    if let Some(k) = &w.env_set
        && ctx.env_var(k).is_none_or(|v| js_trim(&v).is_empty())
    {
        return Ok(false);
    }
    if let Some((k, v)) = &w.env_equals
        && ctx.env_var(k).as_deref() != Some(v.as_str())
    {
        return Ok(false);
    }
    if let Some((k, v)) = &w.env_not_equals
        && ctx.env_var(k).as_deref() == Some(v.as_str())
    {
        return Ok(false);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::super::test_ctx;
    use super::*;

    /// T-12027: `when.exists` checks the placement folder (`cwd ?? projectRoot`),
    /// never the daemon's process cwd, matching Bun's resolver context.
    #[test]
    fn when_exists_checks_the_placement_folder() -> Result<(), Box<dyn std::error::Error>> {
        let base = std::env::temp_dir().join(format!("raspd-when-cwd-{}", std::process::id()));
        let project = base.join("project");
        std::fs::create_dir_all(&project)?;
        std::fs::write(project.join("pm-gate"), "")?;
        let gate = When {
            exists: Some("pm-gate".into()),
            ..When::default()
        };
        let mut c = test_ctx();
        c.project_root = Some(project.to_string_lossy().into_owned());
        let via_project_root = matches(Some(&gate), &c)
            .map_err(|f| format!("{}: {:?}", f.reason.as_str(), f.detail))?;
        c.cwd = Some(base.to_string_lossy().into_owned());
        let cwd_wins = matches(Some(&gate), &c)
            .map_err(|f| format!("{}: {:?}", f.reason.as_str(), f.detail))?;
        std::fs::remove_dir_all(&base)?;
        assert!(via_project_root);
        assert!(!cwd_wins);
        Ok(())
    }
}
