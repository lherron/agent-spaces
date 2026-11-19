//! The pre-write view of one locked space (plugin-artifacts.ts): its manifest
//! merged with the lock's plugin identity, the harness-support skip, and the
//! hooks.toml and permissions.toml staging will read, judged before anything
//! is written.
use super::fs_tree::{is_dir_follow, is_file_follow};
use super::{Fwd, fwd};
use crate::json::J;
use crate::reads::jspath::join;
use crate::reads::toml;

/// One locked space entry to stage.
pub struct SpaceInput {
    pub key: String,
    pub id: String,
    pub plugin_name: String,
    pub plugin_version: String,
    /// The space's content directory (`resolveSpaceContentDir`).
    pub content_dir: String,
}

/// The pre-write view of one space: its manifest as plugin-artifacts builds
/// it, and the TOML files staging will read, already judged.
pub struct SpacePlan {
    pub input: SpaceInput,
    /// `manifest`, the parsed space.toml merged with the lock's plugin identity.
    pub manifest: J,
    pub hooks: Option<Vec<J>>,
    pub permissions: Option<J>,
    pub antigravity_mcp: Option<J>,
}

/// Judge everything staging a space reads, before anything is written.
/// `None`: the space does not declare the harness and is not materialized
/// (plugin-artifacts.ts harness-skip; the lock keeps it).
pub fn plan_space(
    input: SpaceInput,
    lock_plugin: &J,
    harness_id: &str,
) -> Result<Option<SpacePlan>, Fwd> {
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
            .is_some_and(|s| s.iter().any(|h| h.as_str() == Some(harness_id)))
    {
        return Ok(None);
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
    let antigravity_mcp = if harness_id == super::antigravity::HARNESS_ID {
        super::antigravity::plugins::project_mcp(&input.content_dir)?
    } else {
        None
    };
    Ok(Some(SpacePlan {
        input,
        manifest,
        hooks,
        permissions,
        antigravity_mcp,
    }))
}

fn parse_toml_file(path: &str) -> Result<J, Fwd> {
    // Lossy like Bun's readFile(…, 'utf8'); a file that cannot be read refuses.
    let content = crate::reads::jspath::read_text(path)
        .map_err(|_| fwd(crate::reason!("toml_unreadable")))?;
    match toml::parse(&content) {
        Ok(v) => Ok(v),
        Err(toml::TomlError::Unsupported(reason)) => Err(fwd(reason)),
        Err(_) => Err(fwd(crate::reason!("toml_syntax"))),
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
                Some(_) => Err(fwd(crate::reason!("hooks_toml_shape"))),
            };
            let mut out = J::obj([
                ("event", string_field("event")?),
                ("script", string_field("script")?),
            ]);
            if let Some(J::Arr(tools)) = h.get("tools") {
                if !tools.iter().all(|t| matches!(t, J::Str(_))) {
                    return Err(fwd(crate::reason!("hooks_toml_shape")));
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

/// permissions.toml's tables and the string arrays each keeps, in Bun's order.
const PERMISSION_TABLES: [(&str, &[&str]); 5] = [
    ("read", &["paths"]),
    ("write", &["paths"]),
    ("exec", &["commands", "patterns"]),
    ("network", &["hosts"]),
    ("deny", &["read", "write", "exec", "network"]),
];

/// `parsePermissionsToml`, with every array element a string (`.trim()` on
/// anything else throws in Bun).
fn parse_permissions_toml(path: &str) -> Result<J, Fwd> {
    let parsed = parse_toml_file(path)?;
    let mut out = vec![];
    for (name, keys) in PERMISSION_TABLES {
        let Some(table @ J::Obj(_)) = parsed.get(name) else {
            continue;
        };
        let mut fields = vec![];
        for key in keys {
            if let Some(J::Arr(items)) = table.get(key) {
                let strings = items
                    .iter()
                    .map(|i| {
                        i.as_str()
                            .map(J::str)
                            .ok_or_else(|| fwd(crate::reason!("permissions_toml_shape")))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                fields.push(((*key).to_owned(), J::Arr(strings)));
            }
        }
        out.push((name.to_owned(), J::Obj(fields)));
    }
    Ok(J::Obj(out))
}
