//! An inspection's parts: one per system prompt section (template
//! provenance), then the runtime plan's (agent-inspection.ts
//! `promptPart`, `runtimePlanParts`).
use crate::compile::prompt::zones;
use crate::compile::s;
use crate::json::J;
use crate::reads::jspath::join;

pub(super) fn prompt_part(r: &zones::SectionReport) -> J {
    let part_id = format!("context-section:{}/{}/{}", r.zone, r.order, r.name);
    let disposition = match (&r.failed, r.skipped) {
        (Some(f), _) => J::obj([
            ("kind", J::str("failed")),
            ("source", f.source.clone()),
            ("reason", J::str(&f.reason)),
        ]),
        (None, None) => J::obj([("kind", J::str("effective"))]),
        (None, Some(reason)) => J::obj([("kind", J::str("skipped")), ("reason", J::str(reason))]),
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
pub(super) fn runtime_plan_parts(plan: &J) -> Vec<J> {
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
    let mut parts = vec![
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
    ];
    let env = at(&[
        "execution",
        "dispatchRequest",
        "startRequest",
        "spec",
        "process",
        "lockedEnv",
    ]);
    if let Some(zdotdir) = env.get("ZDOTDIR") {
        let manifest = plan
            .get("artifacts")
            .and_then(|a| a.get("materializedBundleRoot"))
            .and_then(J::as_str)
            .and_then(|root| std::fs::read(join(&[root, ".asp-materialized.json"])).ok())
            .and_then(|bytes| crate::json::parse(&bytes));
        let mut value = J::obj([
            (
                "exclude",
                manifest
                    .as_ref()
                    .and_then(|m| m.get("pathExclude"))
                    .cloned()
                    .unwrap_or(J::Arr(vec![])),
            ),
            ("zdotdir", zdotdir.clone()),
        ]);
        if let Some(wrapper) = env.get("CLAUDE_ENV_FILE") {
            value.set("claudeEnvFile", wrapper.clone());
        }
        parts.insert(
            parts.len() - 1,
            part(
                "runtime-setting",
                "runtime-setting:path-exclude",
                J::obj([("settingId", J::str("path-exclude")), ("value", value)]),
            ),
        );
    }
    parts
}
