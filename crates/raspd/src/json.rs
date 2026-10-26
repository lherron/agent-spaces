//! Order-preserving JSON for the replies raspd writes itself.
//!
//! Bun writes replies with `JSON.stringify`, so key order is insertion order
//! and numbers print the JavaScript way. raspd's native replies must match
//! byte for byte (the compare runner diffs them), so they are built and written
//! here rather than through `serde_json::Value`, whose maps sort their keys.
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt::{self, Write as _};

#[derive(Clone, Debug, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    /// Insertion order, as `JSON.parse` builds it: a repeated key keeps its
    /// first position and takes the last value.
    Obj(Vec<(String, J)>),
}

impl J {
    pub fn str(s: impl Into<String>) -> J {
        J::Str(s.into())
    }
    pub fn obj<const N: usize>(fields: [(&str, J); N]) -> J {
        J::Obj(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }
    pub fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    pub fn is_record(&self) -> bool {
        matches!(self, J::Obj(_))
    }
    /// `Object.keys` order: array-index keys ascending, then insertion order.
    pub fn js_entries(&self) -> Vec<(&str, &J)> {
        let J::Obj(fields) = self else {
            return vec![];
        };
        let mut indexed: Vec<(u32, &str, &J)> = vec![];
        let mut named = vec![];
        for (k, v) in fields {
            match array_index(k) {
                Some(n) => indexed.push((n, k, v)),
                None => named.push((k.as_str(), v)),
            }
        }
        indexed.sort_by_key(|(n, _, _)| *n);
        indexed
            .into_iter()
            .map(|(_, k, v)| (k, v))
            .chain(named)
            .collect()
    }
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }
    fn write(&self, out: &mut String) {
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(n) => out.push_str(&js_number(*n)),
            J::Str(s) => write_str(out, s),
            J::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            J::Obj(fields) => {
                out.push('{');
                for (i, (k, v)) in self.js_entries().into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_str(out, k);
                    out.push(':');
                    v.write(out);
                }
                let _ = fields;
                out.push('}');
            }
        }
    }
}

/// A canonical array index (`0`..`4294967294`), which JS objects order first.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u64>()
        .ok()
        .filter(|n| *n < 4_294_967_295)
        .map(|n| n as u32)
}

/// `JSON.stringify` of a number: ECMAScript `Number::toString`, from the
/// shortest round-trip digits (which Rust's `{:e}` also produces).
pub fn js_number(n: f64) -> String {
    if !n.is_finite() {
        return "null".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let sign = if n < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", n.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    // The decimal point sits after `point` digits: value = 0.digits × 10^point.
    let point = exp.parse::<i64>().unwrap_or(0) + 1;
    let body = if k <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - k) as usize))
    } else if 0 < point && point <= 21 {
        format!(
            "{}.{}",
            &digits[..point as usize],
            &digits[point as usize..]
        )
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let e = point - 1;
        let e = if e < 0 {
            format!("-{}", -e)
        } else {
            format!("+{e}")
        };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// `JSON.stringify` of a string: the two-character escapes, `\u00xx` (lower
/// case) for the other control characters, everything else literal.
pub fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn quoted(s: &str) -> String {
    let mut out = String::new();
    write_str(&mut out, s);
    out
}

impl<'de> Deserialize<'de> for J {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<J, D::Error> {
        deserializer.deserialize_any(JVisitor)
    }
}

struct JVisitor;

impl<'de> Visitor<'de> for JVisitor {
    type Value = J;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("JSON")
    }
    fn visit_unit<E: de::Error>(self) -> Result<J, E> {
        Ok(J::Null)
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<J, E> {
        Ok(J::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<J, E> {
        Ok(J::Num(v as f64))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<J, E> {
        Ok(J::Num(v as f64))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<J, E> {
        Ok(J::Num(v))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<J, E> {
        Ok(J::Str(v.to_owned()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<J, E> {
        Ok(J::Str(v))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<J, A::Error> {
        let mut items = vec![];
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(J::Arr(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<J, A::Error> {
        let mut fields: Vec<(String, J)> = vec![];
        while let Some((k, v)) = map.next_entry::<String, J>()? {
            match fields.iter_mut().find(|(existing, _)| *existing == k) {
                Some(slot) => slot.1 = v,
                None => fields.push((k, v)),
            }
        }
        Ok(J::Obj(fields))
    }
}

/// Parse one frame. `None` where serde_json and `JSON.parse` may disagree
/// (invalid UTF-8, lone surrogate escapes, numbers out of f64 range, deep
/// nesting): raspd forwards such a frame to Bun rather than judge it.
pub fn parse(bytes: &[u8]) -> Option<J> {
    serde_json::from_slice(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_like_json_stringify() {
        let v = parse(br#"{"b":1,"2":true,"a":[1.5,-0,1e21,"x\u0001\n"],"1":null,"b":2}"#).unwrap();
        assert_eq!(
            v.to_json(),
            r#"{"1":null,"2":true,"b":2,"a":[1.5,0,1e+21,"x\u0001\n"]}"#
        );
    }

    #[test]
    fn numbers_print_like_javascript() {
        for (n, js) in [
            (1.0, "1"),
            (-12.5, "-12.5"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"),
            (9007199254740993.0, "9007199254740992"),
            (2.5e-300, "2.5e-300"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
        ] {
            assert_eq!(js_number(n), js, "{n}");
        }
    }
}
