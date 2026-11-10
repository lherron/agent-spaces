//! Byte-identical shell files from compiler/agent-spaces/src/path-filter.ts.
use super::{Fwd, atomic_write, fwd, fwd_at};
use crate::reads::jspath::join;

const BODY: &str = r#"
() {
  emulate -L zsh
  setopt extendedglob
  local _prae_root="$ZDOTDIR/farm"
  local _prae_dir _prae_name _prae_key _prae_farm _prae_tmp _prae_entry _prae_link
  local -a _prae_path
  local -i _prae_hit
  command /bin/mkdir -p -- "$_prae_root" || return
  for _prae_dir in "${path[@]}"; do
    # An inherited farm still needs the source's freshness check.
    if [[ $_prae_dir == "$_prae_root/"* && -L $_prae_dir ]]; then
      _prae_dir=${_prae_dir:t}
      _prae_dir=${_prae_dir//\%2f//}
      _prae_dir=${_prae_dir//\%25/%}
    fi
    if [[ ! -d $_prae_dir || -z $_prae_dir ]]; then
      _prae_path+=("$_prae_dir")
      continue
    fi
    _prae_hit=0
    for _prae_name in "${_prae_deny[@]}"; do
      [[ -x "$_prae_dir/$_prae_name" && ! -d "$_prae_dir/$_prae_name" ]] && _prae_hit=1
    done
    if (( ! _prae_hit )); then
      _prae_path+=("$_prae_dir")
      continue
    fi
    _prae_dir=${_prae_dir:A}
    _prae_key=${_prae_dir//\%/%25}
    _prae_key=${_prae_key//\//%2f}
    _prae_farm="$_prae_root/$_prae_key"
    if [[ ! -e "${_prae_farm:A}.stamp" || $_prae_dir -nt "${_prae_farm:A}.stamp" ]]; then
      _prae_tmp=$(command /usr/bin/mktemp -d "$_prae_root/.build.XXXXXXXXXX") || return
      # Stamp first so a directory change during enumeration triggers another build.
      command /usr/bin/touch -- "$_prae_tmp.stamp" || return
      for _prae_entry in "$_prae_dir"/*(DN); do
        _prae_name=${_prae_entry:t}
        (( ${_prae_deny[(Ie)$_prae_name]} )) && continue
        command /bin/ln -s -- "$_prae_entry" "$_prae_tmp/$_prae_name" || return
      done
      # Publish a symlink to an immutable generation with one rename. Readers
      # keep seeing a complete farm, including during simultaneous first shells.
      _prae_link="$_prae_tmp.link"
      command /bin/ln -s -- "$_prae_tmp" "$_prae_link" || return
      if [[ $OSTYPE == darwin* ]]; then
        command /bin/mv -fh -- "$_prae_link" "$_prae_farm" || return
      else
        command /bin/mv -fT -- "$_prae_link" "$_prae_farm" || return
      fi
    fi
    _prae_path+=("$_prae_farm")
  done
  path=("${_prae_path[@]}")
}
typeset -U path
export PATH
unset _prae_deny
"#;

pub fn valid_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

pub fn files(exclude: &[String]) -> Vec<(String, String)> {
    let mut names = exclude.to_vec();
    names.sort();
    names.dedup();
    let mut files = vec![
        (
            "claude-env.zsh".into(),
            "source \"$ZDOTDIR/path-filter.zsh\"\n".into(),
        ),
        (
            "path-filter.zsh".into(),
            format!("typeset -a _prae_deny=({})\n{BODY}", names.join(" ")),
        ),
    ];
    for rc in ["zshenv", "zprofile", "zshrc", "zlogin"] {
        files.push((format!(".{rc}"), format!("export ZDOTDIR=\"$HOME\"\n[[ ! -r \"$HOME/.{rc}\" ]] || source \"$HOME/.{rc}\"\nexport ZDOTDIR=\"${{${{(%):-%x}}:A:h}}\"\nsource \"$ZDOTDIR/path-filter.zsh\"\n")));
    }
    files
}

/// Preview plans the same path without touching the zdotdir or its farms.
pub fn prepare(scope_root: &str, exclude: &[String], materialize: bool) -> Result<(), Fwd> {
    if exclude.is_empty() || !materialize {
        return Ok(());
    }
    let zdotdir = join(&[scope_root, "zdotdir"]);
    std::fs::create_dir_all(&zdotdir).map_err(|_| fwd(crate::reason!("path_filter_mkdir")))?;
    // Bun's rm(farm, { recursive: true, force: true }): a farm that is a file
    // or a symlink is unlinked; only one rm -rf cannot remove refuses.
    let farm = join(&[&zdotdir, "farm"]);
    let removed = match std::fs::symlink_metadata(&farm) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(&farm),
        Ok(_) => std::fs::remove_file(&farm),
        Err(e) => Err(e),
    };
    match removed {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(fwd_at(crate::reason!("path_filter_reset"), e.to_string())),
    }
    for (name, content) in files(exclude) {
        atomic_write(&join(&[&zdotdir, &name]), &content)?;
    }
    Ok(())
}
