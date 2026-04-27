#!/usr/bin/env bash
# cli-smoke.sh — end-to-end smoke test for all 4 praesidium CLIs
#
# Validates the Commander CLI Upgrade spec section 6.4 contract:
#   exit 0 = success
#   exit 1 = runtime error
#   exit 2 = usage error
#
# Usage:  bash scripts/cli-smoke.sh
#         bash scripts/cli-smoke.sh --verbose
#
# Environment: reads .env.local from the repo root for canonical state.
# Each command invocation sets vars inline so direnv loss is not a problem.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERBOSE="${1:-}"

# Source .env.local if present (key=value lines only, skip comments/blanks)
ENV_LOCAL="$REPO_ROOT/.env.local"
if [[ -f "$ENV_LOCAL" ]]; then
  # shellcheck disable=SC1090
  set -a
  while IFS='=' read -r key value; do
    # Skip comments and blank lines
    [[ -z "$key" || "$key" == \#* ]] && continue
    export "$key=$value"
  done < "$ENV_LOCAL"
  set +a
fi

# Canonical env vars (with defaults)
: "${WRKQ_DB_PATH:=/Users/lherron/praesidium/var/db/wrkq.db}"
: "${WRKQ_ACTOR:=local-human}"
: "${ASP_PROJECT:=agent-spaces}"
: "${ASP_HOME:=/Users/lherron/praesidium/var/spaces-repo}"
: "${ASP_ROOT_DIR:=/Users/lherron/praesidium/var/spaces-repo}"

# CLI paths — prefer workspace-local where available
ASP_BIN="${ASP_BIN:-asp}"
ACP_BIN="${ACP_BIN:-bun $REPO_ROOT/packages/acp-cli/src/cli.ts}"
HRC_BIN="${HRC_BIN:-hrc}"
HRCCHAT_BIN="${HRCCHAT_BIN:-hrcchat}"

# Inline env prefix for every command
ENV_PREFIX="WRKQ_DB_PATH=$WRKQ_DB_PATH WRKQ_ACTOR=$WRKQ_ACTOR ASP_PROJECT=$ASP_PROJECT ASP_HOME=$ASP_HOME ASP_ROOT_DIR=$ASP_ROOT_DIR"

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
FAILURES=()

# Colors (disable if not a tty)
if [[ -t 1 ]]; then
  GREEN=$'\033[0;32m'
  RED=$'\033[0;31m'
  YELLOW=$'\033[0;33m'
  CYAN=$'\033[0;36m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  GREEN="" RED="" YELLOW="" CYAN="" BOLD="" RESET=""
fi

log() { echo "${CYAN}[smoke]${RESET} $*"; }
log_verbose() { [[ "$VERBOSE" == "--verbose" ]] && echo "        $*" || true; }

# run_cli <label> <expected_exit> <cli_command...>
#
# Runs a CLI command, captures exit code + stdout + stderr.
# Asserts exit code matches expected.  Returns 0 on pass, 1 on fail.
run_cli() {
  local label="$1"
  local expected_exit="$2"
  shift 2
  local cmd_str="$*"

  local stdout_file stderr_file
  stdout_file=$(mktemp)
  stderr_file=$(mktemp)

  local actual_exit=0
  # Run with inline env vars via eval so the ENV_PREFIX expands correctly
  eval "$ENV_PREFIX $cmd_str" >"$stdout_file" 2>"$stderr_file" || actual_exit=$?

  local stdout stderr
  stdout=$(cat "$stdout_file")
  stderr=$(cat "$stderr_file")
  rm -f "$stdout_file" "$stderr_file"

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  ${GREEN}PASS${RESET}  $label  (exit $actual_exit)"
    log_verbose "cmd: $cmd_str"
    PASS_COUNT=$((PASS_COUNT + 1))
    # Store for content assertions
    _LAST_STDOUT="$stdout"
    _LAST_STDERR="$stderr"
    _LAST_EXIT="$actual_exit"
    return 0
  else
    echo "  ${RED}FAIL${RESET}  $label  (expected exit $expected_exit, got $actual_exit)"
    log_verbose "cmd: $cmd_str"
    [[ -n "$stderr" ]] && log_verbose "stderr: ${stderr:0:200}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILURES+=("$label (expected exit $expected_exit, got $actual_exit)")
    _LAST_STDOUT="$stdout"
    _LAST_STDERR="$stderr"
    _LAST_EXIT="$actual_exit"
    return 1
  fi
}

# assert_stdout_contains <label> <substring>
assert_stdout_contains() {
  local label="$1"
  local needle="$2"
  if [[ "$_LAST_STDOUT" == *"$needle"* ]]; then
    echo "  ${GREEN}PASS${RESET}  $label  (stdout contains '$needle')"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  ${RED}FAIL${RESET}  $label  (stdout missing '$needle')"
    log_verbose "stdout: ${_LAST_STDOUT:0:300}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILURES+=("$label (stdout missing '$needle')")
  fi
}

# assert_stderr_contains <label> <substring>
assert_stderr_contains() {
  local label="$1"
  local needle="$2"
  if [[ "$_LAST_STDERR" == *"$needle"* ]]; then
    echo "  ${GREEN}PASS${RESET}  $label  (stderr contains '$needle')"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  ${RED}FAIL${RESET}  $label  (stderr missing '$needle')"
    log_verbose "stderr: ${_LAST_STDERR:0:300}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILURES+=("$label (stderr missing '$needle')")
  fi
}

# assert_stdout_empty <label>
assert_stdout_empty() {
  local label="$1"
  if [[ -z "$_LAST_STDOUT" ]]; then
    echo "  ${GREEN}PASS${RESET}  $label  (stdout empty)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  ${RED}FAIL${RESET}  $label  (stdout not empty: ${_LAST_STDOUT:0:100})"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILURES+=("$label (stdout not empty)")
  fi
}

# assert_valid_json <label>
assert_valid_json() {
  local label="$1"
  if echo "$_LAST_STDOUT" | python3 -m json.tool >/dev/null 2>&1; then
    echo "  ${GREEN}PASS${RESET}  $label  (valid JSON)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  ${RED}FAIL${RESET}  $label  (invalid JSON)"
    log_verbose "stdout: ${_LAST_STDOUT:0:200}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILURES+=("$label (invalid JSON)")
  fi
}

# Internal state for the last command
_LAST_STDOUT=""
_LAST_STDERR=""
_LAST_EXIT=0

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

echo ""
echo "${BOLD}============================================${RESET}"
echo "${BOLD} CLI Smoke Test — Commander Upgrade Spec 6.4${RESET}"
echo "${BOLD}============================================${RESET}"
echo ""
echo "repo:    $REPO_ROOT"
echo "env:     ${ENV_LOCAL:-<none>}"
echo "asp:     $ASP_BIN"
echo "acp:     $ACP_BIN"
echo "hrc:     $HRC_BIN"
echo "hrcchat: $HRCCHAT_BIN"
echo ""

# ---------------------------------------------------------------------------
# 1. ASP (packages/cli — @lherron/agent-spaces)
# ---------------------------------------------------------------------------

echo "${BOLD}--- asp ---${RESET}"

run_cli "asp --help exits 0" 0 "$ASP_BIN --help" || true
assert_stdout_contains "asp --help shows commands" "Commands:"

run_cli "asp self --help exits 0" 0 "$ASP_BIN self --help" || true
assert_stdout_contains "asp self --help shows inspect" "inspect"

run_cli "asp doctor exits 0" 0 "$ASP_BIN doctor" || true
assert_stdout_contains "asp doctor mentions ASP_HOME" "ASP_HOME"

run_cli "asp <unknown> exits 2" 2 "$ASP_BIN definitely-not-a-command" || true
assert_stderr_contains "asp <unknown> mentions command" "definitely-not-a-command"

echo ""

# ---------------------------------------------------------------------------
# 2. ACP (packages/acp-cli)
# ---------------------------------------------------------------------------

echo "${BOLD}--- acp ---${RESET}"

run_cli "acp --help exits 0" 0 "$ACP_BIN --help" || true
assert_stdout_contains "acp --help shows commands" "Commands:"

run_cli "acp task --help exits 0" 0 "$ACP_BIN task --help" || true
assert_stdout_contains "acp task --help shows create" "create"

run_cli "acp task create --help exits 0" 0 "$ACP_BIN task create --help" || true
assert_stdout_contains "acp task create --help shows --role" "--role"

run_cli "acp <unknown> exits 2" 2 "$ACP_BIN definitely-not-a-command" || true
assert_stderr_contains "acp <unknown> mentions command" "definitely-not-a-command"

echo ""

# ---------------------------------------------------------------------------
# 3. HRC (packages/hrc-cli)
# ---------------------------------------------------------------------------

echo "${BOLD}--- hrc ---${RESET}"

run_cli "hrc --help exits 0" 0 "$HRC_BIN --help" || true
assert_stdout_contains "hrc --help shows commands" "Commands:"

for group in server session runtime launch turn inflight surface bridge monitor; do
  run_cli "hrc $group --help exits 0" 0 "$HRC_BIN $group --help" || true
  assert_stdout_contains "hrc $group --help shows usage" "Usage:"
done

for command in start run capture attach; do
  run_cli "hrc $command --help exits 0" 0 "$HRC_BIN $command --help" || true
  assert_stdout_contains "hrc $command --help shows usage" "Usage:"
done

run_cli "hrc server status --json exits 0" 0 "$HRC_BIN server status --json" || true
assert_valid_json "hrc server status --json is valid JSON"
assert_stdout_contains "hrc server status --json has running key" "running"

run_cli "hrc monitor watch --from-seq -1 exits 2 (integer validation)" 2 "$HRC_BIN monitor watch --from-seq -1" || true
assert_stderr_contains "hrc monitor watch --from-seq -1 error message" "positive integer"

run_cli "hrc <unknown> exits 2" 2 "$HRC_BIN definitely-not-a-command" || true
assert_stderr_contains "hrc <unknown> mentions command" "definitely-not-a-command"

echo ""

# ---------------------------------------------------------------------------
# 4. HRCCHAT (packages/hrcchat-cli)
# ---------------------------------------------------------------------------

echo "${BOLD}--- hrcchat ---${RESET}"

run_cli "hrcchat --help exits 0" 0 "$HRCCHAT_BIN --help" || true
assert_stdout_contains "hrcchat --help shows commands" "Commands:"

run_cli "hrcchat info exits 0" 0 "$HRCCHAT_BIN info" || true
assert_stdout_contains "hrcchat info shows COMMANDS section" "COMMANDS"
assert_stdout_contains "hrcchat info mentions dm" "dm"

run_cli "hrcchat dm (no args) exits 2 — missing required arg" 2 "$HRCCHAT_BIN dm" || true

run_cli "hrcchat dm <target> --timeout invalid exits 2" 2 "$HRCCHAT_BIN dm human hello --timeout invalid" || true
assert_stderr_contains "hrcchat --timeout invalid mentions duration" "duration"

run_cli "hrcchat <unknown> exits 2 — unknown command" 2 "$HRCCHAT_BIN definitely-not-a-command" || true
assert_stderr_contains "hrcchat <unknown> mentions command" "definitely-not-a-command"

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

TOTAL=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))

echo "${BOLD}============================================${RESET}"
echo "${BOLD} Results${RESET}"
echo "${BOLD}============================================${RESET}"
echo ""
echo "  Total:   $TOTAL"
echo "  ${GREEN}Passed:  $PASS_COUNT${RESET}"
echo "  ${RED}Failed:  $FAIL_COUNT${RESET}"
[[ "$SKIP_COUNT" -gt 0 ]] && echo "  ${YELLOW}Skipped: $SKIP_COUNT${RESET}"
echo ""

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo "${RED}${BOLD}Failures:${RESET}"
  for f in "${FAILURES[@]}"; do
    echo "  ${RED}-${RESET} $f"
  done
  echo ""
fi

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "${RED}${BOLD}SMOKE TEST FAILED${RESET} ($FAIL_COUNT failure(s))"
  exit 1
else
  echo "${GREEN}${BOLD}ALL SMOKE TESTS PASSED${RESET}"
  exit 0
fi
