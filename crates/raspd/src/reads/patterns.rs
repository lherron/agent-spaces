//! The regular expressions the two read ops test, written out by hand. JS `.`
//! never matches a line terminator (`\n`, `\r`, U+2028, U+2029); `[^@]` does.

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// `^[A-Za-z0-9._-]+$`, without the length bound.
pub fn is_token_chars(s: &str) -> bool {
    !s.is_empty() && s.chars().all(token_char)
}

/// `^[A-Za-z0-9._-]{1,64}$`.
pub fn is_node_id(s: &str) -> bool {
    is_token_chars(s) && s.len() <= 64
}

/// agent-scope `validateToken(value, label)`; lengths are UTF-16 units.
pub fn validate_token(value: &str, label: &str) -> Option<String> {
    let length = value.encode_utf16().count();
    if !(1..=64).contains(&length) {
        return Some(format!("{label} must be 1..64 characters, got {length}"));
    }
    if !is_token_chars(value) {
        return Some(format!(
            "{label} contains invalid characters: must match [A-Za-z0-9._-]+"
        ));
    }
    None
}

/// `.+`: non-empty, no line terminator.
fn dot_plus(s: &str) -> bool {
    !s.is_empty() && !s.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// `[a-z0-9]+(?:-[a-z0-9]+)*`.
fn space_id(s: &str) -> bool {
    !s.is_empty()
        && s.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// `id(?:@(.+))?`, or `id@(.+)` when the selector is required.
fn id_then_selector(s: &str, selector_required: bool) -> bool {
    match s.split_once('@') {
        Some((id, selector)) => space_id(id) && dot_plus(selector),
        None => !selector_required && space_id(s),
    }
}

/// `[^@]+@(.+)`.
fn path_ref(s: &str) -> bool {
    match s.split_once('@') {
        Some((path, selector)) => !path.is_empty() && dot_plus(selector),
        None => false,
    }
}

/// spaces-config `isSpaceRefString`.
pub fn is_space_ref(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix("spaces:")
        .or_else(|| value.strip_prefix("space:"))
    else {
        return false;
    };
    id_then_selector(rest, false)
        || rest.strip_prefix("path:").is_some_and(path_ref)
        || rest
            .strip_prefix("project:")
            .is_some_and(|r| id_then_selector(r, false))
        || rest
            .strip_prefix("agent:")
            .is_some_and(|r| id_then_selector(r, false))
}

/// targets.schema.json `$defs.spaceRef` pattern.
pub fn is_schema_space_ref(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("space:") else {
        return false;
    };
    rest.strip_prefix("project:")
        .is_some_and(|r| id_then_selector(r, false))
        || rest.strip_prefix("path:").is_some_and(path_ref)
        || id_then_selector(rest, false)
}

/// The avatar rule: `new URL(raw)` parses, protocol `https:`, no credentials,
/// `raw` already trimmed. `Some(verdict)` only for the plain shape raspd can
/// judge without a WHATWG URL parser (`https://` + dotted host labels + an
/// optional printable-ASCII path, or a plain non-https scheme); `None`
/// otherwise, and the request is forwarded.
pub fn https_image_url(raw: &str) -> Option<bool> {
    let (scheme, rest) = raw.split_once("://")?;
    let plain_scheme = !scheme.is_empty()
        && scheme.bytes().all(|b| b.is_ascii_lowercase())
        && !matches!(scheme, "file");
    if !plain_scheme {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (host, tail) = rest.split_at(end);
    let labels: Vec<&str> = host.split('.').collect();
    let host_ok = !host.is_empty()
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && !l.starts_with('-')
                && !l.ends_with('-')
                && !l.get(..4).is_some_and(|p| p.eq_ignore_ascii_case("xn--"))
        })
        && labels
            .last()
            .is_some_and(|l| l.bytes().any(|b| b.is_ascii_alphabetic()));
    let tail_ok = tail
        .bytes()
        .all(|b| (0x21..=0x7e).contains(&b) && b != b'\\');
    if !host_ok || !tail_ok {
        return None;
    }
    Some(scheme == "https")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_refs() {
        for ok in [
            "space:base",
            "space:base@dev",
            "spaces:a-b@1.2.3",
            "space:path:../x@dev",
            "space:project:p-1",
            "space:agent:clod@agent",
        ] {
            assert!(is_space_ref(ok), "{ok}");
        }
        for bad in [
            "space:",
            "space:A",
            "space:a@",
            "space:a@x\ny",
            "space:path:@x",
            "x:a",
        ] {
            assert!(!is_space_ref(bad), "{bad}");
        }
        assert!(!is_schema_space_ref("spaces:a"));
        assert!(is_schema_space_ref("space:path:a\nb@x"));
    }

    #[test]
    fn avatars() {
        assert_eq!(https_image_url("https://cdn.example.com/a.png"), Some(true));
        assert_eq!(https_image_url("http://cdn.example.com/a.png"), Some(false));
        assert_eq!(https_image_url("https://u:p@example.com/"), None);
        assert_eq!(https_image_url(" https://example.com"), None);
        assert_eq!(https_image_url("https://1.2.3.4/"), None);
    }
}
