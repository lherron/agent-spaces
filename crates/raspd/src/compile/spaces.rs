//! Space resolution for mutable compiles: space refs (core/types/refs.ts),
//! the dependency closure (resolver/closure.ts), manifests
//! (resolver/manifest.ts + space.schema.json), integrity
//! (resolver/integrity.ts), and lock generation and merge
//! (resolver/lock-generator.ts).
//!
//! Only filesystem-backed refs are resolved natively: `@dev` registry refs,
//! `space:agent:` and `space:project:`. A registry ref that needs a git
//! resolution, a path ref, or any input raspd will not judge is a `Forward`.
use super::util::{now_iso, sha1_hex, sha256_hex};
use super::{Fwd, fwd, fwd_at};
use crate::json::J;
use crate::reads::jspath::{join, read_text};
use crate::reads::toml::{self, TomlError};
use std::os::unix::fs::PermissionsExt;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Dev,
    Agent,
    Project,
}

impl Kind {
    pub fn marker(self) -> &'static str {
        match self {
            Kind::Dev => "dev",
            Kind::Agent => "agent",
            Kind::Project => "project",
        }
    }
}

pub struct SpaceRef {
    pub id: String,
    pub kind: Kind,
}

fn is_space_id_chars(s: &str) -> bool {
    // /^[a-z0-9]+(?:-[a-z0-9]+)*$/
    !s.is_empty()
        && s.split('-').all(|seg| {
            !seg.is_empty()
                && seg
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// JS `.+`: one or more characters, none a line terminator.
fn dot_plus(s: &str) -> bool {
    !s.is_empty()
        && !s
            .chars()
            .any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
}

/// `parseSpaceRef`, restricted to the refs raspd resolves natively.
pub fn parse_space_ref(raw: &str) -> Result<SpaceRef, Fwd> {
    let body = raw
        .strip_prefix("spaces:")
        .or_else(|| raw.strip_prefix("space:"))
        .ok_or_else(|| fwd("space_ref_invalid"))?;
    for (prefix, kind) in [("agent:", Kind::Agent), ("project:", Kind::Project)] {
        if let Some(rest) = body.strip_prefix(prefix) {
            let (id, selector) = match rest.split_once('@') {
                Some((id, sel)) => (id, Some(sel)),
                None => (rest, None),
            };
            if is_space_id_chars(id) && selector.is_none_or(dot_plus) {
                if id.len() > 64 {
                    return Err(fwd("space_id_invalid"));
                }
                return Ok(SpaceRef {
                    id: id.to_owned(),
                    kind,
                });
            }
        }
    }
    if body.starts_with("path:") {
        return Err(fwd("space_path_ref"));
    }
    let (id, selector) = match body.split_once('@') {
        Some((id, sel)) => (id, Some(sel)),
        None => (body, None),
    };
    if !is_space_id_chars(id) || selector.is_some_and(|s| !dot_plus(s)) {
        return Err(fwd("space_ref_invalid"));
    }
    if id.len() > 64 {
        return Err(fwd("space_id_invalid"));
    }
    match selector {
        None | Some("dev") => Ok(SpaceRef {
            id: id.to_owned(),
            kind: Kind::Dev,
        }),
        // HEAD, dist-tags, semver and git pins resolve through the registry.
        Some(_) => Err(fwd_at("registry_space", format!("compose:{raw}"))),
    }
}

/// A space as `computeClosure` resolved it.
pub struct Resolved {
    pub key: String,
    pub id: String,
    pub kind: Kind,
    pub manifest: J,
    pub deps: Vec<String>,
}

pub struct Closure {
    /// Postorder (`loadOrder`).
    pub spaces: Vec<Resolved>,
    pub roots: Vec<String>,
}

pub struct ClosureRoots<'a> {
    /// The registry root (`getRegistryPath`): `@dev` spaces live under it.
    pub registry: &'a str,
    pub agent_root: Option<&'a str>,
    pub project_root: Option<&'a str>,
}

pub fn closure(refs: &[String], roots: &ClosureRoots) -> Result<Closure, Fwd> {
    let mut out = Closure {
        spaces: vec![],
        roots: vec![],
    };
    let mut visiting: Vec<String> = vec![];
    for raw in refs {
        let r = parse_space_ref(raw)?;
        let key = visit(&r, None, roots, &mut out, &mut visiting)?;
        out.roots.push(key);
    }
    Ok(out)
}

fn edge_type(kind: Kind) -> &'static str {
    match kind {
        Kind::Agent => "agent",
        Kind::Project => "project",
        Kind::Dev => "registry",
    }
}

fn visit(
    r: &SpaceRef,
    parent: Option<&'static str>,
    roots: &ClosureRoots,
    out: &mut Closure,
    visiting: &mut Vec<String>,
) -> Result<String, Fwd> {
    let this = edge_type(r.kind);
    if let Some(parent) = parent
        && matches!(
            (parent, this),
            ("registry", "agent")
                | ("registry", "project")
                | ("agent", "project")
                | ("project", "agent")
        )
    {
        return Err(fwd("disallowed_dependency_edge"));
    }
    let key = format!("{}@{}", r.id, r.kind.marker());
    if out.spaces.iter().any(|s| s.key == key) {
        return Ok(key);
    }
    if visiting.contains(&key) {
        return Err(fwd("cyclic_dependency"));
    }
    visiting.push(key.clone());
    let dir = match r.kind {
        Kind::Agent => format!(
            "{}/spaces/{}",
            roots.agent_root.ok_or_else(|| fwd("agent_root_required"))?,
            r.id
        ),
        Kind::Project => format!(
            "{}/spaces/{}",
            roots
                .project_root
                .ok_or_else(|| fwd_at("project_root_required", format!("space:project:{}", r.id)))?,
            r.id
        ),
        Kind::Dev => join(&[roots.registry, "spaces", &r.id]),
    };
    let manifest = read_manifest(&join(&[&dir, "space.toml"]))?;
    let mut deps = vec![];
    if let Some(dep_refs) = manifest.get("deps").and_then(|d| d.get("spaces")) {
        for dep in dep_refs.as_arr().into_iter().flatten() {
            let dep = parse_space_ref(dep.as_str().ok_or_else(|| fwd("space_dep_invalid"))?)?;
            deps.push(visit(&dep, Some(this), roots, out, visiting)?);
        }
    }
    visiting.pop();
    out.spaces.push(Resolved {
        key: key.clone(),
        id: r.id.clone(),
        kind: r.kind,
        manifest,
        deps,
    });
    Ok(key)
}

/// `readSpaceManifestFromFilesystem`: the parsed, schema-valid manifest.
pub fn read_manifest(path: &str) -> Result<J, Fwd> {
    let content = read_text(path).map_err(|_| fwd("space_manifest_unreadable"))?;
    let parsed = match toml::parse(&content) {
        Ok(v) => v,
        Err(TomlError::Unsupported(reason)) => return Err(fwd(reason)),
        Err(_) => return Err(fwd("space_manifest_toml")),
    };
    if !space_manifest_valid(&parsed) {
        return Err(fwd("space_manifest_invalid"));
    }
    Ok(parsed)
}

// -- space.schema.json ------------------------------------------------------

fn code_points(s: &str) -> usize {
    s.chars().count()
}

fn semver(s: &str) -> bool {
    // ^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$
    let (core, build) = match s.split_once('+') {
        Some((c, b)) => (c, Some(b)),
        None => (s, None),
    };
    let ident = |x: &str| {
        !x.is_empty()
            && x.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    };
    if build.is_some_and(|b| !ident(b)) {
        return false;
    }
    let (nums, pre) = match core.split_once('-') {
        Some((n, p)) => (n, Some(p)),
        None => (core, None),
    };
    if pre.is_some_and(|p| !ident(p)) {
        return false;
    }
    let parts: Vec<&str> = nums.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.bytes().all(|b| b.is_ascii_digit())
                && (p.len() == 1 || !p.starts_with('0'))
        })
}

fn schema_space_ref(s: &str) -> bool {
    // ^space:((agent|project):ID(?:@.+)?|path:[^@]+@.+|ID@.+)$
    let Some(body) = s.strip_prefix("space:") else {
        return false;
    };
    for prefix in ["agent:", "project:"] {
        if let Some(rest) = body.strip_prefix(prefix) {
            let ok = match rest.split_once('@') {
                Some((id, sel)) => is_space_id_chars(id) && dot_plus(sel),
                None => is_space_id_chars(rest),
            };
            if ok {
                return true;
            }
        }
    }
    if let Some(rest) = body.strip_prefix("path:")
        && let Some((p, sel)) = rest.split_once('@')
        && !p.is_empty()
        && dot_plus(sel)
    {
        return true;
    }
    match body.split_once('@') {
        Some((id, sel)) => is_space_id_chars(id) && dot_plus(sel),
        None => false,
    }
}

fn only(v: &J, keys: &[&str]) -> bool {
    match v {
        J::Obj(fields) => fields.iter().all(|(k, _)| keys.contains(&k.as_str())),
        _ => false,
    }
}

fn opt<'a>(v: &'a J, key: &str, check: impl Fn(&'a J) -> bool) -> bool {
    v.get(key).is_none_or(check)
}

fn str_max(max: usize) -> impl Fn(&J) -> bool {
    move |v| matches!(v, J::Str(s) if code_points(s) <= max)
}

fn str_array(v: &J) -> bool {
    matches!(v, J::Arr(items) if items.iter().all(|i| matches!(i, J::Str(_))))
}

/// The space manifest schema, or false where raspd will not judge (the
/// `email`/`uri` formats, which ajv-formats checks).
pub fn space_manifest_valid(v: &J) -> bool {
    let id_ok = |v: &J| matches!(v, J::Str(s) if is_space_id_chars(s) && code_points(s) <= 64);
    let semver_ok = |v: &J| matches!(v, J::Str(s) if semver(s));
    let plugin_ok = |p: &J| {
        only(p, &["name", "version", "description", "author", "homepage", "repository", "license", "keywords"])
            && opt(p, "name", id_ok)
            && opt(p, "version", semver_ok)
            && opt(p, "description", str_max(500))
            // email/uri formats: not judged here.
            && p.get("author").is_none()
            && p.get("homepage").is_none()
            && p.get("repository").is_none()
            && opt(p, "license", str_max(100))
            && opt(p, "keywords", |k| {
                matches!(k, J::Arr(items) if items.len() <= 30 && items.iter().all(str_max(50)))
            })
    };
    let deps_ok = |d: &J| {
        only(d, &["spaces"])
            && opt(
                d,
                "spaces",
                |s| matches!(s, J::Arr(items) if items.iter().all(|i| matches!(i, J::Str(r) if schema_space_ref(r)))),
            )
    };
    let settings_ok = |s: &J| {
        only(s, &["permissions", "env", "model", "cleanupPeriodDays"])
            && opt(s, "permissions", |p| {
                only(p, &["allow", "deny"])
                    && opt(p, "allow", str_array)
                    && opt(p, "deny", str_array)
            })
            && opt(
                s,
                "env",
                |e| matches!(e, J::Obj(f) if f.iter().all(|(_, v)| matches!(v, J::Str(_)))),
            )
            && opt(s, "model", |m| matches!(m, J::Str(_)))
            && opt(
                s,
                "cleanupPeriodDays",
                |n| matches!(n, J::Num(x) if *x >= 1.0),
            )
    };
    let harness_ok = |h: &J| {
        only(h, &["supports"])
            && opt(h, "supports", |s| {
                let J::Arr(items) = s else { return false };
                let mut seen: Vec<&J> = vec![];
                items.iter().all(|i| {
                    let ok = matches!(i, J::Str(x) if ["agent-harness", "claude", "claude-hrcpty", "codex", "muse"].contains(&x.as_str()))
                        && !seen.contains(&i);
                    seen.push(i);
                    ok
                })
            })
    };
    let claude_ok = |c: &J| {
        only(c, &["model", "mcp"])
            && opt(c, "model", |m| matches!(m, J::Str(_)))
            && opt(c, "mcp", str_array)
    };
    let pi_ok = |p: &J| {
        only(p, &["model", "extensions", "build"])
            && opt(p, "model", |m| matches!(m, J::Str(_)))
            && opt(p, "extensions", str_array)
            && opt(p, "build", |b| {
                only(b, &["bundle", "format", "target", "external"])
                    && opt(b, "bundle", |x| matches!(x, J::Bool(_)))
                    && opt(
                        b,
                        "format",
                        |x| matches!(x, J::Str(s) if s == "esm" || s == "cjs"),
                    )
                    && opt(
                        b,
                        "target",
                        |x| matches!(x, J::Str(s) if s == "bun" || s == "node"),
                    )
                    && opt(b, "external", str_array)
            })
    };
    let toggle = |t: &J| only(t, &["enabled"]) && opt(t, "enabled", |x| matches!(x, J::Bool(_)));
    let codex_ok = |c: &J| {
        only(c, &["config", "model", "prompts", "skills"])
            && opt(c, "config", J::is_record)
            && opt(c, "model", |m| matches!(m, J::Str(_)))
            && opt(c, "prompts", toggle)
            && opt(c, "skills", toggle)
    };
    only(
        v,
        &[
            "schema",
            "id",
            "version",
            "description",
            "plugin",
            "deps",
            "settings",
            "harness",
            "claude",
            "pi",
            "codex",
        ],
    ) && matches!(v.get("schema"), Some(J::Num(n)) if *n == 1.0)
        && v.get("id").is_some_and(id_ok)
        && opt(v, "version", semver_ok)
        && opt(v, "description", str_max(500))
        && opt(v, "plugin", plugin_ok)
        && opt(v, "deps", deps_ok)
        && opt(v, "settings", settings_ok)
        && opt(v, "harness", harness_ok)
        && opt(v, "claude", claude_ok)
        && opt(v, "pi", pi_ok)
        && opt(v, "codex", codex_ok)
}

// -- integrity --------------------------------------------------------------

/// `computeFilesystemIntegrity`.
pub fn filesystem_integrity(space_path: &str) -> Result<String, Fwd> {
    let mut entries: Vec<(String, String, String)> = vec![];
    collect_fs(space_path, "", &mut entries)?;
    entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let mut text = String::from("v1\0");
    for (path, oid, mode) in entries {
        text.push_str(&format!("{path}\0blob\0{oid}\0{mode}\n"));
    }
    Ok(format!("sha256:{}", sha256_hex(text.as_bytes())))
}

fn ignored(rel: &str) -> bool {
    rel.split('/')
        .any(|p| matches!(p, "node_modules" | ".git" | ".DS_Store" | "Thumbs.db"))
        || [".pyc", ".pyo", ".class"].iter().any(|e| rel.ends_with(e))
}

fn collect_fs(base: &str, rel: &str, out: &mut Vec<(String, String, String)>) -> Result<(), Fwd> {
    let full = if rel.is_empty() {
        base.to_owned()
    } else {
        join(&[base, rel])
    };
    let Ok(read) = std::fs::read_dir(&full) else {
        return Ok(());
    };
    for entry in read {
        let entry = entry.map_err(|_| fwd("integrity_readdir"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let item_rel = if rel.is_empty() {
            name
        } else {
            join(&[rel, &name])
        };
        if ignored(&item_rel) {
            continue;
        }
        let ft = entry.file_type().map_err(|_| fwd("integrity_stat"))?;
        if ft.is_dir() {
            collect_fs(base, &item_rel, out)?;
        } else if ft.is_file() {
            let path = join(&[base, &item_rel]);
            let content = std::fs::read(&path).map_err(|_| fwd("integrity_read"))?;
            let mut blob = format!("blob {}\0", content.len()).into_bytes();
            blob.extend_from_slice(&content);
            let mode = std::fs::metadata(&path)
                .map_err(|_| fwd("integrity_stat"))?
                .permissions()
                .mode();
            let mode = if mode & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            };
            out.push((item_rel, sha1_hex(&blob), mode.into()));
        }
    }
    Ok(())
}

pub fn integrity(space: &Resolved, roots: &ClosureRoots) -> Result<String, Fwd> {
    match space.kind {
        Kind::Dev => Ok("sha256:dev".into()),
        Kind::Agent => filesystem_integrity(&join(&[
            roots.agent_root.unwrap_or_default(),
            "spaces",
            &space.id,
        ])),
        Kind::Project => filesystem_integrity(&join(&[
            roots.project_root.unwrap_or_default(),
            "spaces",
            &space.id,
        ])),
    }
}

// -- lock -------------------------------------------------------------------

/// `derivePluginIdentity`: `(name, version)`.
pub fn plugin_identity(manifest: &J) -> (String, Option<String>) {
    let plugin = manifest.get("plugin");
    let name = plugin
        .and_then(|p| p.get("name"))
        .and_then(J::as_str)
        .or_else(|| manifest.get("id").and_then(J::as_str))
        .unwrap_or_default()
        .to_owned();
    let version = plugin
        .and_then(|p| p.get("version"))
        .and_then(J::as_str)
        .or_else(|| manifest.get("version").and_then(J::as_str))
        .map(str::to_owned);
    (name, version)
}

pub fn portable_registry() -> J {
    J::obj([
        ("type", J::str("git")),
        ("repository", J::str("spaces-repo")),
        (
            "canonicalRemote",
            J::str("git@github.com:lherron/spaces-repo.git"),
        ),
        ("defaultBranch", J::str("main")),
    ])
}

fn env_hash(prefix: &str, data: &[(String, String, String)]) -> String {
    let mut text = prefix.to_owned();
    for (key, integrity, plugin) in data {
        text.push_str(&format!("{key}\0{integrity}\0{plugin}\n"));
    }
    format!("sha256:{}", sha256_hex(text.as_bytes()))
}

/// `generateLockFileForTarget(targetName, compose, closure, ...)`.
pub fn generate_lock(
    target: &str,
    compose: &[String],
    closure: &Closure,
    integrities: &[String],
) -> J {
    let mut spaces = vec![];
    let mut data = vec![];
    for (space, integrity) in closure.spaces.iter().zip(integrities) {
        let (name, version) = plugin_identity(&space.manifest);
        let mut plugin = vec![("name".to_owned(), J::str(&name))];
        if let Some(v) = version {
            plugin.push(("version".into(), J::str(v)));
        }
        let path = format!("spaces/{}", space.id);
        let mut entry = J::obj([
            ("id", J::str(&space.id)),
            ("commit", J::str(space.kind.marker())),
            ("path", J::str(path)),
            ("integrity", J::str(integrity)),
            ("plugin", J::Obj(plugin)),
            (
                "deps",
                J::obj([("spaces", J::Arr(space.deps.iter().map(J::str).collect()))]),
            ),
            ("resolvedFrom", J::obj([("selector", J::str("dev"))])),
        ]);
        match space.kind {
            Kind::Project => entry.set("projectSpace", J::Bool(true)),
            Kind::Agent => entry.set("agentSpace", J::Bool(true)),
            Kind::Dev => {}
        }
        spaces.push((space.key.clone(), entry));
        data.push((space.key.clone(), integrity.clone(), name));
    }
    // W205: plugin names produced by more than one space, in first-seen order.
    let mut owners: Vec<(String, Vec<String>)> = vec![];
    for space in &closure.spaces {
        let (name, _) = plugin_identity(&space.manifest);
        match owners.iter_mut().find(|(n, _)| *n == name) {
            Some((_, keys)) => keys.push(space.key.clone()),
            None => owners.push((name, vec![space.key.clone()])),
        }
    }
    let warnings: Vec<J> = owners
        .into_iter()
        .filter(|(_, keys)| keys.len() > 1)
        .map(|(name, keys)| {
            let ids: Vec<&str> = keys
                .iter()
                .map(|k| k.split('@').next().unwrap_or_default())
                .collect();
            J::obj([
                ("code", J::str("W205")),
                (
                    "message",
                    J::str(format!(
                        "Plugin name '{name}' is produced by multiple spaces: {}",
                        ids.join(", ")
                    )),
                ),
                (
                    "details",
                    J::obj([
                        ("pluginName", J::str(&name)),
                        ("spaces", J::Arr(keys.iter().map(J::str).collect())),
                    ]),
                ),
            ])
        })
        .collect();
    let load_order: Vec<J> = closure.spaces.iter().map(|s| J::str(&s.key)).collect();
    let mut target_entry = J::obj([
        ("compose", J::Arr(compose.iter().map(J::str).collect())),
        ("roots", J::Arr(closure.roots.iter().map(J::str).collect())),
        ("loadOrder", J::Arr(load_order)),
        ("envHash", J::str(env_hash("env-v1\0", &data))),
        (
            "harnesses",
            J::obj([(
                super::stage::DEFAULT_HARNESS,
                J::obj([(
                    "envHash",
                    J::str(env_hash("env-harness-v1\0agent-harness\0", &data)),
                )]),
            )]),
        ),
    ]);
    if !warnings.is_empty() {
        target_entry.set("warnings", J::Arr(warnings));
    }
    J::obj([
        ("lockfileVersion", J::Num(1.0)),
        ("resolverVersion", J::Num(1.0)),
        ("generatedAt", J::str(now_iso())),
        ("registry", portable_registry()),
        ("spaces", J::Obj(spaces)),
        ("targets", J::obj([(target, target_entry)])),
    ])
}

/// `mergeLockFiles(existing, updates)`.
pub fn merge_locks(existing: &J, updates: &J) -> J {
    let mut merged = existing.clone();
    merged.set(
        "registry",
        updates.get("registry").cloned().unwrap_or(J::Null),
    );
    merged.set("generatedAt", J::str(now_iso()));
    for key in ["spaces", "targets"] {
        let mut map = existing.get(key).cloned().unwrap_or(J::Obj(vec![]));
        if let Some(J::Obj(fields)) = updates.get(key) {
            for (k, v) in fields {
                map.set(k, v.clone());
            }
        }
        merged.set(key, map);
    }
    merged
}

/// `classifySpaceEntry(entry) === 'registry'`.
pub fn is_registry_entry(entry: &J) -> bool {
    let commit = entry.get("commit").and_then(J::as_str);
    let integrity = entry.get("integrity").and_then(J::as_str);
    !(commit == Some("dev")
        || integrity == Some("sha256:dev")
        || commit == Some("project")
        || entry.get("projectSpace").is_some_and(super::truthy)
        || commit == Some("agent")
        || entry.get("agentSpace").is_some_and(super::truthy))
}

/// A lock file as `readLockJson` would accept it, as far as raspd judges.
pub fn lock_shape_ok(lock: &J) -> bool {
    let entries_ok = |key: &str| matches!(lock.get(key), Some(J::Obj(_)));
    matches!(lock, J::Obj(_))
        && entries_ok("spaces")
        && entries_ok("targets")
        && lock.get("spaces").is_some_and(|s| {
            s.js_entries().iter().all(|(_, e)| {
                ["id", "commit", "integrity"]
                    .iter()
                    .all(|k| matches!(e.get(k), Some(J::Str(_))))
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs() {
        assert_eq!(
            parse_space_ref("space:defaults@dev").unwrap().kind,
            Kind::Dev
        );
        assert_eq!(parse_space_ref("space:defaults").unwrap().kind, Kind::Dev);
        assert_eq!(parse_space_ref("space:agent:x").unwrap().kind, Kind::Agent);
        assert_eq!(
            parse_space_ref("space:project:y@dev").unwrap().kind,
            Kind::Project
        );
        assert!(parse_space_ref("space:x@git:abcdef1").is_err());
        assert!(parse_space_ref("space:x@stable").is_err());
        assert!(semver("1.0.0") && semver("0.1.0-rc.1+b") && !semver("01.0.0") && !semver("1.0"));
    }
}
