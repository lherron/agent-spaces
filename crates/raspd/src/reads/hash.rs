//! `createCanonicalHasher()` with the default policy (sha256-canonical-json/v1):
//! keys sorted by UTF-16 code unit, no whitespace, strings and numbers as
//! `JSON.stringify` writes them.
//! Source: contracts/spaces-runtime-contracts/src/hash.ts.
use crate::json::{J, js_number, write_str};
use sha2::{Digest, Sha256};

pub fn canonicalize(value: &J) -> String {
    let mut out = String::new();
    serialize(value, &mut out);
    out
}

fn serialize(value: &J, out: &mut String) {
    match value {
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
                serialize(item, out);
            }
            out.push(']');
        }
        J::Obj(fields) => {
            let mut keys: Vec<&(String, J)> = fields.iter().collect();
            keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            out.push('{');
            for (i, (k, v)) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_str(out, k);
                out.push(':');
                serialize(v, out);
            }
            out.push('}');
        }
    }
}

pub fn hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// `hasher.hash(value).value`.
pub fn hash(value: &J) -> String {
    hex(&canonicalize(value))
}
