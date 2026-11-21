//! `aspc.inspectRuntimePlacement` (agent-inspection.ts
//! `inspectResolvedRuntimePlacement`): the placement's declaration, its
//! harness gate and prepared execution context, one prompt report, the
//! inspection seed, exactly one compile through the shared core, then a
//! second prompt report from the same input for the reply.
use super::preparation::{
    Preparation, env_object, placement_from_declaration, placement_prompt, preparation,
};
use super::{PromptReport, RESPONSE_VERSION, evaluate, failure_reply};
use crate::compile::materialize::ensure_asp_home;
use crate::compile::util::{hash, now_iso};
use crate::compile::{Fwd, Phases, fwd, fwd_at, s};
use crate::json::J;
use crate::reads::jspath::{basename, dirname, join};
use crate::reads::{Answer, Env, declaration, profile};
use crate::release::Release;

pub(super) fn inspect(params: &J, release: &Release, phases: &mut Phases) -> Result<J, Fwd> {
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
    let harness = inspected_harness(&declaration)?;

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
        Err(message) => {
            return Ok(failure_reply(
                "incompatible",
                "configured_context_mismatch",
                &message,
            ));
        }
    };
    let sources = declaration.get("agentSources");
    let asp_home = s(sources.and_then(|x| x.get("aspHome")))
        .map_or_else(declaration::process_asp_home, str::to_owned);
    let agents_root_echo = s(sources.and_then(|x| x.get("agentsRoot")));
    phases.lap("placement-context");

    // inspectAgentForContext: one prompt report, then exactly one compile.
    let report = || {
        placement_prompt(
            &placement,
            &prep,
            task_context,
            (&asp_home, agents_root_echo),
        )
    };
    let first = report()?;
    phases.lap("system-prompt");
    let seed = Seed::new(&placement, &context, &prep, &harness, agents_root_echo)?;
    let inspection = match evaluate::evaluate(
        &seed.request,
        &seed.evaluation_context,
        &first,
        release,
        phases,
        false,
    ) {
        Ok(i) => i,
        Err(f) => return compile_refused(f, &seed.agent_root),
    };

    // The reply's prompt: a second report from the same input.
    let prompt = prompt_reply(report()?, &declaration);
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

/// The declaration's effective harness, gated to the ones that compile. An
/// undeclared harness inspects as agent-harness; Bun throws on an unknown one.
fn inspected_harness(declaration: &J) -> Result<String, Fwd> {
    let harness = match declaration
        .get("provisioning")
        .and_then(|p| p.get("effectiveHarness"))
    {
        None => "agent-harness".to_owned(),
        Some(J::Str(h)) if profile::HARNESS_IDS.contains(&h.as_str()) => h.clone(),
        Some(_) => return Err(fwd(crate::reason!("inspect_harness_unknown"))),
    };
    if !matches!(
        harness.as_str(),
        "claude" | "claude-hrcpty" | "codex" | "codex-hrcpty" | "antigravity-hrcpty"
    ) {
        return Err(fwd_at(crate::reason!("inspect_harness"), harness));
    }
    Ok(harness)
}

/// buildAgentSpacesInspection's seed: the request and evaluation context,
/// which carry the wall clock (`nowIso`), so every id the compile derives
/// from them differs per call in Bun too; only `profileId` reaches the reply
/// (measured volatile). `agentProfile` here is the profile's TOML table, not
/// parseAgentProfile's normalized object; with the clock in the seed no reply
/// can tell them apart.
struct Seed {
    agent_root: String,
    request: J,
    evaluation_context: J,
}

impl Seed {
    fn new(
        placement: &J,
        context: &J,
        prep: &Preparation,
        harness: &str,
        agents_root_echo: Option<&str>,
    ) -> Result<Self, Fwd> {
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
        identifiers.set("harness", J::str(harness));
        identifiers.set("presentation", J::Bool(false));

        let environment = env_object(&prep.exec_env);
        let now = now_iso();
        let profile_path = join(&[&agent_root, "agent-profile.toml"]);
        if !std::path::Path::new(&profile_path).exists() {
            // buildRuntimeBundleRef throws without a profile.
            return Err(fwd(crate::reason!("inspect_profile_missing")));
        }
        let agent_profile = crate::reads::jspath::read_text(&profile_path)
            .ok()
            .and_then(|c| crate::reads::toml::parse(&c).ok())
            .ok_or_else(|| fwd(crate::reason!("profile_unreadable")))?;
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
                        J::str(
                            agents_root_echo.map_or_else(|| dirname(&agent_root), str::to_owned),
                        ),
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
            ("identifiers", identifiers),
            ("declaredOverrides", J::Obj(vec![])),
        ]);
        Ok(Seed {
            agent_root,
            request,
            evaluation_context,
        })
    }
}

/// A compile Bun refuses or throws on, which an inspection reports as
/// `inspection_failed` (inspectAgentForContext's `compiler_exception` and
/// refusal diagnostics, joined); any other relays.
fn compile_refused(f: Fwd, agent_root: &str) -> Result<J, Fwd> {
    let message = match (f.reason.as_str(), f.detail.as_deref()) {
        // launchRefusal, before anything is written.
        ("agent_participant_only", _) => format!(
            "Agent at {agent_root} is participant-only ([placement] launch = \"participant-only\"): its seat joins HRC as a direct participant and is never launched"
        ),
        ("agent_self_brokered", _) => format!(
            "Agent at {agent_root} is self-brokered ([placement] launch = \"self-brokered\"): HRC starts its own launch_command, which serves its own broker, and never compiles a bundle for it"
        ),
        // closure.ts throws after the temp sweep and ensureAspHome: an
        // inspection whose project root is empty carries no projectRoot, so
        // a project space cannot resolve.
        ("project_root_required", Some(space)) => {
            crate::compile::temp_lifecycle::sweep_temp(&declaration::process_asp_home());
            ensure_asp_home();
            format!("Project root is required to resolve project space: {space}")
        }
        _ => return Err(f),
    };
    Ok(failure_reply("unavailable", "inspection_failed", &message))
}

/// The reply's `prompt`: absent without a declared prompt, else the resolved
/// prompt, reminder and priming with their sizes.
fn prompt_reply(report: PromptReport, declaration: &J) -> J {
    let Some((resolved, inspected, append)) = report else {
        return J::obj([
            ("state", J::str("absent")),
            ("code", J::str("prompt_not_declared")),
        ]);
    };
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
