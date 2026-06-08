# cli-kit — SOLID / code-smell audit

Package: `cli-kit` (`packages/cli-kit/`)
Source audited: `packages/cli-kit/src/index.ts` (191 lines, single source file; `index.test.ts` excluded as a refactor target).

## Verdict

This package was refactored in the most recent commit (`e238805`, T-02028, "SOLID/code-smell cleanup pass across all 17 packages"). The single source file is already clean against the detection guide:

- No long functions — the largest body is ~12 lines; `repeatable` overloads add up to ~9.
- Named constants already in place: `DURATION_UNIT_MS`, `DURATION_RE`, `EXIT_CODE_USAGE`, `EXIT_CODE_INTERNAL`. No raw magic numbers.
- Helpers already extracted and private: `isPlainObject`, `readBody`, `formatErrorLine`.
- Guard-clause / early-return style throughout (`attachServerOption`, `parseDuration`, `consumeBody`).
- No dead code, no commented-out blocks, no unused params; the comments document prior refactor decisions and the overload/type-guard rationale.
- Duration unit handling is already a lookup table (`DURATION_UNIT_MS`), not an if/else chain.
- The `value as unknown as T` cast in `repeatable` is deliberately confined to the no-parser overload and documented; not a smell to "fix."

Only one optional nit was found, and it is public-surface (deferred). No internal-only auto-applicable findings.

## Optional: `consumeBody` hardcodes `/dev/stdin` for `'-'`
- File: packages/cli-kit/src/index.ts:132
- Risk: Low
- API-impact: public-surface
- Smell: The stdin path literal `'/dev/stdin'` and the sentinel `'-'` are inline magic strings inside an exported function's branch.
- Proposed change: hoist `'-'` (STDIN_SENTINEL) and `'/dev/stdin'` (STDIN_PATH) to named module constants for readability. Behavior-preserving. Deferred because `consumeBody` is exported and the `'-'` sentinel + `/dev/stdin` semantics are part of the observable CLI contract consumers depend on; any touch here should be reviewed against the consuming CLIs and is not worth an auto-apply.

## Notes
No High-risk structural issues (no god objects, no boolean-trap refactors needed). The exported surface (`CliUsageError`, `attachJsonOption`, `attachServerOption`, `attachActorOption`, `repeatable`, `withDeps`, `parseDuration`, `parseJsonObject`, `parseCommaList`, `parseIntegerValue`, `consumeBody`, `exitWithError`, `BuildDeps`) is cohesive and single-purpose. This is a genuinely clean, recently-refactored utility module.
