//! Task facts (task-prompt-facts.ts) and `interpolateVariables`
//! (template-vars.ts).
use super::{Ctx, OBJECT_PROTOTYPE_KEYS};
use crate::compile::util::{js_space, js_trim, js_trim_end};
use crate::compile::{Fwd, fwd};
use crate::json::J;
use chrono::{DateTime, Utc};

/// `derivePromptTaskFacts`.
pub(super) struct TaskFacts {
    id: String,
    phase: Option<String>,
    role: Option<String>,
    required_evidence: Option<Vec<String>>,
    hints: Option<String>,
}

impl TaskFacts {
    /// Whether the fact a `when.taskField` names is present.
    pub(super) fn has(&self, field: &str) -> bool {
        match field {
            "id" => true,
            "phase" => self.phase.is_some(),
            "role" => self.role.is_some(),
            "requiredEvidence" => self.required_evidence.is_some(),
            _ => self.hints.is_some(),
        }
    }
}

fn non_blank(v: Option<&J>) -> Option<String> {
    match v {
        Some(J::Str(s)) if !js_trim(s).is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// The task context's facts, else a bare `T-<digits>` task id's.
pub(super) fn task_facts(ctx: &Ctx) -> Option<TaskFacts> {
    if let Some(tc) = &ctx.task_context {
        let evidence: Vec<String> = tc
            .get("requiredEvidenceKinds")
            .and_then(J::as_arr)
            .map(|a| {
                a.iter()
                    .filter(|k| non_blank(Some(k)).is_some())
                    .filter_map(J::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        return Some(TaskFacts {
            id: tc
                .get("taskId")
                .and_then(J::as_str)
                .unwrap_or_default()
                .to_owned(),
            phase: non_blank(tc.get("phase")),
            role: non_blank(tc.get("role")),
            required_evidence: (!evidence.is_empty()).then_some(evidence),
            hints: non_blank(tc.get("hintsText")).map(|h| js_trim_end(&h).to_owned()),
        });
    }
    let id = ctx.task_id.as_ref()?;
    let ok = id
        .strip_prefix("T-")
        .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()));
    ok.then(|| TaskFacts {
        id: id.clone(),
        phase: None,
        role: None,
        required_evidence: None,
        hints: None,
    })
}

fn scope_ref(agent: &str, project: &str, task: &str) -> String {
    if agent.is_empty() {
        return String::new();
    }
    let mut r = agent.to_owned();
    if !project.is_empty() {
        r.push('@');
        r.push_str(project);
        if !task.is_empty() {
            r.push(':');
            r.push_str(task);
        }
    }
    r
}

/// The variable table, in lookup order: canonical names, task facts, aliases.
fn variables(ctx: &Ctx, now: DateTime<Utc>) -> Vec<(String, String)> {
    let profile_name = ctx
        .agent_profile
        .as_ref()
        .and_then(|p| p.get("agent"))
        .and_then(|a| a.get("name"))
        .and_then(J::as_str)
        .map(str::to_owned);
    let agent_name = ctx.agent_name.clone().or(profile_name).unwrap_or_default();
    let agent_id = ctx.agent_id.clone().unwrap_or_else(|| agent_name.clone());
    let project_id = ctx.project_id.clone().unwrap_or_default();
    let task_id = ctx.task_id.clone().unwrap_or_default();
    let lane = ctx.lane.clone().unwrap_or_default();
    let base = scope_ref(&agent_id, &project_id, &task_id);
    let handle = if base.is_empty() || lane.is_empty() {
        base.clone()
    } else {
        format!("{base}~{lane}")
    };
    // Agent/project only: the system prompt is shared across task/role seats.
    let agent_project_scope = if agent_id.is_empty() {
        String::new()
    } else if project_id.is_empty() {
        format!("agent:{agent_id}")
    } else {
        format!("agent:{agent_id}:project:{project_id}")
    };
    let canonical = vec![
        ("agentId", agent_id),
        ("agentName", agent_name),
        ("projectId", project_id),
        ("taskId", task_id),
        ("scopeRef", base),
        ("agentProjectScopeRef", agent_project_scope),
        ("handle", handle),
        ("lane", lane),
        ("runMode", ctx.run_mode.clone().unwrap_or_default()),
        ("date", now.format("%Y-%m-%d").to_string()),
        ("dateUtc", now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()),
        ("agentRoot", ctx.agent_root.clone()),
        ("agentsRoot", ctx.agents_root.clone()),
        ("projectRoot", ctx.project_root.clone().unwrap_or_default()),
    ];
    let mut vars: Vec<(String, String)> = canonical
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect();
    let facts = task_facts(ctx);
    let fact = |read: fn(&TaskFacts) -> Option<String>| facts.as_ref().and_then(read);
    for (name, value) in [
        ("task.id", fact(|f| Some(f.id.clone()))),
        ("task.phase", fact(|f| f.phase.clone())),
        ("task.role", fact(|f| f.role.clone())),
        (
            "task.requiredEvidence",
            fact(|f| f.required_evidence.as_ref().map(|e| e.join(", "))),
        ),
        ("task.hints", fact(|f| f.hints.clone())),
    ] {
        vars.push((name.into(), value.unwrap_or_default()));
    }
    let get = |k: &str| {
        canonical
            .iter()
            .find(|(c, _)| *c == k)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    for (alias, target) in [
        ("path.agentRoot", "agentRoot"),
        ("path.agentsRoot", "agentsRoot"),
        ("path.projectRoot", "projectRoot"),
        ("agent_name", "agentName"),
        ("agent_root", "agentRoot"),
        ("agents_root", "agentsRoot"),
        ("project_root", "projectRoot"),
        ("project_id", "projectId"),
        ("run_mode", "runMode"),
    ] {
        vars.push((alias.into(), get(target)));
    }
    vars
}

fn var_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}
fn var_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.'
}

/// `interpolateVariables(content, context)`.
pub fn interpolate(content: &str, ctx: &Ctx) -> Result<String, Fwd> {
    if !content.contains("{{") {
        return Ok(content.to_owned());
    }
    // An inspection pins its clock; one without a valid nowIso refuses.
    let now = match &ctx.pinned {
        Some(p) => p
            .context
            .get("nowIso")
            .and_then(J::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
            .ok_or_else(|| fwd(crate::reason!("prompt_section_failed")))?,
        None => Utc::now(),
    };
    let vars = variables(ctx, now);
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(at) = rest.find("{{") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        // /\{\{\s*([a-zA-Z_][a-zA-Z_0-9.]*)\s*\}\}/
        let ws = after.len() - after.trim_start_matches(js_space).len();
        let name_part = &after[ws..];
        let name_len = match name_part.chars().next() {
            Some(c) if var_start(c) => name_part
                .find(|c: char| !var_char(c))
                .unwrap_or(name_part.len()),
            _ => 0,
        };
        let tail = &name_part[name_len..];
        let ws2 = tail.len() - tail.trim_start_matches(js_space).len();
        if name_len > 0 && tail[ws2..].starts_with("}}") {
            let name = &name_part[..name_len];
            let matched_len = 2 + ws + name_len + ws2 + 2;
            if let Some(key) = name.strip_prefix("env.") {
                out.push_str(&ctx.env_var(key).unwrap_or_default());
            } else if let Some((_, v)) = vars.iter().find(|(k, _)| k == name) {
                out.push_str(v);
            } else if OBJECT_PROTOTYPE_KEYS.contains(&name) {
                return Err(fwd(crate::reason!("template_prototype_variable")));
            } else {
                out.push_str(&rest[at..at + matched_len]);
            }
            rest = &rest[at + matched_len..];
        } else {
            out.push_str("{{");
            rest = after;
        }
    }
    out.push_str(rest);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::super::test_ctx;
    use super::*;

    #[test]
    fn interpolates_like_template_vars() {
        let c = test_ctx();
        assert_eq!(
            interpolate("{{agentId}} {{ project_id }} {{task.id}} {{env.X}} {{env.Y}} {{nope}} {{ handle }} {{agentName}}", &c).unwrap(),
            "clod proj T-1 1  {{nope}} clod@proj:T-1~main "
        );
        assert_eq!(interpolate("{{ {{agentId}}", &c).unwrap(), "{{ clod");
        assert!(interpolate("{{toString}}", &c).is_err());
    }
}
