//! Persistent home keyed by the canonical seat scope and lane. Only the paths
//! listed in the compile's plugin inventory are retired on a later compile.
use super::HOOK_COMMAND;
use crate::compile::fs_tree::{io_fwd, mkdirp};
use crate::compile::lockfile::{MATERIALIZATION, with_lock};
use crate::compile::materialize::atomic_write;
use crate::compile::plan::Plan;
use crate::compile::temp_lifecycle::materialization_lock_path;
use crate::compile::util::hash;
use crate::compile::{Fwd, fwd, lock_fwd};
use crate::json::J;
use crate::reads::jspath::join;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub(crate) fn seat_key(placement: &J) -> Option<String> {
    let session = placement.get("correlation")?.get("sessionRef")?;
    let scope = session.get("scopeRef")?.as_str()?;
    let lane = session.get("laneRef").and_then(J::as_str).unwrap_or("main");
    let lane = lane.strip_prefix("lane:").unwrap_or(lane);
    if scope.is_empty() || lane.is_empty() {
        return None;
    }
    Some(hash(&J::Arr(vec![J::str(scope), J::str(lane)]), false))
}

pub(crate) fn home_path(asp_home: &str, seat_key: &str) -> String {
    join(&[asp_home, "antigravity-homes", seat_key])
}

pub(in crate::compile) fn artifact_scope(asp_home: &str, seat_key: &str) -> String {
    join(&[asp_home, "antigravity-bundles", seat_key])
}

pub(in crate::compile) fn prepare(
    plan: &Plan,
    seat_key: &str,
    home: &str,
    bundle_root: &str,
) -> Result<(), Fwd> {
    // agy identifies its current workspace by its physical path (e.g.
    // /private/tmp on macOS). Trust that path before the child starts.
    let trusted_workspace = fs::canonicalize(&plan.cwd).map_err(io_fwd)?;
    let lock = materialization_lock_path(&plan.asp_home, &format!("antigravity-{seat_key}"));
    with_lock(&lock, &MATERIALIZATION, || -> Result<(), Fwd> {
        let config = join(&[home, "config"]);
        let cli = join(&[home, "antigravity-cli"]);
        let prompt = plan
            .system_prompt
            .as_ref()
            .and_then(|sp| sp.prompt.as_deref())
            .unwrap_or("");
        atomic_write(&join(&[&config, "AGENTS.md"]), prompt)?;
        sync_plugins(&join(&[bundle_root, "plugins"]), &config)?;
        let settings = J::obj([
            (
                "trustedWorkspaces",
                J::Arr(vec![J::str(trusted_workspace.to_string_lossy())]),
            ),
            (
                "statusLine",
                J::obj([
                    ("type", J::str("command")),
                    (
                        "command",
                        J::str(format!("{HOOK_COMMAND} --event StatusLine")),
                    ),
                ]),
            ),
            ("showTips", J::Bool(false)),
            ("showFeedbackSurvey", J::Bool(false)),
            ("notifications", J::Bool(false)),
        ]);
        atomic_write(&join(&[&cli, "settings.json"]), &settings.to_json_pretty())?;
        let onboarding = J::obj([
            ("consumerOnboardingComplete", J::Bool(true)),
            ("enterpriseOnboardingComplete", J::Bool(false)),
            ("onboardingComplete", J::Bool(true)),
        ]);
        atomic_write(
            &join(&[&cli, "cache", "onboarding.json"]),
            &onboarding.to_json_pretty(),
        )
    })
    .map_err(lock_fwd(crate::reason!("antigravity_home_lock")))?
}

fn sync_plugins(source: &str, config: &str) -> Result<(), Fwd> {
    let dest = Path::new(config).join("plugins");
    let inventory = join(&[config, ".asp-plugin-files.json"]);
    let previous = match fs::read(&inventory) {
        Ok(bytes) => {
            let parsed = crate::json::parse(&bytes);
            parsed
                .as_ref()
                .and_then(J::as_arr)
                .and_then(|paths| {
                    paths
                        .iter()
                        .map(|path| {
                            let path = PathBuf::from(path.as_str()?);
                            (!path.as_os_str().is_empty()
                                && path
                                    .components()
                                    .all(|part| matches!(part, Component::Normal(_))))
                            .then_some(path)
                        })
                        .collect::<Option<BTreeSet<_>>>()
                })
                .ok_or_else(|| fwd(crate::reason!("antigravity_home_inventory")))?
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => BTreeSet::new(),
        Err(err) => return Err(io_fwd(err)),
    };
    let source = Path::new(source);
    let mut current = BTreeSet::new();
    collect_files(source, Path::new(""), &mut current)?;

    // Record newly owned paths before copying so a retry can retire them even
    // if the daemon exits midway through refreshing the home.
    let write_inventory = |paths: Vec<J>| atomic_write(&inventory, &J::Arr(paths).to_json_pretty());
    write_inventory(
        previous
            .union(&current)
            .map(|p| J::str(p.to_string_lossy()))
            .collect(),
    )?;
    for stale in previous.difference(&current) {
        let path = dest.join(stale);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(io_fwd(err)),
        }
        for parent in path.ancestors().skip(1).take_while(|p| *p != dest) {
            if fs::remove_dir(parent).is_err() {
                break;
            }
        }
    }
    for rel in &current {
        let path = dest.join(rel);
        if let Some(parent) = path.parent() {
            mkdirp(&parent.to_string_lossy())?;
        }
        fs::copy(source.join(rel), &path).map_err(io_fwd)?;
    }
    write_inventory(
        current
            .iter()
            .map(|p| J::str(p.to_string_lossy()))
            .collect(),
    )
}

fn collect_files(root: &Path, rel: &Path, files: &mut BTreeSet<PathBuf>) -> Result<(), Fwd> {
    for entry in fs::read_dir(root.join(rel)).map_err(io_fwd)? {
        let entry = entry.map_err(io_fwd)?;
        let path = rel.join(entry.file_name());
        let kind = entry.file_type().map_err(io_fwd)?;
        if kind.is_dir() {
            collect_files(root, &path, files)?;
        } else if kind.is_file() {
            files.insert(path);
        }
    }
    Ok(())
}
