//! Staging the plugin artifacts a mutable target publishes, under
//! tmp/.staging: each planned space through its harness adapter
//! (plugin-artifacts.ts `materializeSpaceEntry`), and the agent's own
//! skills and commands as a synthetic plugin
//! (`detectAgentLocalComponents`/`materializeAgentLocalComponents`).
use super::Fwd;
use super::fs_tree::{copy_dir, copy_dir_following, is_dir_follow, mkdirp, write};
use super::space_plan::SpacePlan;
use super::temp_lifecycle::unique_staging_dir;
use super::util::sanitize_segment;
use crate::json::J;
use crate::reads::jspath::{basename, join};

/// What `materializeSpaceEntry` returns.
pub struct Artifact {
    pub space_key: String,
    pub space_id: String,
    pub path: String,
    pub plugin_name: String,
    pub plugin_version: String,
    pub settings: J,
}

/// `materializeSpaceEntry` for a mutable space: stage it under tmp/.staging.
pub fn stage_space(plan: &SpacePlan, asp_home: &str, codex: bool) -> Result<Artifact, Fwd> {
    let dir = unique_staging_dir(
        asp_home,
        &format!("space-{}", sanitize_segment(&plan.input.key)),
    );
    if codex {
        super::codex::space::materialize_space(plan, &dir)?;
    } else {
        super::claude_plugin::materialize_space(plan, &dir)?;
    }
    Ok(Artifact {
        space_key: plan.input.key.clone(),
        space_id: plan.input.id.clone(),
        path: dir,
        plugin_name: plan.input.plugin_name.clone(),
        plugin_version: plan.input.plugin_version.clone(),
        settings: plan
            .manifest
            .get("settings")
            .cloned()
            .unwrap_or(J::Obj(vec![])),
    })
}

/// Agent-local skills/commands, as `detectAgentLocalComponents` found them.
pub struct AgentLocal {
    pub agent_root: String,
    pub has_skills: bool,
    pub has_commands: bool,
    pub has_tools: bool,
}

impl AgentLocal {
    pub fn detect(agent_root: &str) -> Option<AgentLocal> {
        let found = AgentLocal {
            agent_root: agent_root.to_owned(),
            has_skills: is_dir_follow(&join(&[agent_root, "skills"])),
            has_commands: is_dir_follow(&join(&[agent_root, "commands"])),
            has_tools: is_dir_follow(&join(&[agent_root, "tools", "bin"])),
        };
        (found.has_skills || found.has_commands || found.has_tools).then_some(found)
    }
}

/// `materializeAgentLocalComponents(components, paths)`.
pub fn stage_agent_local(local: &AgentLocal, asp_home: &str) -> Result<Option<Artifact>, Fwd> {
    if !local.has_skills && !local.has_commands {
        return Ok(None);
    }
    let agent_name = basename(&local.agent_root);
    let plugin_name = format!("{agent_name}-agent");
    let dir = unique_staging_dir(
        asp_home,
        &format!("agent-components-{}", sanitize_segment(&agent_name)),
    );
    mkdirp(&join(&[&dir, ".claude-plugin"]))?;
    let plugin = J::obj([
        ("name", J::str(&plugin_name)),
        ("version", J::str("0.0.0")),
        ("description", J::str("Agent-local skills and commands")),
    ]);
    // No trailing newline, unlike a space's plugin.json.
    write(
        &join(&[&dir, ".claude-plugin", "plugin.json"]),
        &plugin.to_json_pretty(),
    )?;
    if local.has_skills {
        copy_dir(
            &join(&[&local.agent_root, "skills"]),
            &join(&[&dir, "skills"]),
            false,
        )?;
    }
    if local.has_commands {
        copy_dir_following(
            &join(&[&local.agent_root, "commands"]),
            &join(&[&dir, "commands"]),
        )?;
    }
    Ok(Some(Artifact {
        space_key: format!("{plugin_name}@local"),
        space_id: plugin_name.clone(),
        path: dir,
        plugin_name,
        plugin_version: "0.0.0".into(),
        settings: J::Obj(vec![]),
    }))
}
