# harness-pi (spaces-harness-pi) — SOLID / code-smell audit

Audited every non-test source file under `packages/harness-pi/src/`:
`index.ts`, `register.ts`, `adapters/{pi-adapter,bundle,constants,detect,errors,fs-helpers}.ts`,
`adapters/codegen/{hook-bridge,hrc-events}.ts`.

Overall: this package was part of the recent SOLID cleanup pass (commit e238805) and is
in good shape. Concerns are already split into cohesive sibling modules
(`errors`/`detect`/`bundle`/`constants`/`fs-helpers`/`codegen/*`), the old god-class shape
of `pi-adapter.ts` has been broken into small private helpers, the repeated
`stat → isDirectory → copy/readdir` pattern is centralized in `fs-helpers.ts`, and magic
values live in `constants.ts`. Findings below are minor.

## Dead exported constant HOOK_LOG_RELATIVE_DIR
- File: packages/harness-pi/src/adapters/constants.ts:53
- Risk: Low
- API-impact: internal-only
- Smell: `HOOK_LOG_RELATIVE_DIR` is exported but imported nowhere (grep confirms zero
  references). It is NOT re-exported through the package entry (`index.ts`), so it is an
  internal-only module export. The hook-bridge codegen that should consume it instead
  hardcodes the same path segments as string literals.
- Proposed change: Remove the unused constant (or, if kept, derive the generated literal
  from it so the two cannot drift — see next finding). Deleting it is behavior-preserving
  and touches no public surface.

## Duplicated log-dir literal between constant and generated code
- File: packages/harness-pi/src/adapters/codegen/hook-bridge.ts:210
- Risk: Low
- API-impact: internal-only
- Smell: The generated hook bridge hardcodes `path.join(os.homedir(), 'praesidium', 'var',
  'logs')`, duplicating the path that `HOOK_LOG_RELATIVE_DIR` in constants.ts already names.
  Two sources of truth for the same host path can silently diverge.
- Proposed change: Interpolate the segments from `HOOK_LOG_RELATIVE_DIR` into the template
  (spread `JSON.stringify` of the array into the emitted `path.join(os.homedir(), ...)`),
  making the constant the single source of truth. The emitted string is identical →
  behavior-preserving.

## buildRunArgs is a long multi-job method
- File: packages/harness-pi/src/adapters/pi-adapter.ts:604
- Risk: Med
- API-impact: internal-only
- Smell: `buildRunArgs` is ~92 lines doing several distinct sub-jobs in sequence: prompt/
  reminder flags, extension discovery + `--no-extensions` fallback, skills flags, model
  translation, continuation handling, extra args, positional prompt. The method body is
  internal; the signature is fixed by the `HarnessAdapter` interface.
- Proposed change: Extract behavior-preserving private helpers that push onto a shared
  `args` array (e.g. `pushExtensionArgs(args, piBundle)`, `pushModelArgs(args, options)`,
  `pushContinuationArgs(args, bundle, options)`), leaving `buildRunArgs` a thin
  orchestrator. No signature change, no public surface touched. Med because it restructures
  the internal flow of a public method.

## Repeated "stat path → isFile → assign" blocks in loadTargetBundle
- File: packages/harness-pi/src/adapters/pi-adapter.ts:741
- Risk: Low
- API-impact: internal-only
- Smell: `loadTargetBundle` repeats the same try/`stat`/`isFile`/assign-or-undefined block
  twice (hookBridgePath, hrcEventsBridgePath) plus a near-identical readdir probe for
  skills. This is the same probe pattern already centralized for materialize/compose in
  `fs-helpers.ts` but not reused here.
- Proposed change: Add a small `existingFile(path): Promise<string | undefined>` helper
  (alongside the existing `fs-helpers`) and reuse `listDirEntries` for the skills check,
  collapsing the three blocks. Pure dedupe, behavior-preserving, internal-only.

## Cast-based ad-hoc type widening for hrcEventsBridgePath / runtimeId
- File: packages/harness-pi/src/adapters/pi-adapter.ts:361
- Risk: High
- API-impact: public-surface
- Smell: Several inline casts widen shared public types because fields the adapter relies
  on are not declared on the `spaces-config` contract types:
  `as ComposedTargetBundle['pi'] & { hrcEventsBridgePath... }` (lines 361, 770),
  `as typeof bundle.pi & { hrcEventsBridgePath?... }` (line 611), and
  `as HarnessRunOptions & { runtimeId?: string }` (line 707). This is a structural smell —
  the canonical type is missing fields the adapter treats as load-bearing.
- Proposed change (DEFER): Add `hrcEventsBridgePath` to `ComposedTargetBundle['pi']` and
  `runtimeId` to `HarnessRunOptions` in `spaces-config`, then drop the casts. Touches an
  exported shared contract consumed by other harness packages; needs a human and a
  cross-package build/typecheck. Documented only.
