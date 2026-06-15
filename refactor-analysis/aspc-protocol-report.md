# 🔧 Refactoring Analysis — spaces-aspc-protocol

**Target:** packages/aspc-protocol/src · **Files read:** 4 (index.ts, types.ts, schemas.ts, validation-primitives.ts) + 1 test (test/schemas.test.ts) · **Lines:** 545 (src)
**Generated:** 2026-06-14 · **Package type:** leaf (pure protocol contract + hand-rolled validators, no I/O, no concurrency)

## 🧭 Summary
This is a small, already-disciplined contract package: the method set is a single tuple from which the type union, runtime predicate, and validator dispatch table are all derived; schemaVersion literals are named once; the validation-primitives layer is deliberately module-internal. Genuine mechanism-level findings are few and low-stakes. The highest-leverage observations concern (1) the public validator type-narrowing being unsound `as` casts (a make-illegal-states / make-safe gap, but a behavior-preserving characterization concern, not a structural defect), and (2) two minor de-abstraction / dead-export cleanups. No leaky or overbroad public boundary was found.

## 🚪 Public boundary (assess first)
- **API surface:** `index.ts` re-exports `* from types.js` and `* from schemas.js`. Public exports = the `ASPC_*` constants/types (protocol version, method tuple, request/response unions), the four `validateAspc*Request` / `validateAspcCommand` functions, and the `AspcValidationError` class hierarchy. `validation-primitives.ts` is intentionally NOT re-exported (internal helpers).
- **Findings:**
  - No fat/leaky interface: external consumer is `packages/aspc` (`facade.ts`, `client.ts`, `service.ts`, `profileSelector.ts`). It imports exactly the type union, `ASPC_PROTOCOL_VERSION`, and the four validators. No caller casts around the API or reaches past it — usage matches the surface (T07: no action).
  - `AspcCompileAndStartRequest = AspcCompileHarnessInvocationRequest` (type alias) and `validateAspcCompileAndStartRequest` simply re-calls the harness-invocation validator. This is a deliberate "same shape today, distinct name for future divergence" alias, consumed by name in `aspc/src/{client,service}.ts`. Collapsing it would be a public-surface change with no benefit — left alone (T16 where-NOT).
  - `coerceRecord` carries an `export` modifier in `validation-primitives.ts` but is used only by `requireRecord` in the same module and is not re-exported from `index.ts`, so it is not part of the public surface. Dead `export` keyword only (see Finding 3).
- **Verdict:** 🟢 sound — narrow, derived-from-one-source, matches actual usage.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. Public validators return via unchecked `as` casts after a structurally shallow check — [T40] Characterization tests / [T12] make illegal states unrepresentable (boundary)
- **Location:** `schemas.ts:88-121` (all four `validateAspc*Request`) and `schemas.ts:137-158` (`validateAspcCommand`); the shallow nested checks at `schemas.ts:219-238` (`validateRuntimeCompileRequest` only asserts `requireRecord` on `identity`/`placement`/`requested`/`materialization`/`hrcPolicy`/`correlation`, never their fields).
- **Mechanism repaired:** The validators promise a typed return (`AspcHelloRequest`, `AspcCompileRuntimePlanRequest`, etc.) but deliver it with `return value as AspcHelloRequest`. The runtime check is intentionally shallow (e.g. `compileRequest.identity` is only proven to be *an object*, not to have `requestId`), so the returned type over-claims what was verified. This is the protocol boundary's load-bearing safety property; the cast is the structural gap between "validated" and "typed".
- **Symptom that flagged it:** `as` cast immediately after issue-accumulation in every public validator; deep contract fields validated only one level deep.
- **Current → Suggested:** Do NOT tighten the runtime checks (that changes observable accept/reject behavior — a redesign, and the shallow depth is a deliberate delegation: `spaces-runtime-contracts` owns deep `RuntimeCompileRequest` validation). Instead, PIN the exact current accept/reject surface with characterization tests (which inputs pass, which throw, and the precise `issues[].path`/`code`/`message` produced) before any future change. The existing `test/schemas.test.ts` covers happy paths + a few rejections but does not pin, e.g., the depth boundary (that a `compileRequest` with a missing `requestId` inside a present `identity` object is *accepted*).
- **Direction:** isolate (lock behavior; do not change it).
- **Preservation:** char-test — adding tests changes nothing observable; it documents the deliberate shallow-validation contract so a later tightening is recognized as the redesign it is.
- **Falsifiable signal:** A test feeding `{compileRequest: {...valid, identity: {}}}` to `validateAspcCompileRuntimePlanRequest` currently returns without throwing; if a future edit makes it throw, the char-test goes red and flags the behavior change.
- **Risk:** Low · **API-impact:** public-surface (tests pin public behavior; no signature change) · **Effort:** S (a handful of boundary-pinning tests)
- **Tests:** add depth-boundary + per-method rejection-path characterization tests.
- **Contraindication:** Do not "fix" the casts by deep-validating here — depth is owned downstream by `spaces-runtime-contracts`; deepening would duplicate that contract and change accept/reject behavior.

### 2. `validateRuntimeCompileRequest` repeats `requireRecord(...)` for six sibling fields — [T15] extract missing abstraction (name the "these keys must each be objects" intent once)
- **Location:** `schemas.ts:232-237` — six near-identical lines: `requireRecord(request['identity'], path(basePath, 'identity'), issues)` … through `'correlation'`.
- **Mechanism repaired:** The recurring intent "this fixed set of sibling keys must each be present objects" is open-coded six times. A single named helper (`requireRecordFields(request, basePath, ['identity','placement','requested','materialization','hrcPolicy','correlation'], issues)`) names the concept once and makes the required-object key list a data declaration rather than copy-paste.
- **Symptom that flagged it:** Six structurally identical statements differing only in a string literal.
- **Current → Suggested:** Introduce a small loop helper in `validation-primitives.ts` (it is generic and ASPC-agnostic, matching that file's stated role) and call it once here. Behavior identical: same paths, same `required`/`invalid_type` codes, same per-field issues, same order (iterate the array in declared order).
- **Direction:** add (one helper) → remove (six inline calls).
- **Preservation:** type/compiler-proof + test-suite — issues produced are byte-identical when the array preserves field order; existing tests plus a quick order-equivalence check confirm.
- **Falsifiable signal:** Snapshot the `issues[]` array for a `compileRequest` missing several of the six fields before/after — must be identical (same paths, same order).
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S
- **Contraindication:** Only worthwhile because all six share the *exact* same check (require-object, no further per-field logic). If any field later needs field-specific validation it diverges back out — do not force unrelated checks through the helper.

### 3. `coerceRecord` exported but only consumed in-module and never re-exported — [T16] collapse premature abstraction (drop the unused `export`)
- **Location:** `validation-primitives.ts:54` (`export function coerceRecord`), sole caller `validation-primitives.ts:36`.
- **Mechanism repaired:** `coerceRecord`'s `export` advertises an external seam that does not exist — `index.ts` re-exports only `types`/`schemas`, and no file outside this module imports it. The `export` is dead reach. Dropping it (keep the function, drop the keyword) narrows the module's surface to what is actually used.
- **Symptom that flagged it:** `export` modifier with zero importers (grep across `src` + `test` shows only the in-file caller).
- **Current → Suggested:** `export function coerceRecord` → `function coerceRecord`. (Its doc-comment contrast with `requireRecord` stays valid.)
- **Direction:** remove (export modifier only).
- **Preservation:** type/compiler-proof — since nothing imports it, removing the keyword cannot break any caller; tsc proves no dangling import.
- **Falsifiable signal:** `bun run build` / tsc passes with no "module has no exported member 'coerceRecord'" error anywhere.
- **Risk:** Low · **API-impact:** internal-only (not on package public surface; validation-primitives is not re-exported) · **Effort:** XS
- **Contraindication:** If there is an intent to make validation-primitives a publicly-consumed helper layer later, this export is a deliberate option — but the file's own docstring explicitly says these are "intentionally module-internal (not re-exported from the package index)", so the export contradicts stated intent.

## 🪶 Deliberately left alone (where-NOT)
- **`ASPC_METHODS` tuple → `AspcMethod` / `isAspcMethod` / `ASPC_PARAMS_VALIDATORS` derivation** (`types.ts:34-41`, `schemas.ts:130-162`) — already the textbook single-source-of-truth + `Record<AspcMethod, ...>` dispatch table that fails compilation if a method is added without a validator. This is the ideal end-state of T19/T15; no action.
- **`AspcValidationError` abstract base + four concrete subclasses** (`schemas.ts:37-86`) — looks like a one-axis hierarchy, but each subclass carries a distinct `code` literal that consumers `instanceof`/branch on (test at `schemas.test.ts:162` asserts `AspcCommandValidationError`). Real, exercised variation — not premature abstraction. T16 where-NOT.
- **`validateOptionalPrimitiveRecord` parameterized over `'boolean' | 'string'`** (`schemas.ts:259-291`) — already the correct dedup of the boolean- and string-record validators, with the required scoped `// biome-ignore lint/suspicious/useValidTypeof` (line 269). The two thin wrappers are kept for readable call sites. Nothing to do.
- **`AspcCompileAndStartRequest` alias + `validateAspcCompileAndStartRequest` pass-through** (`types.ts:116`, `schemas.ts:119-121`) — distinct public name reserved for future divergence and consumed by name in `packages/aspc`; collapsing is a public-surface change with zero gain. T16/T23 where-NOT.
- **Shallow nested record checks in `validateRuntimeCompileRequest`** (`schemas.ts:219-238`) — deliberate delegation; deep `RuntimeCompileRequest` validation is owned by `spaces-runtime-contracts`. Deepening here would duplicate that contract and change behavior (redesign). See Finding 1.
- **`requireRecord` returning `undefined` + every caller early-returning on it** — this is total error handling (issue recorded, control flows on), not swallowed errors. T18 where-NOT.

## 🔭 If applying: outside-in sequence
1. Finding 1 first — add characterization tests pinning the current accept/reject + issue-path surface (make-safe before touching anything). This protects Findings 2–3.
2. Finding 3 — drop the dead `export` on `coerceRecord` (XS, compiler-proven).
3. Finding 2 — extract `requireRecordFields` helper and replace the six inline calls; verify issue-array equivalence against the new char-tests.
4. Re-run `bun test` for the package and `aspc` (sole consumer) to confirm no downstream drift.

## ✅ Safety checklist
- [ ] Characterization tests added/green before any edit (Finding 1) — pins shallow-validation depth + per-method rejection paths.
- [ ] `coerceRecord` export removal: tsc/build clean, no dangling import in src or test (Finding 3).
- [ ] `requireRecordFields` extraction preserves field iteration order → identical `issues[]` (paths, codes, order) (Finding 2).
- [ ] No change to runtime accept/reject behavior (all three findings are behavior-preserving; deepening validation is explicitly OUT of scope as a redesign).
- [ ] `packages/aspc` consumer test suites (`facade.test.ts`, `service.test.ts`) still green — confirms public surface untouched.
- [ ] biome lint clean (the existing scoped `// biome-ignore useValidTypeof` at schemas.ts:269 is retained; no new parameterized-typeof introduced).
