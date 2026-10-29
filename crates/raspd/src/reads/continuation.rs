//! `observeContinuationArtifact` (compiler/agent-spaces/src/continuation-probe.ts).
use super::jspath::{basename, is_absolute, join, relative, resolve};
use super::{Answer, Env, truthy_str};
use crate::json::J;

pub const REQUEST_VERSION: &str = "aspc-observe-continuation-artifact-request/v1";
const RESPONSE_VERSION: &str = "aspc-observe-continuation-artifact-response/v1";
const CODEX_SCAN_MAX_ENTRIES: usize = 100_000;
const CODEX_SCAN_MAX_DEPTH: usize = 8;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Probe {
    Present,
    Missing,
    Unknown,
}

#[derive(Clone, Copy, PartialEq)]
enum Provider {
    Pi,
    Codex,
    Claude,
    Unknown,
    Unsupported,
}

fn normalize_provider(provider: &str) -> Provider {
    match provider.to_lowercase().as_str() {
        "pi" | "pi-sdk" | "openai/pi-sdk" => Provider::Pi,
        "codex" | "codex-cli" | "openai-codex" | "openai/codex-cli" => Provider::Codex,
        "anthropic" | "claude" | "claude-code" | "claude-code-cli" => Provider::Claude,
        "openai" => Provider::Unknown,
        _ => Provider::Unsupported,
    }
}

fn failure(kind: &str, code: &str, message: &str) -> J {
    J::obj([
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
    ])
}

fn state(state: &str, code: &str) -> J {
    J::obj([("state", J::str(state)), ("code", J::str(code))])
}

fn artifact_state(result: Probe) -> J {
    match result {
        Probe::Present => state("present", "artifact_present"),
        Probe::Missing => state("missing", "artifact_missing"),
        Probe::Unknown => state("unknown", "home_unreadable"),
    }
}

fn success(requested: J, format: &str, basis: &str, artifact: J, diagnostics: Vec<J>) -> J {
    let provider = requested.get("provider").cloned();
    let mut fields = vec![
        ("schemaVersion".to_owned(), J::str(RESPONSE_VERSION)),
        ("ok".into(), J::Bool(true)),
        ("requested".into(), requested),
    ];
    if let Some(J::Str(p)) = &provider
        && (p == "anthropic" || p == "openai")
    {
        fields.push(("executionProvider".into(), J::str(p)));
    }
    fields.extend([
        ("artifactFormat".to_owned(), J::str(format)),
        ("artifact".into(), artifact),
        ("basis".into(), J::str(basis)),
        ("diagnostics".into(), J::Arr(diagnostics)),
    ]);
    J::Obj(fields)
}

fn record(v: Option<&J>) -> Option<&J> {
    v.filter(|v| v.is_record())
}

/// `a?.b?.c`, reading through records only (validated input never needs more).
fn at<'a>(v: Option<&'a J>, keys: &[&str]) -> Option<&'a J> {
    keys.iter().try_fold(v?, |v, k| v.get(k))
}

fn driver_format(driver: Option<&J>) -> Option<&'static str> {
    match driver {
        Some(J::Str(d)) => match d.as_str() {
            "pi-sdk" | "pi-tui-tmux" => Some("pi"),
            "codex-app-server" | "codex-cli-tmux" => Some("codex"),
            "claude-code-tmux" | "claude-code-hrcpty" => Some("claude"),
            _ => None,
        },
        _ => None,
    }
}

fn resolve_format(continuation: &J, frozen: Option<&J>) -> String {
    let broker = frozen.and_then(|f| f.get("brokerDriver"));
    let driver = match broker {
        Some(J::Null) | None => at(frozen, &["startRequest", "spec", "driver", "kind"]),
        some => some,
    };
    let from_driver = driver_format(driver);
    let requested = truthy_str(continuation.get("artifactFormat"));
    if let (Some(requested), Some(from_driver)) = (requested, from_driver)
        && requested != from_driver
    {
        return "conflict".into();
    }
    if let Some(requested) = requested {
        return requested.to_owned();
    }
    if let Some(from_driver) = from_driver {
        return from_driver.into();
    }
    let provider = match continuation.get("provider") {
        Some(J::Str(p)) => p.as_str(),
        _ => "",
    };
    match normalize_provider(provider) {
        Provider::Pi => "pi",
        Provider::Codex => "codex",
        Provider::Claude => "claude",
        Provider::Unknown | Provider::Unsupported => "unknown",
    }
    .into()
}

fn absolute_string(v: Option<&J>) -> Option<&str> {
    match v {
        Some(J::Str(s)) if is_absolute(s) => Some(s),
        _ => None,
    }
}

fn frozen_codex_home(frozen: Option<&J>) -> Option<&str> {
    absolute_string(at(
        frozen,
        &["startRequest", "spec", "process", "lockedEnv", "CODEX_HOME"],
    ))
}

fn frozen_claude_home(frozen: Option<&J>) -> Option<String> {
    let env = at(frozen, &["startRequest", "spec", "process", "lockedEnv"]);
    if let Some(dir) = absolute_string(env.and_then(|e| e.get("CLAUDE_CONFIG_DIR"))) {
        return Some(dir.to_owned());
    }
    absolute_string(env.and_then(|e| e.get("HOME"))).map(|home| join(&[home, ".claude"]))
}

fn derive_recorded_codex_home(
    recorded: Option<&J>,
    daemon_asp_home: Option<&str>,
) -> Option<String> {
    let recorded = recorded?;
    let placement = recorded.get("placement");
    let agent_root = placement.and_then(|p| p.get("agentRoot"));
    let project_root = placement.and_then(|p| p.get("projectRoot"));
    let asp_home = match recorded.get("aspHome") {
        Some(J::Str(s)) => Some(s.as_str()),
        _ => daemon_asp_home,
    };
    let (Some(J::Str(agent_root)), Some(J::Str(project_root)), Some(asp_home)) =
        (agent_root, project_root, asp_home.filter(|h| !h.is_empty()))
    else {
        return None;
    };
    Some(join(&[
        asp_home,
        "codex-homes",
        &format!("{}_{}", basename(project_root), basename(agent_root)),
    ]))
}

fn is_same_or_inside(child: &str, parent: &str) -> bool {
    let path = relative(&resolve(&[parent]), &resolve(&[child]));
    path.is_empty() || (!path.starts_with("..") && !is_absolute(&path))
}

fn not_found(error: &std::io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ENOENT) | Some(libc::ENOTDIR)
    )
}

fn stat_path(path: &str) -> Probe {
    match std::fs::metadata(path) {
        Ok(_) => Probe::Present,
        Err(e) if not_found(&e) => Probe::Missing,
        Err(_) => Probe::Unknown,
    }
}

fn scan_codex(codex_home: &str, key: &str) -> Probe {
    let sessions = join(&[codex_home, "sessions"]);
    let suffix = format!("-{key}.jsonl");
    let mut pending = vec![(sessions.clone(), 0usize)];
    let mut scanned = 0usize;
    while let Some((path, depth)) = pending.pop() {
        let entries = match std::fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(e) => {
                return if path == sessions && not_found(&e) {
                    Probe::Missing
                } else {
                    Probe::Unknown
                };
            }
        };
        let mut listed = vec![];
        for entry in entries {
            let Ok(entry) = entry else {
                return Probe::Unknown;
            };
            let Ok(file_type) = entry.file_type() else {
                return Probe::Unknown;
            };
            listed.push((entry.file_name().to_string_lossy().into_owned(), file_type));
        }
        scanned += listed.len();
        if scanned > CODEX_SCAN_MAX_ENTRIES {
            return Probe::Unknown;
        }
        for (name, file_type) in listed {
            if file_type.is_file() && name.starts_with("rollout-") && name.ends_with(&suffix) {
                return Probe::Present;
            }
            if file_type.is_dir() {
                if depth + 1 > CODEX_SCAN_MAX_DEPTH {
                    return Probe::Unknown;
                }
                pending.push((join(&[&path, &name]), depth + 1));
            }
        }
    }
    Probe::Missing
}

/// Claude's project directory name for `cwd`: every UTF-16 unit outside
/// `[a-zA-Z0-9]` becomes `-`.
fn encode_claude_project_path(path: &str) -> String {
    path.chars()
        .flat_map(|c| {
            let n = if c.is_ascii_alphanumeric() {
                0
            } else {
                c.len_utf16()
            };
            std::iter::repeat_n('-', n).chain((n == 0).then_some(c))
        })
        .collect()
}

pub fn observe(request: &J, env: &Env) -> Answer {
    if request.get("schemaVersion") != Some(&J::str(REQUEST_VERSION)) {
        return Answer::Result(failure(
            "incompatible",
            "unsupported_schema",
            "Unsupported continuation observation schema",
        ));
    }
    let continuation = record(request.get("continuation"));
    let provider = truthy_str(continuation.and_then(|c| c.get("provider")));
    let key = truthy_str(continuation.and_then(|c| c.get("key")));
    let (Some(continuation), Some(provider), Some(key)) = (continuation, provider, key) else {
        return Answer::Result(failure(
            "incompatible",
            "evidence_invalid",
            "Continuation provider and key are required",
        ));
    };
    let historical = record(request.get("historicalExecution"));
    let frozen = record(historical.and_then(|h| h.get("frozenStartRequest")));
    if let Some(frozen) = frozen
        && frozen.get("keyBinding") != Some(&J::str("runtime-continuation"))
    {
        return Answer::Result(failure(
            "incompatible",
            "evidence_invalid",
            "Frozen evidence is not bound to the retained runtime continuation",
        ));
    }
    let normalized = normalize_provider(provider);
    if normalized == Provider::Unsupported {
        return Answer::Result(failure(
            "incompatible",
            "unsupported_provider",
            &format!("Unsupported continuation provider {provider}"),
        ));
    }
    let format = resolve_format(continuation, frozen);
    if format == "conflict" {
        return Answer::Result(failure(
            "incompatible",
            "evidence_invalid",
            "Artifact format conflicts with broker driver evidence",
        ));
    }
    if (normalized == Provider::Claude && format != "claude")
        || (normalized == Provider::Codex && format != "codex")
    {
        return Answer::Result(failure(
            "incompatible",
            "evidence_invalid",
            "Execution provider and artifact format disagree",
        ));
    }
    let mut requested = vec![
        ("provider".to_owned(), J::str(provider)),
        ("key".into(), J::str(key)),
    ];
    if let Some(f) = truthy_str(continuation.get("artifactFormat")) {
        requested.push(("artifactFormat".into(), J::str(f)));
    }
    let requested = J::Obj(requested);
    let ok = |format: &str, basis: &str, artifact: J, diagnostics: Vec<J>| {
        Answer::Result(success(
            requested.clone(),
            format,
            basis,
            artifact,
            diagnostics,
        ))
    };
    match format.as_str() {
        "unknown" => {
            return ok(
                "unknown",
                "none",
                state("unknown", "artifact_format_ambiguous"),
                vec![],
            );
        }
        "pi" => {
            let artifact = if !is_absolute(key) {
                state("unknown", "key_not_absolute")
            } else {
                artifact_state(stat_path(key))
            };
            return ok("pi", "absolute-key", artifact, vec![]);
        }
        "codex" => {
            let asp_home = env.get("ASP_HOME").filter(|h| !h.is_empty());
            let frozen_home = frozen_codex_home(frozen);
            if let (Some(home), Some(asp_home)) = (frozen_home, asp_home)
                && !is_same_or_inside(home, asp_home)
            {
                return Answer::Result(failure(
                    "incompatible",
                    "evidence_invalid",
                    "Frozen provider home is outside the configured historical ASP home",
                ));
            }
            let recorded = record(historical.and_then(|h| h.get("recordedPlacement")));
            let derived_home = derive_recorded_codex_home(recorded, asp_home);
            let derived = derived_home.as_deref().map(|home| scan_codex(home, key));
            if let Some(home) = frozen_home {
                if !super::jspath::is_directory(home) {
                    return ok(
                        "codex",
                        "frozen-home",
                        state("unknown", "home_unreadable"),
                        vec![],
                    );
                }
                let frozen_result = scan_codex(home, key);
                let diagnostics = if derived.is_some_and(|d| d != frozen_result) {
                    vec![J::obj([
                        ("code", J::str("historical_evidence_disagrees")),
                        (
                            "message",
                            J::str("Frozen provider home and recorded placement rule disagree"),
                        ),
                    ])]
                } else {
                    vec![]
                };
                return ok(
                    "codex",
                    "frozen-home",
                    artifact_state(frozen_result),
                    diagnostics,
                );
            }
            if derived_home.is_some() {
                let artifact = if derived == Some(Probe::Present) {
                    state("present", "artifact_present")
                } else {
                    state("unknown", "home_not_historical")
                };
                return ok("codex", "recorded-placement-rule", artifact, vec![]);
            }
            return ok(
                "codex",
                "none",
                state("unknown", "context_unavailable"),
                vec![],
            );
        }
        _ => {}
    }
    // claude
    let cwd = match at(frozen, &["placement", "cwd"]) {
        Some(J::Str(c)) => Some(c.as_str()),
        // Bun's `path.resolve` throws on a truthy non-string cwd.
        Some(other) if super::js_truthy(other) => {
            return Answer::Forward("continuation_cwd_not_string");
        }
        _ => None,
    };
    let claude_home = frozen_claude_home(frozen);
    let usable =
        cwd.is_some_and(|c| !c.is_empty()) && claude_home.as_deref().is_some_and(|h| !h.is_empty());
    if !usable {
        return ok(
            "claude",
            "none",
            state("unknown", "context_unavailable"),
            vec![],
        );
    }
    let (cwd, home) = (cwd.unwrap(), claude_home.unwrap());
    let encoded = encode_claude_project_path(&resolve(&[cwd]));
    let result = stat_path(&join(&[
        &home,
        "projects",
        &encoded,
        &format!("{key}.jsonl"),
    ]));
    ok("claude", "frozen-home", artifact_state(result), vec![])
}
