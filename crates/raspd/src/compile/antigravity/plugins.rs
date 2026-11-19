//! Translate composed spaces into Antigravity's plugin layout.
use super::hooks;
use crate::compile::fs_tree::{
    copy_dir, copy_dir_following, copy_file, is_dir_follow, is_file_follow, mkdirp, read_json,
    write_json,
};
use crate::compile::space_plan::SpacePlan;
use crate::compile::stage::Artifact;
use crate::compile::{Fwd, fwd, fwd_at};
use crate::json::J;
use crate::reads::jspath::join;

const BRIDGE_NAME: &str = "praesidium-broker";

/// agy infers transport from the endpoint and rejects the ASP type field in
/// strict plugin validation. Preserve every other server property.
pub(in crate::compile) fn project_mcp(source: &str) -> Result<Option<J>, Fwd> {
    let path = join(&[source, "mcp", "mcp.json"]);
    if !is_file_follow(&path) {
        return Ok(None);
    }
    let reason = crate::reason!("antigravity_mcp_transport_unsupported");
    let mut config = read_json(&path, reason)?;
    let Some(J::Obj(mut servers)) = config.remove("mcpServers") else {
        return Err(fwd_at(reason, path));
    };
    for (name, server) in &mut servers {
        let nonempty_string = |value: &J| value.as_str().is_some_and(|s| !s.trim().is_empty());
        let declared = server.get("type");
        let supported = match (server.get("command"), server.get("url")) {
            (Some(command), None) => {
                nonempty_string(command) && declared.is_none_or(|d| d.as_str() == Some("stdio"))
            }
            (None, Some(url)) => {
                nonempty_string(url)
                    && declared
                        .is_none_or(|d| matches!(d.as_str(), Some("http" | "streamable-http")))
            }
            _ => false,
        };
        if !supported {
            return Err(fwd_at(reason, format!("{path}: {name}")));
        }
        server.remove("type");
    }
    config.set("mcpServers", J::Obj(servers));
    Ok(Some(config))
}

pub(in crate::compile) fn stage_space(plan: &SpacePlan, dir: &str) -> Result<(), Fwd> {
    let src = &plan.input.content_dir;
    let name = &plan.input.plugin_name;
    let result = (|| {
        let description = plan
            .manifest
            .get("plugin")
            .and_then(|p| p.get("description"))
            .and_then(J::as_str)
            .unwrap_or(name);
        write_manifest(dir, name, &plan.input.plugin_version, description)?;
        for subdir in ["skills", "scripts", "mcp"] {
            copy_component(src, dir, subdir)?;
        }
        if let Some(config) = &plan.antigravity_mcp {
            write_json(&join(&[dir, "mcp_config.json"]), config)?;
        }
        for filename in ["AGENTS.md", "AGENT.md"] {
            let instructions = join(&[src, filename]);
            if is_file_follow(&instructions) {
                mkdirp(&join(&[dir, "rules"]))?;
                copy_file(&instructions, &join(&[dir, "rules", "AGENTS.md"]))?;
                break;
            }
        }
        if let Some(config) = hooks::space(name, plan.hooks.as_deref().unwrap_or_default())? {
            copy_component(src, dir, "hooks")?;
            write_json(&join(&[dir, "hooks.json"]), &config)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(dir);
    }
    result
}

pub(in crate::compile) fn compose(
    artifacts: &[Artifact],
    output: &str,
    bridge_hooks: &J,
) -> Result<Vec<String>, Fwd> {
    let plugins = join(&[output, "plugins"]);
    mkdirp(&plugins)?;
    let bridge = join(&[&plugins, BRIDGE_NAME]);
    write_manifest(&bridge, BRIDGE_NAME, "1.0.0", "Praesidium broker hooks")?;
    write_json(&join(&[&bridge, "hooks.json"]), bridge_hooks)?;
    let mut manifests = vec![
        join(&[&bridge, "plugin.json"]),
        join(&[&bridge, "hooks.json"]),
    ];
    for artifact in artifacts {
        let name = &artifact.plugin_name;
        let dest = join(&[&plugins, name]);
        if std::path::Path::new(&dest).exists() {
            return Err(fwd(crate::reason!("antigravity_plugin_collision")));
        }
        if is_file_follow(&join(&[&artifact.path, "plugin.json"])) {
            copy_dir(&artifact.path, &dest, false)?;
        } else if is_dir_follow(&join(&[&artifact.path, "skills"])) {
            // Agent-local components are staged in the common legacy format.
            write_manifest(&dest, name, &artifact.plugin_version, "Agent-local skills")?;
            copy_component(&artifact.path, &dest, "skills")?;
        } else {
            continue;
        }
        manifests.push(join(&[&dest, "plugin.json"]));
    }
    Ok(manifests)
}

fn write_manifest(dir: &str, name: &str, version: &str, description: &str) -> Result<(), Fwd> {
    if name.is_empty()
        || !name.as_bytes()[0].is_ascii_lowercase()
        || !name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(fwd(crate::reason!("antigravity_plugin_name")));
    }
    mkdirp(dir)?;
    write_json(
        &join(&[dir, "plugin.json"]),
        &J::obj([
            ("name", J::str(name)),
            ("version", J::str(version)),
            ("description", J::str(description)),
        ]),
    )
}

fn copy_component(src: &str, dest: &str, name: &str) -> Result<(), Fwd> {
    let dir = join(&[src, name]);
    if is_dir_follow(&dir) {
        copy_dir_following(&dir, &join(&[dest, name]))?;
    }
    Ok(())
}
