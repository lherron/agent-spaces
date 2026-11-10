//! The caller-supplied inspection boundary (spaces-runtime-contracts/agent-inspection.ts).
//! Validation is separate from evaluation; cataloging reuses the profile reader.
use super::{Fwd, fwd};
use crate::json::J;
use crate::reads::{jspath, profile};

fn text(v: Option<&J>) -> bool {
    v.and_then(J::as_str).is_some_and(|s| !s.is_empty())
}
fn fields(v: &J, names: &[&str]) -> bool {
    v.is_record() && names.iter().all(|n| text(v.get(n)))
}
fn strings(v: Option<&J>) -> bool {
    v.is_some_and(|v| v.is_record() && v.js_entries().iter().all(|(_, v)| text(Some(v))))
}
fn array(v: Option<&J>, valid: impl Fn(&J) -> bool) -> bool {
    v.and_then(J::as_arr).is_some_and(|a| a.iter().all(valid))
}
fn only(v: &J, keys: &[&str]) -> bool {
    v.is_record() && v.js_entries().iter().all(|(k, _)| keys.contains(k))
}
fn identity(v: Option<&J>) -> bool {
    v.is_some_and(|v| {
        fields(
            v,
            &["agentId", "projectId", "mode", "scope", "lane", "harness"],
        ) && v
            .get("harness")
            .and_then(J::as_str)
            .is_some_and(|h| profile::HARNESS_IDS.contains(&h))
            && matches!(v.get("presentation"), Some(J::Bool(_)))
            && ["agentName", "taskId"]
                .iter()
                .all(|n| v.get(n).is_none() || text(v.get(n)))
    })
}
fn overrides(v: Option<&J>) -> bool {
    v.is_some_and(|v| {
        only(v, &["modelId", "reasoningEffort", "executionProfileId"])
            && v.js_entries().iter().all(|(k, v)| {
                if *k == "reasoningEffort" {
                    v.as_str()
                        .is_some_and(|s| ["low", "medium", "high", "xhigh"].contains(&s))
                } else {
                    text(Some(v))
                }
            })
    })
}
pub fn context(v: &J) -> bool {
    v.is_record()
        && v.get("schemaVersion") == Some(&J::str("agent-inspection-evaluation-context/v2"))
        && identity(v.get("identifiers"))
        && v.get("paths")
            .is_some_and(|p| fields(p, &["agentRoot", "agentsRoot", "projectRoot", "cwd"]))
        && text(v.get("nowIso"))
        && strings(v.get("environment"))
        && ["predicateInputs", "execInputs"].iter().all(|k| {
            v.get(k)
                .is_some_and(|i| fields(i, &["cwd"]) && strings(i.get("environment")))
        })
        && v.get("serviceProbeInputs").is_some_and(|i| {
            i.is_record()
                && array(i.get("responses"), |r| {
                    fields(r, &["name", "endpoint"]) && matches!(r.get("up"), Some(J::Bool(_)))
                })
        })
        && array(v.get("scaffoldPackets"), |p| {
            fields(p, &["slot"])
                && ["content", "ref"]
                    .iter()
                    .all(|k| p.get(k).is_none() || text(p.get(k)))
        })
        && v.get("agentProfile").is_some_and(J::is_record)
        && overrides(v.get("declaredOverrides"))
        && v.get("compileContext").is_some_and(|c| {
            fields(c, &["nowIso", "idSalt"])
                && c.get("toolchainManifest").is_some_and(|m| {
                    fields(m, &["schemaVersion"])
                        && (m.get("tools").is_none()
                            || array(m.get("tools"), |t| fields(t, &["name", "version"])))
                        && m.get("modelCatalog").is_none_or(J::is_record)
                })
        })
}
pub fn valid(params: Option<&J>, inspect: bool) -> bool {
    params.is_some_and(|p| {
        only(
            p,
            if inspect {
                &["request", "evaluationContext"]
            } else {
                &["evaluationContext"]
            },
        ) && p.get("evaluationContext").is_some_and(context)
            && (!inspect
                || p.get("request").is_some_and(|r| {
                    only(r, &["schemaVersion", "identifiers", "declaredOverrides"])
                        && r.get("schemaVersion") == Some(&J::str("agent-inspection-request/v2"))
                        && identity(r.get("identifiers"))
                        && overrides(r.get("declaredOverrides"))
                }))
    })
}

pub fn catalog(context: &J) -> Result<J, Fwd> {
    let root = context
        .get("paths")
        .and_then(|p| p.get("agentsRoot"))
        .and_then(J::as_str)
        .unwrap();
    let mut names: Vec<String> = std::fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| std::path::Path::new(&jspath::join(&[root, n, "agent-profile.toml"])).exists())
        .collect();
    names.sort_by(|a, b| locale_compare(a, b));
    let mut agents = vec![];
    for name in names {
        let dir = jspath::join(&[root, &name]);
        let path = jspath::join(&[&dir, "agent-profile.toml"]);
        let mut diagnostics = vec![];
        let parsed = match jspath::read_text(&path) {
            Ok(s) => match profile::catalog_parse(&s) {
                Ok(p) => Some(p),
                Err(profile::ProfileError::Invalid(message)) => {
                    diagnostics.push(J::obj([
                        ("severity", J::str("error")),
                        ("code", J::str("invalid_agent_profile")),
                        ("message", J::str(message)),
                    ]));
                    None
                }
                Err(profile::ProfileError::Forward(r)) => return Err(fwd(r)),
            },
            Err(_) => return Err(fwd(crate::reason!("profile_unreadable"))),
        };
        let id = context.get("identifiers").unwrap();
        let mut row = J::obj([
            ("agentId", J::str(&name)),
            (
                "displayName",
                J::str(
                    parsed
                        .as_ref()
                        .and_then(|p| p.identity_display.as_deref())
                        .unwrap_or(&name),
                ),
            ),
            (
                "role",
                parsed
                    .as_ref()
                    .and_then(|p| p.identity_role.as_ref())
                    .map(J::str)
                    .unwrap_or(J::Null),
            ),
            (
                "sourceAvailability",
                J::obj([
                    ("profile", J::Bool(true)),
                    (
                        "soul",
                        J::Bool(std::path::Path::new(&jspath::join(&[&dir, "SOUL.md"])).exists()),
                    ),
                    (
                        "contextTemplate",
                        J::Bool(
                            std::path::Path::new(&jspath::join(&[&dir, "context-template.toml"]))
                                .exists(),
                        ),
                    ),
                ]),
            ),
            (
                "defaultContextSummary",
                J::Obj(
                    ["projectId", "mode", "lane", "harness", "presentation"]
                        .iter()
                        .map(|k| ((*k).into(), id.get(k).unwrap().clone()))
                        .collect(),
                ),
            ),
            ("warningCount", J::Num(0.0)),
            ("errorCount", J::Num(diagnostics.len() as f64)),
            ("diagnostics", J::Arr(diagnostics)),
        ]);
        if let Some(avatar) = parsed.and_then(|p| p.identity_avatar) {
            row.set("avatarUrl", J::str(avatar));
        }
        agents.push(row);
    }
    Ok(J::obj([("agents", J::Arr(agents))]))
}

/// Bun's en-US localeCompare on the supported macOS host, through the system ICU collation.
fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use std::ffi::c_void;
    #[repr(C)]
    struct Range {
        location: isize,
        length: isize,
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithBytes(
            allocator: *const c_void,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            external: bool,
        ) -> *const c_void;
        fn CFStringGetLength(string: *const c_void) -> isize;
        fn CFLocaleCreate(allocator: *const c_void, identifier: *const c_void) -> *const c_void;
        fn CFStringCompareWithOptionsAndLocale(
            a: *const c_void,
            b: *const c_void,
            range: Range,
            options: usize,
            locale: *const c_void,
        ) -> isize;
        fn CFRelease(value: *const c_void);
    }
    // SAFETY: each UTF-8 slice lives through its copying CF constructor; every
    // owned CF reference is released after the comparison and none escapes.
    unsafe {
        let make = |v: &str| {
            CFStringCreateWithBytes(
                std::ptr::null(),
                v.as_ptr(),
                v.len() as isize,
                0x08000100,
                false,
            )
        };
        let a = make(a);
        let b = make(b);
        let id = make("en_US");
        let locale = CFLocaleCreate(std::ptr::null(), id);
        let result = CFStringCompareWithOptionsAndLocale(
            a,
            b,
            Range {
                location: 0,
                length: CFStringGetLength(a),
            },
            0,
            locale,
        );
        for value in [a, b, id, locale] {
            CFRelease(value);
        }
        result.cmp(&0)
    }
}
