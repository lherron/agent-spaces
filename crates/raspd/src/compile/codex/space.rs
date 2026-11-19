//! `CodexAdapter.materializeSpace(input, dir, { force: false, useHardlinks:
//! false })`: one space's staged artifact — skills, commands as prompts,
//! mcp.json, AGENTS.md/AGENT.md as instructions.md, `[codex.config]` as
//! codex.config.json and its codex pre_tool_use hooks with their scripts.
use crate::compile::Fwd;
use crate::compile::fs_tree::{
    copy_dir, io_fwd, is_dir_follow, mkdirp, read_text, write, write_json,
};
use crate::compile::space_plan::SpacePlan;
use crate::json::J;
use crate::reads::jspath::{exists, join};
use std::fs;

/// The hooks.toml entries codex honours (`selectCodexSpaceHooks`).
fn codex_space_hooks(hooks: &[J]) -> Vec<J> {
    hooks
        .iter()
        .filter(|h| {
            h.get("harness").and_then(J::as_str) == Some("codex")
                && h.get("event").and_then(J::as_str) == Some("pre_tool_use")
        })
        .map(|h| {
            let mut out = J::obj([
                ("event", h.get("event").cloned().unwrap_or(J::Null)),
                ("script", h.get("script").cloned().unwrap_or(J::Null)),
            ]);
            if let Some(tools) = h.get("tools") {
                out.set("tools", tools.clone());
            }
            out
        })
        .collect()
}

/// The staged artifact at `dir`; a failure removes it.
pub fn materialize_space(plan: &SpacePlan, dir: &str) -> Result<(), Fwd> {
    let result = (|| {
        let src = &plan.input.content_dir;
        mkdirp(dir)?;
        let codex = plan.manifest.get("codex");
        let enabled = |k: &str| {
            codex.and_then(|c| c.get(k)).and_then(|s| s.get("enabled")) != Some(&J::Bool(false))
        };
        if enabled("skills") {
            let s = join(&[src, "skills"]);
            if is_dir_follow(&s) {
                copy_dir(&s, &join(&[dir, "skills"]), false)?;
            }
        }
        if enabled("prompts") {
            let s = join(&[src, "commands"]);
            if is_dir_follow(&s) {
                let d = join(&[dir, "prompts"]);
                mkdirp(&d)?;
                for entry in fs::read_dir(&s).map_err(io_fwd)? {
                    let entry = entry.map_err(io_fwd)?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if !entry.file_type().map_err(io_fwd)?.is_file() || !name.ends_with(".md") {
                        continue;
                    }
                    let bytes = fs::read(join(&[&s, &name])).map_err(io_fwd)?;
                    fs::write(join(&[&d, &name]), bytes).map_err(io_fwd)?;
                }
            }
        }
        let mcp = join(&[src, "mcp", "mcp.json"]);
        if exists(&mcp) {
            mkdirp(&join(&[dir, "mcp"]))?;
            let bytes = fs::read(&mcp).map_err(io_fwd)?;
            fs::write(join(&[dir, "mcp", "mcp.json"]), bytes).map_err(io_fwd)?;
        }
        for name in ["AGENTS.md", "AGENT.md"] {
            let s = join(&[src, name]);
            if exists(&s) {
                write(&join(&[dir, "instructions.md"]), &read_text(&s)?)?;
                break;
            }
        }
        if let Some(config @ J::Obj(fields)) = codex.and_then(|c| c.get("config"))
            && !fields.is_empty()
        {
            write_json(&join(&[dir, "codex.config.json"]), config)?;
        }
        let hooks = codex_space_hooks(plan.hooks.as_deref().unwrap_or_default());
        if !hooks.is_empty() {
            copy_dir(&join(&[src, "hooks"]), &join(&[dir, "hooks"]), false)?;
            write_json(&join(&[dir, "space-hooks.json"]), &J::Arr(hooks))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(dir);
    }
    result
}
