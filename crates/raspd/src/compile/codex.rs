//! The codex-app-server recipe's materialization, with Bun's write rules:
//! the Codex adapter's `detect`/`materializeSpace`/`composeTarget`/
//! `loadTargetBundle` (drivers/harness-codex/src/adapters/codex-adapter.ts and
//! its codex-config, codex-agents, codex-hooks helpers) and the stable runtime
//! home (drivers/execution/src/run-codex.ts `prepareCodexRuntimeHome`),
//! materialized under `.asp-runtime.lock` and gated by its `.asp-runtime.json`
//! fingerprint. The bundle publish, lock and prune protocol is stage.rs's.
use super::lockfile::{self, MATERIALIZATION};
use super::stage::{
    Artifact, SpacePlan, copy_dir, copy_file, io_fwd, is_dir_follow, mkdirp, rm_rf, write,
};
use super::util::{canonicalize, js_trim, js_trim_end, now_iso, random_uuid, sha256_hex};
use super::{Fwd, fwd, iarna, truthy};
use crate::json::{J, quoted};
use crate::reads::jspath::{join, relative, resolve};
use std::fs;
use std::os::unix::fs::symlink;
use std::sync::Mutex;

/// `DEFAULT_CODEX_ENABLED_FEATURES` (core/config/src/core/codex-launch.ts).
pub const DEFAULT_FEATURES: [&str; 1] = ["goals"];
/// The CodexAdapter's `models` ids: a runtime plan's model must be one.
pub const ADAPTER_MODELS: [&str; 13] = [
    "gpt-5.6-terra",
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.3-codex",
    "gpt-5.3",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
];
/// The hook events a presented (codex-tui) birth captures (compile-broker-plan.ts).
pub const TUI_HOOK_EVENTS: [&str; 2] = ["Stop", "PostToolUse"];
const INTERACTIVE_HOOK_EVENTS: [&str; 6] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
];

fn exists(path: &str) -> bool {
    fs::metadata(path).is_ok()
}

fn read_text(path: &str) -> Result<String, Fwd> {
    fs::read(path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .map_err(io_fwd)
}

fn write_json(path: &str, value: &J) -> Result<(), Fwd> {
    write(path, &format!("{}\n", value.to_json_pretty()))
}

fn parse_json(text: &str, reason: &'static str) -> Result<J, Fwd> {
    crate::json::parse(text.as_bytes()).ok_or_else(|| fwd(reason))
}

/// JS `a < b` on strings: UTF-16 code units.
fn js_sort(names: &mut [String]) {
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

// -- detection (CodexAdapter.detect, codex-discovery.ts) ------------------------

/// Successful probes by candidate, keyed by the binary's (target, mtime, size);
/// failures are never cached, as in Bun's long-lived compiler.
static DETECTED: Mutex<Vec<(String, String)>> = Mutex::new(vec![]);

fn binary_fingerprint(candidate: &str) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let target = fs::canonicalize(candidate).ok()?;
    let meta = fs::metadata(&target).ok()?;
    Some(format!(
        "{}:{}:{}:{}",
        target.to_string_lossy(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.size()
    ))
}

fn candidates() -> Vec<String> {
    let env = super::util::exec_environment();
    let home = crate::reads::homedir();
    let mut out: Vec<String> = vec![env.get("ASP_CODEX_PATH").cloned().unwrap_or_default()];
    if env.get("ASP_CODEX_SKIP_COMMON_PATHS").map(String::as_str) != Some("1") {
        out.push(join(&[&home, ".local", "bin", "codex"]));
        out.push(join(&[&home, ".bun", "bin", "codex"]));
        let nvm = join(&[&home, ".nvm", "versions", "node"]);
        if let Ok(read) = fs::read_dir(&nvm) {
            for entry in read.flatten() {
                if entry.file_type().is_ok_and(|t| t.is_dir()) {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    out.push(join(&[&nvm, &name, "bin", "codex"]));
                }
            }
        }
        out.push("/opt/homebrew/bin/codex".into());
        out.push("/usr/local/bin/codex".into());
    }
    for dir in env
        .get("PATH")
        .map(String::as_str)
        .unwrap_or_default()
        .split(':')
        .filter(|d| !d.is_empty())
    {
        out.push(join(&[dir, "codex"]));
    }
    let mut seen: Vec<String> = vec![];
    out.into_iter()
        .filter(|c| {
            if c.is_empty() || seen.contains(c) {
                return false;
            }
            seen.push(c.clone());
            true
        })
        .collect()
}

/// `runCommand(argv)`: exit code and stdout, with a 15 s deadline and the
/// process env minus `HARNESS_BROKER_*`.
fn run(argv: &[&str]) -> Option<(i32, String, String)> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let env = super::util::exec_environment();
    let mut child = Command::new(argv[0])
        .args(&argv[1..])
        .env_clear()
        .envs(env.iter().filter(|(k, _)| !k.starts_with("HARNESS_BROKER_")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let mut err = child.stderr.take()?;
    let out_reader = std::thread::spawn(move || {
        let mut b = vec![];
        let _ = out.read_to_end(&mut b);
        String::from_utf8_lossy(&b).into_owned()
    });
    let err_reader = std::thread::spawn(move || {
        let mut b = vec![];
        let _ = err.read_to_end(&mut b);
        String::from_utf8_lossy(&b).into_owned()
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    status.map(|s| (s.code().unwrap_or(0), stdout, stderr))
}

fn version_at_least(version: &str, min: [u64; 3]) -> bool {
    let Some(parsed) = semver(version) else {
        return false;
    };
    parsed >= min
}

/// The first `\d+\.\d+\.\d+` in `text`.
fn semver(text: &str) -> Option<[u64; 3]> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let mut parts = [0u64; 3];
            let mut j = i;
            let mut ok = true;
            for (n, part) in parts.iter_mut().enumerate() {
                let start = j;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j == start {
                    ok = false;
                    break;
                }
                *part = text[start..j].parse().unwrap_or(u64::MAX);
                if n < 2 {
                    if j < bytes.len() && bytes[j] == b'.' {
                        j += 1;
                    } else {
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                return Some(parts);
            }
        }
        i += 1;
    }
    None
}

fn probe(candidate: &str) -> bool {
    let Some((code, stdout, stderr)) = run(&[candidate, "--version"]) else {
        return false;
    };
    if code != 0 {
        return false;
    }
    let output = if js_trim(&stdout).is_empty() {
        js_trim(&stderr)
    } else {
        js_trim(&stdout)
    };
    if semver(output).is_none() || !version_at_least(output, [0, 124, 0]) {
        return false;
    }
    matches!(run(&[candidate, "app-server", "--help"]), Some((0, _, _)))
}

/// `codexAdapter.detect()`: the first available candidate's path, or a
/// forward where Bun throws "Harness codex is not available".
pub fn detect() -> Result<String, Fwd> {
    for candidate in candidates() {
        if !exists(&candidate) {
            continue;
        }
        let fingerprint = binary_fingerprint(&candidate);
        if let Some(fp) = &fingerprint {
            let cache = DETECTED.lock().unwrap_or_else(|e| e.into_inner());
            if cache.iter().any(|(c, f)| *c == candidate && f == fp) {
                return Ok(candidate);
            }
        }
        if probe(&candidate) {
            if let Some(fp) = fingerprint {
                let mut cache = DETECTED.lock().unwrap_or_else(|e| e.into_inner());
                cache.retain(|(c, _)| *c != candidate);
                cache.push((candidate.clone(), fp));
            }
            return Ok(candidate);
        }
    }
    Err(fwd("codex_unavailable"))
}

// -- space artifacts (CodexAdapter.materializeSpace) ------------------------------

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

/// `materializeSpace(input, dir, { force: false, useHardlinks: false })`.
pub fn materialize_space(plan: &SpacePlan, dir: &str) -> Result<(), Fwd> {
    let result = (|| {
        let src = &plan.input.content_dir;
        mkdirp(dir)?;
        let codex = plan.manifest.get("codex");
        let enabled = |k: &str| {
            codex
                .and_then(|c| c.get(k))
                .and_then(|s| s.get("enabled"))
                != Some(&J::Bool(false))
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

// -- hooks (codex-hooks.ts) ---------------------------------------------------------

const HRC_HOOK_COMMAND: &str =
    "if [ -n \"${HRC_LAUNCH_HOOK_CLI:-}\" ]; then bun \"$HRC_LAUNCH_HOOK_CLI\"; fi";
const EVENT_LABELS: [(&str, &str); 8] = [
    ("PreToolUse", "pre_tool_use"),
    ("PermissionRequest", "permission_request"),
    ("PostToolUse", "post_tool_use"),
    ("PreCompact", "pre_compact"),
    ("PostCompact", "post_compact"),
    ("SessionStart", "session_start"),
    ("UserPromptSubmit", "user_prompt_submit"),
    ("Stop", "stop"),
];
const EVENTS_WITH_MATCHERS: [&str; 6] = [
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SessionStart",
];

/// `buildHrcCodexHooksConfig(events)`.
fn hrc_hooks_config(events: &[&str]) -> J {
    let mut hooks = J::Obj(vec![]);
    for event in events {
        let status = if *event == "Stop" {
            "capturing Codex turn".to_owned()
        } else {
            format!("capturing Codex {event}")
        };
        let handler = J::obj([
            ("type", J::str("command")),
            ("command", J::str(HRC_HOOK_COMMAND)),
            ("statusMessage", J::str(status)),
        ]);
        let group = if EVENTS_WITH_MATCHERS.contains(event) {
            J::obj([("matcher", J::str("")), ("hooks", J::Arr(vec![handler]))])
        } else {
            J::obj([("hooks", J::Arr(vec![handler]))])
        };
        hooks.set(event, J::Arr(vec![group]));
    }
    J::obj([("hooks", hooks)])
}

/// `/^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/`.
fn safe_hook_path(p: &str) -> bool {
    !p.is_empty()
        && p
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
        && !p.split('/').any(|seg| seg == "..")
}

/// `buildCodexSpaceHooksConfig(spaces)`; an unsafe path throws in Bun.
fn space_hooks_config(spaces: &[(String, J)]) -> Result<J, Fwd> {
    let mut hooks = J::Obj(vec![]);
    for (space_id, list) in spaces {
        for hook in list.as_arr().into_iter().flatten() {
            if hook.get("event").and_then(J::as_str) != Some("pre_tool_use") {
                continue;
            }
            let script = hook.get("script").and_then(J::as_str).unwrap_or_default();
            if !safe_hook_path(space_id) || !safe_hook_path(script) {
                return Err(fwd("codex_space_hook_unsafe"));
            }
            let command = format!(
                "p=\"${{CODEX_HOME:-}}/space-hooks/{space_id}/{script}\"; [ -x \"$p\" ] || exit 0; exec \"$p\""
            );
            let matcher = match hook.get("tools").and_then(J::as_arr) {
                None => String::new(),
                Some(tools) if tools.iter().any(|t| t.as_str() == Some("*")) => String::new(),
                Some(tools) => tools
                    .iter()
                    .map(|t| t.as_str().unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join("|"),
            };
            let mut groups = hooks
                .get("PreToolUse")
                .and_then(J::as_arr)
                .cloned()
                .unwrap_or_default();
            groups.push(J::obj([
                ("matcher", J::str(matcher)),
                (
                    "hooks",
                    J::Arr(vec![J::obj([
                        ("type", J::str("command")),
                        ("command", J::str(command)),
                    ])]),
                ),
            ]));
            hooks.set("PreToolUse", J::Arr(groups));
        }
    }
    Ok(J::obj([("hooks", hooks)]))
}

/// `mergeCodexHooksConfigs(...configs)`.
fn merge_hooks(configs: &[&J]) -> J {
    let mut merged = J::Obj(vec![]);
    for config in configs {
        let Some(root @ J::Obj(_)) = config.get("hooks") else {
            continue;
        };
        for (event, groups) in root.js_entries() {
            let J::Arr(groups) = groups else { continue };
            let mut list = merged
                .get(event)
                .and_then(J::as_arr)
                .cloned()
                .unwrap_or_default();
            list.extend(groups.iter().cloned());
            merged.set(event, J::Arr(list));
        }
    }
    J::obj([("hooks", merged)])
}

/// `canonicalHookTrustPath`: resolved, then realpath when it exists.
fn trust_path(hooks_path: &str) -> String {
    let resolved = resolve(&[hooks_path]);
    fs::canonicalize(&resolved)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(resolved)
}

/// `buildCodexHookTrustState(hooksPath, hooksConfig)`, in insertion order.
fn trust_state(hooks_path: &str, hooks_config: &J) -> Vec<(String, J)> {
    let root = match hooks_config.get("hooks") {
        Some(r @ J::Obj(_)) => r.clone(),
        _ => J::Obj(vec![]),
    };
    let source = trust_path(hooks_path);
    let mut out = vec![];
    for (event, label) in EVENT_LABELS {
        let Some(J::Arr(groups)) = root.get(event) else {
            continue;
        };
        for (gi, group) in groups.iter().enumerate() {
            if !group.is_record() {
                continue;
            }
            let matcher = match group.get("matcher") {
                Some(J::Str(m)) if EVENTS_WITH_MATCHERS.contains(&event) => Some(m.clone()),
                _ => None,
            };
            let Some(J::Arr(handlers)) = group.get("hooks") else {
                continue;
            };
            for (hi, handler) in handlers.iter().enumerate() {
                if !handler.is_record()
                    || handler.get("type") != Some(&J::str("command"))
                    || handler.get("async") == Some(&J::Bool(true))
                {
                    continue;
                }
                let Some(J::Str(command)) = handler.get("command") else {
                    continue;
                };
                if js_trim(command).is_empty() {
                    continue;
                }
                let timeout = match handler.get("timeout") {
                    Some(J::Num(n)) if n.is_finite() => n.trunc().max(1.0),
                    _ => 600.0,
                };
                let mut normalized = J::obj([
                    ("type", J::str("command")),
                    ("command", J::str(command)),
                    ("timeout", J::Num(timeout)),
                    ("async", J::Bool(false)),
                ]);
                if let Some(J::Str(s)) = handler.get("statusMessage") {
                    normalized.set("statusMessage", J::str(s));
                }
                let mut identity = J::obj([("event_name", J::str(label))]);
                if let Some(m) = &matcher {
                    identity.set("matcher", J::str(m));
                }
                identity.set("hooks", J::Arr(vec![normalized]));
                out.push((
                    format!("{source}:{label}:{gi}:{hi}"),
                    J::obj([(
                        "trusted_hash",
                        J::str(format!("sha256:{}", super::util::hash(&identity, false))),
                    )]),
                ));
            }
        }
    }
    out
}

/// `addCodexHookTrustState(config, hooksPath, hooksConfig, { replaceHooksPaths })`:
/// `None` when there is nothing to trust (Bun returns the config itself).
fn add_trust_state(config: &J, hooks_path: &str, hooks_config: &J, stale: &[String]) -> Option<J> {
    let trust = trust_state(hooks_path, hooks_config);
    if trust.is_empty() {
        return None;
    }
    let mut hooks = match config.get("hooks") {
        Some(h @ J::Obj(_)) => h.clone(),
        _ => J::Obj(vec![]),
    };
    let mut state = match hooks.get("state") {
        Some(s @ J::Obj(_)) => s.clone(),
        _ => J::Obj(vec![]),
    };
    let source = trust_path(hooks_path);
    for stale_path in stale {
        let stale_source = trust_path(stale_path);
        for (key, _) in &trust {
            state.remove(&format!("{stale_source}{}", &key[source.len()..]));
        }
    }
    for (key, value) in trust {
        let mut merged = match state.get(&key) {
            Some(e @ J::Obj(_)) => e.clone(),
            _ => J::Obj(vec![]),
        };
        for (k, v) in value.js_entries() {
            merged.set(k, v.clone());
        }
        state.set(&key, merged);
    }
    hooks.set("state", state);
    let mut out = config.clone();
    out.set("hooks", hooks);
    Some(out)
}

/// `trustCodexHooksInConfigToml(configToml, hooksPath, hooksJson, { replaceHooksPaths })`.
fn trust_config_toml(
    toml: &str,
    hooks_path: &str,
    hooks_json: &str,
    stale: &[String],
) -> Result<String, Fwd> {
    let hooks_config = parse_json(hooks_json, "codex_hooks_json_invalid")?;
    let parsed = match crate::reads::toml::parse(toml) {
        Ok(v) => v,
        Err(crate::reads::toml::TomlError::Unsupported(r)) => return Err(fwd(r)),
        Err(_) => return Err(fwd("codex_config_toml_invalid")),
    };
    match add_trust_state(&parsed, hooks_path, &hooks_config, stale) {
        None => Ok(toml.to_owned()),
        Some(updated) => Ok(format!("{}\n", iarna::stringify(&updated)?)),
    }
}

// -- config.toml (codex-config.ts) ------------------------------------------------

/// `applyDottedKey(target, dottedKey, value)`.
fn apply_dotted(target: &mut J, dotted: &str, value: J) {
    let parts: Vec<&str> = dotted.split('.').filter(|p| !p.is_empty()).collect();
    let Some((last, path)) = parts.split_last() else {
        return;
    };
    let mut cursor = target;
    for part in path {
        if !matches!(cursor.get(part), Some(J::Obj(_))) {
            cursor.set(part, J::Obj(vec![]));
        }
        let J::Obj(fields) = cursor else { return };
        cursor = &mut fields
            .iter_mut()
            .find(|(k, _)| k == part)
            .expect("set above")
            .1;
    }
    cursor.set(last, value);
}

fn non_empty(v: &J) -> bool {
    match v {
        J::Arr(a) => !a.is_empty(),
        J::Str(s) => !s.is_empty(),
        J::Obj(f) => !f.is_empty(),
        _ => false,
    }
}

/// `buildCodexConfig(mcpConfig, overrides)`.
fn codex_config(servers: &[(String, J)], overrides: &[J]) -> J {
    let mut base = J::obj([
        ("model", J::str("gpt-5.6-terra")),
        ("model_reasoning_effort", J::str("high")),
        ("model_reasoning_summary", J::str("detailed")),
        ("sandbox_mode", J::str("workspace-write")),
        ("approval_policy", J::str("on-request")),
        (
            "project_doc_fallback_filenames",
            J::Arr(vec![J::str("AGENTS.md"), J::str("AGENT.md")]),
        ),
        ("check_for_update_on_startup", J::Bool(false)),
        (
            "tui",
            J::obj([(
                "status_line",
                J::Arr(
                    ["model-with-reasoning", "context-remaining", "current-dir"]
                        .map(J::str)
                        .to_vec(),
                ),
            )]),
        ),
    ]);
    if !servers.is_empty() {
        let mut mcp = J::Obj(vec![]);
        for (name, server) in servers {
            let mut entry = J::Obj(vec![]);
            if let Some(c) = server.get("command") {
                entry.set("command", c.clone());
            }
            entry.set("enabled", J::Bool(true));
            if let Some(a) = server.get("args").filter(|a| non_empty(a)) {
                entry.set("args", a.clone());
            }
            if let Some(e) = server.get("env").filter(|e| non_empty(e)) {
                entry.set("env", e.clone());
            }
            mcp.set(name, entry);
        }
        base.set("mcp_servers", mcp);
    }
    for o in overrides {
        for (k, v) in o.js_entries() {
            apply_dotted(&mut base, k, v.clone());
        }
    }
    let mut features = match base.get("features") {
        Some(f @ J::Obj(_)) => f.clone(),
        _ => J::Obj(vec![]),
    };
    features.set("hooks", J::Bool(true));
    base.set("features", features);
    base
}

/// `renderCodexConfigToml(config)`: canonical JSON round trip, then iarna.
fn render_config(config: &J) -> Result<String, Fwd> {
    let canonical = parse_json(&canonicalize(config, false), "codex_config_json")?;
    let text = iarna::stringify(&canonical)?;
    Ok(format!("{}\n", text.trim_end_matches('\n')))
}

// -- AGENTS.md (codex-agents.ts) ----------------------------------------------------

const PRAESIDIUM_BEGIN: &str = "<!-- BEGIN praesidium-context -->";
const PRAESIDIUM_END: &str = "<!-- END praesidium-context -->";

fn agents_markdown(blocks: &[(String, String, String)]) -> String {
    let mut lines = vec!["<!-- Generated by agent-spaces. -->".to_owned()];
    for (space_id, version, content) in blocks {
        lines.push(String::new());
        lines.push(format!("<!-- BEGIN space: {space_id}@{version} -->"));
        lines.push(js_trim_end(content).to_owned());
        lines.push(format!("<!-- END space: {space_id}@{version} -->"));
    }
    lines.push(String::new());
    lines.join("\n")
}

/// `renderPraesidiumContextBlock({ systemPrompt, reminderContent })`.
pub fn praesidium_block(system_prompt: Option<&str>, reminder: Option<&str>) -> Option<String> {
    let sp = system_prompt.map(js_trim).unwrap_or_default();
    let rem = reminder.map(js_trim).unwrap_or_default();
    if sp.is_empty() && rem.is_empty() {
        return None;
    }
    let sections: Vec<&str> = [sp, rem].into_iter().filter(|s| !s.is_empty()).collect();
    Some([PRAESIDIUM_BEGIN, &sections.join("\n\n"), PRAESIDIUM_END].join("\n"))
}

fn strip_praesidium(content: &str) -> String {
    let mut remaining = content.to_owned();
    loop {
        let Some(begin) = remaining.find(PRAESIDIUM_BEGIN) else {
            return remaining;
        };
        let Some(end) = remaining[begin..].find(PRAESIDIUM_END).map(|e| e + begin) else {
            return remaining;
        };
        remaining = format!(
            "{}{}",
            &remaining[..begin],
            &remaining[end + PRAESIDIUM_END.len()..]
        );
    }
}

/// `applyPraesidiumContextToCodexHome(home, context)`.
fn apply_praesidium(home: &str, block: Option<&str>) -> Result<(), Fwd> {
    let path = join(&[home, "AGENTS.md"]);
    let existing = fs::read(&path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let stripped = js_trim_end(&strip_praesidium(&existing)).to_owned();
    match block {
        None => {
            if stripped != js_trim_end(&existing) {
                let next = if stripped.is_empty() {
                    String::new()
                } else {
                    format!("{stripped}\n")
                };
                write(&path, &next)?;
            }
            Ok(())
        }
        Some(block) => {
            let next = if stripped.is_empty() {
                format!("{block}\n")
            } else {
                format!("{stripped}\n\n{block}\n")
            };
            write(&path, &next)
        }
    }
}

// -- the target bundle (CodexAdapter.composeTarget / loadTargetBundle) ---------------

pub struct Bundle {
    pub root_dir: String,
    pub home: String,
}

/// `linkOrCopy(src, dest)`.
fn link_or_copy(src: &str, dest: &str) -> Result<(), Fwd> {
    mkdirp(&crate::reads::jspath::dirname(dest))?;
    match fs::hard_link(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if matches!(e.raw_os_error(), Some(libc::EXDEV | libc::EPERM | libc::ENOTSUP)) => {
            copy_file(src, dest)
        }
        Err(e) => Err(io_fwd(e)),
    }
}

/// `CodexAdapter.composeTarget(input, outputDir, { clean: true })`: the
/// bundle and the paths its manifest requires.
pub fn compose_target(
    artifacts: &[Artifact],
    output: &str,
    target_name: &str,
    codex_options: Option<&J>,
) -> Result<(Bundle, Vec<String>), Fwd> {
    let _ = rm_rf(output);
    mkdirp(output)?;
    let home = join(&[output, "codex.home"]);
    let skills_dir = join(&[&home, "skills"]);
    let prompts_dir = join(&[&home, "prompts"]);
    mkdirp(&skills_dir)?;
    mkdirp(&prompts_dir)?;
    let mut blocks: Vec<(String, String, String)> = vec![];
    let mut instruction_hashes: Vec<J> = vec![];
    let mut overrides: Vec<J> = vec![];
    let mut merged_skills: Vec<String> = vec![];
    let mut merged_prompts: Vec<String> = vec![];
    let mut hook_sets: Vec<(String, J)> = vec![];
    for a in artifacts {
        let src_skills = join(&[&a.path, "skills"]);
        if is_dir_follow(&src_skills) {
            let mut entries: Vec<(String, fs::FileType)> = vec![];
            for e in fs::read_dir(&src_skills).map_err(io_fwd)? {
                let e = e.map_err(io_fwd)?;
                entries.push((
                    e.file_name().to_string_lossy().into_owned(),
                    e.file_type().map_err(io_fwd)?,
                ));
            }
            entries.sort_by(|x, y| x.0.encode_utf16().cmp(y.0.encode_utf16()));
            for (name, ft) in entries {
                let src = join(&[&src_skills, &name]);
                if !ft.is_dir() && !(ft.is_symlink() && is_dir_follow(&src)) {
                    continue;
                }
                let dest = join(&[&skills_dir, &name]);
                rm_rf(&dest)?;
                if ft.is_symlink() {
                    symlink(fs::read_link(&src).map_err(io_fwd)?, &dest).map_err(io_fwd)?;
                } else {
                    copy_dir(&src, &dest, true)?;
                }
                if !merged_skills.contains(&name) {
                    merged_skills.push(name);
                }
            }
        }
        let src_prompts = join(&[&a.path, "prompts"]);
        if is_dir_follow(&src_prompts) {
            for e in fs::read_dir(&src_prompts).map_err(io_fwd)? {
                let e = e.map_err(io_fwd)?;
                let name = e.file_name().to_string_lossy().into_owned();
                if !e.file_type().map_err(io_fwd)?.is_file() || !name.ends_with(".md") {
                    continue;
                }
                let dest = join(&[&prompts_dir, &name]);
                let _ = fs::remove_file(&dest);
                link_or_copy(&join(&[&src_prompts, &name]), &dest)?;
                if !merged_prompts.contains(&name) {
                    merged_prompts.push(name);
                }
            }
        }
        let instructions = join(&[&a.path, "instructions.md"]);
        if exists(&instructions) {
            let content = read_text(&instructions)?;
            instruction_hashes.push(J::obj([
                ("spaceId", J::str(&a.space_id)),
                ("version", J::str(&a.plugin_version)),
                ("hash", J::str(sha256_hex(content.as_bytes()))),
            ]));
            blocks.push((a.space_id.clone(), a.plugin_version.clone(), content));
        }
        let config = join(&[&a.path, "codex.config.json"]);
        if exists(&config) {
            overrides.push(parse_json(&read_text(&config)?, "codex_config_json")?);
        }
        let space_hooks = join(&[&a.path, "space-hooks.json"]);
        if exists(&space_hooks) {
            let hooks = parse_json(&read_text(&space_hooks)?, "codex_space_hooks_json")?;
            let dest = join(&[&home, "space-hooks", &a.space_id, "hooks"]);
            rm_rf(&dest)?;
            copy_dir(&join(&[&a.path, "hooks"]), &dest, true)?;
            hook_sets.push((a.space_id.clone(), hooks));
        }
    }
    if let Some(options) = codex_options {
        let mut target = J::Obj(vec![]);
        for (field, key) in [
            ("model", "model"),
            ("model_reasoning_effort", "model_reasoning_effort"),
            ("model_reasoning_summary", "model_reasoning_summary"),
            ("status_line", "tui.status_line"),
            ("approval_policy", "approval_policy"),
            ("sandbox_mode", "sandbox_mode"),
        ] {
            if let Some(v) = options.get(field).filter(|v| truthy(v)) {
                target.set(key, v.clone());
            }
        }
        if matches!(&target, J::Obj(f) if !f.is_empty()) {
            overrides.push(target);
        }
    }
    let agents_path = join(&[&home, "AGENTS.md"]);
    write(&agents_path, &agents_markdown(&blocks))?;

    // composeMcpFromSpaces: later servers override earlier ones of the same name.
    let mut servers: Vec<(String, J)> = vec![];
    for a in artifacts {
        let path = join(&[&a.path, "mcp", "mcp.json"]);
        if !fs::metadata(&path).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let Some(config) = fs::read(&path).ok().and_then(|t| crate::json::parse(&t)) else {
            continue;
        };
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
    let mcp_path = join(&[&home, "mcp.json"]);
    if !servers.is_empty() {
        write_json(
            &mcp_path,
            &J::obj([("mcpServers", J::Obj(servers.clone()))]),
        )?;
    }

    let space_hooks = space_hooks_config(&hook_sets)?;
    let fragment = join(&[&home, "space-hooks.json"]);
    let _ = fs::remove_file(&fragment);
    if !hook_sets.is_empty() {
        write_json(&fragment, &space_hooks)?;
    }
    let hooks_path = join(&[&home, "hooks.json"]);
    let hooks_config = merge_hooks(&[&hrc_hooks_config(&["Stop"]), &space_hooks]);
    let base = codex_config(&servers, &overrides);
    let config = add_trust_state(&base, &hooks_path, &hooks_config, &[]).unwrap_or(base);
    write(&join(&[&home, "config.toml"]), &render_config(&config)?)?;
    write_json(&hooks_path, &hooks_config)?;

    let user_auth = join(&[&crate::reads::homedir(), ".codex", "auth.json"]);
    let dest_auth = join(&[&home, "auth.json"]);
    let _ = fs::remove_file(&dest_auth);
    if exists(&user_auth) {
        let _ = symlink(&user_auth, &dest_auth);
    }

    js_sort(&mut merged_skills);
    js_sort(&mut merged_prompts);
    let mut server_names: Vec<String> = servers.iter().map(|(n, _)| n.clone()).collect();
    js_sort(&mut server_names);
    let manifest = J::obj([
        ("schemaVersion", J::Num(1.0)),
        ("harnessId", J::str("codex")),
        ("targetName", J::str(target_name)),
        ("generatedAt", J::str(now_iso())),
        (
            "spaces",
            J::Arr(
                artifacts
                    .iter()
                    .map(|a| {
                        J::obj([
                            ("spaceId", J::str(&a.space_id)),
                            ("spaceKey", J::str(&a.space_key)),
                            ("version", J::str(&a.plugin_version)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "skills",
            J::Arr(merged_skills.into_iter().map(J::Str).collect()),
        ),
        (
            "prompts",
            J::Arr(merged_prompts.into_iter().map(J::Str).collect()),
        ),
        (
            "mcpServers",
            J::Arr(server_names.into_iter().map(J::Str).collect()),
        ),
        ("instructions", J::Arr(instruction_hashes)),
    ]);
    write_json(&join(&[&home, "manifest.json"]), &manifest)?;

    let mcp_config_path = (!servers.is_empty()).then_some(mcp_path);
    let mut required = vec![home.clone()];
    if let Some(m) = &mcp_config_path {
        required.push(m.clone());
    }
    Ok((
        Bundle {
            root_dir: output.to_owned(),
            home,
        },
        required,
    ))
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
        return Err(fwd("codex_bundle_invalid"));
    }
    Ok(Bundle {
        root_dir: output.to_owned(),
        home,
    })
}

// -- the runtime home (run-codex.ts) --------------------------------------------------

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
            super::util::sanitize_segment(project_id),
            super::util::sanitize_segment(target_name)
        ),
    ])
}

/// `computeCodexRuntimeFingerprint(input)`.
pub fn runtime_fingerprint(h: &Home, block: Option<&str>, config_hash: Option<&str>) -> String {
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
            for rel in MANAGED_FILES {
                sync_managed_file(&template, &home, rel)?;
            }
            for rel in MANAGED_DIRS {
                sync_managed_dir(&template, &home, rel, &fingerprint)?;
            }
            let config_path = join(&[&home, "config.toml"]);
            let hooks_path = join(&[&home, "hooks.json"]);
            if h.interactive {
                let space_path = join(&[&home, "space-hooks.json"]);
                let space = if exists(&space_path) {
                    parse_json(&read_text(&space_path)?, "codex_space_hooks_json")?
                } else {
                    J::obj([("hooks", J::Obj(vec![]))])
                };
                let events = h.hook_events.unwrap_or(&INTERACTIVE_HOOK_EVENTS);
                write_json(&hooks_path, &merge_hooks(&[&hrc_hooks_config(events), &space]))?;
            }
            if exists(&config_path) {
                let mut toml = read_text(&config_path)?;
                if exists(&hooks_path) {
                    toml = trust_config_toml(
                        &toml,
                        &hooks_path,
                        &read_text(&hooks_path)?,
                        &[join(&[&template, "hooks.json"])],
                    )?;
                }
                toml = ensure_project_trust(&toml, h.cwd);
                write(&config_path, &toml)?;
            }
            apply_praesidium(&home, block.as_deref())?;
            let metadata = J::obj([
                ("schemaVersion", J::Num(1.0)),
                ("harnessId", J::str("codex")),
                ("mode", J::str("project")),
                ("targetName", J::str(h.target_name)),
                ("complete", J::Bool(true)),
                ("fingerprint", J::str(&fingerprint)),
                ("projectPath", J::str(resolve(&[h.cwd]))),
            ]);
            write_json(&join(&[&home, ".asp-runtime.json"]), &metadata)
        },
    )
    .map_err(|_| fwd("codex_home_lock"))?;
    written?;
    Ok(home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_finds_the_first_triple() {
        assert_eq!(semver("codex-cli 0.157.1"), Some([0, 157, 1]));
        assert_eq!(semver("v1.2"), None);
        assert!(version_at_least("codex-cli 0.124.0", [0, 124, 0]));
        assert!(!version_at_least("codex-cli 0.123.9", [0, 124, 0]));
    }

    #[test]
    fn hook_paths_refuse_parent_segments() {
        assert!(safe_hook_path("guard/pre.sh"));
        assert!(!safe_hook_path("../x"));
        assert!(!safe_hook_path("a/../x"));
        assert!(safe_hook_path("a/..b"));
        assert!(!safe_hook_path("a b"));
    }

    #[test]
    fn praesidium_block_replaces_in_place() {
        let dir = std::env::temp_dir().join(format!("raspd-codex-{}", random_uuid()));
        let home = dir.to_string_lossy().into_owned();
        fs::create_dir_all(&home).unwrap();
        fs::write(join(&[&home, "AGENTS.md"]), "head\n").unwrap();
        apply_praesidium(&home, praesidium_block(Some(" sp "), Some("rem")).as_deref()).unwrap();
        let once = fs::read_to_string(join(&[&home, "AGENTS.md"])).unwrap();
        assert_eq!(
            once,
            "head\n\n<!-- BEGIN praesidium-context -->\nsp\n\nrem\n<!-- END praesidium-context -->\n"
        );
        apply_praesidium(&home, praesidium_block(Some("sp"), Some("rem")).as_deref()).unwrap();
        assert_eq!(fs::read_to_string(join(&[&home, "AGENTS.md"])).unwrap(), once);
        let _ = fs::remove_dir_all(&home);
    }
}
