# 🔧 Refactoring Analysis

**Target:** `packages/spaces-runtime-contracts/src`
**Lines analyzed:** 2905 (26 TypeScript source files)
**Generated:** 2026-06-01  ·  **Focus:** all

> Scope note: this is a **contracts / DTO package** — its public surface is almost entirely `type`/`interface` declarations plus a handful of `satisfies`-checked constant fixtures. The only meaningful executable logic lives in `validate-execution-profile.ts` (legality gates), `hash.ts` (canonical serialization), `public-api.ts#legacyTransportAlias`, and `route-catalog.ts` (a static catalog). SOLID/code-smell findings are therefore concentrated in those four units; the rest of the package is type definitions where most OO smells do not apply. Findings below are calibrated to that reality (no invented "god class" claims against pure type modules).

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🟡 | `validate-execution-profile.ts` `validateBrokerExecutionProfile` is one 180-line function mixing app-server, claude-tmux, codex-tmux, interactive-tmux and exposure rules; `compile-fixtures.ts` hand-duplicates large capability/state literals. |
| Open/Closed | 🔴 | Driver-specific legality lives in long flat `if` chains keyed on `brokerDriver`/`specDriverKind` strings (`validateBrokerExecutionProfile`); every new broker driver edits the same function. `route-catalog.ts` is an append-only array but acceptable; `project()`/`projectionOmitPaths` switch on `kind`. |
| Liskov Substitution | 🟢 | No class hierarchies or overrides. `RuntimeController` interface uses discriminated `kind` + optional methods cleanly; no `throw "not implemented"` or no-op overrides. |
| Interface Segregation | 🟡 | `RuntimeController` (10 members, several optional) and very wide DTOs (`HrcRuntimeSnapshot` ~40 fields, `BrokerRuntimeState`) push large structural surfaces onto every implementor/consumer, but optionality is mostly principled. |
| Dependency Inversion | 🟢 | Pure contracts package: depends only on `spaces-harness-broker-protocol` and `node:crypto`. `CanonicalHasher` is exposed as an interface with a factory (`createCanonicalHasher`) — good seam. No business-logic `new Concrete()`. |

## 🎯 Priority Refactorings

### 1. `validateBrokerExecutionProfile` is a single long, OCP-hostile rule chain — Open/Closed + SRP
- **Location:** `validate-execution-profile.ts:108-287`
- **Current:** One exported function (~180 lines) computes ~9 boolean driver flags (`isCodexAppServer`, `profileClaimsClaudeCodeTmux`, `isClaudeCodeTmux`, `profileClaimsCodexCliTmux`, `isCodexCliTmux`, …) then runs ~13 independent `if (…) diagnostics.push(executionProfileDiagnostic(...))` blocks covering codex-app-server, claude-code-tmux, codex-cli-tmux, generic interactive, and exposure-policy concerns intermixed. Adding a new broker driver (or a new legality gate for an existing one) means editing the middle of this function and re-reading every sibling branch to confirm no interaction.
- **Suggested:** Extract a table/registry of small single-purpose rule functions: `type BrokerLegalityRule = (profile: BrokerExecutionProfile, facts: BrokerProfileFacts) => CompileDiagnostic | undefined`. Compute the derived flags once into a `BrokerProfileFacts` struct (removes the repeated `'x' in spec.driver` probing and the `specDriver*` locals), then `BROKER_RULES.flatMap(r => r(profile, facts) ?? [])`. Group rules by driver into named arrays (`CODEX_APP_SERVER_RULES`, `CLAUDE_CODE_TMUX_RULES`, `CODEX_CLI_TMUX_RULES`, `INTERACTIVE_TMUX_RULES`) so each driver's gates are co-located and a new driver adds an array entry, not a function edit.
- **Risk:** Med  ·  **Effort:** ~2-3h  ·  **Tests:** `test/validate-execution-profile.test.ts` already exercises these gates via a reflective lookup of `validateBrokerExecutionProfile`; re-run after the extraction — diagnostics output (codes/messages) must remain byte-identical.

### 2. Driver-fact extraction relies on untyped `'key' in spec.driver` probing — Primitive obsession / weak typing
- **Location:** `validate-execution-profile.ts:116-124` (`specDriverTerminalHost`, `specDriverHookBridge` read via `'terminalHost' in spec.driver ? spec.driver['terminalHost'] : undefined`) and `:307` (`profile as unknown as Record<string, unknown>`)
- **Current:** The validator structurally pokes at `spec.driver` and at fields that "aren't part of the type" through `as unknown as Record`, with inline comments explaining why. This defeats the type system precisely in the module whose job is to defend contract legality, and scatters the same defensive idiom across two functions.
- **Suggested:** Centralize the structural reads into named helpers (`readDriverTerminalHost(spec)`, `readDriverHookBridge(spec)`, `hasForbiddenBrokerField(profile, key)`) returning typed results, so the unsafe casts live in one auditable place and the rule bodies read declaratively.
- **Risk:** Low  ·  **Effort:** ~1h  ·  **Tests:** covered by existing validate-execution-profile tests; no behavior change intended.

### 3. `compile-fixtures.ts` duplicates large capability/state object literals — DRY / SRP
- **Location:** `compile-fixtures.ts:19-341` (the `input/turns/continuation/events/control` capability block is hand-written verbatim in `runtimeCapabilities` ~19-57, in `compileOnlyBrokerRuntimeState.invocation.capabilities` ~161-198, and again in `durableUnixBrokerRuntimeState.invocation.capabilities` ~273-310)
- **Current:** Three near-identical ~40-line capability literals plus duplicated `permission`/`input.policy` blocks. These are fixtures consumed by smoke/contract tests, so drift between copies silently weakens what the tests assert.
- **Suggested:** Define shared base constants (`BASE_INVOCATION_CAPABILITIES`, `BASE_PERMISSION_STATE`, `BASE_INPUT_STATE`) and spread/override the few fields that actually differ between the compile-only and durable-unix fixtures (e.g. `events.replay/ack`, `control.attach`, `lastEventSeq`). Keep the `satisfies` checks at the composition site.
- **Risk:** Low  ·  **Effort:** ~1h  ·  **Tests:** any test importing these exported fixtures (e.g. runtime-state / matrix smokes) — values must stay identical post-dedup; assert via a snapshot or deep-equal before/after.

### 4. `legacyTransportAlias` logic is duplicated across two layers — DRY / single-source-of-truth
- **Location:** `public-api.ts:80-92` (`legacyTransportAlias(view)`) vs `public-api.ts:87` inline (`view.controller.brokerTerminal?.host === 'tmux' ? 'tmux' : 'headless'`) and the equivalent computed `legacyTransportAlias` field carried on `RuntimeRouteDecision` (`route-decision.ts:102`), `RuntimeExecutionView.transport` (`public-api.ts:76`), and `HrcRuntimeSnapshot.legacyTransport`/`transport` (`operations.ts:120-121`).
- **Current:** The same controller→alias mapping is expressed once as a pure function here and is also a persisted/transported field elsewhere, with no guarantee the producers agree with this function.
- **Suggested:** Make this function the canonical derivation and document/test that all `legacyTransportAlias`/`transport` fields are populated from it. (Contracts-package change is just the doc comment + an exported helper; enforcement lives in producers, out of scope for this package.)
- **Risk:** Low  ·  **Effort:** ~30m (doc + test)  ·  **Tests:** add a unit test mapping each `controller.kind` to its alias.

### 5. Mid-file `import` statements scattered below declarations — readability / consistency smell
- **Location:** `ids.ts:31`, `operations.ts:87`, `runtime-state.ts:51`, `route-decision.ts:113`, `hash.ts:24` (and the `import type` block at `compile-fixtures.ts:16-17` sits after other imports cleanly, but the above are genuinely interleaved with type bodies)
- **Current:** Several modules declare types, then drop an `import type { … }` in the middle of the file (e.g. `runtime-state.ts` defines `RuntimeStateBase` then imports `RunId` on line 51; `hash.ts` defines its public types then `import { createHash }` on line 24). This hides dependencies and trips the usual "imports at top" reader expectation.
- **Suggested:** Hoist all `import`/`import type` to the file header. Mechanical and low-risk; Biome can assist.
- **Risk:** Low  ·  **Effort:** ~20m  ·  **Tests:** typecheck only (`bun run typecheck`).

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Long function (~180 lines) with ~13 sequential rule branches | `validate-execution-profile.ts:108-287` | 🟠 |
| Unsafe `as unknown as Record<string, unknown>` to read off-type fields | `validate-execution-profile.ts:307` | 🟠 |
| Untyped `'key' in spec.driver ? spec.driver['key'] : undefined` probing (repeated) | `validate-execution-profile.ts:116-118, 233` | 🟡 |
| Duplicated ~40-line capability literals (×3) | `compile-fixtures.ts:19-57, 161-198, 273-310` | 🟠 |
| Duplicated permission/input policy literals across fixtures | `compile-fixtures.ts:200-219, 321-340` | 🟡 |
| Magic JSON-RPC error-code numbers in enum (no shared source w/ protocol pkg) | `errors.ts:30-41` | 🟡 |
| Mid-file imports interleaved with type bodies | `ids.ts:31`, `operations.ts:87`, `runtime-state.ts:51`, `route-decision.ts:113`, `hash.ts:24` | 🟡 |
| `switch (kind)` returning shaped object — OCP pressure if a projection kind is added | `hash.ts:171-180`, `hash.ts:183-193` | 🟡 |
| `omitsLockedEnv` does three overlapping string checks (`===`, `endsWith`, `includes('/…/'`)) — fragile path matching | `hash.ts:123-129` | 🟡 |
| Wide string-union escape hatches (`… | string`) weaken exhaustiveness (`RuntimeStatus`, `RunStatus`, `RuntimeControlErrorCode`, `brokerDriver`) | `primitives.ts:37-61`, `errors.ts:1-20`, `execution-profile.ts:108` | 🟡 |
| `inputId`/`InputId` import split from main `ids` import block | `ids.ts:31`, `operations.ts:87` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Hoist the interleaved mid-file imports in `ids.ts`, `operations.ts`, `runtime-state.ts`, `route-decision.ts`, `hash.ts` to file headers (Finding #5). Pure cleanup, typecheck-gated.
2. Extract `BASE_INVOCATION_CAPABILITIES` (and base permission/input state) constants in `compile-fixtures.ts` and spread the deltas (Finding #3). Removes ~120 duplicated lines and prevents fixture drift.
3. Wrap the structural `'key' in spec.driver` / `as unknown as Record` reads in `validate-execution-profile.ts` behind two named typed helpers (Finding #2) — isolates the unsafe casts before the larger rule-table refactor.
4. Add a unit test for `legacyTransportAlias` covering all five `controller.kind` values (Finding #4) — locks in the mapping cheaply.

## ⚠️ Technical Debt Notes

- **Driver legality is encoded twice**: once as string-keyed `if` branches in `validateBrokerExecutionProfile` and once structurally in `RUNTIME_ROUTE_CATALOG` (`route-catalog.ts:56-166`, e.g. claude-code-tmux ⇒ `processTransport: 'pty'`). These two sources can disagree (the catalog says a driver uses `pty`; the validator independently re-asserts `transportKind !== 'pty'`). A future refactor should let the validator derive expectations from the catalog rather than restate them, collapsing two edit sites into one.
- **`migrationOnly`/`legacy-exec` surface** (`execution-profile.ts:165-175`, `runtime-state.ts:168-174`, route-catalog entry with `removalGate: 'delete-after-broker-codex-cutover'`) is intentionally temporary debt with an explicit removal gate — fine, but it widens every discriminated union (`RuntimeExecutionProfile`, `RuntimeState`, `RuntimeControllerKind`) and its validator/exhaustiveness handling. Track the cutover so these branches are deleted, not left to accrete.
- **Open string unions** (`… | string` on `RuntimeStatus`, `RunStatus`, `brokerDriver`, error codes) trade exhaustiveness checking for forward-compat. This is a deliberate contracts-evolution choice, but it means `switch` consumers in downstream packages get no compiler help when a new value appears; consider a separate `KnownRuntimeStatus` closed union plus a widened alias so internal logic can still switch exhaustively.
- **`BrokerErrorCode` numeric enum** (`errors.ts:30-41`) hardcodes JSON-RPC error numbers that presumably must match `spaces-harness-broker-protocol`; if the protocol package owns these, re-export rather than duplicate to avoid silent divergence.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (`test/validate-execution-profile.test.ts`, `test/hash.test.ts`, `test/runtime-state.red.test.ts`) — confirm green before starting
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run `bun run typecheck` + `bun run test` between each
- [ ] For fixture dedup (#3), deep-equal the exported fixtures before/after to prove zero value drift
- [ ] For the validator rule-table extraction (#1), keep diagnostic `code` + `message` strings byte-identical
- [ ] Run `bun run build` then `bun run check:boundaries` / `bun run check:manifests` (this is a cross-repo publishable boundary package)
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

These are issues NOT raised in the first pass. They concentrate on the executable
serializer in `hash.ts` and on contract-surface / async-cleanup seams that the
first pass (focused on the validator's rule-chain and fixture dedup) did not cover.

### A1. Omitting an *array element* via `omitPaths` corrupts the canonical string — correctness bug
- **Principle/smell:** Missing edge-case handling / silent data corruption (the most load-bearing function in the package emits invalid canonical JSON).
- **Location:** `hash.ts:69` (`if (policy.omitPaths.includes(pointer)) return ''`) interacting with the array branch `hash.ts:83-88`.
- **Detail:** The object branch handles an omitted child by `continue` (`hash.ts:95`), so the key/value pair is dropped cleanly. But array elements are produced by recursing into `serialize(item, …, \`${pointer}/${index}\`)` and joining with `,`. When an element's pointer is in `omitPaths`, `serialize` returns the empty string, yielding `[a,,c]` (or `[]` → `[,]`) — a malformed, ambiguous canonical token. Two different inputs (e.g. omit index 1 of a 3-array vs. a value that genuinely serializes empty) can collide or produce non-round-trippable output, and `project()` then feeds this through `JSON.parse(canonical)` (`hash.ts:165`) which will throw on the trailing/leading comma. The public `canonicalize`/`hash` accept arbitrary caller `omitPaths`, so this is reachable from the published API, not just the internal `projectionOmitPaths` (which happens to only emit object-key paths).
- **Risk:** Med (latent; only triggers when a caller omits an array index, which today's internal callers don't — but it's an exported contract). **Effort:** ~30m — either reject array-index omitPaths in `resolvePolicy`, or have the array branch drop omitted indices the way the object branch does.

### A2. No test exercises array-index `omitPaths`, top-level scalar omit, or the `project → JSON.parse` round-trip on omitted arrays — test gap
- **Principle/smell:** Test gap shielding A1.
- **Location:** `test/hash.test.ts:82-96` (`omitPaths` test only covers object-key pointers `/requestId`, `/nested/ephemeral`).
- **Detail:** Every `omitPaths` assertion targets object keys; none targets `/items/0` (array index) or the root pointer `''`. The corruption in A1 is therefore invisible to CI. Add cases that omit an array element and assert the canonical string and `project()` value stay well-formed (or that the call is rejected per the chosen fix).
- **Risk:** Low. **Effort:** ~20m.

### A3. `serialize` silently returns `'null'` for a top-level `undefined`/`function`/`symbol` instead of rejecting — leaky/forgiving contract
- **Principle/smell:** Missing edge-case handling / forgiving-input smell in a security-relevant (hash-determinism) path.
- **Location:** `hash.ts:77-81`.
- **Detail:** The comment says callers strip `undefined` object fields before recursing, so reaching this branch is "an array hole." But the branch is also reachable at the *top level*: `hash(undefined)`, `hash(() => {})`, or `hash(Symbol())` all silently hash the literal `'null'`, producing a stable but meaningless digest with no error. For a canonical hasher whose whole job is to make illegal inputs detectable, a top-level non-serializable value should throw (like the non-finite-number guard at `hash.ts:62-64` already does), not coerce to `null`.
- **Risk:** Low. **Effort:** ~20m — guard the top-level entry in `canonicalize`/`hash`/`project`, or throw in this branch when `pointer === ''`.

### A4. `omitPaths` matching is escape-asymmetric and undocumented for keys containing `/` or `~` — leaky abstraction
- **Principle/smell:** Leaky abstraction / undocumented contract.
- **Location:** `hash.ts:69` and `hash.ts:94` (object child pointers are built with `escapeJsonPointerToken`, but the caller-supplied `omitPaths` strings are compared verbatim via `.includes()`).
- **Detail:** Child pointers escape `~`→`~0` and `/`→`~1` (RFC 6901), but a caller wanting to omit a field literally named `a/b` must pre-escape it to `/a~1b` with no documentation or validation telling them so — and `omitsLockedEnv` (`hash.ts:123-129`) does its own *unescaped* substring matching, so the two path-matching schemes in the same file disagree on escaping. There is also no validation that an `omitPath` is a well-formed JSON Pointer (must start with `/` or be `''`); a typo like `process/lockedEnv` (missing leading slash) silently matches nothing, defeating the `omitsLockedEnv` safety guard. The first pass flagged `omitsLockedEnv` as "fragile string matching" but did not surface the escaping asymmetry or the missing pointer-shape validation.
- **Risk:** Med (the un-validated `omitsLockedEnv` guard is a security/determinism control — a malformed path bypasses it silently). **Effort:** ~45m — validate pointer shape, route both checks through one escaped tokenizer.

### A5. Three exported profile validators with no kind-dispatching entry point — Open/Closed + missing abstraction
- **Principle/smell:** OCP / missing facade — the inverse of the first pass's "one giant validator" finding.
- **Location:** `validate-execution-profile.ts:24` (`validateTerminalExecutionProfile`), `:108` (`validateBrokerExecutionProfile`), `:300` (`validateEmbeddedSdkExecutionProfile`); the `command-process` / `legacy-exec` profile kinds have *no* validator at all.
- **Detail:** The package exports three separate per-kind validators but no `validateExecutionProfile(profile)` that switches on the discriminant and routes to the right one (and returns `[]` or a diagnostic for unhandled kinds). Every downstream caller must re-implement that `switch`, and because there is no exhaustive dispatcher, adding a new profile kind (e.g. a future `command-process` legality gate) gives no compile-time push to wire it up — the gap stays silent. A single exported dispatcher with an exhaustive `switch (profile.kind)` (with a `never` default) would localize the routing and make a missing validator a type error.
- **Risk:** Low (additive — pure new export). **Effort:** ~30m.

### A6. Async controller/mapper contracts carry no cancellation seam — async-cleanup / contract-surface gap
- **Principle/smell:** Async resource-cleanup / contract surface (no way to cancel or time-bound in-flight work).
- **Location:** `controller.ts:12-24` (`RuntimeController.start/dispatchTurn/interrupt/stop/dispose/inspect/reconcile` all return bare `Promise<…>`); `event-mapper.ts:13-18` (`BrokerEventMapper.apply` returns `Promise` with no signal in `BrokerEventContext`).
- **Detail:** These interfaces model long-running broker/terminal operations (start a process, dispatch a turn, reconcile a possibly-gone broker) yet none of them accepts an `AbortSignal` (or deadline). A host that wants to cancel a hung `start()` or bound `reconcile()` has no contract-level seam; implementations must invent ad-hoc timeouts, and a cancelled-but-still-running `start()` can leak the half-started runtime it was about to return. `interrupt`/`stop` exist for *turn/runtime* lifecycle but not for cancelling an individual in-flight *operation* promise. The first pass treated `RuntimeController` only under ISP (width/optionality); it did not flag the absence of a cancellation parameter.
- **Risk:** Med (a contract addition rippling to every implementor in HRC), but high value for resource-leak safety. **Effort:** ~1-2h across the contract + implementors (contract change here is additive: add `signal?: AbortSignal` to the input structs / context).

### A7. `boundary-checks.ts` ships executable shell commands as string fragments split mid-token — fragility / hidden coupling
- **Principle/smell:** Stringly-typed executable config / fragile construction.
- **Location:** `boundary-checks.ts:13-15`, `:21-24`, `:31-32`.
- **Detail:** Each `command` is a `ripgrep` invocation assembled by concatenating string literals that are deliberately split mid-word (e.g. `'rg "launch/exec|exec\\.ts" packages/hrc-' + "server/src …"` splits the path `hrc-server` across two literals, and the regex `'rg "spaces-harness-' + 'codex|…'` splits `spaces-harness-codex`). This is presumably done so the file itself doesn't match the boundary checks that scan the repo — but it makes the commands extremely easy to break on edit (a stray space or reorder silently changes the executed `rg` pattern), embeds glob/flag syntax with no validation, and couples this contracts package to the exact on-disk path layout of a *different* repo (`packages/hrc-server/src`). At minimum the splitting intent deserves a comment; better, model the check as structured fields (pattern, paths, excludes) and let the runner assemble the command so it can't be silently corrupted and can be unit-tested.
- **Risk:** Low (config data, not runtime logic). **Effort:** ~1h if restructured; ~5m to just document the deliberate splits.

### A8. `RuntimeRouteHarnessRuntime`, `view.transport` and `routeDecision.legacyTransportAlias` keep widening the same `… | string` alias the first pass flagged — but `legacyTransportAlias()` can't actually be applied to the persisted producers
- **Principle/smell:** Single-source-of-truth erosion (extends first pass finding #4 with a concrete unreachability, not a restatement).
- **Location:** `public-api.ts:80-92` (`legacyTransportAlias(view)` takes a `RuntimeExecutionView`) vs. the field populated on `RuntimeRouteDecision.legacyTransportAlias` (`route-decision.ts:102`) which is computed *before* any `RuntimeExecutionView` exists.
- **Detail:** First pass #4 said "make `legacyTransportAlias` the canonical derivation." Fresh observation: it *cannot* be, as written — its sole input is a fully-built `RuntimeExecutionView`, but the route-decision producer must set `legacyTransportAlias` at decision time from a `RuntimeControllerKind` (+ broker-terminal hint) with no view in hand. So the function and the field are derivable from different, partly-overlapping inputs and there is no shared primitive. The fix is to extract the core mapping over `(controllerKind, brokerTerminalHost?)` and have *both* the view helper and the route-decision producer call it; the current signature guarantees the duplication the first pass hoped to remove.
- **Risk:** Low. **Effort:** ~30m (extract `transportAliasFor(kind, brokerTerminalHost?)`, re-point both sites).
