# Refactor audit: packages/aspc-protocol (spaces-aspc-protocol)

Audited every non-test source file:
- `src/index.ts` (2 lines — barrel re-export of `types` + `schemas`)
- `src/types.ts` (130 lines — type/const declarations)
- `src/schemas.ts` (286 lines — request/command validators)
- `src/validation-primitives.ts` (116 lines — module-internal validation helpers)

## Overall assessment

This package was part of the T-02028 SOLID/code-smell cleanup pass (HEAD commit) and
reads as already-clean. Validators consistently use guard clauses / early returns, issue
codes and method names are centralized as named constants (`ISSUE_CODE`, `ASPC_METHODS`,
the response-version constants), method dispatch is a compiler-enforced lookup table
(`ASPC_PARAMS_VALIDATORS: Record<AspcMethod, ...>`), and duplicated record-validation logic
is already deduped into `validateOptionalPrimitiveRecord`. No functions exceed 50 lines, no
god objects, no deep nesting, no commented-out blocks. `validation-primitives.ts` is correctly
module-internal (NOT re-exported from `index.ts`), so its helpers are not public surface.

Findings are few and minor. Both are borderline-cosmetic, behavior-preserving, and internal-only.

## Bare schemaVersion literal not named locally
- File: packages/aspc-protocol/src/schemas.ts:221
- Risk: Low
- API-impact: internal-only
- Smell: Magic string `'agent-runtime-compile-request/v1'` passed inline to `requireLiteral`. The
  same literal is the canonical schemaVersion owned by `spaces-runtime-contracts`
  (`primitives.ts`, `compiler-plan.ts`).
- Proposed change: Optionally hoist to a local `const RUNTIME_COMPILE_REQUEST_SCHEMA_VERSION`
  near the top of `schemas.ts` for a single point of reference. NOTE: marginal value — the literal
  appears exactly once in this package and its authoritative home is `spaces-runtime-contracts`, so
  the cleaner long-term fix (import the constant from contracts) would be a cross-package change and
  is out of scope here. Safe to leave as-is.

## `validateStringRecord` name omits its optional/string-record semantics
- File: packages/aspc-protocol/src/schemas.ts:278
- Risk: Low
- API-impact: internal-only
- Smell: Naming asymmetry — its sibling is `validateOptionalBooleanRecord` (line 270) but the
  string variant is `validateStringRecord`, dropping the `Optional` prefix even though it also
  accepts `undefined`. Both delegate to `validateOptionalPrimitiveRecord`. Minor inconsistency in a
  module-internal (non-exported) function name.
- Proposed change: Rename the local function to `validateOptionalStringRecord` and update its single
  call site (`validateCompileHarnessInvocation`, line 207) to match its boolean sibling. Purely
  internal rename; not exported from the package.
