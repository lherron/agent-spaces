//! Filesystem tree operations the materializers share, with Bun's semantics
//! (core/atomic.ts `copyDir`/`linkOrCopy`, materializer/link-components.ts
//! `linkDirectory`): copy and hardlink trees, recreate or follow symlinks,
//! remove forcibly, and map every I/O failure to `materialize_io`.
use super::{Fwd, fwd};
use crate::json::J;
use crate::reads::jspath::join;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, symlink};
use std::path::PathBuf;

pub(super) fn io_fwd(e: io::Error) -> Fwd {
    super::fwd_at(crate::reason!("materialize_io"), e.to_string())
}

pub(super) fn mkdirp(path: &str) -> Result<(), Fwd> {
    fs::create_dir_all(path).map_err(io_fwd)
}

pub(super) fn write(path: &str, content: &str) -> Result<(), Fwd> {
    fs::write(path, content).map_err(io_fwd)
}

/// `readFileSync(path, 'utf8')`: lossy UTF-8.
pub(super) fn read_text(path: &str) -> Result<String, Fwd> {
    fs::read(path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .map_err(io_fwd)
}

/// `JSON.parse(readFileSync(path))`, refusing malformed JSON with `reason`.
pub(super) fn read_json(path: &str, reason: crate::disposition::Reason) -> Result<J, Fwd> {
    crate::json::parse(read_text(path)?.as_bytes()).ok_or_else(|| fwd(reason))
}

/// Pretty JSON plus the trailing newline Bun's writers add.
pub(super) fn write_json(path: &str, value: &J) -> Result<(), Fwd> {
    write(path, &format!("{}\n", value.to_json_pretty()))
}

/// `fs.promises.copyFile` (contents and mode).
pub(super) fn copy_file(src: &str, dest: &str) -> Result<(), Fwd> {
    fs::copy(src, dest).map(|_| ()).map_err(io_fwd)
}

/// Hardlink `src` at `dest`, copying instead on EXDEV/EPERM/ENOTSUP.
pub(super) fn hardlink_or_copy(src: &str, dest: &str) -> Result<(), Fwd> {
    match fs::hard_link(src, dest) {
        Ok(()) => Ok(()),
        Err(e)
            if matches!(
                e.raw_os_error(),
                Some(libc::EXDEV | libc::EPERM | libc::ENOTSUP)
            ) =>
        {
            copy_file(src, dest)
        }
        Err(e) => Err(io_fwd(e)),
    }
}

/// `rm(path, { recursive: true, force: true })`: a missing path is fine.
pub(super) fn rm_rf(path: &str) -> Result<(), Fwd> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path).map_err(io_fwd),
        Ok(_) => fs::remove_file(path).map_err(io_fwd),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_fwd(e)),
    }
}

/// `copyDir(src, dest, { useHardlinks })`, and `linkDirectory(src, dest,
/// { forceCopy: true })` without `followSymlinks`: files hardlinked (copy on
/// EXDEV/EPERM/ENOTSUP) or copied, symlinks recreated.
pub(super) fn copy_dir(src: &str, dest: &str, hardlinks: bool) -> Result<(), Fwd> {
    mkdirp(dest)?;
    for entry in fs::read_dir(src).map_err(io_fwd)? {
        let entry = entry.map_err(io_fwd)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let (s, d) = (join(&[src, &name]), join(&[dest, &name]));
        let ft = entry.file_type().map_err(io_fwd)?;
        if ft.is_dir() {
            copy_dir(&s, &d, hardlinks)?;
        } else if ft.is_file() && hardlinks {
            hardlink_or_copy(&s, &d)?;
        } else if ft.is_file() {
            copy_file(&s, &d)?;
        } else if ft.is_symlink() {
            let target = fs::read_link(&s).map_err(io_fwd)?;
            symlink(target, &d).map_err(io_fwd)?;
        }
    }
    Ok(())
}

/// `linkDirectory(src, dest, { forceCopy: true, followSymlinks: true })`:
/// copies through symlinks, refusing a directory cycle.
pub(super) fn copy_dir_following(src: &str, dest: &str) -> Result<(), Fwd> {
    copy_following(src, dest, &mut vec![])
}

fn copy_following(src: &str, dest: &str, ancestors: &mut Vec<PathBuf>) -> Result<(), Fwd> {
    let real = fs::canonicalize(src).map_err(io_fwd)?;
    if ancestors.contains(&real) {
        return Err(fwd(crate::reason!("symlink_cycle")));
    }
    ancestors.push(real);
    mkdirp(dest)?;
    for entry in fs::read_dir(src).map_err(io_fwd)? {
        let entry = entry.map_err(io_fwd)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let (s, d) = (join(&[src, &name]), join(&[dest, &name]));
        let ft = entry.file_type().map_err(io_fwd)?;
        // A symlink is judged by what it points at (a dangling one refuses).
        let (is_dir, is_file) = if ft.is_symlink() {
            let meta = fs::metadata(&s).map_err(io_fwd)?;
            (meta.is_dir(), meta.is_file())
        } else {
            (ft.is_dir(), ft.is_file())
        };
        if is_dir {
            copy_following(&s, &d, ancestors)?;
        } else if is_file {
            copy_file(&s, &d)?;
        }
    }
    ancestors.pop();
    Ok(())
}

pub(super) fn is_dir_follow(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_dir())
}

pub(super) fn is_file_follow(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// `stat.mtimeMs`.
pub(super) fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.mtime() as f64 * 1000.0 + (meta.mtime_nsec() as f64 / 1_000_000.0)
}
