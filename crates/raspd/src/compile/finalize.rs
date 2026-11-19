//! The shared plan tail (compile-plan-finalize.ts): the recipe DTO, the
//! compatibility, start-request, profile and plan hashes, the diagnostics,
//! and the compile response with its execution release.
use super::broker_spec::{EnvPairs, claude_driver, env_json, terminal_host};
use super::plan::Plan;
use super::release_binding::execution_release;
use super::util::{hash, now_iso};
use super::{Fwd, request, s};
use crate::json::J;
use crate::release::Release;

/// `toRecipeDto(recipe)` for the selected harness variant and presentation
/// (catalog.ts executionVariants).
fn recipe_dto(selection: &request::Selection) -> J {
    let hrcpty = selection.hrcpty;
    let host = terminal_host(hrcpty);
    let process_execution = if hrcpty {
        "supervisor-process"
    } else {
        "broker-process"
    };
    if selection.harness == request::Harness::Codex {
        // codex-hrcpty hosts both variants on a terminal.
        let terminal = selection.interactive();
        let mut hosting = J::obj([
            ("executionTransport", J::str("jsonrpc-stdio")),
            ("terminalRequired", J::Bool(terminal)),
        ]);
        if terminal {
            hosting.set("terminalHost", J::str(host));
        }
        hosting.set("processExecution", J::str(process_execution));
        let mut dto = J::obj([
            ("recipeId", J::str("codex-app-server")),
            ("driver", J::str("codex-app-server")),
            ("protocol", J::str("harness-broker/0.2")),
            ("hosting", hosting),
        ]);
        if terminal {
            dto.set(
                "presentationSurface",
                J::obj([
                    ("transport", J::str("websocket-unix")),
                    ("terminalHost", J::str(host)),
                ]),
            );
        }
        dto.set("presentationFulfillment", J::str("attachable"));
        return dto;
    }
    let (recipe_id, driver) = match selection.harness {
        request::Harness::Antigravity => (super::antigravity::FRONTEND, super::antigravity::DRIVER),
        _ => ("claude-code", claude_driver(hrcpty)),
    };
    J::obj([
        ("recipeId", J::str(recipe_id)),
        ("driver", J::str(driver)),
        ("protocol", J::str("harness-broker/0.2")),
        (
            "hosting",
            J::obj([
                ("executionTransport", J::str("pty")),
                ("terminalRequired", J::Bool(true)),
                ("terminalHost", J::str(host)),
                ("processExecution", J::str(process_execution)),
            ]),
        ),
        ("presentationFulfillment", J::str("intrinsic")),
    ])
}

/// `hashNeutralStartRequest`: the spec without invocationId and correlation,
/// and the initial input's identity (its id and response format) only.
fn neutral_start_request(start: &J) -> J {
    let mut spec = start.get("spec").cloned().unwrap_or(J::Null);
    spec.remove("invocationId");
    spec.remove("correlation");
    let mut out = J::obj([("spec", spec)]);
    if let Some(input) = start.get("initialInput") {
        let mut identity = J::Obj(vec![]);
        if let Some(id) = input.get("inputId") {
            identity.set("inputId", id.clone());
        }
        if let Some(format) = input.get("responseFormat") {
            identity.set("responseFormat", format.clone());
        }
        out.set("initialInput", identity);
    }
    out
}

pub(super) fn finalize(
    plan: &Plan,
    release: &Release,
    start_request: J,
    locked: EnvPairs,
    warnings: &mut [String],
    system_prompt_path: Option<String>,
    bundle_root: &str,
) -> Result<J, Fwd> {
    let req = &plan.req;
    let policy = req
        .get("hrcPolicy")
        .ok_or_else(|| super::fwd(crate::reason!("invalid_params")))?;
    let codex = plan.selection.harness == request::Harness::Codex;
    let recipe = recipe_dto(&plan.selection);
    let worker = s(recipe.get("driver")).unwrap_or_default().to_owned();
    let recipe_id = s(recipe.get("recipeId")).unwrap_or_default().to_owned();
    let neutral = neutral_start_request(&start_request);
    let spec = neutral.get("spec").cloned().unwrap_or(J::Null);
    let process = spec.get("process").cloned().unwrap_or(J::Null);
    let mut process_material = J::Obj(vec![]);
    for k in ["command", "args", "cwd"] {
        if let Some(v) = process.get(k) {
            process_material.set(k, v.clone());
        }
    }
    process_material.set("lockedEnv", env_json(&locked));
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
    let driver = spec.get("driver").cloned().unwrap_or(J::Null);
    // buildCompatibilityMaterial narrows a codex-app-server driver.
    let driver_material = if codex {
        if let Some(m) = driver.get("model") {
            model.set("driverModel", m.clone());
        }
        let mut d = J::Obj(vec![]);
        for k in [
            "kind",
            "model",
            "modelReasoningEffort",
            "approvalPolicy",
            "sandboxMode",
            "permissionPolicy",
            "resumeFallback",
        ] {
            if let Some(v) = driver.get(k) {
                d.set(k, v.clone());
            }
        }
        d
    } else {
        driver
    };
    let mut compat = J::obj([
        (
            "bundle",
            J::obj([("bundleIdentity", J::str(&plan.bundle_identity))]),
        ),
        ("model", model),
        ("process", process_material),
        ("driver", driver_material),
    ]);
    if let Some(c) = req.get("continuation") {
        compat.set("continuation", continuation_material(c));
    }
    compat.set("policy", policy_material(policy));
    let compatibility_hash = hash(&compat, true);
    let start_request_hash = hash(&neutral, true);
    let profile_id = format!(
        "profile_{}",
        &hash(
            &J::obj([
                ("recipeId", J::str(&recipe_id)),
                ("startRequest", neutral.clone())
            ]),
            true
        )[..32]
    );
    let profile_hash = hash(
        &J::obj([
            ("profileId", J::str(&profile_id)),
            ("recipe", recipe.clone()),
            ("compatibilityHash", J::str(&compatibility_hash)),
            ("startRequestHash", J::str(&start_request_hash)),
        ]),
        true,
    );
    let diagnostics = diagnostics(warnings, policy, &worker, &profile_id);
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
    let mut execution = recipe;
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
    let mut artifacts = J::obj([("materializedBundleRoot", J::str(bundle_root))]);
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
    // The compile context's pinned instant, else the wall clock (not plan-hash material).
    let created_at = s(plan
        .params
        .get("compileContext")
        .and_then(|c| c.get("nowIso")))
    .map_or_else(now_iso, str::to_owned);
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
    let execution_release = execution_release(release, protocol, &worker)?;
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

/// The compatibility material's continuation: the HRC and broker
/// continuation identities and the source, never the keys.
fn continuation_material(c: &J) -> J {
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
    cont
}

/// The compatibility material's policy, with the broker defaults for an
/// absent input or exposure policy.
fn policy_material(policy: &J) -> J {
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
    policy_material
}

/// The plan's diagnostics: one per prepare warning, and
/// disallowedToolsUnsupportedDiagnostic where the broker route cannot deny
/// tools.
fn diagnostics(warnings: &[String], policy: &J, driver: &str, profile_id: &str) -> Vec<J> {
    let mut diagnostics: Vec<J> = warnings
        .iter()
        .map(|w| {
            J::obj([
                ("level", J::str("warning")),
                ("code", J::str("prepare_runtime_warning")),
                ("message", J::str(w)),
                ("plane", J::str("asp-compiler")),
                ("profileId", J::str(profile_id)),
            ])
        })
        .collect();
    if matches!(driver, "codex-app-server" | "antigravity-cli-hrcpty")
        && let Some(J::Arr(tools)) = policy.get("disallowedTools")
        && !tools.is_empty()
    {
        diagnostics.push(J::obj([
            ("level", J::str("warning")),
            ("code", J::str("disallowed_tools_unsupported_driver")),
            (
                "message",
                J::str(format!(
                    "hrcPolicy.disallowedTools was not applied for {driver}; only claude-code-tmux and claude-code-hrcpty currently support compiler-enforced tool denial.",
                )),
            ),
            ("plane", J::str("asp-compiler")),
            ("profileId", J::str(profile_id)),
            (
                "details",
                J::obj([
                    ("selectedDriver", J::str(driver)),
                    ("disallowedTools", J::Arr(tools.clone())),
                    ("applied", J::Bool(false)),
                ]),
            ),
        ]));
    }
    diagnostics
}
