#!/usr/bin/env bash
# run-closeout-e2e.sh — E2E acceptance harness for agent-spaces-closeout@1
#
# 9 tests mapped 1:1 to CONTRACT.md §"The 9 REQUIRED TESTS"
# Drives the INSTALLED `wrkf` binary against a throwaway db per the
# wrkf-authoring proof recipe.  Template under test:
#   agent-spaces/.wrkq/wrkf-closeout/agent-spaces-closeout.v1.workflow.json
#
# Usage:
#   ./tests/run-closeout-e2e.sh           # run all 9 tests
#   ./tests/run-closeout-e2e.sh --test N  # run single test N (1-9)
#
# Exit 0 only if all selected tests pass.

set -uo pipefail

# ── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOSEOUT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"  # .wrkq/wrkf-closeout/
TEMPLATE="$CLOSEOUT_DIR/agent-spaces-closeout.v1.workflow.json"
CATALOG="$CLOSEOUT_DIR/hook-catalog.json"
WORKFLOW_REF="agent-spaces-closeout@1"

# ── Arg parsing ───────────────────────────────────────────────────────────────
SELECTED_TEST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --test)
      SELECTED_TEST="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,11p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Colors ────────────────────────────────────────────────────────────────────
RED_C='\033[0;31m'
GREEN_C='\033[0;32m'
YELLOW_C='\033[1;33m'
CYAN_C='\033[0;36m'
NC='\033[0m'

# ── Counters ─────────────────────────────────────────────────────────────────
PASS_COUNT=0
FAIL_COUNT=0
declare -a FAILED_TESTS=()

# ── Utility helpers ───────────────────────────────────────────────────────────
log()  { echo -e "${CYAN_C}  ▸ $*${NC}"; }
pass() { echo -e "${GREEN_C}  ✓ $*${NC}"; }
fail() { echo -e "${RED_C}  ✗ $*${NC}"; }

# assert_eq LABEL EXPECTED ACTUAL
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label: '$actual'"
    return 0
  else
    fail "$label: expected '$expected', got '$actual'"
    return 1
  fi
}

# assert_contains LABEL PATTERN TEXT
assert_contains() {
  local label="$1" pattern="$2" text="$3"
  if echo "$text" | grep -qE "$pattern"; then
    pass "$label: pattern '$pattern' found"
    return 0
  else
    fail "$label: pattern '$pattern' NOT found in: $(echo "$text" | head -3)"
    return 1
  fi
}

# assert_diag_fields LABEL CHECK_RUN_JSON
# Verifies all 7 §3 diagnostic fields appear in the check run's .summary JSON.
# The check-run summary is a JSON-encoded string in .checks[0].summary.
assert_diag_fields() {
  local label="$1" check_json="$2"
  local summary_str
  summary_str="$(echo "$check_json" | jq -r '.checks[0].summary // empty' 2>/dev/null || true)"
  if [[ -z "$summary_str" || "$summary_str" == "null" ]]; then
    fail "$label: no §3 diagnostic in check summary (got: $check_json)"
    return 1
  fi
  local diag
  diag="$(echo "$summary_str" | jq '.' 2>/dev/null || true)"
  if [[ -z "$diag" ]]; then
    fail "$label: §3 summary is not valid JSON: $summary_str"
    return 1
  fi
  log "$label §3 diag: $summary_str"
  local ok=0
  for field in requiredSurface claimClass recordedDiffFloor expectedKind reason; do
    local val
    val="$(echo "$diag" | jq -r ".$field // empty" 2>/dev/null || true)"
    if [[ -n "$val" && "$val" != "null" ]]; then
      pass "$label.diag.$field = '$val'"
    else
      fail "$label.diag.$field MISSING in: $summary_str"
      ok=1
    fi
  done
  # foundKind and foundExitCode may be null — just check key presence
  for field in foundKind foundExitCode; do
    if echo "$diag" | jq -e "has(\"$field\")" > /dev/null 2>&1; then
      local val
      val="$(echo "$diag" | jq -r ".$field // \"null\"" 2>/dev/null || true)"
      pass "$label.diag.$field key present (=$val)"
    else
      fail "$label.diag.$field key MISSING in: $summary_str"
      ok=1
    fi
  done
  return $ok
}

# ── DB setup ─────────────────────────────────────────────────────────────────
# setup_db DB_PATH → prints task ID on stdout; all other output to stderr
setup_db() {
  local db="$1"
  # Neutralise inherited project poisoning
  export ASP_PROJECT= WRKQ_PROJECT_ROOT=

  rm -f "$db" "${db}-shm" "${db}-wal" 2>/dev/null || true
  wrkqadm --db "$db" migrate >&2
  # Run init from /tmp so wrkqadm doesn't pollute the repo's .gitignore
  (cd /tmp && wrkqadm --db "$db" init) >&2

  # Seed distinct actors (one per workflow role) for SoD compliance
  wrkqadm --db "$db" actors add implementer-actor --role agent >&2
  wrkqadm --db "$db" actors add tester-actor      --role agent >&2
  wrkqadm --db "$db" actors add reviewer-actor    --role agent >&2
  wrkqadm --db "$db" actors add system-actor      --role system >&2

  # Project + container + task scaffold
  wrkq --db "$db" mkdir --kind project smoke >&2
  wrkq --db "$db" --project smoke mkdir inbox >&2
  local task_id
  task_id="$(wrkq --db "$db" --project smoke touch inbox/wf-smoke \
      -t "closeout-smoke" -d "throwaway" \
      --output json 2>/dev/null | jq -r '.[0].id')"
  echo "$task_id"
}

# cleanup_db DB_PATH
cleanup_db() {
  local db="$1"
  rm -f "$db" "${db}-shm" "${db}-wal" 2>/dev/null || true
}

# ── Template install ──────────────────────────────────────────────────────────
install_template() {
  local db="$1"
  if [[ ! -f "$TEMPLATE" ]]; then
    fail "TEMPLATE ABSENT: $TEMPLATE"
    return 1
  fi
  if [[ ! -f "$CATALOG" ]]; then
    fail "CATALOG ABSENT: $CATALOG"
    return 1
  fi
  if ! wrkf --db "$db" --hook-catalog "$CATALOG" workflow install "$TEMPLATE" 2>&1; then
    fail "wrkf workflow install failed"
    return 1
  fi
  pass "Template $WORKFLOW_REF installed"
  return 0
}

# ── wrkf shorthand with db + catalog ─────────────────────────────────────────
# wf DB_PATH [wrkf args...]
wf() {
  local db="$1"; shift
  wrkf --db "$db" --hook-catalog "$CATALOG" "$@"
}

# ── Get obligation ID by kind ─────────────────────────────────────────────────
# get_obligation_id DB TASK KIND → prints obligation ID (e.g. obl_000001)
get_obligation_id() {
  local db="$1" task="$2" kind="$3"
  wf "$db" obligation list "$task" --all --json 2>/dev/null \
    | jq -r --arg k "$kind" '.obligations[] | select(.kind==$k) | .id' 2>/dev/null \
    | head -1
}

# ── Walk the workflow from intake → active/review ─────────────────────────────
# walk_to_review DB TASK_ID CLAIM_CLASS [DIFF_FLOOR_SURFACE] [DIFF_FILES_JSON]
# CLAIM_CLASS: docs|logic|contract|packaging|harness|runtime
# DIFF_FLOOR_SURFACE: (optional) strongestSurface fact for changed_files evidence
# DIFF_FILES_JSON: (optional) files array JSON string for changed_files data
walk_to_review() {
  local db="$1" task="$2" claim_class="$3"
  local diff_floor="${4:-}"
  local diff_files="${5:-}"

  log "walk_to_review: claim_class=$claim_class diff_floor=${diff_floor:-none}"

  # 1. Tester adds red_test evidence, then author_red transition
  wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind red_test \
      --ref "file://tests/red.txt" \
      --facts '{"verdict":"red"}' \
      --summary "red bar from test harness" >&2

  wf "$db" --actor tester-actor --role tester \
      transition "$task" author_red >&2

  # 2. Implementer adds verify (+ optional changed_files), then implement transition
  wf "$db" --actor implementer-actor --role implementer \
      evidence add "$task" \
      --kind verify \
      --ref "file://tests/verify.txt" \
      --facts '{"verdict":"pass"}' \
      --summary "verify green from test harness" >&2

  if [[ -n "$diff_floor" ]]; then
    local files_data="${diff_files:-[\"packages/harness-broker/src/core.ts\"]}"
    log "  adding changed_files evidence (floor=$diff_floor, files=$files_data)..."
    wf "$db" --actor implementer-actor --role implementer \
        evidence add "$task" \
        --kind changed_files \
        --ref "file://tests/changed-files.txt" \
        --facts "{\"strongestSurface\":\"$diff_floor\"}" \
        --data "{\"files\":$files_data}" \
        --summary "recorded diff floor from test harness" >&2
  fi

  wf "$db" --actor implementer-actor --role implementer \
      transition "$task" implement >&2

  # 3. Tester adds closeout_claim + verify_full, then full_verify transition
  wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind closeout_claim \
      --ref "file://tests/closeout-claim.txt" \
      --facts "{\"claimClass\":\"$claim_class\"}" \
      --summary "closeout claim from test harness" >&2

  wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind verify_full \
      --ref "file://tests/verify-full.txt" \
      --facts '{"verdict":"pass"}' \
      --summary "full verify from test harness" >&2

  wf "$db" --actor tester-actor --role tester \
      transition "$task" full_verify >&2

  # Verify we reached active/review
  local status phase
  status="$(wf "$db" task inspect "$task" --json 2>/dev/null | jq -r '.status // empty')"
  phase="$(wf  "$db" task inspect "$task" --json 2>/dev/null | jq -r '.phase  // empty')"
  if [[ "$status" != "active" || "$phase" != "review" ]]; then
    fail "walk_to_review: expected active/review, got $status/$phase"
    return 1
  fi
  pass "walk_to_review: reached active/review ✓"
}

# ── Add all sign_off transition requirements ──────────────────────────────────
# add_signoff_requirements DB TASK_ID
# Adds installed_binary + review_signoff evidence and satisfies both obligations.
add_signoff_requirements() {
  local db="$1" task="$2"

  log "  adding installed_binary evidence as reviewer..."
  wf "$db" --actor reviewer-actor --role reviewer \
      evidence add "$task" \
      --kind installed_binary \
      --ref "file://$(which wrkf)" \
      --facts '{"verdict":"pass","binary":"wrkf"}' \
      --summary "installed binary smoke from test harness" >&2

  log "  adding review_signoff evidence as reviewer..."
  wf "$db" --actor reviewer-actor --role reviewer \
      evidence add "$task" \
      --kind review_signoff \
      --ref "file://tests/review.txt" \
      --facts '{"verdict":"approved"}' \
      --summary "reviewer approval from test harness" >&2

  # Satisfy obligations by ID (not kind name)
  local rs_id ce_id
  rs_id="$(get_obligation_id "$db" "$task" "review_signoff")"
  ce_id="$(get_obligation_id "$db" "$task" "closeout_evidence")"
  log "  satisfying review_signoff obligation ($rs_id)..."
  wf "$db" --actor reviewer-actor --role reviewer \
      obligation satisfy "$task" "$rs_id" \
      --reason "reviewer submitted signoff evidence" >&2
  log "  satisfying closeout_evidence obligation ($ce_id)..."
  wf "$db" --actor reviewer-actor --role reviewer \
      obligation satisfy "$task" "$ce_id" \
      --reason "reviewer attests coverage evidence submitted" >&2
}

# ── Deliver all pending set_task_state effects ────────────────────────────────
# deliver_effects DB TASK_ID
deliver_effects() {
  local db="$1" task="$2"
  local eff_ids
  eff_ids="$(wf "$db" effect list "$task" --json 2>/dev/null | jq -r '.effects[] | select(.status=="pending") | .id' 2>/dev/null || true)"
  if [[ -z "$eff_ids" ]]; then
    log "  no pending effects to deliver"
    return 0
  fi
  while IFS= read -r eff_id; do
    log "  delivering effect $eff_id..."
    wf "$db" effect deliver "$eff_id" >&2
  done <<< "$eff_ids"
}

# ── Run check and assert §3 rejection ────────────────────────────────────────
# run_check_assert_reject DB TASK_ID LABEL
# Runs the closeout_evidence_coverage check, asserts it FAILS with §3 diag,
# then asserts the transition is BLOCKED.
run_check_assert_reject() {
  local db="$1" task="$2" label="$3"
  local ok=0

  log "  running check run sign_off..."
  local check_out check_rc=0
  check_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      check run "$task" sign_off --json 2>&1)" || check_rc=$?

  log "  check run output: $check_out"

  local verdict
  verdict="$(echo "$check_out" | jq -r '.checks[0].verdict // empty' 2>/dev/null || true)"
  if [[ "$verdict" == "fail" ]]; then
    pass "$label: check verdict=fail as expected"
  else
    fail "$label: check verdict expected 'fail', got '$verdict'"
    ok=1
  fi

  # Assert §3 diagnostic fields in the check summary
  assert_diag_fields "$label" "$check_out" || ok=1

  # Transition must be BLOCKED (check failed → engine blocks sign_off)
  log "  attempting transition sign_off (expect WRKF_TRANSITION_BLOCKED)..."
  local tr_out tr_rc=0
  tr_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --json 2>&1)" || tr_rc=$?
  log "  transition output (rc=$tr_rc): $tr_out"

  # Should be a blocked error, not success
  local err_code
  err_code="$(echo "$tr_out" | jq -r '.error.code // empty' 2>/dev/null || true)"
  if [[ "$err_code" == "WRKF_TRANSITION_BLOCKED" ]]; then
    pass "$label: transition correctly BLOCKED (WRKF_TRANSITION_BLOCKED)"
  else
    fail "$label: expected WRKF_TRANSITION_BLOCKED, got: err=$err_code rc=$tr_rc"
    ok=1
  fi

  # Task must NOT be in closed/done
  local status phase
  status="$(wf "$db" task inspect "$task" --json 2>/dev/null | jq -r '.status // empty')"
  phase="$(wf  "$db" task inspect "$task" --json 2>/dev/null | jq -r '.phase  // empty')"
  if [[ "$status" == "closed" && "$phase" == "done" ]]; then
    fail "$label: task incorrectly reached closed/done"
    ok=1
  else
    pass "$label: task remains in $status/$phase (not done) ✓"
  fi

  return $ok
}

# ── inspect task state ────────────────────────────────────────────────────────
get_task_field() {
  local db="$1" task="$2" field="${3:-status}"
  wf "$db" task inspect "$task" --json 2>/dev/null \
    | jq -r ".$field // empty" 2>/dev/null || true
}

# ── run_test orchestrator ─────────────────────────────────────────────────────
run_test() {
  local num="$1" desc="$2" fn="$3"

  if [[ -n "$SELECTED_TEST" && "$SELECTED_TEST" != "$num" ]]; then
    return 0
  fi

  echo ""
  echo -e "${CYAN_C}══════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN_C}  TEST $num: $desc${NC}"
  echo -e "${CYAN_C}══════════════════════════════════════════════════════${NC}"

  local db
  db="$(mktemp -u /tmp/wrkf-closeout-t${num}-XXXXXX.db)"

  local rc=0
  "$fn" "$db" || rc=$?

  cleanup_db "$db"

  if [[ $rc -eq 0 ]]; then
    echo -e "${GREEN_C}[PASS] TEST $num${NC}"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "${RED_C}[FAIL] TEST $num (exit $rc)${NC}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_TESTS+=("$num: $desc")
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 1 — validate + install the exact template+catalog used live
# CONTRACT: "wrkf --hook-catalog <cat> workflow validate then install — the
#            exact template+catalog used live."
# ═══════════════════════════════════════════════════════════════════════════════
test_1() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"

  # Template and catalog must exist
  if [[ ! -f "$TEMPLATE" ]]; then
    fail "TEMPLATE ABSENT — harness is RED (Phase 2 not yet delivered)"; return 1
  fi
  if [[ ! -f "$CATALOG" ]]; then
    fail "CATALOG ABSENT — harness is RED (Phase 2 not yet delivered)"; return 1
  fi

  local ok=0

  log "Running: wrkf workflow validate $TEMPLATE"
  if ! wf "$db" workflow validate "$TEMPLATE" 2>&1; then
    fail "workflow validate failed"; ok=1
  else
    pass "workflow validate passed"
  fi

  log "Running: wrkf workflow install $TEMPLATE"
  if ! wf "$db" workflow install "$TEMPLATE" 2>&1; then
    fail "workflow install failed"; ok=1
  else
    pass "workflow install passed"
  fi

  log "Confirming template listed after install..."
  # workflow list --json emits {"templates":[...]} — use .templates[]
  local list_out
  list_out="$(wf "$db" workflow list --json 2>/dev/null || true)"
  if echo "$list_out" | jq -e '.templates[] | select(.id == "agent-spaces-closeout" and .version == "1")' > /dev/null 2>&1; then
    pass "template agent-spaces-closeout@1 present in registry"
  else
    fail "template agent-spaces-closeout@1 NOT found in registry; list: $list_out"
    ok=1
  fi

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 2 — facts enum enforced, producer restrictions, new-kind facts
# CONTRACT: "Template/role: closeout_claim facts enum enforced, producer
#            restrictions, new-kind facts, installed_binary reuse."
# ═══════════════════════════════════════════════════════════════════════════════
test_2() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"
  install_template "$db" || return 1

  wf "$db" --actor tester-actor --role tester \
      task attach "$task" --workflow "$WORKFLOW_REF" >&2

  local ok=0
  local add_out rc

  # 2a. closeout_claim with INVALID claimClass enum → must fail
  log "2a. closeout_claim with invalid claimClass (should reject)..."
  rc=0
  add_out="$(wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind closeout_claim \
      --ref "file://tests/claim.txt" \
      --facts '{"claimClass":"nonexistent_invalid"}' 2>&1)" || rc=$?
  if [[ $rc -ne 0 ]]; then
    pass "2a. invalid claimClass correctly rejected (exit $rc)"
  else
    fail "2a. invalid claimClass was NOT rejected (exit 0, output: $add_out)"; ok=1
  fi

  # 2b. closeout_claim produced by REVIEWER (wrong role) → must fail
  log "2b. closeout_claim as reviewer (wrong role, should reject)..."
  rc=0
  add_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      evidence add "$task" \
      --kind closeout_claim \
      --ref "file://tests/claim.txt" \
      --facts '{"claimClass":"logic"}' 2>&1)" || rc=$?
  if [[ $rc -ne 0 ]]; then
    pass "2b. reviewer producing closeout_claim correctly rejected (exit $rc)"
  else
    fail "2b. reviewer producing closeout_claim was NOT rejected (exit 0)"; ok=1
  fi

  # 2c. installed_binary produced by TESTER (wrong role) → must fail
  log "2c. installed_binary as tester (wrong role, should reject)..."
  rc=0
  add_out="$(wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind installed_binary \
      --ref "file://$(which wrkf)" \
      --facts '{"verdict":"pass","binary":"wrkf"}' 2>&1)" || rc=$?
  if [[ $rc -ne 0 ]]; then
    pass "2c. tester producing installed_binary correctly rejected (exit $rc)"
  else
    fail "2c. tester producing installed_binary was NOT rejected (exit 0)"; ok=1
  fi

  # 2d. closeout_claim with VALID claimClass as tester → must succeed
  log "2d. closeout_claim with valid claimClass as tester (should succeed)..."
  rc=0
  add_out="$(wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind closeout_claim \
      --ref "file://tests/claim.txt" \
      --facts '{"claimClass":"logic"}' 2>&1)" || rc=$?
  if [[ $rc -eq 0 ]]; then
    pass "2d. valid closeout_claim accepted"
  else
    fail "2d. valid closeout_claim was rejected (exit $rc, output: $add_out)"; ok=1
  fi

  # 2e. changed_files with valid strongestSurface → must succeed
  log "2e. changed_files with strongestSurface=logic as tester (should succeed)..."
  rc=0
  add_out="$(wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind changed_files \
      --ref "file://tests/changed.txt" \
      --facts '{"strongestSurface":"logic"}' \
      --data '{"files":["src/foo.ts"]}' 2>&1)" || rc=$?
  if [[ $rc -eq 0 ]]; then
    pass "2e. valid changed_files accepted"
  else
    fail "2e. valid changed_files was rejected (exit $rc, output: $add_out)"; ok=1
  fi

  # 2f. installed_binary with required facts (verdict+binary) as reviewer → must succeed
  log "2f. installed_binary with verdict+binary as reviewer (should succeed)..."
  rc=0
  add_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      evidence add "$task" \
      --kind installed_binary \
      --ref "file://$(which wrkf)" \
      --facts '{"verdict":"pass","binary":"wrkf"}' 2>&1)" || rc=$?
  if [[ $rc -eq 0 ]]; then
    pass "2f. valid installed_binary (reviewer) accepted"
  else
    fail "2f. valid installed_binary (reviewer) was rejected (exit $rc)"; ok=1
  fi

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 3 — RED: surface mismatch → check FAILS + §3 diagnostic present
# CONTRACT: "RED: runtime diff-floor/claim with only verify/unit evidence →
#            sign_off REJECTED, §3 fields present."
# Strategy: claimClass=harness (requires matrix); only verify evidence (covers
#            logic only) → hook exits 1, §3 diag present, transition BLOCKED.
# ═══════════════════════════════════════════════════════════════════════════════
test_3() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"
  install_template "$db" || return 1
  wf "$db" --actor tester-actor --role tester \
      task attach "$task" --workflow "$WORKFLOW_REF" >&2

  # Walk to review with harness claim; no matrix coverage provided
  walk_to_review "$db" "$task" "harness" || return 1

  # Add sign_off transition requirements (installed_binary covers runtime, not harness)
  add_signoff_requirements "$db" "$task" || return 1

  local ok=0

  # Run check → expect FAIL with §3 diag; then assert transition is BLOCKED
  run_check_assert_reject "$db" "$task" "test3" || ok=1

  # §3 must show expectedKind=matrix (harness surface coverage)
  local check_out
  check_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      check run "$task" sign_off --json 2>&1)" || true
  local expected_kind
  expected_kind="$(echo "$check_out" | jq -r '.checks[0].summary // "null"' 2>/dev/null \
      | jq -r '.expectedKind // empty' 2>/dev/null || true)"
  if [[ "$expected_kind" == "matrix" ]]; then
    pass "test3.§3.expectedKind = matrix (harness surface)"
  else
    fail "test3.§3.expectedKind: expected 'matrix', got '$expected_kind'"; ok=1
  fi

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 4 — GREEN: installed_binary/real-e2e → sign_off → done + completed
# CONTRACT: "GREEN: same with a successful installed_binary/real-e2e evidence →
#            sign_off permitted → done + task completed."
# Strategy: claimClass=runtime, installed_binary (verdict:pass) covers runtime.
# ═══════════════════════════════════════════════════════════════════════════════
test_4() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"
  install_template "$db" || return 1
  wf "$db" --actor tester-actor --role tester \
      task attach "$task" --workflow "$WORKFLOW_REF" >&2

  # Walk to review with runtime claim; installed_binary covers runtime surface
  walk_to_review "$db" "$task" "runtime" || return 1

  # Add sign_off requirements (installed_binary covers runtime → check passes)
  add_signoff_requirements "$db" "$task" || return 1

  local ok=0

  log "Running sign_off --run-checks (GREEN: runtime covered by installed_binary)..."
  local signoff_out signoff_rc=0
  signoff_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --run-checks --json 2>&1)" || signoff_rc=$?
  log "sign_off output (rc=$signoff_rc): $(echo "$signoff_out" | jq -c '{outcome, state}' 2>/dev/null || echo "$signoff_out")"

  # Task must reach closed/done
  local status phase
  status="$(get_task_field "$db" "$task" "status")"
  phase="$(get_task_field  "$db" "$task" "phase")"
  assert_eq "4. task.status" "closed" "$status" || ok=1
  assert_eq "4. task.phase"  "done"   "$phase"  || ok=1

  # Deliver set_task_state effect so wrkq state reflects completed
  deliver_effects "$db" "$task" || true

  local wrkq_state
  wrkq_state="$(wrkq --db "$db" --project smoke cat "inbox/wf-smoke" --output json 2>/dev/null \
      | jq -r '.[0].state // empty' 2>/dev/null || true)"
  assert_eq "4. wrkq task state" "completed" "$wrkq_state" || ok=1

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 5 — failed evidence exec records but check STILL rejects (data.exitCode trap)
# CONTRACT: "Failed-command: evidence exec with NONZERO exit records evidence
#            (and exits nonzero), but the check STILL rejects (proves
#            data.exitCode==0 inspection, not just facts.verdict=pass)."
# Strategy: exec `false` as matrix kind → exitCode=1 in data;
#           hook sees data.exitCode=1 → NOT covered → §3 diag foundExitCode=1.
# ═══════════════════════════════════════════════════════════════════════════════
test_5() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"
  install_template "$db" || return 1
  wf "$db" --actor tester-actor --role tester \
      task attach "$task" --workflow "$WORKFLOW_REF" >&2

  # Walk to review with harness claim (needs matrix coverage)
  walk_to_review "$db" "$task" "harness" || return 1

  local ok=0

  # Run evidence exec with a command that EXITS NONZERO → exitCode=1 in evidence data
  log "5. Running evidence exec with failing command (false)..."
  local exec_rc=0
  wf "$db" --actor tester-actor --role tester \
      evidence exec "$task" \
      --kind matrix \
      --facts '{}' \
      --summary "failing matrix command (test 5)" \
      -- false 2>&1 || exec_rc=$?

  if [[ $exec_rc -ne 0 ]]; then
    pass "5. evidence exec exited nonzero ($exec_rc) as expected"
  else
    fail "5. evidence exec exited 0 — should have been nonzero for `false`"; ok=1
  fi

  # Verify the evidence WAS RECORDED despite nonzero exit
  local evidence_list
  evidence_list="$(wf "$db" evidence list "$task" --json 2>/dev/null || true)"
  # evidence list --json emits {"evidence":[...]} — use .evidence[]
  if echo "$evidence_list" | jq -e '.evidence[] | select(.kind == "matrix")' > /dev/null 2>&1; then
    pass "5. matrix evidence recorded despite nonzero exec exit"
  else
    fail "5. matrix evidence NOT recorded (expected to be recorded)"; ok=1
  fi

  # Add sign_off requirements
  add_signoff_requirements "$db" "$task" || return 1

  # Run check; must FAIL with foundExitCode=1 in §3 diag
  log "5. Running check run (expect rejection: data.exitCode=1 for matrix)..."
  local check_out
  check_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      check run "$task" sign_off --json 2>&1)" || true
  log "5. check run: $check_out"

  run_check_assert_reject "$db" "$task" "test5" || ok=1

  # Assert §3.foundExitCode = 1 (the key proof: exitCode=0 required, got 1)
  local check_out2
  check_out2="$(wf "$db" --actor reviewer-actor --role reviewer \
      check run "$task" sign_off --json 2>&1)" || true
  local found_exit_code
  found_exit_code="$(echo "$check_out2" | jq -r '.checks[0].summary // "null"' 2>/dev/null \
      | jq -r '.foundExitCode // "MISSING"' 2>/dev/null || true)"
  if [[ "$found_exit_code" == "1" ]]; then
    pass "5. §3.foundExitCode = 1 (proves data.exitCode==0 inspection)"
  else
    fail "5. §3.foundExitCode: expected 1, got '$found_exit_code'"; ok=1
  fi

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 6 — recorded changed_files floor drives coverage; empty live staged diff loses
# CONTRACT: "Diff-source: a recorded changed_files/committed-or-unstaged floor
#            drives the correct (higher) requirement; an empty live staged diff
#            can NOT downgrade it."
# Strategy:
#   - changed_files: strongestSurface="harness",
#     files=["packages/harness-broker/src/core.ts"] (matches harness globs)
#   - closeout_claim: claimClass="docs" (rank 1, weakest)
#   - requiredSurface = max(docs=1, harness=5) = harness (floor wins)
#   - Coverage provided: docs_reachability (covers docs, NOT harness)
#   - installed_binary (transition req) covers runtime (rank 6), NOT harness (rank 5)
#   - Hook must fail: needs matrix (harness) — not present
# ═══════════════════════════════════════════════════════════════════════════════
test_6() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"
  install_template "$db" || return 1
  wf "$db" --actor tester-actor --role tester \
      task attach "$task" --workflow "$WORKFLOW_REF" >&2

  # Walk to review with docs claim AND harness-surface diff floor
  # Files in packages/harness-broker/ match the harness globs in closeout-config.json
  walk_to_review "$db" "$task" "docs" "harness" \
    '["packages/harness-broker/src/core.ts"]' || return 1

  # Add docs_reachability coverage (covers docs=1, NOT harness=5)
  log "6. Adding docs_reachability via evidence exec (exitCode=0, covers docs only)..."
  local exec_rc=0
  wf "$db" --actor tester-actor --role tester \
      evidence exec "$task" \
      --kind docs_reachability \
      --facts '{}' \
      --summary "docs reachability check" \
      -- echo "docs ok" 2>&1 || exec_rc=$?
  log "6. docs_reachability exec rc: $exec_rc"

  # Add sign_off requirements (installed_binary covers runtime=6, NOT harness=5)
  add_signoff_requirements "$db" "$task" || return 1

  local ok=0

  # Run check; hook should compute:
  #   claimSurface=docs(1), factFloor=harness(5), classifiedFloor=harness(5)
  #   (packages/harness-broker/src/core.ts matches harness glob)
  #   recordedDiffFloor=harness, requiredSurface=harness
  #   Coverage for harness = matrix; NOT found (only docs_reachability+installed_binary present)
  log "6. Running check run (expect: floor=harness, matrix coverage not provided)..."
  local check_out
  check_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      check run "$task" sign_off --json 2>&1)" || true
  log "6. check run: $check_out"

  run_check_assert_reject "$db" "$task" "test6" || ok=1

  # §3 diag must show recordedDiffFloor=harness (floor drove the requirement, not docs claim)
  local check_out2
  check_out2="$(wf "$db" --actor reviewer-actor --role reviewer \
      check run "$task" sign_off --json 2>&1)" || true
  local rec_floor
  rec_floor="$(echo "$check_out2" | jq -r '.checks[0].summary // "null"' 2>/dev/null \
      | jq -r '.recordedDiffFloor // empty' 2>/dev/null || true)"
  if [[ "$rec_floor" == "harness" ]]; then
    pass "6. §3.recordedDiffFloor = harness (floor beat docs claim)"
  else
    fail "6. §3.recordedDiffFloor expected 'harness', got '$rec_floor'"; ok=1
  fi

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 7 — no-run-checks / stale-check rejects
# CONTRACT: "No-check/stale-check: sign_off without --run-checks (or with a
#            check run that predates the latest evidence) → REJECTED;
#            pre-change/stale check rejects."
# ═══════════════════════════════════════════════════════════════════════════════
test_7() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"
  install_template "$db" || return 1
  wf "$db" --actor tester-actor --role tester \
      task attach "$task" --workflow "$WORKFLOW_REF" >&2

  # Walk to review with logic claim (verify covers logic → check will PASS once run)
  walk_to_review "$db" "$task" "logic" || return 1
  add_signoff_requirements "$db" "$task" || return 1

  local ok=0

  # 7a. sign_off with NO prior check run → must be BLOCKED
  log "7a. sign_off with NO check run (expect WRKF_TRANSITION_BLOCKED)..."
  local tr_out tr_rc=0
  tr_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --json 2>&1)" || tr_rc=$?
  log "7a. transition output (rc=$tr_rc): $tr_out"
  local err_code
  err_code="$(echo "$tr_out" | jq -r '.error.code // empty' 2>/dev/null || true)"
  if [[ "$err_code" == "WRKF_TRANSITION_BLOCKED" ]]; then
    pass "7a. no-check transition correctly BLOCKED"
  else
    fail "7a. expected WRKF_TRANSITION_BLOCKED, got: $err_code"; ok=1
  fi

  local status phase
  status="$(get_task_field "$db" "$task" "status")"
  phase="$(get_task_field  "$db" "$task" "phase")"
  if [[ "$status" == "closed" && "$phase" == "done" ]]; then
    fail "7a. task incorrectly reached closed/done"; ok=1
  else
    pass "7a. task remains $status/$phase"
  fi

  # 7b. Run check FIRST (GREEN: logic claim + verify covers → pass), then add new
  #     evidence to make check STALE, then try transition → BLOCKED stale
  log "7b. Running check (GREEN for logic claim with verify coverage)..."
  local check_out check_rc=0
  check_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      check run "$task" sign_off --json 2>&1)" || check_rc=$?
  local verdict
  verdict="$(echo "$check_out" | jq -r '.checks[0].verdict // empty' 2>/dev/null || true)"
  if [[ "$verdict" == "pass" ]]; then
    pass "7b. check passed (logic+verify coverage) — now adding evidence to make it stale"
  else
    fail "7b. check did NOT pass for logic+verify: verdict=$verdict; out=$check_out"; ok=1
  fi

  log "7b. Adding new evidence to make check stale..."
  wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind closeout_claim \
      --ref "file://tests/stale-claim.txt" \
      --facts '{"claimClass":"logic"}' \
      --summary "new evidence after check (makes stale)" >&2

  log "7b. Attempting transition with stale check (expect WRKF_TRANSITION_BLOCKED)..."
  tr_rc=0
  tr_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --json 2>&1)" || tr_rc=$?
  log "7b. stale transition output (rc=$tr_rc): $tr_out"
  local err_msg
  err_msg="$(echo "$tr_out" | jq -r '.error.message // empty' 2>/dev/null || true)"
  err_code="$(echo "$tr_out" | jq -r '.error.code // empty' 2>/dev/null || true)"
  if [[ "$err_code" == "WRKF_TRANSITION_BLOCKED" ]]; then
    pass "7b. stale check correctly BLOCKED: $err_msg"
  else
    fail "7b. expected WRKF_TRANSITION_BLOCKED for stale check, got: $err_code ($err_msg)"; ok=1
  fi

  # Check the stale message
  if echo "$err_msg" | grep -qiE "stale"; then
    pass "7b. error message mentions 'stale'"
  else
    fail "7b. stale error message expected to contain 'stale': $err_msg"; ok=1
  fi

  status="$(get_task_field "$db" "$task" "status")"
  phase="$(get_task_field  "$db" "$task" "phase")"
  if [[ "$status" == "closed" && "$phase" == "done" ]]; then
    fail "7b. task incorrectly reached closed/done with stale check"; ok=1
  else
    pass "7b. task remains $status/$phase with stale check"
  fi

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 8 — waiver records but cannot reach done
# CONTRACT: "Waiver: obligation waive closeout_evidence with ticketed reason
#            records but can NOT reach done; weak evidence + waived still rejects."
# ═══════════════════════════════════════════════════════════════════════════════
test_8() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"
  install_template "$db" || return 1
  wf "$db" --actor tester-actor --role tester \
      task attach "$task" --workflow "$WORKFLOW_REF" >&2

  walk_to_review "$db" "$task" "logic" || return 1

  local ok=0

  # Look up the closeout_evidence obligation ID (obl_XXXXXX)
  local ce_id
  ce_id="$(get_obligation_id "$db" "$task" "closeout_evidence")"
  log "8. closeout_evidence obligation ID: $ce_id"

  # Waive the closeout_evidence obligation (waiveRole=system, noSelfWaive=true)
  log "8. Waiving closeout_evidence obligation ($ce_id) as system-actor..."
  local waive_out waive_rc=0
  waive_out="$(wf "$db" --actor system-actor --role system \
      obligation waive "$task" "$ce_id" \
      --reason "CLOSEOUT-EXEMPT(T-99999): harness tests waiver path" 2>&1)" || waive_rc=$?
  log "8. waive output (rc=$waive_rc): $waive_out"

  if [[ $waive_rc -eq 0 ]]; then
    pass "8. obligation waive succeeded (recorded)"
  else
    fail "8. obligation waive failed unexpectedly (exit $waive_rc): $waive_out"; ok=1
  fi

  # Verify obligation is waived
  local obl_status
  obl_status="$(wf "$db" obligation list "$task" --all --json 2>/dev/null \
      | jq -r --arg id "$ce_id" '.obligations[] | select(.id==$id) | .status' 2>/dev/null || true)"
  if [[ "$obl_status" == "waived" ]]; then
    pass "8. closeout_evidence obligation status = waived ✓"
  else
    fail "8. closeout_evidence obligation status expected 'waived', got '$obl_status'"; ok=1
  fi

  # Add the other sign_off requirements (review_signoff satisfied; closeout_evidence waived, NOT satisfied)
  log "8. Adding installed_binary + review_signoff as reviewer..."
  wf "$db" --actor reviewer-actor --role reviewer \
      evidence add "$task" \
      --kind installed_binary \
      --ref "file://$(which wrkf)" \
      --facts '{"verdict":"pass","binary":"wrkf"}' \
      --summary "installed binary" >&2

  wf "$db" --actor reviewer-actor --role reviewer \
      evidence add "$task" \
      --kind review_signoff \
      --ref "file://tests/review.txt" \
      --facts '{"verdict":"approved"}' \
      --summary "reviewer approval" >&2

  local rs_id
  rs_id="$(get_obligation_id "$db" "$task" "review_signoff")"
  log "8. satisfying review_signoff obligation ($rs_id) as reviewer..."
  wf "$db" --actor reviewer-actor --role reviewer \
      obligation satisfy "$task" "$rs_id" \
      --reason "reviewer submitted signoff" >&2

  # Attempt sign_off — must be BLOCKED because closeout_evidence is waived, not satisfied
  log "8. Attempting sign_off (expect BLOCKED: closeout_evidence waived, not satisfied)..."
  local tr_out tr_rc=0
  tr_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --json 2>&1)" || tr_rc=$?
  log "8. sign_off output (rc=$tr_rc): $tr_out"
  local err_code
  err_code="$(echo "$tr_out" | jq -r '.error.code // empty' 2>/dev/null || true)"
  if [[ "$err_code" == "WRKF_TRANSITION_BLOCKED" ]]; then
    pass "8. sign_off correctly BLOCKED (waived obligation is not satisfied)"
  else
    fail "8. expected WRKF_TRANSITION_BLOCKED, got: $err_code"; ok=1
  fi

  local status phase
  status="$(get_task_field "$db" "$task" "status")"
  phase="$(get_task_field  "$db" "$task" "phase")"
  if [[ "$status" == "closed" && "$phase" == "done" ]]; then
    fail "8. task reached closed/done with waived obligation — should be blocked"; ok=1
  else
    pass "8. task NOT closed/done ($status/$phase) — waiver correctly blocked done path"
  fi

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 9 — live smoke: BOTH reject and pass paths with real evidence exec
# CONTRACT: "Live smoke: real temp task + workflow attached + real evidence exec
#            + real transition --run-checks — BOTH the reject path and the pass
#            path exercised."
# ═══════════════════════════════════════════════════════════════════════════════
test_9() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"
  install_template "$db" || return 1
  wf "$db" --actor tester-actor --role tester \
      task attach "$task" --workflow "$WORKFLOW_REF" >&2

  local ok=0

  # Walk to review with harness claim (needs matrix evidence)
  walk_to_review "$db" "$task" "harness" || return 1

  # Add docs_reachability via real evidence exec (wrong surface for harness)
  log "9. [REJECT PATH] Adding docs_reachability via real evidence exec (wrong surface)..."
  local exec_rc=0
  wf "$db" --actor tester-actor --role tester \
      evidence exec "$task" \
      --kind docs_reachability \
      --facts '{}' \
      --summary "live docs check" \
      -- echo "docs ok" 2>&1 || exec_rc=$?
  log "9. docs_reachability exec rc: $exec_rc"

  # Add sign_off requirements
  add_signoff_requirements "$db" "$task" || return 1

  # REJECT PATH: check fails (harness needs matrix; only docs_reachability present)
  log "9. [REJECT PATH] Running check (expect fail: harness uncovered)..."
  run_check_assert_reject "$db" "$task" "test9_reject" || ok=1

  # PASS PATH: add matrix evidence via real evidence exec (exitCode=0 → covers harness)
  log "9. [PASS PATH] Adding matrix evidence via real evidence exec (echo → exitCode=0)..."
  exec_rc=0
  wf "$db" --actor tester-actor --role tester \
      evidence exec "$task" \
      --kind matrix \
      --facts '{}' \
      --summary "live matrix smoke" \
      -- echo "matrix smoke ok" 2>&1 || exec_rc=$?
  log "9. matrix exec rc: $exec_rc"
  if [[ $exec_rc -ne 0 ]]; then
    fail "9. [PASS PATH] matrix evidence exec failed (rc=$exec_rc)"; ok=1
  else
    pass "9. [PASS PATH] matrix evidence exec succeeded (exitCode=0)"
  fi

  # Check is now stale (new evidence added). Re-run check → must pass
  log "9. [PASS PATH] Re-running check after adding matrix (expect PASS)..."
  local check_out check_rc=0
  check_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      check run "$task" sign_off --json 2>&1)" || check_rc=$?
  local verdict
  verdict="$(echo "$check_out" | jq -r '.checks[0].verdict // empty' 2>/dev/null || true)"
  if [[ "$verdict" == "pass" ]]; then
    pass "9. [PASS PATH] check passed after adding matrix evidence"
  else
    fail "9. [PASS PATH] check NOT passing after matrix: verdict=$verdict; out=$check_out"; ok=1
  fi

  # Transition sign_off (check is current and passing → routes to done)
  log "9. [PASS PATH] Transitioning sign_off (check passed, expect done)..."
  local signoff_out signoff_rc=0
  signoff_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --json 2>&1)" || signoff_rc=$?
  log "9. sign_off output: $(echo "$signoff_out" | jq -c '{outcome, state}' 2>/dev/null || echo "$signoff_out")"

  local status phase
  status="$(get_task_field "$db" "$task" "status")"
  phase="$(get_task_field  "$db" "$task" "phase")"
  assert_eq "9. [PASS PATH] task.status" "closed" "$status" || ok=1
  assert_eq "9. [PASS PATH] task.phase"  "done"   "$phase"  || ok=1

  # Deliver effect and check wrkq task state
  deliver_effects "$db" "$task" || true
  local wrkq_state
  wrkq_state="$(wrkq --db "$db" --project smoke cat "inbox/wf-smoke" --output json 2>/dev/null \
      | jq -r '.[0].state // empty' 2>/dev/null || true)"
  assert_eq "9. [PASS PATH] wrkq state" "completed" "$wrkq_state" || ok=1

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN_C}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN_C}║  agent-spaces-closeout@1 — E2E Acceptance Harness   ║${NC}"
echo -e "${CYAN_C}║  9 tests mapped to CONTRACT.md § Required Tests     ║${NC}"
echo -e "${CYAN_C}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Template : $TEMPLATE"
echo "Catalog  : $CATALOG"
echo "wrkf     : $(which wrkf 2>/dev/null || echo 'not found')"
echo ""

if [[ -n "$SELECTED_TEST" ]]; then
  echo -e "${YELLOW_C}Running single test: $SELECTED_TEST${NC}"
fi

run_test 1 "validate + install (template+catalog used live)"             test_1
run_test 2 "facts enum, producer restrictions, new-kind fields"          test_2
run_test 3 "RED: mismatched surface → check fails + §3 diag + BLOCKED"  test_3
run_test 4 "GREEN: installed_binary/real-e2e → sign_off → done"         test_4
run_test 5 "failed evidence exec records; check still rejects (exitCode trap)" test_5
run_test 6 "recorded diff-floor beats weak claim; live empty diff loses" test_6
run_test 7 "no-check / stale-check → sign_off BLOCKED"                  test_7
run_test 8 "waiver records but cannot reach done"                        test_8
run_test 9 "live smoke: both reject and pass paths with real evidence exec" test_9

echo ""
echo -e "${CYAN_C}══════════════════════════════════════════════════════${NC}"
echo -e "${CYAN_C}  SUMMARY${NC}"
echo -e "${CYAN_C}══════════════════════════════════════════════════════${NC}"
echo -e "  ${GREEN_C}PASS: $PASS_COUNT${NC}"
echo -e "  ${RED_C}FAIL: $FAIL_COUNT${NC}"
if [[ ${#FAILED_TESTS[@]} -gt 0 ]]; then
  echo ""
  echo -e "  ${RED_C}Failed tests:${NC}"
  for t in "${FAILED_TESTS[@]}"; do
    echo -e "    ${RED_C}✗ $t${NC}"
  done
fi
echo ""

if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0
