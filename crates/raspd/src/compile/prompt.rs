//! The system prompt (core/runtime/src): template discovery and the built-in
//! default (system-prompt.ts), `parseContextTemplate` (context-template.ts),
//! zone/section resolution (context-resolver.ts, section-resolution.ts,
//! when-predicate.ts), interpolation (template-vars.ts, task-prompt-facts.ts),
//! file refs (template-ref.ts, resolver/root-relative-refs.ts) and service
//! probes (service-probe*.ts).
//!
//! Exec sections and service probes run for real, with Bun's command, cwd,
//! environment, timeout and failure handling. A template or input raspd will
//! not judge is a `Forward`; resolution happens before any write.
use super::util::{js_space, js_trim, js_trim_end, utf16_at, utf16_len, utf16_slice};
use super::{Fwd, fwd};
use crate::json::J;
use crate::reads::jspath::{dirname, is_absolute, join, normalize, relative, resolve};
use crate::reads::toml::{self, TomlError};
use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub type EnvMap = BTreeMap<String, String>;

/// `ContextResolverContext`, as a compile builds it.
#[derive(Clone)]
pub struct Ctx {
    pub agent_root: String,
    pub agents_root: String,
    pub search_path: Vec<String>,
    pub project_root: Option<String>,
    pub project_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub task_id: Option<String>,
    pub task_context: Option<J>,
    pub lane: Option<String>,
    pub run_mode: String,
    pub agent_profile: Option<J>,
    /// `context.env` (`undefined` reads `process.env`).
    pub env: Option<EnvMap>,
    pub exec_env: Option<EnvMap>,
}

const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

fn process_env(key: &str) -> Option<String> {
    crate::reads::Env::process().get(key).map(str::to_owned)
}

// -- task facts and variables ------------------------------------------------

fn non_blank(v: Option<&J>) -> Option<String> {
    match v {
        Some(J::Str(s)) if !js_trim(s).is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// `derivePromptTaskFacts`: `(id, phase, role, requiredEvidence, hints)`.
type Facts = (
    String,
    Option<String>,
    Option<String>,
    Option<Vec<String>>,
    Option<String>,
);

fn task_facts(ctx: &Ctx) -> Option<Facts> {
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
        return Some((
            tc.get("taskId")
                .and_then(J::as_str)
                .unwrap_or_default()
                .to_owned(),
            non_blank(tc.get("phase")),
            non_blank(tc.get("role")),
            (!evidence.is_empty()).then_some(evidence),
            non_blank(tc.get("hintsText")).map(|h| js_trim_end(&h).to_owned()),
        ));
    }
    let id = ctx.task_id.as_ref()?;
    let ok = id
        .strip_prefix("T-")
        .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()));
    ok.then(|| (id.clone(), None, None, None, None))
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

fn variables(ctx: &Ctx) -> Vec<(String, String)> {
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
    let now = chrono::Utc::now();
    let canonical = vec![
        ("agentId", agent_id),
        ("agentName", agent_name),
        ("projectId", project_id),
        ("taskId", task_id),
        ("scopeRef", base),
        ("handle", handle),
        ("lane", lane),
        ("runMode", ctx.run_mode.clone()),
        ("date", now.format("%Y-%m-%d").to_string()),
        ("dateUtc", now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()),
        ("agentRoot", ctx.agent_root.clone()),
        ("agentsRoot", ctx.agents_root.clone()),
        ("projectRoot", ctx.project_root.clone().unwrap_or_default()),
    ];
    let facts = task_facts(ctx);
    let mut vars: Vec<(String, String)> = canonical
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect();
    let f = facts.as_ref();
    vars.push(("task.id".into(), f.map(|f| f.0.clone()).unwrap_or_default()));
    vars.push((
        "task.phase".into(),
        f.and_then(|f| f.1.clone()).unwrap_or_default(),
    ));
    vars.push((
        "task.role".into(),
        f.and_then(|f| f.2.clone()).unwrap_or_default(),
    ));
    vars.push((
        "task.requiredEvidence".into(),
        f.and_then(|f| f.3.as_ref().map(|e| e.join(", ")))
            .unwrap_or_default(),
    ));
    vars.push((
        "task.hints".into(),
        f.and_then(|f| f.4.clone()).unwrap_or_default(),
    ));
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
    let vars = variables(ctx);
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
                let value = match &ctx.env {
                    Some(env) => env.get(key).cloned(),
                    None => process_env(key),
                };
                out.push_str(&value.unwrap_or_default());
            } else if let Some((_, v)) = vars.iter().find(|(k, _)| k == name) {
                out.push_str(v);
            } else if OBJECT_PROTOTYPE_KEYS.contains(&name) {
                return Err(fwd("template_prototype_variable"));
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

// -- root-relative refs ------------------------------------------------------

fn realpath(p: &str) -> Result<String, Fwd> {
    std::fs::canonicalize(p)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| fwd("realpath_failed"))
}

/// `resolveContainedPath(root, relativePath)`; `Err(None)` is a thrown error.
fn contained(root: &str, rel_path: &str) -> Result<String, Option<Fwd>> {
    if is_absolute(rel_path) {
        return Err(None);
    }
    let normalized = normalize(rel_path);
    if normalized.starts_with("..") || normalized.contains("/..") || normalized.contains("\\..") {
        return Err(None);
    }
    let candidate = join(&[root, &normalized]);
    let rel = relative(root, &candidate);
    if rel.starts_with("..") || is_absolute(&rel) {
        return Err(None);
    }
    if std::path::Path::new(&candidate).exists() {
        let real_root = realpath(root).map_err(Some)?;
        let real_candidate = realpath(&candidate).map_err(Some)?;
        let real_rel = relative(&real_root, &real_candidate);
        if real_rel.starts_with("..") || is_absolute(&real_rel) {
            return Err(None);
        }
    }
    Ok(candidate)
}

/// `resolveTemplateRef(ref, context)`; `Err(None)` is a thrown error.
fn template_ref(r: &str, ctx: &Ctx) -> Result<String, Option<Fwd>> {
    for (scheme, root) in [
        ("agent-root:///", Some(&ctx.agent_root)),
        ("project-root:///", ctx.project_root.as_ref()),
    ] {
        if let Some(rest) = r.strip_prefix(scheme) {
            if rest.is_empty() || rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
                return Err(None);
            }
            let Some(root) = root else { return Err(None) };
            if !is_absolute(root) {
                return Err(None);
            }
            return contained(root, rest);
        }
    }
    if let Some(rest) = r.strip_prefix("agents-root:///") {
        if rest.is_empty() || rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
            return Err(None);
        }
        let roots: Vec<&String> = if ctx.search_path.is_empty() {
            vec![&ctx.agents_root]
        } else {
            ctx.search_path.iter().collect()
        };
        for root in &roots {
            if !is_absolute(root) {
                return Err(None);
            }
            let candidate = contained(root, rest)?;
            if std::path::Path::new(&candidate).exists() {
                return Ok(candidate);
            }
        }
        return contained(roots[0], rest);
    }
    let interpolated = interpolate(r, ctx).map_err(Some)?;
    if interpolated != r && is_absolute(&interpolated) {
        return Ok(interpolated);
    }
    let roots: Vec<&String> = if ctx.search_path.is_empty() {
        vec![&ctx.agents_root]
    } else {
        ctx.search_path.iter().collect()
    };
    for root in &roots {
        let candidate = join(&[root, &interpolated]);
        if std::path::Path::new(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Ok(join(&[roots[0], &interpolated]))
}

/// `resolveRootRelativeRef(ref, { agentRoot, projectRoot })`, `None` where it throws.
pub fn root_relative(r: &str, ctx: &Ctx) -> Option<String> {
    if !(r.starts_with("agent-root:///") || r.starts_with("project-root:///")) {
        return None;
    }
    template_ref(r, ctx).ok()
}

/// `readFileOrUndefined`: `Ok(None)` when missing; `Err(())` for other errors.
fn read_optional(path: &str) -> Result<Option<String>, ()> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

// -- the template ------------------------------------------------------------

#[derive(Clone)]
pub struct When {
    run_mode: Option<String>,
    exists: Option<String>,
    env_set: Option<String>,
    env_equals: Option<(String, String)>,
    env_not_equals: Option<(String, String)>,
    task_field: Option<String>,
}

#[derive(Clone)]
pub enum Body {
    File {
        path: String,
        required: bool,
    },
    Inline(String),
    Parts(Vec<(String, Option<When>)>),
    Exec {
        command: String,
        timeout: Option<f64>,
    },
    Slot(String),
    Probe {
        services: Vec<(String, String)>,
        header: Option<String>,
        timeout: Option<f64>,
    },
}

#[derive(Clone)]
pub struct Section {
    when: Option<When>,
    max_chars: Option<usize>,
    wrap: Option<(Option<String>, Option<String>)>,
    body: Body,
}

pub struct Template {
    pub append: bool,
    pub max_chars: Option<usize>,
    pub prompt: Vec<Section>,
    pub reminder: Vec<Section>,
}

fn bad<T>() -> Result<T, Fwd> {
    // A template Bun would reject: its message is not reproduced.
    Err(fwd("context_template_invalid"))
}

fn req_str(v: Option<&J>) -> Result<String, Fwd> {
    match v {
        Some(J::Str(s)) if !s.is_empty() => Ok(s.clone()),
        _ => bad(),
    }
}
fn opt_str(v: Option<&J>) -> Result<Option<String>, Fwd> {
    match v {
        None => Ok(None),
        Some(J::Str(s)) => Ok(Some(s.clone())),
        _ => bad(),
    }
}
fn opt_num(v: Option<&J>) -> Result<Option<f64>, Fwd> {
    match v {
        None => Ok(None),
        Some(J::Num(n)) if n.is_finite() => Ok(Some(*n)),
        _ => bad(),
    }
}
fn opt_pos_int(v: Option<&J>) -> Result<Option<usize>, Fwd> {
    match v {
        None => Ok(None),
        Some(J::Num(n)) if n.fract() == 0.0 && *n > 0.0 && *n < 9.0e15 => Ok(Some(*n as usize)),
        _ => bad(),
    }
}

fn parse_when(v: Option<&J>) -> Result<Option<When>, Fwd> {
    let Some(v) = v else { return Ok(None) };
    if !v.is_record() {
        return bad();
    }
    let allowed = [
        "runMode",
        "exists",
        "envSet",
        "envEquals",
        "envNotEquals",
        "taskField",
    ];
    if v.js_entries().iter().any(|(k, _)| !allowed.contains(k)) {
        return bad();
    }
    let pair = |x: Option<&J>| -> Result<Option<(String, String)>, Fwd> {
        let Some(x) = x else { return Ok(None) };
        if !x.is_record()
            || x.js_entries()
                .iter()
                .any(|(k, _)| *k != "name" && *k != "value")
        {
            return bad();
        }
        let name = req_str(x.get("name"))?;
        let Some(J::Str(value)) = x.get("value") else {
            return bad();
        };
        Ok(Some((name, value.clone())))
    };
    let task_field = match v.get("taskField") {
        None => None,
        Some(J::Str(s))
            if ["id", "phase", "role", "requiredEvidence", "hints"].contains(&s.as_str()) =>
        {
            Some(s.clone())
        }
        _ => return bad(),
    };
    let when = When {
        run_mode: opt_str(v.get("runMode"))?,
        exists: opt_str(v.get("exists"))?,
        env_set: opt_str(v.get("envSet"))?,
        env_equals: pair(v.get("envEquals"))?,
        env_not_equals: pair(v.get("envNotEquals"))?,
        task_field,
    };
    if when.env_set.as_deref() == Some("") {
        return bad();
    }
    Ok(Some(when))
}

fn parse_section(v: &J) -> Result<Section, Fwd> {
    if !v.is_record() {
        return bad();
    }
    req_str(v.get("name"))?;
    let kind = match v.get("type") {
        Some(J::Str(s))
            if ["file", "inline", "exec", "slot", "service-probe"].contains(&s.as_str()) =>
        {
            s.clone()
        }
        _ => return bad(),
    };
    let when = parse_when(v.get("when"))?;
    let max_chars = opt_pos_int(v.get("max_chars"))?;
    let wrap = match v.get("wrap") {
        None => None,
        Some(w) if w.is_record() => {
            if w.js_entries()
                .iter()
                .any(|(k, _)| *k != "prefix" && *k != "suffix")
            {
                return bad();
            }
            Some((opt_str(w.get("prefix"))?, opt_str(w.get("suffix"))?))
        }
        Some(_) => return bad(),
    };
    let body = match kind.as_str() {
        "file" => Body::File {
            path: req_str(v.get("path"))?,
            required: match v.get("required") {
                None => false,
                Some(J::Bool(b)) => *b,
                Some(_) => return bad(),
            },
        },
        "inline" => match v.get("parts") {
            None => Body::Inline(req_str(v.get("content"))?),
            Some(_) if v.get("content").is_some() => return bad(),
            Some(J::Arr(parts)) if !parts.is_empty() => Body::Parts(
                parts
                    .iter()
                    .map(|p| {
                        if !p.is_record()
                            || p.js_entries()
                                .iter()
                                .any(|(k, _)| *k != "content" && *k != "when")
                        {
                            return bad();
                        }
                        Ok((req_str(p.get("content"))?, parse_when(p.get("when"))?))
                    })
                    .collect::<Result<_, _>>()?,
            ),
            Some(_) => return bad(),
        },
        "exec" => Body::Exec {
            command: req_str(v.get("command"))?,
            timeout: opt_num(v.get("timeout"))?,
        },
        "slot" => Body::Slot(req_str(v.get("source"))?),
        _ => {
            let Some(J::Arr(list)) = v.get("services") else {
                return bad();
            };
            let services = list
                .iter()
                .map(|s| {
                    if !s.is_record() {
                        return bad();
                    }
                    Ok((req_str(s.get("name"))?, req_str(s.get("endpoint"))?))
                })
                .collect::<Result<_, _>>()?;
            Body::Probe {
                services,
                header: opt_str(v.get("header"))?,
                timeout: opt_num(v.get("timeout"))?,
            }
        }
    };
    Ok(Section {
        when,
        max_chars,
        wrap,
        body,
    })
}

/// `parseContextTemplate(toml)`.
pub fn parse_template(content: &str) -> Result<Template, Fwd> {
    let parsed = match toml::parse(content) {
        Ok(v) => v,
        Err(TomlError::Unsupported(reason)) => return Err(fwd(reason)),
        Err(_) => return bad(),
    };
    if parsed.get("schema_version") != Some(&J::Num(2.0)) {
        return bad();
    }
    let append = match parsed.get("mode") {
        None => false,
        Some(J::Str(m)) if m == "replace" => false,
        Some(J::Str(m)) if m == "append" => true,
        _ => return bad(),
    };
    let max_chars = opt_pos_int(parsed.get("max_chars"))?;
    if parsed.get("section").is_some() {
        return bad();
    }
    let sections = |k: &str| -> Result<Vec<Section>, Fwd> {
        match parsed.get(k) {
            None => Ok(vec![]),
            Some(J::Arr(items)) => items.iter().map(parse_section).collect(),
            Some(_) => bad(),
        }
    };
    Ok(Template {
        append,
        max_chars,
        prompt: sections("prompt")?,
        reminder: sections("reminder")?,
    })
}

/// `buildDefaultTemplate(base, scaffoldPackets)` (no scaffold packets).
pub fn default_template(base: &[String]) -> Template {
    let file = |_name: String, path: &str, when: Option<When>| Section {
        when,
        max_chars: None,
        wrap: None,
        body: Body::File {
            path: path.to_owned(),
            required: false,
        },
    };
    let mut prompt = vec![file("soul".into(), "agent-root:///SOUL.md", None)];
    for (i, r) in base.iter().enumerate() {
        prompt.push(file(format!("additional-base-{i}"), r, None));
    }
    prompt.push(file(
        "heartbeat".into(),
        "agent-root:///HEARTBEAT.md",
        Some(When {
            run_mode: Some("heartbeat".into()),
            exists: None,
            env_set: None,
            env_equals: None,
            env_not_equals: None,
            task_field: None,
        }),
    ));
    Template {
        append: false,
        max_chars: None,
        prompt,
        reminder: vec![],
    }
}

// -- resolution --------------------------------------------------------------

fn env_lookup(ctx: &Ctx, key: &str) -> Option<String> {
    match &ctx.env {
        Some(env) => env.get(key).cloned(),
        None => process_env(key),
    }
}

/// `matchesWhenPredicate`.
fn matches(when: Option<&When>, ctx: &Ctx) -> bool {
    let Some(w) = when else { return true };
    if w.run_mode.as_ref().is_some_and(|m| *m != ctx.run_mode) {
        return false;
    }
    if let Some(e) = &w.exists {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".into());
        if !std::path::Path::new(&join(&[&cwd, e])).exists() {
            return false;
        }
    }
    if let Some(field) = &w.task_field {
        let Some(f) = task_facts(ctx) else {
            return false;
        };
        let present = match field.as_str() {
            "id" => true,
            "phase" => f.1.is_some(),
            "role" => f.2.is_some(),
            "requiredEvidence" => f.3.is_some(),
            _ => f.4.is_some(),
        };
        if !present {
            return false;
        }
    }
    if let Some(k) = &w.env_set
        && env_lookup(ctx, k).is_none_or(|v| js_trim(&v).is_empty())
    {
        return false;
    }
    if let Some((k, v)) = &w.env_equals
        && env_lookup(ctx, k).as_deref() != Some(v.as_str())
    {
        return false;
    }
    if let Some((k, v)) = &w.env_not_equals
        && env_lookup(ctx, k).as_deref() == Some(v.as_str())
    {
        return false;
    }
    true
}

enum Res {
    Content(String),
    Empty,
    Failed,
}

fn as_res(content: Option<String>) -> Res {
    match content {
        Some(c) if !c.is_empty() => Res::Content(c),
        _ => Res::Empty,
    }
}

/// `execFile('bash', ['-c', command], { cwd, env, timeout, maxBuffer: 1 MiB })`:
/// the trimmed stdout on exit 0, `None` on any failure.
fn run_exec(command: &str, timeout_ms: f64, ctx: &Ctx) -> Option<String> {
    const MAX_BUFFER: usize = 1024 * 1024;
    let mut cmd = Command::new("bash");
    cmd.arg("-c").arg(command).current_dir(&ctx.agent_root);
    if let Some(env) = &ctx.exec_env {
        cmd.env_clear().envs(env);
    }
    // Node leaves the child's stdin pipe open and unwritten.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let out_reader = std::thread::spawn(move || {
        let mut buf = vec![];
        let _ = (&mut stdout)
            .take(MAX_BUFFER as u64 + 1)
            .read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = vec![];
        let _ = (&mut stderr)
            .take(MAX_BUFFER as u64 + 1)
            .read_to_end(&mut buf);
        buf.len()
    });
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(0.0) as u64);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline && timeout_ms > 0.0 => {
                // SIGTERM, as Node's timeout kill does.
                unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(2)),
            Err(_) => break None,
        }
    };
    drop(stdin);
    let out = out_reader.join().ok()?;
    let err_len = err_reader.join().ok()?;
    let status = status?;
    if !status.success() || out.len() > MAX_BUFFER || err_len > MAX_BUFFER {
        return None;
    }
    Some(js_trim(&String::from_utf8_lossy(&out)).to_owned())
}

fn resolve_exec(command: &str, timeout: Option<f64>, ctx: &Ctx) -> Res {
    match run_exec(command, timeout.unwrap_or(5000.0), ctx) {
        Some(out) => as_res(Some(out)),
        None => Res::Failed,
    }
}

fn resolve_file(path: &str, required: bool, ctx: &Ctx) -> Result<Res, Fwd> {
    let file = match template_ref(path, ctx) {
        Ok(f) => f,
        Err(Some(f)) => return Err(f),
        Err(None) if required => return Err(fwd("required_context_file_unresolvable")),
        Err(None) => return Ok(Res::Failed),
    };
    let content = match read_optional(&file) {
        Ok(c) => c,
        Err(()) if required => return Err(fwd("required_context_file_unreadable")),
        Err(()) => return Ok(Res::Failed),
    };
    match content {
        Some(c) if !c.is_empty() => Ok(as_res(Some(interpolate(&c, ctx)?))),
        _ if required => Err(fwd("required_context_file_missing")),
        _ => Ok(Res::Empty),
    }
}

fn resolve_slot(source: &str, ctx: &Ctx) -> Result<Res, Fwd> {
    let segments: Vec<&str> = source.split('.').filter(|s| !s.is_empty()).collect();
    if segments.iter().any(|s| OBJECT_PROTOTYPE_KEYS.contains(s)) {
        return Err(fwd("slot_prototype_source"));
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
    let entries: Vec<String> = match value {
        J::Str(s) if s.is_empty() => vec![],
        J::Str(s) => vec![s.clone()],
        J::Arr(items) if items.iter().all(|i| matches!(i, J::Str(_))) => items
            .iter()
            .filter_map(J::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => return Ok(Res::Failed),
    };
    if entries.is_empty() {
        return Ok(Res::Empty);
    }
    let mut contents: Vec<Option<String>> = vec![];
    let mut failures = 0;
    let exec = source.ends_with("Exec");
    for entry in &entries {
        let res = if exec {
            resolve_exec(entry, None, ctx)
        } else {
            match template_ref(entry, ctx) {
                Ok(file) => match read_optional(&file) {
                    Ok(Some(c)) => as_res(Some(interpolate(&c, ctx)?)),
                    Ok(None) => Res::Empty,
                    Err(()) => Res::Failed,
                },
                Err(Some(f)) => return Err(f),
                Err(None) => Res::Failed,
            }
        };
        match res {
            Res::Content(c) => contents.push(Some(c)),
            Res::Empty => contents.push(None),
            Res::Failed => {
                failures += 1;
                contents.push(None);
            }
        }
    }
    let joined: Vec<String> = contents
        .into_iter()
        .flatten()
        .filter(|c| !c.is_empty())
        .collect();
    if !joined.is_empty() {
        return Ok(as_res(Some(joined.join(if exec { "\n" } else { "\n\n" }))));
    }
    Ok(if failures > 0 {
        Res::Failed
    } else {
        Res::Empty
    })
}

enum Endpoint {
    Unix(String),
    Tcp(String, u16),
}

/// `parseServiceEndpoint` for the forms raspd judges; `Err` forwards.
fn parse_endpoint(endpoint: &str) -> Result<Option<Endpoint>, Fwd> {
    if let Some(p) = endpoint.strip_prefix("unix://") {
        return Ok(Some(Endpoint::Unix(p.to_owned())));
    }
    if endpoint.starts_with('/') {
        return Ok(Some(Endpoint::Unix(endpoint.to_owned())));
    }
    let Some((scheme, rest)) = endpoint.split_once("://") else {
        return Err(fwd("service_probe_endpoint"));
    };
    let scheme = scheme.to_ascii_lowercase();
    if !["tcp", "http", "https", "ws", "wss"].contains(&scheme.as_str()) {
        return Err(fwd("service_probe_endpoint"));
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains(['@', '[', ']', ' ', '%', '\\']) {
        return Err(fwd("service_probe_endpoint"));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() => (
            h,
            Some(
                p.parse::<u16>()
                    .map_err(|_| fwd("service_probe_endpoint"))?,
            ),
        ),
        Some((h, _)) => (h, None),
        None => (authority, None),
    };
    if host.is_empty()
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err(fwd("service_probe_endpoint"));
    }
    let secure = scheme == "https" || scheme == "wss";
    let default = if secure { 443 } else { 80 };
    // URL drops a default port, and `url.port ? Number(url.port) : default`.
    let port = match port {
        Some(p) if (scheme == "http" || scheme == "ws") && p == 80 => 80,
        Some(p) if secure && p == 443 => 443,
        Some(p) => p,
        None => default,
    };
    Ok(Some(Endpoint::Tcp(host.to_ascii_lowercase(), port)))
}

/// `probeServiceEndpoint(endpoint, timeoutMs)`: up when a connection is made
/// before the timer fires. Node's connect never blocks the caller and its timer
/// covers DNS too, so the attempt runs on its own thread and the timer decides.
fn probe(endpoint: &Endpoint, timeout_ms: f64) -> bool {
    let timeout = Duration::from_millis(timeout_ms.max(0.0) as u64);
    let (tx, rx) = std::sync::mpsc::channel();
    let target = match endpoint {
        Endpoint::Unix(path) => Endpoint::Unix(path.clone()),
        Endpoint::Tcp(host, port) => Endpoint::Tcp(host.clone(), *port),
    };
    std::thread::spawn(move || {
        let up = match &target {
            Endpoint::Unix(path) => std::os::unix::net::UnixStream::connect(path).is_ok(),
            Endpoint::Tcp(host, port) => {
                use std::net::ToSocketAddrs;
                (host.as_str(), *port)
                    .to_socket_addrs()
                    .map(|mut addrs| addrs.any(|a| std::net::TcpStream::connect(a).is_ok()))
                    .unwrap_or(false)
            }
        };
        let _ = tx.send(up);
    });
    rx.recv_timeout(timeout).unwrap_or(false)
}

fn resolve_probe(
    services: &[(String, String)],
    header: Option<&str>,
    timeout: Option<f64>,
    ctx: &Ctx,
) -> Result<Res, Fwd> {
    if services.is_empty() {
        return Ok(Res::Empty);
    }
    let mut specs = vec![];
    for (name, endpoint) in services {
        specs.push((name.clone(), interpolate(endpoint, ctx)?));
    }
    let mut parsed = vec![];
    for (_, endpoint) in &specs {
        match parse_endpoint(endpoint)? {
            Some(e) => parsed.push(e),
            // Unsupported endpoint: the section fails.
            None => return Ok(Res::Failed),
        }
    }
    let timeout = timeout.unwrap_or(250.0);
    let ups: Vec<bool> = std::thread::scope(|s| {
        let handles: Vec<_> = parsed
            .iter()
            .map(|e| s.spawn(move || probe(e, timeout)))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or(false))
            .collect()
    });
    let width = specs.iter().map(|(n, _)| utf16_len(n)).max().unwrap_or(0);
    let mut lines = vec![];
    if let Some(h) = header.filter(|h| !h.is_empty()) {
        lines.push(interpolate(h, ctx)?);
    }
    for ((name, endpoint), up) in specs.iter().zip(ups) {
        let pad = " ".repeat(width - utf16_len(name));
        let display = endpoint.strip_prefix("unix://").unwrap_or(endpoint);
        lines.push(format!(
            "  {} {name}{pad}  {display}",
            if up { "✅" } else { "❌" }
        ));
    }
    Ok(as_res(Some(lines.join("\n"))))
}

fn resolve_section(section: &Section, ctx: &Ctx) -> Result<Res, Fwd> {
    match &section.body {
        Body::File { path, required } => resolve_file(path, *required, ctx),
        Body::Inline(content) => Ok(as_res(Some(interpolate(content, ctx)?))),
        Body::Parts(parts) => {
            let mut included = vec![];
            for (content, when) in parts {
                if matches(when.as_ref(), ctx) {
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

/// `truncateSectionContent(content, maxChars)` in UTF-16 units.
fn truncate(content: &str, max: Option<usize>) -> Result<String, Fwd> {
    const MARKER: &str = "[truncated]";
    let Some(max) = max else {
        return Ok(content.to_owned());
    };
    if utf16_len(content) <= max {
        return Ok(content.to_owned());
    }
    if max <= MARKER.len() {
        return Ok(MARKER[..max].to_owned());
    }
    if max == MARKER.len() + 1 {
        return Ok(MARKER.to_owned());
    }
    let keep = max - MARKER.len();
    let end = if utf16_at(content, keep) == Some(u16::from(b'\n')) {
        keep + 1
    } else {
        keep
    };
    let kept = utf16_slice(content, 0, end).ok_or_else(|| fwd("truncate_splits_surrogate"))?;
    Ok(format!("{kept}{MARKER}"))
}

pub struct Resolved {
    pub prompt: Option<String>,
    pub append: bool,
}

fn resolve_zone(sections: &[Section], ctx: &Ctx) -> Result<(Option<String>, usize), Fwd> {
    let mut included = vec![];
    for section in sections {
        if !matches(section.when.as_ref(), ctx) {
            continue;
        }
        let Res::Content(content) = resolve_section(section, ctx)? else {
            continue;
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
        let truncated = truncate(&wrapped, section.max_chars)?;
        if truncated.is_empty() {
            continue;
        }
        included.push(truncated);
    }
    if included.is_empty() {
        return Ok((None, 0));
    }
    let content = included.join("\n\n---\n\n");
    let chars = utf16_len(&content);
    Ok((Some(content), chars))
}

/// `resolveContextTemplateDetailed(template, context)`, the parts a compile uses.
pub fn resolve_template(template: &Template, ctx: &Ctx) -> Result<Resolved, Fwd> {
    let (prompt, prompt_chars) = resolve_zone(&template.prompt, ctx)?;
    // The reminder zone resolves too (its exec sections run, its size counts).
    let (_, reminder_chars) = resolve_zone(&template.reminder, ctx)?;
    if let Some(max) = template.max_chars
        && prompt_chars + reminder_chars > max
    {
        return Err(fwd("context_template_max_chars"));
    }
    Ok(Resolved {
        prompt,
        append: template.append,
    })
}

// -- discovery -----------------------------------------------------------------

/// The `opts` a `getAgentRootSearchPathForProject` call is given.
pub enum Roots<'a> {
    /// No opts: the daemon's environment and ASP_HOME.
    Ambient,
    /// `sharedRootOptions` for an explicit aspHome: that home's config, the
    /// daemon's environment without ASP_AGENTS_ROOT.
    Shared(&'a str),
    /// `{ env: { ASP_AGENTS_ROOT: root } }`.
    Agents(&'a str),
}

/// `getAgentRootSearchPathForProject(projectRoot, opts)`: (roots, has a project entry).
pub fn agent_root_search_path(
    project_root: Option<&str>,
    opts: Roots,
) -> Result<(Vec<String>, bool), Fwd> {
    let process = crate::reads::Env::process();
    let shared_env;
    let env = match opts {
        Roots::Shared(_) => {
            shared_env = process
                .with("ASP_AGENTS_ROOT", None)
                .with("ASP_PROJECT_ROOT_OVERRIDE", None);
            &shared_env
        }
        _ => process,
    };
    let mut roots = vec![];
    let mut has_project = false;
    if let Some(project_root) = project_root {
        let manifest = join(&[project_root, "asp-targets.toml"]);
        if std::path::Path::new(&manifest).exists() {
            let content =
                std::fs::read_to_string(&manifest).map_err(|_| fwd("targets_unreadable"))?;
            let parsed = match crate::reads::targets::parse(&content) {
                Ok(m) => m,
                Err(crate::reads::targets::TargetsError::Forward(r)) => return Err(fwd(r)),
                Err(_) => return Err(fwd("project_targets_invalid")),
            };
            if let Some(J::Str(declared)) = parsed.get("agents-root").filter(|d| super::truthy(d)) {
                has_project = true;
                // expandHomePath(value, opts.env ?? process.env): `env.HOME ?? homedir()`.
                let home = match opts {
                    Roots::Agents(_) => crate::reads::homedir(),
                    _ => env
                        .get("HOME")
                        .map_or_else(crate::reads::homedir, str::to_owned),
                };
                let expanded = if declared == "~" {
                    home.clone()
                } else if let Some(r) = declared.strip_prefix("~/") {
                    join(&[&home, r])
                } else {
                    declared.clone()
                };
                let root = if is_absolute(&expanded) {
                    resolve(&[&expanded])
                } else {
                    resolve(&[project_root, &expanded])
                };
                if std::path::Path::new(&root).exists() {
                    roots.push(root);
                }
            }
        }
    }
    let canonical = match opts {
        Roots::Agents(r) => Some(r.to_owned()),
        Roots::Shared(home) => crate::reads::declaration::agents_root(Some(home), env)
            .map_err(|_| fwd("agents_root_config"))?,
        Roots::Ambient => crate::reads::declaration::agents_root(None, env)
            .map_err(|_| fwd("agents_root_config"))?,
    };
    if let Some(c) = canonical {
        roots.push(c);
    }
    Ok((dedupe_roots(roots), has_project))
}

fn dedupe_roots(roots: Vec<String>) -> Vec<String> {
    let mut seen = vec![];
    let mut out = vec![];
    for root in roots {
        let key = resolve(&[&root]);
        if !seen.contains(&key) {
            seen.push(key);
            out.push(root);
        }
    }
    out
}

pub struct Discovered {
    pub agents_root: String,
    pub search_path: Vec<String>,
    pub raw_profile: Option<J>,
    pub base: Option<Vec<String>>,
    pub template: Option<Template>,
}

/// `discoverContextTemplate` for a compile (no explicit agents root or search path).
pub fn discover(
    agent_root: &str,
    project_root: Option<&str>,
    asp_home: &str,
    shared: bool,
) -> Result<Discovered, Fwd> {
    let agents_root = dirname(&resolve(&[agent_root]));
    let initial = match project_root {
        Some(p) => {
            let opts = if shared {
                Roots::Shared(asp_home)
            } else {
                Roots::Ambient
            };
            let (roots, has_project) = agent_root_search_path(Some(p), opts)?;
            if has_project {
                roots
            } else {
                agent_root_search_path(Some(p), Roots::Agents(&agents_root))?.0
            }
        }
        None => agent_root_search_path(None, Roots::Agents(&agents_root))?.0,
    };
    let mut all = initial;
    all.push(agents_root.clone());
    all.push(dirname(&resolve(&[agent_root])));
    let search_path = dedupe_roots(all);
    // loadTemplateDiscoveryProfile: the raw TOML, unvalidated.
    let profile_path = join(&[agent_root, "agent-profile.toml"]);
    let (raw_profile, template_ref, base) = if std::path::Path::new(&profile_path).exists() {
        let content =
            std::fs::read_to_string(&profile_path).map_err(|_| fwd("profile_unreadable"))?;
        let raw = match toml::parse(&content) {
            Ok(v) => v,
            Err(TomlError::Unsupported(r)) => return Err(fwd(r)),
            Err(_) => return Err(fwd("profile_toml_syntax")),
        };
        match raw.get("instructions") {
            Some(i @ J::Obj(_)) => {
                let template = i.get("template").and_then(J::as_str).map(str::to_owned);
                let base = match i.get("base") {
                    Some(J::Arr(items)) if items.iter().all(|x| matches!(x, J::Str(_))) => Some(
                        items
                            .iter()
                            .filter_map(J::as_str)
                            .map(str::to_owned)
                            .collect(),
                    ),
                    _ => None,
                };
                (Some(raw.clone()), template, base)
            }
            _ => (Some(raw), None, None),
        }
    } else {
        (None, None, None)
    };
    let search_ref = template_ref
        .clone()
        .unwrap_or_else(|| "context-template.toml".into());
    let mut candidates = vec![];
    if let Some(r) = &template_ref {
        candidates.push(if is_absolute(r) {
            r.clone()
        } else {
            resolve(&[agent_root, r])
        });
    } else {
        candidates.push(join(&[agent_root, "context-template.toml"]));
    }
    if !template_ref.as_deref().is_some_and(is_absolute) {
        for root in &search_path {
            candidates.push(join(&[root, &search_ref]));
        }
    }
    candidates.push(join(&[asp_home, "context-template.toml"]));
    let winner = candidates.iter().find(|c| std::path::Path::new(c).exists());
    let template = match winner {
        Some(path) => {
            let content = std::fs::read_to_string(path).map_err(|_| fwd("template_unreadable"))?;
            Some(parse_template(&content)?)
        }
        None if template_ref.is_some() => return Err(fwd("configured_template_missing")),
        None => None,
    };
    Ok(Discovered {
        agents_root,
        search_path,
        raw_profile,
        base,
        template,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Ctx {
        Ctx {
            agent_root: "/a/clod".into(),
            agents_root: "/a".into(),
            search_path: vec![],
            project_root: Some("/p".into()),
            project_id: Some("proj".into()),
            agent_id: Some("clod".into()),
            agent_name: None,
            task_id: Some("T-1".into()),
            task_context: None,
            lane: Some("main".into()),
            run_mode: "task".into(),
            agent_profile: None,
            env: Some(EnvMap::from([("X".to_owned(), "1".to_owned())])),
            exec_env: None,
        }
    }

    #[test]
    fn interpolates_like_template_vars() {
        let c = ctx();
        assert_eq!(
            interpolate("{{agentId}} {{ project_id }} {{task.id}} {{env.X}} {{env.Y}} {{nope}} {{ handle }} {{agentName}}", &c).unwrap(),
            "clod proj T-1 1  {{nope}} clod@proj:T-1~main "
        );
        assert_eq!(interpolate("{{ {{agentId}}", &c).unwrap(), "{{ clod");
        assert!(interpolate("{{toString}}", &c).is_err());
    }

    #[test]
    fn truncates_in_utf16_units() {
        assert_eq!(
            truncate("abcdefghijklmnop", Some(14)).unwrap(),
            "abc[truncated]"
        );
        assert_eq!(
            truncate("abc\ndefghijklmnop", Some(14)).unwrap(),
            "abc\n[truncated]"
        );
        assert_eq!(truncate("abcdefghijklmnop", Some(5)).unwrap(), "[trun");
    }

    #[test]
    fn exec_runs_bash_with_trimmed_stdout() {
        let mut c = ctx();
        c.agent_root = "/".into();
        assert_eq!(
            run_exec("printf '  hi \\n'", 5000.0, &c).as_deref(),
            Some("hi")
        );
        assert_eq!(run_exec("exit 3", 5000.0, &c), None);
        assert_eq!(run_exec("sleep 2", 100.0, &c), None);
    }
}
