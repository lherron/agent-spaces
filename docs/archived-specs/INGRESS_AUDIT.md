# Phase B Input Ingress Audit

Task: T-01380. Parent: T-01379.

## Primary write ingress

The four primary ACP input write callers route through `InputAdmissionService.admit`:

- `packages/acp-server/src/handlers/inputs.ts:139`
- `packages/acp-server/src/handlers/coordination-messages.ts:227`
- `packages/acp-server/src/handlers/interface-messages.ts:178`
- `packages/acp-server/src/cli.ts:486` for the smoke harness path

## Wake dispatcher

The wake dispatcher path uses the `admitInput` shim at `packages/acp-server/src/cli.ts:485`. The direct `createAttempt` path remains a test-only fallback and is not a primary production ingress.

## Discord live progress

Recent Discord live-progress commits `3eb6dc5`, `bebcda2`, and `573bb3f` are read-side/rendering changes for progress visibility. They add no new input write ingress outside `InputAdmissionService`.
