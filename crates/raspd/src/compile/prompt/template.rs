//! The context template: its model, `parseContextTemplate`
//! (context-template.ts) and `buildDefaultTemplate` (system-prompt.ts).
use super::when::When;
use crate::compile::{Fwd, fwd};
use crate::json::J;
use crate::reads::toml::{self, TomlError};

/// A section's content source.
#[derive(Clone)]
pub(super) enum Body {
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
pub(super) struct Section {
    pub(super) name: String,
    pub(super) when: Option<When>,
    pub(super) max_chars: Option<usize>,
    pub(super) wrap: Option<(Option<String>, Option<String>)>,
    pub(super) body: Body,
}

impl Section {
    /// A section with no predicate, size bound or wrap.
    fn plain(name: String, body: Body) -> Self {
        Self {
            name,
            when: None,
            max_chars: None,
            wrap: None,
            body,
        }
    }
}

pub struct Template {
    pub append: bool,
    pub(super) max_chars: Option<usize>,
    pub(super) prompt: Vec<Section>,
    pub(super) reminder: Vec<Section>,
}

fn bad<T>() -> Result<T, Fwd> {
    // A template Bun would reject: its message is not reproduced.
    Err(fwd(crate::reason!("context_template_invalid")))
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
    let name = req_str(v.get("name"))?;
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
        name,
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

fn optional_file(path: &str) -> Body {
    Body::File {
        path: path.to_owned(),
        required: false,
    }
}

/// `buildDefaultTemplate(base, scaffoldPackets)` (no scaffold packets).
pub fn default_template(base: &[String]) -> Template {
    let mut prompt = vec![Section::plain(
        "soul".into(),
        optional_file("agent-root:///SOUL.md"),
    )];
    for (i, r) in base.iter().enumerate() {
        prompt.push(Section::plain(
            format!("additional-base-{i}"),
            optional_file(r),
        ));
    }
    prompt.push(Section {
        when: Some(When {
            run_mode: Some("heartbeat".into()),
            ..When::default()
        }),
        ..Section::plain(
            "heartbeat".into(),
            optional_file("agent-root:///HEARTBEAT.md"),
        )
    });
    Template {
        append: false,
        max_chars: None,
        prompt,
        reminder: vec![],
    }
}

/// Default prompt sections with the caller's scaffold packets, in source order.
pub fn default_template_with_scaffold(base: &[String], packets: &J) -> Result<Template, Fwd> {
    let mut t = default_template(base);
    for (i, packet) in packets
        .as_arr()
        .ok_or_else(|| fwd(crate::reason!("invalid_params")))?
        .iter()
        .enumerate()
    {
        for (key, prefix) in [("content", "scaffold-inline"), ("ref", "scaffold-ref")] {
            if let Some(value) = packet
                .get(key)
                .and_then(J::as_str)
                .filter(|v| !v.is_empty())
            {
                let body = if key == "content" {
                    Body::Inline(value.into())
                } else {
                    optional_file(value)
                };
                t.prompt.push(Section::plain(format!("{prefix}-{i}"), body));
            }
        }
    }
    Ok(t)
}
