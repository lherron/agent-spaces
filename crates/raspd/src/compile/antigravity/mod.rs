//! Native Antigravity CLI compile inputs shared by launch and observation.
use crate::json::J;
use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;

pub(super) mod hooks;
pub(super) mod plugins;
pub(crate) mod runtime_home;

pub(super) const HARNESS_ID: &str = "antigravity-hrcpty";
pub(super) const FRONTEND: &str = "antigravity-cli";
pub(super) const DRIVER: &str = "antigravity-cli-hrcpty";
pub(super) const HOOK_BIN_DIR: &str = "HARNESS_BROKER_HOOK_BIN_DIR";
const HOOK_COMMAND: &str = r#""${HARNESS_BROKER_HOOK_BIN_DIR:?}/harness-broker" antigravity-hook"#;

pub(crate) fn find_binary(env: &BTreeMap<String, String>) -> Option<String> {
    std::env::split_paths(env.get("PATH")?)
        .filter(|entry| entry.is_absolute())
        .map(|entry| entry.join("agy"))
        .find(|candidate| {
            candidate
                .metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
        .and_then(|path| path.into_os_string().into_string().ok())
}

pub(super) fn bypass_enabled(req: &J, yolo: bool) -> bool {
    match req.get("hrcPolicy").and_then(|p| p.get("permissionPolicy")) {
        None => yolo,
        Some(policy) => policy.get("mode").and_then(J::as_str) == Some("allow"),
    }
}
