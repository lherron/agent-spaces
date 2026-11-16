//! File refs: `resolveTemplateRef` (template-ref.ts), `resolveContainedPath`
//! and `resolveRootRelativeRef` (resolver/root-relative-refs.ts), and the
//! optional reads a file section makes.
use super::Ctx;
use super::vars::interpolate;
use crate::compile::{Fwd, fwd};
use crate::reads::jspath::{is_absolute, join, normalize, relative};

fn realpath(p: &str) -> Result<String, Fwd> {
    std::fs::canonicalize(p)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| fwd(crate::reason!("realpath_failed")))
}

/// `resolveContainedPath(root, relativePath)`; `Err(None)` is a thrown error.
fn contained(root: &str, rel_path: &str) -> Result<String, Option<Fwd>> {
    if is_absolute(rel_path) {
        return Err(None);
    }
    let normalized = normalize(rel_path);
    if normalized.starts_with("..") || normalized.contains("/..") || normalized.contains("\\..") {
        return Err(None);
    }
    let candidate = join(&[root, &normalized]);
    let rel = relative(root, &candidate);
    if rel.starts_with("..") || is_absolute(&rel) {
        return Err(None);
    }
    if std::path::Path::new(&candidate).exists() {
        let real_root = realpath(root).map_err(Some)?;
        let real_candidate = realpath(&candidate).map_err(Some)?;
        let real_rel = relative(&real_root, &real_candidate);
        if real_rel.starts_with("..") || is_absolute(&real_rel) {
            return Err(None);
        }
    }
    Ok(candidate)
}

/// The part of a `<scheme>:///` ref after its scheme, as a ref may carry it:
/// non-empty and on one line.
fn valid_rest(rest: &str) -> bool {
    !rest.is_empty() && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// `resolveTemplateRef(ref, context)`; `Err(None)` is a thrown error.
pub(super) fn template_ref(r: &str, ctx: &Ctx) -> Result<String, Option<Fwd>> {
    for (scheme, root) in [
        ("agent-root:///", Some(&ctx.agent_root)),
        ("project-root:///", ctx.project_root.as_ref()),
    ] {
        if let Some(rest) = r.strip_prefix(scheme) {
            if !valid_rest(rest) {
                return Err(None);
            }
            let Some(root) = root else { return Err(None) };
            if !is_absolute(root) {
                return Err(None);
            }
            return contained(root, rest);
        }
    }
    let roots = ctx.search_roots();
    if let Some(rest) = r.strip_prefix("agents-root:///") {
        if !valid_rest(rest) {
            return Err(None);
        }
        for root in &roots {
            if !is_absolute(root) {
                return Err(None);
            }
            let candidate = contained(root, rest)?;
            if std::path::Path::new(&candidate).exists() {
                return Ok(candidate);
            }
        }
        return contained(roots[0], rest);
    }
    let interpolated = interpolate(r, ctx).map_err(Some)?;
    if interpolated != r && is_absolute(&interpolated) {
        return Ok(interpolated);
    }
    for root in &roots {
        let candidate = join(&[root, &interpolated]);
        if std::path::Path::new(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Ok(join(&[roots[0], &interpolated]))
}

/// `resolveRootRelativeRef(ref, { agentRoot, projectRoot })`, `None` where it throws.
pub fn root_relative(r: &str, ctx: &Ctx) -> Option<String> {
    if !(r.starts_with("agent-root:///") || r.starts_with("project-root:///")) {
        return None;
    }
    template_ref(r, ctx).ok()
}

/// `readFileOrUndefined`: `Ok(None)` when missing; `Err` for other errors.
pub(super) fn read_optional(path: &str) -> Result<Option<String>, std::io::Error> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Node's message for a readFile error, where raspd has its wording.
pub(super) fn read_message(error: &std::io::Error, path: &str) -> Option<String> {
    crate::reads::jspath::read_error(error, path).map(|e| e.message)
}
