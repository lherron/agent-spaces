//! `validateLockFile`: core/config/src/core/schemas/lock.schema.json under
//! Ajv (strict, ajv-formats' full `date-time`), as a verdict. A
//! global-lock.json Bun rejects is refused before raspd merges or rewrites it
//! (T-13018 r2 section 2.2).
use crate::json::J;

fn kebab(s: &str) -> bool {
    // ^[a-z0-9]+(?:-[a-z0-9]+)*$
    !s.is_empty()
        && s.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

fn hex_len(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `commitRef`: 7-64 hex, or dev, project, agent.
fn commit_ref(s: &str) -> bool {
    hex_len(s, 7, 64) || matches!(s, "dev" | "project" | "agent")
}

/// `sha256Integrity`.
fn integrity(s: &str) -> bool {
    s.strip_prefix("sha256:")
        .is_some_and(|rest| hex_len(rest, 64, 64) || matches!(rest, "dev" | "project" | "agent"))
}

/// `spaceKey`: `<kebab id>@<commitRef>`.
fn space_key(s: &str) -> bool {
    s.split_once('@')
        .is_some_and(|(id, commit)| kebab(id) && commit_ref(commit))
}

/// `spaceRef`.
fn space_ref(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("space:") else {
        return false;
    };
    // `<kebab>(?:@.+)?`
    let id_with_selector = |r: &str| match r.split_once('@') {
        Some((id, selector)) => kebab(id) && !selector.is_empty(),
        None => kebab(r),
    };
    if let Some(r) = rest.strip_prefix("agent:") {
        return id_with_selector(r);
    }
    if let Some(r) = rest.strip_prefix("project:") {
        return id_with_selector(r);
    }
    if let Some(r) = rest.strip_prefix("path:")
        && let Some((path, selector)) = r.split_once('@')
        && !path.is_empty()
        && !selector.is_empty()
    {
        return true;
    }
    id_with_selector(rest)
}

fn string(v: Option<&J>) -> Option<&str> {
    match v {
        Some(J::Str(s)) => Some(s),
        _ => None,
    }
}

fn only(v: &J, allowed: &[&str]) -> bool {
    v.js_entries().iter().all(|(k, _)| allowed.contains(k))
}

fn strings_all(v: Option<&J>, item: impl Fn(&str) -> bool) -> bool {
    matches!(v, Some(J::Arr(items)) if items.iter().all(|i| string(Some(i)).is_some_and(&item)))
}

fn optional(v: Option<&J>, ok: impl Fn(&J) -> bool) -> bool {
    v.is_none_or(ok)
}

fn is_int_one(v: Option<&J>) -> bool {
    matches!(v, Some(J::Num(n)) if *n == 1.0)
}

/// ajv-formats' full `date-time` (RFC 3339, time zone required).
fn date_time(s: &str) -> bool {
    let parts: Vec<&str> = s.split(['t', 'T', ' ', '\t', '\n', '\r']).collect();
    let [date, time] = parts.as_slice() else {
        return false;
    };
    let d = date.as_bytes();
    if d.len() != 10 || d[4] != b'-' || d[7] != b'-' {
        return false;
    }
    let num = |b: &[u8]| -> Option<u32> {
        b.iter()
            .all(u8::is_ascii_digit)
            .then(|| std::str::from_utf8(b).ok()?.parse().ok())
            .flatten()
    };
    let (Some(year), Some(month), Some(day)) = (num(&d[0..4]), num(&d[5..7]), num(&d[8..10]))
    else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    const DAYS: [u32; 13] = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&month)
        || day < 1
        || day
            > if month == 2 && leap {
                29
            } else {
                DAYS[month as usize]
            }
    {
        return false;
    }
    // ^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$ with the zone required.
    let t = time.as_bytes();
    if t.len() < 8 || t[2] != b':' || t[5] != b':' {
        return false;
    }
    let (Some(hr), Some(min)) = (num(&t[0..2]), num(&t[3..5])) else {
        return false;
    };
    let mut i = 8;
    if num(&t[6..8]).is_none() {
        return false;
    }
    if i < t.len() && t[i] == b'.' {
        let start = i + 1;
        i = start;
        while i < t.len() && t[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    let sec: f64 = match std::str::from_utf8(&t[6..i])
        .ok()
        .and_then(|x| x.parse().ok())
    {
        Some(v) => v,
        None => return false,
    };
    let zone = &t[i..];
    let (sign, tz_h, tz_m) = match zone {
        [b'z' | b'Z'] => (1i32, 0u32, 0u32),
        [s @ (b'+' | b'-'), h1, h2, rest @ ..] => {
            let Some(h) = num(&[*h1, *h2]) else {
                return false;
            };
            let m = match rest {
                [] => 0,
                [b':', m1, m2] | [m1, m2] => match num(&[*m1, *m2]) {
                    Some(m) => m,
                    None => return false,
                },
                _ => return false,
            };
            (if *s == b'-' { -1 } else { 1 }, h, m)
        }
        _ => return false,
    };
    if tz_h > 23 || tz_m > 59 {
        return false;
    }
    if hr <= 23 && min <= 59 && sec < 60.0 {
        return true;
    }
    // A leap second, at 23:59 UTC.
    let utc_min = min as i32 - tz_m as i32 * sign;
    let utc_hr = hr as i32 - tz_h as i32 * sign - i32::from(utc_min < 0);
    (utc_hr == 23 || utc_hr == -1) && (utc_min == 59 || utc_min == -1) && sec < 61.0
}

fn warning(w: &J) -> bool {
    w.is_record()
        && string(w.get("code")).is_some()
        && string(w.get("message")).is_some()
        && optional(w.get("details"), J::is_record)
        && only(w, &["code", "message", "details"])
}

fn warnings(v: Option<&J>) -> bool {
    optional(
        v,
        |w| matches!(w, J::Arr(items) if items.iter().all(warning)),
    )
}

fn space_entry(e: &J) -> bool {
    let plugin_ok = e.get("plugin").is_some_and(|p| {
        p.is_record()
            && string(p.get("name")).is_some()
            && optional(p.get("version"), |v| matches!(v, J::Str(_)))
            && only(p, &["name", "version"])
    });
    let deps_ok = e.get("deps").is_some_and(|d| {
        d.is_record() && strings_all(d.get("spaces"), space_key) && only(d, &["spaces"])
    });
    let resolved_ok = optional(e.get("resolvedFrom"), |r| {
        r.is_record()
            && ["selector", "tag", "semver"]
                .iter()
                .all(|k| optional(r.get(k), |v| matches!(v, J::Str(_))))
            && only(r, &["selector", "tag", "semver"])
    });
    e.is_record()
        && string(e.get("id")).is_some()
        && string(e.get("commit")).is_some_and(commit_ref)
        && string(e.get("path")).is_some()
        && string(e.get("integrity")).is_some_and(integrity)
        && plugin_ok
        && deps_ok
        && resolved_ok
        && optional(e.get("projectSpace"), |v| matches!(v, J::Bool(_)))
        && optional(e.get("agentSpace"), |v| matches!(v, J::Bool(_)))
        && only(
            e,
            &[
                "id",
                "commit",
                "path",
                "integrity",
                "plugin",
                "deps",
                "resolvedFrom",
                "projectSpace",
                "agentSpace",
            ],
        )
}

fn target_entry(t: &J) -> bool {
    let harnesses_ok = optional(t.get("harnesses"), |h| {
        h.is_record()
            && h.js_entries().iter().all(|(_, e)| {
                e.is_record()
                    && string(e.get("envHash")).is_some_and(integrity)
                    && warnings(e.get("warnings"))
                    && only(e, &["envHash", "warnings"])
            })
    });
    t.is_record()
        && strings_all(t.get("compose"), space_ref)
        && strings_all(t.get("roots"), space_key)
        && strings_all(t.get("loadOrder"), space_key)
        && string(t.get("envHash")).is_some_and(integrity)
        && warnings(t.get("warnings"))
        && harnesses_ok
        && only(
            t,
            &[
                "compose",
                "roots",
                "loadOrder",
                "envHash",
                "warnings",
                "harnesses",
            ],
        )
}

fn registry(r: &J) -> bool {
    let url = string(r.get("url"));
    let repository = r.get("repository");
    let remote = r.get("canonicalRemote");
    let first = url.is_some();
    let second = matches!(repository, Some(J::Str(_))) && matches!(remote, Some(J::Str(_)));
    r.is_record()
        && r.get("type") == Some(&J::str("git"))
        && optional(r.get("url"), |v| matches!(v, J::Str(_)))
        && optional(repository, |v| string(Some(v)).is_some_and(kebab))
        && optional(remote, |v| string(Some(v)).is_some_and(|s| !s.is_empty()))
        && optional(r.get("defaultBranch"), |v| matches!(v, J::Str(_)))
        && first != second
        && only(
            r,
            &[
                "type",
                "url",
                "repository",
                "canonicalRemote",
                "defaultBranch",
            ],
        )
}

/// Whether Bun's `validateLockFile` accepts `lock`.
pub fn valid(lock: &J) -> bool {
    let entries = |key: &str, each: fn(&J) -> bool| {
        lock.get(key)
            .is_some_and(|v| v.is_record() && v.js_entries().iter().all(|(_, e)| each(e)))
    };
    lock.is_record()
        && is_int_one(lock.get("lockfileVersion"))
        && is_int_one(lock.get("resolverVersion"))
        && string(lock.get("generatedAt")).is_some_and(date_time)
        && lock.get("registry").is_some_and(registry)
        && entries("spaces", space_entry)
        && entries("targets", target_entry)
        && only(
            lock,
            &[
                "lockfileVersion",
                "resolverVersion",
                "generatedAt",
                "registry",
                "spaces",
                "targets",
            ],
        )
}
