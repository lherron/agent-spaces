#!/usr/bin/env bash
# cli-smoke.sh - installed ASP CLI smoke test

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERBOSE="${1:-}"

ENV_LOCAL="$REPO_ROOT/.env.local"
if [[ -f "$ENV_LOCAL" ]]; then
  set -a
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    export "$key=$value"
  done < "$ENV_LOCAL"
  set +a
fi

: "${WRKQ_DB_PATH:=/Users/lherron/praesidium/var/db/wrkq.db}"
: "${WRKQ_ACTOR:=local-human}"
: "${ASP_PROJECT:=agent-spaces}"
: "${ASP_HOME:=/Users/lherron/praesidium/var/spaces-repo}"
: "${ASP_ROOT_DIR:=/Users/lherron/praesidium/var/spaces-repo}"

ASP_BIN="${ASP_BIN:-asp}"

ENV_PREFIX="WRKQ_DB_PATH=$WRKQ_DB_PATH WRKQ_ACTOR=$WRKQ_ACTOR ASP_PROJECT=$ASP_PROJECT ASP_HOME=$ASP_HOME ASP_ROOT_DIR=$ASP_ROOT_DIR"

PASS_COUNT=0
FAIL_COUNT=0
FAILURES=()

if [[ -t 1 ]]; then
  GREEN=$'\033[0;32m'
  RED=$'\033[0;31m'
  CYAN=$'\033[0;36m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  GREEN="" RED="" CYAN="" BOLD="" RESET=""
fi

log_verbose() { [[ "$VERBOSE" == "--verbose" ]] && echo "${CYAN}[smoke]${RESET} $*" || true; }

run_cli() {
  local label="$1"
  local expected_exit="$2"
  shift 2
  local cmd_str="$*"

  local stdout_file stderr_file
  stdout_file=$(mktemp)
  stderr_file=$(mktemp)

  local actual_exit=0
  eval "$ENV_PREFIX $cmd_str" >"$stdout_file" 2>"$stderr_file" || actual_exit=$?

  _LAST_STDOUT="$(cat "$stdout_file")"
  _LAST_STDERR="$(cat "$stderr_file")"
  _LAST_EXIT="$actual_exit"
  rm -f "$stdout_file" "$stderr_file"

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  ${GREEN}PASS${RESET}  $label  (exit $actual_exit)"
    log_verbose "cmd: $cmd_str"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  fi

  echo "  ${RED}FAIL${RESET}  $label  (expected exit $expected_exit, got $actual_exit)"
  log_verbose "cmd: $cmd_str"
  [[ -n "$_LAST_STDERR" ]] && log_verbose "stderr: ${_LAST_STDERR:0:300}"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILURES+=("$label (expected exit $expected_exit, got $actual_exit)")
  return 1
}

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

_LAST_STDOUT=""
_LAST_STDERR=""
_LAST_EXIT=0

echo ""
echo "${BOLD}============================================${RESET}"
echo "${BOLD} ASP CLI Smoke Test${RESET}"
echo "${BOLD}============================================${RESET}"
echo ""
echo "repo:    $REPO_ROOT"
echo "env:     ${ENV_LOCAL:-<none>}"
echo "asp:     $ASP_BIN"
echo ""

run_cli "asp --help exits 0" 0 "$ASP_BIN --help" || true
assert_stdout_contains "asp --help shows commands" "Commands:"

run_cli "asp self --help exits 0" 0 "$ASP_BIN self --help" || true
assert_stdout_contains "asp self --help shows inspect" "inspect"

run_cli "asp doctor exits 0" 0 "$ASP_BIN doctor" || true
assert_stdout_contains "asp doctor mentions ASP_HOME" "ASP_HOME"

run_cli "asp <unknown> exits 2" 2 "$ASP_BIN definitely-not-a-command" || true
assert_stderr_contains "asp <unknown> mentions command" "definitely-not-a-command"

TOTAL=$((PASS_COUNT + FAIL_COUNT))

echo ""
echo "${BOLD}============================================${RESET}"
echo "${BOLD} Results${RESET}"
echo "${BOLD}============================================${RESET}"
echo ""
echo "  Total:   $TOTAL"
echo "  ${GREEN}Passed:  $PASS_COUNT${RESET}"
echo "  ${RED}Failed:  $FAIL_COUNT${RESET}"
echo ""

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo "${RED}${BOLD}Failures:${RESET}"
  for failure in "${FAILURES[@]}"; do
    echo "  ${RED}-${RESET} $failure"
  done
  echo ""
fi

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "${RED}${BOLD}SMOKE TEST FAILED${RESET} ($FAIL_COUNT failure(s))"
  exit 1
fi

echo "${GREEN}${BOLD}ALL SMOKE TESTS PASSED${RESET}"
