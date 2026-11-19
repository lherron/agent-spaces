//! The target bundle (`CodexAdapter.composeTarget` / `loadTargetBundle`): the
//! staged artifacts merged into one `codex.home` template — skills, prompts,
//! AGENTS.md, mcp.json, space hook scripts, hooks.json, config.toml with its
//! hook trust, the user's auth.json link and manifest.json.
use super::agents::{Block, agents_markdown};
use super::config::{codex_config, mcp_servers, render_config, target_overrides};
use super::hooks::{add_trust_state, hrc_hooks_config, merge_hooks, space_hooks_config};
use crate::compile::fs_tree::{
    copy_dir, hardlink_or_copy, io_fwd, is_dir_follow, mkdirp, read_json, read_text, rm_rf, write,
    write_json,
};
use crate::compile::stage::Artifact;
use crate::compile::util::{js_sort, now_iso, sha256_hex};
use crate::compile::{Fwd, fwd};
use crate::json::J;
use crate::reads::jspath::{dirname, exists, join};
use std::fs;
use std::os::unix::fs::symlink;

pub struct Bundle {
    pub root_dir: String,
    pub home: String,
}

/// What the artifacts contribute beyond the files they place in the home.
#[derive(Default)]
struct Composed {
    skills: Vec<String>,
    prompts: Vec<String>,
    blocks: Vec<Block>,
    instruction_hashes: Vec<J>,
    overrides: Vec<J>,
    hook_sets: Vec<(String, J)>,
}

/// Skill directories (or links to one) by UTF-16 name order; a later space's
/// skill replaces an earlier one of the same name.
fn merge_skills(src_skills: &str, skills_dir: &str, merged: &mut Vec<String>) -> Result<(), Fwd> {
    if !is_dir_follow(src_skills) {
        return Ok(());
    }
    let mut entries: Vec<(String, fs::FileType)> = vec![];
    for e in fs::read_dir(src_skills).map_err(io_fwd)? {
        let e = e.map_err(io_fwd)?;
        entries.push((
            e.file_name().to_string_lossy().into_owned(),
            e.file_type().map_err(io_fwd)?,
        ));
    }
    entries.sort_by(|x, y| x.0.encode_utf16().cmp(y.0.encode_utf16()));
    for (name, ft) in entries {
        let src = join(&[src_skills, &name]);
        if !ft.is_dir() && !(ft.is_symlink() && is_dir_follow(&src)) {
            continue;
        }
        let dest = join(&[skills_dir, &name]);
        rm_rf(&dest)?;
        if ft.is_symlink() {
            symlink(fs::read_link(&src).map_err(io_fwd)?, &dest).map_err(io_fwd)?;
        } else {
            copy_dir(&src, &dest, true)?;
        }
        if !merged.contains(&name) {
            merged.push(name);
        }
    }
    Ok(())
}

/// `*.md` prompt files, linked (`linkOrCopy`) over any earlier one.
fn merge_prompts(
    src_prompts: &str,
    prompts_dir: &str,
    merged: &mut Vec<String>,
) -> Result<(), Fwd> {
    if !is_dir_follow(src_prompts) {
        return Ok(());
    }
    for e in fs::read_dir(src_prompts).map_err(io_fwd)? {
        let e = e.map_err(io_fwd)?;
        let name = e.file_name().to_string_lossy().into_owned();
        if !e.file_type().map_err(io_fwd)?.is_file() || !name.ends_with(".md") {
            continue;
        }
        let dest = join(&[prompts_dir, &name]);
        let _ = fs::remove_file(&dest);
        mkdirp(&dirname(&dest))?;
        hardlink_or_copy(&join(&[src_prompts, &name]), &dest)?;
        if !merged.contains(&name) {
            merged.push(name);
        }
    }
    Ok(())
}

/// One artifact's contribution, in Bun's order: skills, prompts,
/// instructions, `[codex.config]`, then its hook scripts.
fn compose_artifact(a: &Artifact, home: &str, out: &mut Composed) -> Result<(), Fwd> {
    merge_skills(
        &join(&[&a.path, "skills"]),
        &join(&[home, "skills"]),
        &mut out.skills,
    )?;
    merge_prompts(
        &join(&[&a.path, "prompts"]),
        &join(&[home, "prompts"]),
        &mut out.prompts,
    )?;
    let instructions = join(&[&a.path, "instructions.md"]);
    if exists(&instructions) {
        let content = read_text(&instructions)?;
        out.instruction_hashes.push(J::obj([
            ("spaceId", J::str(&a.space_id)),
            ("version", J::str(&a.plugin_version)),
            ("hash", J::str(sha256_hex(content.as_bytes()))),
        ]));
        out.blocks
            .push((a.space_id.clone(), a.plugin_version.clone(), content));
    }
    let config = join(&[&a.path, "codex.config.json"]);
    if exists(&config) {
        out.overrides
            .push(read_json(&config, crate::reason!("codex_config_json"))?);
    }
    let space_hooks = join(&[&a.path, "space-hooks.json"]);
    if exists(&space_hooks) {
        let hooks = read_json(&space_hooks, crate::reason!("codex_space_hooks_json"))?;
        let dest = join(&[home, "space-hooks", &a.space_id, "hooks"]);
        rm_rf(&dest)?;
        copy_dir(&join(&[&a.path, "hooks"]), &dest, true)?;
        out.hook_sets.push((a.space_id.clone(), hooks));
    }
    Ok(())
}

fn names(mut list: Vec<String>) -> J {
    js_sort(&mut list);
    J::Arr(list.into_iter().map(J::Str).collect())
}

/// manifest.json: the spaces composed and what the home merged from them.
fn manifest(artifacts: &[Artifact], target_name: &str, c: Composed, servers: &[(String, J)]) -> J {
    let spaces = artifacts
        .iter()
        .map(|a| {
            J::obj([
                ("spaceId", J::str(&a.space_id)),
                ("spaceKey", J::str(&a.space_key)),
                ("version", J::str(&a.plugin_version)),
            ])
        })
        .collect();
    J::obj([
        ("schemaVersion", J::Num(1.0)),
        ("harnessId", J::str("codex")),
        ("targetName", J::str(target_name)),
        ("generatedAt", J::str(now_iso())),
        ("spaces", J::Arr(spaces)),
        ("skills", names(c.skills)),
        ("prompts", names(c.prompts)),
        (
            "mcpServers",
            names(servers.iter().map(|(n, _)| n.clone()).collect()),
        ),
        ("instructions", J::Arr(c.instruction_hashes)),
    ])
}

/// `CodexAdapter.composeTarget(input, outputDir, { clean: true })`: writes
/// the bundle and returns the paths its manifest requires.
pub fn compose_target(
    artifacts: &[Artifact],
    output: &str,
    target_name: &str,
    codex_options: Option<&J>,
) -> Result<Vec<String>, Fwd> {
    let _ = rm_rf(output);
    mkdirp(output)?;
    let home = join(&[output, "codex.home"]);
    mkdirp(&join(&[&home, "skills"]))?;
    mkdirp(&join(&[&home, "prompts"]))?;
    let mut composed = Composed::default();
    for a in artifacts {
        compose_artifact(a, &home, &mut composed)?;
    }
    composed.overrides.extend(target_overrides(codex_options));
    write(
        &join(&[&home, "AGENTS.md"]),
        &agents_markdown(&composed.blocks),
    )?;

    let servers = mcp_servers(artifacts.iter().map(|a| a.path.as_str()))?;
    let mcp_path = join(&[&home, "mcp.json"]);
    if !servers.is_empty() {
        write_json(
            &mcp_path,
            &J::obj([("mcpServers", J::Obj(servers.clone()))]),
        )?;
    }

    let space_hooks = space_hooks_config(&composed.hook_sets)?;
    let fragment = join(&[&home, "space-hooks.json"]);
    let _ = fs::remove_file(&fragment);
    if !composed.hook_sets.is_empty() {
        write_json(&fragment, &space_hooks)?;
    }
    let hooks_path = join(&[&home, "hooks.json"]);
    let hooks_config = merge_hooks(&[&hrc_hooks_config(&["Stop"]), &space_hooks]);
    let base = codex_config(&servers, &composed.overrides)?;
    let config = add_trust_state(&base, &hooks_path, &hooks_config, &[]).unwrap_or(base);
    write(&join(&[&home, "config.toml"]), &render_config(&config)?)?;
    write_json(&hooks_path, &hooks_config)?;

    let user_auth = join(&[&crate::reads::homedir(), ".codex", "auth.json"]);
    let dest_auth = join(&[&home, "auth.json"]);
    let _ = fs::remove_file(&dest_auth);
    if exists(&user_auth) {
        let _ = symlink(&user_auth, &dest_auth);
    }

    let manifest = manifest(artifacts, target_name, composed, &servers);
    write_json(&join(&[&home, "manifest.json"]), &manifest)?;

    let mut required = vec![home];
    if !servers.is_empty() {
        required.push(mcp_path);
    }
    Ok(required)
}

/// `CodexAdapter.loadTargetBundle(outputDir, targetName)`.
pub fn load_bundle(output: &str) -> Result<Bundle, Fwd> {
    let home = join(&[output, "codex.home"]);
    let kind_ok = |p: &str, dir: bool| {
        fs::metadata(p).is_ok_and(|m| if dir { m.is_dir() } else { m.is_file() })
    };
    if !kind_ok(&home, true)
        || !kind_ok(&join(&[&home, "config.toml"]), false)
        || !kind_ok(&join(&[&home, "AGENTS.md"]), false)
    {
        return Err(fwd(crate::reason!("codex_bundle_invalid")));
    }
    Ok(Bundle {
        root_dir: output.to_owned(),
        home,
    })
}
