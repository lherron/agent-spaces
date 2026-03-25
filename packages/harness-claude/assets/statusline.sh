#!/usr/bin/env bash
# Agent Spaces statusline for Claude Code
# Bundled with asp run targets to show context window utilization.
# Based on the Warm Graphite theme.

set -euo pipefail

# ANSI formatting
RESET=$'\033[0m'
DIM=$'\033[2m'
BOLD=$'\033[1m'

# Warm Graphite color palette (ANSI 256)
MAUVE=$'\033[38;5;140m'      # model name
GRAY=$'\033[38;5;243m'       # separators
LIGHT_GRAY=$'\033[38;5;245m' # token display
DARK_GRAY=$'\033[38;5;240m'  # empty bar segments
PEACH=$'\033[38;5;223m'      # medium usage
ROSE=$'\033[38;5;174m'       # higher usage
SAGE=$'\033[38;5;107m'       # low usage, healthy
GOLD=$'\033[38;5;178m'       # bolt icon
CORAL=$'\033[38;5;173m'      # critical usage
TEAL=$'\033[38;5;73m'        # brackets

# Read JSON input from stdin
input=$(cat)

# Extract values from JSON
model=$(echo "$input" | jq -r '.model.display_name')
context_size=$(echo "$input" | jq -r '.context_window.context_window_size')
used_percentage=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
current_usage=$(echo "$input" | jq '.context_window.current_usage')

# Use pre-calculated used_percentage when available, fall back to manual calculation
if [ -n "$used_percentage" ]; then
  percentage=$(printf '%.0f' "$used_percentage")
  if [ "$current_usage" != "null" ]; then
    current_tokens=$(echo "$current_usage" | jq '.input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens')
    current_k=$((current_tokens / 1000))
    context_k=$((context_size / 1000))
    token_display="${current_k}K/${context_k}K"
  else
    context_k=$((context_size / 1000))
    token_display="${context_k}K"
  fi
elif [ "$current_usage" != "null" ]; then
  current_tokens=$(echo "$current_usage" | jq '.input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens')
  percentage=$((current_tokens * 100 / context_size))
  current_k=$((current_tokens / 1000))
  context_k=$((context_size / 1000))
  token_display="${current_k}K/${context_k}K"
else
  percentage=0
  context_k=$((context_size / 1000))
  token_display="—/${context_k}K"
fi

# Choose color based on usage level
if [ "$percentage" -lt 30 ]; then
  bar_color="$SAGE"
elif [ "$percentage" -lt 50 ]; then
  bar_color="$TEAL"
elif [ "$percentage" -lt 70 ]; then
  bar_color="$PEACH"
elif [ "$percentage" -lt 85 ]; then
  bar_color="$ROSE"
else
  bar_color="$CORAL"
fi

# Create progress bar (15 characters wide)
bar_width=15
filled=$((percentage * bar_width / 100))
empty=$((bar_width - filled))

progress_bar="${bar_color}"
for ((i=0; i<filled; i++)); do
  progress_bar+="▰"
done
progress_bar+="${DARK_GRAY}"
for ((i=0; i<empty; i++)); do
  progress_bar+="▱"
done
progress_bar+="${RESET}"

# Model glyphs
short_model="$model"
case "$model" in
  *"Opus"*) short_model="◈ Opus" ;;
  *"Sonnet"*) short_model="◇ Sonnet" ;;
  *"Haiku"*) short_model="○ Haiku" ;;
esac

# Format: ◈ Model │ ⚡ ▰▰▰▰▰▱▱▱▱▱ 45K/200K (45%)
echo -n "${MAUVE}${short_model}${RESET} ${GRAY}│${RESET} ${GOLD}⚡${RESET} ${progress_bar} ${LIGHT_GRAY}${token_display}${RESET} ${bar_color}(${percentage}%)${RESET}"
