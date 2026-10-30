//! Bundle materialization for a mutable claude target, with Bun's write
//! rules: plugin-artifacts.ts (mutable staging), the Claude adapter's
//! `materializeSpace`/`composeTarget`/`loadTargetBundle`
//! (drivers/harness-claude/src/adapters/claude-adapter.ts), the materializer
//! helpers (link-components, plugin-json, hooks-toml, hooks-builder,
//! permissions-toml, mcp-composer, settings-composer), materialize-target.ts
//! (fingerprint, publish under the bundle-scope lock, prune) and
//! store/temp-lifecycle.ts (sweep, prompt artifact).
use super::lockfile::{self, MATERIALIZATION};
use super::util::{canonicalize, now_iso, now_ms, random_uuid, sanitize_segment, sha256_hex};
use super::{Fwd, fwd};
use crate::json::J;
use crate::reads::jspath::{basename, join, relative};
use crate::reads::toml;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

/// `DEFAULT_HARNESS`: materializeFromRefs is not given the selected harness
/// (the T-11825 defect Bun keeps until the D0 window closes), so the bundle
/// fingerprint, manifest and space support check name `agent-harness`.
pub const DEFAULT_HARNESS: &str = "agent-harness";
pub const TARGET_MATERIALIZER_VERSION: &str = "target-materializer-v7-claude-skip-bypass-consent";
const PLUGIN_COMPONENT_DIRS: [&str; 6] =
    ["commands", "skills", "agents", "hooks", "scripts", "mcp"];

pub(super) fn io_fwd(_: io::Error) -> Fwd {
    fwd("materialize_io")
}

/// `uniqueStagingDir(paths, prefix)`.
pub fn unique_staging_dir(asp_home: &str, prefix: &str) -> String {
    join(&[
        asp_home,
        "tmp",
        ".staging",
        &format!("{prefix}-{}-{}", std::process::id(), random_uuid()),
    ])
}

/// `materializationLockPath(paths, key)`.
pub fn materialization_lock_path(asp_home: &str, key: &str) -> String {
    join(&[
        asp_home,
        "tmp",
        "locks",
        &format!("{}.lock", sanitize_segment(key)),
    ])
}

// -- copying (core/atomic.ts, materializer/link-components.ts) ---------------

pub(super) fn mkdirp(path: &str) -> Result<(), Fwd> {
    fs::create_dir_all(path).map_err(io_fwd)
}

/// `fs.promises.copyFile` (contents and mode).
pub(super) fn copy_file(src: &str, dest: &str) -> Result<(), Fwd> {
    fs::copy(src, dest).map(|_| ()).map_err(io_fwd)
}

/// `linkDirectory(src, dest, { forceCopy: true, followSymlinks })`.
fn link_directory(
    src: &str,
    dest: &str,
    follow: bool,
    ancestors: &mut Vec<std::path::PathBuf>,
) -> Result<(), Fwd> {
    let pushed = if follow {
        let real = fs::canonicalize(src).map_err(io_fwd)?;
        if ancestors.contains(&real) {
            return Err(fwd("symlink_cycle"));
        }
        ancestors.push(real);
        true
    } else {
        false
    };
    mkdirp(dest)?;
    for entry in fs::read_dir(src).map_err(io_fwd)? {
        let entry = entry.map_err(io_fwd)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let (s, d) = (join(&[src, &name]), join(&[dest, &name]));
        let ft = entry.file_type().map_err(io_fwd)?;
        if ft.is_dir() {
            link_directory(&s, &d, follow, ancestors)?;
        } else if ft.is_file() {
            copy_file(&s, &d)?;
        } else if ft.is_symlink() {
            if follow {
                let meta = fs::metadata(&s).map_err(io_fwd)?;
                if meta.is_dir() {
                    link_directory(&s, &d, follow, ancestors)?;
                } else if meta.is_file() {
                    copy_file(&s, &d)?;
                }
                continue;
            }
            let target = fs::read_link(&s).map_err(io_fwd)?;
            symlink(target, &d).map_err(io_fwd)?;
        }
    }
    if pushed {
        ancestors.pop();
    }
    Ok(())
}

/// `copyDir(src, dest, { useHardlinks: true })`: hardlink files (copy on
/// EXDEV/EPERM/ENOTSUP), recreate symlinks.
fn copy_dir_hardlinked(src: &str, dest: &str) -> Result<(), Fwd> {
    copy_dir(src, dest, true)
}

/// `rm(path, { recursive: true, force: true })`: a missing path is fine.
pub(super) fn rm_rf(path: &str) -> Result<(), Fwd> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path).map_err(io_fwd),
        Ok(_) => fs::remove_file(path).map_err(io_fwd),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_fwd(e)),
    }
}

/// `copyDir(src, dest, { useHardlinks })`: files hardlinked (copy on
/// EXDEV/EPERM/ENOTSUP) or copied, symlinks recreated.
pub(super) fn copy_dir(src: &str, dest: &str, hardlinks: bool) -> Result<(), Fwd> {
    mkdirp(dest)?;
    for entry in fs::read_dir(src).map_err(io_fwd)? {
        let entry = entry.map_err(io_fwd)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let (s, d) = (join(&[src, &name]), join(&[dest, &name]));
        let ft = entry.file_type().map_err(io_fwd)?;
        if ft.is_dir() {
            copy_dir(&s, &d, hardlinks)?;
        } else if ft.is_file() && !hardlinks {
            copy_file(&s, &d)?;
        } else if ft.is_file() {
            match fs::hard_link(&s, &d) {
                Ok(()) => {}
                Err(e)
                    if matches!(
                        e.raw_os_error(),
                        Some(libc::EXDEV | libc::EPERM | libc::ENOTSUP)
                    ) =>
                {
                    copy_file(&s, &d)?;
                }
                Err(e) => return Err(io_fwd(e)),
            }
        } else if ft.is_symlink() {
            let target = fs::read_link(&s).map_err(io_fwd)?;
            symlink(target, &d).map_err(io_fwd)?;
        }
    }
    Ok(())
}

pub(super) fn is_dir_follow(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_dir())
}

fn is_file_follow(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file())
}

pub(super) fn write(path: &str, content: &str) -> Result<(), Fwd> {
    fs::write(path, content).map_err(io_fwd)
}

// -- the inputs -------------------------------------------------------------

/// One locked space entry to stage.
pub struct SpaceInput {
    pub key: String,
    pub id: String,
    pub plugin_name: String,
    pub plugin_version: String,
    /// The space's content directory (`resolveSpaceContentDir`).
    pub content_dir: String,
}

/// What `materializeSpaceEntry` returns.
pub struct Artifact {
    pub space_key: String,
    pub space_id: String,
    pub path: String,
    pub plugin_name: String,
    pub plugin_version: String,
    pub settings: J,
}

/// The pre-write view of one space: its manifest as plugin-artifacts builds
/// it, and the TOML files staging will read, already judged.
pub struct SpacePlan {
    pub input: SpaceInput,
    /// `manifest`, the parsed space.toml merged with the lock's plugin identity.
    pub manifest: J,
    pub hooks: Option<Vec<J>>,
    pub permissions: Option<J>,
}

/// Judge everything staging a space reads, before anything is written.
pub fn plan_space(input: SpaceInput, lock_plugin: &J) -> Result<SpacePlan, Fwd> {
    let toml_path = join(&[&input.content_dir, "space.toml"]);
    // readSpaceToml failures fall back to the lock's plugin identity.
    let parsed = super::spaces::read_manifest(&toml_path).ok();
    let mut plugin = match parsed.as_ref().and_then(|p| p.get("plugin")) {
        Some(J::Obj(fields)) => J::Obj(fields.clone()),
        _ if parsed.is_none() => lock_plugin.clone(),
        _ => J::Obj(vec![]),
    };
    plugin.set("name", J::str(&input.plugin_name));
    plugin.set("version", J::str(&input.plugin_version));
    let mut manifest = parsed.unwrap_or_else(|| J::Obj(vec![]));
    manifest.set("schema", J::Num(1.0));
    manifest.set("id", J::str(&input.id));
    manifest.set("plugin", plugin);
    if let Some(supports) = manifest.get("harness").and_then(|h| h.get("supports"))
        && !supports
            .as_arr()
            .is_some_and(|s| s.iter().any(|h| h.as_str() == Some(DEFAULT_HARNESS)))
    {
        // harness-skip: no live space takes this branch.
        return Err(fwd("space_harness_skip"));
    }
    // Staging copies hooks/ and reads hooks/hooks.toml from the copy.
    let hooks_toml = join(&[&input.content_dir, "hooks", "hooks.toml"]);
    let hooks =
        if is_dir_follow(&join(&[&input.content_dir, "hooks"])) && is_file_follow(&hooks_toml) {
            Some(parse_hooks_toml(&hooks_toml)?)
        } else {
            None
        };
    let permissions_path = join(&[&input.content_dir, "permissions.toml"]);
    let permissions = if is_file_follow(&permissions_path) {
        Some(parse_permissions_toml(&permissions_path)?)
    } else {
        None
    };
    Ok(SpacePlan {
        input,
        manifest,
        hooks,
        permissions,
    })
}

fn parse_toml_file(path: &str) -> Result<J, Fwd> {
    let content = fs::read_to_string(path).map_err(|_| fwd("toml_unreadable"))?;
    match toml::parse(&content) {
        Ok(v) => Ok(v),
        Err(toml::TomlError::Unsupported(reason)) => Err(fwd(reason)),
        Err(_) => Err(fwd("toml_syntax")),
    }
}

/// `parseHooksToml(content).hook`.
fn parse_hooks_toml(path: &str) -> Result<Vec<J>, Fwd> {
    let parsed = parse_toml_file(path)?;
    let Some(J::Arr(hooks)) = parsed.get("hook") else {
        return Ok(vec![]);
    };
    hooks
        .iter()
        .map(|h| {
            // String(hook.event ?? ''): only strings are judged here.
            let string_field = |k: &str| match h.get(k) {
                None => Ok(J::str("")),
                Some(J::Str(s)) => Ok(J::str(s)),
                Some(_) => Err(fwd("hooks_toml_shape")),
            };
            let mut out = J::obj([
                ("event", string_field("event")?),
                ("script", string_field("script")?),
            ]);
            if let Some(J::Arr(tools)) = h.get("tools") {
                if !tools.iter().all(|t| matches!(t, J::Str(_))) {
                    return Err(fwd("hooks_toml_shape"));
                }
                out.set("tools", J::Arr(tools.clone()));
            }
            for key in ["matcher", "harness"] {
                if let Some(J::Str(s)) = h.get(key) {
                    out.set(key, J::str(s));
                }
            }
            Ok(out)
        })
        .collect()
}

/// `parsePermissionsToml`, with every array element a string (`.trim()` on
/// anything else throws in Bun).
fn parse_permissions_toml(path: &str) -> Result<J, Fwd> {
    let parsed = parse_toml_file(path)?;
    let table = |k: &str| match parsed.get(k) {
        Some(v @ J::Obj(_)) => Some(v),
        _ => None,
    };
    let strings = |t: Option<&J>, k: &str| -> Result<Option<Vec<String>>, Fwd> {
        match t.and_then(|t| t.get(k)) {
            Some(J::Arr(items)) => items
                .iter()
                .map(|i| {
                    i.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| fwd("permissions_toml_shape"))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Some),
            _ => Ok(None),
        }
    };
    let mut out = vec![];
    let arr = |v: Option<Vec<String>>| v.map(|v| J::Arr(v.into_iter().map(J::Str).collect()));
    let put = |out: &mut Vec<(String, J)>, k: &str, fields: Vec<(&str, Option<J>)>| {
        out.push((
            k.to_owned(),
            J::Obj(
                fields
                    .into_iter()
                    .filter_map(|(k, v)| v.map(|v| (k.to_owned(), v)))
                    .collect(),
            ),
        ));
    };
    if let Some(t) = table("read") {
        put(
            &mut out,
            "read",
            vec![("paths", arr(strings(Some(t), "paths")?))],
        );
    }
    if let Some(t) = table("write") {
        put(
            &mut out,
            "write",
            vec![("paths", arr(strings(Some(t), "paths")?))],
        );
    }
    if let Some(t) = table("exec") {
        put(
            &mut out,
            "exec",
            vec![
                ("commands", arr(strings(Some(t), "commands")?)),
                ("patterns", arr(strings(Some(t), "patterns")?)),
            ],
        );
    }
    if let Some(t) = table("network") {
        put(
            &mut out,
            "network",
            vec![("hosts", arr(strings(Some(t), "hosts")?))],
        );
    }
    if let Some(t) = table("deny") {
        put(
            &mut out,
            "deny",
            vec![
                ("read", arr(strings(Some(t), "read")?)),
                ("write", arr(strings(Some(t), "write")?)),
                ("exec", arr(strings(Some(t), "exec")?)),
                ("network", arr(strings(Some(t), "network")?)),
            ],
        );
    }
    Ok(J::Obj(out))
}

fn str_list(v: Option<&J>) -> Vec<String> {
    v.and_then(J::as_arr)
        .map(|a| a.iter().filter_map(J::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// `toClaudeSettingsPermissions(toClaudePermissions(permissions))`.
fn claude_settings_permissions(p: &J) -> (Vec<String>, Vec<String>) {
    let trimmed = |v: Vec<String>| -> Vec<String> {
        v.iter()
            .map(|s| super::util::js_trim(s).to_owned())
            .filter(|s| !s.is_empty())
            .collect()
    };
    let mut allow = vec![];
    let read = str_list(p.get("read").and_then(|r| r.get("paths")));
    if !read.is_empty() && !trimmed(read).is_empty() {
        allow.push("Read".to_owned());
    }
    let write = str_list(p.get("write").and_then(|r| r.get("paths")));
    if !write.is_empty() && !trimmed(write).is_empty() {
        allow.push("Write".to_owned());
    }
    let exec = p.get("exec");
    for cmd in str_list(exec.and_then(|e| e.get("commands"))) {
        let t = super::util::js_trim(&cmd);
        if !t.is_empty() {
            allow.push(format!("Bash({t} *)"));
        }
    }
    for pat in str_list(exec.and_then(|e| e.get("patterns"))) {
        let t = super::util::js_trim(&pat);
        if !t.is_empty() {
            allow.push(format!("Bash({t})"));
        }
    }
    let mut deny = vec![];
    if let Some(d) = p.get("deny") {
        let dr = str_list(d.get("read"));
        if !dr.is_empty() {
            deny.extend(trimmed(dr).into_iter().map(|p| format!("Read({p})")));
        }
        let dw = str_list(d.get("write"));
        if !dw.is_empty() {
            deny.extend(trimmed(dw).into_iter().map(|p| format!("Write({p})")));
        }
        let de = str_list(d.get("exec"));
        if !de.is_empty() {
            deny.extend(
                de.iter()
                    .map(|c| format!("Bash({})", super::util::js_trim(c))),
            );
        }
    }
    (allow, deny)
}

// -- staging ------------------------------------------------------------------

/// `generatePluginJson(manifest)`.
fn plugin_json(manifest: &J) -> J {
    let (name, version) = super::spaces::plugin_identity(manifest);
    let plugin = manifest.get("plugin");
    let mut out = J::obj([("name", J::str(name))]);
    if let Some(v) = version {
        out.set("version", J::str(v));
    }
    let desc = plugin
        .and_then(|p| p.get("description"))
        .or_else(|| manifest.get("description"));
    if let Some(d) = desc {
        out.set("description", d.clone());
    }
    for key in ["homepage", "repository", "license"] {
        if let Some(v) = plugin.and_then(|p| p.get(key)) {
            out.set(key, v.clone());
        }
    }
    if let Some(J::Arr(k)) = plugin.and_then(|p| p.get("keywords"))
        && !k.is_empty()
    {
        out.set("keywords", J::Arr(k.clone()));
    }
    out
}

/// ClaudeAdapter.materializeSpace(input, cacheDir, { force: false, useHardlinks: false }).
fn materialize_space(plan: &SpacePlan, dir: &str) -> Result<(), Fwd> {
    let result = (|| {
        let src = &plan.input.content_dir;
        mkdirp(dir)?;
        mkdirp(&join(&[dir, ".claude-plugin"]))?;
        write(
            &join(&[dir, ".claude-plugin", "plugin.json"]),
            &format!("{}\n", plugin_json(&plan.manifest).to_json_pretty()),
        )?;
        for component in PLUGIN_COMPONENT_DIRS {
            let s = join(&[src, component]);
            if is_dir_follow(&s) {
                link_directory(&s, &join(&[dir, component]), false, &mut vec![])?;
            }
        }
        // AGENT.md, else CLAUDE.md, becomes CLAUDE.md (access(): follows links).
        for name in ["AGENT.md", "CLAUDE.md"] {
            let s = join(&[src, name]);
            if fs::metadata(&s).is_ok() {
                copy_file(&s, &join(&[dir, "CLAUDE.md"]))?;
                break;
            }
        }
        if plan.permissions.is_some() {
            copy_file(
                &join(&[src, "permissions.toml"]),
                &join(&[dir, "permissions.toml"]),
            )?;
        }
        if let Some(hooks) = &plan.hooks
            && !hooks.is_empty()
        {
            write(
                &join(&[dir, "hooks", "hooks.json"]),
                &format!("{}\n", claude_hooks_config(hooks).to_json_pretty()),
            )?;
        }
        ensure_hooks_executable(dir);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(dir);
    }
    result
}

const CLAUDE_EVENTS: [(&str, &str); 12] = [
    ("pre_tool_use", "PreToolUse"),
    ("post_tool_use", "PostToolUse"),
    ("post_tool_use_failure", "PostToolUseFailure"),
    ("permission_request", "PermissionRequest"),
    ("notification", "Notification"),
    ("user_prompt_submit", "UserPromptSubmit"),
    ("stop", "Stop"),
    ("subagent_start", "SubagentStart"),
    ("subagent_stop", "SubagentStop"),
    ("pre_compact", "PreCompact"),
    ("session_start", "SessionStart"),
    ("session_end", "SessionEnd"),
];

/// `toClaudeHooksConfig(hooks)`.
fn claude_hooks_config(hooks: &[J]) -> J {
    fn normalize(h: &str) -> &str {
        match h {
            "claude-agent-sdk" => "claude",
            "pi-sdk" => "pi",
            other => other,
        }
    }
    // event -> [(matcher, hooks)] in first-seen order.
    type Groups<'a> = Vec<(Option<String>, Vec<&'a J>)>;
    let mut by_event: Vec<(String, Groups)> = vec![];
    for hook in hooks {
        if let Some(h) = hook.get("harness").and_then(J::as_str)
            && !h.is_empty()
            && normalize(h) != "claude"
        {
            continue;
        }
        let event = hook.get("event").and_then(J::as_str).unwrap_or_default();
        let Some((_, claude_event)) = CLAUDE_EVENTS.iter().find(|(a, _)| *a == event) else {
            continue;
        };
        let matcher = if matches!(*claude_event, "PreToolUse" | "PostToolUse") {
            let tools = str_list(hook.get("tools"));
            Some(if tools.is_empty() || tools.iter().any(|t| t == "*") {
                "*".to_owned()
            } else {
                tools.join("|")
            })
        } else {
            hook.get("matcher").and_then(J::as_str).map(str::to_owned)
        };
        let slot = match by_event.iter().position(|(e, _)| e == claude_event) {
            Some(i) => i,
            None => {
                by_event.push(((*claude_event).to_owned(), vec![]));
                by_event.len() - 1
            }
        };
        let groups = &mut by_event[slot].1;
        match groups.iter_mut().find(|(m, _)| *m == matcher) {
            Some((_, list)) => list.push(hook),
            None => groups.push((matcher, vec![hook])),
        }
    }
    let events = by_event
        .into_iter()
        .map(|(event, groups)| {
            let entries = groups
                .into_iter()
                .map(|(matcher, list)| {
                    let commands = list
                        .iter()
                        .map(|h| {
                            J::obj([
                                ("type", J::str("command")),
                                (
                                    "command",
                                    J::str(format!(
                                        "${{CLAUDE_PLUGIN_ROOT}}/{}",
                                        h.get("script").and_then(J::as_str).unwrap_or_default()
                                    )),
                                ),
                            ])
                        })
                        .collect();
                    let mut entry = J::obj([("hooks", J::Arr(commands))]);
                    if let Some(m) = matcher.filter(|m| !m.is_empty()) {
                        entry.set("matcher", J::str(m));
                    }
                    entry
                })
                .collect();
            (event, J::Arr(entries))
        })
        .collect();
    J::obj([("hooks", J::Obj(events))])
}

/// `ensureHooksExecutable(dir)`: only the legacy array form of hooks.json.
fn ensure_hooks_executable(dir: &str) {
    let path = join(&[dir, "hooks", "hooks.json"]);
    let Ok(text) = fs::read(&path) else { return };
    let Some(config) = crate::json::parse(&text) else {
        return;
    };
    let Some(J::Arr(hooks)) = config.get("hooks") else {
        return;
    };
    let native = hooks
        .first()
        .is_some_and(|h| matches!(h.get("hooks"), Some(J::Arr(_))));
    let mut scripts = vec![];
    for h in hooks {
        if native {
            for cmd in h.get("hooks").and_then(J::as_arr).into_iter().flatten() {
                if let Some(c) = cmd
                    .get("command")
                    .and_then(J::as_str)
                    .filter(|c| !c.is_empty())
                {
                    let c = c.strip_prefix("${CLAUDE_PLUGIN_ROOT}/").unwrap_or(c);
                    scripts.push(c.strip_prefix("hooks/").unwrap_or(c).to_owned());
                }
            }
        } else if let Some(s) = h.get("script").and_then(J::as_str) {
            scripts.push(s.to_owned());
        }
    }
    for script in scripts.iter().filter(|s| !s.is_empty()) {
        let p = join(&[dir, "hooks", script]);
        let executable = std::ffi::CString::new(p.clone())
            .map(|c| unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0)
            .unwrap_or(false);
        if !executable && let Ok(meta) = fs::metadata(&p) {
            let _ = fs::set_permissions(
                &p,
                fs::Permissions::from_mode(meta.permissions().mode() | 0o111),
            );
        }
    }
}

/// `materializeSpaceEntry` for a mutable space: stage it under tmp/.staging.
pub fn stage_space(plan: &SpacePlan, asp_home: &str, codex: bool) -> Result<Artifact, Fwd> {
    let dir = unique_staging_dir(
        asp_home,
        &format!("space-{}", sanitize_segment(&plan.input.key)),
    );
    if codex {
        super::codex::materialize_space(plan, &dir)?;
    } else {
        materialize_space(plan, &dir)?;
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
    write(
        &join(&[&dir, ".claude-plugin", "plugin.json"]),
        &plugin.to_json_pretty(),
    )?;
    if local.has_skills {
        link_directory(
            &join(&[&local.agent_root, "skills"]),
            &join(&[&dir, "skills"]),
            false,
            &mut vec![],
        )?;
    }
    if local.has_commands {
        link_directory(
            &join(&[&local.agent_root, "commands"]),
            &join(&[&dir, "commands"]),
            true,
            &mut vec![],
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

/// `hashDirectory(root, { excludeRelativePaths: {'.asp-cache.json'} })`.
pub fn hash_directory(root: &str) -> Result<String, Fwd> {
    let mut entries = vec![];
    hash_visit(root, "", &mut entries)?;
    Ok(sha256_hex(entries.join("\n").as_bytes()))
}

fn hash_visit(dir: &str, prefix: &str, out: &mut Vec<String>) -> Result<(), Fwd> {
    let mut names: Vec<(String, fs::FileType)> = fs::read_dir(dir)
        .map_err(io_fwd)?
        .map(|e| {
            let e = e.map_err(io_fwd)?;
            Ok((
                e.file_name().to_string_lossy().into_owned(),
                e.file_type().map_err(io_fwd)?,
            ))
        })
        .collect::<Result<_, Fwd>>()?;
    names.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    for (name, ft) in names {
        let full = join(&[dir, &name]);
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if rel == ".asp-cache.json" {
            continue;
        }
        let mode = fs::symlink_metadata(&full).map_err(io_fwd)?.mode();
        if ft.is_dir() {
            out.push(format!("dir {rel} {mode}"));
            hash_visit(&full, &rel, out)?;
        } else if ft.is_symlink() {
            let target = fs::read_link(&full).map_err(io_fwd)?;
            out.push(format!("symlink {rel} {mode} {}", target.to_string_lossy()));
        } else if ft.is_file() {
            let content = fs::read(&full).map_err(io_fwd)?;
            out.push(format!("file {rel} {mode} {}", sha256_hex(&content)));
        }
    }
    Ok(())
}

// -- the target bundle ----------------------------------------------------------

pub struct TargetInput<'a> {
    pub target_name: &'a str,
    pub identity: &'a J,
    pub lock_target: &'a J,
    pub codex_options: Option<&'a J>,
    pub public_scope_root: String,
    /// The release's Claude statusline asset (`claude-statusline`); a claude
    /// bundle only.
    pub statusline: Option<&'a Statusline>,
}

pub struct Statusline {
    pub path: String,
    pub sha256: String,
}

pub struct Bundle {
    pub root_dir: String,
    pub plugin_dirs: Vec<String>,
    pub mcp_config_path: Option<String>,
    pub settings_path: String,
}

/// `computeTargetFingerprint`.
pub fn fingerprint(input: &TargetInput, artifacts: &[Artifact], hashes: &[String]) -> String {
    let arr = |k: &str| input.lock_target.get(k).cloned().unwrap_or(J::Arr(vec![]));
    let mut material = J::obj([
        ("schemaVersion", J::str(TARGET_MATERIALIZER_VERSION)),
        ("harnessId", J::str(DEFAULT_HARNESS)),
        ("targetName", J::str(input.target_name)),
        ("identity", input.identity.clone()),
        ("compose", arr("compose")),
        ("roots", arr("roots")),
        ("loadOrder", arr("loadOrder")),
        (
            "artifacts",
            J::Arr(
                artifacts
                    .iter()
                    .zip(hashes)
                    .map(|(a, h)| {
                        J::obj([
                            ("spaceKey", J::str(&a.space_key)),
                            ("spaceId", J::str(&a.space_id)),
                            ("pluginName", J::str(&a.plugin_name)),
                            ("pluginVersion", J::str(&a.plugin_version)),
                            ("contentHash", J::str(h)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "settingsInputs",
            J::Arr(artifacts.iter().map(|a| a.settings.clone()).collect()),
        ),
    ]);
    if let Some(codex) = input.codex_options {
        material.set("codexOptions", codex.clone());
    }
    sha256_hex(canonicalize(&material, false).as_bytes())
}

/// `validateMaterializedTarget(outputPath, fingerprint)`.
pub fn validate_target(output: &str, fingerprint: &str) -> bool {
    let Ok(text) = fs::read(join(&[output, ".asp-materialized.json"])) else {
        return false;
    };
    let Some(manifest) = crate::json::parse(&text) else {
        return false;
    };
    if manifest.get("fingerprint").and_then(J::as_str) != Some(fingerprint)
        || manifest.get("complete") != Some(&J::Bool(true))
    {
        return false;
    }
    manifest
        .get("requiredPaths")
        .and_then(J::as_arr)
        .into_iter()
        .flatten()
        .all(|p| {
            p.as_str()
                .is_some_and(|p| fs::metadata(join(&[output, p])).is_ok())
        })
}

/// ClaudeAdapter.composeTarget(input, outputDir, { clean: true, publishedOutputPath }).
fn compose_target(
    artifacts: &[Artifact],
    permissions: &[Option<J>],
    output: &str,
    published: &str,
    statusline: &Statusline,
) -> Result<Bundle, Fwd> {
    let _ = fs::remove_dir_all(output);
    let plugins = join(&[output, "plugins"]);
    mkdirp(&plugins)?;
    let mut plugin_dirs = vec![];
    for (i, a) in artifacts.iter().enumerate() {
        let dest = join(&[&plugins, &format!("{i:03}-{}", a.space_id)]);
        copy_dir_hardlinked(&a.path, &dest)?;
        plugin_dirs.push(dest);
    }
    // MCP: later servers override earlier ones of the same name.
    let mut servers: Vec<(String, J)> = vec![];
    for dir in &plugin_dirs {
        let path = join(&[dir, "mcp", "mcp.json"]);
        if !fs::metadata(&path).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let Some(config) = fs::read(&path).ok().and_then(|t| crate::json::parse(&t)) else {
            continue;
        };
        // Object.entries(config.mcpServers) throws on a missing table.
        let Some(J::Obj(entries)) = config.get("mcpServers") else {
            return Err(fwd("mcp_config_shape"));
        };
        for (name, server) in entries {
            match servers.iter_mut().find(|(n, _)| n == name) {
                Some(slot) => slot.1 = server.clone(),
                None => servers.push((name.clone(), server.clone())),
            }
        }
    }
    let mcp_path = join(&[output, "mcp.json"]);
    let mcp_config_path = if servers.is_empty() {
        None
    } else {
        write(
            &mcp_path,
            &format!(
                "{}\n",
                J::obj([("mcpServers", J::Obj(servers))]).to_json_pretty()
            ),
        )?;
        Some(mcp_path)
    };
    // Settings: each space's manifest settings plus its permissions.toml.
    let mut composed = J::Obj(vec![]);
    for (artifact, perms) in artifacts.iter().zip(permissions) {
        let mut merged = artifact.settings.clone();
        if let Some(p) = perms {
            let (allow, deny) = claude_settings_permissions(p);
            if !allow.is_empty() || !deny.is_empty() {
                let mut permissions = merged.get("permissions").cloned().unwrap_or(J::Obj(vec![]));
                for (key, rules) in [("allow", allow), ("deny", deny)] {
                    if !rules.is_empty() {
                        let mut list = permissions
                            .get(key)
                            .and_then(J::as_arr)
                            .cloned()
                            .unwrap_or_default();
                        list.extend(rules.into_iter().map(J::Str));
                        permissions.set(key, J::Arr(list));
                    }
                }
                merged.set("permissions", permissions);
            }
        }
        compose_settings_into(&mut composed, &merged);
    }
    let settings_path = join(&[output, "settings.json"]);
    composed.set("askUserQuestionTimeout", J::str("60s"));
    composed.set("tui", J::str("fullscreen"));
    composed.set("idleCompaction", J::Bool(false));
    composed.set("skipDangerousModePermissionPrompt", J::Bool(true));
    let source = fs::read(&statusline.path).map_err(|_| fwd("statusline_asset"))?;
    if sha256_hex(&source) != statusline.sha256 {
        return Err(fwd("statusline_digest"));
    }
    let script = join(&[output, "statusline.sh"]);
    fs::write(&script, &source).map_err(io_fwd)?;
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).map_err(io_fwd)?;
    composed.set(
        "statusLine",
        J::obj([
            ("type", J::str("command")),
            (
                "command",
                J::str(format!("bash {}", join(&[published, "statusline.sh"]))),
            ),
        ]),
    );
    write(&settings_path, &composed.to_json_pretty())?;
    Ok(Bundle {
        root_dir: output.to_owned(),
        plugin_dirs,
        mcp_config_path,
        settings_path,
    })
}

/// One space's settings into `composeSettings`' accumulator.
fn compose_settings_into(composed: &mut J, settings: &J) {
    if !matches!(settings, J::Obj(f) if !f.is_empty()) {
        return;
    }
    if let Some(p) = settings.get("permissions").filter(|p| super::truthy(p)) {
        let mut permissions = composed
            .get("permissions")
            .cloned()
            .unwrap_or(J::Obj(vec![]));
        for key in ["allow", "deny"] {
            if let Some(J::Arr(rules)) = p.get(key)
                && !rules.is_empty()
            {
                let mut list = permissions
                    .get(key)
                    .and_then(J::as_arr)
                    .cloned()
                    .unwrap_or_default();
                list.extend(rules.iter().cloned());
                permissions.set(key, J::Arr(list));
            }
        }
        composed.set("permissions", permissions);
    }
    if let Some(J::Obj(env)) = settings.get("env")
        && !env.is_empty()
    {
        let mut merged = composed.get("env").cloned().unwrap_or(J::Obj(vec![]));
        for (k, v) in env {
            merged.set(k, v.clone());
        }
        composed.set("env", merged);
    }
    if let Some(m) = settings.get("model").filter(|m| super::truthy(m)) {
        composed.set("model", m.clone());
    }
    if let Some(d) = settings.get("cleanupPeriodDays") {
        composed.set("cleanupPeriodDays", d.clone());
    }
}

/// ClaudeAdapter.loadTargetBundle(outputDir, targetName).
pub fn load_bundle(output: &str) -> Result<Bundle, Fwd> {
    let plugins = join(&[output, "plugins"]);
    let mut plugin_dirs = vec![];
    for entry in fs::read_dir(&plugins).map_err(io_fwd)? {
        let entry = entry.map_err(io_fwd)?;
        let ft = entry.file_type().map_err(io_fwd)?;
        if ft.is_dir() || ft.is_symlink() {
            plugin_dirs.push(join(&[&plugins, &entry.file_name().to_string_lossy()]));
        }
    }
    plugin_dirs.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let mcp = join(&[output, "mcp.json"]);
    let mcp_config_path = fs::metadata(&mcp).ok().filter(|m| m.len() > 2).map(|_| mcp);
    Ok(Bundle {
        root_dir: output.to_owned(),
        plugin_dirs,
        mcp_config_path,
        settings_path: join(&[output, "settings.json"]),
    })
}

/// Publish a claude target bundle.
pub fn publish_claude_target(
    input: &TargetInput,
    artifacts: &[Artifact],
    permissions: &[Option<J>],
    fingerprint: &str,
    asp_home: &str,
) -> Result<Bundle, Fwd> {
    let statusline = input.statusline.ok_or_else(|| fwd("release_statusline_missing"))?;
    let output = publish_target(
        input,
        artifacts,
        fingerprint,
        asp_home,
        "claude",
        |staging_output, output| {
            let bundle = compose_target(artifacts, permissions, staging_output, output, statusline)?;
            let mut required = vec![bundle.settings_path.clone()];
            required.extend(bundle.mcp_config_path.clone());
            required.extend(bundle.plugin_dirs.iter().cloned());
            Ok(required)
        },
    )?;
    load_bundle(&output)
}

/// Publish the target bundle (`materializeTarget` from the fingerprint on):
/// `compose(stagingOutput, publishedOutput)` composes the adapter's bundle
/// and returns the paths its manifest requires. Returns the published output.
pub fn publish_target(
    input: &TargetInput,
    artifacts: &[Artifact],
    fingerprint: &str,
    asp_home: &str,
    harness_dir: &str,
    compose: impl Fn(&str, &str) -> Result<Vec<String>, Fwd>,
) -> Result<String, Fwd> {
    let versions = join(&[&input.public_scope_root, "bundles", ".versions"]);
    let version_root = join(&[&versions, fingerprint]);
    let output = join(&[&version_root, input.target_name, harness_dir]);
    let scope_key = format!(
        "bundle-scope-{}",
        &sha256_hex(join(&[&input.public_scope_root, "bundles"]).as_bytes())[..32]
    );
    let lock_path = materialization_lock_path(asp_home, &scope_key);
    let published = lockfile::with_lock(&lock_path, &MATERIALIZATION, || -> Result<(), Fwd> {
        if !validate_target(&output, fingerprint) {
            let staging_root = unique_staging_dir(
                asp_home,
                &format!(
                    "bundle-{}-{}",
                    sanitize_segment(input.target_name),
                    &fingerprint[..16]
                ),
            );
            let staging_output = join(&[&staging_root, input.target_name, harness_dir]);
            let _ = fs::remove_dir_all(&staging_root);
            let result = (|| {
                let mut required: Vec<String> = compose(&staging_output, &output)?
                    .iter()
                    .map(|p| relative(&staging_output, p))
                    .collect();
                required.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                required.dedup();
                let mut manifest = J::obj([
                    ("schemaVersion", J::Num(1.0)),
                    ("complete", J::Bool(true)),
                    ("materializerVersion", J::str(TARGET_MATERIALIZER_VERSION)),
                    ("fingerprint", J::str(fingerprint)),
                    ("harnessId", J::str(DEFAULT_HARNESS)),
                    ("targetName", J::str(input.target_name)),
                ]);
                manifest.set("identity", input.identity.clone());
                manifest.set("generatedAt", J::str(now_iso()));
                manifest.set(
                    "requiredPaths",
                    J::Arr(required.into_iter().map(J::Str).collect()),
                );
                write(
                    &join(&[&staging_output, ".asp-materialized.json"]),
                    &format!("{}\n", manifest.to_json_pretty()),
                )?;
                mkdirp(&versions)?;
                if !validate_target(&output, fingerprint) {
                    let _ = fs::remove_dir_all(&version_root);
                }
                match fs::rename(&staging_root, &version_root) {
                    Ok(()) => Ok(()),
                    Err(e) => {
                        let _ = fs::remove_dir_all(&staging_root);
                        // Content-addressed: losing the rename to a valid peer is success.
                        if matches!(e.raw_os_error(), Some(libc::EEXIST | libc::ENOTEMPTY))
                            && validate_target(&output, fingerprint)
                        {
                            Ok(())
                        } else {
                            Err(io_fwd(e))
                        }
                    }
                }
            })();
            if result.is_err() {
                let _ = fs::remove_dir_all(&staging_root);
            }
            result?;
        }
        prune_bundle_versions(&versions, fingerprint, &join(&[asp_home, "tmp"]));
        Ok(())
    })
    .map_err(|_| fwd("bundle_scope_lock"))?;
    published?;
    if !validate_target(&output, fingerprint) {
        return Err(fwd("bundle_invalid_after_publish"));
    }
    let staging = join(&[asp_home, "tmp", ".staging"]);
    for a in artifacts.iter().filter(|a| a.path.starts_with(&staging)) {
        let _ = fs::remove_dir_all(&a.path);
    }
    Ok(output)
}

fn is_fingerprint(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit())
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.mtime() as f64 * 1000.0 + (meta.mtime_nsec() as f64 / 1_000_000.0)
}

/// `pruneBundleVersions({ versionsRoot, currentFingerprints: [fp], referenceRoots: [tmp] })`.
fn prune_bundle_versions(versions_root: &str, current: &str, reference_root: &str) {
    let Ok(read) = fs::read_dir(versions_root) else {
        return;
    };
    let mut versions: Vec<(String, String, f64)> = vec![];
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type().is_ok_and(|t| t.is_dir()) || !is_fingerprint(&name) {
            continue;
        }
        let path = join(&[versions_root, &name]);
        if let Ok(meta) = fs::symlink_metadata(&path)
            && meta.is_dir()
        {
            versions.push((name.to_lowercase(), path, mtime_ms(&meta)));
        }
    }
    if versions.is_empty() {
        return;
    }
    let current = current.to_lowercase();
    versions.sort_by(|a, b| {
        b.2.partial_cmp(&a.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.cmp(&a.0))
    });
    let mut recent: Vec<String> = vec![];
    for (hash, _, _) in &versions {
        if *hash == current {
            continue;
        }
        if recent.len() >= 3 {
            break;
        }
        recent.push(hash.clone());
    }
    let candidates: Vec<String> = versions
        .iter()
        .map(|v| v.0.clone())
        .filter(|h| *h != current && !recent.contains(h))
        .collect();
    if candidates.is_empty() {
        return;
    }
    let mut referenced: Vec<String> = vec![];
    scan_references(reference_root, versions_root, &candidates, &mut referenced);
    let now = now_ms();
    for (hash, path, mtime) in &versions {
        if *hash == current || recent.contains(hash) || referenced.contains(hash) {
            continue;
        }
        if now - mtime < 15.0 * 60.0 * 1000.0 {
            continue;
        }
        let _ = fs::remove_dir_all(path);
    }
}

fn reference_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    [
        "json", "jsonl", "ndjson", "toml", "yaml", "yml", "md", "txt", "log",
    ]
    .iter()
    .any(|ext| lower.ends_with(&format!(".{ext}")))
}

fn scan_references(path: &str, versions_root: &str, candidates: &[String], out: &mut Vec<String>) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    let rel = relative(versions_root, path);
    if rel.is_empty() || (!rel.starts_with("..") && !rel.contains("../")) {
        return;
    }
    if meta.is_dir() {
        if let Ok(read) = fs::read_dir(path) {
            for entry in read.flatten() {
                scan_references(
                    &join(&[path, &entry.file_name().to_string_lossy()]),
                    versions_root,
                    candidates,
                    out,
                );
            }
        }
        return;
    }
    if !meta.is_file() || meta.len() > 10 * 1024 * 1024 || !reference_file(&basename(path)) {
        return;
    }
    let Ok(bytes) = fs::read(path) else { return };
    let text = String::from_utf8_lossy(&bytes);
    let marker = format!("{versions_root}/");
    for hash in candidates {
        if out.contains(hash) {
            continue;
        }
        if text.contains(&format!("{marker}{hash}/")) || text.contains(&format!("{marker}{hash}\""))
        {
            out.push(hash.clone());
            continue;
        }
        // /(?:^|[/\\])\.versions[/\\]([a-f0-9]{64})(?:[/\\]|"|'|$)/gi
        let lower = text.to_lowercase();
        for (at, _) in lower.match_indices(".versions") {
            let before_ok = at == 0 || matches!(lower.as_bytes()[at - 1], b'/' | b'\\');
            let rest = &lower[at + ".versions".len()..];
            let Some(sep) = rest.chars().next() else {
                continue;
            };
            if !before_ok || !matches!(sep, '/' | '\\') || rest.len() < 65 {
                continue;
            }
            let found = &rest[1..65];
            let after = rest[65..].chars().next();
            if found == hash.as_str() && after.is_none_or(|c| matches!(c, '/' | '\\' | '"' | '\''))
            {
                out.push(hash.clone());
                break;
            }
        }
    }
}

/// `sweepAspTempArtifacts({ aspHome })`.
pub fn sweep_temp(asp_home: &str) {
    let now = now_ms();
    sweep_children(
        &join(&[asp_home, "tmp", "launch-overlays"]),
        now,
        15.0 * 60.0 * 1000.0,
        false,
    );
    sweep_children(
        &join(&[asp_home, "tmp", ".staging"]),
        now,
        60.0 * 60.0 * 1000.0,
        true,
    );
}

fn staging_pid(name: &str) -> Option<i32> {
    // /-(\d+)-<uuid>$/i
    if name.len() < 38 {
        return None;
    }
    let (head, uuid) = name.split_at(name.len() - 36);
    let uuid_ok = uuid.char_indices().all(|(i, c)| {
        if matches!(i, 8 | 13 | 18 | 23) {
            c == '-'
        } else {
            c.is_ascii_hexdigit()
        }
    });
    let head = head.strip_suffix('-')?;
    let digits_start = head.rfind(|c: char| !c.is_ascii_digit())?;
    if !uuid_ok || head.as_bytes()[digits_start] != b'-' {
        return None;
    }
    head[digits_start + 1..]
        .parse::<i32>()
        .ok()
        .filter(|p| *p > 0)
}

fn sweep_children(root: &str, now: f64, max_age: f64, skip_live: bool) {
    let Ok(read) = fs::read_dir(root) else { return };
    for entry in read.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = join(&[root, &name]);
        let Ok(meta) = fs::symlink_metadata(&child) else {
            continue;
        };
        if !meta.is_dir() || now - mtime_ms(&meta) < max_age {
            continue;
        }
        if skip_live
            && let Some(pid) = staging_pid(&name)
            && (unsafe { libc::kill(pid, 0) } == 0
                || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
        {
            continue;
        }
        let _ = fs::remove_dir_all(&child);
    }
}

/// `writeRuntimeSystemPromptArtifact({ aspHome, artifactRoot, content })`.
pub fn write_prompt_artifact(artifact_root: &str, content: &str) -> Result<String, Fwd> {
    let hash = sha256_hex(content.as_bytes());
    let dir = join(&[artifact_root, "system-prompts", &hash[..2], &hash]);
    mkdirp(&dir)?;
    let path = join(&[&dir, "system-prompt.md"]);
    write(&path, content)?;
    if let Ok(file) = fs::File::options().write(true).open(&path) {
        let now = std::time::SystemTime::now();
        let _ = file.set_times(fs::FileTimes::new().set_accessed(now).set_modified(now));
    }
    Ok(path)
}

/// `discoverSkills(pluginDirs)` + `detectCommandConflicts(pluginDirs)`:
/// a conflict throws in Bun, so raspd reports it as a forward.
pub fn check_skill_and_command_conflicts(plugin_dirs: &[String]) -> Result<(), Fwd> {
    let mut skills: Vec<String> = vec![];
    for dir in plugin_dirs {
        let skills_dir = join(&[dir, "skills"]);
        if fs::metadata(&skills_dir).is_err() {
            continue;
        }
        let mut files = vec![];
        find_skill_files(&skills_dir, &mut files);
        files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        for file in files {
            let rel = relative(&skills_dir, &file);
            let name = if rel == "SKILL.md" {
                basename(dir)
            } else if let Some(n) = rel.strip_suffix("/SKILL.md") {
                n.to_owned()
            } else {
                rel.clone()
            };
            if skills.contains(&name) {
                return Err(fwd("skill_name_conflict"));
            }
            skills.push(name);
        }
    }
    let mut commands: Vec<String> = vec![];
    for dir in plugin_dirs {
        let Ok(read) = fs::read_dir(join(&[dir, "commands"])) else {
            continue;
        };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type().is_ok_and(|t| t.is_file()) || !name.ends_with(".md") {
                continue;
            }
            let name = name.trim_end_matches(".md").to_owned();
            if commands.contains(&name) {
                return Err(fwd("command_name_conflict"));
            }
            commands.push(name);
        }
    }
    Ok(())
}

fn find_skill_files(dir: &str, out: &mut Vec<String>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let full = join(&[dir, &entry.file_name().to_string_lossy()]);
        match entry.file_type() {
            Ok(t) if t.is_dir() => find_skill_files(&full, out),
            Ok(t) if t.is_file() && entry.file_name() == "SKILL.md" => out.push(full),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staging_pid_matches_bun_pattern() {
        assert_eq!(
            staging_pid("space-x-dev-123-1b4e28ba-2fa1-41d2-883f-0016d3cca427"),
            Some(123)
        );
        assert_eq!(
            staging_pid("space-x-1b4e28ba-2fa1-41d2-883f-0016d3cca427"),
            None
        );
    }

    #[test]
    fn hooks_config_groups_by_event_then_matcher() {
        let hooks: Vec<J> = vec![
            J::obj([
                ("event", J::str("pre_tool_use")),
                ("script", J::str("a.sh")),
                ("tools", J::Arr(vec![J::str("Bash")])),
            ]),
            J::obj([
                ("event", J::str("session_start")),
                ("script", J::str("b.sh")),
                ("matcher", J::str("compact")),
            ]),
            J::obj([
                ("event", J::str("pre_tool_use")),
                ("script", J::str("c.sh")),
                ("tools", J::Arr(vec![J::str("Bash")])),
            ]),
            J::obj([
                ("event", J::str("stop")),
                ("script", J::str("d.sh")),
                ("harness", J::str("pi")),
            ]),
        ];
        assert_eq!(
            claude_hooks_config(&hooks).to_json(),
            r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/a.sh"},{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/c.sh"}],"matcher":"Bash"}],"SessionStart":[{"hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/b.sh"}],"matcher":"compact"}]}}"#
        );
    }
}
