//! The agent-profile and project-target reads the compile makes
//! (agent-project-merge.ts, placement-resolver.ts) and the session metadata
//! they layer (`layerSessionMetadata`).
use super::{Fwd, fwd};
use crate::json::J;
use crate::reads::jspath::{join, read_text};
use crate::reads::{profile, targets};

/// The validated agent profile: the raw TOML plus R2's typed reads.
pub struct Profile {
    pub raw: J,
    pub typed: profile::Profile,
}

pub fn read_profile(agent_root: &str) -> Result<Profile, Fwd> {
    let path = join(&[agent_root, "agent-profile.toml"]);
    let content = if std::path::Path::new(&path).exists() {
        read_text(&path).map_err(|_| fwd(crate::reason!("source_read_unavailable")))?
    } else {
        "version = 4\n".to_owned()
    };
    let typed = match profile::parse(&content) {
        Ok(p) => p,
        Err(profile::ProfileError::Forward(r)) => return Err(fwd(r)),
        Err(profile::ProfileError::Invalid(_)) => {
            return Err(fwd(crate::reason!("agent_profile_invalid")));
        }
    };
    let raw = crate::reads::toml::parse(&content)
        .map_err(|_| fwd(crate::reason!("profile_toml_syntax")))?;
    Ok(Profile { raw, typed })
}

/// This agent's target in the project's `asp-targets.toml`, if any.
pub fn read_target(project_root: Option<&str>, agent_name: &str) -> Result<Option<J>, Fwd> {
    let Some(project_root) = project_root else {
        return Ok(None);
    };
    let path = join(&[project_root, "asp-targets.toml"]);
    if !std::path::Path::new(&path).exists() {
        return Ok(None);
    }
    let content = read_text(&path).map_err(|_| fwd(crate::reason!("source_read_unavailable")))?;
    let manifest = match targets::parse(&content) {
        Ok(m) => m,
        Err(targets::TargetsError::Forward(r)) => return Err(fwd(r)),
        Err(targets::TargetsError::Invalid(_)) => {
            return Err(fwd(crate::reason!("project_targets_invalid")));
        }
    };
    Ok(manifest
        .get("targets")
        .and_then(|t| t.get(agent_name))
        .cloned())
}

/// `session.metadata` leaves of profile then target, as `layerSessionMetadata`.
pub fn session_metadata(profile: &J, target: Option<&J>) -> (J, Vec<J>) {
    fn flatten(v: &J, prefix: &str, out: &mut Vec<(String, J)>) {
        for (k, leaf) in v.js_entries() {
            let path = if prefix.is_empty() {
                k.to_owned()
            } else {
                format!("{prefix}.{k}")
            };
            if leaf.is_record() {
                flatten(leaf, &path, out);
            } else {
                match out.iter_mut().find(|(p, _)| *p == path) {
                    Some(slot) => slot.1 = leaf.clone(),
                    None => out.push((path, leaf.clone())),
                }
            }
        }
    }
    let mut leaves = vec![];
    if let Some(m) = profile.get("session").and_then(|s| s.get("metadata")) {
        flatten(m, "", &mut leaves);
    }
    if let Some(m) = target
        .and_then(|t| t.get("session"))
        .and_then(|s| s.get("metadata"))
    {
        flatten(m, "", &mut leaves);
    }
    let key_ok = |k: &str| {
        k.len() <= 128
            && k.split('.').count() <= 4
            && k.split('.').all(|seg| {
                let mut chars = seg.chars();
                chars.next().is_some_and(|c| c.is_ascii_lowercase())
                    && seg.len() <= 64
                    && chars.all(|c| c.is_ascii_alphanumeric())
            })
    };
    let scalar = |v: &J| {
        matches!(v, J::Null | J::Str(_) | J::Bool(_)) || matches!(v, J::Num(n) if n.is_finite())
    };
    let mut accepted: Vec<(String, J)> = vec![];
    let mut diagnostics = vec![];
    for (key, value) in leaves {
        let reason = if !key_ok(&key) {
            Some("invalid metadata key")
        } else if !scalar(&value) && !matches!(&value, J::Arr(items) if items.iter().all(scalar)) {
            Some("value must be a JSON scalar or array of scalars")
        } else if value.to_json().len() > 4096 {
            Some("value exceeds 4096 bytes")
        } else if accepted
            .iter()
            .any(|(e, _)| e.starts_with(&format!("{key}.")) || key.starts_with(&format!("{e}.")))
        {
            Some("metadata prefix collision")
        } else if accepted.len() >= 64 {
            Some("metadata exceeds 64 keys")
        } else {
            None
        };
        match reason {
            Some(r) => diagnostics.push(J::obj([
                ("level", J::str("warning")),
                ("code", J::str("session_metadata_rejected")),
                ("message", J::str(format!("{key}: {r}"))),
                ("plane", J::str("asp-compiler")),
            ])),
            None => accepted.push((key, value)),
        }
    }
    (J::Obj(accepted), diagnostics)
}
