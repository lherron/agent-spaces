# agent-scope — SOLID / code-smell audit

Package: `agent-scope` (`packages/agent-scope/`)
Source audited (non-test): `index.ts`, `types.ts`, `input.ts`, `scope-ref.ts`, `scope-handle.ts`, `session-ref.ts`, `session-handle.ts`, `lane-ref.ts` (695 lines total).

## Overall assessment

This package is small, single-purpose (parse/validate/format scope & session refs and handles), and was clearly the subject of a recent SOLID/code-smell cleanup pass (commit `e238805`). It is in good shape:

- Functions are short and single-job. The longest, `validateScopeRef` (scope-ref.ts, ~56 lines), is a linear grammar validator that already reads as a sequence of guard clauses; splitting it would hurt readability, not help. No extraction recommended.
- The handle grammar has a single source of truth (`splitHandle` in scope-handle.ts, reused by both validate and parse). The ScopeRef assembly has a single builder (`buildScopeRef`). The validate-token boilerplate was already deduped into `validateTokenField`.
- Magic strings are already named constants (`TOKEN_PATTERN`, `TOKEN_MIN/MAX_LENGTH`, `DEFAULT_LANE_ID`, `DEFAULT_PRIMARY_TASK_ID`, `LANE_PREFIX`).
- No dead code, no commented-out blocks, no unreachable branches found across the eight files.

Findings below are minor. Only one is a concrete, behavior-preserving dedupe; the rest are observations recorded for completeness.

## Duplicated `LANE_PREFIX` constant across lane-ref.ts and session-ref.ts
- File: packages/agent-scope/src/session-ref.ts:6
- Risk: Low
- API-impact: internal-only
- Smell: The literal `const LANE_PREFIX = 'lane:'` is declared identically in `lane-ref.ts:5` and `session-ref.ts:6`. `session-ref.ts` already imports three helpers (`laneIdFromRef`, `laneRefFromId`, `normalizeLaneRef`) from `lane-ref.ts`, so the constant is the only piece copy-pasted rather than shared. Two definitions of the same protocol literal can drift independently.
- Proposed change: `export const LANE_PREFIX` from `lane-ref.ts` (a new module-internal export only — it is NOT re-exported from `index.ts`, so the package public surface is unchanged) and `import { LANE_PREFIX }` in `session-ref.ts`, deleting the local copy. Behavior-preserving; the value is identical.

## `part(parts, i)` index-cast helper — minor readability tax (no change recommended)
- File: packages/agent-scope/src/scope-ref.ts:4
- Risk: Low
- API-impact: internal-only
- Smell: `function part(parts, i) { return parts[i] as string }` exists only to launder `string | undefined` into `string` after the validator has already guaranteed bounds. Every access reads `part(parts, 5)` instead of `parts[5]`, and the `as string` defeats the type-checker's bounds awareness. Borderline.
- Proposed change: Optional only. Leave as-is unless already touching the file; the helper is internal and consistently used, and removing it would reintroduce `as string` casts at each call site (no net improvement). No change recommended.

## Verdict
Already clean. One applicable dedupe (`LANE_PREFIX`), no deferred (High-risk / public-surface) findings.
