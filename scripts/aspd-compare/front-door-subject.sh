#!/usr/bin/env bash
# The fronted aspd subject for the compare runner (T-11835, R1 close condition 1):
#   --b-cmd '["<repo>/scripts/aspd-compare/front-door-subject.sh"]'
# The runner appends `serve --socket <ns>/run/aspd.sock --log <log>` and sets
# ASPD_COMPARE_RELEASE. This starts the release's Bun aspd on a private socket
# beside the public one, waits until it listens, then the same release's raspd
# on the public socket in front of it: the production front-door shape. Both
# share this process group, so the runner's group SIGTERM stops both; if either
# exits, the other is stopped and this exits non-zero.
set -euo pipefail
[[ "${1-}" == serve ]] || { echo "usage: front-door-subject.sh serve --socket <s> --log <l>" >&2; exit 2; }
shift
socket="" log=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --socket) socket="$2"; shift 2 ;;
    --log) log="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
release="${ASPD_COMPARE_RELEASE:?ASPD_COMPARE_RELEASE is required}"
bun_socket="$(dirname "$socket")/aspd-bun.sock"

"$release/aspd" serve --socket "$bun_socket" --log "$log.bun" &
bun_pid=$!
for _ in $(seq 1 300); do
  [[ -S "$bun_socket" ]] && break
  kill -0 "$bun_pid" 2>/dev/null || { echo "Bun aspd exited before listening" >&2; exit 1; }
  sleep 0.1
done
[[ -S "$bun_socket" ]] || { echo "Bun aspd never listened on $bun_socket" >&2; kill "$bun_pid"; exit 1; }
"$release/raspd" serve --socket "$socket" --upstream "$bun_socket" --log "$log" &
raspd_pid=$!
stop() { kill -TERM "$raspd_pid" "$bun_pid" 2>/dev/null; wait; }
trap 'stop; exit 0' TERM INT
# macOS ships bash 3.2 (no `wait -n`): poll both.
while kill -0 "$bun_pid" 2>/dev/null && kill -0 "$raspd_pid" 2>/dev/null; do
  sleep 0.2
done
stop
exit 1
