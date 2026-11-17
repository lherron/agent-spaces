//! The claude target bundle (ClaudeAdapter.composeTarget/loadTargetBundle,
//! with the materializer's mcp-composer, settings-composer and
//! permissions-toml): the ordered plugin copies, the merged mcp.json, the
//! composed settings.json with each space's permissions.toml as Claude rules,
//! and the release's statusline script, published through bundle_publish.
use super::bundle_publish::{TargetInput, publish_target};
use super::claude_plugin::str_list;
use super::fs_tree::{copy_dir, io_fwd, mkdirp, write, write_json};
use super::stage::Artifact;
use super::util::{js_sort, js_trim, sha256_hex};
use super::{Fwd, fwd};
use crate::json::J;
use crate::reads::jspath::join;
use std::fs;
use std::os::unix::fs::PermissionsExt;

/// The release's Claude statusline asset (`claude-statusline`).
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

/// Publish a claude target bundle.
pub fn publish_claude_target(
    input: &TargetInput,
    artifacts: &[Artifact],
    permissions: &[Option<J>],
    statusline: &Statusline,
    fingerprint: &str,
    asp_home: &str,
) -> Result<Bundle, Fwd> {
    let output = publish_target(
        input,
        artifacts,
        fingerprint,
        asp_home,
        "claude",
        |staging_output, output| {
            let bundle =
                compose_target(artifacts, permissions, staging_output, output, statusline)?;
            let mut required = vec![bundle.settings_path.clone()];
            required.extend(bundle.mcp_config_path.clone());
            required.extend(bundle.plugin_dirs.iter().cloned());
            Ok(required)
        },
    )?;
    load_bundle(&output)
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
        copy_dir(&a.path, &dest, true)?;
        plugin_dirs.push(dest);
    }
    let mcp_config_path = compose_mcp(output, &plugin_dirs)?;
    // Settings: each space's manifest settings plus its permissions.toml.
    let mut composed = J::Obj(vec![]);
    for (artifact, perms) in artifacts.iter().zip(permissions) {
        let mut merged = artifact.settings.clone();
        if let Some(p) = perms {
            let (allow, deny) = claude_settings_permissions(p);
            if !allow.is_empty() || !deny.is_empty() {
                let mut permissions = merged.get("permissions").cloned().unwrap_or(J::Obj(vec![]));
                append_rules(&mut permissions, "allow", allow.into_iter().map(J::Str));
                append_rules(&mut permissions, "deny", deny.into_iter().map(J::Str));
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
    composed.set("promptSuggestionEnabled", J::Bool(false));
    composed.set("awaySummaryEnabled", J::Bool(false));
    let source = fs::read(&statusline.path).map_err(|_| fwd(crate::reason!("statusline_asset")))?;
    if sha256_hex(&source) != statusline.sha256 {
        return Err(fwd(crate::reason!("statusline_digest")));
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

/// `composeMcpConfig`: every plugin's mcp/mcp.json servers into the bundle's
/// mcp.json, later servers overriding earlier ones of the same name. `None`
/// (and no file) when no plugin declares a server.
fn compose_mcp(output: &str, plugin_dirs: &[String]) -> Result<Option<String>, Fwd> {
    let mut servers: Vec<(String, J)> = vec![];
    for dir in plugin_dirs {
        let path = join(&[dir, "mcp", "mcp.json"]);
        if !fs::metadata(&path).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let Some(config) = fs::read(&path).ok().and_then(|t| crate::json::parse(&t)) else {
            continue;
        };
        // Object.entries(config.mcpServers) throws on a missing table.
        let Some(J::Obj(entries)) = config.get("mcpServers") else {
            return Err(fwd(crate::reason!("mcp_config_shape")));
        };
        for (name, server) in entries {
            match servers.iter_mut().find(|(n, _)| n == name) {
                Some(slot) => slot.1 = server.clone(),
                None => servers.push((name.clone(), server.clone())),
            }
        }
    }
    if servers.is_empty() {
        return Ok(None);
    }
    let mcp_path = join(&[output, "mcp.json"]);
    write_json(&mcp_path, &J::obj([("mcpServers", J::Obj(servers))]))?;
    Ok(Some(mcp_path))
}

/// Append `rules` to `permissions[key]`; an empty list leaves it untouched.
fn append_rules(permissions: &mut J, key: &str, rules: impl IntoIterator<Item = J>) {
    let mut rules = rules.into_iter().peekable();
    if rules.peek().is_none() {
        return;
    }
    let mut list = permissions
        .get(key)
        .and_then(J::as_arr)
        .cloned()
        .unwrap_or_default();
    list.extend(rules);
    permissions.set(key, J::Arr(list));
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
            if let Some(J::Arr(rules)) = p.get(key) {
                append_rules(&mut permissions, key, rules.iter().cloned());
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

/// `toClaudeSettingsPermissions(toClaudePermissions(permissions))`.
fn claude_settings_permissions(p: &J) -> (Vec<String>, Vec<String>) {
    let trimmed = |v: Vec<String>| -> Vec<String> {
        v.iter()
            .map(|s| js_trim(s).to_owned())
            .filter(|s| !s.is_empty())
            .collect()
    };
    let mut allow = vec![];
    if !trimmed(str_list(p.get("read").and_then(|r| r.get("paths")))).is_empty() {
        allow.push("Read".to_owned());
    }
    if !trimmed(str_list(p.get("write").and_then(|r| r.get("paths")))).is_empty() {
        allow.push("Write".to_owned());
    }
    let exec = p.get("exec");
    for cmd in trimmed(str_list(exec.and_then(|e| e.get("commands")))) {
        allow.push(format!("Bash({cmd} *)"));
    }
    for pat in trimmed(str_list(exec.and_then(|e| e.get("patterns")))) {
        allow.push(format!("Bash({pat})"));
    }
    let mut deny = vec![];
    if let Some(d) = p.get("deny") {
        deny.extend(
            trimmed(str_list(d.get("read")))
                .into_iter()
                .map(|p| format!("Read({p})")),
        );
        deny.extend(
            trimmed(str_list(d.get("write")))
                .into_iter()
                .map(|p| format!("Write({p})")),
        );
        // Bun keeps a blank exec denial as `Bash()`.
        deny.extend(
            str_list(d.get("exec"))
                .iter()
                .map(|c| format!("Bash({})", js_trim(c))),
        );
    }
    (allow, deny)
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
    js_sort(&mut plugin_dirs);
    let mcp = join(&[output, "mcp.json"]);
    let mcp_config_path = fs::metadata(&mcp).ok().filter(|m| m.len() > 2).map(|_| mcp);
    Ok(Bundle {
        root_dir: output.to_owned(),
        plugin_dirs,
        mcp_config_path,
        settings_path: join(&[output, "settings.json"]),
    })
}
