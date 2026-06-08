# Refactor audit — `spaces-runtime-contracts`

## Scope and overall assessment

Audited every non-test source file under
`packages/spaces-runtime-contracts/src/` (26 files, ~3047 lines).

This is a **contracts package**: roughly 90% of the lines are pure TypeScript
`type`/`export type` declarations with no runtime behavior. Only three files
carry real executable logic:

- `hash.ts` — canonical JSON serializer + projection.
- `validate-execution-profile.ts` — per-kind legality validators.
- `public-api.ts` — `transportAliasFor` / `legacyTransportAlias` helpers.

The package was **recently and heavily refactored** in commit `e238805`
("SOLID/code-smell cleanup pass across all 17 packages"). The evidence is
visible throughout:

- `validate-execution-profile.ts` has already been rebuilt into a declarative
  rule-array registry (`BrokerLegalityRule[]` per driver), with the unsafe
  `'key' in driver` probing isolated into auditable helpers
  (`readDriverTerminalHost`, `readDriverHookBridge`, `hasForbiddenProfileField`).
- `hash.ts` extracts `serializeNumber`, `isEphemeralTimestampField`,
  `resolvePolicy`, `escapeJsonPointerToken`, `omitsLockedEnv` as named helpers.
- `compile-fixtures.ts` dedupes shared capability/state sub-blocks
  (`BASE_INPUT_CAPABILITIES`, `BASE_PERMISSION_STATE`, etc.) into named consts to
  prevent silent drift between fixtures.
- `route-catalog.ts` factors the three lifecycle baselines into named consts.

As a result there are **very few actionable findings**, and the ones that remain
are minor consistency / magic-string items. This is a genuinely clean package;
the small list below is honest, not padded.

---

## Findings

## Magic-string `/process/lockedEnv` repeated in omit guard
- File: packages/spaces-runtime-contracts/src/hash.ts:123
- Risk: Low
- API-impact: internal-only
- Smell: The literal `/process/lockedEnv` appears three times in
  `omitsLockedEnv` (exact match, suffix `endsWith`, infix `includes('/process/lockedEnv/')`).
  A repeated magic string that must stay in sync across three comparisons.
- Proposed change: Hoist a module-private `const LOCKED_ENV_POINTER = '/process/lockedEnv'`
  and build the three checks from it (`=== LOCKED_ENV_POINTER`,
  `endsWith(LOCKED_ENV_POINTER)`, `includes(\`${LOCKED_ENV_POINTER}/\`)`).
  Pure behavior-preserving dedupe of a literal.

## Embedded-SDK validator is a flat 100-line guard sequence (inconsistent with broker rule-registry pattern)
- File: packages/spaces-runtime-contracts/src/validate-execution-profile.ts:384
- Risk: Med
- API-impact: internal-only
- Smell: `validateEmbeddedSdkExecutionProfile` is ~100 lines of repetitive
  `if (cond) diagnostics.push(executionProfileDiagnostic(profile, code, message))`
  blocks. The broker validator in the same file was already refactored into a
  declarative `BrokerLegalityRule[]` registry iterated by a single loop; the
  embedded-sdk validator did not get the same treatment, so the two validators
  in one file use two different structural styles.
- Proposed change: Introduce a local `EmbeddedSdkLegalityRule =
  (profile) => CompileDiagnostic | undefined` rule array mirroring `BROKER_RULES`,
  move each guard into a rule entry, and iterate it the same way
  `validateBrokerExecutionProfile` does. Emission order is preserved by array
  order, so behavior and the diagnostics sequence existing tests assert stay
  identical. Internal to the file; the exported function signature is unchanged.

## Forbidden-profile-field keys are repeated string literals
- File: packages/spaces-runtime-contracts/src/validate-execution-profile.ts:420
- Risk: Low
- API-impact: internal-only
- Smell: `hasForbiddenProfileField(profile, 'brokerProtocol' | 'brokerDriver' |
  'brokerTerminal' | 'process' | 'transport' | 'terminal')` passes bare string
  literals for the forbidden field keys at lines 420-453. These are
  contract-significant field names duplicated as untyped strings; a typo would
  silently disable a legality gate.
- Proposed change: Define a module-private
  `const FORBIDDEN_EMBEDDED_SDK_FIELDS = ['brokerProtocol', 'brokerDriver', ...] as const`
  and reference the named members at each call site. Centralizes the field-name
  list. Behavior-preserving.

## `runtimeCapabilities` / `capabilityResolution` fixture consts use lowerCamel unlike sibling SCREAMING_SNAKE bases
- File: packages/spaces-runtime-contracts/src/compile-fixtures.ts:44
- Risk: Low
- API-impact: internal-only
- Smell: Minor naming inconsistency — `runtimeCapabilities` (line 44) and
  `capabilityResolution` (line 108) are module-private fixture consts in
  lowerCamelCase, while the surrounding shared blocks use SCREAMING_SNAKE
  (`BASE_INPUT_CAPABILITIES`, `BASE_PERMISSION_STATE`). Inconsistent within the
  file.
- Proposed change: Align the two private consts with a single convention. Purely
  a local rename — neither is exported. Low value; listed for completeness.

---

## Items explicitly NOT flagged (verified clean / intentional)

- `boundary-checks.ts`: the deliberately mid-token-split `rg` command literals
  are **intentional and load-bearing** (documented in the file header: un-split
  literals would self-trigger the boundary scan). Do NOT "tidy" these — left as-is.
- `validate-execution-profile.ts` `BROKER_RULES` ordering is asserted by tests;
  the rule-array structure is already the SOLID-correct shape.
- `hash.ts` `serialize` (~37 lines) is a single cohesive recursive serializer;
  splitting it would not improve clarity.
- The pervasive `?: T | undefined` explicit-undefined style is a repo-wide
  `exactOptionalPropertyTypes` convention, not a smell.
- No dead exports, no commented-out code, no unreachable branches found. The
  `validateExecutionProfile` switch has an exhaustive `never` default guard.
