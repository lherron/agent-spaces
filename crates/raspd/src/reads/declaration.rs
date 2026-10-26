//! `resolveRuntimeDeclaration` (compiler/agent-spaces/src/runtime-declaration.ts)
//! and the spaces-config lookups it makes: agent roots (asp-config.ts),
//! project markers and bundle refs (runtime-placement.ts), the profile/target
//! merge (agent-project-merge.ts).
use super::hash::{canonicalize, hash};
use super::jspath::{
    self, FsError, access_readable, basename, dirname, exists, fs_error, is_absolute, join,
    read_error, read_text, relative, resolve,
};
use super::profile::{self, Profile, ProfileError, SCALARS};
use super::targets::{self, TargetsError};
use super::toml::{self, TomlError};
use super::{Answer, Env, Forward, homedir, truthy_str};
use crate::json::J;

pub const REQUEST_VERSION: &str = "aspc-resolve-runtime-declaration-request/v1";
const RESPONSE_VERSION: &str = "aspc-resolve-runtime-declaration-response/v1";
const HARNESS_CATALOG: [&str; 4] = ["agent-harness", "claude", "codex", "muse"];
const DIRECTIVE_KEYS: [&str; 10] = [
    "harness",
    "model_provider",
    "model",
    "reasoning_effort",
    "presentation",
    "sandbox",
    "approval",
    "node",
    "yolo",
    "remote",
];
/// `targets[agentId]` reads through `Object.prototype` for these names.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "toLocaleString",
    "valueOf",
];

/// Early exits: a finished answer or a forward.
type Step<T> = Result<T, Answer>;

fn forward<T>(reason: Forward) -> Step<T> {
    Err(Answer::Forward(reason))
}

fn failure(kind: &str, code: &str, message: &str) -> Answer {
    Answer::Result(J::obj([
        ("schemaVersion", J::str(RESPONSE_VERSION)),
        ("ok", J::Bool(false)),
        (
            "failure",
            J::obj([
                ("kind", J::str(kind)),
                ("code", J::str(code)),
                ("message", J::str(message)),
            ]),
        ),
    ]))
}

/// A thrown fs error: its message when Bun's is pinned, else a forward.
fn known(error: Option<FsError>) -> Step<FsError> {
    error.ok_or(Answer::Forward("fs_errno_unported"))
}

/// `canonicalDirectory`: stat, must be a directory, readable, realpath.
fn canonical_directory(value: &str) -> Step<Result<String, String>> {
    if value.is_empty() {
        return forward("empty_path");
    }
    match std::fs::metadata(value) {
        Err(e) => return Ok(Err(known(fs_error(&e, "stat", Some(value)))?.message)),
        Ok(m) if !m.is_dir() => {
            return Ok(Err(format!("Configured path is not a directory: {value}")));
        }
        Ok(_) => {}
    }
    if let Err(e) = access_readable(value) {
        return Ok(Err(known(fs_error(&e, "access", Some(value)))?.message));
    }
    match std::fs::canonicalize(value) {
        Ok(p) => Ok(Ok(p.to_string_lossy().into_owned())),
        Err(_) => forward("realpath_failed"),
    }
}

fn canonical_optional(value: Option<&str>) -> Step<Result<Option<String>, String>> {
    match value {
        None => Ok(Ok(None)),
        Some(v) => Ok(canonical_directory(v)?.map(Some)),
    }
}

fn expand_home_path(value: &str, env: &Env) -> String {
    if !value.starts_with('~') {
        return value.to_owned();
    }
    let home = env.get("HOME").map_or_else(homedir, str::to_owned);
    if value == "~" {
        return home;
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return join(&[&home, rest]);
    }
    value.to_owned()
}

/// `getAspHome()`: the process's ASP_HOME, else `~/.asp`.
pub(crate) fn process_asp_home() -> String {
    match Env::process().get("ASP_HOME") {
        Some(home) => home.to_owned(),
        None => join(&[&homedir(), ".asp"]),
    }
}

/// `readAspConfig(opts)['agents-root']` when it is a string.
fn config_agents_root(asp_home: Option<&str>) -> Step<Option<String>> {
    let home = asp_home.map_or_else(process_asp_home, str::to_owned);
    let path = join(&[&home, "config.toml"]);
    if !exists(&path) {
        return Ok(None);
    }
    let Ok(content) = read_text(&path) else {
        return Ok(None);
    };
    match toml::parse(&content) {
        Ok(config) => Ok(match config.get("agents-root") {
            Some(J::Str(s)) => Some(s.clone()),
            _ => None,
        }),
        // iarna throws, and readAspConfig swallows it.
        Err(TomlError::IarnaRejects) => Ok(None),
        Err(TomlError::Unparsed) => forward("config_toml_syntax"),
        Err(TomlError::Unsupported(reason)) => forward(reason),
    }
}

/// `getAgentsRoot({ aspHome?, env })`.
pub(crate) fn agents_root(asp_home: Option<&str>, env: &Env) -> Step<Option<String>> {
    // getConfiguredRoot: the env value when set, else the config file's.
    let explicit = match env.get("ASP_AGENTS_ROOT").filter(|v| !v.is_empty()) {
        Some(from_env) => Some(expand_home_path(from_env, env)),
        None => config_agents_root(asp_home)?.map(|c| expand_home_path(&c, env)),
    };
    if let Some(explicit) = explicit.filter(|e| !e.is_empty()) {
        return Ok(Some(explicit));
    }
    let Some(home) = env.get("HOME").filter(|h| !h.is_empty()) else {
        return Ok(None);
    };
    let convention = join(&[home, "praesidium", "var", "agents"]);
    Ok(exists(&convention).then_some(convention))
}

struct SourceRoots {
    asp_home: Option<String>,
    agents_root: Option<String>,
}

fn context_mismatch(message: &str) -> Answer {
    failure("incompatible", "configured_context_mismatch", message)
}

fn source_roots(context: &J, env: &Env) -> Step<SourceRoots> {
    let sources = context.get("agentSources");
    let field = |k: &str| match sources.and_then(|s| s.get(k)) {
        Some(J::Str(s)) => Some(s.as_str()),
        _ => None,
    };
    let caller_asp_home = match canonical_optional(field("aspHome"))? {
        Ok(v) => v,
        Err(message) => return Err(context_mismatch(&message)),
    };
    let caller_agents_root = match canonical_optional(field("agentsRoot"))? {
        Ok(v) => v,
        Err(message) => return Err(context_mismatch(&message)),
    };
    if sources.is_some() && caller_agents_root.is_none() && caller_asp_home.is_none() {
        return Err(context_mismatch(
            "agentSources must resolve aspHome or agentsRoot",
        ));
    }
    let mut caller_configured: Option<String> = None;
    if let Some(home) = &caller_asp_home {
        let caller_env = env
            .with("ASP_PROJECT_ROOT_OVERRIDE", None)
            .with("ASP_HOME", Some(home))
            .with("ASP_AGENTS_ROOT", None);
        caller_configured = match agents_root(Some(home), &caller_env)? {
            Some(path) => match canonical_directory(&path)? {
                Ok(p) => Some(p),
                Err(message) => return Err(context_mismatch(&message)),
            },
            None => caller_agents_root.clone(),
        };
        if let (Some(root), Some(configured)) = (&caller_agents_root, &caller_configured)
            && configured != root
        {
            return Err(context_mismatch(&format!(
                "Caller agentsRoot {root} conflicts with {home}"
            )));
        }
        if caller_configured.is_none() {
            return Err(context_mismatch("No agents root is configured"));
        }
    }
    if sources.is_some() {
        return Ok(SourceRoots {
            asp_home: caller_asp_home
                .clone()
                .or_else(|| caller_agents_root.as_deref().map(dirname)),
            agents_root: caller_agents_root.or(caller_configured),
        });
    }
    let unavailable = |m: &str| failure("unavailable", "configured_source_unavailable", m);
    let daemon_asp_home = match env.get("ASP_HOME") {
        Some("") => return forward("empty_asp_home"),
        home => match canonical_optional(home)? {
            Ok(v) => v,
            Err(message) => return Err(unavailable(&message)),
        },
    };
    let daemon_agents_root = match agents_root(daemon_asp_home.as_deref(), env)? {
        None => return Err(unavailable("No agents root is configured")),
        Some(path) => match canonical_directory(&path)? {
            Ok(p) => p,
            Err(message) => return Err(unavailable(&message)),
        },
    };
    Ok(SourceRoots {
        asp_home: daemon_asp_home,
        agents_root: Some(daemon_agents_root),
    })
}

fn resolved_sources(roots: &SourceRoots, context: &J) -> J {
    let mut fields = vec![];
    if let Some(h) = roots.asp_home.as_deref().filter(|h| !h.is_empty()) {
        fields.push(("aspHome".to_owned(), J::str(h)));
    }
    if let Some(r) = roots.agents_root.as_deref().filter(|r| !r.is_empty()) {
        fields.push(("agentsRoot".to_owned(), J::str(r)));
    }
    let sources = context.get("agentSources");
    let provenance = if truthy_str(context.get("agentRoot")).is_some() {
        "caller-agent-root"
    } else if let Some(s) = sources {
        if truthy_str(s.get("aspHome")).is_some() && truthy_str(s.get("agentsRoot")).is_none() {
            "caller-asp-home-config"
        } else {
            "caller"
        }
    } else {
        "daemon-default"
    };
    fields.push(("provenance".to_owned(), J::str(provenance)));
    J::Obj(fields)
}

fn is_same_or_inside(child: &str, parent: &str) -> bool {
    let rel = relative(parent, child);
    rel.is_empty() || (!rel.starts_with("..") && !is_absolute(&rel))
}

fn git_root(start: &str) -> Option<String> {
    let mut dir = resolve(&[start]);
    loop {
        if exists(&join(&[&dir, ".git"])) {
            return Some(dir);
        }
        let parent = dirname(&dir);
        if parent == dir {
            return None;
        }
        dir = parent;
    }
}

/// `findProjectMarker(startDir, { agentsRoot })`: `(dir, id)`.
fn find_project_marker(start: &str, agents_root: Option<&str>) -> Option<(String, String)> {
    let mut dir = resolve(&[start]);
    let roots: Vec<String> = agents_root.map(|r| resolve(&[r])).into_iter().collect();
    let git = git_root(&dir);
    let boundary = |p: &str| roots.iter().find(|r| is_same_or_inside(p, r)).cloned();
    loop {
        // No project root is allowed to cross a boundary here.
        if boundary(&dir).is_some() {
            return None;
        }
        if exists(&join(&[&dir, "asp-targets.toml"])) {
            let id = basename(&dir);
            return Some((dir, id));
        }
        if git.as_deref() == Some(dir.as_str()) {
            break;
        }
        let parent = dirname(&dir);
        if parent == dir {
            return None;
        }
        dir = parent;
    }
    let git = git?;
    if boundary(&git).is_none() {
        let id = basename(&git);
        return Some((git, id));
    }
    None
}

enum SearchFailure {
    Answer(Answer),
    /// `getAgentRootSearchPathForProject` threw this message.
    Threw(String),
}

/// `getAgentRootSearchPathForProject(projectRoot, { aspHome?, env }).roots`.
fn search_roots(
    project_root: &str,
    asp_home: Option<&str>,
    env: &Env,
) -> Result<Vec<String>, SearchFailure> {
    let mut roots = vec![];
    let manifest_path = join(&[project_root, "asp-targets.toml"]);
    if exists(&manifest_path) {
        let content = match read_text(&manifest_path) {
            Ok(c) => c,
            Err(e) => {
                return Err(match read_error(&e, &manifest_path) {
                    Some(fs) => SearchFailure::Threw(fs.message),
                    None => SearchFailure::Answer(Answer::Forward("fs_errno_unported")),
                });
            }
        };
        let manifest = match targets::parse(&content) {
            Ok(m) => m,
            Err(TargetsError::Invalid(message)) => return Err(SearchFailure::Threw(message)),
            Err(TargetsError::Forward(reason)) => {
                return Err(SearchFailure::Answer(Answer::Forward(reason)));
            }
        };
        if let Some(declared) = truthy_str(manifest.get("agents-root")) {
            let expanded = expand_home_path(declared, env);
            let root = if is_absolute(&expanded) {
                resolve(&[&expanded])
            } else {
                resolve(&[project_root, &expanded])
            };
            if exists(&root) {
                roots.push(root);
            }
        }
    }
    match agents_root(asp_home, env) {
        Ok(Some(canonical)) => roots.push(canonical),
        Ok(None) => {}
        Err(answer) => return Err(SearchFailure::Answer(answer)),
    }
    let mut seen: Vec<String> = vec![];
    let mut out = vec![];
    for root in roots {
        let key = resolve(&[&root]);
        if !seen.contains(&key) {
            seen.push(key);
            out.push(root);
        }
    }
    Ok(out)
}

fn absent() -> J {
    J::obj([
        ("state", J::str("absent")),
        ("code", J::str("not_declared")),
    ])
}

fn empty_sources() -> Vec<(String, J)> {
    [
        "agentProfile",
        "projectTargets",
        "selectedTarget",
        "priming",
    ]
    .into_iter()
    .map(|k| (k.to_owned(), absent()))
    .collect()
}

fn set(fields: &mut Vec<(String, J)>, key: &str, value: J) {
    match fields.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = value,
        None => fields.push((key.to_owned(), value)),
    }
}

fn valid_source(content: &str) -> J {
    J::obj([
        ("state", J::str("valid")),
        ("code", J::str("parsed")),
        ("contentHash", J::Str(hash(&J::str(content)))),
    ])
}

fn diagnostic(code: &str, source: &str, message: &str) -> J {
    J::obj([
        ("severity", J::str("error")),
        ("code", J::str(code)),
        ("message", J::str(message)),
        ("source", J::str(source)),
    ])
}

fn invalid_source(code: &str, source: &str, message: &str) -> J {
    J::obj([
        ("state", J::str("invalid")),
        (
            "diagnostics",
            J::Arr(vec![diagnostic(code, source, message)]),
        ),
    ])
}

/// `declarationInvalid(code, sourceName, error, fields)`.
fn declaration_invalid(
    code: &str,
    source_name: &str,
    message: &str,
    fields: Vec<(String, J)>,
) -> Answer {
    let item = diagnostic(code, source_name, message);
    let mut out = vec![
        ("schemaVersion".to_owned(), J::str(RESPONSE_VERSION)),
        ("ok".to_owned(), J::Bool(false)),
    ];
    let has_source = fields.iter().any(|(k, _)| k == "source");
    out.extend(fields);
    if !has_source {
        let mut source = empty_sources();
        let key = if source_name == "agent-profile" {
            "agentProfile"
        } else {
            "projectTargets"
        };
        set(
            &mut source,
            key,
            J::obj([
                ("state", J::str("invalid")),
                ("diagnostics", J::Arr(vec![item.clone()])),
            ]),
        );
        out.push(("source".into(), J::Obj(source)));
    }
    out.push((
        "resolution".into(),
        J::obj([
            ("state", J::str("invalid")),
            ("code", J::str(code)),
            ("message", J::str(message)),
            ("diagnostics", J::Arr(vec![item])),
        ]),
    ));
    Answer::Result(J::Obj(out))
}

/// `{ markerProjectId }` as an object literal writes it: present unless
/// `undefined`.
fn marker_field(marker: &Option<String>) -> Vec<(String, J)> {
    marker
        .iter()
        .map(|m| ("markerProjectId".to_owned(), J::str(m)))
        .collect()
}

/// `...(markerProjectId ? { markerProjectId } : {})`.
fn marker_spread(marker: &Option<String>) -> Vec<(String, J)> {
    marker
        .iter()
        .filter(|m| !m.is_empty())
        .map(|m| ("markerProjectId".to_owned(), J::str(m)))
        .collect()
}

fn read_source(path: &str) -> Step<String> {
    read_text(path).map_err(|e| match read_error(&e, path) {
        Some(fs) => failure("unavailable", "source_read_unavailable", &fs.message),
        None => Answer::Forward("fs_errno_unported"),
    })
}

/// `provisioning(scalars, declaredHarness, effectiveHarness)`.
fn provisioning(scalars: &[(String, J)], declared: Option<&str>) -> Result<J, Answer> {
    let effective = match scalars.iter().find(|(k, _)| k == "harness") {
        Some((_, J::Str(h))) => Some(h.as_str()),
        _ => None,
    };
    if let Some(h) = effective
        && !HARNESS_CATALOG.contains(&h)
    {
        return Err(failure(
            "incompatible",
            "unsupported_harness",
            &format!("Unsupported harness {h}"),
        ));
    }
    let mut out = vec![("scalars".to_owned(), J::Obj(scalars.to_vec()))];
    if let Some(d) = declared.filter(|d| !d.is_empty()) {
        out.push(("declaredHarness".into(), J::str(d)));
    }
    if let Some(e) = effective {
        out.push(("effectiveHarness".into(), J::str(e)));
    }
    Ok(J::Obj(out))
}

/// `mergeProvisioningScalars(profile, target)`: target over agent, by key
/// order, `yolo`/`remote` defaulted to false.
fn merge_scalars(profile: &Profile, target: Option<&J>) -> Vec<(String, J)> {
    let target_provisioning = target.and_then(|t| t.get("provisioning"));
    let mut merged = vec![];
    for (key, _) in SCALARS {
        let value = target_provisioning
            .and_then(|p| p.get(key))
            .or_else(|| profile.scalar(key));
        if let Some(v) = value {
            merged.push((key.to_owned(), v.clone()));
        }
    }
    for key in ["yolo", "remote"] {
        if !merged.iter().any(|(k, _)| k == key) {
            merged.push((key.to_owned(), J::Bool(false)));
        }
    }
    merged
}

pub fn answer(request: &J, env: &Env) -> Answer {
    match resolve_steps(request, env) {
        Ok(answer) | Err(answer) => answer,
    }
}

fn resolve_steps(request: &J, env: &Env) -> Step<Answer> {
    let context = match request.get("context") {
        Some(c)
            if request.get("schemaVersion") == Some(&J::str(REQUEST_VERSION))
                && super::js_truthy(c) =>
        {
            c
        }
        _ => {
            return Ok(failure(
                "incompatible",
                "unsupported_schema",
                "Unsupported runtime declaration schema",
            ));
        }
    };
    let text = |v: Option<&J>| match v {
        Some(J::Str(s)) => s.clone(),
        _ => String::new(),
    };
    let agent_id = text(context.get("agentId"));
    if agent_id.is_empty() || OBJECT_PROTOTYPE_KEYS.contains(&agent_id.as_str()) {
        return forward("agent_id_unported");
    }
    let cwd = text(context.get("cwd"));
    let run_mode = text(context.get("runMode"));
    let project = context.get("project");
    let mode = text(project.and_then(|p| p.get("mode")));

    let roots = source_roots(context, env)?;
    let configured_agents_root = roots.agents_root.clone();

    let supplied_agent_root = match truthy_str(context.get("agentRoot")) {
        Some(root) => match canonical_directory(root)? {
            Ok(p) => Some(p),
            Err(message) => return Ok(context_mismatch(&message)),
        },
        None => None,
    };

    let mut project_root: Option<String> = None;
    let mut marker_project_id: Option<String> = None;
    if mode == "root" {
        let root = text(project.and_then(|p| p.get("projectRoot")));
        project_root = match canonical_directory(&root)? {
            Ok(p) => Some(p),
            Err(message) => return Ok(context_mismatch(&message)),
        };
        marker_project_id = match project.and_then(|p| p.get("projectId")) {
            Some(J::Str(id)) => Some(id.clone()),
            _ => None,
        };
    } else if mode == "infer-from-cwd" {
        let agents_root = configured_agents_root.as_deref().filter(|r| !r.is_empty());
        if let Some((dir, id)) = find_project_marker(&cwd, agents_root) {
            project_root = match canonical_directory(&dir)? {
                Ok(p) => Some(p),
                Err(message) => return Ok(context_mismatch(&message)),
            };
            marker_project_id = Some(id);
        }
    }

    let agent_sources = resolved_sources(&roots, context);
    let searched_for =
        |roots: &[String]| -> Vec<String> { roots.iter().map(|r| join(&[r, &agent_id])).collect() };
    let strings = |v: &[String]| J::Arr(v.iter().map(J::str).collect());

    let mut search: Vec<String> = vec![];
    if supplied_agent_root.is_none()
        && let Some(root) = configured_agents_root.as_deref().filter(|r| !r.is_empty())
    {
        search.push(root.to_owned());
    }
    if supplied_agent_root.is_none()
        && let Some(root) = project_root.as_deref()
    {
        let search_env = if context.get("agentSources").is_none() {
            env.with("ASP_PROJECT_ROOT_OVERRIDE", None)
        } else {
            let mut e = env.with("ASP_PROJECT_ROOT_OVERRIDE", None);
            if let Some(h) = roots.asp_home.as_deref().filter(|h| !h.is_empty()) {
                e = e.with("ASP_HOME", Some(h));
            }
            e.with("ASP_AGENTS_ROOT", configured_agents_root.as_deref())
        };
        let asp_home = roots.asp_home.as_deref().filter(|h| !h.is_empty());
        match search_roots(root, asp_home, &search_env) {
            Ok(found) => search = found,
            Err(SearchFailure::Answer(answer)) => return Err(answer),
            Err(SearchFailure::Threw(message)) => {
                let mut fields = vec![("agentSources".to_owned(), agent_sources.clone())];
                fields.extend(marker_field(&marker_project_id));
                fields.push(("searchedAgentRoots".into(), strings(&searched_for(&search))));
                return Ok(declaration_invalid(
                    "project_targets_invalid",
                    "project-targets",
                    &message,
                    fields,
                ));
            }
        }
    }
    let searched = searched_for(&search);

    let agent_root = match supplied_agent_root {
        Some(root) => Some(root),
        None => match searched.iter().find(|r| jspath::is_directory(r)) {
            Some(found) => match canonical_directory(found)? {
                Ok(p) => Some(p),
                Err(message) => return Ok(context_mismatch(&message)),
            },
            None => None,
        },
    };
    let Some(agent_root) = agent_root else {
        let mut out = vec![
            ("schemaVersion".to_owned(), J::str(RESPONSE_VERSION)),
            ("ok".to_owned(), J::Bool(false)),
            ("agentSources".to_owned(), agent_sources),
        ];
        out.extend(marker_spread(&marker_project_id));
        out.push(("searchedAgentRoots".into(), strings(&searched)));
        out.push(("source".into(), J::Obj(empty_sources())));
        out.push((
            "resolution".into(),
            J::obj([
                ("state", J::str("absent")),
                ("code", J::str("agent_not_found")),
                ("message", J::Str(format!("Agent {agent_id} was not found"))),
                ("diagnostics", J::Arr(vec![])),
            ]),
        ));
        return Ok(Answer::Result(J::Obj(out)));
    };

    // -- the agent profile ----------------------------------------------------
    let profile_path = join(&[&agent_root, "agent-profile.toml"]);
    let mut profile_content: Option<String> = None;
    let profile = if exists(&profile_path) {
        let content = read_source(&profile_path)?;
        let parsed = profile::parse(&content);
        match parsed {
            Ok(p) => {
                profile_content = Some(content);
                p
            }
            Err(ProfileError::Forward(reason)) => return forward(reason),
            Err(ProfileError::Invalid(message)) => {
                let mut fields = vec![("agentSources".to_owned(), agent_sources)];
                fields.extend(marker_spread(&marker_project_id));
                fields.push(("searchedAgentRoots".into(), strings(&searched)));
                let mut source = empty_sources();
                set(
                    &mut source,
                    "agentProfile",
                    invalid_source("agent_profile_invalid", "agent-profile", &message),
                );
                fields.push(("source".into(), J::Obj(source)));
                return Ok(declaration_invalid(
                    "agent_profile_invalid",
                    "agent-profile",
                    &message,
                    fields,
                ));
            }
        }
    } else {
        Profile::default()
    };
    let declared_harness = profile.harness().map(str::to_owned);
    let observed_profile_source = match &profile_content {
        Some(content) => {
            let mut source = valid_source(content);
            if let (J::Obj(f), Some(h)) = (
                &mut source,
                declared_harness.as_deref().filter(|h| !h.is_empty()),
            ) {
                f.push(("declaredHarness".into(), J::str(h)));
            }
            source
        }
        None => absent(),
    };

    // -- the project target -----------------------------------------------------
    let mut target_source = absent();
    let mut selected_target_source = absent();
    let mut target: Option<J> = None;
    if let Some(root) = project_root.as_deref() {
        let targets_path = join(&[root, "asp-targets.toml"]);
        if exists(&targets_path) {
            let content = read_source(&targets_path)?;
            match targets::parse(&content) {
                Ok(manifest) => {
                    target_source = valid_source(&content);
                    target = manifest
                        .get("targets")
                        .and_then(|t| t.get(&agent_id))
                        .cloned();
                    if let Some(t) = &target {
                        selected_target_source = valid_source(&canonicalize(t));
                    }
                }
                Err(TargetsError::Forward(reason)) => return forward(reason),
                Err(TargetsError::Invalid(message)) => {
                    let mut fields = vec![("agentSources".to_owned(), agent_sources)];
                    fields.extend(marker_field(&marker_project_id));
                    fields.push(("searchedAgentRoots".into(), strings(&searched)));
                    let mut source = empty_sources();
                    set(&mut source, "agentProfile", observed_profile_source);
                    set(
                        &mut source,
                        "projectTargets",
                        invalid_source("project_targets_invalid", "project-targets", &message),
                    );
                    fields.push(("source".into(), J::Obj(source)));
                    return Ok(declaration_invalid(
                        "project_targets_invalid",
                        "project-targets",
                        &message,
                        fields,
                    ));
                }
            }
        }
    }

    // -- priming ----------------------------------------------------------------
    let mut priming: Option<String> = None;
    let mut priming_source = absent();
    if let Some(p) = profile.priming.as_deref().filter(|p| !p.is_empty()) {
        priming = Some(p.to_owned());
    } else if let Some(file) = profile.priming_file.as_deref().filter(|f| !f.is_empty()) {
        let path = join(&[&agent_root, file]);
        match read_text(&path) {
            Ok(content) => priming = Some(content),
            Err(e) => {
                let Some(fs) = read_error(&e, &path) else {
                    return forward("fs_errno_unported");
                };
                if fs.is(&["ENOENT", "EACCES"]) {
                    return Ok(failure(
                        "unavailable",
                        "source_read_unavailable",
                        &fs.message,
                    ));
                }
                let mut fields = vec![("agentSources".to_owned(), agent_sources)];
                fields.extend(marker_field(&marker_project_id));
                fields.push(("searchedAgentRoots".into(), strings(&searched)));
                fields.push((
                    "source".into(),
                    J::Obj(vec![
                        ("agentProfile".into(), observed_profile_source),
                        ("projectTargets".into(), target_source),
                        ("selectedTarget".into(), selected_target_source),
                        (
                            "priming".into(),
                            invalid_source("priming_invalid", "priming", &fs.message),
                        ),
                    ]),
                ));
                return Ok(declaration_invalid(
                    "priming_invalid",
                    "priming",
                    &fs.message,
                    fields,
                ));
            }
        }
    }
    if let Some(p) = &priming {
        priming_source = valid_source(p);
    }

    // -- provisioning -----------------------------------------------------------
    let baseline = merge_scalars(&profile, target.as_ref());
    let mut final_scalars = baseline.clone();
    if let Some(directives) = context.get("provisionDirectives") {
        for (key, value) in directives.js_entries() {
            if !DIRECTIVE_KEYS.contains(&key) {
                return Ok(failure(
                    "incompatible",
                    "unsupported_directive",
                    &format!("Unsupported directive {key}"),
                ));
            }
            set(&mut final_scalars, key, value.clone());
        }
    }
    let baseline_provisioning = match provisioning(&baseline, declared_harness.as_deref()) {
        Ok(p) => p,
        Err(Answer::Result(failure)) => J::Obj(vec![("failure".into(), failure)]),
        Err(answer) => return Err(answer),
    };
    let final_provisioning = match provisioning(&final_scalars, declared_harness.as_deref()) {
        Ok(p) => p,
        Err(answer) => return Ok(answer),
    };

    // -- the declaration --------------------------------------------------------
    let mut bundle = vec![
        ("kind".to_owned(), J::str("agent-project")),
        ("agentName".to_owned(), J::str(&agent_id)),
    ];
    if let Some(root) = &project_root {
        bundle.push(("projectRoot".into(), J::str(root)));
    }
    let bundle = J::Obj(bundle);
    let mut placement = vec![("agentRoot".to_owned(), J::str(&agent_root))];
    if let Some(root) = &project_root {
        placement.push(("projectRoot".into(), J::str(root)));
    }
    placement.extend([
        ("cwd".to_owned(), J::str(&cwd)),
        ("runMode".to_owned(), J::str(&run_mode)),
        ("bundle".to_owned(), bundle.clone()),
    ]);
    let source = J::Obj(vec![
        ("agentProfile".into(), observed_profile_source),
        ("projectTargets".into(), target_source),
        ("selectedTarget".into(), selected_target_source),
        ("priming".into(), priming_source),
    ]);
    let context_hash = hash(&J::Obj(vec![
        ("context".into(), context.clone()),
        ("source".into(), source.clone()),
    ]));

    let mut identity = vec![];
    if let Some(role) = profile.identity_role.as_deref().filter(|r| !r.is_empty()) {
        identity.push(("role".to_owned(), J::str(role)));
    }
    identity.push(("operator".into(), J::Bool(profile.operator == Some(true))));

    let mut policy = vec![(
        "claimsTask".to_owned(),
        J::Bool(profile.claims_task == Some(true)),
    )];
    if let Some(J::Str(node)) = profile.scalar("node")
        && !node.is_empty()
    {
        policy.push(("provisioningNode".into(), J::str(node)));
    }
    let placement_policy = profile.placement.as_ref();
    let mut placement_fields = vec![];
    if let Some(launch) = placement_policy.and_then(|p| p.launch.as_deref()) {
        placement_fields.push(("launch".to_owned(), J::str(launch)));
    }
    placement_fields.push((
        "pins".into(),
        J::Obj(placement_policy.map(|p| p.pins.clone()).unwrap_or_default()),
    ));
    placement_fields.push((
        "homes".into(),
        J::Obj(
            placement_policy
                .map(|p| p.homes.clone())
                .unwrap_or_default(),
        ),
    ));
    policy.push(("placement".into(), J::Obj(placement_fields)));

    let mut out = vec![
        ("schemaVersion".to_owned(), J::str(RESPONSE_VERSION)),
        ("ok".to_owned(), J::Bool(true)),
        ("evaluatedAt".to_owned(), J::Str(evaluated_at())),
        ("contextHash".to_owned(), J::Str(context_hash)),
        ("agentSources".to_owned(), agent_sources),
    ];
    out.extend(marker_spread(&marker_project_id));
    out.extend([
        ("searchedAgentRoots".to_owned(), strings(&searched)),
        ("source".to_owned(), source),
        ("identity".to_owned(), J::Obj(identity)),
        ("policy".to_owned(), J::Obj(policy)),
        ("baselineProvisioning".to_owned(), baseline_provisioning),
        ("provisioning".to_owned(), final_provisioning),
    ]);
    if let Some(content) = priming {
        let source = profile
            .priming_file
            .clone()
            .unwrap_or_else(|| "inline".into());
        out.push((
            "priming".into(),
            J::obj([("content", J::Str(content)), ("source", J::Str(source))]),
        ));
    }
    out.extend([
        ("placement".to_owned(), J::Obj(placement)),
        (
            "bundle".to_owned(),
            J::obj([("ref", bundle.clone()), ("identity", J::Str(hash(&bundle)))]),
        ),
        ("diagnostics".to_owned(), J::Arr(vec![])),
    ]);
    Ok(Answer::Result(J::Obj(out)))
}

/// `new Date().toISOString()`.
fn evaluated_at() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}
