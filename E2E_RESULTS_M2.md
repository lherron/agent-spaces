# E2E Results — Milestone 2: Path safety and local-space completion

## Date: 2026-03-27

## Commit: 7a65b3e

## Tasks Completed
- T-00848: Add space:agent:<id> resolution
- T-00849: Extend space:project:<id> for explicit compose paths
- T-00850: Enforce allowed/disallowed dependency edges
- T-00851: Implement root-relative path safety and containment

## Test Results

### Red Phase (smokey confirmed)
- 13/24 tests RED — 6 for space:agent (no AGENT_REF_PATTERN), 5 for dependency edges (no enforcement), 2 for path containment (wrong error type)
- T-00849 already GREEN (existing implementation sufficient)

### Green Phase (smokey validated)
- 24/24 M2 tests passing
- T-00848: 6/6 GREEN — AGENT_COMMIT_MARKER, agentSpace flag, closure/integrity/lock pipeline
- T-00849: 2/2 GREEN — explicit compose path verified
- T-00850: 5/5 GREEN — cross-root dependency edge rejection
- T-00851: 2/2 GREEN — ".." traversal and absolute path injection rejected

### Full Suite Verification
- 1025 tests pass, 0 fail across 10 packages
- M0 (18/18), M1 (61/61), M2 (24/24) all green
- No regressions

## Key Changes
- `packages/config/src/core/types/refs.ts` — AGENT_COMMIT_MARKER, agentSpace flag, parse/format
- `packages/config/src/core/closure.ts` — agentRoot threading, agent resolution, dependency edge enforcement
- `packages/config/src/core/integrity.ts` — agent commit marker support
- Lock types, schema, lock-generator, install, resolve updated for agent spaces

## Agent: claude (primary), codex (path containment assist)
## Validator: smokey
