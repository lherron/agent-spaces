#!/bin/bash
# Ralph Build Loop (Pi Harness)
# Usage: ./pi_ralph_build_loop.sh [max_iterations]

set -euo pipefail
cd "$(dirname "$0")/.."
MAX=${1:-5}
ITER=0
BRANCH=$(git branch --show-current)

echo "━━━ Ralph Build Loop (Pi) ━━━"
echo "Branch: $BRANCH"
[ $MAX -gt 0 ] && echo "Max: $MAX"

while true; do
    [ $MAX -gt 0 ] && [ $ITER -ge $MAX ] && { echo "Done: $MAX iterations"; break; }
    echo $(asp run ralph-build --harness pi --yolo --print-command --no-interactive)
    eval "$(asp run ralph-build --harness pi --yolo --print-command --no-interactive) \"Hey bud, got some new work for us.  Please study @ralph/CODEX_RALPH_BUILD_PROMPT.md and execute as written\""
    git push origin "$BRANCH" 2>/dev/null || git push -u origin "$BRANCH"
    ITER=$((ITER + 1))
    echo -e "\n══════ BUILD ITERATION $ITER ══════\n"
done
