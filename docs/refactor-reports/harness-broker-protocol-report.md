# 🔧 Refactoring Analysis

**Target:** `packages/harness-broker-protocol/src`
**Lines analyzed:** 3617 (14 TypeScript files; `schemas.ts` is 1925)
**Generated:** 2026-06-01  ·  **Focus:** all (SRP, OCP, LSP, ISP, DIP)

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🔴 | `schemas.ts` (1925 lines) bundles ~8 error classes, the public `SchemaRecord` god-type, 6 entry validators, 25+ shape validators, env policy re-export, and tmux-id regex policy in one file. `validateEventPayload` is ~339 lines / 27 cases. |
| Open/Closed | 🔴 | Two parallel hand-maintained dispatch tables (`validateCommandParams` switch, `validateEventPayload` switch) plus duplicated `Set` registries (`brokerMethods`, `eventTypes`) that must be edited in lock-step with the type unions every time a method or event is added. |
| Liskov Substitution | 🟢 | No class hierarchies with overrides; error subclasses are flat and uniform. No `throw "not implemented"` / no-op overrides. |
| Interface Segregation | 🟡 | `SchemaRecord` is a ~130-member optional grab-bag every validator depends on; `InvocationCapabilities` is a deep multi-section fat interface. Mostly DTOs, so impact is bounded, but the `SchemaRecord` mega-type couples unrelated validators. |
| Dependency Inversion | 🟡 | `validateLifecyclePolicyOverlay` reaches into a concrete `lifecyclePolicyHash` (sha256/crypto) instead of an injected hasher; tmux id regex policy is hardcoded inline. No collaborator `new`-ing in this pure package, so severity is moderate. |

## 🎯 Priority Refactorings

### 1. `schemas.ts` is a 1925-line multi-responsibility module — SRP
- **Location:** `schemas.ts:1-1926` (whole file)
- **Current:** One file holds: 8 `*ValidationError` classes (`schemas.ts:45-120`), the `SchemaRecord` god-type (`schemas.ts:122-249`), two registry `Set`s (`schemas.ts:251-306`), 6 public entry validators (`schemas.ts:308-409`), ~20 private shape validators, env re-export (`schemas.ts:16-22`), and tmux-id regexes (`schemas.ts:989-991`). Three distinct domains are interleaved: spec validation, command/param validation, and event-envelope/payload validation.
- **Suggested:** Split by domain into sibling modules that re-export through `schemas.ts` to preserve the public surface (the pattern already used for `env-keys.ts` and `validation-primitives.ts`): `errors.ts` (the 8 error classes — note a separate `src/errors.ts` already exists and should absorb these), `validate-spec.ts`, `validate-commands.ts`, `validate-events.ts`, and `tmux-ids.ts` (regexes + `validateTmuxId` helper). Keep `schemas.ts` as a thin barrel.
- **Risk:** Low (pure moves; behavior-preserving, mirrors prior `env-keys`/`validation-primitives` extractions)  ·  **Effort:** ~3-4h  ·  **Tests:** Run `bun run test` for this package + `bun run typecheck`; the existing `test/` suite plus the golden fixtures under `src/fixtures/codex-app-server/` should pass unchanged.

### 2. `validateEventPayload` — 339-line, 27-case switch — SRP + OCP
- **Location:** `schemas.ts:1218-1557`
- **Current:** A single function with a giant `switch (eventType)`; each case inlines its own field checks (lifecycle, harness, recovery, turn, terminal-surface, permission). Adding an event type means editing this switch AND the `eventTypes` Set (`schemas.ts:267-306`) AND the `InvocationEventType` union (`events.ts:43-81`) — three edit sites.
- **Suggested:** Replace the switch with a `Record<InvocationEventType, (payload, issues, ctx) => void>` validator registry, one small named function per payload (e.g. `validateTurnStalledPayload`). A `satisfies Record<InvocationEventType, …>` annotation makes the compiler enforce exhaustiveness, collapsing the three-site edit into a typed table and making each payload validator independently testable.
- **Risk:** Med (touches the hottest validation path; mitigated by golden fixtures)  ·  **Effort:** ~4-6h  ·  **Tests:** Event-envelope validation tests + `basic-events.golden.jsonl`.

### 3. Duplicated registries vs. type unions — OCP
- **Location:** `schemas.ts:251-265` (`brokerMethods`), `schemas.ts:267-306` (`eventTypes`) mirror `commands.ts:26-46` (`BrokerMethod*`) and `events.ts:43-81` (`InvocationEventType`).
- **Current:** The runtime `Set`s are hand-maintained copies of compile-time unions. They silently drift if one is updated without the other — a new method/event can typecheck while being rejected at runtime (or vice versa).
- **Suggested:** Derive one from the other. Define the canonical list as a `const` tuple (`as const`), derive the union via `typeof LIST[number]`, and build the `Set` from the same tuple. Single source of truth eliminates drift.
- **Risk:** Low  ·  **Effort:** ~1-2h  ·  **Tests:** `validateCommand` / `validateEventEnvelope` unknown-method/type tests.

### 4. `SchemaRecord` god-type — ISP
- **Location:** `schemas.ts:122-249`
- **Current:** A ~130-key all-optional `Record<string, unknown> &` type listing every field name across every DTO in the protocol. Every validator and every primitive in `validation-primitives.ts` depends on this single sprawling type, so any field rename ripples widely and the type documents nothing about which validator needs which field.
- **Suggested:** Replace with a plain `Record<string, unknown>` (or a small `UnknownRecord` alias) in `validation-primitives.ts`, and let each shape validator narrow locally via `asRecord(...)`. The named-key catalog adds no real type safety (everything is `unknown`) while creating a wide coupling surface.
- **Risk:** Med (touched by many call sites; purely typing-level, no runtime change)  ·  **Effort:** ~2-3h  ·  **Tests:** `bun run typecheck` is the gate; no runtime tests affected.

### 5. Triplicated tmux-id validation block — DRY / SRP
- **Location:** `schemas.ts:1131-1161` (inside `validateTerminalSurfaceLease`) vs. `schemas.ts:1458-1499` (inside `validateEventPayload` `terminal.surface.reported` case)
- **Current:** The `terminalSurface` lease validates `sessionId`/`windowId`/`paneId` against the three regexes via a local `validateTmuxId` closure; the `terminal.surface.reported` payload re-implements the same three required-string + regex-test checks inline by hand (sessionId/windowId/paneId), ~42 lines of near-identical copy.
- **Suggested:** Extract a shared `validateTmuxId(value, fieldPath, pattern, issues)` (and a `{ sessionId, windowId, paneId }` group helper) into a `tmux-ids.ts` module; call it from both sites. Removes the copy and keeps the id-shape contract in one place.
- **Risk:** Low  ·  **Effort:** ~1h  ·  **Tests:** Terminal-surface lease + `terminal.surface.reported` validation tests.

### 6. Lifecycle-policy validators are long, mode-keyed branchers — SRP + OCP
- **Location:** `validateHarnessRecoveryPolicy` (`schemas.ts:777-868`, ~91 lines), `validateTurnRetryPolicy` (`schemas.ts:900-979`, ~79 lines), `validateRuntimeRetentionPolicy` (`schemas.ts:738-775`), `validateStallDetectionPolicy` (`schemas.ts:870-898`)
- **Current:** Each validator switches on `policy.mode` and inlines the per-mode required-field checks; `validateHarnessRecoveryPolicy` nests `recycle` boolean checks 4 levels deep (`schemas.ts:834-858`). These mode unions mirror the discriminated unions in `lifecycle.ts:7-73`, so each new mode is another multi-site edit.
- **Suggested:** Split per-mode validators (`validateRecycleChildRecovery`, `validateFailAndEscalateRecovery`) keyed by a small `Record<mode, validator>` table, mirroring finding #2. Reduces nesting and isolates each mode's contract.
- **Risk:** Low-Med  ·  **Effort:** ~3h  ·  **Tests:** Lifecycle-policy-overlay validation tests + `lifecyclePolicyHash` mismatch path (`schemas.ts:719-735`).

### 7. Hash collaborator hardcoded into the validator — DIP
- **Location:** `schemas.ts:695-736` (`validateLifecyclePolicyOverlay` calls `lifecyclePolicyHash`), `lifecycle.ts:225-229` (sha256 via `node:crypto`)
- **Current:** The validator imports the concrete `lifecyclePolicyHash` (sha256/`createHash`) directly and recomputes the canonical hash inline to compare against `policyHash`. The crypto dependency is baked into the validation module with no seam to substitute (e.g. for a faster test hasher or an alternative algorithm).
- **Suggested:** Accept an optional `computeHash` parameter (defaulting to `lifecyclePolicyHash`) on the overlay validator, or pass a verification options object. Keeps the default behavior while introducing an injection seam.
- **Risk:** Low  ·  **Effort:** ~1h  ·  **Tests:** Policy-hash-mismatch validation test.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| God file (1925 lines, multiple domains) | `schemas.ts` (whole) | 🟠 |
| Long method (~339 lines, 27-case switch) | `schemas.ts:1218-1557` `validateEventPayload` | 🟠 |
| Long method (~91 lines, deep nesting) | `schemas.ts:777-868` `validateHarnessRecoveryPolicy` | 🟠 |
| Long method (~98 lines) | `schemas.ts:1089-1187` `validateTerminalSurfaceLease` | 🟡 |
| Long method (~87 lines, switch) | `schemas.ts:530-617` `validateCommandParams` | 🟡 |
| Deep nesting (≥4 levels) | `schemas.ts:834-858` (recycle boolean checks) | 🟡 |
| Duplicated tmux-id validation block | `schemas.ts:1131-1161` vs `1458-1499` | 🟠 |
| God-type with ~130 optional members | `schemas.ts:122-249` `SchemaRecord` | 🟠 |
| Registry `Set` duplicates type union (drift risk) | `schemas.ts:251-306` vs `commands.ts`/`events.ts` | 🟠 |
| Repeated error-class boilerplate (8 near-identical classes) | `schemas.ts:45-120` | 🟡 |
| Inline magic literals (spec/schema version strings) repeated | `schemas.ts:418`, `707`, `1.x` enum lists scattered | 🟡 |
| Swallowed error in hash compare (`try { } catch { expected = undefined }`) | `schemas.ts:719-725` | 🟡 |
| Long boolean-policy block re-implemented per field | `schemas.ts:834-858`, `850-858` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. **Derive registries from `as const` tuples** (finding #3) — removes a real drift hazard between runtime `Set`s and the type unions in ~1-2h.
2. **Extract `validateTmuxId` and dedupe the two tmux-id blocks** (finding #5) — ~42 lines of copy collapse to one helper.
3. **Move the 8 `*ValidationError` classes out of `schemas.ts`** into the existing `src/errors.ts` (currently 46 lines) and re-export — pure mechanical move, shrinks the god file immediately.
4. **Factor the repeated error-class shape** (`code` + `issues` + `super(message)`) into a small `ProtocolValidationError` base or a `defineValidationError(code, name, message)` factory (`schemas.ts:45-120`).

## ⚠️ Technical Debt Notes

- The package is a wire-protocol contract package: every change here is a **published cross-repo boundary** (per CLAUDE.md, this is one of the 10 publishable boundary packages with a `prepack` strip step). The refactorings above are intentionally surface-preserving — `index.ts` (`index.ts:1-11`) and `schemas.ts`'s `export *` must keep exporting the same symbols, and golden fixtures under `src/fixtures/codex-app-server/` are the regression safety net.
- Migration scaffolding is accumulating: `runtime.tmux.socketPath` (LEGACY) vs `runtime.terminalSurface` (NEW) is dual-accepted (`schemas.ts:993-1081`, `commands.ts:102-150`), and `tmux-session` vs `tmux-pane` payload kinds coexist (`events.ts:279-308`). Once the Phase C/D flip lands, the legacy branches are dead-code-removal candidates — track and prune to stop the validators from growing.
- `validateEventPayload` and the lifecycle validators each shadow a discriminated union from `events.ts`/`lifecycle.ts`. The hand-rolled validator and the type will drift unless converted to a typed registry with `satisfies Record<…>` exhaustiveness (findings #2, #6).
- The hand-rolled validation approach (no schema library) is a deliberate zero-dependency choice for a boundary package; the recommendations preserve it (table-driven, not library-driven) rather than introducing a runtime schema dependency.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (`bun run test` in this package + golden fixtures under `src/fixtures/`)
- [ ] Confirm public surface unchanged: `bun run typecheck`, `bun run check:manifests`, and the cross-repo pack smoke (`bun scripts/smoke-pack-cross-repo.ts`) since this is a published boundary package
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run tests between each (start with quick wins #1-#3, which are mechanical)
- [ ] Keep `index.ts` `export *` and `schemas.ts` re-exports stable; verify no symbol disappears from the published entrypoint
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

The first pass was thorough on `schemas.ts` (SRP/OCP/ISP/DIP of the validator god-file). This pass deliberately re-examined the *other* modules — `ndjson.ts`, `jsonrpc.ts`, `lifecycle.ts`, `validation-primitives.ts`, `env-keys.ts` — plus the test suite, looking for correctness/async/edge-case/test-gap issues the first pass did not touch. The first report had **zero** findings outside `schemas.ts`; everything below is net-new.

### A1. `NdjsonDecoder.push` corrupts multi-byte UTF-8 split across chunks — Correctness (highest priority)
- **Location:** `ndjson.ts:24`
- **Current:** `this.#buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)`. A **fresh** `TextDecoder` is constructed per `push()` and `decode(chunk)` is called *without* `{ stream: true }`. When a multi-byte UTF-8 codepoint (any non-ASCII char, e.g. an emoji or accented letter in a prompt/argv/diagnostic string) straddles a chunk boundary — which is normal on a real stdio/socket transport — the trailing partial bytes at the end of one chunk and the leading bytes of the next are each decoded in isolation, yielding U+FFFD replacement characters. That mangles the JSON, which then either fails `JSON.parse` (spurious `NdjsonFrameError`) or, worse, silently corrupts a valid-but-wrong string field. This is a real wire-protocol bug, not a style issue — and this decoder is the single ingress point for every broker frame.
- **Suggested:** Hold one long-lived `TextDecoder` instance (field on the class) and decode with `decoder.decode(chunk, { stream: true })`, calling a final `decode()` (no stream flag) in `flush()` to drain any trailing partial sequence. This makes the decoder correctly streaming across chunk boundaries.
- **Risk:** Low (localized) · **Effort:** ~1h · **Tests:** Add a test that pushes a multi-byte char split across two `push()` calls at the byte boundary (none exists today — see A5).

### A2. `NdjsonDecoder` has an unbounded internal buffer — DoS / resource-safety
- **Location:** `ndjson.ts:21-41` (`#buffer` accumulation), no max-line guard
- **Current:** `push()` appends every chunk to `#buffer` and only ever slices on `\n`. A peer that streams a very large line (or never sends a newline) grows `#buffer` without bound until the process OOMs. For a boundary protocol package framing untrusted stdio/socket input, a max-frame/max-buffer limit is a standard NDJSON-decoder safeguard that is absent here.
- **Suggested:** Add an optional `maxLineBytes` (constructor option) and emit a single terminal `NdjsonFrameError` (and reset/abort) when the buffer exceeds it without a newline, instead of accumulating indefinitely.
- **Risk:** Low · **Effort:** ~1-2h · **Tests:** Oversized-line rejection test.

### A3. `canonicalizeJson` treats `undefined`/`function`/`symbol` asymmetrically between array elements and object values — hash-stability subtlety
- **Location:** `lifecycle.ts:243-272` (`canonicalizeJson`), specifically the array branch (`:258`) vs. the object branch (`:266-269`)
- **Current:** Top-level/array-element `undefined`, `function`, and `symbol` all serialize to the literal string `'null'` (`:254-256`, and arrays map through `canonicalizeJson` at `:258`). But inside an object, **only** `undefined` values are *skipped* (`:268 if (child === undefined) continue`) — a `function`/`symbol` object value is NOT skipped and falls through to `canonicalizeJson(child) === 'null'`, emitting `"key":null`. So `{a: undefined}` → `{}` while `[undefined]` → `[null]`, and `{a: someFn}` → `{"a":null}`. This mirrors `JSON.stringify`'s own asymmetry, but here it is the input to a **policy hash** used for cross-process integrity checks (`lifecyclePolicyHash`, compared in `validateLifecyclePolicyOverlay`). Any path that can route a non-finite-but-present field, a `function`, or an inconsistent `undefined` through this produces a hash that two implementations could disagree on. Since lifecycle DTOs are typed with `prop?: T | undefined` everywhere, `undefined` object values are routine — the skip is load-bearing and the divergent function/symbol handling is latent.
- **Suggested:** Normalize the policy: reject (throw) on `function`/`symbol` the same way non-finite numbers are rejected (`:250`), rather than silently coercing to `null`; and document/test the `undefined`-skip contract explicitly. A stricter "no non-JSON values in hash material" invariant removes the ambiguity for a security-relevant hash.
- **Risk:** Low-Med (touches the canonical hash — behavior change only on malformed input) · **Effort:** ~2h · **Tests:** None today directly exercise `canonicalizeJson` edge cases (see A5).

### A4. `isJsonRpcResponse` is a public type guard that accepts `result: undefined` — leaky contract
- **Location:** `jsonrpc.ts:110-125`
- **Current:** The guard uses `Object.hasOwn(value, 'result')` (`:118`) to decide a message is a result-response, never checking that the value is non-`undefined`. On the `parseJsonRpcMessage` path this is safe (JSON cannot yield `undefined`), but `isJsonRpcResponse` is **exported** (`index.ts:7` re-exports it) and usable as a standalone guard on arbitrary in-memory objects. `{ jsonrpc: '2.0', id: '1', result: undefined }` passes as a valid `JsonRpcResultResponse` while having no result. Same shape issue: `isJsonRpcRequest`/`isJsonRpcNotification` key off `typeof method === 'string'` but `parseJsonRpcMessage` does not enforce that a request's `method` is non-empty (empty-string method is accepted).
- **Suggested:** For the exported guards, treat `hasResult` as `value.result !== undefined` (or document that the guards assume JSON-parsed input). Optionally reject empty-string `method`. Low blast radius but tightens an exported contract on a boundary package.
- **Risk:** Low · **Effort:** ~30m · **Tests:** Add `{result: undefined}` and empty-`method` guard cases.

### A5. Test gaps: `flush()`, streaming UTF-8, and `canonicalizeJson` edge cases are uncovered — Test gap
- **Location:** `test/ndjson.test.ts` (no `flush` case), `test/jsonrpc.test.ts` (no `{result:undefined}`/empty-method case), no test importing `canonicalizeJson` / `normalizeLifecyclePolicyOverlay` round-trip on non-finite or `undefined` fields
- **Current:** `NdjsonDecoder.flush()` (`ndjson.ts:43-51`) — the path that drains a final newline-less frame on stream end — has **zero** tests; `grep` over `test/` shows no `flush` reference. The multi-byte-split scenario (A1) and the unbounded-buffer scenario (A2) are likewise untested, so the A1 corruption bug ships green. `canonicalizeJson`'s array-vs-object asymmetry (A3), its non-finite `RangeError` throw (`lifecycle.ts:250`), and key-sort determinism are only exercised indirectly via `lifecyclePolicyHash` on the *conservative default* overlay (`test/schemas.test.ts:415`), never on adversarial inputs.
- **Suggested:** Add unit tests: (a) `flush()` returns the trailing partial frame and clears the buffer; (b) a multi-byte char split across two `push()` calls reassembles correctly (will fail until A1 is fixed — good); (c) `canonicalizeJson`/`lifecyclePolicyHash` stability for reordered keys and `undefined` fields, and the non-finite `RangeError` path.
- **Risk:** Low (tests only) · **Effort:** ~2h · **Tests:** This *is* the test work.

### A6. `validation-primitives.ts` `path` / `issue` are dangerously generic public-ish names — naming / ISP
- **Location:** `validation-primitives.ts:135-141` (`export function path(...)`, `export function issue(...)`)
- **Current:** The module exports two single-word identifiers, `path` and `issue`. The file header says it is "Not part of the public package surface," yet nothing enforces that — `index.ts` does `export * from './schemas'` and `schemas.ts` imports these; if a future `export *` ever forwards them (or a consumer imports from the deep path), `path` collides head-on with Node's `path` module name and `issue` is an extremely generic export for a published boundary package. There is no `internal/` boundary marker or `@internal` annotation that a tooling/manifest check can rely on.
- **Suggested:** Rename to `joinPath` / `makeIssue` (or namespace them), and either move the file under an `internal/` directory or add an `@internal` JSDoc tag + ensure no barrel re-exports them. The first report flagged `SchemaRecord` as the internal-coupling type but did not flag these export names.
- **Risk:** Low · **Effort:** ~1h (mechanical rename; internal callers only) · **Tests:** `bun run typecheck`.

### A7. `JsonRpcParseError` and the `*ValidationError` family duplicate the same `{ code; issues; name }` error shape across modules — DRY (cross-module)
- **Location:** `jsonrpc.ts:51-60` (`JsonRpcParseError`), `ndjson.ts:7-18` (`NdjsonFrameError`), the 8 classes in `schemas.ts:45-120`, and `errors.ts`
- **Current:** The first report's Quick-Win #4 proposed a `ProtocolValidationError` base **only for the 8 classes inside `schemas.ts`**. But the *same* hand-rolled pattern (`readonly code = '…'`, `readonly issues: string[]`, `this.name = '…'` in the constructor) is independently re-implemented in `jsonrpc.ts` and `ndjson.ts` as well. Consolidating only the `schemas.ts` eight leaves two more copies of the identical boilerplate in sibling modules.
- **Suggested:** Extend the proposed base/factory to cover all protocol error classes package-wide (a single `ProtocolError` base in `errors.ts` carrying `code` + optional `issues`), so `JsonRpcParseError` and `NdjsonFrameError` share it too — not just the `schemas.ts` set.
- **Risk:** Low · **Effort:** ~1-2h · **Tests:** Existing parse/frame error-code tests (`jsonrpc.test.ts:85-93`, `ndjson.test.ts:54-76`).

### A8. Env-key classification predicates are silently case-sensitive with overlapping heuristics — leaky abstraction / edge case
- **Location:** `env-keys.ts:47-59`
- **Current:** `isCredentialEnvKey` matches `key.endsWith('_TOKEN') || key.endsWith('_PASSWORD')` (uppercase only) — a lowercase `my_token` or mixed-case `Api_Password` is NOT classified as a credential, so a secret could leak past a credential filter that relies on this. `isReservedEnvKey` mixes a case-sensitive prefix list (`NODE_`, `npm_`, `NPM_`, `XDG_`) with an explicit dual-case proxy set, showing the author already knows casing is a hazard, yet the credential predicate has no such doubling. The `_TOKEN`/`_PASSWORD` substring heuristic is also unanchored policy embedded in code with no test of its boundaries.
- **Suggested:** Decide and document the casing contract (env var names are conventionally upper-case, but POSIX permits any case). If the policy is "case-insensitive credential detection," uppercase the key before the suffix test; otherwise document that callers must normalize. Add tests for the suffix/prefix boundaries.
- **Risk:** Low (policy clarification) · **Effort:** ~1h · **Tests:** Add credential/reserved boundary cases.
