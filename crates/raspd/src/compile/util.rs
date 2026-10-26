//! JavaScript semantics the compile path depends on: UTF-16 string lengths
//! and slices, `String.prototype.trim`, the canonical hasher with its
//! `omit-ephemeral` policy, path-segment sanitizing, and `crypto.randomUUID`.
use crate::json::{J, js_number, write_str};
use sha2::{Digest, Sha256};

/// `string.length`.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `string.slice(start, end)` in UTF-16 units, or `None` when a bound would
/// split a surrogate pair (JS would produce a lone surrogate there).
pub fn utf16_slice(s: &str, start: usize, end: usize) -> Option<String> {
    let units: Vec<u16> = s.encode_utf16().collect();
    let end = end.min(units.len());
    let start = start.min(end);
    String::from_utf16(&units[start..end]).ok()
}

/// The UTF-16 unit at `index` (`string[index]`), if any.
pub fn utf16_at(s: &str, index: usize) -> Option<u16> {
    s.encode_utf16().nth(index)
}

/// ECMAScript WhiteSpace and LineTerminator code points.
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(js_space)
}

/// `sanitizeProjectAgentScopeSegment` (store/paths.ts).
pub fn sanitize_segment(value: &str) -> String {
    let lowered = js_trim(value).to_lowercase();
    let mut out = String::new();
    let mut in_run = false;
    for c in lowered.chars() {
        let keep = c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-');
        if keep {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    // `.replace(/-+/g, '-')`
    let mut collapsed = String::new();
    for c in out.chars() {
        if c == '-' && collapsed.ends_with('-') {
            continue;
        }
        collapsed.push(c);
    }
    let trimmed = collapsed.trim_matches(|c| matches!(c, '-' | '_' | '.'));
    if trimmed.is_empty() {
        "default".into()
    } else {
        trimmed.to_owned()
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn sha1_hex(bytes: &[u8]) -> String {
    use sha1::Sha1;
    let digest = Sha1::digest(bytes);
    let mut out = String::with_capacity(40);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Field names `timestampMode: 'omit-ephemeral'` drops:
/// `/(?:_at|At|_ts|Ts|timestamp|Timestamp)$/`.
fn ephemeral_timestamp(key: &str) -> bool {
    ["_at", "At", "_ts", "Ts", "timestamp", "Timestamp"]
        .iter()
        .any(|suffix| key.ends_with(suffix))
}

/// `createCanonicalHasher().canonicalize(value, policy)`, keys sorted by
/// UTF-16 code unit.
pub fn canonicalize(value: &J, omit_ephemeral: bool) -> String {
    let mut out = String::new();
    serialize(value, omit_ephemeral, &mut out);
    out
}

fn serialize(value: &J, omit: bool, out: &mut String) {
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
                serialize(item, omit, out);
            }
            out.push(']');
        }
        J::Obj(fields) => {
            let mut keys: Vec<&(String, J)> = fields
                .iter()
                .filter(|(k, _)| !(omit && ephemeral_timestamp(k)))
                .collect();
            keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            out.push('{');
            for (i, (k, v)) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_str(out, k);
                out.push(':');
                serialize(v, omit, out);
            }
            out.push('}');
        }
    }
}

/// `hasher.hash(value, { timestampMode }).value`.
pub fn hash(value: &J, omit_ephemeral: bool) -> String {
    sha256_hex(canonicalize(value, omit_ephemeral).as_bytes())
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    // SAFETY: arc4random_buf fills exactly `N` bytes of a valid buffer.
    unsafe { libc::arc4random_buf(buf.as_mut_ptr().cast(), N) };
    buf
}

/// `crypto.randomUUID()`: a lowercase RFC 4122 version-4 UUID.
pub fn random_uuid() -> String {
    let mut b = random_bytes::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: Vec<String> = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        h[0..4].concat(),
        h[4..6].concat(),
        h[6..8].concat(),
        h[8..10].concat(),
        h[10..16].concat()
    )
}

pub fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Milliseconds since the epoch, as `Date.now()`.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// The environment this process was exec'd with, which is what Bun's
/// `process.env` holds. raspd's live environment can differ: CoreFoundation
/// (linked for the local time zone) sets `__CF_USER_TEXT_ENCODING` in-process
/// at load. Read from `KERN_PROCARGS2`; the live environment if that fails.
pub fn exec_environment() -> &'static std::collections::BTreeMap<String, String> {
    use std::collections::BTreeMap;
    use std::sync::OnceLock;
    static ENV: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        procargs_env().unwrap_or_else(|| {
            std::env::vars_os()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.to_string_lossy().into_owned(),
                    )
                })
                .collect()
        })
    })
}

fn procargs_env() -> Option<std::collections::BTreeMap<String, String>> {
    let mut mib = [
        libc::CTL_KERN,
        libc::KERN_PROCARGS2,
        std::process::id() as libc::c_int,
    ];
    let mut size: libc::size_t = 0;
    // SAFETY: sysctl with a null buffer reports the size it needs.
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    let mut buf = vec![0u8; size];
    // SAFETY: `buf` has `size` writable bytes.
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    buf.truncate(size);
    let argc = i32::from_ne_bytes(buf.get(..4)?.try_into().ok()?) as usize;
    let mut at = 4;
    // The exec path, then NUL padding.
    while at < buf.len() && buf[at] != 0 {
        at += 1;
    }
    while at < buf.len() && buf[at] == 0 {
        at += 1;
    }
    let mut strings = buf[at..].split(|b| *b == 0);
    for _ in 0..argc {
        strings.next()?;
    }
    let mut env = std::collections::BTreeMap::new();
    for entry in strings {
        if entry.is_empty() {
            break;
        }
        let text = String::from_utf8_lossy(entry);
        if let Some((k, v)) = text.split_once('=') {
            env.entry(k.to_owned()).or_insert_with(|| v.to_owned());
        }
    }
    Some(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_like_bun() {
        assert_eq!(sanitize_segment("agent-spaces"), "agent-spaces");
        assert_eq!(sanitize_segment(" My Project!! "), "my-project");
        assert_eq!(sanitize_segment("--_."), "default");
        assert_eq!(sanitize_segment("a//b"), "a-b");
    }

    #[test]
    fn utf16_semantics() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_slice("a😀b", 0, 2), None);
        assert_eq!(utf16_slice("a😀b", 0, 3).as_deref(), Some("a😀"));
        assert_eq!(js_trim("\u{feff} x \u{85}"), "x \u{85}");
    }

    #[test]
    fn omits_ephemeral_fields() {
        let v = crate::json::parse(br#"{"b":1,"createdAt":"x","a":{"updated_at":2,"k":null}}"#)
            .unwrap();
        assert_eq!(canonicalize(&v, true), r#"{"a":{"k":null},"b":1}"#);
        assert_eq!(
            canonicalize(&v, false),
            r#"{"a":{"k":null,"updated_at":2},"b":1,"createdAt":"x"}"#
        );
    }
}
