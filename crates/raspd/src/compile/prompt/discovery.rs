//! Template discovery (system-prompt.ts `discoverContextTemplate`) and the
//! agent-root search path (`getAgentRootSearchPathForProject`).
use super::template::{Template, parse_template};
use crate::compile::{Fwd, fwd, truthy};
use crate::json::J;
use crate::reads::jspath::{dirname, is_absolute, join, resolve};
use crate::reads::toml::{self, TomlError};

/// The `opts` a `getAgentRootSearchPathForProject` call is given.
pub enum Roots<'a> {
    /// No opts: the daemon's environment and ASP_HOME.
    Ambient,
    /// `sharedRootOptions` for an explicit aspHome: that home's config, the
    /// daemon's environment without ASP_AGENTS_ROOT, or with the declaration's
    /// echoed agents root as ASP_AGENTS_ROOT (`promptSourcesForDeclaration`).
    Shared(&'a str, Option<&'a str>),
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
        Roots::Shared(_, agents_root) => {
            shared_env = process
                .with("ASP_PROJECT_ROOT_OVERRIDE", None)
                .with("ASP_AGENTS_ROOT", agents_root);
            &shared_env
        }
        _ => process,
    };
    let mut roots = vec![];
    let mut has_project = false;
    if let Some(project_root) = project_root {
        let manifest = join(&[project_root, "asp-targets.toml"]);
        if std::path::Path::new(&manifest).exists() {
            // Lossy like Bun's readFileSync(…, 'utf8'); a read error throws there too.
            let content = crate::reads::jspath::read_text(&manifest)
                .map_err(|_| fwd(crate::reason!("targets_unreadable")))?;
            let parsed = match crate::reads::targets::parse(&content) {
                Ok(m) => m,
                Err(crate::reads::targets::TargetsError::Forward(r)) => return Err(fwd(r)),
                Err(_) => return Err(fwd(crate::reason!("project_targets_invalid"))),
            };
            if let Some(J::Str(declared)) = parsed.get("agents-root").filter(|d| truthy(d)) {
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
        Roots::Shared(home, _) => {
            crate::reads::declaration::agents_root(Some(home), env).map_err(fwd)?
        }
        Roots::Ambient => crate::reads::declaration::agents_root(None, env).map_err(fwd)?,
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
    raw_profile: Option<J>,
    base: Option<Vec<String>>,
    pub template: Option<Template>,
}

impl Discovered {
    /// Whether the agent has a system prompt: a template, else a SOUL.md.
    pub fn has_prompt(&self, agent_root: &str) -> bool {
        self.template.is_some() || std::path::Path::new(&join(&[agent_root, "SOUL.md"])).exists()
    }

    /// The profile's `instructions.base` refs (none without them).
    pub fn base(&self) -> &[String] {
        self.base.as_deref().unwrap_or_default()
    }

    /// The resolver's `agentProfile`: the raw profile under a template, else
    /// only its `instructions.base`.
    pub fn agent_profile(&self) -> Option<J> {
        if self.template.is_some() {
            return self.raw_profile.clone();
        }
        self.base.as_ref().map(|b| {
            J::obj([(
                "instructions",
                J::obj([("base", J::Arr(b.iter().map(J::str).collect()))]),
            )])
        })
    }
}

/// `discoverContextTemplate` with no explicit agents root or search path.
/// `shared` is the `sharedRootOptions` arm: `None` is ambient, `Some(root)`
/// sets ASP_AGENTS_ROOT to that root (`None` inside clears it).
pub fn discover(
    agent_root: &str,
    project_root: Option<&str>,
    asp_home: &str,
    shared: Option<Option<&str>>,
) -> Result<Discovered, Fwd> {
    let agents_root = dirname(&resolve(&[agent_root]));
    let initial = match project_root {
        Some(p) => {
            let opts = match shared {
                Some(agents_root) => Roots::Shared(asp_home, agents_root),
                None => Roots::Ambient,
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
    discover_from_roots(agent_root, agents_root, asp_home, search_path)
}

/// Caller-context discovery pins both roots and search order; no placement config
/// or process environment participates in discovering the inspection template.
pub fn discover_explicit(agent_root: &str, agents_root: &str) -> Result<Discovered, Fwd> {
    let search_path = dedupe_roots(vec![
        agent_root.into(),
        agents_root.into(),
        dirname(&resolve(&[agent_root])),
    ]);
    discover_from_roots(
        agent_root,
        agents_root.into(),
        &dirname(agents_root),
        search_path,
    )
}

/// `loadTemplateDiscoveryProfile`: the raw TOML (unvalidated), its
/// `instructions.template` ref and its `instructions.base` refs.
type DiscoveryProfile = (Option<J>, Option<String>, Option<Vec<String>>);

fn discovery_profile(agent_root: &str) -> Result<DiscoveryProfile, Fwd> {
    let profile_path = join(&[agent_root, "agent-profile.toml"]);
    if !std::path::Path::new(&profile_path).exists() {
        return Ok((None, None, None));
    }
    // Bun reads it as UTF-8 with replacement; only a read error refuses.
    let content = crate::reads::jspath::read_text(&profile_path)
        .map_err(|_| fwd(crate::reason!("profile_unreadable")))?;
    let raw = match toml::parse(&content) {
        Ok(v) => v,
        Err(TomlError::Unsupported(r)) => return Err(fwd(r)),
        Err(_) => return Err(fwd(crate::reason!("profile_toml_syntax"))),
    };
    Ok(match raw.get("instructions") {
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
    })
}

/// The template candidates in Bun's order: the agent's own (or its configured
/// ref), the configured or default name in each search root unless the ref is
/// absolute, then ASP_HOME's.
fn template_candidates(
    agent_root: &str,
    template_ref: Option<&str>,
    asp_home: &str,
    search_path: &[String],
) -> Vec<String> {
    let search_ref = template_ref.unwrap_or("context-template.toml");
    let mut candidates = vec![match template_ref {
        Some(r) if is_absolute(r) => r.to_owned(),
        Some(r) => resolve(&[agent_root, r]),
        None => join(&[agent_root, "context-template.toml"]),
    }];
    if !template_ref.is_some_and(is_absolute) {
        for root in search_path {
            candidates.push(join(&[root, search_ref]));
        }
    }
    candidates.push(join(&[asp_home, "context-template.toml"]));
    candidates
}

fn discover_from_roots(
    agent_root: &str,
    agents_root: String,
    asp_home: &str,
    search_path: Vec<String>,
) -> Result<Discovered, Fwd> {
    let (raw_profile, template_ref, base) = discovery_profile(agent_root)?;
    let candidates =
        template_candidates(agent_root, template_ref.as_deref(), asp_home, &search_path);
    let template = match candidates.iter().find(|c| std::path::Path::new(c).exists()) {
        Some(path) => {
            // Lossy like Bun's readFileSync(…, 'utf8'); a read error throws there too.
            let content = crate::reads::jspath::read_text(path)
                .map_err(|_| fwd(crate::reason!("template_unreadable")))?;
            Some(parse_template(&content)?)
        }
        None if template_ref.is_some() => {
            return Err(fwd(crate::reason!("configured_template_missing")));
        }
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
