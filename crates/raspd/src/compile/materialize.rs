//! The compile's writes under ASP_HOME's shared lock protocol: the global
//! lock's merge-write, each space's staged plugin artifact and the
//! agent-local plugin, the published target bundle and its prompt artifact,
//! the path filter, then the harness's runtime home and emission.
use super::agent_tools::agent_tool_env;
use super::broker_spec::path_filter_scope;
use super::plan::{Launch, Plan};
use super::util::{self, sanitize_segment, sha256_hex};
use super::workspace_trust::workspace_trust;
use super::{
    Fwd, Phases, codex, emit_claude, emit_codex, fwd, lock_fwd, lock_schema, lockfile, path_filter,
    spaces, stage,
};
use crate::json::J;
use crate::reads::jspath::{basename, dirname, join, resolve};
use crate::release::Release;

pub(super) fn materialize_and_emit(
    plan: Plan,
    release: &Release,
    phases: &mut Phases,
) -> Result<J, Fwd> {
    let asp_home = &plan.asp_home;
    let target_name = plan.agent_name.clone();
    stage::sweep_temp(asp_home);
    ensure_asp_home();
    phases.lap("temp-sweep");

    let new_lock = spaces::generate_lock(
        &target_name,
        &plan.compose,
        &plan.closure,
        &plan.integrities,
    );
    write_global_lock(asp_home, &plan.lock_path, &new_lock)?;

    // Plugin artifacts, the agent-local plugin, then the bundle.
    let codex = matches!(plan.launch, Launch::Codex { .. });
    let mut artifacts = vec![];
    let mut permissions = vec![];
    let cleanup = |artifacts: &Vec<stage::Artifact>| {
        for a in artifacts {
            let _ = std::fs::remove_dir_all(&a.path);
        }
    };
    for sp in &plan.space_plans {
        match stage::stage_space(sp, asp_home, codex) {
            Ok(a) => {
                artifacts.push(a);
                permissions.push(sp.permissions.clone());
            }
            Err(e) => {
                cleanup(&artifacts);
                return Err(e);
            }
        }
    }
    if let Some(local) = &plan.agent_local {
        match stage::stage_agent_local(local, asp_home) {
            Ok(Some(a)) => {
                artifacts.push(a);
                permissions.push(None);
            }
            Ok(None) => {}
            Err(e) => {
                cleanup(&artifacts);
                return Err(e);
            }
        }
    }
    let hashes = match artifacts
        .iter()
        .map(|a| stage::hash_directory(&a.path))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(h) => h,
        Err(e) => {
            cleanup(&artifacts);
            return Err(e);
        }
    };
    let lock_target = new_lock
        .get("targets")
        .and_then(|t| t.get(&target_name))
        .cloned()
        .unwrap_or(J::Null);
    let identity_of = |k: &str| plan.identity.get(k).and_then(J::as_str).unwrap_or_default();
    let input = stage::TargetInput {
        target_name: &target_name,
        identity: &plan.identity,
        lock_target: &lock_target,
        codex_options: plan.codex_options.as_ref(),
        path_exclude: spaces::path_exclude(&plan.closure),
        public_scope_root: join(&[
            asp_home,
            "codex-homes",
            &format!(
                "{}_{}",
                sanitize_segment(identity_of("projectId")),
                sanitize_segment(identity_of("agentId"))
            ),
        ]),
        statusline: match &plan.launch {
            Launch::Claude { statusline, .. } => Some(statusline),
            Launch::Codex { .. } => None,
        },
    };
    let fingerprint = stage::fingerprint(&input, &artifacts, &hashes);
    let published = if codex {
        stage::publish_target(
            &input,
            &artifacts,
            &fingerprint,
            asp_home,
            "codex",
            |staging_output, _| {
                codex::compose_target(
                    &artifacts,
                    staging_output,
                    &target_name,
                    plan.codex_options.as_ref(),
                )
                .map(|(_, required)| required)
            },
        )
        .and_then(|output| codex::load_bundle(&output))
        .map(|b| (b.root_dir, vec![b.home]))
    } else {
        stage::publish_claude_target(&input, &artifacts, &permissions, &fingerprint, asp_home)
            .map(|b| (b.root_dir, b.plugin_dirs))
    };
    let (bundle_root, plugin_dirs) = match published {
        Ok(p) => p,
        Err(e) => {
            cleanup(&artifacts);
            return Err(e);
        }
    };
    stage::check_skill_and_command_conflicts(&plugin_dirs)?;

    // The system prompt artifact, inside the versioned bundle.
    let system_prompt_path = match &plan.system_prompt {
        Some(sp) => Some(stage::write_prompt_artifact(
            &join(&[&bundle_root, ".asp-runtime-artifacts"]),
            sp.prompt.as_deref().unwrap_or(""),
        )?),
        None => None,
    };
    phases.lap("materialize");
    path_filter::prepare(
        &path_filter_scope(&plan),
        &input.path_exclude,
        !plan.codex_home_read_only,
    )?;

    match &plan.launch {
        Launch::Claude { .. } => {
            let bundle = stage::load_bundle(&bundle_root)?;
            // Workspace trust for the launch cwd (warnings, never failures).
            let mut warnings = workspace_trust(&plan.cwd);
            // Agent tool runtime env (mkdirs under the agent's var/) and its warnings.
            let (tool_env, path_prepend) = agent_tool_env(&plan)?;
            warnings.extend(plan.tool_warnings.iter().cloned());
            let emitted = emit_claude::emit_claude(
                &plan,
                release,
                &bundle,
                system_prompt_path,
                &mut warnings,
                tool_env,
                path_prepend,
            );
            phases.lap("emit");
            emitted
        }
        Launch::Codex { .. } => {
            codex::load_bundle(&bundle_root)?;
            // The shared home takes the task-invariant prompt; task-scoped
            // sections travel per invocation as developerInstructions.
            let (home_prompt, home_reminder) = match &plan.system_prompt {
                None => (None, None),
                Some(sp) => match &sp.task_scoped {
                    Some(t) => (t.prompt.clone(), t.reminder.clone()),
                    None => (
                        Some(sp.prompt.clone().unwrap_or_default()),
                        sp.reminder.clone(),
                    ),
                },
            };
            let project_id = plan.handle.project_id.clone().unwrap_or_default();
            let codex_home = if plan.codex_home_read_only {
                codex::home_path(asp_home, &project_id, &target_name)
            } else {
                codex::prepare_runtime_home(&codex::Home {
                    asp_home,
                    project_id: &project_id,
                    target_name: &target_name,
                    bundle_root: &bundle_root,
                    cwd: &plan.cwd,
                    interactive: plan.selection.interactive(),
                    hook_events: plan
                        .selection
                        .interactive()
                        .then_some(&codex::TUI_HOOK_EVENTS[..]),
                    system_prompt: home_prompt.as_deref(),
                    reminder: home_reminder.as_deref(),
                })?
            };
            phases.lap("codex-home");
            let (tool_env, path_prepend) = agent_tool_env(&plan)?;
            let mut warnings = plan.tool_warnings.clone();
            let emitted = emit_codex::emit_codex(
                &plan,
                release,
                &bundle_root,
                &codex_home,
                system_prompt_path,
                &mut warnings,
                tool_env,
                path_prepend,
            );
            phases.lap("emit");
            emitted
        }
    }
}

/// The global lock JSON, judged by the lock schema like Bun's readLockJson.
pub(super) fn parse_global_lock(bytes: &[u8]) -> Result<J, Fwd> {
    crate::json::parse(bytes)
        .filter(lock_schema::valid)
        .ok_or_else(|| fwd(crate::reason!("global_lock_invalid")))
}

/// Merge-write the generated lock under the lock file's own lock, reading
/// the current lock again under it: another writer may have changed it.
fn write_global_lock(asp_home: &str, lock_path: &str, new_lock: &J) -> Result<(), Fwd> {
    let lock_key = format!(
        "lock-file-{}",
        &sha256_hex(resolve(&[lock_path]).as_bytes())[..32]
    );
    let lock_lock = stage::materialization_lock_path(asp_home, &lock_key);
    lockfile::with_lock(
        &lock_lock,
        &lockfile::MATERIALIZATION,
        || -> Result<(), Fwd> {
            let current = match std::fs::read(lock_path) {
                Ok(bytes) => Some(parse_global_lock(&bytes)?),
                Err(_) => None,
            };
            let merged = match &current {
                Some(c) => spaces::merge_locks(c, new_lock),
                None => new_lock.clone(),
            };
            atomic_write(lock_path, &format!("{}\n", merged.to_json_pretty()))
        },
    )
    .map_err(lock_fwd(crate::reason!("global_lock_lock")))?
}

/// `ensureAspHome()`: the process ASP_HOME's directories.
pub(super) fn ensure_asp_home() {
    let process_home = crate::reads::declaration::process_asp_home();
    for d in ["repo", "sources", "snapshots", "cache", "projects", "tmp"] {
        let _ = std::fs::create_dir_all(join(&[&process_home, d]));
    }
}

/// `atomicWriteJson`: temp file, fsync, rename.
pub(super) fn atomic_write(path: &str, content: &str) -> Result<(), Fwd> {
    let dir = dirname(path);
    std::fs::create_dir_all(&dir).map_err(|_| fwd(crate::reason!("atomic_write")))?;
    let tmp = join(&[
        &dir,
        &format!(
            ".{}.{}.tmp",
            basename(path),
            util::hex_bytes(&util::random_bytes::<6>())
        ),
    ]);
    let result = (|| -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o644)
            .open(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(fwd(crate::reason!("atomic_write")));
    }
    Ok(())
}
