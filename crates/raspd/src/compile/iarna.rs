//! `TOML.stringify` from @iarna/toml 2.2.5 (node_modules/@iarna/toml/stringify.js),
//! byte for byte over the values raspd hands it: codex config.toml is written
//! by it (the bundle template, after a canonical-JSON round trip) and rewritten
//! by it (the runtime home's hook trust). Keys go out in `Object.keys` order.
use super::{Fwd, fwd};
use crate::json::{J, js_number};

#[derive(Clone, Copy, PartialEq)]
enum Type {
    Null,
    Integer,
    Float,
    Boolean,
    String,
    Array,
    Table,
}

fn toml_type(v: &J) -> Type {
    match v {
        J::Null => Type::Null,
        J::Num(n) if n.is_finite() && n.fract() == 0.0 && !(*n == 0.0 && n.is_sign_negative()) => {
            Type::Integer
        }
        J::Num(_) => Type::Float,
        J::Bool(_) => Type::Boolean,
        J::Str(_) => Type::String,
        J::Arr(_) => Type::Array,
        J::Obj(_) => Type::Table,
    }
}

fn is_inline(v: &J) -> bool {
    match v {
        J::Arr(items) => items.first().is_none_or(|f| toml_type(f) != Type::Table),
        J::Obj(fields) => fields.is_empty(),
        _ => true,
    }
}

/// `TOML.stringify(obj)` for a table; a mixed-type array throws in iarna.
pub fn stringify(obj: &J) -> Result<String, Fwd> {
    if !obj.is_record() {
        return Err(fwd("toml_stringify_type"));
    }
    stringify_object("", "", obj)
}

fn stringify_object(prefix: &str, indent: &str, obj: &J) -> Result<String, Fwd> {
    let entries = obj.js_entries();
    let inline: Vec<&(&str, &J)> = entries.iter().filter(|(_, v)| is_inline(v)).collect();
    let complex: Vec<&(&str, &J)> = entries.iter().filter(|(_, v)| !is_inline(v)).collect();
    let mut result: Vec<String> = vec![];
    for (k, v) in &inline {
        if toml_type(v) != Type::Null {
            result.push(format!("{indent}{} = {}", key(k), any_inline(v, true)?));
        }
    }
    if !result.is_empty() {
        result.push(String::new());
    }
    let complex_indent = if !prefix.is_empty() && !inline.is_empty() {
        format!("{indent}  ")
    } else {
        String::new()
    };
    for (k, v) in &complex {
        result.push(stringify_complex(prefix, &complex_indent, k, v)?);
    }
    Ok(result.join("\n"))
}

fn key(k: &str) -> String {
    if !k.is_empty()
        && k
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        k.to_owned()
    } else {
        basic_string(k)
    }
}

fn basic_string(s: &str) -> String {
    format!("\"{}\"", escape(s).replace('"', "\\\""))
}

fn escape(s: &str) -> String {
    let replaced = s
        .replace('\\', "\\\\")
        .replace('\u{8}', "\\b")
        .replace('\t', "\\t")
        .replace('\n', "\\n")
        .replace('\u{c}', "\\f")
        .replace('\r', "\\r");
    // `.replace(/([\u0000-\u001f\u007f])/, …)`: not global, the first only.
    match replaced.find(|c: char| (c as u32) < 0x20 || c == '\u{7f}') {
        Some(at) => {
            let c = replaced[at..].chars().next().expect("found");
            format!(
                "{}\\u{:04x}{}",
                &replaced[..at],
                c as u32,
                &replaced[at + c.len_utf8()..]
            )
        }
        None => replaced,
    }
}

fn multiline_string(s: &str) -> String {
    let mut escaped = s
        .split('\n')
        .map(|line| {
            // `.replace(/"(?="")/g, '\\"')`: a quote followed by two quotes.
            let e = escape(line);
            let chars: Vec<char> = e.chars().collect();
            let mut out = String::new();
            for (i, c) in chars.iter().enumerate() {
                if *c == '"' && chars.get(i + 1) == Some(&'"') && chars.get(i + 2) == Some(&'"') {
                    out.push('\\');
                }
                out.push(*c);
            }
            out
        })
        .collect::<Vec<_>>()
        .join("\n");
    if escaped.ends_with('"') {
        escaped.push_str("\\\n");
    }
    format!("\"\"\"\n{escaped}\"\"\"")
}

fn any_inline(v: &J, multiline_ok: bool) -> Result<String, Fwd> {
    if let J::Str(s) = v {
        if multiline_ok && s.contains('\n') {
            return Ok(multiline_string(s));
        }
        if !s.contains(['\u{8}', '\t', '\n', '\u{c}', '\r', '\'']) && s.contains('"') {
            return Ok(format!("'{s}'"));
        }
    }
    inline_value(v, toml_type(v))
}

fn integer(text: &str) -> String {
    // `.replace(/\B(?=(\d{3})+(?!\d))/g, '_')`.
    let chars: Vec<char> = text.chars().collect();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::new();
    for i in 0..chars.len() {
        if i > 0 && word(chars[i - 1]) == word(chars[i]) {
            let run = chars[i..].iter().take_while(|c| c.is_ascii_digit()).count();
            if run > 0 && run % 3 == 0 {
                out.push('_');
            }
        }
        out.push(chars[i]);
    }
    out
}

fn float(n: f64) -> String {
    if n.is_infinite() {
        return if n > 0.0 { "inf" } else { "-inf" }.into();
    }
    if n.is_nan() {
        return "nan".into();
    }
    if n == 0.0 && n.is_sign_negative() {
        return "-0.0".into();
    }
    let text = js_number(n);
    let mut chunks = text.split('.');
    let int = chunks.next().unwrap_or_default();
    let dec = chunks.next().unwrap_or("0");
    format!("{}.{dec}", integer(int))
}

fn inline_value(v: &J, t: Type) -> Result<String, Fwd> {
    Ok(match (t, v) {
        (Type::String, J::Str(s)) => basic_string(s),
        (Type::Integer, J::Num(n)) => integer(&js_number(*n)),
        (Type::Float, J::Num(n)) => float(*n),
        (Type::Boolean, J::Bool(b)) => b.to_string(),
        (Type::Array, J::Arr(items)) => {
            inline_array(&items.iter().filter(|i| !matches!(i, J::Null)).collect::<Vec<_>>())?
        }
        (Type::Table, J::Obj(_)) => inline_table(v)?,
        _ => return Err(fwd("toml_stringify_type")),
    })
}

fn array_type(values: &[&J]) -> Result<Type, Fwd> {
    let Some(first) = values.first() else {
        return Ok(Type::Null);
    };
    let t = toml_type(first);
    if values.iter().all(|v| toml_type(v) == t) {
        return Ok(t);
    }
    if values
        .iter()
        .all(|v| matches!(toml_type(v), Type::Integer | Type::Float))
    {
        return Ok(Type::Float);
    }
    Err(fwd("toml_mixed_array"))
}

fn inline_array(values: &[&J]) -> Result<String, Fwd> {
    let t = array_type(values)?;
    let items = values
        .iter()
        .map(|v| inline_value(v, t))
        .collect::<Result<Vec<_>, _>>()?;
    let joined = items.join(", ");
    // `/\n/.test(stringified)` tests the array's comma-joined string.
    Ok(if joined.chars().count() > 60 || items.iter().any(|i| i.contains('\n')) {
        format!("[\n  {}\n]", items.join(",\n  "))
    } else if items.is_empty() {
        "[ ]".into()
    } else {
        format!("[ {joined} ]")
    })
}

fn inline_table(v: &J) -> Result<String, Fwd> {
    let parts = v
        .js_entries()
        .into_iter()
        .map(|(k, v)| Ok(format!("{} = {}", key(k), any_inline(v, false)?)))
        .collect::<Result<Vec<_>, Fwd>>()?;
    Ok(if parts.is_empty() {
        "{ }".into()
    } else {
        format!("{{ {} }}", parts.join(", "))
    })
}

fn stringify_complex(prefix: &str, indent: &str, k: &str, v: &J) -> Result<String, Fwd> {
    let full = format!("{prefix}{}", key(k));
    match v {
        J::Arr(tables) => {
            array_type(&tables.iter().collect::<Vec<_>>())?;
            let mut out = String::new();
            for table in tables {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(&format!("{indent}[[{full}]]\n"));
                out.push_str(&stringify_object(&format!("{full}."), indent, table)?);
            }
            Ok(out)
        }
        J::Obj(_) => {
            let mut out = String::new();
            if v.js_entries().iter().any(|(_, x)| is_inline(x)) {
                out.push_str(&format!("{indent}[{full}]\n"));
            }
            out.push_str(&stringify_object(&format!("{full}."), indent, v)?);
            Ok(out)
        }
        _ => Err(fwd("toml_stringify_type")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> J {
        crate::json::parse(s.as_bytes()).expect("json")
    }

    #[test]
    fn layout_matches_iarna() {
        // Expected bytes produced by node_modules/@iarna/toml 2.2.5.
        let v = parse(
            r#"{"a":"x","n":200000,"arr":["AGENTS.md","AGENT.md"],"q":"say \"hi\"","features":{"hooks":true},"hooks":{"state":{"/p/hooks.json:stop:0:0":{"trusted_hash":"sha256:ab"}}},"mcp_servers":{"s":{"command":"c","enabled":true,"env":{"K":"V"}}},"empty":{},"tui":{"status_line":["model-with-reasoning","context-remaining","current-dir"]}}"#,
        );
        let expected = "a = \"x\"\nn = 200_000\narr = [ \"AGENTS.md\", \"AGENT.md\" ]\nq = 'say \"hi\"'\nempty = { }\n\n[features]\nhooks = true\n\n[hooks.state.\"/p/hooks.json:stop:0:0\"]\ntrusted_hash = \"sha256:ab\"\n\n[mcp_servers.s]\ncommand = \"c\"\nenabled = true\n\n  [mcp_servers.s.env]\n  K = \"V\"\n\n[tui]\nstatus_line = [ \"model-with-reasoning\", \"context-remaining\", \"current-dir\" ]\n";
        assert_eq!(stringify(&v).unwrap(), expected);
        let v = parse(r#"{"m":"a\nb\"","c":"x\u0001y\u0002","f":5.25,"big":1234567.5}"#);
        let expected = "m = \"\"\"\na\nb\"\\\n\"\"\"\nc = \"x\\u0001y\u{2}\"\nf = 5.25\nbig = 1_234_567.5\n";
        assert_eq!(stringify(&v).unwrap(), expected);
        let v = parse(r#"{"negative":-1234567,"small":999,"fraction":0.5}"#);
        assert_eq!(
            stringify(&v).unwrap(),
            "negative = -1_234_567\nsmall = 999\nfraction = 0.5\n"
        );
    }
}
