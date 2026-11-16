//! One section's content (section-resolution.ts): file, inline, inline parts,
//! exec and slot sections, and how a failed one is worded.
use super::exec::run_exec;
use super::probe::resolve_probe;
use super::refs::{read_message, read_optional, template_ref};
use super::template::{Body, Section};
use super::vars::interpolate;
use super::when::matches;
use super::{Ctx, OBJECT_PROTOTYPE_KEYS};
use crate::compile::util::{utf16_len, utf16_slice};
use crate::compile::{Fwd, fwd};
use crate::json::J;

/// SectionResolution `failed`: its source and reason, as Bun words them.
/// `None` for a failure raspd cannot word as Bun does (an inspect then
/// refuses `prompt_section_failed`; a compile skips the section either way).
#[derive(Clone)]
pub struct Failure {
    pub source: J,
    pub reason: String,
}

pub(super) enum Res {
    Content(String),
    Empty,
    Failed(Option<Failure>),
}

pub(super) fn as_res(content: Option<String>) -> Res {
    match content {
        Some(c) if !c.is_empty() => Res::Content(c),
        _ => Res::Empty,
    }
}

/// `boundedReason`: the first 8192 UTF-16 units.
pub(super) fn bounded(reason: String) -> String {
    const MAX: usize = 8192;
    if utf16_len(&reason) <= MAX {
        return reason;
    }
    utf16_slice(&reason, 0, MAX).unwrap_or_default()
}

fn resolve_exec(command: &str, timeout: Option<f64>, ctx: &Ctx) -> Res {
    match run_exec(command, timeout.unwrap_or(5000.0), ctx) {
        Ok(out) => as_res(Some(out)),
        Err(reason) => Res::Failed(reason.map(|reason| Failure {
            source: J::obj([("kind", J::str("exec")), ("command", J::str(command))]),
            reason: bounded(reason),
        })),
    }
}

fn resolve_file(path: &str, required: bool, ctx: &Ctx) -> Result<Res, Fwd> {
    let file = match template_ref(path, ctx) {
        Ok(f) => f,
        Err(Some(f)) => return Err(f),
        Err(None) if required => {
            return Err(fwd(crate::reason!("required_context_file_unresolvable")));
        }
        Err(None) => return Ok(Res::Failed(None)),
    };
    let content = match read_optional(&file) {
        Ok(c) => c,
        Err(_) if required => return Err(fwd(crate::reason!("required_context_file_unreadable"))),
        Err(e) => {
            return Ok(Res::Failed(read_message(&e, &file).map(|message| {
                Failure {
                    source: J::obj([("kind", J::str("file")), ("ref", J::str(path))]),
                    reason: bounded(format!("Unreadable context file {path}: {message}")),
                }
            })));
        }
    };
    match content {
        Some(c) if !c.is_empty() => Ok(as_res(Some(interpolate(&c, ctx)?))),
        _ if required => Err(fwd(crate::reason!("required_context_file_missing"))),
        _ => Ok(Res::Empty),
    }
}

/// One slot entry: a file ref read optionally, or (for an `…Exec` source) a
/// command.
fn resolve_slot_entry(entry: &str, exec: bool, ctx: &Ctx) -> Result<Res, Fwd> {
    if exec {
        return Ok(resolve_exec(entry, None, ctx));
    }
    Ok(match template_ref(entry, ctx) {
        Ok(file) => match read_optional(&file) {
            Ok(Some(c)) => as_res(Some(interpolate(&c, ctx)?)),
            Ok(None) => Res::Empty,
            Err(e) => Res::Failed(read_message(&e, &file).map(|message| Failure {
                source: J::Null,
                reason: bounded(format!("Unreadable slot file {entry}: {message}")),
            })),
        },
        Err(Some(f)) => return Err(f),
        Err(None) => Res::Failed(None),
    })
}

/// A slot section: the agent profile value at `source`, each entry resolved
/// and joined; `slotAggregateResolution` when every entry failed.
fn resolve_slot(source: &str, ctx: &Ctx) -> Result<Res, Fwd> {
    let segments: Vec<&str> = source.split('.').filter(|s| !s.is_empty()).collect();
    if segments.iter().any(|s| OBJECT_PROTOTYPE_KEYS.contains(s)) {
        return Err(fwd(crate::reason!("slot_prototype_source")));
    }
    let mut current = ctx.agent_profile.as_ref();
    if segments.is_empty() {
        current = None;
    }
    for seg in &segments {
        current = match current {
            Some(c) if c.is_record() => c.get(seg),
            _ => None,
        };
    }
    let Some(value) = current else {
        return Ok(Res::Empty);
    };
    let slot_source = || J::obj([("kind", J::str("slot")), ("source", J::str(source))]);
    let entries: Vec<String> = match value {
        J::Str(s) if s.is_empty() => vec![],
        J::Str(s) => vec![s.clone()],
        J::Arr(items) if items.iter().all(|i| matches!(i, J::Str(_))) => items
            .iter()
            .filter_map(J::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => {
            return Ok(Res::Failed(Some(Failure {
                source: slot_source(),
                reason: bounded(format!(
                    "Slot source {source} must resolve to a string or string array"
                )),
            })));
        }
    };
    if entries.is_empty() {
        return Ok(Res::Empty);
    }
    let mut contents: Vec<String> = vec![];
    // Each failed contribution's reason; `None` where raspd has no wording.
    let mut failures: Vec<Option<String>> = vec![];
    let exec = source.ends_with("Exec");
    for entry in &entries {
        match resolve_slot_entry(entry, exec, ctx)? {
            Res::Content(c) => contents.push(c),
            Res::Empty => {}
            Res::Failed(f) => failures.push(f.map(|f| f.reason)),
        }
    }
    if !contents.is_empty() {
        return Ok(as_res(Some(contents.join(if exec {
            "\n"
        } else {
            "\n\n"
        }))));
    }
    if failures.is_empty() {
        return Ok(Res::Empty);
    }
    // slotAggregateResolution.
    let reasons: Option<Vec<String>> = failures.into_iter().collect();
    Ok(Res::Failed(reasons.map(|reasons| Failure {
        source: slot_source(),
        reason: bounded(format!(
            "Slot source {source} failed to resolve {} contribution(s): {}",
            reasons.len(),
            reasons.join("; ")
        )),
    })))
}

/// `resolveSection`'s content for one section whose predicate matched.
pub(super) fn resolve_section(section: &Section, ctx: &Ctx) -> Result<Res, Fwd> {
    match &section.body {
        Body::File { path, required } => resolve_file(path, *required, ctx),
        Body::Inline(content) => Ok(as_res(Some(interpolate(content, ctx)?))),
        Body::Parts(parts) => {
            let mut included = vec![];
            for (content, when) in parts {
                if matches(when.as_ref(), ctx)? {
                    included.push(interpolate(content, ctx)?);
                }
            }
            Ok(as_res(Some(included.join("\n"))))
        }
        Body::Exec { command, timeout } => Ok(resolve_exec(command, *timeout, ctx)),
        Body::Slot(source) => resolve_slot(source, ctx),
        Body::Probe {
            services,
            header,
            timeout,
        } => resolve_probe(services, header.as_deref(), *timeout, ctx),
    }
}
