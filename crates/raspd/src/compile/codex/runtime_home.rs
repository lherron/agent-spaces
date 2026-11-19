//! The stable Codex runtime home (run-codex.ts `prepareCodexRuntimeHome`):
//! `<ASP_HOME>/codex-homes/<project>_<target>`, synced from the bundle's
//! `codex.home` template under `.asp-runtime.lock` unless its
//! `.asp-runtime.json` fingerprint already matches. Managed files are
//! copied, managed directories become symlinks to immutable versions, and
//! hooks, hook trust, project trust and the praesidium context are applied.
use super::agents::{apply_praesidium, praesidium_block};
use super::hooks::{hrc_hooks_config, merge_hooks, trust_config_toml};
use crate::compile::fs_tree::{
    copy_dir, copy_file, io_fwd, mkdirp, read_json, read_text, rm_rf, write, write_json,
};
use crate::compile::lockfile::{self, MATERIALIZATION};
use crate::compile::util::{canonicalize, random_uuid, sanitize_segment, sha256_hex};
use crate::compile::{Fwd, lock_fwd};
use crate::json::{J, quoted};
use crate::reads::jspath::{exists, join, relative, resolve};
use std::fs;
use std::os::unix::fs::symlink;

/// The hook events a presented (codex-tui) birth captures (compile-broker-plan.ts).
pub const TUI_HOOK_EVENTS: [&str; 2] = ["Stop", "PostToolUse"];
/// The events an interactive home captures when the caller names none.
const INTERACTIVE_HOOK_EVENTS: [&str; 6] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
];
const MANAGED_FILES: [&str; 7] = [
    "AGENTS.md",
    "config.toml",
    "hooks.json",
    "mcp.json",
    "manifest.json",
    "auth.json",
    "space-hooks.json",
];
const MANAGED_DIRS: [&str; 3] = ["skills", "prompts", "space-hooks"];
const MANAGED_VERSIONS: &str = ".asp-managed-directory-versions";

/// What `prepareCodexRuntimeHome(bundle, runOptions)` reads.
pub struct Home<'a> {
    pub asp_home: &'a str,
    pub project_id: &'a str,
    pub target_name: &'a str,
    pub bundle_root: &'a str,
    /// `runOptions.cwd`, which is also its project path.
    pub cwd: &'a str,
    pub interactive: bool,
    pub hook_events: Option<&'a [&'a str]>,
    pub system_prompt: Option<&'a str>,
    pub reminder: Option<&'a str>,
}

/// `resolveCodexRuntimeHomePath` for an agent-project placement with a project id.
pub fn home_path(asp_home: &str, project_id: &str, target_name: &str) -> String {
    join(&[
        asp_home,
        "codex-homes",
        &format!(
            "{}_{}",
            sanitize_segment(project_id),
            sanitize_segment(target_name)
        ),
    ])
}

/// `computeCodexRuntimeFingerprint(input)`.
fn runtime_fingerprint(h: &Home, block: Option<&str>, config_hash: Option<&str>) -> String {
    let template = join(&[h.bundle_root, "codex.home"]);
    let mut material = J::obj([
        ("schemaVersion", J::Num(1.0)),
        ("templateHome", J::str(resolve(&[&template]))),
        ("bundleRoot", J::str(resolve(&[h.bundle_root]))),
        ("targetName", J::str(h.target_name)),
        ("projectPath", J::str(resolve(&[h.cwd]))),
        ("cwd", J::str(resolve(&[h.cwd]))),
        ("interactive", J::Bool(h.interactive)),
    ]);
    if let Some(events) = h.hook_events {
        material.set(
            "codexHookEvents",
            J::Arr(events.iter().map(|e| J::str(*e)).collect()),
        );
    }
    if let Some(b) = block {
        material.set("praesidiumBlock", J::str(b));
    }
    if let Some(c) = config_hash {
        material.set("configHash", J::str(c));
    }
    sha256_hex(canonicalize(&material, false).as_bytes())
}

fn home_matches(home: &str, fingerprint: &str) -> bool {
    let Ok(text) = fs::read(join(&[home, ".asp-runtime.json"])) else {
        return false;
    };
    let Some(metadata) = crate::json::parse(&text) else {
        return false;
    };
    metadata.get("complete") == Some(&J::Bool(true))
        && metadata.get("fingerprint").and_then(J::as_str) == Some(fingerprint)
        && ["AGENTS.md", "config.toml"]
            .iter()
            .all(|r| exists(&join(&[home, r])))
}

fn sync_managed_file(template: &str, home: &str, rel: &str) -> Result<(), Fwd> {
    let src = join(&[template, rel]);
    let dest = join(&[home, rel]);
    if !exists(&src) {
        return rm_rf(&dest);
    }
    let meta = fs::symlink_metadata(&src).map_err(io_fwd)?;
    rm_rf(&dest)?;
    if meta.file_type().is_symlink() {
        symlink(fs::read_link(&src).map_err(io_fwd)?, &dest).map_err(io_fwd)?;
        return Ok(());
    }
    copy_file(&src, &dest)
}

/// `rel` as a relative symlink to its version `key`, copied once; a real
/// directory left by an older home is moved aside as a legacy version.
fn sync_managed_dir(template: &str, home: &str, rel: &str, key: &str) -> Result<(), Fwd> {
    let src = join(&[template, rel]);
    let dest = join(&[home, rel]);
    if !exists(&src) {
        return rm_rf(&dest);
    }
    let versions = join(&[home, MANAGED_VERSIONS, rel]);
    let version = join(&[&versions, key]);
    let staging = join(&[&versions, &format!(".{key}.{}.staging", random_uuid())]);
    let pending = join(&[home, &format!(".{rel}.{}.pending", random_uuid())]);
    mkdirp(&versions)?;
    let result = (|| {
        if !exists(&version) {
            fs::create_dir(&staging).map_err(io_fwd)?;
            copy_dir(&src, &staging, false)?;
            if let Err(e) = fs::rename(&staging, &version)
                && !(e.raw_os_error() == Some(libc::EEXIST) && exists(&version))
            {
                return Err(io_fwd(e));
            }
        }
        symlink(relative(home, &version), &pending).map_err(io_fwd)?;
        match fs::symlink_metadata(&dest) {
            Ok(m) if m.file_type().is_symlink() => fs::rename(&pending, &dest).map_err(io_fwd),
            Ok(_) => {
                let legacy = join(&[&versions, &format!(".legacy-{rel}-{}", random_uuid())]);
                fs::rename(&dest, &legacy).map_err(io_fwd)?;
                fs::rename(&pending, &dest).map_err(io_fwd)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::rename(&pending, &dest).map_err(io_fwd)
            }
            Err(e) => Err(io_fwd(e)),
        }
    })();
    let _ = rm_rf(&staging);
    let _ = fs::remove_file(&pending);
    result
}

/// `ensureCodexProjectTrust(configToml, projectPath)`.
fn ensure_project_trust(toml: &str, project_path: &str) -> String {
    let key = format!("[projects.{}]", quoted(&resolve(&[project_path])));
    if toml.contains(&key) {
        return toml.to_owned();
    }
    let suffix = if toml.ends_with('\n') { "" } else { "\n" };
    format!("{toml}{suffix}\n{key}\ntrust_level = \"trusted\"\n")
}

/// `.asp-runtime.json`; the fingerprint only once the sync is complete.
fn runtime_metadata(h: &Home, fingerprint: &str, complete: bool) -> J {
    let mut m = J::obj([
        ("schemaVersion", J::Num(1.0)),
        ("harnessId", J::str("codex")),
        ("mode", J::str("project")),
        ("targetName", J::str(h.target_name)),
        ("complete", J::Bool(complete)),
    ]);
    if complete {
        m.set("fingerprint", J::str(fingerprint));
    }
    m.set("projectPath", J::str(resolve(&[h.cwd])));
    m
}

/// Rewrite `home` from `template` (the caller holds the lock). Recognisably
/// incomplete while it is synced (T-13018 r2 2.1): a sync that fails partway
/// leaves a home no fingerprint matches, and the next compile syncs it again
/// in full. `complete: true` and the fingerprint are written last.
fn sync_home(
    h: &Home,
    template: &str,
    home: &str,
    fingerprint: &str,
    block: Option<&str>,
) -> Result<(), Fwd> {
    let metadata_path = join(&[home, ".asp-runtime.json"]);
    write_json(&metadata_path, &runtime_metadata(h, fingerprint, false))?;
    for rel in MANAGED_FILES {
        sync_managed_file(template, home, rel)?;
    }
    for rel in MANAGED_DIRS {
        sync_managed_dir(template, home, rel, fingerprint)?;
    }
    let config_path = join(&[home, "config.toml"]);
    let hooks_path = join(&[home, "hooks.json"]);
    if h.interactive {
        let space_path = join(&[home, "space-hooks.json"]);
        let space = if exists(&space_path) {
            read_json(&space_path, crate::reason!("codex_space_hooks_json"))?
        } else {
            J::obj([("hooks", J::Obj(vec![]))])
        };
        let events = h.hook_events.unwrap_or(&INTERACTIVE_HOOK_EVENTS);
        write_json(
            &hooks_path,
            &merge_hooks(&[&hrc_hooks_config(events), &space]),
        )?;
    }
    if exists(&config_path) {
        let mut toml = read_text(&config_path)?;
        if exists(&hooks_path) {
            toml = trust_config_toml(
                &toml,
                &hooks_path,
                &read_json(&hooks_path, crate::reason!("codex_hooks_json_invalid"))?,
                &[join(&[template, "hooks.json"])],
            )?;
        }
        toml = ensure_project_trust(&toml, h.cwd);
        write(&config_path, &toml)?;
    }
    apply_praesidium(home, block)?;
    write_json(&metadata_path, &runtime_metadata(h, fingerprint, true))
}

/// `prepareCodexRuntimeHome(bundle, runOptions)`: the home's path, with the
/// home rewritten under its lock unless its fingerprint already matches.
pub fn prepare_runtime_home(h: &Home) -> Result<String, Fwd> {
    let template = join(&[h.bundle_root, "codex.home"]);
    let home = home_path(h.asp_home, h.project_id, h.target_name);
    let block = praesidium_block(h.system_prompt, h.reminder);
    let config_hash = fs::read(join(&[&template, "config.toml"]))
        .ok()
        .map(|b| sha256_hex(&b));
    let fingerprint = runtime_fingerprint(h, block.as_deref(), config_hash.as_deref());
    mkdirp(&home)?;
    let written = lockfile::with_lock(
        &join(&[&home, ".asp-runtime.lock"]),
        &MATERIALIZATION,
        || -> Result<(), Fwd> {
            if home_matches(&home, &fingerprint) {
                return Ok(());
            }
            sync_home(h, &template, &home, &fingerprint, block.as_deref())
        },
    )
    .map_err(lock_fwd(crate::reason!("codex_home_lock")))?;
    written?;
    Ok(home)
}
