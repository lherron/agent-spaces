# Refactor analysis — `spaces-runtime-contracts`

packageType: **data** (a contracts/DTO package — ~90% pure type declarations; the only
executable logic is `hash.ts`, the two transport helpers in `public-api.ts`, the
`validate-execution-profile.ts` legality registries, plus `const`-data tables in
`route-catalog.ts` / `compile-fixtures.ts` / `boundary-checks.ts`).

## Summary

**applicableCount: 0. No findings — clean.**

This package was visibly worked over by the two prior passes (T-02028, T-02030). The
evidence is everywhere in the executable files:

- `validate-execution-profile.ts` already converted the broker/embedded-sdk legality
  gates from flat guard sequences into **ordered rule registries** (`BROKER_RULES`,
  `EMBEDDED_SDK_RULES`) with per-driver rule arrays, a precomputed `BrokerProfileFacts`
  block, and the unsafe `'key' in driver` / forbidden-field probing **isolated into two
  documented helpers** (`readDriver*`, `hasForbiddenProfileField`). The T19
  conditional→dispatch mechanism is already applied.
- `validateExecutionProfile` is an **exhaustive `switch` with a `never` default** — the
  partial→total (T17) work is done; a new profile kind is a compile error here.
- `compile-fixtures.ts` already extracted the duplicated capability/state sub-blocks into
  shared `BASE_*` consts (`BASE_INPUT_CAPABILITIES`, `BASE_INVOCATION_INPUT_BLOCKS`,
  `BASE_PERMISSION_STATE`, …) — the T15 missing-abstraction work on the fixtures is done.
- `public-api.ts` already has the single canonical `transportAliasFor` dispatch that
  `legacyTransportAlias` delegates to (the T15/T19 dedup of the alias derivation).
- `hash.ts`'s `omitsLockedEnv` invariant guard, `serializeNumber` non-finite guard, and
  `escapeJsonPointerToken` are all named/extracted.

There is no remaining low-hanging fruit and nothing manufactured below. I pressure-tested
the three things that looked like candidates and all three are either already-fixed or
deliberately load-bearing (see "Deliberately left alone").

## Public boundary verdict

`src/index.ts` re-exports every module (`export *`). The package has **multiple in-repo
consumers** (`packages/aspc`, `packages/cli`, `packages/agent-spaces`) and at least one
cross-repo consumer (`hrc-runtime`, per the dev-publish loop). Per **M02 (expand/contract)**
any type-shape change here is a contract change that must be migrated at every consumer —
so the boundary is correctly treated as frozen. Characterization tests already pin the
three executable surfaces that matter: `hash.test.ts`, `public-api.test.ts`,
`validate-execution-profile.test.ts`, plus the `*.red.test.ts` guards. The make-safe (T40)
gate is therefore already satisfied; no new characterization tests are needed before
internal churn.

The public surface itself is well-shaped: discriminated unions on a `kind` tag throughout
(`RuntimeExecutionProfile`, `RuntimeState`, `RuntimeRouteDecision.admission`,
`AgentchatExposurePolicy`, `RuntimeReconcileResult`), explicit `| undefined` on optionals,
branded `Id<…>` types. No fat/leaky interface (T07) and no premature one-implementor
abstraction (T16) was found on the boundary.

## Findings by mechanism

None. Every mechanism A–E was walked outside-in and produced no applicable finding:

- **A make-safe / B boundary (T40/T07/M02):** boundary frozen, tests already present.
- **C seams & structure (T01/T16/T15/T03/T19):** dispatch registries + exhaustive switch
  already in place; shared fixture blocks already extracted; no new-concrete/singleton in
  logic; no one-instantiation generic or never-flipped flag to de-abstract.
- **D invariants (T12/T10/T17):** illegal states are already union-modeled; `validateExecutionProfile`
  is total; the `never` default is a real exhaustiveness guard, not a "can't happen" arm to remove.
- **E quality (T18/T23/T22/T21):** no swallowed catch (the only throws — `omitsLockedEnv`
  guard, non-finite number, undefined `serialize` arm — are intentional and reachable); no
  pass-through middle-man; max nesting is shallow; no param list >4 / data clump.

## Deliberately left alone (pressure-tested, NOT findings)

1. **`CLAUDE_CODE_TMUX_RULES` vs `CODEX_CLI_TMUX_RULES` near-parallel arrays**
   (`validate-execution-profile.ts:234-294`). Tempting T15 dedup target: each has a
   "claims-X ⇒ driver-kind-X", "driver-kind-X ⇒ terminalHost tmux", "driver-kind-X ⇒ pty
   transport" rule (codex adds a 4th hookBridge rule). **Left alone — load-bearing
   divergence + deliberate option-value.** The driver name is baked into both the `facts`
   selector boolean (`isClaudeCodeTmux` vs `isCodexCliTmux`) *and* the diagnostic
   `code`/`message` string literals, which the tests assert by exact value AND emission
   order (`v01-removal.red.test.ts` + `validate-execution-profile.test.ts`). Folding into a
   `makeTmuxDriverRules(name)` factory would force dynamic `${name}_requires_pty_transport`
   code construction (fragile, order-coupled) and re-introduce the exact cross-driver
   coupling the prior pass intentionally removed — the registry header comment states the
   design goal is "a new driver appends an array rather than editing a sibling branch."
   Parameterizing here trades a documented, safe seam for a fragile abstraction.

2. **`boundary-checks.ts` mid-token string concatenation** (`'rg "spaces-harness-' +
   'codex…'`). Looks like an obfuscation smell. **Left alone — deliberate self-protection,
   exhaustively documented in the file header.** The split keeps this file from matching the
   very ripgrep boundary patterns it ships; un-splitting would self-trigger the checks. The
   comment explicitly forbids "tidying" the literals back together.

3. **`hash.ts` `project()` `{ ...base, planHash }` spread** (`hash.ts:169-182`). The brief
   warns spreads can forward excess props. **Verified safe — not a finding.** `base` is an
   explicit local `{ hashProjection, value }`, so the field set is exact and closed; there
   is no source object whose extra properties could leak through, and the
   `RuntimeContractProjection` union members each add exactly one hash field. No projection
   rewrite warranted.

4. **`RuntimeStatus` / `RunStatus` / `BrokerPermissionRequestKind` `| string` open unions**
   (`primitives.ts`, `permissions.ts`). Not a T12 illegal-state target — these are
   intentionally open string unions (forward-compat with broker/driver-emitted statuses);
   closing them would be a behavior-narrowing redesign, not a refactor, and would break
   consumers that already carry vendor statuses.

## Outside-in apply sequence

Empty. There are no auto-applicable (Low/Med + internal-only) findings to sequence, and no
deferred (High / public-surface) findings to surface. The package is in a clean post-pass
state; the correct action is to take nothing.
