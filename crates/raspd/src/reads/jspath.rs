//! Node's `path.posix` and the `node:fs` calls the two read ops make, with the
//! error messages Bun gives them, so a refusal that carries `formatError(e)`
//! reads the same from raspd.
//!
//! Paths are compared and sliced as bytes: `/` and `.` are ASCII, so UTF-8
//! code units and JavaScript's UTF-16 ones agree on every boundary used here.
use std::io;

pub fn is_absolute(p: &str) -> bool {
    p.starts_with('/')
}

/// `normalizeString(path, allowAboveRoot)`.
fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let bytes = path.as_bytes();
    let mut res = String::new();
    let mut last_segment_length = 0usize;
    let mut last_slash: isize = -1;
    let mut dots: isize = 0;
    for i in 0..=bytes.len() {
        let code = if i < bytes.len() {
            bytes[i]
        } else if bytes.last() == Some(&b'/') {
            break;
        } else {
            b'/'
        };
        if code == b'/' {
            if last_slash == i as isize - 1 || dots == 1 {
                // Nothing to append.
            } else if dots == 2 {
                if res.len() < 2 || last_segment_length != 2 || !res.ends_with("..") {
                    if res.len() > 2 {
                        match res.rfind('/') {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(index) => {
                                res.truncate(index);
                                last_segment_length = match res.rfind('/') {
                                    Some(p) => res.len() - 1 - p,
                                    None => res.len(),
                                };
                            }
                        }
                        last_slash = i as isize;
                        dots = 0;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i as isize;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    res.push_str(if res.is_empty() { ".." } else { "/.." });
                    last_segment_length = 2;
                }
            } else {
                let segment = &path[(last_slash + 1) as usize..i];
                if !res.is_empty() {
                    res.push('/');
                }
                res.push_str(segment);
                last_segment_length = (i as isize - last_slash - 1) as usize;
            }
            last_slash = i as isize;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res
}

pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let absolute = is_absolute(path);
    let trailing = path.ends_with('/');
    let mut out = normalize_string(path, !absolute);
    if out.is_empty() {
        if absolute {
            return "/".into();
        }
        return if trailing { "./".into() } else { ".".into() };
    }
    if trailing {
        out.push('/');
    }
    if absolute { format!("/{out}") } else { out }
}

pub fn join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".into();
    }
    normalize(&joined.join("/"))
}

fn process_cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".into())
}

pub fn resolve(parts: &[&str]) -> String {
    let mut resolved = String::new();
    let mut absolute = false;
    let mut i = parts.len() as isize - 1;
    while i >= -1 && !absolute {
        let path = if i >= 0 {
            parts[i as usize].to_owned()
        } else {
            process_cwd()
        };
        i -= 1;
        if path.is_empty() {
            continue;
        }
        resolved = format!("{path}/{resolved}");
        absolute = is_absolute(&path);
    }
    let normalized = normalize_string(&resolved, !absolute);
    if absolute {
        format!("/{normalized}")
    } else if normalized.is_empty() {
        ".".into()
    } else {
        normalized
    }
}

/// `path.relative(from, to)`.
pub fn relative(from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from = resolve(&[from]);
    let to = resolve(&[to]);
    if from == to {
        return String::new();
    }
    let f = from.as_bytes();
    let t = to.as_bytes();
    let from_start = 1usize;
    let from_end = f.len();
    let from_len = from_end - from_start;
    let to_start = 1usize;
    let to_len = t.len() - to_start;
    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0usize;
    while i < length {
        let code = f[from_start + i];
        if code != t[to_start + i] {
            break;
        } else if code == b'/' {
            last_common_sep = i as isize;
        }
        i += 1;
    }
    if i == length {
        if to_len > length {
            if t[to_start + i] == b'/' {
                return to[to_start + i + 1..].to_owned();
            }
            if i == 0 {
                return to[to_start + i..].to_owned();
            }
        } else if from_len > length {
            if f[from_start + i] == b'/' {
                last_common_sep = i as isize;
            } else if i == 0 {
                last_common_sep = 0;
            }
        }
    }
    let mut out = String::new();
    let mut j = (from_start as isize + last_common_sep + 1) as usize;
    while j <= from_end {
        if j == from_end || f[j] == b'/' {
            out.push_str(if out.is_empty() { ".." } else { "/.." });
        }
        j += 1;
    }
    format!(
        "{out}{}",
        &to[(to_start as isize + last_common_sep) as usize..]
    )
}

pub fn dirname(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let b = path.as_bytes();
    let has_root = b[0] == b'/';
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = b.len() - 1;
    while i >= 1 {
        if b[i] == b'/' {
            if !matched_slash {
                end = i as isize;
                break;
            }
        } else {
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        return if has_root { "/".into() } else { ".".into() };
    }
    if has_root && end == 1 {
        return "//".into();
    }
    path[..end as usize].to_owned()
}

pub fn basename(path: &str) -> String {
    let b = path.as_bytes();
    let mut start = 0usize;
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = b.len() as isize - 1;
    while i >= 0 {
        if b[i as usize] == b'/' {
            if !matched_slash {
                start = i as usize + 1;
                break;
            }
        } else if end == -1 {
            matched_slash = false;
            end = i + 1;
        }
        i -= 1;
    }
    if end == -1 {
        return String::new();
    }
    path[start..end as usize].to_owned()
}

/// The fs failures Bun formats as `<CODE>: <description>, <syscall> '<path>'`.
/// Any other errno is not ported: the caller forwards instead of guessing.
#[derive(Debug)]
pub struct FsError {
    pub code: &'static str,
    pub message: String,
}

impl FsError {
    pub fn is(&self, codes: &[&str]) -> bool {
        codes.contains(&self.code)
    }
}

/// None when the errno is outside the messages verified against Bun.
pub fn fs_error(error: &io::Error, syscall: &str, path: Option<&str>) -> Option<FsError> {
    let (code, description) = match error.raw_os_error()? {
        libc::ENOENT => ("ENOENT", "no such file or directory"),
        libc::ENOTDIR => ("ENOTDIR", "not a directory"),
        libc::EACCES => ("EACCES", "permission denied"),
        libc::EISDIR => ("EISDIR", "illegal operation on a directory"),
        _ => return None,
    };
    let message = match path {
        Some(path) => format!("{code}: {description}, {syscall} '{path}'"),
        None => format!("{code}: {description}, {syscall}"),
    };
    Some(FsError { code, message })
}

/// `existsSync`: follows symlinks, false on any error.
pub fn exists(path: &str) -> bool {
    !path.is_empty() && std::fs::metadata(path).is_ok()
}

/// `statSync(path).isDirectory()`, false on any error.
pub fn is_directory(path: &str) -> bool {
    !path.is_empty() && std::fs::metadata(path).is_ok_and(|m| m.is_dir())
}

/// `readFileSync(path, 'utf8')`: lossy UTF-8, BOM kept. A read of a directory
/// fails at `read` (no path), as Bun reports it.
pub fn read_text(path: &str) -> Result<String, io::Error> {
    let bytes = std::fs::read(path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn read_error(error: &io::Error, path: &str) -> Option<FsError> {
    if error.raw_os_error() == Some(libc::EISDIR) {
        fs_error(error, "read", None)
    } else {
        fs_error(error, "open", Some(path))
    }
}

pub fn access_readable(path: &str) -> Result<(), io::Error> {
    let c = std::ffi::CString::new(path).map_err(|_| io::Error::from_raw_os_error(libc::ENOENT))?;
    // SAFETY: `c` is a valid NUL-terminated string for the call's duration.
    if unsafe { libc::access(c.as_ptr(), libc::R_OK) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_node_posix_path() {
        assert_eq!(join(&["/a/b", "../c", "d/"]), "/a/c/d/");
        assert_eq!(join(&["/a", ""]), "/a");
        assert_eq!(join(&["a", "..", ".."]), "..");
        assert_eq!(normalize("/../a//b/./c/.."), "/a/b");
        assert_eq!(normalize("./"), "./");
        assert_eq!(resolve(&["/a/b", "./c", "../d"]), "/a/b/d");
        assert_eq!(resolve(&["/a/b/"]), "/a/b");
        assert_eq!(relative("/a/b", "/a/b/c"), "c");
        assert_eq!(relative("/a/b/c", "/a/b"), "..");
        assert_eq!(relative("/a/bc", "/a/b"), "../b");
        assert_eq!(relative("/", "/a"), "a");
        assert_eq!(relative("/a", "/"), "..");
        assert_eq!(relative("/a/b", "/a/..b"), "../..b");
        assert_eq!(dirname("/a/b/"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("a"), ".");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("/"), "");
        assert_eq!(normalize("a/../../b"), "../b");
        assert_eq!(normalize("/a/b/../../.."), "/");
    }
}
