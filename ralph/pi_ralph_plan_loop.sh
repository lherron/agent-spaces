#!/bin/bash
# Ralph Planning Loop (Pi Harness)
# Usage: ./pi_ralph_plan_loop.sh [max_iterations]

set -euo pipefail
cd "$(dirname "$0")/.."
MAX=${1:-2}
ITER=0
BRANCH=$(git branch --show-current)

echo "━━━ Ralph Plan Loop (Pi) ━━━"
echo "Branch: $BRANCH"
[ $MAX -gt 0 ] && echo "Max: $MAX"

while true; do
    [ $MAX -gt 0 ] && [ $ITER -ge $MAX ] && { echo "Done: $MAX iterations"; break; }
    echo $(asp run ralph-plan --harness pi --yolo --print-command --no-interactive --model gpt-5.3)
    eval "$(asp run ralph-plan --harness pi --yolo --print-command --model gpt-5.3) \"Hey bud, help me out.  Execute the instructions in ralph/CODEX_RALPH_PLAN_PROMPT.md\""
    git push origin "$BRANCH" 2>/dev/null || git push -u origin "$BRANCH"
    ITER=$((ITER + 1))
    echo -e "\n══════ PLAN ITERATION $ITER ══════\n"
done
