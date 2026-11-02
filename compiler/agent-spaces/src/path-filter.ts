import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from 'spaces-config'

// These bytes are shared with the raspd port. Only the deny array is generated.
export const PATH_FILTER_BODY = String.raw`
() {
  emulate -L zsh
  setopt extendedglob
  local _prae_root="$ZDOTDIR/farm"
  local _prae_dir _prae_name _prae_key _prae_farm _prae_tmp _prae_entry _prae_link
  local -a _prae_path
  local -i _prae_hit
  command /bin/mkdir -p -- "$_prae_root" || return
  for _prae_dir in "${'$'}{path[@]}"; do
    # An inherited farm still needs the source's freshness check.
    if [[ $_prae_dir == "$_prae_root/"* && -L $_prae_dir ]]; then
      _prae_dir=${'$'}{_prae_dir:t}
      _prae_dir=${'$'}{_prae_dir//\%2f//}
      _prae_dir=${'$'}{_prae_dir//\%25/%}
    fi
    if [[ ! -d $_prae_dir || -z $_prae_dir ]]; then
      _prae_path+=("$_prae_dir")
      continue
    fi
    _prae_hit=0
    for _prae_name in "${'$'}{_prae_deny[@]}"; do
      [[ -x "$_prae_dir/$_prae_name" && ! -d "$_prae_dir/$_prae_name" ]] && _prae_hit=1
    done
    if (( ! _prae_hit )); then
      _prae_path+=("$_prae_dir")
      continue
    fi
    _prae_dir=${'$'}{_prae_dir:A}
    _prae_key=${'$'}{_prae_dir//\%/%25}
    _prae_key=${'$'}{_prae_key//\//%2f}
    _prae_farm="$_prae_root/$_prae_key"
    if [[ ! -e "${'$'}{_prae_farm:A}.stamp" || $_prae_dir -nt "${'$'}{_prae_farm:A}.stamp" ]]; then
      _prae_tmp=$(command /usr/bin/mktemp -d "$_prae_root/.build.XXXXXXXXXX") || return
      # Stamp first so a directory change during enumeration triggers another build.
      command /usr/bin/touch -- "$_prae_tmp.stamp" || return
      for _prae_entry in "$_prae_dir"/*(DN); do
        _prae_name=${'$'}{_prae_entry:t}
        (( ${'$'}{_prae_deny[(Ie)$_prae_name]} )) && continue
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
  path=("${'$'}{_prae_path[@]}")
}
typeset -U path
export PATH
unset _prae_deny
`

export function pathFilterFiles(exclude: readonly string[]): Record<string, string> {
  const names = [...new Set(exclude)].sort()
  if (names.some((name) => !/^[a-z][a-z0-9._-]*$/.test(name))) {
    throw new Error('Invalid PATH exclusion command name')
  }
  const files: Record<string, string> = {
    'claude-env.zsh': 'source "$ZDOTDIR/path-filter.zsh"\n',
    'path-filter.zsh': `typeset -a _prae_deny=(${names.join(' ')})\n${PATH_FILTER_BODY}`,
  }
  for (const rc of ['zshenv', 'zprofile', 'zshrc', 'zlogin']) {
    files[`.${rc}`] =
      `export ZDOTDIR="$HOME"\n[[ ! -r "$HOME/.${rc}" ]] || source "$HOME/.${rc}"\nexport ZDOTDIR="\${\${(%):-%x}:A:h}"\nsource "$ZDOTDIR/path-filter.zsh"\n`
  }
  return files
}

/** Preview computes the same path and bytes but performs no writes. */
export async function preparePathFilter(
  scopeRoot: string,
  exclude: readonly string[],
  materialize: boolean
): Promise<string> {
  const zdotdir = join(scopeRoot, 'zdotdir')
  const files = pathFilterFiles(exclude)
  if (materialize && exclude.length > 0) {
    await mkdir(zdotdir, { recursive: true })
    // Every birth discards stale farm state. Shells build from their real PATH.
    await rm(join(zdotdir, 'farm'), { recursive: true, force: true })
    for (const [name, content] of Object.entries(files)) {
      await atomicWrite(join(zdotdir, name), content)
    }
  }
  return zdotdir
}
