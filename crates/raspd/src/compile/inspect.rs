//! Native `aspc.inspectRuntimePlacement` (R2b): compiler/agent-spaces/src
//! agent-inspection.ts (`inspectRuntimePlacement`, `inspectAgentForContext`)
//! and preparation-execution-context.ts, reproduced byte for byte.
//!
//! Bun's inspection is not read-only: for a claude or codex effective harness
//! it runs the canonical compile, which materializes the bundle under ASP_HOME
//! (codex runtime home excepted). raspd does the same through its native
//! compile, so it writes exactly what Bun writes, under the same lock protocol.
//! The other harnesses, and any input the compile would not judge, relay to
//! Bun before anything is written.
use super::util::{exec_environment, hash, now_iso};
use super::{
    Compiled, Fwd, Phases, classify, ensure_asp_home, fwd, fwd_at, handle_parts,
    materialize_and_emit,
};
use super::{agent_session_env, parse_scope_ref, prompt, s};
use crate::json::J;
use crate::reads::jspath::{basename, dirname, join, resolve};
use crate::reads::{Answer, Env, INSPECT_REQUEST_VERSION, declaration, profile};
use crate::release::Release;

pub const METHOD: &str = "aspc.inspectRuntimePlacement";
const RESPONSE_VERSION: &str = "aspc-inspect-runtime-placement-response/v1";
const DECLARATION_RESPONSE_VERSION: &str = "aspc-resolve-runtime-declaration-response/v1";

pub fn handle(params: Option<&J>, release: &Release) -> Compiled {
    let mut phases = Phases::start();
    let answered = |answer, fallback_detail, phases| Compiled {
        answer,
        fallback_detail,
        phases,
    };
    let valid = crate::reads::valid_inspect(params);
    if !crate::reads::handled(valid, params, INSPECT_REQUEST_VERSION) {
        return answered(Answer::Forward("invalid_params"), None, None);
    }
    let params = params.expect("validated or fallback params are a record");
    if params.get("schemaVersion") != Some(&J::str(INSPECT_REQUEST_VERSION)) {
        return answered(
            Answer::Result(declaration_failure(
                "unsupported_schema",
                "Unsupported runtime placement inspection schema",
            )),
            None,
            None,
        );
    }
    match inspect(params, release, &mut phases) {
        Ok(result) => answered(Answer::Result(result), None, Some(phases.finish())),
        Err(f) => answered(Answer::Forward(f.reason), f.detail, None),
    }
}

/// `{ ok: false, declaration: { ok: false, failure } }` with an incompatible failure.
fn declaration_failure(code: &str, message: &str) -> J {
    J::obj([
        ("schemaVersion", J::str(RESPONSE_VERSION)),
        ("ok", J::Bool(false)),
        (
            "declaration",
            J::obj([
                ("schemaVersion", J::str(DECLARATION_RESPONSE_VERSION)),
                ("ok", J::Bool(false)),
                (
                    "failure",
                    J::obj([
                        ("kind", J::str("incompatible")),
                        ("code", J::str(code)),
                        ("message", J::str(message)),
                    ]),
                ),
            ]),
        ),
    ])
}

/// `buildPreparationExecutionContext`'s outputs an inspection reads.
struct Preparation {
    agent_id: String,
    project_id: Option<String>,
    task_id: Option<String>,
    lane: Option<String>,
    exec_env: prompt::EnvMap,
    effective_environment_hash: String,
}

/// `PreparationContextMismatchError`'s message.
fn mismatch(field: &str, scoped: &str, hinted: &str) -> String {
    format!(
        "sessionRef {field} {} conflicts with context {field} {}",
        J::str(scoped).to_json(),
        J::str(hinted).to_json()
    )
}

/// `buildPreparationExecutionContext(placement, inputs)`: `Ok(Err(message))`
/// is its `PreparationContextMismatchError`.
fn preparation(
    placement: &J,
    hints: (&str, Option<&str>, Option<&str>),
    task_context: Option<&J>,
) -> Result<Result<Preparation, String>, Fwd> {
    let agent_root = s(placement.get("agentRoot")).unwrap_or_default();
    let session = placement
        .get("correlation")
        .and_then(|c| c.get("sessionRef"));
    let parts = handle_parts(
        &{
            let mut p = placement.clone();
            p.remove("projectRoot");
            p
        },
        false,
    )?;
    let canonical = session
        .and_then(|x| s(x.get("scopeRef")))
        .is_some_and(|scope| parse_scope_ref(scope).is_some());
    let (hint_agent, hint_project, hint_task) = hints;
    if canonical {
        let checks = [
            ("agentId", parts.agent_id.as_deref(), Some(hint_agent)),
            ("projectId", parts.project_id.as_deref(), hint_project),
            ("taskId", parts.task_id.as_deref(), hint_task),
        ];
        for (field, scoped, hinted) in checks {
            if let (Some(scoped), Some(hinted)) = (scoped, hinted)
                && scoped != hinted
            {
                return Ok(Err(mismatch(field, scoped, hinted)));
            }
        }
        // assertPreparationTaskContext.
        if let (Some(scoped), Some(tc)) = (parts.task_id.as_deref(), task_context)
            && let Some(hinted) = s(tc.get("taskId"))
            && scoped != hinted
        {
            return Ok(Err(mismatch("taskId", scoped, hinted)));
        }
    }
    let agent_id = match (&session, &parts.agent_id) {
        (Some(_), Some(a)) if !a.is_empty() => a.clone(),
        _ => basename(agent_root),
    };
    let project_id = parts
        .project_id
        .clone()
        .or_else(|| hint_project.map(str::to_owned))
        .or_else(|| s(placement.get("projectRoot")).map(|p| basename(&resolve(&[p]))));
    let task_id = parts
        .task_id
        .clone()
        .or_else(|| hint_task.map(str::to_owned));
    let mut exec_env = exec_environment().clone();
    for (k, v) in agent_session_env(placement)? {
        exec_env.insert(k, v);
    }
    exec_env.insert("AGENTCHAT_ID".into(), basename(agent_root));
    if let Some(p) = &project_id {
        exec_env.insert("ASP_PROJECT".into(), p.clone());
    }
    let env_json = env_object(&exec_env);
    let effective_environment_hash = match task_context {
        None => hash(&env_json, false),
        Some(tc) => hash(
            &J::obj([("environment", env_json), ("taskContext", tc.clone())]),
            false,
        ),
    };
    Ok(Ok(Preparation {
        agent_id,
        project_id,
        task_id,
        lane: parts.lane,
        exec_env,
        effective_environment_hash,
    }))
}

fn env_object(env: &prompt::EnvMap) -> J {
    J::Obj(env.iter().map(|(k, v)| (k.clone(), J::str(v))).collect())
}

/// `placementFromDeclaration(resolvedPlacement, context, correlation)`.
fn placement_from_declaration(resolved: &J, context: &J, correlation: J) -> J {
    let mut placement = resolved.clone();
    if let Some(root) = crate::reads::truthy_str(context.get("agentRoot")) {
        placement.set("agentRoot", J::str(root));
    }
    let project = context.get("project");
    let project_root = (project.and_then(|p| s(p.get("mode"))) == Some("root"))
        .then(|| project.and_then(|p| p.get("projectRoot")).cloned())
        .flatten();
    if let Some(root) = &project_root {
        placement.set("projectRoot", root.clone());
    }
    if let Some(bundle) = placement.get("bundle").cloned()
        && s(bundle.get("kind")) == Some("agent-project")
    {
        let mut bundle = bundle;
        if let Some(root) = &project_root {
            bundle.set("projectRoot", root.clone());
        }
        placement.set("bundle", bundle);
    }
    placement.set("cwd", context.get("cwd").cloned().unwrap_or(J::str("")));
    placement.set("correlation", correlation);
    placement
}

/// `inspectAgentSystemPrompt(preparation.promptInput)`: `None` when the agent
/// declares no template and has no SOUL.md.
fn inspect_prompt(
    placement: &J,
    prep: &Preparation,
    task_context: Option<&J>,
    sources: (&str, Option<&str>),
) -> Result<Option<(prompt::Resolved, prompt::Inspected, bool)>, Fwd> {
    let agent_root = s(placement.get("agentRoot")).unwrap_or_default();
    let project_root = s(placement.get("projectRoot"));
    let (asp_home, agents_root) = sources;
    let discovered = prompt::discover(agent_root, project_root, asp_home, Some(agents_root))?;
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
    let template = match discovered.template {
        Some(t) => t,
        None => prompt::default_template(discovered.base.as_deref().unwrap_or_default()),
    };
    let ctx = prompt::Ctx {
        agent_root: agent_root.to_owned(),
        agents_root: discovered.agents_root.clone(),
        search_path: discovered.search_path.clone(),
        project_root: project_root.map(str::to_owned),
        cwd: s(placement.get("cwd")).map(str::to_owned),
        project_id: prep.project_id.clone(),
        agent_id: Some(prep.agent_id.clone()),
        agent_name: Some(basename(agent_root)),
        task_id: prep.task_id.clone(),
        task_context: task_context.cloned(),
        lane: prep.lane.clone(),
        run_mode: s(placement.get("runMode")).map(str::to_owned),
        agent_profile,
        env: Some(prep.exec_env.clone()),
        exec_env: Some(prep.exec_env.clone()),
    };
    let (resolved, inspected) = prompt::resolve_inspected(&template, &ctx)?;
    Ok(Some((resolved, inspected, template.append)))
}

fn inspect(params: &J, release: &Release, phases: &mut Phases) -> Result<J, Fwd> {
    let context = params.get("context").cloned().unwrap_or(J::Null);
    let declaration = match declaration::answer(
        &J::obj([
            ("schemaVersion", J::str(declaration::REQUEST_VERSION)),
            ("context", context.clone()),
        ]),
        Env::process(),
    ) {
        Answer::Result(d) => d,
        Answer::Forward(reason) => return Err(fwd(reason)),
    };
    phases.lap("resolve");
    if declaration.get("ok") != Some(&J::Bool(true)) {
        return Ok(J::obj([
            ("schemaVersion", J::str(RESPONSE_VERSION)),
            ("ok", J::Bool(false)),
            ("declaration", declaration),
        ]));
    }
    // An undeclared harness inspects as agent-harness; Bun throws on an
    // unknown one.
    let harness = match declaration
        .get("provisioning")
        .and_then(|p| p.get("effectiveHarness"))
    {
        None => "agent-harness".to_owned(),
        Some(J::Str(h)) if profile::HARNESS_IDS.contains(&h.as_str()) => h.clone(),
        Some(_) => return Err(fwd("inspect_harness_unknown")),
    };
    let provider = match harness.as_str() {
        "claude" => "anthropic",
        "codex" => "openai-codex",
        // agent-harness and muse compile through recipes raspd does not build.
        _ => return Err(fwd_at("inspect_harness", harness)),
    };

    let placement = placement_from_declaration(
        declaration.get("placement").unwrap_or(&J::Null),
        &context,
        params
            .get("preparationCorrelation")
            .cloned()
            .unwrap_or(J::Obj(vec![])),
    );
    let task_context = params.get("preparationTaskContext");
    let prep = match preparation(
        &placement,
        (
            s(context.get("agentId")).unwrap_or_default(),
            s(declaration.get("markerProjectId")),
            s(context.get("taskId")),
        ),
        task_context,
    )? {
        Ok(p) => p,
        Err(message) => return Ok(declaration_failure("configured_context_mismatch", &message)),
    };
    let sources = declaration.get("agentSources");
    let asp_home = s(sources.and_then(|x| x.get("aspHome")))
        .map_or_else(declaration::process_asp_home, str::to_owned);
    let agents_root_echo = s(sources.and_then(|x| x.get("agentsRoot")));
    phases.lap("placement-context");

    // inspectAgentForContext: one prompt report, then exactly one compile.
    let first = inspect_prompt(
        &placement,
        &prep,
        task_context,
        (&asp_home, agents_root_echo),
    )?;
    phases.lap("system-prompt");
    let agent_root = s(placement.get("agentRoot")).unwrap_or_default().to_owned();
    let agent_id = s(context.get("agentId")).unwrap_or_default().to_owned();
    let cwd = s(context.get("cwd")).unwrap_or_default().to_owned();
    let run_mode = s(context.get("runMode")).unwrap_or_default().to_owned();
    let project_root = s(placement.get("projectRoot")).unwrap_or(&cwd).to_owned();
    let project_id = prep
        .project_id
        .clone()
        .unwrap_or_else(|| basename(&project_root));
    let lane = prep.lane.clone().unwrap_or_else(|| "primary".into());
    let scope = format!("agent:{agent_id}:project:{project_id}");
    let mut identifiers = J::obj([
        ("agentId", J::str(&agent_id)),
        ("agentName", J::str(&agent_id)),
        ("projectId", J::str(&project_id)),
        ("mode", J::str(&run_mode)),
        ("scope", J::str(&scope)),
    ]);
    if let Some(task) = prep.task_id.as_deref().filter(|t| !t.is_empty()) {
        identifiers.set("taskId", J::str(task));
    }
    identifiers.set("lane", J::str(&lane));
    identifiers.set("harness", J::str(&harness));
    identifiers.set("presentation", J::Bool(false));

    // buildAgentSpacesInspection's seed: the request and evaluation context,
    // which carry the wall clock (`nowIso`), so every id below differs per
    // call in Bun too; only `profileId` reaches the reply (measured volatile).
    // `agentProfile` here is the profile's TOML table, not parseAgentProfile's
    // normalized object; with the clock in the seed no reply can tell them apart.
    let environment = env_object(&prep.exec_env);
    let now = now_iso();
    let profile_path = join(&[&agent_root, "agent-profile.toml"]);
    if !std::path::Path::new(&profile_path).exists() {
        // buildRuntimeBundleRef throws without a profile.
        return Err(fwd("inspect_profile_missing"));
    }
    let agent_profile = std::fs::read_to_string(&profile_path)
        .ok()
        .and_then(|c| crate::reads::toml::parse(&c).ok())
        .ok_or_else(|| fwd("profile_unreadable"))?;
    let evaluation_context = J::obj([
        (
            "schemaVersion",
            J::str("agent-inspection-evaluation-context/v2"),
        ),
        ("identifiers", identifiers.clone()),
        (
            "paths",
            J::obj([
                ("agentRoot", J::str(&agent_root)),
                (
                    "agentsRoot",
                    J::str(agents_root_echo.map_or_else(|| dirname(&agent_root), str::to_owned)),
                ),
                ("projectRoot", J::str(&project_root)),
                ("cwd", J::str(&cwd)),
            ]),
        ),
        ("nowIso", J::str(&now)),
        ("environment", environment.clone()),
        (
            "predicateInputs",
            J::obj([("cwd", J::str(&cwd)), ("environment", environment.clone())]),
        ),
        (
            "execInputs",
            J::obj([
                ("cwd", J::str(&agent_root)),
                ("environment", environment.clone()),
            ]),
        ),
        (
            "serviceProbeInputs",
            J::obj([("responses", J::Arr(vec![]))]),
        ),
        ("scaffoldPackets", J::Arr(vec![])),
        ("agentProfile", agent_profile),
        ("declaredOverrides", J::Obj(vec![])),
        (
            "compileContext",
            J::obj([
                ("nowIso", J::str(&now)),
                (
                    "idSalt",
                    J::str(hash(
                        &J::obj([
                            ("identifiers", identifiers.clone()),
                            ("environment", environment),
                        ]),
                        false,
                    )),
                ),
                (
                    "toolchainManifest",
                    J::obj([
                        ("schemaVersion", J::str("agent-inspection-toolchain/v1")),
                        ("tools", J::Arr(vec![])),
                    ]),
                ),
            ]),
        ),
    ]);
    let request = J::obj([
        ("schemaVersion", J::str("agent-inspection-request/v2")),
        ("identifiers", identifiers.clone()),
        ("declaredOverrides", J::Obj(vec![])),
    ]);
    let seed = hash(
        &J::obj([("request", request), ("context", evaluation_context)]),
        false,
    );
    let initial_prompt = first
        .as_ref()
        .and_then(|(r, _, _)| r.prompt.clone())
        .unwrap_or_default();
    let compile_request = inspection_compile_request(
        &seed,
        (&agent_id, &scope, &lane, &harness, provider),
        (&project_root, &cwd, &agent_root),
        &initial_prompt,
    );
    let mut plan = match classify(
        &J::obj([("compileRequest", compile_request)]),
        release,
        phases,
    ) {
        Ok(plan) => plan,
        Err(f) => return compile_refused(f, &agent_root),
    };
    plan.codex_home_read_only = true;
    let compiled = materialize_and_emit(plan, release, phases)?;
    let runtime_plan = compiled.get("plan").cloned().unwrap_or(J::Null);

    // The parts: every prompt section, then the runtime plan's.
    let mut parts: Vec<J> = first
        .as_ref()
        .map(|(_, inspected, _)| inspected.reports.iter().map(prompt_part).collect())
        .unwrap_or_default();
    parts.extend(runtime_plan_parts(&runtime_plan));
    let mut ids: Vec<&str> = parts.iter().filter_map(|p| s(p.get("partId"))).collect();
    ids.sort_unstable();
    if ids.windows(2).any(|w| w[0] == w[1]) {
        // validateAgentInspectionResult's verdict on repeated part ids is Bun's.
        return Err(fwd("inspect_duplicate_part"));
    }
    let mut diagnostics: Vec<J> = vec![];
    let mut seen: Vec<String> = vec![];
    for d in compiled
        .get("diagnostics")
        .and_then(J::as_arr)
        .into_iter()
        .flatten()
    {
        let diagnostic = J::obj([
            ("kind", J::str("compile")),
            ("severity", d.get("level").cloned().unwrap_or(J::Null)),
            ("code", d.get("code").cloned().unwrap_or(J::Null)),
            ("message", d.get("message").cloned().unwrap_or(J::Null)),
        ]);
        // deduplicateDiagnostics' key.
        let key = format!(
            "compile:{}:{}:",
            s(diagnostic.get("code")).unwrap_or_default(),
            s(diagnostic.get("message")).unwrap_or_default()
        );
        if !seen.contains(&key) {
            seen.push(key);
            diagnostics.push(diagnostic);
        }
    }
    let inspection = J::obj([
        ("schemaVersion", J::str("agent-inspection/v2")),
        ("identity", identifiers),
        ("parts", J::Arr(parts)),
        ("completeness", J::obj([("kind", J::str("complete"))])),
        ("freshness", freshness(&runtime_plan)?),
        ("diagnostics", J::Arr(diagnostics)),
    ]);

    // The reply's prompt: a second report from the same input.
    let second = inspect_prompt(
        &placement,
        &prep,
        task_context,
        (&asp_home, agents_root_echo),
    )?;
    let prompt = match second {
        None => J::obj([
            ("state", J::str("absent")),
            ("code", J::str("prompt_not_declared")),
        ]),
        Some((resolved, inspected, append)) => {
            let mut value = J::obj([
                ("systemPrompt", J::str(resolved.prompt.unwrap_or_default())),
                (
                    "systemPromptMode",
                    J::str(if append { "append" } else { "replace" }),
                ),
            ]);
            if let Some(r) = resolved.reminder {
                value.set("reminderContent", J::Str(r));
            }
            if let Some(p) = declaration
                .get("priming")
                .and_then(|p| crate::reads::truthy_str(p.get("content")))
            {
                value.set("primingPrompt", J::str(p));
            }
            value.set("promptSectionSizes", section_sizes(&inspected.prompt_sizes));
            value.set(
                "reminderSectionSizes",
                section_sizes(&inspected.reminder_sizes),
            );
            value.set("promptTotalChars", J::Num(inspected.prompt_chars as f64));
            value.set(
                "reminderTotalChars",
                J::Num(inspected.reminder_chars as f64),
            );
            value.set(
                "totalContextChars",
                J::Num((inspected.prompt_chars + inspected.reminder_chars) as f64),
            );
            if let Some(max) = inspected.max_chars {
                value.set("maxChars", J::Num(max as f64));
            }
            value.set("nearMaxChars", J::Bool(inspected.near_max_chars));
            J::obj([("state", J::str("present")), ("value", value)])
        }
    };
    phases.lap("inspect");
    Ok(J::obj([
        ("schemaVersion", J::str(RESPONSE_VERSION)),
        ("ok", J::Bool(true)),
        ("declaration", declaration),
        ("inspection", inspection),
        ("prompt", prompt),
        (
            "effectiveEnvironmentHash",
            J::str(&prep.effective_environment_hash),
        ),
    ]))
}

/// A compile Bun refuses or throws on, which an inspection reports as
/// `inspection_failed` (inspectAgentForContext's `compiler_exception` and
/// refusal diagnostics, joined); any other relays.
fn compile_refused(f: Fwd, agent_root: &str) -> Result<J, Fwd> {
    let message = match (f.reason, f.detail.as_deref()) {
        // participantOnlyRefusal, before anything is written.
        ("agent_participant_only", _) => format!(
            "Agent at {agent_root} is participant-only ([placement] launch = \"participant-only\"): its seat joins HRC as a direct participant and is never launched"
        ),
        // closure.ts throws after the temp sweep and ensureAspHome: an
        // inspection whose project root is empty carries no projectRoot, so
        // a project space cannot resolve.
        ("project_root_required", Some(space)) => {
            super::stage::sweep_temp(&declaration::process_asp_home());
            ensure_asp_home();
            format!("Project root is required to resolve project space: {space}")
        }
        _ => return Err(f),
    };
    Ok(J::obj([
        ("schemaVersion", J::str(RESPONSE_VERSION)),
        ("ok", J::Bool(false)),
        (
            "declaration",
            J::obj([
                ("schemaVersion", J::str(DECLARATION_RESPONSE_VERSION)),
                ("ok", J::Bool(false)),
                (
                    "failure",
                    J::obj([
                        ("kind", J::str("unavailable")),
                        ("code", J::str("inspection_failed")),
                        ("message", J::Str(message)),
                    ]),
                ),
            ]),
        ),
    ]))
}

/// `normalizeSectionSizes`: `<zone>.<name>=<chars>` split at the last `=`.
fn section_sizes(sizes: &[String]) -> J {
    J::Arr(
        sizes
            .iter()
            .map(|v| {
                let (name, chars) = v.rsplit_once('=').unwrap_or((v, "0"));
                J::obj([
                    ("name", J::str(name)),
                    ("chars", J::Num(chars.parse().unwrap_or(0.0))),
                ])
            })
            .collect(),
    )
}

/// `buildInspectionCompileRequest(request, context, initialPrompt)`.
fn inspection_compile_request(
    seed: &str,
    who: (&str, &str, &str, &str, &str),
    paths: (&str, &str, &str),
    initial_prompt: &str,
) -> J {
    let (agent_id, scope, lane, harness, provider) = who;
    let (project_root, cwd, agent_root) = paths;
    let id = |prefix: &str| J::str(format!("{prefix}{seed}"));
    let identity = J::obj([
        ("requestId", id("request_")),
        ("operationId", id("runtimeOperation_")),
        ("hostSessionId", id("hostSession_")),
        ("generation", J::Num(1.0)),
        ("runtimeId", id("runtime_")),
        ("invocationId", id("inv_")),
        ("initialInputId", id("input_")),
        ("runId", id("run_")),
        ("traceId", id("trace_")),
        ("idempotencyKey", id("agent-inspection:")),
    ]);
    let get = |k: &str| identity.get(k).cloned().unwrap_or(J::Null);
    let mut bundle = J::obj([
        ("kind", J::str("agent-project")),
        ("agentName", J::str(agent_id)),
    ]);
    if !project_root.is_empty() {
        bundle.set("projectRoot", J::str(project_root));
    }
    let mut placement = vec![
        ("kind".to_owned(), J::str("agent-inspection")),
        ("root".to_owned(), J::str(project_root)),
        ("targetDir".to_owned(), J::str(cwd)),
        ("agentRoot".to_owned(), J::str(agent_root)),
    ];
    // T-11951: the compile resolves project spaces, targets and the prompt's
    // search path from placement.projectRoot (absent when empty, as the bundle).
    if !project_root.is_empty() {
        placement.push(("projectRoot".to_owned(), J::str(project_root)));
    }
    placement.push(("bundle".to_owned(), bundle));
    placement.push((
        "correlation".to_owned(),
        J::obj([
            (
                "sessionRef",
                J::obj([("scopeRef", J::str(scope)), ("laneRef", J::str(lane))]),
            ),
            ("hostSessionId", get("hostSessionId")),
        ]),
    ));
    J::obj([
        ("schemaVersion", J::str("agent-runtime-compile-request/v2")),
        ("agent", J::obj([("id", J::str(agent_id))])),
        ("identity", identity.clone()),
        ("placement", J::Obj(placement)),
        (
            "requested",
            J::obj([
                ("harness", J::str(harness)),
                ("modelProvider", J::str(provider)),
                ("presentation", J::Bool(false)),
            ]),
        ),
        (
            "materialization",
            J::obj([("initialPrompt", J::str(initial_prompt))]),
        ),
        (
            "hrcPolicy",
            J::obj([
                (
                    "permissionPolicy",
                    J::obj([("mode", J::str("deny")), ("audit", J::Bool(true))]),
                ),
                ("exposurePolicy", J::obj([("mode", J::str("none"))])),
                ("observability", J::obj([("traceId", get("traceId"))])),
                (
                    "capabilityPolicy",
                    J::obj([
                        ("allowDegrade", J::Bool(false)),
                        ("requireBrokerDefaultForCodexHeadless", J::Bool(true)),
                    ]),
                ),
            ]),
        ),
        (
            "correlation",
            J::obj([
                ("requestId", get("requestId")),
                ("operationId", get("operationId")),
                ("hostSessionId", get("hostSessionId")),
                ("generation", get("generation")),
                ("runtimeId", get("runtimeId")),
                ("invocationId", get("invocationId")),
                ("runId", get("runId")),
                ("traceId", get("traceId")),
                ("appId", J::str("agent-spaces-inspection")),
                ("appSessionKey", J::str(scope)),
                ("scopeRef", J::str(scope)),
                ("laneRef", J::str(lane)),
            ]),
        ),
    ])
}

fn prompt_part(r: &prompt::SectionReport) -> J {
    let part_id = format!("context-section:{}/{}/{}", r.zone, r.order, r.name);
    let disposition = match r.skipped {
        None => J::obj([("kind", J::str("effective"))]),
        Some(reason) => J::obj([("kind", J::str("skipped")), ("reason", J::str(reason))]),
    };
    let mut value = J::obj([
        ("zone", J::str(r.zone)),
        ("name", J::str(&r.name)),
        ("sourceType", J::str(r.kind)),
        ("order", J::Num(r.order as f64)),
    ]);
    if let Some(c) = &r.content {
        value.set("content", J::str(c));
    }
    J::obj([
        ("kind", J::str("prompt")),
        ("partId", J::str(format!("prompt:{}:{}", r.zone, r.name))),
        ("disposition", disposition),
        (
            "provenance",
            J::obj([(
                "contributions",
                J::Arr(vec![J::obj([
                    ("kind", J::str("template")),
                    ("sourceId", J::str(part_id)),
                    ("sourceRef", J::str(&r.source)),
                ])]),
            )]),
        ),
        ("value", value),
    ])
}

/// `runtimePlanParts(plan)`.
fn runtime_plan_parts(plan: &J) -> Vec<J> {
    let provenance = || {
        J::obj([(
            "contributions",
            J::Arr(vec![J::obj([
                ("kind", J::str("runtime-plan")),
                ("sourceId", J::str("canonical-compile")),
                ("sourceRef", J::str("agent-runtime-plan/v2")),
            ])]),
        )])
    };
    let part = |kind: &str, part_id: &str, value: J| {
        J::obj([
            ("kind", J::str(kind)),
            ("partId", J::str(part_id)),
            ("disposition", J::obj([("kind", J::str("effective"))])),
            ("provenance", provenance()),
            ("value", value),
        ])
    };
    let at = |path: &[&str]| {
        path.iter()
            .try_fold(plan, |v, k| v.get(k))
            .cloned()
            .unwrap_or(J::Null)
    };
    let mut model = J::obj([
        ("provider", at(&["selection", "modelProvider"])),
        ("modelId", at(&["selection", "model"])),
    ]);
    if let Some(e) = plan.get("selection").and_then(|x| x.get("reasoningEffort")) {
        model.set("reasoningEffort", e.clone());
    }
    let mut artifact = J::obj([
        ("artifactKind", J::str("bundle")),
        ("bundleIdentity", at(&["artifacts", "bundleIdentity"])),
    ]);
    if let Some(l) = plan.get("artifacts").and_then(|a| a.get("lockHash")) {
        artifact.set("identity", l.clone());
    }
    let profile_id = at(&["execution", "profile", "profileId"]);
    vec![
        part(
            "capability",
            "capability:runtime-plan",
            J::obj([
                ("capabilityId", J::str("runtime-plan")),
                ("enabled", J::Bool(true)),
            ]),
        ),
        part(
            "runtime-setting",
            "runtime-setting:locked-env-keys",
            J::obj([
                ("settingId", J::str("locked-env-keys")),
                ("value", at(&["lockedEnv", "lockedEnvKeys"])),
            ]),
        ),
        part(
            "harness",
            "harness:selected",
            J::obj([
                ("family", at(&["selection", "harness"])),
                ("runtime", at(&["execution", "recipeId"])),
                ("provider", at(&["selection", "modelProvider"])),
            ]),
        ),
        part("model", "model:selected", model),
        part("artifact", "artifact:bundle", artifact),
        part(
            "execution-profile",
            &format!(
                "execution-profile:{}",
                s(Some(&profile_id)).unwrap_or_default()
            ),
            J::obj([
                ("profileId", profile_id.clone()),
                ("controllerKind", at(&["execution", "driver"])),
                (
                    "configuration",
                    J::obj([("recipeId", at(&["execution", "recipeId"]))]),
                ),
            ]),
        ),
    ]
}

/// `inspectionFreshness(plan, request, context)`. raspd compiles only
/// mutable spaces, whose bundles carry no lock hash.
fn freshness(plan: &J) -> Result<J, Fwd> {
    let lock = |v: Option<&J>| v.and_then(|x| x.get("lockHash")).is_some();
    if lock(plan.get("resolvedBundle")) || lock(plan.get("artifacts")) {
        return Err(fwd("inspect_lock_hash"));
    }
    Ok(J::obj([
        ("kind", J::str("unknown")),
        (
            "reason",
            J::str("The canonical compile produced no lock hash"),
        ),
    ]))
}
