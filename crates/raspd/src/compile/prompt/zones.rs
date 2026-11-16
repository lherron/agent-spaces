//! `resolveContextTemplateDetailed` (context-resolver.ts): each zone's sections
//! in order through predicate, content, wrap and truncation, the task-scoped
//! split, `max_chars`, and the section reports an inspection projects.
use super::Ctx;
use super::refs::template_ref;
use super::sections::{Failure, Res, resolve_section};
use super::template::{Body, Section, Template};
use super::vars::interpolate;
use super::when::matches;
use crate::compile::util::{utf16_at, utf16_len, utf16_slice};
use crate::compile::{Fwd, fwd, fwd_at};
use crate::json::J;

const SECTION_SEPARATOR: &str = "\n\n---\n\n";

/// `truncateSectionContent(content, maxChars)` in UTF-16 units.
fn truncate(content: &str, max: Option<usize>) -> String {
    const MARKER: &str = "[truncated]";
    let Some(max) = max else {
        return content.to_owned();
    };
    if utf16_len(content) <= max {
        return content.to_owned();
    }
    if max <= MARKER.len() {
        return MARKER[..max].to_owned();
    }
    if max == MARKER.len() + 1 {
        return MARKER.to_owned();
    }
    let keep = max - MARKER.len();
    let end = if utf16_at(content, keep) == Some(u16::from(b'\n')) {
        keep + 1
    } else {
        keep
    };
    // A cut between a surrogate pair leaves a lone high surrogate, as in Bun:
    // JSON carries it escaped, a file write or content hash as U+FFFD.
    let kept = utf16_slice(content, 0, end).unwrap_or_default();
    format!("{kept}{MARKER}")
}

pub struct Resolved {
    pub prompt: Option<String>,
    pub append: bool,
    /// The reminder zone's content (`inspected.reminder.content`).
    pub reminder: Option<String>,
    /// The task-invariant vs task-scoped split, when a section gated by
    /// `when.taskField` rendered (T-09860).
    pub task_scoped: Option<TaskScoped>,
}

/// `ResolvedTaskScopedSplit`: each zone joined without its task-scoped
/// sections, and the task-scoped sections joined.
pub struct TaskScoped {
    pub content: String,
    pub prompt: Option<String>,
    pub reminder: Option<String>,
}

/// What an inspection reads beside the resolved content
/// (`inspectAgentSystemPrompt`'s sections and diagnostics).
pub struct Inspected {
    pub reports: Vec<SectionReport>,
    pub prompt_sizes: Vec<String>,
    pub reminder_sizes: Vec<String>,
    pub prompt_chars: usize,
    pub reminder_chars: usize,
    pub max_chars: Option<usize>,
    pub near_max_chars: bool,
}

/// `ResolvedContextSection`, the fields an inspection projects.
pub struct SectionReport {
    pub zone: &'static str,
    pub name: String,
    pub kind: &'static str,
    /// `describeSectionSource`.
    pub source: String,
    pub order: usize,
    /// `effective`, or `skipped` with `predicate` or `empty`.
    pub skipped: Option<&'static str>,
    /// `failed`, with Bun's source and reason (then `skipped` is unused).
    pub failed: Option<Failure>,
    pub content: Option<String>,
}

/// One resolved zone: its content and size, the content without task-scoped
/// sections, the task-scoped sections, and (when inspecting) each section's
/// report and size label.
struct Zone {
    content: Option<String>,
    chars: usize,
    invariant: Option<String>,
    task_scoped: Vec<String>,
    reports: Vec<SectionReport>,
    sizes: Vec<String>,
}

impl Section {
    fn kind(&self) -> &'static str {
        match &self.body {
            Body::File { .. } => "file",
            Body::Inline(_) | Body::Parts(_) => "inline",
            Body::Exec { .. } => "exec",
            Body::Slot(_) => "slot",
            Body::Probe { .. } => "service-probe",
        }
    }

    /// `describeSectionSource(section, context)`.
    fn source(&self, ctx: &Ctx) -> Result<String, Fwd> {
        Ok(match &self.body {
            Body::Inline(_) | Body::Parts(_) => "inline content".into(),
            Body::Exec { command, .. } => format!("exec: {command}"),
            Body::Slot(source) => format!("slot: {source}"),
            Body::Probe { services, .. } => format!(
                "service-probe: {}",
                services
                    .iter()
                    .map(|(n, _)| n.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Body::File { path, .. } => match template_ref(path, ctx) {
                Ok(file) => format!("{path} -> {file}"),
                Err(Some(f)) => return Err(f),
                Err(None) => format!("file: {path}"),
            },
        })
    }
}

fn resolve_zone(
    sections: &[Section],
    ctx: &Ctx,
    zone: &'static str,
    inspect: bool,
) -> Result<Zone, Fwd> {
    let mut included = vec![];
    let mut invariant = vec![];
    let mut task_scoped = vec![];
    let mut reports = vec![];
    let mut sizes = vec![];
    for (order, section) in sections.iter().enumerate() {
        let mut report = if inspect {
            Some(SectionReport {
                zone,
                name: section.name.clone(),
                kind: section.kind(),
                source: section.source(ctx)?,
                order,
                skipped: Some("empty"),
                failed: None,
                content: None,
            })
        } else {
            None
        };
        let outcome = if !matches(section.when.as_ref(), ctx)? {
            Err("predicate")
        } else {
            match resolve_section(section, ctx)? {
                Res::Content(content) => Ok(content),
                Res::Empty => Err("empty"),
                Res::Failed(Some(failure)) if inspect => {
                    if let Some(mut r) = report.take() {
                        r.failed = Some(failure);
                        reports.push(r);
                    }
                    continue;
                }
                // A failure raspd cannot word as Bun does.
                Res::Failed(None) if inspect => {
                    return Err(fwd_at(
                        crate::reason!("prompt_section_failed"),
                        format!("{zone}.{}", section.name),
                    ));
                }
                Res::Failed(_) => Err("failed"),
            }
        };
        let content = match outcome {
            Ok(content) => content,
            Err(reason) => {
                if let Some(mut r) = report.take() {
                    r.skipped = Some(reason);
                    reports.push(r);
                }
                continue;
            }
        };
        let wrapped = match &section.wrap {
            Some((prefix, suffix)) => {
                let p = interpolate(prefix.as_deref().unwrap_or(""), ctx)?;
                let s = interpolate(suffix.as_deref().unwrap_or(""), ctx)?;
                if p.is_empty() && s.is_empty() {
                    content
                } else {
                    format!("{p}{content}{s}")
                }
            }
            None => content,
        };
        let truncated = truncate(&wrapped, section.max_chars);
        if truncated.is_empty() {
            reports.extend(report);
            continue;
        }
        if section
            .when
            .as_ref()
            .is_some_and(|w| w.task_field.is_some())
        {
            task_scoped.push(truncated.clone());
        } else {
            invariant.push(truncated.clone());
        }
        if let Some(mut r) = report {
            sizes.push(format!("{zone}.{}={}", section.name, utf16_len(&truncated)));
            r.skipped = None;
            r.content = Some(truncated.clone());
            reports.push(r);
        }
        included.push(truncated);
    }
    let invariant = (!invariant.is_empty()).then(|| invariant.join(SECTION_SEPARATOR));
    let content = (!included.is_empty()).then(|| included.join(SECTION_SEPARATOR));
    let chars = content.as_deref().map_or(0, utf16_len);
    Ok(Zone {
        content,
        chars,
        invariant,
        task_scoped,
        reports,
        sizes,
    })
}

/// `resolveContextTemplateDetailed(template, context)`, the parts a compile uses.
pub fn resolve_template(template: &Template, ctx: &Ctx) -> Result<Resolved, Fwd> {
    resolve_detailed(template, ctx, false).map(|(resolved, _)| resolved)
}

/// `resolveContextTemplateDetailed` with its section reports.
pub fn resolve_inspected(template: &Template, ctx: &Ctx) -> Result<(Resolved, Inspected), Fwd> {
    resolve_detailed(template, ctx, true)
}

fn resolve_detailed(
    template: &Template,
    ctx: &Ctx,
    inspect: bool,
) -> Result<(Resolved, Inspected), Fwd> {
    if let Some(p) = &ctx.pinned {
        // Duplicate replay entries are invalid even when no service section consumes them.
        let mut keys = std::collections::HashSet::new();
        for r in p.probe_responses()? {
            let key = (
                r.get("name").and_then(J::as_str),
                r.get("endpoint").and_then(J::as_str),
            );
            if !keys.insert(key) {
                return Err(fwd(crate::reason!("prompt_section_failed")));
            }
        }
    }
    let prompt = resolve_zone(&template.prompt, ctx, "prompt", inspect)?;
    let reminder = resolve_zone(&template.reminder, ctx, "reminder", inspect)?;
    // Every replayed response must have been consumed.
    if let Some(p) = &ctx.pinned
        && p.used.borrow().len() != p.probe_responses()?.len()
    {
        return Err(fwd(crate::reason!("prompt_section_failed")));
    }
    let total = prompt.chars + reminder.chars;
    if let Some(max) = template.max_chars
        && total > max
    {
        return Err(fwd(crate::reason!("context_template_max_chars")));
    }
    let scoped: Vec<String> = prompt
        .task_scoped
        .iter()
        .chain(&reminder.task_scoped)
        .cloned()
        .collect();
    let task_scoped = (!scoped.is_empty()).then(|| TaskScoped {
        content: scoped.join(SECTION_SEPARATOR),
        prompt: prompt.invariant,
        reminder: reminder.invariant,
    });
    let inspected = Inspected {
        reports: prompt.reports.into_iter().chain(reminder.reports).collect(),
        prompt_sizes: prompt.sizes,
        reminder_sizes: reminder.sizes,
        prompt_chars: prompt.chars,
        reminder_chars: reminder.chars,
        max_chars: template.max_chars,
        // MAX_CHARS_WARNING_RATIO
        near_max_chars: template
            .max_chars
            .is_some_and(|max| max > 0 && total as f64 / max as f64 >= 0.9),
    };
    Ok((
        Resolved {
            prompt: prompt.content,
            append: template.append,
            reminder: reminder.content,
            task_scoped,
        },
        inspected,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_in_utf16_units() {
        assert_eq!(truncate("abcdefghijklmnop", Some(14)), "abc[truncated]");
        assert_eq!(truncate("abc\ndefghijklmnop", Some(14)), "abc\n[truncated]");
        assert_eq!(truncate("abcdefghijklmnop", Some(5)), "[trun");
    }
}
