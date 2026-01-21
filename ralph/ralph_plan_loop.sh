#!/bin/bash
# Ralph Planning Loop
# Usage: ./ralph_plan_loop.sh [max_iterations]

set -euo pipefail
cd "$(dirname "$0")/.."
MAX=${1:-2}
ITER=0
BRANCH=$(git branch --show-current)
ASP="bun run /Users/lherron/praesidium/agent-spaces/packages/cli/bin/asp.js"

echo "━━━ Ralph Plan Loop ━━━"
echo "Branch: $BRANCH"
[ $MAX -gt 0 ] && echo "Max: $MAX"

while true; do
    [ $MAX -gt 0 ] && [ $ITER -ge $MAX ] && { echo "Done: $MAX iterations"; break; }
    eval "cat ralph/RALPH_PLAN_PROMPT.md | $($ASP run ralph-plan --yolo --print-command --no-interactive)"
    git push origin "$BRANCH" 2>/dev/null || git push -u origin "$BRANCH"
    ITER=$((ITER + 1))
    echo -e "\n══════ PLAN ITERATION $ITER ══════\n"
done
