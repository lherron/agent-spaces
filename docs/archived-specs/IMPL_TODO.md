# Agent-Spaces Implementation Todo

This tracks implementation work discovered while reconciling
`specs/spec_agent_spaces.md` with the current code.

## Open

### 1. Make placement requests typecheck without legacy fields

The spec now treats placement requests as first-class. Current implementation
accepts placement at runtime, but the primary TypeScript interfaces still make
legacy fields such as `aspHome`, `spec`, `cwd`, and sometimes `runId` required.
Several tests use `as any` to exercise the intended placement shape.

Fix:
- Convert `RunTurnNonInteractiveRequest` and `BuildProcessInvocationSpecRequest`
  to discriminated unions or overloads.
- Placement request variants should not require legacy `SpaceSpec` fields.
- Keep legacy request variants for compatibility.

Relevant files:
- `packages/agent-spaces/src/types.ts`
- `packages/agent-spaces/src/client.ts`
- `packages/agent-spaces/src/__tests__/m5-public-api-cutover.test.ts`

### 2. Remove duplicate/stale placement helper surface

`packages/agent-spaces/src/placement-api.ts` is narrower than the main client
types. It omits `pi-cli`, newer invocation fields such as `prompt`,
`attachments`, and `yolo`, and has a local frontend-to-provider map that can
drift from the shared harness catalog.

Fix:
- Prefer shared catalog helpers from `spaces-config`.
- Add `pi-cli` support if this exported helper surface remains.
- Align placement request types with the primary client request types, or remove
  the duplicate exported request interfaces.

Relevant files:
- `packages/agent-spaces/src/placement-api.ts`
- `packages/agent-spaces/src/types.ts`
- `packages/config/src/core/types/harness.ts`

### 3. Decide and wire `artifactDir`

`artifactDir` is accepted on the agent-spaces invocation request, but
`buildProcessInvocationSpec` does not currently thread it into run options.
The execution CLI path does pass it through to harness run options.

Fix:
- Either wire `artifactDir` through agent-spaces invocation planning where
  supported by adapters, or deprecate/remove it from that API.
- Add a regression test for the chosen behavior.

Relevant files:
- `packages/agent-spaces/src/types.ts`
- `packages/agent-spaces/src/client.ts`
- `packages/execution/src/run.ts`
- `packages/execution/src/run/space-launch.ts`

### 4. Keep documentation links current

`README.md` references `specs/AGENT-SPACES-V2-SPEC.md` and
`specs/AGENT-SPACES-V2-SCHEMAS.md`, but those files are not present in this
repo. The current local spec is `specs/spec_agent_spaces.md`.

Fix:
- Update README links to the actual spec files, or restore the missing files if
  they are intended to be canonical.

Relevant files:
- `README.md`
- `specs/spec_agent_spaces.md`
