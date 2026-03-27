# E2E Results — Milestone 6: CLI surface for standalone agent execution

## Date: 2026-03-27

## Commit: 1dfac42

## Tasks Completed
- T-00865: Implement asp agent <scope-ref> <mode> command (claude)
- T-00866: Implement asp agent resolve <scope-ref> command (claude)
- T-00867: Verify existing asp run/install/build/explain commands unchanged (codex)
- T-00868: Implement bundle selection flags for asp agent (claude)

## Test Results

### Red Phase (smokey confirmed)
- 7/18 tests RED — all `asp agent` commands return "unknown command 'agent'"

### Green Phase (smokey validated)
- 18/18 M6 tests passing
- T-00865: 5/5 GREEN — asp agent with ScopeRef, mode verbs, --dry-run, --print-command
- T-00866: 3/3 GREEN — asp agent resolve with --json output
- T-00867: 4/4 GREEN — existing CLI commands unchanged
- T-00868: 6/6 GREEN — bundle selection flags (--bundle, --agent-target, --project-target, --compose)

### Full Suite Verification
- All tests pass across 10 packages, 0 failures
- M0-M6 all green, no regressions
- Existing non-agent `asp run` behavior intact

## Key Changes
- `packages/cli/src/` — new `agent` subcommand family
- `asp agent <scope-ref> query|task|heartbeat|maintenance` — positional ScopeRef + mode verb
- `asp agent resolve <scope-ref>` — resolve-only diagnostic
- Bundle selection: --bundle, --agent-target, --project-target + --project-root, --compose
- --dry-run, --print-command, --json output support

## Agents: claude (T-00865, T-00866, T-00868), codex (T-00867)
## Validator: smokey
