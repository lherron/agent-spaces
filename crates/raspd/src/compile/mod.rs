//! Native `aspc.compileHarnessInvocation` for the claude-code recipe over
//! mutable spaces (R3a, docs/proposals/aspd-rust-front-door.md).
//!
//! Bun owns the semantics; this is compiler/agent-spaces/src
//! (compile-runtime-plan.ts, compile-tmux-broker-plan.ts,
//! prepare-cli-runtime.ts, compile-plan-finalize.ts) and what they call,
//! reproduced byte for byte. The request is classified before anything is
//! written: every read, every validation and the whole system prompt resolve
//! first, and anything raspd does not implement (another recipe, a registry
//! space, a missing snapshot, an input it will not judge) is a `Forward`
//! relayed to Bun unchanged. Writes then follow Bun's rules under ASP_HOME's
//! shared lock protocol. raspd never fetches the registry.
mod lockfile;
mod prompt;
mod request;
mod spaces;
mod stage;
mod util;

use crate::json::J;
use crate::reads::jspath::{basename, dirname, join, resolve};
use crate::reads::{Answer, Env};
use crate::release::Release;
use prompt::{Ctx, EnvMap};
use std::sync::atomic::{AtomicBool, Ordering};
use util::{hash, now_iso, sanitize_segment, sha256_hex};

/// Why a compile is relayed to Bun.
pub type Fwd = &'static str;

pub fn fwd(reason: &'static str) -> Fwd {
    reason
}

pub const METHOD: &str = "aspc.compileHarnessInvocation";

/// JS truthiness of a JSON value.
pub fn truthy(v: &J) -> bool {
    crate::reads::js_truthy(v)
}

/// Set once the first compile wrote under ASP_HOME, for logging only.
static WROTE: AtomicBool = AtomicBool::new(false);

pub fn handle(params: Option<&J>, release: &Release) -> Answer {
    if !request::params_valid(params) {
        return Answer::Forward("invalid_params");
    }
    let params = params.expect("validated");
    match compile(params, release) {
        Ok(result) => Answer::Result(result),
        Err(reason) => Answer::Forward(reason),
    }
}

/// Everything a compile reads and decides before its first write.
struct Plan {
    req: J,
    params: J,
    agent_root: String,
    project_root: Option<String>,
    agent_name: String,
    asp_home: String,
    cwd: String,
    selection: request::Selection,
    session_metadata: J,
    metadata_diagnostics: Vec<J>,
    resolved_bundle: J,
    bundle_identity: String,
    compose: Vec<String>,
    closure: spaces::Closure,
    integrities: Vec<String>,
    lock_path: String,
    existing_lock: Option<J>,
    space_plans: Vec<stage::SpacePlan>,
    agent_local: Option<stage::AgentLocal>,
    identity: J,
    codex_options: Option<J>,
    claude: ClaudeDefaults,
    claude_path: String,
    system_prompt: Option<prompt::Resolved>,
    expanded_prompt: Option<String>,
    handle: Handle,
    effective_environment_hash: String,
    correlation_env: Vec<(String, String)>,
    statusline: stage::Statusline,
    tool_warnings: Vec<String>,
}

#[derive(Default, Clone)]
struct Handle {
    agent_id: Option<String>,
    project_id: Option<String>,
    task_id: Option<String>,
    lane: Option<String>,
}

/// The adapter's `getDefaultRunOptions` on the synthetic agent-project manifest.
#[derive(Default)]
struct ClaudeDefaults {
    permission_mode: Option<String>,
    extra_args: Vec<String>,
    ask_user_question: Option<bool>,
    yolo: bool,
    remote: bool,
}

fn s(v: Option<&J>) -> Option<&str> {
    v.and_then(J::as_str)
}

fn compile(params: &J, release: &Release) -> Result<J, Fwd> {
    request::shape_supported(params)?;
    let plan = classify(params, release)?;
    WROTE.store(true, Ordering::Relaxed);
    materialize_and_emit(plan, release)
}

// -- scope refs (contracts/agent-scope) ---------------------------------------

struct Scope {
    agent_id: String,
    project_id: Option<String>,
    task_id: Option<String>,
}

/// `parseScopeRef`, or `None` where Bun would throw.
fn parse_scope_ref(scope: &str) -> Option<Scope> {
    let parts: Vec<&str> = scope.split(':').collect();
    let tok = |v: &str| request::token_error(v, "x").is_none();
    if parts.len() < 2 || parts[0] != "agent" || !tok(parts[1]) {
        return None;
    }
    let agent_id = parts[1].to_owned();
    if parts.len() == 2 {
        return Some(Scope {
            agent_id,
            project_id: None,
            task_id: None,
        });
    }
    if parts.len() < 4 || parts[2] != "project" || !tok(parts[3]) {
        return None;
    }
    let project_id = Some(parts[3].to_owned());
    if parts.len() == 4 {
        return Some(Scope {
            agent_id,
            project_id,
            task_id: None,
        });
    }
    match parts[4] {
        "role" if parts.len() == 6 && tok(parts[5]) => Some(Scope {
            agent_id,
            project_id,
            task_id: None,
        }),
        "task" if parts.len() >= 6 && tok(parts[5]) => {
            let task_id = Some(parts[5].to_owned());
            match parts.len() {
                6 => Some(Scope {
                    agent_id,
                    project_id,
                    task_id,
                }),
                8 if parts[6] == "role" && tok(parts[7]) => Some(Scope {
                    agent_id,
                    project_id,
                    task_id,
                }),
                _ => None,
            }
        }
        _ => None,
    }
}

/// `deriveHandleParts(placement)` (canonical scope refs only).
fn handle_parts(placement: &J, with_project_root: bool) -> Result<Handle, Fwd> {
    let correlation = placement.get("correlation");
    let session = correlation.and_then(|c| c.get("sessionRef"));
    let mut h = Handle::default();
    if let Some(scope) = s(session.and_then(|x| x.get("scopeRef"))).filter(|x| !x.is_empty()) {
        let parsed = parse_scope_ref(scope).ok_or_else(|| fwd("scope_ref_shorthand"))?;
        h.agent_id = Some(parsed.agent_id);
        h.project_id = parsed.project_id;
        h.task_id = parsed.task_id;
    }
    let agent_root = s(placement.get("agentRoot")).unwrap_or_default();
    if h.agent_id.is_none() {
        h.agent_id = Some(basename(agent_root));
    }
    if with_project_root
        && h.project_id.is_none()
        && let Some(root) = s(placement.get("projectRoot")).filter(|r| !r.is_empty())
    {
        h.project_id = Some(basename(&resolve(&[root])));
    }
    if let Some(lane) = s(session.and_then(|x| x.get("laneRef"))).filter(|l| !l.is_empty()) {
        h.lane = Some(lane.strip_prefix("lane:").unwrap_or(lane).to_owned());
    }
    Ok(h)
}

/// `buildAgentSessionEnv(placement)`, in insertion order.
fn agent_session_env(placement: &J) -> Result<Vec<(String, String)>, Fwd> {
    let mut env: Vec<(String, String)> = vec![];
    let mut put = |k: &str, v: String| match env.iter_mut().find(|(e, _)| e == k) {
        Some(slot) => slot.1 = v,
        None => env.push((k.to_owned(), v)),
    };
    let correlation = placement.get("correlation");
    let session = correlation.and_then(|c| c.get("sessionRef"));
    let mut ids: (Option<String>, Option<String>, Option<String>) = (None, None, None);
    if let Some(session) = session {
        let scope = s(session.get("scopeRef")).unwrap_or_default();
        let lane_ref = s(session.get("laneRef")).unwrap_or_default();
        let normalized = if lane_ref == "main" || lane_ref.starts_with("lane:") {
            lane_ref.to_owned()
        } else {
            format!("lane:{lane_ref}")
        };
        if normalized != "main" {
            let lane_id = &normalized["lane:".len()..];
            if request::token_error(lane_id, "laneId").is_some() {
                return Err(fwd("lane_ref_invalid"));
            }
        }
        put("AGENT_SCOPE_REF", scope.to_owned());
        put("AGENT_LANE_REF", lane_ref.to_owned());
        let lane = if normalized == "main" {
            "main"
        } else {
            &normalized["lane:".len()..]
        };
        put(
            "AGENT_LANE",
            if lane.is_empty() {
                "main".into()
            } else {
                lane.to_owned()
            },
        );
        let parsed = parse_scope_ref(scope).ok_or_else(|| fwd("scope_ref_shorthand"))?;
        ids = (Some(parsed.agent_id), parsed.project_id, parsed.task_id);
        let session_ref = format!("{scope}/lane:{lane}");
        put("AGENT_SESSION_REF", session_ref.clone());
        put("HRC_SESSION_REF", session_ref);
    }
    if let Some(a) = &ids.0 {
        put("AGENT_ID", a.clone());
    }
    if let Some(p) = &ids.1 {
        put("AGENT_PROJECT", p.clone());
    }
    if let Some(t) = &ids.2 {
        put("AGENT_TASK", t.clone());
    }
    let c = |k: &str| s(correlation.and_then(|c| c.get(k))).map(str::to_owned);
    if let Some(run) = c("runId") {
        put("AGENT_RUN_ID", run.clone());
        put("HRC_RUN_ID", run);
    }
    if let Some(host) = c("hostSessionId") {
        put("AGENT_HOST_SESSION_ID", host.clone());
        put("HRC_HOST_SESSION_ID", host);
    }
    if let Some(J::Num(g)) = correlation.and_then(|c| c.get("generation")) {
        let g = crate::json::js_number(*g);
        put("AGENT_GENERATION", g.clone());
        put("HRC_GENERATION", g);
    }
    if let Some(v) = c("runtimeId") {
        put("HRC_RUNTIME_ID", v);
    }
    if let Some(v) = c("invocationId") {
        put("HRC_INVOCATION_ID", v);
    }
    if let Some(v) = c("initialInputId") {
        put("HRC_INITIAL_INPUT_ID", v);
    }
    if let Some(root) = s(placement.get("projectRoot")) {
        put("AGENT_PROJECT_ROOT", root.to_owned());
    }
    if let Some(actor) = ids.0.filter(|a| !a.is_empty()) {
        put("AGENT_ACTOR", actor.clone());
        let principal = if actor.starts_with("agent:") {
            actor
        } else {
            format!("agent:{actor}")
        };
        put("WRKQ_PRINCIPAL_REF", principal);
    }
    Ok(env)
}

/// `getAspHome()`.
fn asp_home() -> String {
    crate::reads::declaration::process_asp_home()
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
            Err(fwd("claude_not_found"))
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
    Err(fwd("claude_not_found"))
}

fn by_mode(v: Option<&J>, mode: &str) -> Vec<String> {
    let entry = v.and_then(|m| m.get(mode));
    let list = match entry {
        Some(J::Arr(items)) => Some(items),
        Some(o @ J::Obj(_)) => o.get("base").and_then(J::as_arr),
        _ => None,
    };
    list.into_iter()
        .flatten()
        .filter_map(J::as_str)
        .map(str::to_owned)
        .collect()
}

fn dedupe_spaces(refs: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = vec![];
    let mut out = vec![];
    for r in refs {
        let key = r.strip_suffix("@dev").unwrap_or(&r).to_owned();
        if !seen.contains(&key) {
            seen.push(key);
            out.push(r);
        }
    }
    out
}

/// `mergeClaudeOptions(defaults, overrides)` as `(model, permission_mode, args, ask)`.
type ClaudeOpts = (Option<J>, Option<J>, Option<J>, Option<J>);

fn claude_opts(v: Option<&J>) -> Option<ClaudeOpts> {
    let v = v?;
    Some((
        v.get("model").cloned(),
        v.get("permission_mode").cloned(),
        v.get("args").cloned(),
        v.get("ask_user_question").cloned(),
    ))
}

fn merge_claude(d: Option<ClaudeOpts>, o: Option<ClaudeOpts>) -> Option<ClaudeOpts> {
    match (d, o) {
        (None, None) => None,
        (Some(d), None) => Some(d),
        (None, Some(o)) => Some(o),
        (Some(d), Some(o)) => Some((o.0.or(d.0), o.1.or(d.1), o.2.or(d.2), o.3.or(d.3))),
    }
}

/// `mergeCodexOptions` + `getEffectiveCodexOptions`, as `J` with only the
/// defined keys (the fingerprint's canonical JSON drops `undefined`).
fn effective_codex_options(manifest: &J, target_name: &str) -> J {
    const KEYS: [&str; 6] = [
        "model",
        "model_reasoning_effort",
        "model_reasoning_summary",
        "status_line",
        "approval_policy",
        "sandbox_mode",
    ];
    let target = manifest.get("targets").and_then(|t| t.get(target_name));
    let provisioning = target.and_then(|t| t.get("provisioning"));
    let defaults = manifest.get("codex");
    let overrides = provisioning.and_then(|p| p.get("codex"));
    let mut out = match (defaults, overrides) {
        (None, None) => J::Obj(vec![]),
        (Some(d), None) => d.clone(),
        (None, Some(o)) => o.clone(),
        (Some(d), Some(o)) => J::Obj(
            KEYS.iter()
                .filter_map(|k| {
                    o.get(k)
                        .or_else(|| d.get(k))
                        .map(|v| ((*k).to_owned(), v.clone()))
                })
                .collect(),
        ),
    };
    for (scalar, key) in [
        ("model", "model"),
        ("reasoning_effort", "model_reasoning_effort"),
        ("approval", "approval_policy"),
        ("sandbox", "sandbox_mode"),
    ] {
        if let Some(v) = provisioning.and_then(|p| p.get(scalar)) {
            out.set(key, v.clone());
        }
    }
    out
}

/// `loadProjectManifest(projectPath, aspHome)`: the project manifest merged
/// over `$ASP_HOME/default-targets.toml`.
fn project_manifest(project_manifest: J, asp_home: &str) -> Result<J, Fwd> {
    let default_path = join(&[asp_home, "default-targets.toml"]);
    if !std::path::Path::new(&default_path).exists() {
        return Ok(project_manifest);
    }
    let content =
        std::fs::read_to_string(&default_path).map_err(|_| fwd("default_targets_unreadable"))?;
    let defaults = match crate::reads::targets::parse(&content) {
        Ok(m) => m,
        Err(crate::reads::targets::TargetsError::Forward(r)) => return Err(fwd(r)),
        Err(_) => return Err(fwd("default_targets_invalid")),
    };
    let mut targets = defaults.get("targets").cloned().unwrap_or(J::Obj(vec![]));
    if let Some(J::Obj(fields)) = project_manifest.get("targets") {
        for (k, v) in fields {
            targets.set(k, v.clone());
        }
    }
    let mut merged = J::obj([("schema", J::Num(2.0)), ("targets", targets)]);
    let (dc, pc) = (defaults.get("codex"), project_manifest.get("codex"));
    if dc.is_some() || pc.is_some() {
        let codex = effective_codex_options(
            &J::obj([
                ("codex", dc.cloned().unwrap_or(J::Null)),
                (
                    "targets",
                    J::obj([(
                        "_",
                        J::obj([(
                            "provisioning",
                            J::obj([("codex", pc.cloned().unwrap_or(J::Null))]),
                        )]),
                    )]),
                ),
            ]),
            "_",
        );
        merged.set("codex", codex);
    }
    // mergeCodexOptions(undefined, X) keeps X's keys: rebuild faithfully.
    if let (None, Some(p)) = (dc, pc) {
        merged.set("codex", p.clone());
    }
    if let (Some(d), None) = (dc, pc) {
        merged.set("codex", d.clone());
    }
    Ok(merged)
}

fn classify(params: &J, release: &Release) -> Result<Plan, Fwd> {
    let req = params.get("compileRequest").expect("validated").clone();
    let placement = req.get("placement").expect("validated").clone();
    let agent_root = s(placement.get("agentRoot")).unwrap_or_default().to_owned();
    let project_root = s(placement.get("projectRoot")).map(str::to_owned);
    let agent_name = s(placement.get("bundle").and_then(|b| b.get("agentName")))
        .unwrap_or_default()
        .to_owned();
    let bundle_project_root =
        s(placement.get("bundle").and_then(|b| b.get("projectRoot"))).map(str::to_owned);
    let run_mode = s(placement.get("runMode")).unwrap_or("task").to_owned();
    let material = req.get("materialization").expect("validated");
    let task_context = material.get("taskContext").cloned();

    // participantOnlyRefusal and the taskContext check refuse before writing.
    let profile = request::read_profile(&agent_root)?;
    if profile
        .typed
        .placement
        .as_ref()
        .and_then(|p| p.launch.as_deref())
        == Some("participant-only")
    {
        return Err(fwd("agent_participant_only"));
    }
    let scoped = handle_parts(
        &{
            let mut p = placement.clone();
            p.remove("projectRoot");
            p
        },
        false,
    )?;
    if let Some(tc) = &task_context
        && placement
            .get("correlation")
            .and_then(|c| c.get("sessionRef"))
            .is_some()
        && let Some(scoped_task) = &scoped.task_id
        && s(tc.get("taskId")) != Some(scoped_task.as_str())
    {
        return Err(fwd("configured_context_mismatch"));
    }

    // resolveCompileSources: the target comes from bundle.projectRoot.
    let targets_for_sources = request::read_targets(bundle_project_root.as_deref(), &agent_name)?;
    let (session_metadata, metadata_diagnostics) =
        request::session_metadata(&profile.raw, targets_for_sources.target.as_ref());
    let selection =
        request::resolve_selection(&req, &profile, targets_for_sources.target.as_ref())?;

    // resolvePlacementContext({ ...placement, dryRun: true }).
    let project_target = targets_for_sources.target.clone();
    let raw = &profile.raw;
    let priming = match profile.typed.priming.as_deref().filter(|p| !p.is_empty()) {
        Some(p) => Some(p.to_owned()),
        None => match profile
            .typed
            .priming_file
            .as_deref()
            .filter(|p| !p.is_empty())
        {
            Some(file) => Some(
                std::fs::read_to_string(join(&[&agent_root, file]))
                    .map_err(|_| fwd("priming_file_unreadable"))?,
            ),
            None => None,
        },
    };
    let effective_priming = match &project_target {
        None => priming.clone(),
        Some(t) => match (t.get("priming"), t.get("priming_append")) {
            (Some(_), Some(_)) => return Err(fwd("priming_conflict")),
            (Some(J::Str(p)), _) => Some(p.clone()),
            (_, Some(J::Str(a))) if priming.as_deref().is_some_and(|p| !p.is_empty()) => {
                Some(format!("{}\n{a}", priming.clone().unwrap_or_default()))
            }
            _ => priming.clone(),
        },
    };
    let agent_compose = dedupe_spaces(
        raw.get("spaces")
            .and_then(|sp| sp.get("base"))
            .and_then(J::as_arr)
            .into_iter()
            .flatten()
            .filter_map(J::as_str)
            .map(str::to_owned)
            .chain(by_mode(
                raw.get("spaces").and_then(|sp| sp.get("modes")),
                &run_mode,
            ))
            .collect(),
    );
    let compose: Vec<String> = match project_target
        .as_ref()
        .and_then(|t| t.get("compose"))
        .and_then(J::as_arr)
    {
        Some(c) if !c.is_empty() => {
            let target_compose: Vec<String> =
                c.iter().filter_map(J::as_str).map(str::to_owned).collect();
            if project_target
                .as_ref()
                .and_then(|t| s(t.get("compose_mode")))
                == Some("merge")
            {
                dedupe_spaces(agent_compose.into_iter().chain(target_compose).collect())
            } else {
                target_compose
            }
        }
        _ => agent_compose,
    };
    // Merged provisioning: target scalars over profile scalars.
    let target_prov = project_target.as_ref().and_then(|t| t.get("provisioning"));
    let scalar = |k: &str| -> Option<J> {
        target_prov
            .and_then(|p| p.get(k))
            .cloned()
            .or_else(|| profile.typed.scalar(k).cloned())
    };
    let effective_claude = merge_claude(
        claude_opts(raw.get("provisioning").and_then(|p| p.get("claude"))),
        claude_opts(target_prov.and_then(|p| p.get("claude"))),
    );
    let claude = ClaudeDefaults {
        permission_mode: effective_claude
            .as_ref()
            .and_then(|c| c.1.as_ref())
            .and_then(J::as_str)
            .map(str::to_owned),
        extra_args: effective_claude
            .as_ref()
            .and_then(|c| c.2.as_ref())
            .and_then(J::as_arr)
            .map(|a| a.iter().filter_map(J::as_str).map(str::to_owned).collect())
            .unwrap_or_default(),
        ask_user_question: effective_claude.as_ref().and_then(|c| match c.3 {
            Some(J::Bool(b)) => Some(b),
            _ => None,
        }),
        yolo: matches!(scalar("yolo"), Some(J::Bool(true))),
        remote: matches!(scalar("remote"), Some(J::Bool(true))),
    };

    // Instructions (audit only): SOUL, instructions.base, HEARTBEAT, modes.
    let resolved_bundle = {
        let mut instructions = vec![];
        let soul = join(&[&agent_root, "SOUL.md"]);
        if std::path::Path::new(&soul).exists() {
            let mut slots: Vec<(&str, String, String)> = vec![];
            let read = |path: &str| {
                std::fs::read(path)
                    .ok()
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
            };
            let soul_content = read(&soul).ok_or_else(|| fwd("soul_unreadable"))?;
            slots.push(("soul", soul_content, "agent-root:///SOUL.md".into()));
            let instruction_ref = |r: &str| -> Option<String> {
                let path = if r.starts_with("agent-root:///") || r.starts_with("project-root:///") {
                    let ctx = expansion_ctx_stub(&agent_root, project_root.as_deref());
                    prompt_ref(r, &ctx)?
                } else {
                    join(&[&agent_root, r])
                };
                if std::path::Path::new(&path).exists() {
                    read(&path)
                } else {
                    None
                }
            };
            let base = raw
                .get("instructions")
                .and_then(|i| i.get("base"))
                .and_then(J::as_arr);
            for r in base.into_iter().flatten().filter_map(J::as_str) {
                if let Some(c) = instruction_ref(r) {
                    slots.push(("additional-base", c, r.to_owned()));
                }
            }
            if run_mode == "heartbeat" {
                let hb = join(&[&agent_root, "HEARTBEAT.md"]);
                if let Some(c) = std::path::Path::new(&hb)
                    .exists()
                    .then(|| read(&hb))
                    .flatten()
                {
                    slots.push(("heartbeat", c, "agent-root:///HEARTBEAT.md".into()));
                }
            }
            for r in by_mode(
                raw.get("instructions").and_then(|i| i.get("modes")),
                &run_mode,
            ) {
                if let Some(c) = instruction_ref(&r) {
                    slots.push(("by-mode", c, r));
                }
            }
            for (slot, content, r) in slots {
                instructions.push(J::obj([
                    ("slot", J::str(slot)),
                    ("ref", J::str(r)),
                    (
                        "contentHash",
                        J::str(format!("sha256:{}", sha256_hex(content.as_bytes()))),
                    ),
                ]));
            }
        }
        let resolved_spaces: Vec<J> = dedupe_spaces(compose.clone())
            .iter()
            .map(|r| {
                let parsed = spaces::parse_space_ref(r);
                let key = match &parsed {
                    Ok(p) => match p.kind {
                        spaces::Kind::Agent => format!("{}@agent", p.id),
                        spaces::Kind::Project => format!("{}@project", p.id),
                        spaces::Kind::Dev => format!(
                            "{}@{}",
                            p.id,
                            r.split_once('@').map_or("dev", |(_, sel)| sel)
                        ),
                    },
                    Err(_) => r.clone(),
                };
                let integrity = space_audit_integrity(r, &agent_root, project_root.as_deref());
                J::obj([
                    ("ref", J::str(r)),
                    ("resolvedKey", J::str(key)),
                    ("integrity", J::str(integrity)),
                ])
            })
            .collect();
        let cwd = match s(placement.get("cwd")).filter(|c| !c.is_empty()) {
            Some(c) => c.to_owned(),
            None => bundle_project_root
                .clone()
                .unwrap_or_else(|| agent_root.clone()),
        };
        J::obj([
            (
                "bundleIdentity",
                J::str(bundle_identity(
                    &agent_root,
                    &agent_name,
                    bundle_project_root.as_deref(),
                )),
            ),
            ("runMode", J::str(&run_mode)),
            ("cwd", J::str(cwd)),
            ("instructions", J::Arr(instructions)),
            ("spaces", J::Arr(resolved_spaces)),
        ])
    };
    let bundle_identity = s(resolved_bundle.get("bundleIdentity"))
        .unwrap_or_default()
        .to_owned();
    let cwd = s(resolved_bundle.get("cwd")).unwrap_or_default().to_owned();
    // An explicit aspHome (both HRCs send theirs) anchors materialization and
    // prompt sources; absent, the daemon's own (promptSourcesForCompile).
    let explicit_asp_home = s(params.get("aspHome")).map(str::to_owned);
    let asp_home = explicit_asp_home.clone().unwrap_or_else(asp_home);

    let claude_path = find_claude()?;
    let agent_local = stage::AgentLocal::detect(&agent_root);
    // validateAgentTools throws in Bun after writes; judged here, before any.
    let tool_warnings = match &agent_local {
        Some(l) if l.has_tools => validate_agent_tools(&agent_root)?,
        _ => vec![],
    };

    // Identity: scope-ref facts (the only live branch).
    let handle = handle_parts(&placement, true)?;
    let (Some(agent_id), Some(project_id)) = (handle.agent_id.clone(), handle.project_id.clone())
    else {
        return Err(fwd("placement_identity_fallback"));
    };
    let identity = J::obj([
        ("agentId", J::str(&agent_id)),
        ("projectId", J::str(&project_id)),
        ("frontend", J::str("claude-code")),
    ]);

    // The preparation execution context (preparation-execution-context.ts).
    let prep_project_id = scoped
        .project_id
        .clone()
        .or_else(|| project_root.as_deref().map(|p| basename(&resolve(&[p]))));
    let prep_agent_id = if placement
        .get("correlation")
        .and_then(|c| c.get("sessionRef"))
        .is_some()
    {
        scoped
            .agent_id
            .clone()
            .unwrap_or_else(|| basename(&agent_root))
    } else {
        basename(&agent_root)
    };
    let correlation_env = agent_session_env(&placement)?;
    let mut exec_env: EnvMap = util::exec_environment().clone();
    for (k, v) in &correlation_env {
        exec_env.insert(k.clone(), v.clone());
    }
    exec_env.insert("AGENTCHAT_ID".into(), basename(&agent_root));
    if let Some(p) = &prep_project_id {
        exec_env.insert("ASP_PROJECT".into(), p.clone());
    }
    let env_json = J::Obj(
        exec_env
            .iter()
            .map(|(k, v)| (k.clone(), J::str(v)))
            .collect(),
    );
    let effective_environment_hash = match &task_context {
        None => hash(&env_json, false),
        Some(tc) => hash(
            &J::obj([("environment", env_json), ("taskContext", tc.clone())]),
            false,
        ),
    };

    // Spaces: closure over filesystem-backed refs, lock, snapshot presence.
    let env = Env::process();
    let registry = match crate::reads::declaration::agents_root(Some(&asp_home), env)
        .map_err(|_| fwd("agents_root_config"))?
    {
        Some(root) => root,
        None => join(&[&asp_home, "repo"]),
    };
    let roots = spaces::ClosureRoots {
        registry: &registry,
        agent_root: Some(&agent_root),
        project_root: project_root.as_deref(),
    };
    let closure = spaces::closure(&compose, &roots)?;
    let integrities = closure
        .spaces
        .iter()
        .map(|sp| spaces::integrity(sp, &roots))
        .collect::<Result<Vec<_>, _>>()?;
    let lock_path = join(&[&asp_home, "global-lock.json"]);
    let existing_lock = match std::fs::read(&lock_path) {
        Ok(bytes) => {
            let lock = crate::json::parse(&bytes).ok_or_else(|| fwd("global_lock_invalid"))?;
            if !spaces::lock_shape_ok(&lock) {
                return Err(fwd("global_lock_invalid"));
            }
            Some(lock)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(fwd("global_lock_unreadable")),
    };
    // populateSnapshotsFromLock walks the merged lock: every registry entry,
    // other targets' included, must already have its snapshot.
    if let Some(lock) = &existing_lock {
        for (_, entry) in lock.get("spaces").map(J::js_entries).unwrap_or_default() {
            if spaces::is_registry_entry(entry) {
                let integrity = s(entry.get("integrity")).unwrap_or_default();
                let snapshot = join(&[
                    &asp_home,
                    "snapshots",
                    integrity.trim_start_matches("sha256:"),
                ]);
                if !std::fs::metadata(&snapshot).is_ok_and(|m| m.is_dir()) {
                    return Err(fwd("snapshot_missing"));
                }
            }
        }
    }
    let mut space_plans = vec![];
    for (space, _) in closure.spaces.iter().zip(&integrities) {
        let (name, version) = spaces::plugin_identity(&space.manifest);
        let content_dir = match space.kind {
            spaces::Kind::Agent => join(&[&agent_root, "spaces", &space.id]),
            spaces::Kind::Project => join(&[
                project_root.as_deref().unwrap_or_default(),
                "spaces",
                &space.id,
            ]),
            spaces::Kind::Dev => join(&[&registry, "spaces", &space.id]),
        };
        let mut lock_plugin = J::obj([("name", J::str(&name))]);
        if let Some(v) = &version {
            lock_plugin.set("version", J::str(v));
        }
        space_plans.push(stage::plan_space(
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
    // The fingerprint's codex options (loadEffectiveCodexOptions).
    let codex_options = match &project_root {
        Some(root) if std::path::Path::new(&join(&[root, "asp-targets.toml"])).exists() => {
            let content = std::fs::read_to_string(join(&[root, "asp-targets.toml"]))
                .map_err(|_| fwd("source_read_unavailable"))?;
            let manifest = match crate::reads::targets::parse(&content) {
                Ok(m) => m,
                Err(crate::reads::targets::TargetsError::Forward(r)) => return Err(fwd(r)),
                Err(_) => return Err(fwd("project_targets_invalid")),
            };
            Some(effective_codex_options(
                &project_manifest(manifest, &asp_home)?,
                &agent_name,
            ))
        }
        _ => None,
    };

    // The launch prompt: priming (fresh only) plus the caller prompt, expanded.
    let caller_prompt = s(material.get("initialPrompt")).map(str::to_owned);
    let omit_priming = matches!(material.get("omitPriming"), Some(J::Bool(true)));
    // prepare-cli-runtime receives a continuation only when the key is set.
    let may_prime = s(req
        .get("continuation")
        .and_then(|c| c.get("hrc"))
        .and_then(|h| h.get("key")))
    .is_none();
    let priming_for_launch = if may_prime {
        effective_priming.clone()
    } else {
        None
    };
    let launch_prompt = if caller_prompt.as_deref() == Some("") {
        Some(String::new())
    } else if omit_priming {
        caller_prompt.clone()
    } else {
        match (&priming_for_launch, &caller_prompt) {
            (Some(p), Some(c)) => Some(format!("{p}\n\n{c}")),
            (p, c) => p.clone().or_else(|| c.clone()),
        }
    };
    let expansion = Ctx {
        agent_root: agent_root.clone(),
        agents_root: dirname(&agent_root),
        search_path: prompt::agent_root_search_path(
            project_root.as_deref(),
            prompt::Roots::Ambient,
        )?
        .0,
        project_root: project_root.clone(),
        project_id: handle.project_id.clone(),
        agent_id: handle.agent_id.clone(),
        agent_name: None,
        task_id: handle.task_id.clone(),
        task_context: None,
        lane: handle.lane.clone(),
        run_mode: run_mode.clone(),
        agent_profile: None,
        env: None,
        exec_env: None,
    };
    let expanded_prompt = match &launch_prompt {
        Some(p) => Some(prompt::interpolate(p, &expansion)?),
        None => None,
    };

    // The system prompt, resolved now (exec sections and probes run here).
    let discovered = prompt::discover(
        &agent_root,
        project_root.as_deref(),
        &asp_home,
        explicit_asp_home.is_some(),
    )?;
    let system_prompt = if discovered.template.is_none()
        && !std::path::Path::new(&join(&[&agent_root, "SOUL.md"])).exists()
    {
        None
    } else {
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
        let template = match discovered.template {
            Some(t) => t,
            None => prompt::default_template(discovered.base.as_deref().unwrap_or_default()),
        };
        let ctx = Ctx {
            agent_root: agent_root.clone(),
            agents_root: discovered.agents_root.clone(),
            search_path: discovered.search_path.clone(),
            project_root: project_root.clone(),
            project_id: prep_project_id.clone(),
            agent_id: Some(prep_agent_id.clone()),
            agent_name: Some(basename(&agent_root)),
            task_id: scoped.task_id.clone(),
            task_context: task_context.clone(),
            lane: scoped.lane.clone(),
            run_mode: run_mode.clone(),
            agent_profile,
            env: Some(exec_env.clone()),
            exec_env: Some(exec_env.clone()),
        };
        Some(prompt::resolve_template(&template, &ctx)?)
    };

    let statusline = release_statusline(release)?;
    Ok(Plan {
        params: params.clone(),
        req,
        agent_root,
        project_root,
        agent_name,
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
        existing_lock,
        space_plans,
        agent_local,
        identity,
        codex_options,
        claude,
        claude_path,
        system_prompt,
        expanded_prompt,
        handle,
        effective_environment_hash,
        correlation_env,
        statusline,
        tool_warnings,
    })
}

fn expansion_ctx_stub(agent_root: &str, project_root: Option<&str>) -> Ctx {
    Ctx {
        agent_root: agent_root.to_owned(),
        agents_root: dirname(agent_root),
        search_path: vec![],
        project_root: project_root.map(str::to_owned),
        project_id: None,
        agent_id: None,
        agent_name: None,
        task_id: None,
        task_context: None,
        lane: None,
        run_mode: "task".into(),
        agent_profile: None,
        env: None,
        exec_env: None,
    }
}

/// `resolveRootRelativeRef` for an instruction ref; `None` where Bun's
/// `resolveInstructionRef` swallows the throw.
fn prompt_ref(r: &str, ctx: &Ctx) -> Option<String> {
    prompt::root_relative(r, ctx)
}

/// `computeSpaceIntegrity` (audit only).
fn space_audit_integrity(r: &str, agent_root: &str, project_root: Option<&str>) -> String {
    let fs_integrity = |root: &str, prefix: &str, marker: &str| {
        let stripped = r.strip_prefix(prefix).unwrap_or(r);
        let id = stripped.split('@').next().unwrap_or(stripped);
        let path = join(&[root, "spaces", id]);
        if std::path::Path::new(&path).exists() {
            format!("sha256:{}", sha256_hex(format!("dir:{path}").as_bytes()))
        } else {
            marker.to_owned()
        }
    };
    if r.contains("agent:") {
        return fs_integrity(agent_root, "space:agent:", "sha256:agent");
    }
    if r.contains("project:")
        && let Some(root) = project_root.filter(|p| !p.is_empty())
    {
        return fs_integrity(root, "space:project:", "sha256:project");
    }
    "sha256:pending".into()
}

/// `computeBundleIdentity` for an agent-project bundle.
fn bundle_identity(agent_root: &str, agent_name: &str, project_root: Option<&str>) -> String {
    let material = format!(
        "{agent_root}\0agent-project:{agent_name}:{}",
        project_root.unwrap_or("")
    );
    format!("bundle:{}", &sha256_hex(material.as_bytes())[..16])
}

fn release_statusline(release: &Release) -> Result<stage::Statusline, Fwd> {
    let manifest = release_manifest(release)?;
    let asset = manifest
        .get("assets")
        .and_then(|a| a.get("claude-statusline"));
    let (Some(path), Some(sha)) = (
        s(asset.and_then(|a| a.get("path"))),
        s(asset.and_then(|a| a.get("sha256"))),
    ) else {
        return Err(fwd("release_statusline_missing"));
    };
    let root = release.root.to_string_lossy().into_owned();
    let full = resolve(&[&root, path]);
    if !full.starts_with(&format!("{root}/")) {
        return Err(fwd("release_statusline_escapes"));
    }
    Ok(stage::Statusline {
        path: full,
        sha256: sha.to_owned(),
    })
}

fn release_manifest(release: &Release) -> Result<J, Fwd> {
    let bytes =
        std::fs::read(release.root.join("release.json")).map_err(|_| fwd("release_manifest"))?;
    crate::json::parse(&bytes).ok_or_else(|| fwd("release_manifest"))
}

/// `executionRelease` for the claude-code-tmux worker, from release.json's
/// worker bindings (aspd.ts `resolveAspdReleaseBinding`).
fn execution_release(release: &Release, protocol: &str) -> Result<J, Fwd> {
    let manifest = release_manifest(release)?;
    let root = release.root.to_string_lossy().into_owned();
    let bindings = manifest
        .get("workerBindings")
        .filter(|b| b.is_record())
        .ok_or_else(|| fwd("release_workers"))?;
    let mut workers: Vec<(String, String)> = vec![];
    for (driver, executable) in bindings.js_entries() {
        let name = executable.as_str().ok_or_else(|| fwd("release_workers"))?;
        let launcher = s(manifest
            .get("executables")
            .and_then(|e| e.get(name))
            .and_then(|e| e.get("launcher")))
        .ok_or_else(|| fwd("release_workers"))?;
        let real = std::fs::canonicalize(join(&[&root, launcher]))
            .map_err(|_| fwd("release_workers"))?
            .to_string_lossy()
            .into_owned();
        workers.push((driver.to_owned(), real));
    }
    let Some((_, executable)) = workers.iter().find(|(d, _)| d == "claude-code-tmux") else {
        return Err(fwd("release_worker_driver_unavailable"));
    };
    let mut hosted: Vec<String> = workers
        .iter()
        .filter(|(_, e)| e == executable)
        .map(|(d, _)| d.clone())
        .collect();
    hosted.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(J::obj([
        ("releaseId", J::str(&release.release_id)),
        ("sourceCommit", J::str(&release.source_commit)),
        ("builtAt", J::str(&release.built_at)),
        ("releaseRoot", J::str(&root)),
        (
            "worker",
            J::obj([
                ("protocol", J::str(protocol)),
                ("executable", J::str(executable)),
                (
                    "hostedDrivers",
                    J::Arr(hosted.into_iter().map(J::Str).collect()),
                ),
                (
                    "argvPrefix",
                    J::Arr(["run", "--transport", "unix"].map(J::str).to_vec()),
                ),
            ]),
        ),
    ]))
}

// -- writes and emission ---------------------------------------------------------

fn materialize_and_emit(plan: Plan, release: &Release) -> Result<J, Fwd> {
    let asp_home = &plan.asp_home;
    let target_name = plan.agent_name.clone();
    stage::sweep_temp(asp_home);
    // ensureAspHome() creates the process ASP_HOME's directories.
    let process_home = crate::reads::declaration::process_asp_home();
    for d in ["repo", "sources", "snapshots", "cache", "projects", "tmp"] {
        let _ = std::fs::create_dir_all(join(&[&process_home, d]));
    }

    // Lock file: generate, then merge-write under the lock file's lock.
    let new_lock = spaces::generate_lock(
        &target_name,
        &plan.compose,
        &plan.closure,
        &plan.integrities,
    );
    let lock_key = format!(
        "lock-file-{}",
        &sha256_hex(resolve(&[&plan.lock_path]).as_bytes())[..32]
    );
    let lock_lock = stage::materialization_lock_path(asp_home, &lock_key);
    let lock_path = plan.lock_path.clone();
    let wrote = lockfile::with_lock(
        &lock_lock,
        &lockfile::MATERIALIZATION,
        || -> Result<(), Fwd> {
            let current = match std::fs::read(&lock_path) {
                Ok(bytes) => {
                    Some(crate::json::parse(&bytes).ok_or_else(|| fwd("global_lock_invalid"))?)
                }
                Err(_) => None,
            };
            let merged = match &current {
                Some(c) => spaces::merge_locks(c, &new_lock),
                None => new_lock.clone(),
            };
            atomic_write(&lock_path, &format!("{}\n", merged.to_json_pretty()))
        },
    )
    .map_err(|_| fwd("global_lock_lock"))?;
    wrote?;
    let _ = &plan.existing_lock;

    // Plugin artifacts, the agent-local plugin, then the bundle.
    let mut artifacts = vec![];
    let mut permissions = vec![];
    let cleanup = |artifacts: &Vec<stage::Artifact>| {
        for a in artifacts {
            let _ = std::fs::remove_dir_all(&a.path);
        }
    };
    for sp in &plan.space_plans {
        match stage::stage_space(sp, asp_home) {
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
    let project_id = plan
        .identity
        .get("projectId")
        .and_then(J::as_str)
        .unwrap_or_default();
    let agent_id = plan
        .identity
        .get("agentId")
        .and_then(J::as_str)
        .unwrap_or_default();
    let input = stage::TargetInput {
        target_name: &target_name,
        identity: &plan.identity,
        lock_target: &lock_target,
        codex_options: plan.codex_options.as_ref(),
        public_scope_root: join(&[
            asp_home,
            "codex-homes",
            &format!(
                "{}_{}",
                sanitize_segment(project_id),
                sanitize_segment(agent_id)
            ),
        ]),
        statusline: &plan.statusline,
    };
    let fingerprint = stage::fingerprint(&input, &artifacts, &hashes);
    let bundle =
        match stage::publish_target(&input, &artifacts, &permissions, &fingerprint, asp_home) {
            Ok(b) => b,
            Err(e) => {
                cleanup(&artifacts);
                return Err(e);
            }
        };
    stage::check_skill_and_command_conflicts(&bundle.plugin_dirs)?;

    // The system prompt artifact, inside the versioned bundle.
    let system_prompt_path = match &plan.system_prompt {
        Some(sp) => Some(stage::write_prompt_artifact(
            &join(&[&bundle.root_dir, ".asp-runtime-artifacts"]),
            sp.prompt.as_deref().unwrap_or(""),
        )?),
        None => None,
    };
    let bundle = stage::load_bundle(&bundle.root_dir)?;

    // Workspace trust for the launch cwd (warnings, never failures).
    let mut warnings = workspace_trust(&plan.cwd);

    // Agent tool runtime env (mkdirs under the agent's var/) and its warnings.
    let (tool_env, path_prepend) = agent_tool_env(&plan)?;
    warnings.extend(plan.tool_warnings.iter().cloned());

    emit(
        &plan,
        release,
        &bundle,
        system_prompt_path,
        &mut warnings,
        tool_env,
        path_prepend,
    )
}

/// `atomicWriteJson`: temp file, fsync, rename.
fn atomic_write(path: &str, content: &str) -> Result<(), Fwd> {
    let dir = dirname(path);
    std::fs::create_dir_all(&dir).map_err(|_| fwd("atomic_write"))?;
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
        return Err(fwd("atomic_write"));
    }
    Ok(())
}

/// `ensureClaudeWorkspaceTrust(cwd)`: the warnings it reports.
fn workspace_trust(cwd: &str) -> Vec<String> {
    let env = Env::process();
    let config = match env
        .get("CLAUDE_CONFIG_DIR")
        .map(util::js_trim)
        .filter(|d| !d.is_empty())
    {
        Some(dir) => join(&[dir, ".claude.json"]),
        None => join(&[&crate::reads::homedir(), ".claude.json"]),
    };
    let mut keys = vec![cwd.to_owned()];
    if let Ok(real) = std::fs::canonicalize(cwd) {
        let real = real.to_string_lossy().into_owned();
        if real != cwd {
            keys.push(real);
        }
    }
    let mut warnings = vec![];
    let trusted = |state: &J, key: &str| {
        state
            .get("projects")
            .filter(|p| p.is_record())
            .and_then(|p| p.get(key))
            .filter(|e| e.is_record())
            .and_then(|e| e.get("hasTrustDialogAccepted"))
            == Some(&J::Bool(true))
    };
    let read = |path: &str| -> Result<J, String> {
        match std::fs::read(path) {
            Ok(bytes) => match crate::json::parse(&bytes) {
                Some(v) if v.is_record() => Ok(v),
                Some(_) => Err(format!("{path} does not contain a JSON object")),
                None => Err("JSON Parse error".into()),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(J::Obj(vec![])),
            Err(e) => Err(e.to_string()),
        }
    };
    for attempt in 1..=3 {
        let outcome = (|| -> Result<bool, String> {
            let mut state = read(&config)?;
            let missing: Vec<&String> = keys.iter().filter(|k| !trusted(&state, k)).collect();
            if missing.is_empty() {
                return Ok(true);
            }
            let mut projects = state
                .get("projects")
                .filter(|p| p.is_record())
                .cloned()
                .unwrap_or(J::Obj(vec![]));
            for key in &missing {
                let mut entry = projects
                    .get(key)
                    .filter(|e| e.is_record())
                    .cloned()
                    .unwrap_or(J::Obj(vec![]));
                entry.set("hasTrustDialogAccepted", J::Bool(true));
                projects.set(key, entry);
            }
            state.set("projects", projects);
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mode = std::fs::metadata(&config)
                .map(|m| m.permissions().mode() & 0o777)
                .unwrap_or(0o600);
            let tmp = join(&[
                &dirname(&config),
                &format!(
                    ".claude.json.asp-trust-{}-{}.tmp",
                    std::process::id(),
                    util::hex_bytes(&util::random_bytes::<4>())
                ),
            ]);
            let written = (|| -> std::io::Result<()> {
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(mode)
                    .open(&tmp)?;
                f.write_all(format!("{}\n", state.to_json_pretty()).as_bytes())?;
                std::fs::rename(&tmp, &config)
            })();
            if let Err(e) = written {
                let _ = std::fs::remove_file(&tmp);
                return Err(e.to_string());
            }
            let verify = read(&config)?;
            let lost: Vec<&String> = keys.iter().filter(|k| !trusted(&verify, k)).collect();
            if lost.is_empty() {
                return Ok(true);
            }
            warnings.push(format!(
                "Workspace-trust write for {} was clobbered by a concurrent writer (attempt {attempt}/3)",
                lost.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
            ));
            Ok(false)
        })();
        match outcome {
            Ok(true) => return warnings,
            Ok(false) => {}
            Err(reason) => warnings.push(format!(
                "Workspace-trust seeding failed for {cwd} (attempt {attempt}/3): {reason}"
            )),
        }
        if attempt < 3 {
            std::thread::sleep(std::time::Duration::from_millis(50 * attempt as u64));
        }
    }
    warnings.push(format!(
        "Workspace trust for {cwd} could not be recorded in {config}; an interactive Claude launch may block on the trust prompt"
    ));
    warnings
}

/// An env in insertion order.
type EnvPairs = Vec<(String, String)>;

/// `prepareAgentToolRuntime`: the agent var dirs, the tool env, and the
/// typed PATH prepend.
fn agent_tool_env(plan: &Plan) -> Result<(EnvPairs, Vec<String>), Fwd> {
    let agent_root = &plan.agent_root;
    let agent_name = basename(agent_root);
    let var = join(&[agent_root, "var"]);
    let state = join(&[&var, "state"]);
    let cache = join(&[&var, "cache"]);
    let logs = join(&[&var, "logs"]);
    for d in [&state, &cache, &logs] {
        std::fs::create_dir_all(d).map_err(|_| fwd("agent_var_dirs"))?;
    }
    let mut env = vec![
        ("ASP_AGENT_ROOT".to_owned(), agent_root.clone()),
        ("ASP_AGENT_NAME".into(), agent_name.clone()),
        ("ASP_AGENT_VAR_DIR".into(), var.clone()),
        ("ASP_AGENT_STATE_DIR".into(), state.clone()),
        ("ASP_AGENT_CACHE_DIR".into(), cache),
        ("ASP_AGENT_LOG_DIR".into(), logs),
    ];
    if let Some(project_root) = &plan.project_root {
        let project = plan
            .correlation_env
            .iter()
            .find(|(k, _)| k == "AGENT_PROJECT")
            .map(|(_, v)| v.clone());
        let project_id = match project {
            Some(p) => format!("{}_{}", sanitize_segment(&p), sanitize_segment(&agent_name)),
            None => format!(
                "{}_{}",
                sanitize_segment(&basename(&resolve(&[project_root]))),
                sanitize_segment(&agent_name)
            ),
        };
        let project_state = join(&[&state, "projects", &project_id]);
        std::fs::create_dir_all(&project_state).map_err(|_| fwd("agent_var_dirs"))?;
        env.push(("ASP_PROJECT_ROOT".into(), project_root.clone()));
        env.push(("ASP_PROJECT_ID".into(), project_id));
        env.push(("ASP_PROJECT_STATE_DIR".into(), project_state));
    }
    let mut path_prepend = vec![];
    if plan.agent_local.as_ref().is_some_and(|l| l.has_tools) {
        let tools = join(&[agent_root, "tools"]);
        let bin = join(&[&tools, "bin"]);
        env.push(("ASP_AGENT_TOOLS_DIR".into(), tools));
        env.push(("ASP_AGENT_TOOLS_BIN".into(), bin.clone()));
        // PATH from the caller's dispatch env, else the daemon's.
        let dispatch_path = plan
            .req
            .get("placement")
            .and_then(|p| p.get("dispatchEnv"))
            .and_then(|d| d.get("PATH"))
            .and_then(J::as_str)
            .map(str::to_owned);
        let current = dispatch_path
            .or_else(|| util::exec_environment().get("PATH").cloned())
            .unwrap_or_default();
        if current.split(':').next() != Some(bin.as_str()) || current.is_empty() {
            path_prepend.push(bin);
        }
    }
    Ok((env, path_prepend))
}

const RESERVED_TOOL_NAMES: [&str; 41] = [
    "sh",
    "bash",
    "zsh",
    "env",
    "sudo",
    "su",
    "node",
    "npm",
    "npx",
    "bun",
    "bunx",
    "python",
    "python3",
    "pip",
    "pip3",
    "ruby",
    "perl",
    "go",
    "cargo",
    "claude",
    "codex",
    "pi",
    "hrc",
    "hrcchat",
    "acp",
    "asp",
    "wrkq",
    "stackctl",
    "agentchat",
    "git",
    "gh",
    "curl",
    "wget",
    "jq",
    "sed",
    "awk",
    "grep",
    "find",
    "xargs",
    "make",
    "just",
];

/// `validateAgentTools(components)`: its warnings, or a forward where Bun throws.
fn validate_agent_tools(agent_root: &str) -> Result<Vec<String>, Fwd> {
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    let tools = join(&[agent_root, "tools"]);
    let bin = join(&[&tools, "bin"]);
    let tools_real = std::fs::canonicalize(&tools).map_err(|_| fwd("agent_tools_invalid"))?;
    let tools_real = tools_real.to_string_lossy().into_owned();
    let mut warnings = vec![];
    for entry in std::fs::read_dir(&bin).map_err(|_| fwd("agent_tools_invalid"))? {
        let entry = entry.map_err(|_| fwd("agent_tools_invalid"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let pattern_ok = name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
            && name.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')
            });
        if !pattern_ok || RESERVED_TOOL_NAMES.contains(&name.as_str()) {
            return Err(fwd("agent_tools_invalid"));
        }
        let path = join(&[&bin, &name]);
        let meta = std::fs::symlink_metadata(&path).map_err(|_| fwd("agent_tools_invalid"))?;
        let resolved = if meta.file_type().is_symlink() {
            let real = std::fs::canonicalize(&path).map_err(|_| fwd("agent_tools_invalid"))?;
            let real = real.to_string_lossy().into_owned();
            if real != tools_real && !real.starts_with(&format!("{tools_real}/")) {
                return Err(fwd("agent_tools_invalid"));
            }
            real
        } else if meta.is_file() {
            path.clone()
        } else {
            return Err(fwd("agent_tools_invalid"));
        };
        let target = std::fs::metadata(&resolved).map_err(|_| fwd("agent_tools_invalid"))?;
        if !target.is_file() || target.permissions().mode() & 0o111 == 0 {
            return Err(fwd("agent_tools_invalid"));
        }
        let mut head = vec![];
        std::fs::File::open(&resolved)
            .and_then(|f| f.take(4096).read_to_end(&mut head))
            .map_err(|_| fwd("agent_tools_invalid"))?;
        if !head.is_empty() && !head.contains(&0) && !head.starts_with(b"#!") {
            warnings.push(format!(
                "Agent tool \"{name}\" is executable text but has no shebang"
            ));
        }
    }
    Ok(warnings)
}

fn remote_control_suffix() -> String {
    let b = util::random_bytes::<4>();
    let mut value = u32::from_be_bytes(b) % 36u32.pow(4);
    let mut digits = vec![];
    for _ in 0..4 {
        let d = (value % 36) as u8;
        digits.push(if d < 10 { b'0' + d } else { b'a' + d - 10 } as char);
        value /= 36;
    }
    digits.iter().rev().collect()
}

fn emit(
    plan: &Plan,
    release: &Release,
    bundle: &stage::Bundle,
    system_prompt_path: Option<String>,
    warnings: &mut [String],
    tool_env: Vec<(String, String)>,
    path_prepend: Vec<String>,
) -> Result<J, Fwd> {
    let req = &plan.req;
    let material = req.get("materialization").expect("validated");
    let policy = req.get("hrcPolicy").expect("validated");
    let continuation_key = s(req
        .get("continuation")
        .and_then(|c| c.get("hrc"))
        .and_then(|h| h.get("key")));
    let prompt = plan.expanded_prompt.clone();
    let task_id = s(material.get("taskContext").and_then(|t| t.get("taskId")));

    // ClaudeAdapter.buildRunArgs(bundle, runOptions).
    let yolo = plan.claude.yolo;
    let permission_mode = plan
        .claude
        .permission_mode
        .clone()
        .or_else(|| yolo.then(|| "bypassPermissions".into()));
    let prompt_args: Vec<String> = match prompt.as_deref() {
        Some(p) if !p.is_empty() => vec![p.to_owned()],
        _ => vec![],
    };
    let session_args: Vec<String> = match continuation_key {
        Some(k) if !k.is_empty() => vec!["--resume".into(), k.to_owned()],
        _ => vec!["--session-id".into(), util::random_uuid()],
    };
    let mut extra: Vec<String> = vec!["--chrome".into()];
    if yolo {
        extra.push("--dangerously-skip-permissions".into());
    }
    if plan.claude.remote {
        let project_segment = plan
            .handle
            .project_id
            .clone()
            .unwrap_or_else(|| basename(&plan.cwd));
        let parts: Vec<&str> = [
            Some(plan.agent_name.as_str()),
            Some(project_segment.as_str()),
            plan.handle.task_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect();
        let name = format!("{}-{}", parts.join("-"), remote_control_suffix());
        extra.extend([
            "--remote-control".into(),
            "--remote-control-session-name-prefix".into(),
            name.clone(),
            "--name".into(),
            name,
        ]);
    }
    if let Some(e) = &plan.selection.reasoning_effort
        && !e.is_empty()
    {
        extra.extend(["--effort".into(), e.clone()]);
    }
    extra.extend(plan.claude.extra_args.iter().cloned());
    extra.extend(session_args);
    if prompt_args.len() == 1 {
        extra.push("--".into());
    }
    extra.extend(prompt_args);
    let disallowed_request: Vec<String> = policy
        .get("disallowedTools")
        .and_then(J::as_arr)
        .map(|a| a.iter().filter_map(J::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    let mut args: Vec<String> = vec![];
    for dir in &bundle.plugin_dirs {
        args.extend(["--plugin-dir".into(), dir.clone()]);
    }
    if let Some(mcp) = &bundle.mcp_config_path {
        args.extend(["--mcp-config".into(), mcp.clone()]);
    }
    args.extend(["--model".into(), plan.selection.model.clone()]);
    if let Some(mode) = permission_mode.filter(|m| !m.is_empty()) {
        args.extend(["--permission-mode".into(), mode]);
    }
    let mut disallowed = disallowed_request.clone();
    if plan.claude.ask_user_question != Some(true) {
        disallowed.push("AskUserQuestion".into());
    }
    if !disallowed.is_empty() {
        args.push("--disallowedTools".into());
        args.extend(disallowed);
    }
    args.extend(["--setting-sources".into(), String::new()]);
    args.extend(["--settings".into(), bundle.settings_path.clone()]);
    if let Some(sp) = &plan.system_prompt
        && let Some(content) = sp.prompt.as_deref().filter(|c| !c.is_empty())
    {
        args.extend([
            if sp.append {
                "--append-system-prompt"
            } else {
                "--system-prompt"
            }
            .into(),
            content.to_owned(),
        ]);
    }
    args.extend(extra);

    // Env: adapter env, agentchat env, ASP_HOME, then the tool runtime env.
    let mut locked: Vec<(String, String)> =
        vec![("ASP_PLUGIN_ROOT".into(), bundle.root_dir.clone())];
    if let Some(p) = prompt.as_deref().filter(|p| !p.is_empty()) {
        locked.push(("ASP_PRIMING_PROMPT".into(), p.to_owned()));
    }
    locked.push(("AGENTCHAT_ID".into(), basename(&plan.agent_root)));
    if let Some(root) = &plan.project_root {
        locked.push((
            "ASP_PROJECT".into(),
            plan.handle
                .project_id
                .clone()
                .unwrap_or_else(|| basename(&resolve(&[root]))),
        ));
    }
    let mut set = |k: String, v: String| match locked.iter_mut().find(|(e, _)| *e == k) {
        Some(slot) => slot.1 = v,
        None => locked.push((k, v)),
    };
    set("ASP_HOME".into(), plan.asp_home.clone());
    for (k, v) in tool_env {
        set(k, v);
    }
    let locked_env = J::Obj(locked.iter().map(|(k, v)| (k.clone(), J::str(v))).collect());

    // The start request (compileTmuxBrokerPlan).
    let mut launch = J::Obj(vec![]);
    if let Some(path) = &system_prompt_path {
        launch.set("systemPromptFile", J::str(path));
    }
    if let Some(sp) = &plan.system_prompt {
        launch.set(
            "systemPromptMode",
            J::str(if sp.append { "append" } else { "replace" }),
        );
    }
    if let Some(p) = &prompt {
        launch.set("initialPrompt", J::str(p));
    }
    let mut process = J::obj([
        ("command", J::str(&plan.claude_path)),
        ("args", J::Arr(args.iter().map(J::str).collect())),
        ("cwd", J::str(&plan.cwd)),
        ("lockedEnv", locked_env.clone()),
    ]);
    if !path_prepend.is_empty() {
        process.set(
            "pathPrepend",
            J::Arr(path_prepend.iter().map(J::str).collect()),
        );
    }
    process.set("harnessTransport", J::obj([("kind", J::str("pty"))]));
    if let Some(limits) = policy.get("resourceLimits") {
        let mut l = J::Obj(vec![]);
        for k in [
            "startupTimeoutMs",
            "turnTimeoutMs",
            "stopGraceMs",
            "maxEventBytes",
        ] {
            if let Some(v) = limits.get(k) {
                l.set(k, v.clone());
            }
        }
        process.set("limits", l);
    }
    let mut spec = J::obj([("specVersion", J::str("harness-broker.invocation/v1"))]);
    if let Some(inv) = req.get("identity").and_then(|i| i.get("invocationId")) {
        spec.set("invocationId", inv.clone());
    }
    if let Some(t) = task_id {
        spec.set("labels", J::obj([("task", J::str(t))]));
    }
    spec.set(
        "harness",
        J::obj([
            ("frontend", J::str("claude-code")),
            ("provider", J::str("anthropic")),
            ("driver", J::str("claude-code-tmux")),
        ]),
    );
    spec.set("process", process);
    spec.set(
        "interaction",
        J::obj([
            ("mode", J::str("interactive")),
            ("turnConcurrency", J::str("single")),
            ("inputQueue", J::str("fifo")),
        ]),
    );
    if let Some(k) = continuation_key {
        spec.set(
            "continuation",
            J::obj([
                ("provider", J::str("anthropic")),
                ("key", J::str(k)),
                ("kind", J::str("session")),
            ]),
        );
    }
    spec.set(
        "driver",
        J::obj([
            ("kind", J::str("claude-code-tmux")),
            ("terminalHost", J::str("tmux")),
        ]),
    );
    if matches!(&launch, J::Obj(f) if !f.is_empty()) {
        spec.set("launch", launch);
    }
    let correlation = req.get("correlation").expect("validated");
    let mut broker_correlation = J::Obj(vec![]);
    for k in [
        "requestId",
        "hostSessionId",
        "operationId",
        "runtimeId",
        "runId",
        "invocationId",
        "inputId",
        "traceId",
        "scopeRef",
        "laneRef",
    ] {
        if let Some(v) = correlation.get(k) {
            broker_correlation.set(k, v.clone());
        }
    }
    spec.set("correlation", broker_correlation);
    let start_request = J::obj([("spec", spec)]);

    finalize(
        plan,
        release,
        start_request,
        locked,
        warnings,
        system_prompt_path,
        bundle,
    )
}

fn recipe_dto() -> J {
    J::obj([
        ("recipeId", J::str("claude-code")),
        ("driver", J::str("claude-code-tmux")),
        ("protocol", J::str("harness-broker/0.2")),
        (
            "hosting",
            J::obj([
                ("executionTransport", J::str("pty")),
                ("terminalRequired", J::Bool(true)),
                ("terminalHost", J::str("tmux")),
                ("processExecution", J::str("broker-process")),
            ]),
        ),
        ("presentationFulfillment", J::str("intrinsic")),
    ])
}

/// `hashNeutralStartRequest`: the spec without invocationId and correlation.
fn neutral_start_request(start: &J) -> J {
    let mut spec = start.get("spec").cloned().unwrap_or(J::Null);
    spec.remove("invocationId");
    spec.remove("correlation");
    J::obj([("spec", spec)])
}

fn finalize(
    plan: &Plan,
    release: &Release,
    start_request: J,
    locked: Vec<(String, String)>,
    warnings: &mut [String],
    system_prompt_path: Option<String>,
    bundle: &stage::Bundle,
) -> Result<J, Fwd> {
    let req = &plan.req;
    let policy = req.get("hrcPolicy").expect("validated");
    let neutral = neutral_start_request(&start_request);
    let spec = neutral.get("spec").cloned().unwrap_or(J::Null);
    let process = spec.get("process").cloned().unwrap_or(J::Null);
    let mut process_material = J::Obj(vec![]);
    for k in ["command", "args", "cwd"] {
        if let Some(v) = process.get(k) {
            process_material.set(k, v.clone());
        }
    }
    process_material.set(
        "lockedEnv",
        J::Obj(locked.iter().map(|(k, v)| (k.clone(), J::str(v))).collect()),
    );
    for k in ["pathPrepend", "harnessTransport", "limits"] {
        if let Some(v) = process.get(k) {
            process_material.set(k, v.clone());
        }
    }
    let selection = &plan.selection.selection;
    let mut model = J::obj([
        (
            "provider",
            selection.get("modelProvider").cloned().unwrap_or(J::Null),
        ),
        (
            "requestedModel",
            selection.get("model").cloned().unwrap_or(J::Null),
        ),
    ]);
    if let Some(e) = selection.get("reasoningEffort") {
        model.set("reasoningEffort", e.clone());
    }
    let mut compat = J::obj([
        (
            "bundle",
            J::obj([("bundleIdentity", J::str(&plan.bundle_identity))]),
        ),
        ("model", model),
        ("process", process_material),
        ("driver", spec.get("driver").cloned().unwrap_or(J::Null)),
    ]);
    if let Some(c) = req.get("continuation") {
        let hrc = c.get("hrc").cloned().unwrap_or(J::Null);
        let mut h = J::Obj(vec![]);
        for k in ["provider", "continuationId"] {
            if let Some(v) = hrc.get(k) {
                h.set(k, v.clone());
            }
        }
        let mut cont = J::obj([("hrc", h)]);
        if let Some(b) = c.get("broker") {
            let mut bm = J::Obj(vec![]);
            for k in ["provider", "kind", "continuationId"] {
                if let Some(v) = b.get(k) {
                    bm.set(k, v.clone());
                }
            }
            cont.set("broker", bm);
        }
        if let Some(src) = c.get("source") {
            cont.set("source", src.clone());
        }
        compat.set("continuation", cont);
    }
    let mut policy_material = J::Obj(vec![]);
    if let Some(p) = policy.get("permissionPolicy") {
        policy_material.set("permissionPolicy", p.clone());
    }
    policy_material.set(
        "inputPolicy",
        policy.get("inputPolicy").cloned().unwrap_or_else(|| {
            J::obj([
                ("readyInput", J::str("start-turn")),
                ("busy", J::obj([("whenBusy", J::str("reject"))])),
                ("supportedKinds", J::Arr(vec![J::str("user")])),
                (
                    "attachmentPolicy",
                    J::obj([("localImages", J::Bool(true)), ("fileRefs", J::Bool(false))]),
                ),
            ])
        }),
    );
    policy_material.set(
        "exposurePolicy",
        policy
            .get("exposurePolicy")
            .cloned()
            .unwrap_or_else(|| J::obj([("mode", J::str("none"))])),
    );
    if let Some(r) = policy.get("resourceLimits") {
        policy_material.set("resourceLimits", r.clone());
    }
    compat.set("policy", policy_material);
    let compatibility_hash = hash(&compat, true);
    let start_request_hash = hash(&neutral, true);
    let profile_id = format!(
        "profile_{}",
        &hash(
            &J::obj([
                ("recipeId", J::str("claude-code")),
                ("startRequest", neutral.clone())
            ]),
            true
        )[..32]
    );
    let profile_hash = hash(
        &J::obj([
            ("profileId", J::str(&profile_id)),
            ("recipe", recipe_dto()),
            ("compatibilityHash", J::str(&compatibility_hash)),
            ("startRequestHash", J::str(&start_request_hash)),
        ]),
        true,
    );
    let diagnostics: Vec<J> = warnings
        .iter()
        .map(|w| {
            J::obj([
                ("level", J::str("warning")),
                ("code", J::str("prepare_runtime_warning")),
                ("message", J::str(w)),
                ("plane", J::str("asp-compiler")),
                ("profileId", J::str(&profile_id)),
            ])
        })
        .collect();
    let identity = req.get("identity").cloned().unwrap_or(J::Null);
    let generation = identity.get("generation").cloned();
    let mut compile_material = J::Obj(vec![]);
    if let Some(g) = &generation {
        compile_material.set("generation", g.clone());
    }
    compile_material.set("profileHash", J::str(&profile_hash));
    let compile_id = format!("compile_{}", &hash(&compile_material, true)[..32]);
    let placement = req.get("placement").cloned().unwrap_or(J::Null);
    let mut compiled_placement = placement.clone();
    compiled_placement.remove("dispatchEnv");
    let mut dispatch_request = J::obj([("startRequest", start_request)]);
    let dispatch_env = plan
        .params
        .get("dispatchEnv")
        .or_else(|| placement.get("dispatchEnv"));
    if let Some(d) = dispatch_env {
        dispatch_request.set("dispatchEnv", d.clone());
    }
    for k in ["runtime", "lifecyclePolicy"] {
        if let Some(v) = plan.params.get(k) {
            dispatch_request.set(k, v.clone());
        }
    }
    let mut execution = recipe_dto();
    execution.set(
        "profile",
        J::obj([
            ("profileId", J::str(&profile_id)),
            ("profileHash", J::str(&profile_hash)),
            ("compatibilityHash", J::str(&compatibility_hash)),
            ("startRequestHash", J::str(&start_request_hash)),
        ]),
    );
    execution.set("dispatchRequest", dispatch_request);
    let mut artifacts = J::obj([("materializedBundleRoot", J::str(&bundle.root_dir))]);
    if let Some(p) = &system_prompt_path {
        artifacts.set("systemPromptFile", J::str(p));
    }
    artifacts.set("bundleIdentity", J::str(&plan.bundle_identity));
    let mut locked_keys: Vec<String> = locked.iter().map(|(k, _)| k.clone()).collect();
    locked_keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let omit_priming = matches!(
        req.get("materialization")
            .and_then(|m| m.get("omitPriming")),
        Some(J::Bool(true))
    );
    let created_at = now_iso();
    let mut plan_material = J::obj([
        ("schemaVersion", J::str("agent-runtime-plan/v2")),
        (
            "compiler",
            J::obj([
                ("name", J::str("agent-spaces")),
                ("version", J::str("0.1.1")),
            ]),
        ),
        ("compileId", J::str(&compile_id)),
        ("createdAt", J::str(&created_at)),
        ("agent", req.get("agent").cloned().unwrap_or(J::Null)),
        ("identity", identity.clone()),
        ("placement", compiled_placement.clone()),
        ("resolvedBundle", plan.resolved_bundle.clone()),
        ("omitPriming", J::Bool(omit_priming)),
        ("selection", selection.clone()),
        ("execution", execution),
        ("artifacts", artifacts),
        (
            "lockedEnv",
            J::obj([(
                "lockedEnvKeys",
                J::Arr(locked_keys.into_iter().map(J::Str).collect()),
            )]),
        ),
        ("diagnostics", J::Arr(diagnostics.clone())),
    ]);
    let mut hash_material = plan_material.clone();
    hash_material.remove("createdAt");
    let mut neutral_identity = J::Obj(vec![]);
    if let Some(g) = generation {
        neutral_identity.set("generation", g);
    }
    hash_material.set("identity", neutral_identity);
    let mut neutral_placement = compiled_placement;
    neutral_placement.remove("correlation");
    hash_material.set("placement", neutral_placement);
    let plan_hash = hash(&hash_material, true);
    plan_material.set("planHash", J::str(plan_hash));

    let mut response_diagnostics = diagnostics;
    response_diagnostics.extend(plan.metadata_diagnostics.iter().cloned());
    let protocol = "harness-broker/0.2";
    let execution_release = execution_release(release, protocol)?;
    Ok(J::obj([
        (
            "schemaVersion",
            J::str("aspc-compile-harness-invocation-response/v2"),
        ),
        ("ok", J::Bool(true)),
        ("plan", plan_material),
        ("sessionMetadata", plan.session_metadata.clone()),
        ("diagnostics", J::Arr(response_diagnostics)),
        (
            "effectiveEnvironmentHash",
            J::str(&plan.effective_environment_hash),
        ),
        ("executionRelease", execution_release),
    ]))
}
