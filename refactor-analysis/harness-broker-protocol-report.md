# SOLID / code-smell audit — `spaces-harness-broker-protocol`

Package dir: `packages/harness-broker-protocol/`

## Overall assessment

This package was just refactored in the most recent commit (`e238805 — SOLID/code-smell
cleanup pass across all 17 packages (T-02028)`) and the cleanup is visible and high quality:

- Cross-cutting validation primitives extracted to `validation-primitives.ts`, env policy to
  `env-keys.ts`, tmux id rules to `tmux-ids.ts` — all documented as behavior-preserving extractions
  that preserve the public surface.
- The former per-method/per-event `switch` chains were replaced by lookup tables
  (`COMMAND_PARAM_VALIDATORS`, `EVENT_PAYLOAD_VALIDATORS`, `HARNESS_RECOVERY_MODE_VALIDATORS`) with
  documented OCP rationale.
- A shared `ProtocolError` / `ProtocolValidationError` base removes constructor boilerplate across
  the error family.
- Compile-time exhaustiveness guards (`AssertExhaustive`) close the registry-vs-union drift gap.
- The `void _brokerMethodsExhaustive` / `void _eventTypesExhaustive` lines look like dead code but
  are intentional compile-time guards with an explanatory comment — NOT a finding.

Most files (`capabilities.ts`, `commands.ts`, `events.ts`, `invocation.ts`, `ids.ts`,
`primitives.ts`, `index.ts`, `jsonrpc.ts`, `ndjson.ts`, `errors.ts`) are pure type declarations or
already-tight logic with nothing actionable.

Only a handful of small, low-value internal cleanups remain in `schemas.ts`. None are required;
they are listed for completeness.

---

## Repeated "array shape" guard duplicated across five validators
- File: packages/harness-broker-protocol/src/schemas.ts:1925
- Risk: Low
- API-impact: internal-only
- Smell: The `if (!Array.isArray(value)) { push(value === undefined ? 'required' : 'invalid_type', '... must be an array') ; return }` preamble is copy-pasted in `requireStringArray`, `optionalStringArray` (validation-primitives.ts:48,90) and `validateInputContent`, `validateEnumArray`, `validateOptionalEventTypeArray` (schemas.ts). The "required vs invalid_type" ternary + "must be an array" literal repeat verbatim.
- Proposed change: Add a private helper `requireArray(value, basePath, issues): unknown[] | undefined` in `validation-primitives.ts` that performs the guard and returns the array (or undefined). Have the call sites use it, then `.forEach` over the returned array. Pure dedupe; same issue codes/messages emitted.

## Nested triple `asRecord(startRequest?.spec)` in dispatch lockedEnv lookup
- File: packages/harness-broker-protocol/src/schemas.ts:698
- Risk: Low
- API-impact: internal-only
- Smell: `validateInvocationDispatchRequestShape` derives `lockedEnv` with `asRecord(startRequest?.spec)?.process !== undefined ? asRecord(asRecord(startRequest?.spec)?.process)?.lockedEnv : undefined` — `asRecord(startRequest?.spec)` is evaluated three times and the ternary's false branch is already `undefined` (a no-op).
- Proposed change: Compute once: `const specRecord = asRecord(startRequest?.spec); const processRecord = asRecord(specRecord?.process); const lockedEnv = processRecord?.lockedEnv`. Behavior-identical, removes the redundant evaluations and the no-op ternary.

## `validateEnumArray` and `validateOptionalEventTypeArray` share enum-membership-per-item logic
- File: packages/harness-broker-protocol/src/schemas.ts:1909
- Risk: Low
- API-impact: internal-only
- Smell: Both iterate an array pushing an `invalid_*` issue when an item is not a string or not in the allowed set. They differ only in the membership source (a literal `allowed[]` array vs the `eventTypes` Set) and the issue code/message — near-duplicate bodies.
- Proposed change: Route both through a shared private `forEachArrayItem(value, basePath, issues, predicate, code, message)` helper (best done alongside the array-guard dedupe above, sharing the same helper). Behavior-preserving.

## `SchemaRecord` is a hand-maintained ~130-key optional-`unknown` index type
- File: packages/harness-broker-protocol/src/schemas.ts:65
- Risk: Med
- API-impact: public-surface
- Smell: `SchemaRecord` is exported and is a ~130-line manually-curated map of every DTO field name to `unknown`. It is essentially `Record<string, unknown>` with documentation-only key hints; new fields must be remembered here or property access reverts to bracket strings (the file already mixes `payload.kind` dotted access and `payload['kind']` bracket access inconsistently because of this). It is a mild god-type and a drift risk.
- Proposed change (DEFER — do not auto-apply): Consider collapsing to `type SchemaRecord = Record<string, unknown>` (uniform bracket access) OR generating the key union from the DTO types. Either changes an exported type's shape and the access pattern throughout the file, so it needs human review and a typecheck/test gate. Documented only.

---

## Summary counts
- Auto-applicable (Low/Med AND internal-only): 3
- Deferred (High-risk OR public-surface): 1
