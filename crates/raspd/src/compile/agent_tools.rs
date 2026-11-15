//! The agent tool runtime (`prepareAgentToolRuntime`, `validateAgentTools`):
//! the agent's var dirs, the tool env and typed PATH prepend, and the
//! validation of its tools/bin.
use super::broker_spec::EnvPairs;
use super::plan::Plan;
use super::util::{self, sanitize_segment};
use super::{Fwd, fwd, fwd_at};
use crate::json::J;
use crate::reads::jspath::{basename, join, resolve};

/// The agent tool runtime's project id: the scope's project, else the
/// project root's basename, joined with the agent's name.
fn agent_project_state_id(plan: &Plan, project_root: &str) -> String {
    let agent_name = basename(&plan.agent_root);
    let project = plan
        .correlation_env
        .iter()
        .find(|(k, _)| k == "AGENT_PROJECT")
        .map(|(_, v)| v.clone());
    match project {
        Some(p) => format!("{}_{}", sanitize_segment(&p), sanitize_segment(&agent_name)),
        None => format!(
            "{}_{}",
            sanitize_segment(&basename(&resolve(&[project_root]))),
            sanitize_segment(&agent_name)
        ),
    }
}

/// The directories `prepareAgentToolRuntime` makes under the agent's var/.
pub(super) fn agent_var_dirs(plan: &Plan) -> Vec<String> {
    let state = join(&[&plan.agent_root, "var", "state"]);
    let mut dirs = vec![
        state.clone(),
        join(&[&plan.agent_root, "var", "cache"]),
        join(&[&plan.agent_root, "var", "logs"]),
    ];
    if let Some(root) = &plan.project_root {
        dirs.push(join(&[
            &state,
            "projects",
            &agent_project_state_id(plan, root),
        ]));
    }
    dirs
}

/// `prepareAgentToolRuntime`: the agent var dirs, the tool env, and the
/// typed PATH prepend.
pub(super) fn agent_tool_env(plan: &Plan) -> Result<(EnvPairs, Vec<String>), Fwd> {
    let agent_root = &plan.agent_root;
    let agent_name = basename(agent_root);
    let var = join(&[agent_root, "var"]);
    let state = join(&[&var, "state"]);
    let cache = join(&[&var, "cache"]);
    let logs = join(&[&var, "logs"]);
    for d in [&state, &cache, &logs] {
        std::fs::create_dir_all(d)
            .map_err(|e| fwd_at(crate::reason!("agent_var_dirs"), e.to_string()))?;
    }
    let mut env = vec![
        ("ASP_AGENT_ROOT".to_owned(), agent_root.clone()),
        ("ASP_AGENT_NAME".into(), agent_name.clone()),
        ("ASP_AGENT_VAR_DIR".into(), var.clone()),
        ("ASP_AGENT_STATE_DIR".into(), state.clone()),
        ("ASP_AGENT_CACHE_DIR".into(), cache),
        ("ASP_AGENT_LOG_DIR".into(), logs),
    ];
    if let Some(project_root) = &plan.project_root {
        let project_id = agent_project_state_id(plan, project_root);
        let project_state = join(&[&state, "projects", &project_id]);
        std::fs::create_dir_all(&project_state)
            .map_err(|e| fwd_at(crate::reason!("agent_var_dirs"), e.to_string()))?;
        env.push(("ASP_PROJECT_ROOT".into(), project_root.clone()));
        env.push(("ASP_PROJECT_ID".into(), project_id));
        env.push(("ASP_PROJECT_STATE_DIR".into(), project_state));
    }
    let mut path_prepend = vec![];
    if plan.agent_local.as_ref().is_some_and(|l| l.has_tools) {
        let tools = join(&[agent_root, "tools"]);
        let bin = join(&[&tools, "bin"]);
        env.push(("ASP_AGENT_TOOLS_DIR".into(), tools));
        env.push(("ASP_AGENT_TOOLS_BIN".into(), bin.clone()));
        // PATH from the caller's dispatch env, else the daemon's.
        let dispatch_path = plan
            .req
            .get("placement")
            .and_then(|p| p.get("dispatchEnv"))
            .and_then(|d| d.get("PATH"))
            .and_then(J::as_str)
            .map(str::to_owned);
        let current = dispatch_path
            .or_else(|| util::exec_environment().get("PATH").cloned())
            .unwrap_or_default();
        if current.split(':').next() != Some(bin.as_str()) || current.is_empty() {
            path_prepend.push(bin);
        }
    }
    Ok((env, path_prepend))
}

const RESERVED_TOOL_NAMES: [&str; 41] = [
    "sh",
    "bash",
    "zsh",
    "env",
    "sudo",
    "su",
    "node",
    "npm",
    "npx",
    "bun",
    "bunx",
    "python",
    "python3",
    "pip",
    "pip3",
    "ruby",
    "perl",
    "go",
    "cargo",
    "claude",
    "codex",
    "pi",
    "hrc",
    "hrcchat",
    "acp",
    "asp",
    "wrkq",
    "stackctl",
    "agentchat",
    "git",
    "gh",
    "curl",
    "wget",
    "jq",
    "sed",
    "awk",
    "grep",
    "find",
    "xargs",
    "make",
    "just",
];

/// `validateAgentTools(components)`: its warnings, or a forward where Bun throws.
pub(super) fn validate_agent_tools(agent_root: &str) -> Result<Vec<String>, Fwd> {
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    let tools = join(&[agent_root, "tools"]);
    let bin = join(&[&tools, "bin"]);
    let tools_real =
        std::fs::canonicalize(&tools).map_err(|_| fwd(crate::reason!("agent_tools_invalid")))?;
    let tools_real = tools_real.to_string_lossy().into_owned();
    let mut warnings = vec![];
    for entry in std::fs::read_dir(&bin).map_err(|_| fwd(crate::reason!("agent_tools_invalid")))? {
        let entry = entry.map_err(|_| fwd(crate::reason!("agent_tools_invalid")))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let pattern_ok = name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
            && name.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')
            });
        if !pattern_ok || RESERVED_TOOL_NAMES.contains(&name.as_str()) {
            return Err(fwd(crate::reason!("agent_tools_invalid")));
        }
        let path = join(&[&bin, &name]);
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|_| fwd(crate::reason!("agent_tools_invalid")))?;
        let resolved = if meta.file_type().is_symlink() {
            let real = std::fs::canonicalize(&path)
                .map_err(|_| fwd(crate::reason!("agent_tools_invalid")))?;
            let real = real.to_string_lossy().into_owned();
            if real != tools_real && !real.starts_with(&format!("{tools_real}/")) {
                return Err(fwd(crate::reason!("agent_tools_invalid")));
            }
            real
        } else if meta.is_file() {
            path.clone()
        } else {
            return Err(fwd(crate::reason!("agent_tools_invalid")));
        };
        let target =
            std::fs::metadata(&resolved).map_err(|_| fwd(crate::reason!("agent_tools_invalid")))?;
        if !target.is_file() || target.permissions().mode() & 0o111 == 0 {
            return Err(fwd(crate::reason!("agent_tools_invalid")));
        }
        let mut head = vec![];
        std::fs::File::open(&resolved)
            .and_then(|f| f.take(4096).read_to_end(&mut head))
            .map_err(|_| fwd(crate::reason!("agent_tools_invalid")))?;
        if !head.is_empty() && !head.contains(&0) && !head.starts_with(b"#!") {
            warnings.push(format!(
                "Agent tool \"{name}\" is executable text but has no shebang"
            ));
        }
    }
    Ok(warnings)
}
