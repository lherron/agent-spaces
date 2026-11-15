//! The plan's `resolvedBundle` (audit only): the bundle identity, the
//! instruction slots by content hash (SOUL, instructions.base, HEARTBEAT,
//! modes, scaffold packets), and the composed spaces by audit integrity.
use super::prompt::{self, Ctx};
use super::provisioning::{by_mode, dedupe_spaces};
use super::util::sha256_hex;
use super::{Fwd, fwd, s, spaces};
use crate::json::J;
use crate::reads::jspath::{dirname, join};

/// What the audit bundle reads beyond the profile.
pub(super) struct BundleInput<'a> {
    pub(super) placement: &'a J,
    pub(super) raw_profile: &'a J,
    pub(super) agent_root: &'a str,
    pub(super) agent_name: &'a str,
    pub(super) project_root: Option<&'a str>,
    pub(super) bundle_project_root: Option<&'a str>,
    pub(super) run_mode: Option<&'a str>,
    pub(super) compose: &'a [String],
}

pub(super) fn resolved_bundle(input: &BundleInput) -> Result<J, Fwd> {
    let BundleInput {
        placement,
        raw_profile: raw,
        agent_root,
        agent_name,
        project_root,
        bundle_project_root,
        run_mode,
        compose,
    } = *input;
    let instructions = instructions(placement, raw, agent_root, project_root, run_mode)?;
    let resolved_spaces: Vec<J> = dedupe_spaces(compose.to_vec())
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
            let integrity = space_audit_integrity(r, agent_root, project_root);
            J::obj([
                ("ref", J::str(r)),
                ("resolvedKey", J::str(key)),
                ("integrity", J::str(integrity)),
            ])
        })
        .collect();
    let cwd = match s(placement.get("cwd")).filter(|c| !c.is_empty()) {
        Some(c) => c.to_owned(),
        None => bundle_project_root.unwrap_or(agent_root).to_owned(),
    };
    let mut bundle = J::obj([(
        "bundleIdentity",
        J::str(bundle_identity(agent_root, agent_name, bundle_project_root)),
    )]);
    if let Some(mode) = run_mode {
        bundle.set("runMode", J::str(mode));
    }
    bundle.set("cwd", J::str(cwd));
    bundle.set("instructions", J::Arr(instructions));
    bundle.set("spaces", J::Arr(resolved_spaces));
    Ok(bundle)
}

/// Instructions (audit only): SOUL, instructions.base, HEARTBEAT, modes and
/// scaffold packets, each as `{slot, ref, contentHash}`; none without SOUL.
fn instructions(
    placement: &J,
    raw: &J,
    agent_root: &str,
    project_root: Option<&str>,
    run_mode: Option<&str>,
) -> Result<Vec<J>, Fwd> {
    let soul = join(&[agent_root, "SOUL.md"]);
    if !std::path::Path::new(&soul).exists() {
        return Ok(vec![]);
    }
    let mut slots: Vec<(&str, String, String)> = vec![];
    let read = |path: &str| {
        std::fs::read(path)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    };
    let soul_content = read(&soul).ok_or_else(|| fwd(crate::reason!("soul_unreadable")))?;
    slots.push(("soul", soul_content, "agent-root:///SOUL.md".into()));
    let instruction_ref = |r: &str| -> Option<String> {
        let path = if r.starts_with("agent-root:///") || r.starts_with("project-root:///") {
            // `resolveRootRelativeRef`; `None` where Bun's
            // `resolveInstructionRef` swallows the throw.
            prompt::root_relative(r, &expansion_ctx_stub(agent_root, project_root))?
        } else {
            join(&[agent_root, r])
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
    if run_mode == Some("heartbeat") {
        let hb = join(&[agent_root, "HEARTBEAT.md"]);
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
        run_mode,
    ) {
        if let Some(c) = instruction_ref(&r) {
            slots.push(("by-mode", c, r));
        }
    }
    // resolveScaffoldPacket: inline content, else the ref's content
    // ('' when unreadable); a packet with neither is skipped.
    let packets = placement.get("scaffoldPackets").and_then(J::as_arr);
    for packet in packets.into_iter().flatten() {
        let r = packet.get("ref").and_then(J::as_str).unwrap_or_default();
        let content = match packet.get("content").and_then(J::as_str) {
            Some(c) if !c.is_empty() => Some(c.to_owned()),
            _ if !r.is_empty() => Some(instruction_ref(r).unwrap_or_default()),
            c => c.map(str::to_owned),
        };
        if let Some(content) = content {
            let slot = packet.get("slot").and_then(J::as_str).unwrap_or_default();
            slots.push((slot, content, r.to_owned()));
        }
    }
    Ok(slots
        .into_iter()
        .map(|(slot, content, r)| {
            J::obj([
                ("slot", J::str(slot)),
                ("ref", J::str(r)),
                (
                    "contentHash",
                    J::str(format!("sha256:{}", sha256_hex(content.as_bytes()))),
                ),
            ])
        })
        .collect())
}

fn expansion_ctx_stub(agent_root: &str, project_root: Option<&str>) -> Ctx {
    Ctx {
        agent_root: agent_root.to_owned(),
        agents_root: dirname(agent_root),
        search_path: vec![],
        project_root: project_root.map(str::to_owned),
        cwd: None,
        project_id: None,
        agent_id: None,
        agent_name: None,
        task_id: None,
        task_context: None,
        lane: None,
        run_mode: Some("task".into()),
        agent_profile: None,
        env: None,
        exec_env: None,
        pinned: None,
    }
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
