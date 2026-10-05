#!/bin/bash
# ASP startup info
# Always exits 0 - hooks should never fail

main() {
    asp --help
}

if ! main "$@"; then
    HOOK_LOG=~/praesidium/var/log/hooks-log.log
    mkdir -p "$(dirname "$HOOK_LOG")"
    echo "$(date -Iseconds) [FAIL] startup.sh: main returned non-zero" >> "$HOOK_LOG"
fi
exit 0
