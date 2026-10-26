//! TOML text to the value `@iarna/toml`'s `TOML.parse` returns, or a reason
//! raspd cannot say what it returns.
//!
//! toml_edit parses TOML 1.0; iarna parses 0.5 with its own leniencies.
//! Measured against iarna (bun 1.3.14, T-11838): it rejects arrays mixing
//! element types (`[1, 2.0]`, `[{}, []]`, but not `[[1], ["x"]]`), which 1.0
//! allows, so those are reported as `IarnaRejects`. Everything whose iarna
//! value or message raspd has not pinned down is `Unsupported`: dates and times
//! (JS `Date` objects), integers outside the safe range (BigInt), non-finite
//! floats, a BOM, `__proto__` keys and runs of four quotes (iarna mis-ends
//! multi-line strings that 1.0 accepts). A document toml_edit refuses is
//! `Unparsed`; iarna's message for it is not reproduced.
use crate::json::J;
use toml_edit::{Array, InlineTable, Item, Table, Value};

#[derive(Debug, PartialEq)]
pub enum TomlError {
    Unparsed,
    IarnaRejects,
    Unsupported(&'static str),
}

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub fn parse(content: &str) -> Result<J, TomlError> {
    if content.starts_with('\u{feff}') {
        return Err(TomlError::Unsupported("toml_bom"));
    }
    if content.contains("\"\"\"\"") || content.contains("''''") {
        return Err(TomlError::Unsupported("toml_quote_run"));
    }
    let doc = content
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| TomlError::Unparsed)?;
    table(doc.as_table())
}

fn key(k: &str) -> Result<String, TomlError> {
    if k == "__proto__" {
        return Err(TomlError::Unsupported("toml_proto_key"));
    }
    Ok(k.to_owned())
}

fn table(t: &Table) -> Result<J, TomlError> {
    let mut fields = vec![];
    for (k, item) in t.iter() {
        let v = match item {
            Item::None => continue,
            Item::Value(v) => value(v)?,
            Item::Table(t) => table(t)?,
            Item::ArrayOfTables(a) => J::Arr(a.iter().map(table).collect::<Result<_, _>>()?),
        };
        fields.push((key(k)?, v));
    }
    Ok(J::Obj(fields))
}

fn inline(t: &InlineTable) -> Result<J, TomlError> {
    let mut fields = vec![];
    for (k, v) in t.iter() {
        fields.push((key(k)?, value(v)?));
    }
    Ok(J::Obj(fields))
}

fn kind(v: &Value) -> &'static str {
    match v {
        Value::String(_) => "string",
        Value::Integer(_) => "integer",
        Value::Float(_) => "float",
        Value::Boolean(_) => "boolean",
        Value::Datetime(_) => "datetime",
        Value::Array(_) => "inline-list",
        Value::InlineTable(_) => "inline-table",
    }
}

fn array(a: &Array) -> Result<J, TomlError> {
    let mut items = vec![];
    let mut first: Option<&'static str> = None;
    for v in a.iter() {
        let k = kind(v);
        match first {
            None => first = Some(k),
            Some(f) if f != k => return Err(TomlError::IarnaRejects),
            _ => {}
        }
        items.push(v);
    }
    Ok(J::Arr(
        items.into_iter().map(value).collect::<Result<_, _>>()?,
    ))
}

fn value(v: &Value) -> Result<J, TomlError> {
    Ok(match v {
        Value::String(s) => J::Str(s.value().clone()),
        Value::Integer(i) => {
            let n = *i.value();
            if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n) {
                return Err(TomlError::Unsupported("toml_bigint"));
            }
            J::Num(n as f64)
        }
        Value::Float(f) => {
            let n = *f.value();
            if !n.is_finite() {
                return Err(TomlError::Unsupported("toml_nonfinite_float"));
            }
            J::Num(n)
        }
        Value::Boolean(b) => J::Bool(*b.value()),
        Value::Datetime(_) => return Err(TomlError::Unsupported("toml_datetime")),
        Value::Array(a) => array(a)?,
        Value::InlineTable(t) => inline(t)?,
    })
}
