//! The serving release: the ASP release directory raspd runs from, read from
//! its `release.json` like Bun's `resolveAspdReleaseBinding` does.
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Release {
    pub root: PathBuf,
    pub release_id: String,
    pub source_commit: String,
    pub built_at: String,
}

/// `--release-root`, else the launcher's `ASP_RELEASE_ROOT`, else the
/// directory above this executable's `libexec/`.
pub fn locate(explicit: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(root) = explicit {
        return Ok(root.to_path_buf());
    }
    if let Some(root) = std::env::var_os("ASP_RELEASE_ROOT") {
        return Ok(PathBuf::from(root));
    }
    let exe = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| format!("cannot resolve the raspd executable: {e}"))?;
    let libexec = exe.parent().ok_or("raspd executable has no parent")?;
    if libexec.file_name().and_then(|n| n.to_str()) != Some("libexec") {
        return Err(format!(
            "raspd must run from an immutable ASP release (<root>/libexec/raspd) or with --release-root: {}",
            exe.display()
        ));
    }
    Ok(libexec
        .parent()
        .ok_or("libexec has no parent")?
        .to_path_buf())
}

pub fn read(root: &Path) -> Result<Release, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("release root {}: {e}", root.display()))?;
    let path = root.join("release.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let field = |name: &str| {
        manifest[name]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("{} has no string {name}", path.display()))
    };
    let release = Release {
        release_id: field("releaseId")?,
        source_commit: field("sourceCommit")?,
        built_at: field("builtAt")?,
        root: root.clone(),
    };
    if root.file_name().and_then(|n| n.to_str()) != Some(release.release_id.as_str()) {
        return Err(format!(
            "release directory {} does not match release identity {}",
            root.display(),
            release.release_id
        ));
    }
    Ok(release)
}

/// The Praesidium var root of a namespaced release (`<var>/aspd/releases/<id>`),
/// as Bun's `aspdVarRoot` computes it.
pub fn var_root(release_root: &Path) -> Option<PathBuf> {
    let releases = release_root.parent()?;
    if releases.file_name()?.to_str()? != "releases" {
        return None;
    }
    Some(releases.parent()?.parent()?.to_path_buf())
}
