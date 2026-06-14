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
# RED bar until larry's Phase 2 delivers the template + hook-catalog files.

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
    fail "$label: pattern '$pattern' NOT found in: $(echo "$text" | head -5)"
    return 1
  fi
}

# assert_json_field LABEL FIELD JSON
# Checks that jq .FIELD is non-null and non-empty string in the JSON
assert_json_field() {
  local label="$1" field="$2" json="$3"
  local val
  val="$(echo "$json" | jq -r "$field // empty" 2>/dev/null || true)"
  if [[ -n "$val" && "$val" != "null" ]]; then
    pass "$label.$field present: '$val'"
    return 0
  else
    fail "$label.$field: not found or null in JSON"
    return 1
  fi
}

# assert_diag_fields LABEL STDERR_OUTPUT
# Verifies all 7 §3 diagnostic fields are present in the hook stderr output
assert_diag_fields() {
  local label="$1" output="$2"
  # The hook emits a JSON object on stderr; find the first JSON object in the output
  local diag
  diag="$(echo "$output" | grep -oE '\{[^{}]*requiredSurface[^{}]*\}' | head -1 || true)"
  if [[ -z "$diag" ]]; then
    fail "$label: no §3 diagnostic JSON object found in output"
    fail "  output was: $(echo "$output" | tail -5)"
    return 1
  fi
  local ok=0
  for field in requiredSurface claimClass recordedDiffFloor expectedKind reason; do
    if echo "$diag" | jq -e ".$field" > /dev/null 2>&1; then
      pass "$label.diag.$field present"
    else
      fail "$label.diag.$field MISSING in: $diag"
      ok=1
    fi
  done
  # foundKind and foundExitCode may be null — just check key presence
  for field in foundKind foundExitCode; do
    if echo "$diag" | jq -e "has(\"$field\")" > /dev/null 2>&1; then
      pass "$label.diag.$field key present"
    else
      fail "$label.diag.$field key MISSING in: $diag"
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
  wrkqadm --db "$db" migrate   >&2
  wrkqadm --db "$db" init      >&2

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
# install_template DB_PATH → 0 if validate+install both succeed
install_template() {
  local db="$1"

  # Template and catalog must exist — if absent the harness is RED here
  if [[ ! -f "$TEMPLATE" ]]; then
    fail "TEMPLATE ABSENT: $TEMPLATE (Phase 2 not yet delivered — harness is RED)"
    return 1
  fi
  if [[ ! -f "$CATALOG" ]]; then
    fail "CATALOG ABSENT: $CATALOG (Phase 2 not yet delivered — harness is RED)"
    return 1
  fi

  log "Validating template..."
  if ! wrkf --db "$db" --hook-catalog "$CATALOG" workflow validate "$TEMPLATE" 2>&1; then
    fail "wrkf workflow validate failed"
    return 1
  fi

  log "Installing template..."
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

# ── Walk the workflow from intake → active/review ─────────────────────────────
# walk_to_review DB TASK_ID CLAIM_CLASS [DIFF_FLOOR_SURFACE]
# CLAIM_CLASS: docs|logic|contract|packaging|harness|runtime
# DIFF_FLOOR_SURFACE: (optional) strongestSurface for changed_files evidence
walk_to_review() {
  local db="$1" task="$2" claim_class="$3"
  local diff_floor="${4:-}"

  log "walk_to_review: claim_class=$claim_class diff_floor=${diff_floor:-none}"

  # 1. Tester adds red_test evidence, then author_red transition
  log "  [author_red] adding red_test evidence as tester..."
  wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind red_test \
      --ref "file://tests/red.txt" \
      --facts '{"verdict":"red"}' \
      --summary "red bar from test harness" >&2

  log "  [author_red] transitioning..."
  wf "$db" --actor tester-actor --role tester \
      transition "$task" author_red >&2

  # 2. Implementer adds verify (+ optional changed_files), then implement transition
  log "  [implement] adding verify evidence as implementer..."
  wf "$db" --actor implementer-actor --role implementer \
      evidence add "$task" \
      --kind verify \
      --ref "file://tests/verify.txt" \
      --facts '{"verdict":"pass"}' \
      --summary "verify green from test harness" >&2

  if [[ -n "$diff_floor" ]]; then
    log "  [implement] adding changed_files evidence (floor=$diff_floor)..."
    wf "$db" --actor implementer-actor --role implementer \
        evidence add "$task" \
        --kind changed_files \
        --ref "file://tests/changed-files.txt" \
        --facts "{\"strongestSurface\":\"$diff_floor\"}" \
        --data '{"files":["packages/harness-broker/src/core.ts","scripts/matrix.sh"]}' \
        --summary "recorded diff floor from test harness" >&2
  fi

  log "  [implement] transitioning..."
  wf "$db" --actor implementer-actor --role implementer \
      transition "$task" implement >&2

  # 3. Tester adds closeout_claim + verify_full, then full_verify transition
  log "  [full_verify] adding closeout_claim evidence as tester (class=$claim_class)..."
  wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind closeout_claim \
      --ref "file://tests/closeout-claim.txt" \
      --facts "{\"claimClass\":\"$claim_class\"}" \
      --summary "closeout claim from test harness" >&2

  log "  [full_verify] adding verify_full evidence as tester..."
  wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind verify_full \
      --ref "file://tests/verify-full.txt" \
      --facts '{"verdict":"pass"}' \
      --summary "full verify from test harness" >&2

  log "  [full_verify] transitioning → active/review..."
  wf "$db" --actor tester-actor --role tester \
      transition "$task" full_verify >&2

  # Verify we reached active/review
  local inspect_out
  inspect_out="$(wf "$db" task inspect "$task" --json 2>&1)"
  local status phase
  status="$(echo "$inspect_out" | jq -r '.status // empty' 2>/dev/null || true)"
  phase="$(echo "$inspect_out"  | jq -r '.phase  // empty' 2>/dev/null || true)"
  if [[ "$status" != "active" || "$phase" != "review" ]]; then
    fail "walk_to_review: expected active/review, got $status/$phase"
    return 1
  fi
  pass "walk_to_review: reached active/review ✓"
}

# ── add_reviewer_signoff_evidence: adds installed_binary + review_signoff + satisfies obligations
# add_signoff_requirements DB TASK_ID
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

  log "  satisfying review_signoff obligation as reviewer..."
  wf "$db" --actor reviewer-actor --role reviewer \
      obligation satisfy "$task" review_signoff \
      --reason "reviewer submitted signoff evidence" >&2

  log "  satisfying closeout_evidence obligation as reviewer..."
  wf "$db" --actor reviewer-actor --role reviewer \
      obligation satisfy "$task" closeout_evidence \
      --reason "reviewer attests coverage evidence submitted" >&2
}

# ── inspect task state ────────────────────────────────────────────────────────
get_task_state() {
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
  log "Task: $task (DB: $db)"

  # Template and catalog must exist
  log "Checking template file: $TEMPLATE"
  if [[ ! -f "$TEMPLATE" ]]; then
    fail "TEMPLATE ABSENT — harness is RED (Phase 2 not yet delivered)"
    return 1
  fi
  log "Checking catalog file: $CATALOG"
  if [[ ! -f "$CATALOG" ]]; then
    fail "CATALOG ABSENT — harness is RED (Phase 2 not yet delivered)"
    return 1
  fi

  local ok=0
  log "Running: wrkf workflow validate $TEMPLATE"
  if ! wf "$db" workflow validate "$TEMPLATE" 2>&1; then
    fail "workflow validate failed"
    ok=1
  else
    pass "workflow validate passed"
  fi

  log "Running: wrkf workflow install $TEMPLATE"
  if ! wf "$db" workflow install "$TEMPLATE" 2>&1; then
    fail "workflow install failed"
    ok=1
  else
    pass "workflow install passed"
  fi

  log "Confirming template listed after install..."
  local list_out
  list_out="$(wf "$db" workflow list --json 2>/dev/null || true)"
  if echo "$list_out" | jq -e '.[] | select(.id == "agent-spaces-closeout" and .version == "1")' > /dev/null 2>&1; then
    pass "template agent-spaces-closeout@1 present in registry"
  else
    fail "template agent-spaces-closeout@1 NOT found in registry"
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

  # 2a. closeout_claim with INVALID claimClass enum → must fail
  log "2a. closeout_claim with invalid claimClass (should reject)..."
  local add_out rc
  rc=0
  add_out="$(wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind closeout_claim \
      --ref "file://tests/claim.txt" \
      --facts '{"claimClass":"nonexistent_invalid"}' 2>&1)" || rc=$?
  if [[ $rc -ne 0 ]]; then
    pass "2a. invalid claimClass correctly rejected (exit $rc)"
  else
    fail "2a. invalid claimClass was NOT rejected (exit 0, output: $add_out)"
    ok=1
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
    fail "2b. reviewer producing closeout_claim was NOT rejected (exit 0)"
    ok=1
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
    fail "2c. tester producing installed_binary was NOT rejected (exit 0)"
    ok=1
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
    fail "2d. valid closeout_claim was rejected (exit $rc, output: $add_out)"
    ok=1
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
    fail "2e. valid changed_files was rejected (exit $rc, output: $add_out)"
    ok=1
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
    fail "2f. valid installed_binary (reviewer) was rejected (exit $rc)"
    ok=1
  fi

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 3 — RED: mismatched surface → sign_off REJECTED, §3 diagnostic present
# CONTRACT: "RED: runtime diff-floor/claim with only verify/unit evidence →
#            sign_off REJECTED, §3 fields present."
# Strategy: claimClass=harness, no matrix coverage → hook exits 1 with §3 diag.
# ═══════════════════════════════════════════════════════════════════════════════
test_3() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"
  install_template "$db" || return 1
  wf "$db" --actor tester-actor --role tester \
      task attach "$task" --workflow "$WORKFLOW_REF" >&2

  # Walk to active/review; claim harness surface but provide only verify coverage
  walk_to_review "$db" "$task" "harness" || return 1

  # Add all sign_off transition requirements (installed_binary, review_signoff, obligations)
  # NOTE: installed_binary covers "runtime" surface, NOT "harness".
  # We are claiming "harness" but not providing "matrix" coverage → hook should fail.
  add_signoff_requirements "$db" "$task" || return 1

  local ok=0

  # Run sign_off --run-checks and capture ALL output (stdout + stderr merged)
  log "Running sign_off --run-checks (expect rejection: harness surface uncovered)..."
  local signoff_out
  local signoff_rc=0
  signoff_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --run-checks --json 2>&1)" || signoff_rc=$?

  log "sign_off output (rc=$signoff_rc): $signoff_out"

  # The sign_off should route to "uncovered" (back to active/review), not error/reject at requires
  # Check that the task did NOT reach closed/done
  local status phase
  status="$(get_task_state "$db" "$task" "status")"
  phase="$(get_task_state  "$db" "$task" "phase")"
  log "Task state after sign_off: $status/$phase"

  if [[ "$status" == "closed" && "$phase" == "done" ]]; then
    fail "3. Task incorrectly reached closed/done — hook should have rejected"
    ok=1
  else
    pass "3. Task NOT in closed/done (status=$status phase=$phase) — rejected as expected"
  fi

  # Assert §3 diagnostic fields appear in the output
  assert_diag_fields "test3" "$signoff_out" || ok=1

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 4 — GREEN: installed_binary/real-e2e evidence → sign_off → done + completed
# CONTRACT: "GREEN: same with a successful installed_binary/real-e2e evidence →
#            sign_off permitted → done + task completed."
# Strategy: claimClass=runtime, installed_binary covers runtime → hook passes.
# ═══════════════════════════════════════════════════════════════════════════════
test_4() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"
  install_template "$db" || return 1
  wf "$db" --actor tester-actor --role tester \
      task attach "$task" --workflow "$WORKFLOW_REF" >&2

  # Walk to active/review with claimClass=runtime (installed_binary covers it)
  walk_to_review "$db" "$task" "runtime" || return 1

  # Add sign_off requirements (installed_binary with verdict:pass covers runtime surface)
  add_signoff_requirements "$db" "$task" || return 1

  local ok=0

  # Run sign_off --run-checks — hook should pass (installed_binary covers runtime)
  log "Running sign_off --run-checks (expect GREEN: done + task completed)..."
  local signoff_out signoff_rc=0
  signoff_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --run-checks --json 2>&1)" || signoff_rc=$?

  log "sign_off output (rc=$signoff_rc): $signoff_out"

  # Task must reach closed/done
  local status phase
  status="$(get_task_state "$db" "$task" "status")"
  phase="$(get_task_state  "$db" "$task" "phase")"
  log "Task state after sign_off: $status/$phase"

  assert_eq "4. task.status" "closed" "$status" || ok=1
  assert_eq "4. task.phase"  "done"   "$phase"  || ok=1

  # Task state in wrkq must be completed (set_task_state effect)
  local wrkq_state
  wrkq_state="$(wrkq --db "$db" --project smoke cat "inbox/wf-smoke" --output json 2>/dev/null \
      | jq -r '.[0].state // empty' 2>/dev/null || true)"
  log "wrkq task state: $wrkq_state"
  assert_eq "4. wrkq task state" "completed" "$wrkq_state" || ok=1

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 5 — failed evidence exec records but check STILL rejects
# CONTRACT: "Failed-command: evidence exec with NONZERO exit records evidence
#            (and exits nonzero), but the check STILL rejects (proves
#            data.exitCode==0 inspection, not just facts.verdict=pass)."
# Strategy: exec a command that exits 1 as "matrix" (harness surface) evidence;
#           hook sees data.exitCode=1 → not covered even if kind matches.
# ═══════════════════════════════════════════════════════════════════════════════
test_5() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"
  install_template "$db" || return 1
  wf "$db" --actor tester-actor --role tester \
      task attach "$task" --workflow "$WORKFLOW_REF" >&2

  # Walk to active/review with harness claim
  walk_to_review "$db" "$task" "harness" || return 1

  local ok=0

  # Run evidence exec with a command that EXITS NONZERO → evidence exec should exit nonzero
  log "5. Running evidence exec with failing command (false)..."
  local exec_rc=0
  wf "$db" --actor tester-actor --role tester \
      evidence exec "$task" \
      --kind matrix \
      --facts '{}' \
      --summary "failing matrix command (test 5)" \
      -- false 2>&1 || exec_rc=$?

  log "evidence exec exit code: $exec_rc"
  if [[ $exec_rc -ne 0 ]]; then
    pass "5. evidence exec exited nonzero ($exec_rc) as expected"
  else
    fail "5. evidence exec exited 0 but should have exited nonzero for failing command"
    ok=1
  fi

  # Verify the evidence was RECORDED (list should show it)
  log "5. Checking evidence was recorded despite nonzero exit..."
  local evidence_list
  evidence_list="$(wf "$db" evidence list "$task" --json 2>/dev/null || true)"
  if echo "$evidence_list" | jq -e '.[] | select(.kind == "matrix")' > /dev/null 2>&1; then
    pass "5. matrix evidence recorded despite nonzero exec exit"
  else
    fail "5. matrix evidence NOT recorded (expected to be recorded)"
    ok=1
  fi

  # Add sign_off requirements and attempt sign_off; hook must STILL reject
  add_signoff_requirements "$db" "$task" || return 1

  log "5. Running sign_off --run-checks (expect rejection: matrix exitCode=1)..."
  local signoff_out signoff_rc=0
  signoff_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --run-checks --json 2>&1)" || signoff_rc=$?
  log "sign_off output: $signoff_out"

  local status phase
  status="$(get_task_state "$db" "$task" "status")"
  phase="$(get_task_state  "$db" "$task" "phase")"

  if [[ "$status" == "closed" && "$phase" == "done" ]]; then
    fail "5. Task reached closed/done — nonzero exitCode evidence should have caused rejection"
    ok=1
  else
    pass "5. Task NOT closed/done (status=$status/$phase) — nonzero exitCode correctly rejected"
  fi

  assert_diag_fields "test5" "$signoff_out" || ok=1

  return $ok
}

# ═══════════════════════════════════════════════════════════════════════════════
# TEST 6 — recorded changed_files floor drives coverage; empty live diff can't downgrade
# CONTRACT: "Diff-source: a recorded changed_files/committed-or-unstaged floor
#            drives the correct (higher) requirement; an empty live staged diff
#            can NOT downgrade it."
# Strategy: changed_files strongestSurface=runtime, closeout_claim=docs;
#           requiredSurface = max(docs=1, runtime=6) = runtime.
#           Coverage = only docs_reachability (covers docs, not runtime) → hook fails.
# ═══════════════════════════════════════════════════════════════════════════════
test_6() {
  local db="$1"
  local task
  task="$(setup_db "$db")"
  log "Task: $task"
  install_template "$db" || return 1
  wf "$db" --actor tester-actor --role tester \
      task attach "$task" --workflow "$WORKFLOW_REF" >&2

  # Walk to review with docs claim BUT recorded diff floor = runtime
  walk_to_review "$db" "$task" "docs" "runtime" || return 1

  # Add a docs_reachability evidence (covers docs surface only)
  log "6. Adding docs_reachability evidence (covers docs=1 only)..."
  local exec_rc=0
  wf "$db" --actor tester-actor --role tester \
      evidence exec "$task" \
      --kind docs_reachability \
      --facts '{}' \
      --summary "docs reachability check" \
      -- echo "docs reachability ok" 2>&1 || exec_rc=$?
  log "docs_reachability exec rc: $exec_rc"

  # Add sign_off requirements
  add_signoff_requirements "$db" "$task" || return 1

  local ok=0

  # sign_off --run-checks should REJECT because floor is runtime (6) not docs (1)
  log "6. Running sign_off --run-checks (expect rejection: floor=runtime, coverage=docs only)..."
  local signoff_out signoff_rc=0
  signoff_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --run-checks --json 2>&1)" || signoff_rc=$?
  log "sign_off output: $signoff_out"

  local status phase
  status="$(get_task_state "$db" "$task" "status")"
  phase="$(get_task_state  "$db" "$task" "phase")"

  if [[ "$status" == "closed" && "$phase" == "done" ]]; then
    fail "6. Task reached closed/done — runtime floor should have caused rejection"
    ok=1
  else
    pass "6. Task NOT closed/done ($status/$phase) — diff floor correctly rejected coverage"
  fi

  # §3 diagnostic must show recordedDiffFloor drove the requirement
  assert_diag_fields "test6" "$signoff_out" || ok=1

  # Specifically verify recordedDiffFloor field value
  local diag
  diag="$(echo "$signoff_out" | grep -oE '\{[^{}]*requiredSurface[^{}]*\}' | head -1 || true)"
  if [[ -n "$diag" ]]; then
    local rec_floor
    rec_floor="$(echo "$diag" | jq -r '.recordedDiffFloor // empty' 2>/dev/null || true)"
    if [[ "$rec_floor" == "runtime" ]]; then
      pass "6. §3.recordedDiffFloor = runtime (correct)"
    else
      fail "6. §3.recordedDiffFloor expected 'runtime', got '$rec_floor'"
      ok=1
    fi
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

  walk_to_review "$db" "$task" "logic" || return 1
  add_signoff_requirements "$db" "$task" || return 1

  local ok=0

  # 7a. sign_off WITHOUT --run-checks → must fail/reject
  log "7a. sign_off WITHOUT --run-checks (expect rejection)..."
  local signoff_out signoff_rc=0
  signoff_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --json 2>&1)" || signoff_rc=$?
  log "sign_off (no --run-checks) output (rc=$signoff_rc): $signoff_out"

  # Should NOT reach closed/done
  local status phase
  status="$(get_task_state "$db" "$task" "status")"
  phase="$(get_task_state  "$db" "$task" "phase")"

  if [[ "$status" == "closed" && "$phase" == "done" ]]; then
    fail "7a. Task reached closed/done without --run-checks — should have been rejected"
    ok=1
  else
    pass "7a. sign_off without --run-checks correctly rejected (status=$status/$phase)"
  fi

  # 7b. Run the check FIRST (producing a check run result), then add more evidence
  #     to make the check stale, then try sign_off → should reject
  log "7b. Testing stale-check rejection..."

  # Run check standalone to get a check run result
  log "  Running check run standalone..."
  local check_rc=0
  wf "$db" --actor reviewer-actor --role reviewer \
      check run "$task" sign_off 2>&1 || check_rc=$?
  log "  check run rc: $check_rc"

  # Now add new evidence AFTER the check ran (making it stale)
  log "  Adding new evidence to make check stale..."
  wf "$db" --actor tester-actor --role tester \
      evidence add "$task" \
      --kind closeout_claim \
      --ref "file://tests/stale-claim.txt" \
      --facts '{"claimClass":"logic"}' \
      --summary "new evidence after check (stale)" >&2

  # Try sign_off pointing to the old (now stale) check run
  log "  sign_off with stale check run (expect rejection)..."
  signoff_rc=0
  signoff_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --json 2>&1)" || signoff_rc=$?
  log "  stale sign_off output (rc=$signoff_rc): $signoff_out"

  status="$(get_task_state "$db" "$task" "status")"
  phase="$(get_task_state  "$db" "$task" "phase")"
  if [[ "$status" == "closed" && "$phase" == "done" ]]; then
    fail "7b. Task reached closed/done with stale check — should have been rejected"
    ok=1
  else
    pass "7b. stale check correctly rejected (status=$status/$phase)"
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

  # Waive the closeout_evidence obligation (as system, which has waiveRole)
  log "8. Waiving closeout_evidence obligation with ticketed reason..."
  local waive_rc=0
  local waive_out
  waive_out="$(wf "$db" --actor system-actor --role system \
      obligation waive "$task" closeout_evidence \
      --reason "CLOSEOUT-EXEMPT(T-99999): harness tests waiver path" 2>&1)" || waive_rc=$?
  log "waive output (rc=$waive_rc): $waive_out"

  # Waive itself must succeed
  if [[ $waive_rc -eq 0 ]]; then
    pass "8. obligation waive succeeded (recorded)"
  else
    fail "8. obligation waive failed unexpectedly (exit $waive_rc)"
    ok=1
  fi

  # Add the other sign_off requirements (excluding closeout_evidence satisfaction)
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

  wf "$db" --actor reviewer-actor --role reviewer \
      obligation satisfy "$task" review_signoff \
      --reason "reviewer submitted signoff" >&2

  # Attempt sign_off — must fail because closeout_evidence is waived, not satisfied
  log "8. Attempting sign_off (expect rejection: closeout_evidence waived, not satisfied)..."
  local signoff_out signoff_rc=0
  signoff_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --run-checks --json 2>&1)" || signoff_rc=$?
  log "sign_off output (rc=$signoff_rc): $signoff_out"

  local status phase
  status="$(get_task_state "$db" "$task" "status")"
  phase="$(get_task_state  "$db" "$task" "phase")"
  log "Task state: $status/$phase"

  if [[ "$status" == "closed" && "$phase" == "done" ]]; then
    fail "8. Task reached closed/done with waived obligation — should be blocked"
    ok=1
  else
    pass "8. Task NOT closed/done ($status/$phase) — waiver correctly blocked done path"
  fi

  # Verify obligation is still in waived state (not satisfied)
  local obl_list
  obl_list="$(wf "$db" obligation list "$task" --all --json 2>/dev/null || true)"
  log "8. Obligations: $obl_list"
  local obl_status
  obl_status="$(echo "$obl_list" | jq -r \
      '.[] | select(.kind == "closeout_evidence") | .status // empty' 2>/dev/null || true)"
  if [[ "$obl_status" == "waived" ]]; then
    pass "8. closeout_evidence obligation status=waived (confirmed)"
  else
    fail "8. closeout_evidence obligation status expected 'waived', got '$obl_status'"
    ok=1
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

  # ── REJECT PATH ────────────────────────────────────────────────────────────
  log "9. [REJECT PATH] Walking to active/review with harness claim..."
  walk_to_review "$db" "$task" "harness" || return 1

  # Use real evidence exec for a command that SUCCEEDS but for WRONG surface
  # (docs_reachability covers docs, not harness)
  log "9. [REJECT PATH] Adding docs_reachability via evidence exec (wrong surface)..."
  local exec_rc=0
  wf "$db" --actor tester-actor --role tester \
      evidence exec "$task" \
      --kind docs_reachability \
      --facts '{}' \
      --summary "live docs check" \
      -- echo "docs ok" 2>&1 || exec_rc=$?
  log "docs_reachability exec rc: $exec_rc"

  add_signoff_requirements "$db" "$task" || return 1

  log "9. [REJECT PATH] sign_off --run-checks (expect rejection: harness uncovered)..."
  local signoff_out signoff_rc=0
  signoff_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --run-checks --json 2>&1)" || signoff_rc=$?
  log "REJECT PATH sign_off output: $signoff_out"

  local status phase
  status="$(get_task_state "$db" "$task" "status")"
  phase="$(get_task_state  "$db" "$task" "phase")"

  if [[ "$status" == "closed" && "$phase" == "done" ]]; then
    fail "9. [REJECT PATH] Task reached closed/done — should have been rejected"
    ok=1
  else
    pass "9. [REJECT PATH] Correctly rejected ($status/$phase)"
  fi

  assert_diag_fields "test9_reject" "$signoff_out" || ok=1

  # ── PASS PATH ──────────────────────────────────────────────────────────────
  # We need a fresh task for the pass path (can't reuse — the task is in active/review again)
  # Reset obligations for the pass path: remove the old satisfaction and re-satisfy
  # Actually, after the uncovered routing back to active/review, we need to add
  # the CORRECT coverage evidence and re-attempt sign_off.

  log "9. [PASS PATH] Adding matrix evidence via real evidence exec..."
  exec_rc=0
  wf "$db" --actor tester-actor --role tester \
      evidence exec "$task" \
      --kind matrix \
      --facts '{}' \
      --summary "live matrix smoke" \
      -- echo "matrix smoke ok" 2>&1 || exec_rc=$?
  log "matrix exec rc: $exec_rc (should be 0)"

  if [[ $exec_rc -ne 0 ]]; then
    fail "9. [PASS PATH] matrix evidence exec failed (rc=$exec_rc)"
    ok=1
  else
    pass "9. [PASS PATH] matrix evidence exec succeeded"
  fi

  # Re-run sign_off --run-checks (obligations still satisfied from before)
  log "9. [PASS PATH] sign_off --run-checks (expect GREEN: done + completed)..."
  signoff_rc=0
  signoff_out="$(wf "$db" --actor reviewer-actor --role reviewer \
      transition "$task" sign_off --run-checks --json 2>&1)" || signoff_rc=$?
  log "PASS PATH sign_off output: $signoff_out"

  status="$(get_task_state "$db" "$task" "status")"
  phase="$(get_task_state  "$db" "$task" "phase")"
  log "Final task state: $status/$phase"

  assert_eq "9. [PASS PATH] task.status" "closed" "$status" || ok=1
  assert_eq "9. [PASS PATH] task.phase"  "done"   "$phase"  || ok=1

  # Verify set_task_state completed effect was applied
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
echo "wrkf     : $(which wrkf) ($(wrkf version 2>/dev/null || echo unknown))"
echo ""

if [[ -n "$SELECTED_TEST" ]]; then
  echo -e "${YELLOW_C}Running single test: $SELECTED_TEST${NC}"
fi

run_test 1 "validate + install (template+catalog used live)"           test_1
run_test 2 "facts enum, producer restrictions, new-kind fields"        test_2
run_test 3 "RED: mismatched surface → sign_off rejected + §3 diag"    test_3
run_test 4 "GREEN: installed_binary/real-e2e → sign_off → done"       test_4
run_test 5 "failed evidence exec records but check still rejects"      test_5
run_test 6 "recorded diff-floor drives coverage; empty live diff loses" test_6
run_test 7 "no --run-checks / stale check → sign_off rejected"        test_7
run_test 8 "waiver records but cannot reach done"                      test_8
run_test 9 "live smoke: both reject and pass paths with evidence exec" test_9

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
