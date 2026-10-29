//! `parseAgentProfile` (core/config/src/core/config/agent-profile-toml.ts):
//! the same checks in the same order, failing on the first with Bun's message,
//! and the fields `resolveRuntimeDeclaration` reads.
use super::Forward;
use super::patterns::{is_node_id, is_space_ref, is_token_chars, validate_token};
use super::toml::{self, TomlError};
use crate::json::J;

pub const HARNESS_IDS: [&str; 5] = ["agent-harness", "claude", "claude-hrcpty", "codex", "muse"];
const RUN_MODES: [&str; 4] = ["query", "heartbeat", "task", "maintenance"];
const ROSTER_SLOT_TOKENS: [&str; 10] = [
    "nova", "comet", "pulsar", "quasar", "meteor", "aurora", "zenith", "eclipse", "orbit", "cosmos",
];
/// `PROVISIONING_SCALAR_KINDS` order, with each key's kind.
pub const SCALARS: [(&str, bool); 10] = [
    ("harness", false),
    ("model_provider", false),
    ("model", false),
    ("reasoning_effort", false),
    ("presentation", true),
    ("node", false),
    ("yolo", true),
    ("sandbox", false),
    ("approval", false),
    ("remote", true),
];

#[derive(Default)]
pub struct Placement {
    pub launch: Option<String>,
    pub pins: Vec<(String, J)>,
    pub homes: Vec<(String, J)>,
}

#[derive(Default)]
pub struct Profile {
    pub operator: Option<bool>,
    pub claims_task: Option<bool>,
    pub placement: Option<Placement>,
    /// The `[provisioning]` scalars, by key.
    pub provisioning: Option<Vec<(String, J)>>,
    pub identity_role: Option<String>,
    pub priming: Option<String>,
    pub priming_file: Option<String>,
}

impl Profile {
    pub fn scalar(&self, key: &str) -> Option<&J> {
        self.provisioning
            .as_ref()?
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }
    pub fn harness(&self) -> Option<&str> {
        match self.scalar("harness") {
            Some(J::Str(s)) => Some(s),
            _ => None,
        }
    }
}

pub enum ProfileError {
    /// `ConfigValidationError`'s message.
    Invalid(String),
    Forward(Forward),
}

type R<T> = Result<T, ProfileError>;

fn fail<T>(path: &str, message: impl Into<String>) -> R<T> {
    Err(ProfileError::Invalid(format!(
        "Invalid agent-profile.toml:\n  {path}: {}",
        message.into()
    )))
}

fn assert_only_keys(value: &J, allowed: &[&str], path: &str) -> R<()> {
    for (key, _) in value.js_entries() {
        if !allowed.contains(&key) {
            return fail(
                &format!("{path}/{key}"),
                format!("unknown property \"{key}\""),
            );
        }
    }
    Ok(())
}

fn string_array(value: Option<&J>, path: &str) -> R<Option<Vec<String>>> {
    match value {
        None => Ok(None),
        Some(J::Arr(items)) if items.iter().all(|i| matches!(i, J::Str(_))) => Ok(Some(
            items
                .iter()
                .map(|i| match i {
                    J::Str(s) => s.clone(),
                    _ => unreachable!(),
                })
                .collect(),
        )),
        Some(_) => fail(path, "must be an array of strings"),
    }
}

fn optional_string(value: &J, key: &str, path: &str) -> R<Option<String>> {
    match value.get(key) {
        None => Ok(None),
        Some(J::Str(s)) => Ok(Some(s.clone())),
        Some(_) => fail(&format!("{path}/{key}"), "must be a string"),
    }
}

fn optional_enum(value: &J, key: &str, allowed: &[&str], label: &str, path: &str) -> R<()> {
    if let Some(parsed) = optional_string(value, key, path)?
        && !allowed.contains(&parsed.as_str())
    {
        return fail(
            &format!("{path}/{key}"),
            format!("unsupported {label} \"{parsed}\""),
        );
    }
    Ok(())
}

fn space_ref_array(value: Option<&J>, path: &str) -> R<Option<Vec<String>>> {
    let Some(refs) = string_array(value, path)? else {
        return Ok(None);
    };
    for r in &refs {
        if !is_space_ref(r) {
            return fail(path, format!("\"{r}\" is not a valid space reference"));
        }
    }
    Ok(Some(refs))
}

fn by_mode_string_arrays(value: Option<&J>, path: &str) -> R<()> {
    let Some(value) = value else { return Ok(()) };
    if !value.is_record() {
        return fail(path, "must be a table");
    }
    for (mode, refs) in value.js_entries() {
        let mode_path = format!("{path}/{mode}");
        if !RUN_MODES.contains(&mode) {
            return fail(&mode_path, format!("unsupported run mode \"{mode}\""));
        }
        let raw = if refs.is_record() {
            refs.get("base")
        } else {
            Some(refs)
        };
        if refs.is_record() {
            assert_only_keys(refs, &["base"], &mode_path)?;
        }
        string_array(raw, &mode_path)?;
    }
    Ok(())
}

fn by_mode_space_refs(value: Option<&J>, path: &str) -> R<()> {
    let Some(value) = value else { return Ok(()) };
    if !value.is_record() {
        return fail(path, "must be a table");
    }
    for (mode, refs) in value.js_entries() {
        let mode_path = format!("{path}/{mode}");
        if !RUN_MODES.contains(&mode) {
            return fail(&mode_path, format!("unsupported run mode \"{mode}\""));
        }
        match refs {
            J::Arr(_) => {
                space_ref_array(Some(refs), &mode_path)?;
            }
            J::Obj(_) => {
                assert_only_keys(refs, &["base"], &mode_path)?;
                space_ref_array(refs.get("base"), &format!("{mode_path}/base"))?;
            }
            _ => {
                return fail(
                    &mode_path,
                    "must be an array of space refs or a table with base",
                );
            }
        }
    }
    Ok(())
}

fn provisioning(value: Option<&J>, path: &str) -> R<Option<Vec<(String, J)>>> {
    let Some(value) = value else { return Ok(None) };
    if !value.is_record() {
        return fail(path, "must be a table");
    }
    let mut allowed: Vec<&str> = SCALARS.iter().map(|(k, _)| *k).collect();
    allowed.extend(["claude", "codex", "default_scope_role"]);
    assert_only_keys(value, &allowed, path)?;
    let mut scalars = vec![];
    for (key, raw) in value.js_entries() {
        let key_path = format!("{path}/{key}");
        match key {
            "claude" => claude_options(raw, &key_path)?,
            "codex" => codex_options(raw, &key_path)?,
            "default_scope_role" => {
                let J::Str(raw) = raw else {
                    return fail(&key_path, "must be a string");
                };
                if let Some(error) = validate_token(raw, "role") {
                    return fail(&key_path, error);
                }
            }
            _ => {
                let boolean = SCALARS.iter().any(|(k, b)| *k == key && *b);
                if boolean {
                    if !matches!(raw, J::Bool(_)) {
                        return fail(&key_path, "must be a boolean");
                    }
                } else {
                    let J::Str(s) = raw else {
                        return fail(&key_path, "must be a string");
                    };
                    if key == "harness" && !HARNESS_IDS.contains(&s.as_str()) {
                        return fail(
                            &key_path,
                            format!(
                                "unsupported harness \"{s}\"; valid harness ids: {}",
                                HARNESS_IDS.join(", ")
                            ),
                        );
                    }
                    if key == "model" && s.contains('/') {
                        return fail(
                            &key_path,
                            format!(
                                "provider-prefixed model \"{s}\" is rejected; set model_provider and model separately"
                            ),
                        );
                    }
                    if key == "node" && s == "local" {
                        return fail(
                            &key_path,
                            "\"local\" is not a registry node id; omit node for local birth",
                        );
                    }
                    if key == "node" && !is_node_id(s) {
                        return fail(&key_path, "must be a node id matching [A-Za-z0-9._-]{1,64}");
                    }
                }
                scalars.push((key.to_owned(), raw.clone()));
            }
        }
    }
    Ok(Some(scalars))
}

fn identity(value: Option<&J>, path: &str) -> R<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    if !value.is_record() {
        return fail(path, "must be a table");
    }
    assert_only_keys(value, &["display", "role", "avatar"], path)?;
    let mut role = None;
    for (key, raw) in value.js_entries() {
        let key_path = format!("{path}/{key}");
        let J::Str(raw) = raw else {
            return fail(&key_path, "must be a string");
        };
        if key == "avatar" {
            match super::patterns::https_image_url(raw) {
                Some(true) => {}
                Some(false) => return fail(&key_path, "must be a public HTTPS image URL"),
                None => return Err(ProfileError::Forward("profile_avatar_url")),
            }
        }
        if key == "role" {
            if let Some(error) = validate_token(raw, "role") {
                return fail(&key_path, error);
            }
            role = Some(raw.clone());
        }
    }
    Ok(role)
}

fn placement_map(value: Option<&J>, output: &mut Vec<(String, J)>, pin: bool, path: &str) -> R<()> {
    let Some(value) = value else { return Ok(()) };
    if !value.is_record() {
        return fail(path, "must be a table");
    }
    for (key, raw) in value.js_entries() {
        let key_path = format!("{path}/{key}");
        let key_ok = if pin {
            key.split_once(':').is_some_and(|(a, b)| {
                (1..=64).contains(&a.len())
                    && (1..=64).contains(&b.len())
                    && is_token_chars(a)
                    && is_token_chars(b)
            })
        } else {
            is_node_id(key)
        };
        if !key_ok {
            return fail(
                &key_path,
                if pin {
                    "must be an exact project:task scope key with token characters [A-Za-z0-9._-]"
                } else {
                    "must be an exact task name with token characters [A-Za-z0-9._-]"
                },
            );
        }
        let J::Str(node) = raw else {
            return fail(&key_path, "must be a string");
        };
        if node == "local" {
            return fail(
                &key_path,
                "\"local\" is not a registry node id; omit provisioning.node for local birth",
            );
        }
        if !is_node_id(node) {
            return fail(&key_path, "must be a node id matching [A-Za-z0-9._-]{1,64}");
        }
        match output.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = raw.clone(),
            None => output.push((key.to_owned(), raw.clone())),
        }
    }
    Ok(())
}

fn placement(value: Option<&J>, path: &str) -> R<Option<Placement>> {
    let Some(value) = value else { return Ok(None) };
    if !value.is_record() {
        return fail(path, "must be a table");
    }
    assert_only_keys(value, &["launch", "pins", "homes"], path)?;
    let mut placement = Placement::default();
    if let Some(launch) = value.get("launch") {
        if launch != &J::str("participant-only") {
            return fail(
                &format!("{path}/launch"),
                "must be \"participant-only\" when set",
            );
        }
        placement.launch = Some("participant-only".into());
    }
    placement_map(
        value.get("pins"),
        &mut placement.pins,
        true,
        &format!("{path}/pins"),
    )?;
    placement_map(
        value.get("homes"),
        &mut placement.homes,
        false,
        &format!("{path}/homes"),
    )?;
    let homes = J::Obj(placement.homes.clone());
    let pins = J::Obj(placement.pins.clone());
    for (base, _) in homes.js_entries() {
        for suffix in ROSTER_SLOT_TOKENS {
            let member = format!("{base}-{suffix}");
            if homes.has(&member) {
                return fail(
                    &format!("{path}/homes/{member}"),
                    format!(
                        "reserved family member \"{member}\" cannot declare a home while base \"{base}\" is declared"
                    ),
                );
            }
            for (pin_key, _) in pins.js_entries() {
                let task = pin_key.split_once(':').map_or(pin_key, |(_, t)| t);
                if task == member {
                    return fail(
                        &format!("{path}/pins/{pin_key}"),
                        format!(
                            "reserved family member \"{member}\" cannot be pinned while base \"{base}\" is declared"
                        ),
                    );
                }
            }
        }
    }
    Ok(Some(placement))
}

fn jobs(value: Option<&J>, path: &str) -> R<()> {
    let Some(value) = value else { return Ok(()) };
    if !value.is_record() {
        return fail(path, "must be a table");
    }
    assert_only_keys(value, &["default_node"], path)?;
    if let Some(raw) = value.get("default_node")
        && let Err(message) = job_execution_nodes(raw)
    {
        return fail(&format!("{path}/default_node"), message);
    }
    Ok(())
}

/// `normalizeJobExecutionNodes`, for its verdict only.
fn job_execution_nodes(value: &J) -> Result<(), String> {
    let authored: Vec<&J> = match value {
        J::Str(_) => vec![value],
        J::Arr(items) => items.iter().collect(),
        _ => vec![&J::Null],
    };
    if !matches!(value, J::Str(_) | J::Arr(_)) || authored.iter().any(|n| !matches!(n, J::Str(_))) {
        return Err("must be a node id string, an array of node id strings, or \"all\"".into());
    }
    if authored.is_empty() {
        return Err("must contain at least one node id".into());
    }
    let mut nodes: Vec<&str> = vec![];
    for n in authored {
        if let J::Str(s) = n
            && !nodes.contains(&s.as_str())
        {
            nodes.push(s);
        }
    }
    if nodes.contains(&"local") {
        return Err("\"local\" is not allowed for job execution ownership".into());
    }
    if nodes.contains(&"all") && nodes.len() != 1 {
        return Err("\"all\" cannot be mixed with concrete node ids".into());
    }
    for node in nodes {
        if node != "all" && !is_node_id(node) {
            return Err(format!(
                "\"{node}\" must be a node id matching [A-Za-z0-9._-]{{1,64}}"
            ));
        }
    }
    Ok(())
}

fn claude_options(value: &J, path: &str) -> R<()> {
    if !value.is_record() {
        return fail(path, "must be a table");
    }
    assert_only_keys(
        value,
        &["model", "permission_mode", "args", "ask_user_question"],
        path,
    )?;
    optional_string(value, "model", path)?;
    optional_string(value, "permission_mode", path)?;
    if let Some(args) = value.get("args") {
        string_array(Some(args), &format!("{path}/args"))?;
    }
    if let Some(ask) = value.get("ask_user_question")
        && !matches!(ask, J::Bool(_))
    {
        return fail(&format!("{path}/ask_user_question"), "must be a boolean");
    }
    Ok(())
}

fn codex_options(value: &J, path: &str) -> R<()> {
    if !value.is_record() {
        return fail(path, "must be a table");
    }
    assert_only_keys(
        value,
        &[
            "model",
            "model_reasoning_effort",
            "model_reasoning_summary",
            "status_line",
            "approval_policy",
            "sandbox_mode",
        ],
        path,
    )?;
    optional_string(value, "model", path)?;
    optional_string(value, "model_reasoning_effort", path)?;
    optional_enum(
        value,
        "model_reasoning_summary",
        &["auto", "concise", "detailed", "none"],
        "reasoning summary mode",
        path,
    )?;
    if let Some(status_line) = value.get("status_line") {
        string_array(Some(status_line), &format!("{path}/status_line"))?;
    }
    optional_enum(
        value,
        "approval_policy",
        &["untrusted", "on-failure", "on-request", "never"],
        "approval policy",
        path,
    )?;
    optional_enum(
        value,
        "sandbox_mode",
        &["read-only", "workspace-write", "danger-full-access"],
        "sandbox mode",
        path,
    )?;
    Ok(())
}

pub fn parse(content: &str) -> R<Profile> {
    let parsed = match toml::parse(content) {
        Ok(v) => v,
        // iarna's own parse messages are not reproduced.
        Err(TomlError::Unparsed | TomlError::IarnaRejects) => {
            return Err(ProfileError::Forward("profile_toml_syntax"));
        }
        Err(TomlError::Unsupported(reason)) => return Err(ProfileError::Forward(reason)),
    };
    assert_only_keys(
        &parsed,
        &[
            "version",
            "operator",
            "claims_task",
            "placement",
            "provisioning",
            "jobs",
            "identity",
            "priming",
            "priming_file",
            "instructions",
            "session",
            "spaces",
            "targets",
        ],
        "",
    )?;
    if parsed.get("version") != Some(&J::Num(4.0)) {
        return fail(
            "/version",
            "unsupported profile version; expected 4 (versions 1 through 3 are rejected without translation)",
        );
    }
    let mut profile = Profile::default();
    for (key, slot) in [("operator", 0), ("claims_task", 1)] {
        if let Some(v) = parsed.get(key) {
            let J::Bool(b) = v else {
                return fail(&format!("/{key}"), "must be a boolean");
            };
            if slot == 0 {
                profile.operator = Some(*b);
            } else {
                profile.claims_task = Some(*b);
            }
        }
    }
    profile.placement = placement(parsed.get("placement"), "/placement")?;
    profile.provisioning = provisioning(parsed.get("provisioning"), "/provisioning")?;
    jobs(parsed.get("jobs"), "/jobs")?;
    profile.identity_role = identity(parsed.get("identity"), "/identity")?;
    for key in ["priming", "priming_file"] {
        if let Some(v) = parsed.get(key) {
            let J::Str(s) = v else {
                return fail(&format!("/{key}"), "must be a string");
            };
            if key == "priming" {
                profile.priming = Some(s.clone());
            } else {
                profile.priming_file = Some(s.clone());
            }
        }
    }
    if profile.priming.is_some() && profile.priming_file.is_some() {
        return fail("/priming_file", "cannot set both priming and priming_file");
    }
    if let Some(instructions) = parsed.get("instructions") {
        if !instructions.is_record() {
            return fail("/instructions", "must be a table");
        }
        assert_only_keys(
            instructions,
            &["base", "modes", "template"],
            "/instructions",
        )?;
        string_array(instructions.get("base"), "/instructions/base")?;
        by_mode_string_arrays(instructions.get("modes"), "/instructions/modes")?;
    }
    if let Some(session) = parsed.get("session") {
        if !session.is_record() {
            return fail("/session", "must be a table");
        }
        assert_only_keys(
            session,
            &["additionalContext", "additionalExec", "metadata"],
            "/session",
        )?;
        if let Some(metadata) = session.get("metadata")
            && !metadata.is_record()
        {
            return fail("/session/metadata", "must be a table");
        }
        string_array(
            session.get("additionalContext"),
            "/session/additionalContext",
        )?;
        string_array(session.get("additionalExec"), "/session/additionalExec")?;
    }
    if let Some(spaces) = parsed.get("spaces") {
        if !spaces.is_record() {
            return fail("/spaces", "must be a table");
        }
        assert_only_keys(spaces, &["base", "modes"], "/spaces")?;
        space_ref_array(spaces.get("base"), "/spaces/base")?;
        by_mode_space_refs(spaces.get("modes"), "/spaces/modes")?;
    }
    if let Some(targets) = parsed.get("targets") {
        if !targets.is_record() {
            return fail("/targets", "must be a table");
        }
        for (name, raw) in targets.js_entries() {
            let target_path = format!("/targets/{name}");
            if !raw.is_record() {
                return fail(&target_path, "must be a table");
            }
            assert_only_keys(raw, &["compose"], &target_path)?;
            let compose_path = format!("{target_path}/compose");
            let compose = space_ref_array(raw.get("compose"), &compose_path)?;
            if compose.is_none_or(|c| c.is_empty()) {
                return fail(&compose_path, "must contain at least one space reference");
            }
        }
    }
    Ok(profile)
}
