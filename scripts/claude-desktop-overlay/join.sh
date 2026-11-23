#!/bin/sh

# Check the namespace too, including future markers and empty values. awk's
# ENVIRON reads names directly, independent of the contents of other values.
/usr/bin/awk 'BEGIN { for (name in ENVIRON) if (name ~ /^HARNESS_BROKER_/) exit 1 }' \
  </dev/null 2>/dev/null || exit 0

claude_home="$HOME/.claude"
entrypoint() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ -r "$claude_home/sessions/$1.json" ] || return 1
  /usr/bin/plutil -extract entrypoint raw -expect string -o - \
    "$claude_home/sessions/$1.json" 2>/dev/null
}

claude_pid=$PPID
if ! kind=$(entrypoint "$claude_pid"); then
  claude_pid=${CLAUDE_PID-}
  kind=$(entrypoint "$claude_pid") || exit 0
fi
[ "$kind" = claude-desktop ] || exit 0

# The desktop app's PATH need not include CLI tools installed by the user.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
node "$claude_home/hrc-desktop-hook/join.mjs" "$claude_pid" 2>/dev/null || :
