//! `parseTargetsToml` (core/config/src/core/config/targets-toml.ts).
//!
//! The JSON-schema pass is Ajv's (allErrors), whose message list raspd does
//! not reproduce: raspd only decides whether the schema passes, and a manifest
//! that fails it is forwarded. The semantic checks after the schema carry
//! spaces-config's own messages and are answered natively.
use super::Forward;
use super::patterns::{is_node_id, is_schema_space_ref};
use super::profile::HARNESS_IDS;
use super::toml::{self, TomlError};
use crate::json::J;

pub enum TargetsError {
    Invalid(String),
    Forward(Forward),
}

/// The validated manifest, `targets` defaulted to `{}`.
pub fn parse(content: &str) -> Result<J, TargetsError> {
    let parsed = match toml::parse(content) {
        Ok(v) => v,
        Err(TomlError::Unparsed | TomlError::IarnaRejects) => {
            return Err(TargetsError::Forward("targets_toml_syntax"));
        }
        Err(TomlError::Unsupported(reason)) => return Err(TargetsError::Forward(reason)),
    };
    if !manifest_valid(&parsed) {
        return Err(TargetsError::Forward("targets_schema_invalid"));
    }
    let mut errors: Vec<(String, String)> = vec![];
    let empty = J::Obj(vec![]);
    let targets = parsed.get("targets").unwrap_or(&empty);
    for (name, target) in targets.js_entries() {
        if target.has("priming") && target.has("priming_append") {
            errors.push((
                format!("/targets/{name}"),
                "cannot set both priming and priming_append".into(),
            ));
        }
        let provisioning = target.get("provisioning");
        if let Some(J::Str(harness)) = provisioning.and_then(|p| p.get("harness"))
            && !HARNESS_IDS.contains(&harness.as_str())
        {
            errors.push((
                format!("/targets/{name}/provisioning/harness"),
                format!(
                    "unsupported harness \"{harness}\"; valid harness ids: {}",
                    HARNESS_IDS.join(", ")
                ),
            ));
        }
        if let Some(J::Str(model)) = provisioning.and_then(|p| p.get("model"))
            && model.contains('/')
        {
            errors.push((
                format!("/targets/{name}/provisioning/model"),
                format!(
                    "provider-prefixed model \"{model}\" is rejected; set model_provider and model separately"
                ),
            ));
        }
    }
    if !errors.is_empty() {
        let details: Vec<String> = errors
            .iter()
            .map(|(path, message)| format!("  {path}: {message}"))
            .collect();
        return Err(TargetsError::Invalid(format!(
            "Invalid asp-targets.toml:\n{}",
            details.join("\n")
        )));
    }
    let mut manifest = parsed;
    if !manifest.has("targets")
        && let J::Obj(fields) = &mut manifest
    {
        fields.push(("targets".into(), J::Obj(vec![])));
    }
    Ok(manifest)
}

fn is_str(v: &J) -> bool {
    matches!(v, J::Str(_))
}
fn is_bool(v: &J) -> bool {
    matches!(v, J::Bool(_))
}
fn is_str_array(v: &J) -> bool {
    matches!(v, J::Arr(items) if items.iter().all(is_str))
}
fn is_enum(v: &J, allowed: &[&str]) -> bool {
    matches!(v, J::Str(s) if allowed.contains(&s.as_str()))
}

/// Every key is allowed and each present value passes its check.
type Check<'a> = &'a dyn Fn(&J) -> bool;

fn object(v: &J, props: &[(&str, Check)]) -> bool {
    v.is_record()
        && v.js_entries().into_iter().all(|(k, value)| {
            props
                .iter()
                .find(|(name, _)| *name == k)
                .is_some_and(|(_, check)| check(value))
        })
}

fn claude(v: &J) -> bool {
    object(
        v,
        &[
            ("model", &is_str),
            ("permission_mode", &is_str),
            ("ask_user_question", &is_bool),
            ("args", &is_str_array),
        ],
    )
}

fn codex(v: &J) -> bool {
    object(
        v,
        &[
            ("model", &is_str),
            ("model_reasoning_effort", &is_str),
            ("model_reasoning_summary", &|v| {
                is_enum(v, &["auto", "concise", "detailed", "none"])
            }),
            ("status_line", &is_str_array),
            ("approval_policy", &|v| {
                is_enum(v, &["untrusted", "on-failure", "on-request", "never"])
            }),
            ("sandbox_mode", &|v| {
                is_enum(v, &["read-only", "workspace-write", "danger-full-access"])
            }),
        ],
    )
}

fn target(v: &J) -> bool {
    let provisioning = |v: &J| {
        object(
            v,
            &[
                ("harness", &is_str),
                ("model_provider", &is_str),
                ("model", &is_str),
                ("reasoning_effort", &is_str),
                ("presentation", &is_bool),
                ("node", &|v| matches!(v, J::Str(s) if is_node_id(s))),
                ("yolo", &is_bool),
                ("sandbox", &is_str),
                ("approval", &is_str),
                ("remote", &is_bool),
                ("claude", &claude),
                ("codex", &codex),
            ],
        )
    };
    object(
        v,
        &[
            ("session", &|v| object(v, &[("metadata", &J::is_record)])),
            // Ajv counts code points.
            (
                "description",
                &|v| matches!(v, J::Str(s) if s.chars().count() <= 300),
            ),
            ("priming", &is_str),
            ("priming_append", &is_str),
            (
                "compose",
                &|v| matches!(v, J::Arr(items) if items.iter().all(|i| matches!(i, J::Str(s) if is_schema_space_ref(s)))),
            ),
            ("compose_mode", &|v| is_enum(v, &["replace", "merge"])),
            ("provisioning", &provisioning),
            ("resolver", &|v| {
                object(v, &[("locked", &is_bool), ("allow_dirty", &is_bool)])
            }),
        ],
    )
}

/// targets.schema.json, as a verdict.
fn manifest_valid(v: &J) -> bool {
    let integer_two = |v: &J| matches!(v, J::Num(n) if *n == 2.0);
    v.has("schema")
        && object(
            v,
            &[
                ("schema", &integer_two),
                ("agents-root", &is_str),
                ("claude", &claude),
                ("codex", &codex),
                ("targets", &|v| {
                    v.is_record() && v.js_entries().into_iter().all(|(_, t)| target(t))
                }),
            ],
        )
}
