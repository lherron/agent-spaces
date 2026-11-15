//! Classification: everything a compile reads and decides before its first
//! write (compile-runtime-plan.ts's resolve, placement context, harness
//! detection, agent-local, runtime plan and system prompt stages). Anything
//! raspd will not judge refuses here as a `Forward`, so a refused request has
//! written nothing.
use super::bundle_audit::{self, BundleInput};
use super::materialize::parse_global_lock;
use super::prompt::{self, Ctx, EnvMap};
use super::provisioning::{self, ClaudeDefaults, CodexDefaults};
use super::scope::{Handle, agent_session_env, handle_parts, parse_scope_ref};
use super::util::{self, hash};
use super::{
    Fwd, Phases, agent_tools, codex, fwd, fwd_at, release_binding, request, s, spaces, stage,
};
use crate::json::J;
use crate::reads::Env;
use crate::reads::jspath::{basename, dirname, join, resolve};
use crate::release::Release;

/// Everything a compile reads and decides before its first write.
pub(super) struct Plan {
    pub(super) req: J,
    pub(super) params: J,
    pub(super) agent_root: String,
    pub(super) project_root: Option<String>,
    pub(super) agent_name: String,
    pub(super) asp_home: String,
    pub(super) cwd: String,
    pub(super) selection: request::Selection,
    pub(super) session_metadata: J,
    pub(super) metadata_diagnostics: Vec<J>,
    pub(super) resolved_bundle: J,
    pub(super) bundle_identity: String,
    pub(super) compose: Vec<String>,
    pub(super) closure: spaces::Closure,
    pub(super) integrities: Vec<String>,
    pub(super) lock_path: String,
    pub(super) space_plans: Vec<stage::SpacePlan>,
    pub(super) agent_local: Option<stage::AgentLocal>,
    pub(super) identity: J,
    pub(super) codex_options: Option<J>,
    pub(super) launch: Launch,
    pub(super) system_prompt: Option<prompt::Resolved>,
    pub(super) expanded_prompt: Option<String>,
    pub(super) handle: Handle,
    pub(super) effective_environment_hash: String,
    pub(super) correlation_env: Vec<(String, String)>,
    pub(super) tool_warnings: Vec<String>,
    /// `materializeCodexRuntimeHome: false` (an inspection compile): the
    /// codex runtime home's path, never its write.
    pub(super) codex_home_read_only: bool,
}

/// The harness-specific half of a plan.
pub(super) enum Launch {
    Claude {
        defaults: ClaudeDefaults,
        path: String,
        statusline: stage::Statusline,
    },
    Codex {
        defaults: CodexDefaults,
        path: String,
    },
}

/// The placement facts every stage reads.
struct Sources {
    req: J,
    placement: J,
    agent_root: String,
    project_root: Option<String>,
    agent_name: String,
    bundle_project_root: Option<String>,
    /// Absent only on an inspection compile (agent-inspection.ts), which Bun
    /// resolves with `runMode: undefined`: no mode spaces or instructions.
    run_mode: Option<String>,
    task_context: Option<J>,
    material: J,
}

impl Sources {
    fn read(params: &J) -> Self {
        let req = params.get("compileRequest").expect("validated").clone();
        let placement = req.get("placement").expect("validated").clone();
        let material = req.get("materialization").expect("validated").clone();
        let bundle = placement.get("bundle");
        Sources {
            agent_root: s(placement.get("agentRoot")).unwrap_or_default().to_owned(),
            project_root: s(placement.get("projectRoot")).map(str::to_owned),
            agent_name: s(bundle.and_then(|b| b.get("agentName")))
                .unwrap_or_default()
                .to_owned(),
            bundle_project_root: s(bundle.and_then(|b| b.get("projectRoot"))).map(str::to_owned),
            run_mode: s(placement.get("runMode")).map(str::to_owned),
            task_context: material.get("taskContext").cloned(),
            material,
            placement,
            req,
        }
    }

    fn has_session_ref(&self) -> bool {
        self.placement
            .get("correlation")
            .and_then(|c| c.get("sessionRef"))
            .is_some()
    }
}

/// The preparation execution context (preparation-execution-context.ts):
/// the prompt's identity and the exec env its sections see.
struct Preparation {
    has_session_scope: bool,
    project_id: Option<String>,
    agent_id: String,
    correlation_env: Vec<(String, String)>,
    exec_env: EnvMap,
    effective_environment_hash: String,
}

pub(super) fn classify(params: &J, release: &Release, phases: &mut Phases) -> Result<Plan, Fwd> {
    let src = Sources::read(params);
    let agent_root = src.agent_root.clone();

    // launchRefusal and the taskContext check refuse before writing.
    let profile = request::read_profile(&agent_root)?;
    match profile
        .typed
        .placement
        .as_ref()
        .and_then(|p| p.launch.as_deref())
    {
        Some("participant-only") => return Err(fwd(crate::reason!("agent_participant_only"))),
        Some("self-brokered") => return Err(fwd(crate::reason!("agent_self_brokered"))),
        _ => {}
    }
    let scoped = handle_parts(
        &{
            let mut p = src.placement.clone();
            p.remove("projectRoot");
            p
        },
        false,
    )?;
    if let Some(tc) = &src.task_context
        && src.has_session_ref()
        && let Some(scoped_task) = &scoped.task_id
        && s(tc.get("taskId")) != Some(scoped_task.as_str())
    {
        return Err(fwd(crate::reason!("configured_context_mismatch")));
    }

    // resolveCompileSources: the target comes from bundle.projectRoot.
    let targets_for_sources =
        request::read_targets(src.bundle_project_root.as_deref(), &src.agent_name)?;
    let project_target = targets_for_sources.target.as_ref();
    let (session_metadata, metadata_diagnostics) =
        request::session_metadata(&profile.raw, project_target);
    let selection = request::resolve_selection(&src.req, &profile, project_target)?;
    phases.lap("resolve");

    // resolvePlacementContext({ ...placement, dryRun: true }).
    let effective_priming = provisioning::effective_priming(&profile, &agent_root, project_target)?;
    let compose = provisioning::compose(&profile.raw, src.run_mode.as_deref(), project_target);
    let claude = provisioning::claude_defaults(&profile, project_target);
    let codex_defaults = provisioning::codex_defaults(&profile, project_target, claude.yolo)?;
    let resolved_bundle = bundle_audit::resolved_bundle(&BundleInput {
        placement: &src.placement,
        raw_profile: &profile.raw,
        agent_root: &agent_root,
        agent_name: &src.agent_name,
        project_root: src.project_root.as_deref(),
        bundle_project_root: src.bundle_project_root.as_deref(),
        run_mode: src.run_mode.as_deref(),
        compose: &compose,
    })?;
    let bundle_identity = s(resolved_bundle.get("bundleIdentity"))
        .unwrap_or_default()
        .to_owned();
    let cwd = s(resolved_bundle.get("cwd")).unwrap_or_default().to_owned();
    // An explicit aspHome (both HRCs send theirs) anchors materialization and
    // prompt sources; absent, the daemon's own (promptSourcesForCompile).
    let explicit_asp_home = s(params.get("aspHome")).map(str::to_owned);
    let asp_home = explicit_asp_home
        .clone()
        .unwrap_or_else(crate::reads::declaration::process_asp_home);
    phases.lap("placement-context");

    let harness = selection.harness;
    let launch_path = detect_harness(&selection)?;
    phases.lap("harness-detect");
    let agent_local = stage::AgentLocal::detect(&agent_root);
    // validateAgentTools throws in Bun after writes; judged here, before any.
    let tool_warnings = match &agent_local {
        Some(l) if l.has_tools => agent_tools::validate_agent_tools(&agent_root)?,
        _ => vec![],
    };
    phases.lap("agent-local");

    // Identity: scope-ref facts (the only live branch).
    let handle = handle_parts(&src.placement, true)?;
    let identity = plan_identity(&src.placement, &handle, harness);
    let prep = preparation(&src, &scoped)?;
    phases.lap("environment");

    let registry = registry_root(&asp_home)?;
    let roots = spaces::ClosureRoots {
        registry: &registry,
        agent_root: Some(&agent_root),
        project_root: src.project_root.as_deref(),
    };
    let closure = spaces::closure(&compose, &roots)?;
    let integrities = closure
        .spaces
        .iter()
        .map(|sp| spaces::integrity(sp, &roots))
        .collect::<Result<Vec<_>, _>>()?;
    let lock_path = join(&[&asp_home, "global-lock.json"]);
    check_global_lock(&lock_path)?;
    let space_plans = plan_spaces(
        &closure,
        &agent_root,
        src.project_root.as_deref(),
        &registry,
    )?;
    let codex_options = provisioning::fingerprint_codex_options(
        src.project_root.as_deref(),
        &asp_home,
        &src.agent_name,
    )?;
    phases.lap("spaces-plan");

    // The launch prompt: priming (fresh only) plus the caller prompt, expanded.
    let launch_prompt = launch_prompt(&src, effective_priming);
    let expansion = Ctx {
        agent_root: agent_root.clone(),
        agents_root: dirname(&agent_root),
        search_path: prompt::agent_root_search_path(
            src.project_root.as_deref(),
            prompt::Roots::Ambient,
        )?
        .0,
        project_root: src.project_root.clone(),
        cwd: None,
        project_id: if prep.has_session_scope {
            scoped.project_id.clone()
        } else {
            handle.project_id.clone()
        },
        agent_id: handle.agent_id.clone(),
        agent_name: None,
        task_id: handle.task_id.clone(),
        task_context: None,
        lane: handle.lane.clone(),
        run_mode: src.run_mode.clone(),
        agent_profile: None,
        env: None,
        exec_env: None,
        pinned: None,
    };
    let expanded_prompt = match &launch_prompt {
        Some(p) => Some(prompt::interpolate(p, &expansion)?),
        None => None,
    };
    phases.lap("plan-runtime");

    let system_prompt =
        system_prompt(&src, &scoped, &prep, &asp_home, explicit_asp_home.is_some())?;
    phases.lap("system-prompt");

    let launch = match harness {
        request::Harness::Claude => Launch::Claude {
            defaults: claude,
            path: launch_path,
            statusline: release_binding::release_statusline(release)?,
        },
        request::Harness::Codex => Launch::Codex {
            defaults: codex_defaults,
            path: launch_path,
        },
    };
    phases.lap("statusline");
    Ok(Plan {
        params: params.clone(),
        req: src.req,
        agent_root,
        project_root: src.project_root,
        agent_name: src.agent_name,
        asp_home,
        cwd,
        selection,
        session_metadata,
        metadata_diagnostics,
        resolved_bundle,
        bundle_identity,
        compose,
        closure,
        integrities,
        lock_path,
        space_plans,
        agent_local,
        identity,
        codex_options,
        launch,
        system_prompt,
        expanded_prompt,
        handle,
        effective_environment_hash: prep.effective_environment_hash,
        correlation_env: prep.correlation_env,
        tool_warnings,
        codex_home_read_only: false,
    })
}

/// The selected harness's binary: `findClaudeBinary()`, or the codex
/// adapter's detection for a model in its list.
fn detect_harness(selection: &request::Selection) -> Result<String, Fwd> {
    match selection.harness {
        request::Harness::Claude => find_claude(),
        request::Harness::Codex => {
            // planPlacementRuntime throws for a model outside the adapter's list.
            if !codex::ADAPTER_MODELS.contains(&selection.model.as_str()) {
                return Err(fwd_at(
                    crate::reason!("codex_model_unsupported"),
                    selection.model.clone(),
                ));
            }
            codex::detect()
        }
    }
}

/// `findClaudeBinary()`: ASP_CLAUDE_PATH, the common locations, then PATH.
fn find_claude() -> Result<String, Fwd> {
    let env = Env::process();
    let executable = |p: &str| {
        std::ffi::CString::new(p)
            .is_ok_and(|c| unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0)
    };
    if let Some(explicit) = env.get("ASP_CLAUDE_PATH").filter(|p| !p.is_empty()) {
        return if executable(explicit) {
            Ok(explicit.to_owned())
        } else {
            Err(fwd(crate::reason!("claude_not_found")))
        };
    }
    let home = env
        .get("HOME")
        .filter(|h| !h.is_empty())
        .unwrap_or("~")
        .to_owned();
    let mut candidates: Vec<String> = vec![];
    if env.get("ASP_CLAUDE_SKIP_COMMON_PATHS") != Some("1") {
        candidates.extend([
            "/opt/homebrew/bin/claude".to_owned(),
            "/usr/local/bin/claude".into(),
            "/usr/bin/claude".into(),
            join(&[&home, ".local/bin/claude"]),
            join(&[&home, "bin/claude"]),
            join(&[&home, ".npm-global/bin/claude"]),
        ]);
    }
    for dir in env
        .get("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|d| !d.is_empty())
    {
        candidates.push(join(&[dir, "claude"]));
    }
    let mut seen = vec![];
    for c in candidates {
        if c.is_empty() || seen.contains(&c) {
            continue;
        }
        if executable(&c) {
            return Ok(c);
        }
        seen.push(c);
    }
    Err(fwd(crate::reason!("claude_not_found")))
}

/// The plan's `identity`: the scope's agent and project, else
/// prepare-cli-runtime.ts's placement fallback (the bundle's agent name, and
/// the first of projectRoot ?? cwd ?? bundle.projectRoot).
fn plan_identity(placement: &J, handle: &Handle, harness: request::Harness) -> J {
    let (agent_id, project_id) = match (handle.agent_id.clone(), handle.project_id.clone()) {
        (Some(agent), Some(project)) => (agent, project),
        _ => {
            let bundle = placement.get("bundle");
            let agent = s(bundle.and_then(|b| b.get("agentName")))
                .unwrap_or_default()
                .to_owned();
            let root = [
                placement.get("projectRoot"),
                placement.get("cwd"),
                bundle.and_then(|b| b.get("projectRoot")),
            ]
            .into_iter()
            .flatten()
            .find(|v| !matches!(v, J::Null))
            .and_then(J::as_str)
            .filter(|r| !r.is_empty());
            let project = root.map_or_else(
                || "missing-project".to_owned(),
                |r| basename(&resolve(&[r])),
            );
            (agent, project)
        }
    };
    J::obj([
        ("agentId", J::str(&agent_id)),
        ("projectId", J::str(&project_id)),
        (
            "frontend",
            J::str(match harness {
                request::Harness::Claude => "claude-code",
                request::Harness::Codex => "codex-cli",
            }),
        ),
    ])
}

/// Prompt identity follows the canonical scope, including no project
/// (handle_parts already refused non-canonical scopes on this compile path);
/// environment discovery keeps its old fallback independently of the prompt.
fn preparation(src: &Sources, scoped: &Handle) -> Result<Preparation, Fwd> {
    let placement = &src.placement;
    let has_session_scope = s(placement
        .get("correlation")
        .and_then(|c| c.get("sessionRef"))
        .and_then(|r| r.get("scopeRef")))
    .and_then(parse_scope_ref)
    .is_some();
    let discovery_project_id = scoped.project_id.clone().or_else(|| {
        src.project_root
            .as_deref()
            .map(|p| basename(&resolve(&[p])))
    });
    let project_id = if has_session_scope {
        scoped.project_id.clone()
    } else {
        discovery_project_id.clone()
    };
    let agent_id = if src.has_session_ref() {
        scoped
            .agent_id
            .clone()
            .unwrap_or_else(|| basename(&src.agent_root))
    } else {
        basename(&src.agent_root)
    };
    let correlation_env = agent_session_env(placement)?;
    let mut exec_env: EnvMap = util::exec_environment().clone();
    for (k, v) in &correlation_env {
        exec_env.insert(k.clone(), v.clone());
    }
    exec_env.insert("AGENTCHAT_ID".into(), basename(&src.agent_root));
    if let Some(p) = &discovery_project_id {
        exec_env.insert("ASP_PROJECT".into(), p.clone());
    }
    let env_json = J::Obj(
        exec_env
            .iter()
            .map(|(k, v)| (k.clone(), J::str(v)))
            .collect(),
    );
    let effective_environment_hash = match &src.task_context {
        None => hash(&env_json, false),
        Some(tc) => hash(
            &J::obj([("environment", env_json), ("taskContext", tc.clone())]),
            false,
        ),
    };
    Ok(Preparation {
        has_session_scope,
        project_id,
        agent_id,
        correlation_env,
        exec_env,
        effective_environment_hash,
    })
}

/// The registry root dev spaces resolve under: the declared agents root,
/// else `$ASP_HOME/repo`.
fn registry_root(asp_home: &str) -> Result<String, Fwd> {
    let env = Env::process();
    Ok(
        match crate::reads::declaration::agents_root(Some(asp_home), env).map_err(fwd)? {
            Some(root) => root,
            None => join(&[asp_home, "repo"]),
        },
    )
}

/// Bun's readLockJson: JSON, then the lock schema. raspd neither compiles
/// from nor rewrites a lock Bun rejects.
fn check_global_lock(lock_path: &str) -> Result<(), Fwd> {
    match std::fs::read(lock_path) {
        Ok(bytes) => parse_global_lock(&bytes).map(drop),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(fwd(crate::reason!("global_lock_unreadable"))),
    }
}

/// The staging plan of every space in the closure. Bun's
/// populateSnapshotsFromLock also demands the snapshot of every other
/// target's registry pin in the shared lock. A pin of this target has
/// refused already (registry_space); another target's does not refuse this
/// compile (T-13018 r2), so nothing here reads snapshots.
fn plan_spaces(
    closure: &spaces::Closure,
    agent_root: &str,
    project_root: Option<&str>,
    registry: &str,
) -> Result<Vec<stage::SpacePlan>, Fwd> {
    let mut space_plans = vec![];
    for space in &closure.spaces {
        let (name, version) = spaces::plugin_identity(&space.manifest);
        let content_dir = match space.kind {
            spaces::Kind::Agent => join(&[agent_root, "spaces", &space.id]),
            spaces::Kind::Project => join(&[project_root.unwrap_or_default(), "spaces", &space.id]),
            spaces::Kind::Dev => join(&[registry, "spaces", &space.id]),
        };
        let mut lock_plugin = J::obj([("name", J::str(&name))]);
        if let Some(v) = &version {
            lock_plugin.set("version", J::str(v));
        }
        space_plans.extend(stage::plan_space(
            stage::SpaceInput {
                key: space.key.clone(),
                id: space.id.clone(),
                plugin_name: name,
                plugin_version: version.unwrap_or_else(|| "0.0.0".into()),
                content_dir,
            },
            &lock_plugin,
        )?);
    }
    Ok(space_plans)
}

/// The launch prompt before expansion: priming unless omitted or resuming
/// (prepare-cli-runtime receives a continuation only when the key is set),
/// then the caller's prompt.
fn launch_prompt(src: &Sources, effective_priming: Option<String>) -> Option<String> {
    let material = &src.material;
    let caller_prompt = s(material.get("initialPrompt")).map(str::to_owned);
    let omit_priming = matches!(material.get("omitPriming"), Some(J::Bool(true)));
    let may_prime = super::broker_spec::continuation_key(&src.req).is_none();
    let priming = if may_prime { effective_priming } else { None };
    if caller_prompt.as_deref() == Some("") {
        Some(String::new())
    } else if omit_priming {
        caller_prompt
    } else {
        match (priming, caller_prompt) {
            (Some(p), Some(c)) => Some(format!("{p}\n\n{c}")),
            (p, c) => p.or(c),
        }
    }
}

/// The system prompt, resolved now (exec sections and probes run here);
/// none without a template or a SOUL.
fn system_prompt(
    src: &Sources,
    scoped: &Handle,
    prep: &Preparation,
    asp_home: &str,
    explicit_asp_home: bool,
) -> Result<Option<prompt::Resolved>, Fwd> {
    let agent_root = &src.agent_root;
    let discovered = prompt::discover(
        agent_root,
        src.project_root.as_deref(),
        asp_home,
        explicit_asp_home.then_some(None),
    )?;
    if discovered.template.is_none()
        && !std::path::Path::new(&join(&[agent_root, "SOUL.md"])).exists()
    {
        return Ok(None);
    }
    let agent_profile = if discovered.template.is_some() {
        discovered.raw_profile.clone()
    } else {
        discovered.base.as_ref().map(|b| {
            J::obj([(
                "instructions",
                J::obj([("base", J::Arr(b.iter().map(J::str).collect()))]),
            )])
        })
    };
    // buildDefaultTemplate(base, scaffoldPackets): the placement's packets
    // reach the prompt input through its placement spread.
    let base = discovered.base.as_deref().unwrap_or_default();
    let template = match (discovered.template, src.placement.get("scaffoldPackets")) {
        (Some(t), _) => t,
        (None, Some(packets)) => prompt::default_template_with_scaffold(base, packets),
        (None, None) => prompt::default_template(base),
    };
    let ctx = Ctx {
        agent_root: agent_root.clone(),
        agents_root: discovered.agents_root.clone(),
        search_path: discovered.search_path.clone(),
        project_root: src.project_root.clone(),
        cwd: s(src.placement.get("cwd")).map(str::to_owned),
        project_id: prep.project_id.clone(),
        agent_id: Some(prep.agent_id.clone()),
        agent_name: Some(basename(agent_root)),
        task_id: scoped.task_id.clone(),
        task_context: src.task_context.clone(),
        lane: scoped.lane.clone(),
        run_mode: src.run_mode.clone(),
        agent_profile,
        env: Some(prep.exec_env.clone()),
        exec_env: Some(prep.exec_env.clone()),
        pinned: None,
    };
    Ok(Some(prompt::resolve_template(&template, &ctx)?))
}
