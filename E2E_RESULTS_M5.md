# E2E Results — Milestone 5: Public API cutover

## Date: 2026-03-27

## Commit: d23f64f

## Tasks Completed
- T-00860: Replace SpaceSpec-based requests with placement-based requests (claude)
- T-00861: Rename cpSessionId to hostSessionId in correlation (codex)
- T-00862: Return resolvedBundle from execution and invocation APIs (claude)
- T-00863: Implement createAgentSpacesClient with placement-based options (codex)
- T-00864: Emit AGENT_SCOPE_REF, AGENT_LANE_REF, AGENT_HOST_SESSION_ID env vars (claude)

## Test Results

### Red Phase (smokey confirmed)
- 6/18 tests RED — buildProcessInvocationSpec crashes on placement-based request, correlation env vars untested

### Green Phase (smokey validated)
- 18/18 M5 tests passing
- T-00860: 4/4 GREEN — placement-based request types accepted
- T-00861: 3/3 GREEN — hostSessionId replaces cpSessionId
- T-00862: 3/3 GREEN — resolvedBundle returned from invocation APIs
- T-00863: 4/4 GREEN — createAgentSpacesClient with optional args
- T-00864: 4/4 GREEN — correlation env vars emitted when present

### Full Suite Verification
- 1103 tests pass, 0 fail across 10 packages
- M0-M5 all green, no regressions

## Key Changes
- `packages/agent-spaces/src/client.ts` — rewritten for placement-based requests
- Correlation env vars: AGENT_SCOPE_REF, AGENT_LANE_REF, AGENT_HOST_SESSION_ID
- hostSessionId replaces cpSessionId across all packages
- resolvedBundle returned from buildProcessInvocationSpec

## Agents: claude (T-00860, T-00862, T-00864), codex (T-00861, T-00863)
## Validator: smokey
