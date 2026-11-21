//! The one-compile inspection core both entries share (the compile and the
//! assembly of agent-inspection.ts `inspectAgentForContext`): the inspection's
//! compile request (`buildInspectionCompileRequest`), the canonical
//! compile (classify, preflight, materialize), then the inspection assembled
//! from the prompt report and the runtime plan.
use super::{PromptReport, parts};
use crate::compile::materialize::materialize_and_emit;
use crate::compile::plan::classify;
use crate::compile::util::hash;
use crate::compile::{Fwd, Phases, fwd, fwd_at, invalid_params, s};
use crate::json::J;
use crate::release::Release;

/// `pinned` passes the evaluation context's compile context to the compile
/// (a caller-supplied context); a placement inspection's compile uses its own.
pub(super) fn evaluate(
    request: &J,
    evaluation_context: &J,
    first: &PromptReport,
    release: &Release,
    phases: &mut Phases,
    pinned: bool,
) -> Result<J, Fwd> {
    let identifiers = request.get("identifiers").ok_or_else(invalid_params)?;
    let get = |k| s(identifiers.get(k)).unwrap_or_default();
    let (agent_id, scope, lane, harness) =
        (get("agentId"), get("scope"), get("lane"), get("harness"));
    let provider = match harness {
        "claude" | "claude-hrcpty" => "anthropic",
        "codex" | "codex-hrcpty" => "openai-codex",
        "antigravity-hrcpty" => "google",
        _ => return Err(fwd_at(crate::reason!("inspect_harness"), harness.into())),
    };
    let paths = evaluation_context.get("paths").ok_or_else(invalid_params)?;
    let path = |k| s(paths.get(k)).unwrap_or_default();
    let (agent_root, project_root, cwd) = (path("agentRoot"), path("projectRoot"), path("cwd"));
    let seed = hash(
        &J::obj([
            ("request", request.clone()),
            ("context", evaluation_context.clone()),
        ]),
        false,
    );
    let initial_prompt = first
        .as_ref()
        .and_then(|(r, _, _)| r.prompt.clone())
        .unwrap_or_default();
    let mut compile_request = compile_request(
        &seed,
        (agent_id, scope, lane, harness, provider),
        (project_root, cwd, agent_root),
        &initial_prompt,
    );
    if let Some(requested) = compile_request.get("requested").cloned() {
        let mut requested = requested;
        requested.set(
            "presentation",
            identifiers
                .get("presentation")
                .cloned()
                .unwrap_or(J::Bool(false)),
        );
        for (from, to) in [("modelId", "model"), ("reasoningEffort", "reasoningEffort")] {
            if let Some(v) = request.get("declaredOverrides").and_then(|o| o.get(from)) {
                requested.set(to, v.clone());
            }
        }
        compile_request.set("requested", requested);
    }
    let mut compile_params = J::obj([("compileRequest", compile_request)]);
    if pinned {
        compile_params.set(
            "compileContext",
            evaluation_context
                .get("compileContext")
                .ok_or_else(invalid_params)?
                .clone(),
        );
    }
    let mut plan = classify(&compile_params, release, phases)?;
    plan.runtime_home_read_only = true;
    crate::compile::preflight::preflight(&plan)?;
    let compiled = materialize_and_emit(plan, release, phases)?;
    let runtime_plan = compiled.get("plan").cloned().unwrap_or(J::Null);

    // The parts: every prompt section, then the runtime plan's.
    let mut parts: Vec<J> = first
        .as_ref()
        .map(|(_, inspected, _)| inspected.reports.iter().map(parts::prompt_part).collect())
        .unwrap_or_default();
    parts.extend(parts::runtime_plan_parts(&runtime_plan));
    let mut ids: Vec<&str> = parts.iter().filter_map(|p| s(p.get("partId"))).collect();
    ids.sort_unstable();
    if ids.windows(2).any(|w| w[0] == w[1]) {
        // validateAgentInspectionResult's verdict on repeated part ids is Bun's.
        return Err(fwd(crate::reason!("inspect_duplicate_part")));
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
    // failedResolutionDiagnostic per failed part, then partial completeness.
    let mut missing = vec![];
    for part in &parts {
        let Some(d) = part
            .get("disposition")
            .filter(|d| s(d.get("kind")) == Some("failed"))
        else {
            continue;
        };
        let part_id = s(part.get("partId")).unwrap_or_default().to_owned();
        let message = s(d.get("reason")).unwrap_or_default().to_owned();
        let key = format!("resolution:part_resolution_failed:{message}:{part_id}");
        if !seen.contains(&key) {
            seen.push(key);
            diagnostics.push(J::obj([
                ("kind", J::str("resolution")),
                ("severity", J::str("error")),
                ("code", J::str("part_resolution_failed")),
                ("message", J::str(&message)),
                ("partId", J::str(&part_id)),
            ]));
        }
        missing.push(J::str(part_id));
    }
    let completeness = if missing.is_empty() {
        J::obj([("kind", J::str("complete"))])
    } else {
        J::obj([
            ("kind", J::str("partial")),
            ("missingPartIds", J::Arr(missing)),
        ])
    };
    Ok(J::obj([
        ("schemaVersion", J::str("agent-inspection/v2")),
        ("identity", identifiers.clone()),
        ("parts", J::Arr(parts)),
        ("completeness", completeness),
        ("freshness", freshness(&runtime_plan)?),
        ("diagnostics", J::Arr(diagnostics)),
    ]))
}

/// `buildInspectionCompileRequest(request, context, initialPrompt)`.
fn compile_request(
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
        ("hrcPolicy", {
            let mut policy = J::obj([
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
            ]);
            if harness == "antigravity-hrcpty" {
                policy.remove("permissionPolicy");
            }
            policy
        }),
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

/// `inspectionFreshness(plan, request, context)`. raspd compiles only
/// mutable spaces, whose bundles carry no lock hash.
fn freshness(plan: &J) -> Result<J, Fwd> {
    let lock = |v: Option<&J>| v.and_then(|x| x.get("lockHash")).is_some();
    if lock(plan.get("resolvedBundle")) || lock(plan.get("artifacts")) {
        return Err(fwd(crate::reason!("inspect_lock_hash")));
    }
    Ok(J::obj([
        ("kind", J::str("unknown")),
        (
            "reason",
            J::str("The canonical compile produced no lock hash"),
        ),
    ]))
}
