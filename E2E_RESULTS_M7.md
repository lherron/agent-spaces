# E2E Results — Milestone 7: Cleanup and release hardening

## Date: 2026-03-27

## Commit: 615a838

## Tasks Completed
- T-00869: Remove/quarantine public session registry and legacy terminology (claude)
- T-00870: Update docs, examples, and smoke plans (claude)
- T-00871: Full build/typecheck/test/lint validation pass (codex)

## Test Results

### Red Phase (smokey confirmed)
- 2/22 RED — noExplicitAny lint error and TS2345 type error in agent CLI command

### Green Phase (smokey validated)
- 22/22 M7 tests passing
- T-00869: 4/4 GREEN — cpSessionId deprecated, hostSessionId primary, no SessionRegistry exports
- T-00870: 2/2 GREEN — placement API documented, no session ownership claims
- T-00871: 16/16 GREEN — all 13 final success criteria verified

### Full Suite Verification (`just verify`)
- 156 integration tests pass, 0 fail, 473 expect() calls across 13 files
- 1125 total tests across all packages, 0 failures
- Lint: clean
- Typecheck: clean
- Build: clean

## All 13 Final Success Criteria Verified
1. agent-scope exists, standalone, fully implements contract
2. Public APIs are placement-based, not SpaceSpec-based
3. No host-specific legacy terminology in primary surface
4. SOUL.md, HEARTBEAT.md, agent-profile.toml implemented
5. space:agent:<id> and space:project:<id> both work in explicit compose
6. Root-relative refs implemented and safe
7. ResolvedRuntimeBundle returned from resolution/execution/invocation
8. CLI harnesses support invocation-only at library layer
9. asp agent CLI uses positional ScopeRef, mode verbs
10. projectRoot never implies project target
11. Provider mismatch checks protect continuation reuse
12. Full build/typecheck/test/lint passes
13. Existing asp run behavior unchanged

## Agents: claude (T-00869, T-00870), codex (T-00871)
## Validator: smokey
