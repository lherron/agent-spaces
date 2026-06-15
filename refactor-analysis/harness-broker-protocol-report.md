# 🔧 Refactoring Analysis — spaces-harness-broker-protocol

**Target:** packages/harness-broker-protocol/src  ·  **Files read:** 15 (+5 test files read for contract)  ·  **Lines:** 3989
**Generated:** 2026-06-14  ·  **Package type:** leaf (pure protocol DTOs + hand-rolled validators; no I/O beyond NDJSON framing + sha256 hash)

## 🧭 Summary
This is a wire-contract package: type declarations plus accumulating (non-throwing-internally) validators that gate every broker JSON-RPC command, event envelope, and lifecycle overlay. It has already absorbed most "extract more" refactors — per-method/per-event dispatch tables (T19), an extracted `validation-primitives` module, a `ProtocolError`/`ProtocolValidationError` base, and a compile-time exhaustiveness guard against `commands.ts`/`events.ts`. The remaining leverage is small and mostly about *consistency* of the validator vocabulary and one fat structural type (`SchemaRecord`). The public surface is broad but well-characterized by a 1228-line `schemas.test.ts`.

## 🚪 Public boundary (assess first)
- **API surface:** `index.ts` re-exports everything (`export *`) from 11 modules. Runtime exports: the 7 `validate*` functions, the error classes + `BrokerErrorCode` enum, `createJsonRpcError*`, JSON-RPC type-guards + `parseJsonRpcMessage`, `NdjsonDecoder`/`encodeNdjsonFrame`, env-key predicates + constants, tmux-id patterns/validators (transitively via `export *`? — see below), lifecycle hash/normalize helpers, and `SUPPORTED_BROKER_PROTOCOL_VERSIONS`. Plus a large set of pure type/interface DTOs.
- **Findings:**
  - `SchemaRecord` is **exported** (used by `aspc-protocol` mirror and `validation-primitives`) yet is a 130-key fat optional-record (T07). It is leaky by construction — every consumer sees an index of every field name the validators happen to touch.
  - `validation-primitives` and `tmux-ids` are documented "not part of the public surface" but `index.ts`'s `export *` from `schemas` re-exports `SchemaRecord`/`ValidationIssue` and the env-keys module wholesale; the tmux-id helpers are NOT re-exported (no `export * from './tmux-ids'`), so that boundary is already correct.
  - No fat-vs-actual-usage casting was observed in the validators themselves; callers consume the `validate*` return types, not `SchemaRecord`.
- **Verdict:** 🟡 needs care — surface is sound and well-tested, but `SchemaRecord`'s shape is an accidental public artifact that should be narrowed via Expand/Contract, not edited in place.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. `SchemaRecord`'s 130-key optional index is a leaked internal scratch type — [T07] Align interface to actual usage / [T16] Collapse premature abstraction
- **Location:** `schemas.ts:66-196` (definition); re-exported via `index.ts:11`
- **Mechanism repaired:** A type whose only purpose is "a record the hand-rolled validators index into" has been frozen into the public contract with an exhaustive (and perpetually-drifting) list of every field name any validator reads. Every new validated field grows the public type; consumers (`aspc-protocol` keeps its own parallel copy) gain a spurious dependency on the union of all field names.
- **Symptom that flagged it:** 130 `field?: unknown` lines that must be hand-maintained in lockstep with the validator bodies; an independent duplicate in `aspc-protocol/src/schemas.ts`.
- **Current → Suggested:** The validators only ever read `record[key]` after an `asRecord` guard. `SchemaRecord = Record<string, unknown>` (an index signature) is behaviorally identical for every internal access (`record.foo` / `record['foo']` both resolve to `unknown`). The enumerated keys add zero validation strength. Narrow to `Record<string, unknown>` (optionally `& Record<string, unknown>` kept exported for source-compat), removing the 130-line manifest. Route through **Expand/Contract** because it is exported and mirrored cross-package.
- **Direction:** remove (de-abstract the enumerated key list)
- **Preservation:** type/compiler-proof — `record['anyKey']` is `unknown` under both the enumerated form and a bare index signature; no runtime code changes. Risk is purely that an *external* consumer relies on autocomplete/excess-property behavior of the named keys.
- **Falsifiable signal:** after replacing with `Record<string, unknown>`, `bun run build` + `check:manifests` across the workspace (esp. `aspc-protocol`, `harness-broker`) compiles unchanged; `schemas.test.ts` passes.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** S (delete a block; re-verify cross-pkg compile)
- **Tests:** existing `schemas.test.ts` (whole-surface char tests) + workspace typecheck.
- **Contraindication:** if any consumer destructures `SchemaRecord` with excess-property checks or relies on the named keys for editor ergonomics, the enumerated form is load-bearing DX — confirm via grep before contracting. The parallel `aspc-protocol` copy must be migrated in the same Expand/Contract wave.

### 2. Enum/literal checks via `.includes(String(x))` diverge from the validator vocabulary — [T15] Extract missing abstraction (name the "validate a required string literal-set" concept once)
- **Location:** `schemas.ts:1733` (`harnessTransport.kind`), `schemas.ts:1768` (`interaction.mode`), `schemas.ts:1783-1785` (`interaction.inputQueue`)
- **Mechanism repaired:** Three sites re-implement enum validation with `!['a','b'].includes(String(value))` while the rest of the file uses the extracted `optionalEnum(value, allowed, path, issues, required)`. The `String(value)` coercion changes observable behavior vs `optionalEnum`: a missing `interaction.mode` (`undefined`) coerces to the string `"undefined"`, fails `.includes`, and emits `invalid_literal` — whereas the file's own convention (`optionalEnum(..., required=true)`) would emit `required`. The duplicated intent ("this field must be one of these literals, and is required when its parent object is present") is expressed in two incompatible dialects.
- **Symptom that flagged it:** identical-intent code written two ways; `String()` coercion only at these three sites.
- **Current → Suggested:** replace each with `optionalEnum(value, [...], path, issues, /*required*/ true)` (for `mode`) and `optionalEnum(value, [...], path, issues)` (for the genuinely-optional `inputQueue`). This is a **redesign, not a pure refactor**, because the emitted issue `code` changes (`invalid_literal`→`required`) when the field is absent. Flag as such; route via Expand/Contract / explicit char-test update.
- **Direction:** relocate (onto the shared `optionalEnum` primitive)
- **Preservation:** char-test — NOT observationally equivalent for the missing-field case; the issue `code` and `message` change. Must update `schemas.test.ts` expectations and confirm no consumer matches on the old `invalid_literal` code for a missing `interaction.mode`.
- **Falsifiable signal:** before/after diff of emitted `ValidationIssue[]` for `{ interaction: {} }` — codes will differ. That diff IS the behavior change to ratify.
- **Risk:** Med  ·  **API-impact:** public-surface (error `code`/`message` are observable contract)  ·  **Effort:** S
- **Tests:** add a char test pinning the issue for `interaction.mode` missing vs wrong-typed BEFORE editing.
- **Contraindication:** if any downstream branches on the exact `invalid_literal` code for these paths, the current behavior is load-bearing — keep the `String()` form (or migrate consumers first). Treat as redesign, not auto-applicable.

### 3. `validateEnv` recomputes `asRecord(lockedEnv)` three times — [T22] Guard clause / hoist the computed value
- **Location:** `schemas.ts:1685-1687`
- **Mechanism repaired:** `new Set(asRecord(lockedEnv) ? Object.keys(asRecord(lockedEnv) as SchemaRecord) : [])` calls `asRecord(lockedEnv)` twice in one expression (and the cast re-asserts what the guard already proved). Pure local clarity; no structural cause beyond a missed temporary.
- **Symptom that flagged it:** duplicated subexpression + redundant `as SchemaRecord`.
- **Current → Suggested:** `const lockedRecord = asRecord(lockedEnv); const lockedEnvKeys = new Set(lockedRecord ? Object.keys(lockedRecord) : [])`.
- **Direction:** isolate (hoist temp)
- **Preservation:** observational-equivalence — identical key set; `asRecord` is pure.
- **Falsifiable signal:** `schemas.test.ts` dispatchEnv-shadow cases unchanged.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** XS
- **Tests:** existing dispatchEnv shadow char tests.
- **Contraindication:** none.

### 4. `harness.exited` payload's `exitCode !== null` guard is an idiosyncratic null-handling shim — [T17] Partial → total / clarify the optional-nullable contract
- **Location:** `schemas.ts:1367-1369`
- **Mechanism repaired:** `if (payload['exitCode'] !== null) { optionalNumber(payload['exitCode'], ...) }` hand-rolls "accept `null` OR number OR undefined" because `optionalNumber` rejects `null`. The DTO (`HarnessExitedPayload.exitCode?: number | null | undefined`, `lifecycle.ts:138`) genuinely allows `null`, but the validator vocabulary has no `optionalNumberOrNull` primitive, so this one site improvises. Other nullable-number fields in DTOs (e.g. `InvocationExitedPayload.exitCode`, `process.exitCode`) are not validated at all, so the inconsistency is invisible elsewhere — but the improvised guard is the kind of one-off that drifts.
- **Symptom that flagged it:** a bespoke inline `!== null` ahead of a primitive that the primitive itself should express.
- **Current → Suggested:** introduce `optionalNumberOrNull(value, path, issues)` in `validation-primitives.ts` and call it here; names the "exit-code-shaped nullable number" concept once for future event payloads (`signal` is string-or-null with the same gap).
- **Direction:** add (a primitive) then relocate the inline guard onto it
- **Preservation:** observational-equivalence — same accept/reject set (`null`/number/undefined pass; other types fail with `invalid_type`).
- **Falsifiable signal:** char test: `harness.exited` payload with `exitCode: null`, `exitCode: 0`, `exitCode: "x"` produce the same issue sets before/after.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** add the three-case char test first (verify `exitCode: "x"` currently emits `invalid_type` — it does, via `optionalNumber`).
- **Contraindication:** if no second nullable-number field will ever be validated, this is borderline speculative abstraction (T15 contra); the value is consistency, not reuse. Keep it minimal (one primitive) or leave as-is.

### 5. `requestedAction` enum validated with inconsistent `required` flag across two sites — [T15] name the shared optional-action concept consistently
- **Location:** `schemas.ts:1327-1333` (`lifecycle.escalation`, `required=true`) vs `schemas.ts:1403` (`harness.recovery.failed`, no `required` arg → optional)
- **Mechanism repaired:** Both validate `requestedAction` against a `['hard-reap', ...]` literal set, but `lifecycle.escalation` marks it required (DTO: `LifecycleEscalationPayload.requestedAction: 'hard-reap' | 'operator-attention'` — non-optional) while `harness.recovery.failed` leaves it optional (DTO: `HarnessRecoveryFailedPayload.requestedAction?: 'hard-reap' | undefined`). This is actually CORRECT against the two DTOs — the asymmetry mirrors the types. Recorded here only to mark it as **deliberate**, not a bug, so a future "make them consistent" edit does not silently tighten the optional one.
- **Symptom that flagged it:** same field name, different `required` argument.
- **Current → Suggested:** no change. (Documenting the where-NOT.)
- **Direction:** none
- **Preservation:** n/a
- **Falsifiable signal:** n/a
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** none
- **Tests:** n/a
- **Contraindication:** **This is the contraindication** — the difference is load-bearing (matches the discriminated-union DTOs in `lifecycle.ts`). Do NOT "harmonize."

### 6. `validateInvocationStartRequest` and `validateInvocationDispatchRequestShape` duplicate the startRequest spec/initialInput/stale-runtime sequence — [T15] Extract missing abstraction (name "validate a startRequest")
- **Location:** `schemas.ts:301-317` (`validateInvocationStartRequest`) and `schemas.ts:681-697` (inside `validateInvocationDispatchRequestShape`)
- **Mechanism repaired:** Both walk `{ spec → validateSpec, initialInput? → validateInvocationInputShape, then rejectStaleStartRequestRuntime }`. The dispatch path nests it under a `startRequest` record guard; the top-level start-request path applies it directly. The shared INTENT ("a start-request body is a spec + optional initialInput with no stale runtime/lifecycle overlay") is expressed twice.
- **Symptom that flagged it:** the same three-call sequence with matching path prefixes appears in two validators.
- **Current → Suggested:** extract `validateStartRequestBody(record, basePath, issues)` and call it from both. The top-level validator passes `''`/`'spec'`-style paths; the dispatch path passes `startRequest`-prefixed paths — so the helper must take the spec subpath as a parameter (data clump). Modest payoff because the two callers differ in path prefixing and in whether the record guard is theirs or the helper's.
- **Direction:** relocate (dedup into a named helper)
- **Preservation:** observational-equivalence — identical issue paths/codes if the path arguments are threaded exactly; verify the empty-prefix vs `startRequest`-prefix forms still produce the same `ValidationIssue.path` strings.
- **Falsifiable signal:** `schemas.test.ts` start-request AND dispatch-request stale-overlay/initialInput cases produce byte-identical issue arrays.
- **Risk:** Med  ·  **API-impact:** internal-only (issue paths are observable, so treat output as contract)  ·  **Effort:** S
- **Tests:** the existing 9 dispatch + 4 start-request char cases; add an explicit stale-`runtime`-on-startRequest case for both entry points if not already pinned.
- **Contraindication:** the two sites differ in path construction; if threading the prefix makes the helper signature uglier than the duplication, the duplication is the cleaner local optimum (coincidental-structure contra). Verify the path strings are truly identical first — a single mismatched prefix is a behavior change to the error contract.

## 🪶 Deliberately left alone (where-NOT)
- **Per-method / per-event dispatch tables** (`COMMAND_PARAM_VALIDATORS`, `EVENT_PAYLOAD_VALIDATORS`, `HARNESS_RECOVERY_MODE_VALIDATORS`) — already the T19 dispatch form; no further structure warranted. `broker.health`'s separate branch ahead of the record guard is correct (it legitimately permits `params === undefined`); inlining it back would break that case.
- **Compile-time exhaustiveness guards** (`AssertExhaustive`, `BROKER_METHODS`/`EVENT_TYPES` tuples) — load-bearing drift protection against `commands.ts`/`events.ts`; the apparent "duplication" of the union as a tuple is the mechanism, not a smell.
- **`validation-primitives.ts` primitives** — already the extracted T15 abstraction; the `requireArray` `message` parameter (one caller wants a fixed literal) is documented and correct.
- **`ProtocolError` / `ProtocolValidationError` base hierarchy** — already collapses the constructor boilerplate; the per-subclass `readonly code` is the stable wire contract, not redundancy.
- **`canonicalizeJson` in `lifecycle.ts`** — hand-rolled deterministic JSON for the policy hash; intentionally independent of `JSON.stringify` key order. Load-bearing for hash stability; do not replace with a library.
- **Env-key predicate constants** (`AMBIENT_ENV_KEYS` etc.) — cross-package POLICY consumed by the broker runtime; the sets are intentional security boundaries (defense-in-depth), not magic-list smells.
- **`requestedAction` required-flag asymmetry** (finding #5) — matches the discriminated-union DTOs; harmonizing would change behavior.
- **`PermissionPolicy = DriverPermissionPolicy` alias** (`invocation.ts:315`) — a deliberate public re-name consumed by `agent-spaces` and `harness-broker`; not a middle-man to collapse.
- **NDJSON / JSON-RPC modules** — small, total, well-tested; the `Result`-shaped `NdjsonFrameResult` (ok/error union) is the correct T18 error-as-value form for a streaming decoder.

## 🔭 If applying: outside-in sequence
1. **Finding #1 (`SchemaRecord` contract)** — highest leverage but public; do FIRST via Expand/Contract (introduce `Record<string,unknown>` form, migrate `aspc-protocol`'s parallel copy, then contract). Do not auto-apply.
2. **Finding #2 (`String()` enum checks)** — redesign (error-code change); pin the missing-field issue codes with char tests, change codes deliberately, ratify the diff. Do not auto-apply.
3. **Finding #6 (startRequest dedup)** — internal but error-path-observable; verify path strings, then extract.
4. **Findings #3, #4** — Low-risk internal cleanups; safe to auto-apply behind the existing char suite.
5. **Finding #5** — no-op (documented contraindication).

## ✅ Safety checklist
- [ ] `schemas.test.ts` (whole public surface, 1228 lines) green before and after each change.
- [ ] Workspace `bun run build` + `check:manifests` clean (cross-pkg `aspc-protocol`, `harness-broker`, `agent-spaces`, `spaces-runtime-contracts` all compile).
- [ ] For #1/#2: confirm no external consumer branches on `SchemaRecord`'s named keys or on the `invalid_literal` issue code for missing `interaction.mode`/`harnessTransport.kind` before contracting.
- [ ] For #2: the emitted `ValidationIssue.code` change (`invalid_literal`→`required`) is intentional and documented as a redesign, not a refactor.
- [ ] For #6: byte-compare emitted `ValidationIssue[]` (paths + codes) before/after for both start-request and dispatch entry points.
- [ ] No spread/projection changes introduced (validators never reshape objects — they only read; preserve that).
