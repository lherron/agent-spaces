# Refactor Analysis — `spaces-aspc-protocol`

**Package dir:** `packages/aspc-protocol`
**Package type:** `data` (a hand-rolled JSON-RPC protocol contract: types + accumulating validators; no I/O, no concurrency, no perf hot path)
**Source:** `src/index.ts` (2), `src/types.ts` (130), `src/schemas.ts` (297), `src/validation-primitives.ts` (116). Total ~545 LOC.
**Characterization tests:** `test/schemas.test.ts` (187 LOC) exercise every public `validateAspc*` entry point, including the `instanceof`/`.code` branching on the error subclasses and the `unsupported_protocol` ordering invariant.
**External consumers:** `packages/aspc` (`spaces-aspc`) imports `AspcCompileHarnessInvocationRequest`, `AspcProfileSelector`, `ASPC_PROTOCOL_VERSION`, and the `validateAspc*` functions. This is a published, semver'd package (`0.1.1`) — public surface changes require expand/contract (M02).

## Summary

This package is **clean**. It is a contract package whose entire job is to be a stable, well-named surface, and it already shows the fingerprints of the two prior refactor passes (T-02028 / T-02030):

- `ASPC_METHODS` is a single-source-of-truth tuple; `AspcMethod`, the `isAspcMethod` predicate, and the `ASPC_PARAMS_VALIDATORS` dispatch table are all derived from it. The dispatch table is typed `Record<AspcMethod, ParamsValidator>` so adding a method without a validator is a compile error. This is exactly the [T19] conditional→dispatch + [T12] illegal-states-unrepresentable shape we would otherwise recommend — already present.
- Response-envelope `schemaVersion` literals are hoisted to named `const`s (`ASPC_COMPILE_*_RESPONSE_VERSION`) and reused across the success/failure arms of each union — no magic-string copy-paste.
- The boolean- and string-valued record validators were already de-duplicated into `validateOptionalPrimitiveRecord` (with a correctly-scoped `// biome-ignore useValidTypeof`).
- The error hierarchy (`AspcValidationError` abstract base + four concrete subclasses) is **not** premature abstraction: tests assert `toBeInstanceOf(...)` and `.code`/`.issues`, and consumers branch on the concrete types. It is exercised structure, not speculative.
- `validation-primitives.ts` is correctly kept module-internal (not re-exported from `index.ts`), with a docstring stating exactly that intent.

**Applicable (auto-apply) findings: 0.** No Low/Med internal-only finding survived pressure-testing. The one structurally-interesting observation (cross-package primitive parallel) is a deliberate, diverged copy that would require a cross-package redesign — left alone, documented below.

## Public boundary verdict

**Pin, do not change.** The public surface (`types.ts` exports + the five `validateAspc*` functions + the error classes, all re-exported via `index.ts`) is coherent, narrow, and matches actual consumer usage in `packages/aspc`. The characterization tests already gate it ([T40] make-safe is satisfied). No fat interface to narrow, no leaky interface to widen. Any change here is M02 expand/contract on a published package — out of scope for an internal pass.

## Findings by mechanism

None applicable. Every candidate was pressure-tested and rejected:

### Rejected candidates (pressure-test record)

- **[T23] collapse pass-through — `validateAspcCompileAndStartRequest` (schemas.ts:119-121).** This forwards verbatim to `validateAspcCompileHarnessInvocationRequest`. *Rejected:* it is a public export and a deliberate alias for a distinct protocol method (`aspc.compileAndStart`); the request shapes are currently identical by design but are independent contract points (`AspcCompileAndStartRequest = AspcCompileHarnessInvocationRequest` is an intentional type alias, not an accident). Collapsing it is a public-surface change and removes the seam where the two methods are expected to diverge. Contraindication (deliberate option / public boundary) applies. Leave.

- **[T15] extract shared shape — the four public validator wrappers (schemas.ts:88-117) repeat `issues=[]; validateX(...); if (length>0) throw new XError(issues); return value as Y`.** *Rejected:* each wrapper throws a **different** error subclass and casts to a **different** result type. Folding into a generic helper would require threading both an error constructor and a type parameter, trading four transparent 4-line functions for one higher-order indirection — and the per-call divergence (distinct `instanceof`-able error class) is load-bearing for consumers and tests. Net legibility loss. Leave.

- **[T16] de-abstract the error hierarchy.** *Rejected:* `AspcValidationError` (abstract) has four concrete subclasses, each with a distinct `code` literal and name. Tests assert `toBeInstanceOf(AspcCommandValidationError)` / `toBeInstanceOf(AspcHelloRequestValidationError)` and read `.code`/`.issues`. The variation has materialized and is observed. Not premature. Leave.

- **[T16] remove `coerceRecord` (validation-primitives.ts:54).** Exported but only referenced by `requireRecord` within the same module. *Rejected:* it is documented as the silent counterpart to `requireRecord` and the pairing is intentional/legible; it is module-internal (not on the package's public surface, so no consumer churn either way), and inlining it would erase the named distinction between "silent coerce" and "coerce-or-record-issue" that the docstrings lean on. Low/no value; leave.

## Deliberately left alone

- **Cross-package primitive parallel: `packages/aspc-protocol/src/validation-primitives.ts` vs `packages/harness-broker-protocol/src/validation-primitives.ts`.** Both define overlapping accumulating helpers (`requireString`, `requireStringArray`, `optionalString`, record coercion). They have **diverged**: broker's version uses a local `makeIssue` + `SchemaRecord` from its own `schemas.ts`, carries extra helpers (`requireNumber`, `requireTrue`, `requirePayloadRecord`, `optionalStringArray`), and uses bare string codes; aspc's version uses a shared `ISSUE_CODE` const and a `path()` joiner. Neither is re-exported publicly. Consolidating would mean introducing a new shared primitives package (or making one package depend on the other's internal module), i.e. a new public-surface decision and dependency edge — a cross-package **redesign**, not a behavior-preserving internal refactor of `aspc-protocol`. Classic diverging-copies contraindication. Out of scope for a single-package pass; flag for a deliberate platform decision if the divergence ever stops being intentional.

- **Stray repo artifacts** `default.profraw` and `docs/html/daily-accomplishments-2026-06-08.html` are unrelated to this package (not under `packages/aspc-protocol`); not addressed here.

## Outside-in apply sequence

No edits to apply. The make-safe layer ([T40] characterization tests) is already in place and green over the public surface; the boundary is pinned; no internal finding survived pressure-testing. A target with zero applicable items after two prior refactor passes is the expected, honest result.
