# E2E Results — Milestone 3: Reserved files and runtime profile resolution

## Date: 2026-03-27

## Commit: fb630c7

## Tasks Completed
- T-00852: Implement SOUL.md and optional HEARTBEAT.md runtime contract (codex)
- T-00853: Add agent-profile.toml parser and validator (codex)
- T-00854: Implement agent-root:/// and project-root:/// refs (claude)
- T-00855: Implement normative instruction and space precedence (claude)

## Test Results

### Red Phase (smokey confirmed)
- 34/34 tests RED — all modules missing (resolver/agent-root, core/config/agent-profile-toml, resolver/root-relative-refs, resolver/instruction-layer, resolver/space-composition)

### Green Phase (smokey validated)
- 34/34 M3 tests passing
- T-00852: 6/6 GREEN — validateAgentRoot, SOUL.md required, HEARTBEAT.md optional
- T-00853: 9/9 GREEN — parseAgentProfile, schema validation, instructions/spaces/targets/harness
- T-00854: 9/9 GREEN — root-relative ref resolution, ".." rejection, missing root throws
- T-00855: 10/10 GREEN — instruction layering order, space composition order, deduplication

### Full Suite Verification
- 1059 tests pass, 0 fail across 10 packages
- M0 (18/18), M1 (61/61), M2 (24/24), M3 (34/34) all green
- No regressions

## Key APIs Implemented
- `validateAgentRoot(agentRoot)` — reserved file validation
- `parseAgentProfile(content)` — TOML parser for AgentRuntimeProfile schema
- `resolveRootRelativeRef(ref, {agentRoot?, projectRoot?})` — path resolution with containment
- `resolveInstructionLayer(...)` — normative instruction precedence
- `resolveSpaceComposition(...)` — normative space precedence with dedup

## Agents: codex (T-00852, T-00853), claude (T-00854, T-00855)
## Validator: smokey
