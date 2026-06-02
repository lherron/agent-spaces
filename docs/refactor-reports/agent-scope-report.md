# 🔧 Refactoring Analysis

**Target:** `packages/agent-scope/src`
**Lines analyzed:** 667 (8 source files, excluding `__tests__`)
**Generated:** 2026-06-01  ·  **Focus:** all

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🟡 | Parse + validate + canonical-format concerns interleaved; verbatim re-parsing in `parseScopeHandle` |
| Open/Closed | 🟡 | Scope-segment grammar hardwired into hand-rolled positional branching in three places; adding a segment touches every file |
| Liskov Substitution | 🟢 | Pure functions only; no class hierarchies or overrides |
| Interface Segregation | 🟢 | No fat interfaces; `ParsedScopeRef`/`SessionRef` are small data records |
| Dependency Inversion | 🟢 | No collaborator instantiation; module composes via plain function imports (acceptable for a pure value-object package) |

Overall: a small, well-typed, dependency-light value-object package. No serious SOLID violations, but pervasive **duplication** (the same token validation, the same handle-parse block, the same canonical scope-ref string assembly, and the same `lane:`-prefix slicing) is the dominant maintainability risk.

## 🎯 Priority Refactorings

### 1. Duplicated `validateToken` across three files — DRY / SRP
- **Location:** `scope-ref.ts:4-12`, `scope-handle.ts:17-25`, and the inlined equivalent in `lane-ref.ts:15-23`
- **Current:** `validateToken(value, label)` is copied **verbatim** into `scope-ref.ts` and `scope-handle.ts`; `validateLaneRef` re-implements the same length-check + `TOKEN_PATTERN` test inline. Three copies of the identical validation rule.
- **Suggested:** Promote a single `validateToken(value, label): string | undefined` (and a `ValidationResult` helper) into `types.ts` or a new `token.ts`, and have all three call sites import it. `validateLaneRef` calls it for `laneId`.
- **Risk:** Low  ·  **Effort:** ~20 min  ·  **Tests:** `input.test.ts`, `scope-ref.test.ts`, `scope-handle.test.ts` already cover token-length/charset errors; rerun `bun run test`.

### 2. `parseScopeHandle` re-derives what `validateScopeHandle` already computed — DRY / SRP
- **Location:** `scope-handle.ts:30-90` vs `scope-handle.ts:96-143`
- **Current:** The role-split + `agentId/projectId/taskId` extraction block (lines 36-68) is duplicated **byte-for-byte** in `parseScopeHandle` (lines 102-134). `validateScopeHandle` throws away the parsed pieces and returns only `{ ok }`, forcing `parseScopeHandle` to parse a second time, then build a canonical ref string and round-trip it through `parseScopeRef`.
- **Suggested:** Extract one private `splitHandle(handle): { agentId, projectId?, taskId?, roleName? }`. Have `validateScopeHandle` validate the split result and `parseScopeHandle` reuse it. Eliminates the double parse and the verbatim copy.
- **Risk:** Low  ·  **Effort:** ~30 min  ·  **Tests:** `scope-handle.test.ts`.

### 3. Canonical scope-ref string assembly duplicated in four places — DRY / OCP
- **Location:** `scope-ref.ts:132-148` (`formatScopeRef`), `scope-ref.ts:153-174` (`ancestorScopeRefs`), `scope-handle.ts:137-140`, `input.ts:142-145`
- **Current:** The pattern `agent:${id}` (+ `:project:…` + `:task:…` + `:role:…`) is hand-assembled in four distinct spots. `parseScopeHandle` (scope-handle.ts:137) and `resolveQualifiedScopeInput` (input.ts:142) both rebuild the string and then re-`parseScopeRef` it. Adding a new scope segment means editing all four.
- **Suggested:** Make `formatScopeRef(parsed)` the single source of truth and route the other three through it (construct a `ParsedScopeRef`-shaped object, call `formatScopeRef`). Consider a `buildScopeRef({agentId, projectId?, taskId?, roleName?})` helper consumed by `formatScopeRef`, `parseScopeHandle`, and `resolveQualifiedScopeInput`.
- **Risk:** Low  ·  **Effort:** ~30 min  ·  **Tests:** `scope-ref.test.ts`, `scope-handle.test.ts`, `input.test.ts`.

### 4. `lane:` prefix slicing duplicated with a magic offset — DRY / Primitive Obsession
- **Location:** `input.ts:60,73,83`, `session-handle.ts:36,52`, `session-ref.ts:29,39-41`, `lane-ref.ts:14`
- **Current:** `laneRef.slice(5)` (and `slice('lane:'.length)`) plus the `=== 'main' ? 'main' : 'lane:' + id` ternary are repeated across four files. `scope-handle.ts`/`scope-ref.ts` use bare `parts[5]`-style positional indices too. The literal `5` (length of `"lane:"`) is a magic number.
- **Suggested:** Add `laneIdFromRef(laneRef): string` and `laneRefFromId(laneId): LaneRef` to `lane-ref.ts` and use them everywhere a `lane:`/`main` conversion happens. Removes the magic `5` and centralizes the main/lane convention.
- **Risk:** Low  ·  **Effort:** ~20 min  ·  **Tests:** `input.test.ts`, plus session ref/handle behavior (add coverage if thin).

### 5. Repeated inline `ValidationResult` union — ISP / DRY
- **Location:** return types at `scope-ref.ts:21`, `scope-handle.ts:30`, `lane-ref.ts:7`
- **Current:** `{ ok: true } | { ok: false; error: string }` is spelled out inline in three signatures.
- **Suggested:** Define `export type ValidationResult = { ok: true } | { ok: false; error: string }` in `types.ts` and reference it. Trivial readability win and a stable public type for consumers.
- **Risk:** Low  ·  **Effort:** ~10 min  ·  **Tests:** none functional; typecheck only.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Duplicated code — verbatim `validateToken` | `scope-ref.ts:4-12`, `scope-handle.ts:17-25` | 🟠 |
| Duplicated code — handle-split block copied | `scope-handle.ts:36-68` vs `102-134` | 🟠 |
| Duplicated code — canonical ref assembly (×4) | `scope-ref.ts:132,153`, `scope-handle.ts:137`, `input.ts:142` | 🟠 |
| Duplicated code — `lane:` slice / main-ternary (×7) | `input.ts:60,73,83`, `session-handle.ts:36,52`, `session-ref.ts:29,39` | 🟡 |
| Magic number — `5` for `"lane:".length` | `lane-ref.ts:14`, `input.ts:60,73,83`, `session-handle.ts:36,52` | 🟡 |
| Primitive obsession — positional `parts[i]` indexing with `part()` cast helper | `scope-ref.ts:14-16` and call sites | 🟡 |
| Unsafe cast hidden in helper — `parts[i] as string` masks out-of-bounds | `scope-ref.ts:15` | 🟡 |
| Long branching function — `validateScopeRef` length/positional logic | `scope-ref.ts:21-86` (66 lines) | 🟡 |
| Inconsistent SessionRef serialization grammar — `parseSessionRef` uses `/lane:` but `parseSessionHandle` uses `~`; two formats for one concept | `session-ref.ts` vs `session-handle.ts` | 🟡 |
| Duplicated inline validation-result type | `scope-ref.ts:21`, `scope-handle.ts:30`, `lane-ref.ts:7` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Extract `validateToken` + `ValidationResult` into `types.ts`/`token.ts`; delete the two copies (Finding 1, 5).
2. Replace the four hand-rolled `agent:…:project:…` builders with one `formatScopeRef`-backed helper (Finding 3).
3. Add `laneIdFromRef` / `laneRefFromId` and kill every bare `slice(5)` / `"lane:".length` (Finding 4) — removes the magic number.
4. Route `parseScopeHandle` through a shared `splitHandle` so it stops re-parsing the input (Finding 2).

## ⚠️ Technical Debt Notes

- The package round-trips data through string form unnecessarily: `parseScopeHandle` builds a canonical ref string only to call `parseScopeRef` on it (scope-handle.ts:137-142); `resolveQualifiedScopeInput` does the same (input.ts:142-148). After consolidating the builders (Finding 3), prefer constructing the `ParsedScopeRef` directly and deriving `scopeRef` via `formatScopeRef` to avoid a parse on already-validated data.
- Two serialized session formats coexist (`~lane` handle form and `/lane:` ref form). This is likely intentional (shorthand vs canonical), but it is undocumented in `types.ts` and worth a comment to prevent a future consumer from conflating them.
- `part()` (scope-ref.ts:14) uses `as string` to suppress the `string | undefined` from index access; the surrounding length checks make it safe today, but a stricter `noUncheckedIndexedAccess`-aware destructuring would be more robust than the cast.
- No test file exists for `lane-ref.ts`, `session-ref.ts`, or `input.test.ts`'s lane-extraction edge cases beyond the happy path — add coverage before the Finding 4 refactor touches lane slicing.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (add `lane-ref`/`session-ref` cases first — see debt notes)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run `bun run test` + `bun run typecheck` between each
- [ ] Run `bun run lint` and `bun run check:boundaries` (this is a cross-repo publishable boundary package)
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

These are correctness/contract issues not raised in the first pass (which focused on duplication/DRY). Several are behavioral, not stylistic.

### A. `parseSessionHandle` never validates the laneId — invalid LaneRef escapes the type contract
- **Smell / Principle:** Missing edge-case handling · Broken invariant (LSP-of-the-type-contract)
- **Location:** `session-handle.ts:18-36`
- **Detail:** The lane portion is taken with `handle.slice(tildeIdx + 1)` and wrapped as `` `lane:${laneId}` `` with **no** call to `validateLaneRef`/`normalizeLaneRef`. The scope portion goes through `parseScopeHandle` (validated), but the lane does not. Consequences:
  - `parseSessionHandle('alice@demo~bad!char')` returns `laneRef: 'lane:bad!char'` — a value the `LaneRef` type promises matches `[A-Za-z0-9._-]+`, but doesn't. Every downstream consumer that trusts `SessionRef.laneRef` is now holding an unvalidated string.
  - `parseSessionHandle('alice@demo~')` (trailing `~`) yields `laneRef: 'lane:'` (empty laneId) instead of throwing.
  - A laneId containing a second `~` is silently accepted (charset never checked).
  This is asymmetric with the **ref** path: `parseSessionRef` (session-ref.ts:34) routes through `normalizeSessionRef`→`normalizeLaneRef`, which *does* reject bad lanes. The two public parsers disagree on what a valid lane is.
- **Suggested:** Route the extracted lane through `normalizeLaneRef(laneId === undefined || laneId === 'main' ? 'main' : ` + "`lane:${laneId}`" + `)` so the handle path enforces the same rule as the ref path (and throws on empty/invalid).
- **Risk:** Low · **Effort:** ~15 min · **Tests:** add invalid-lane cases to `session-handle.test.ts` (`alice@demo~`, `alice@demo~bad!char`) — none exist today; the invalid-case table only covers scope-portion errors.

### B. `formatScopeRef` trusts caller fields and can emit a non-canonical, unparseable ref — no invariant guard
- **Smell / Principle:** Leaky abstraction · Missing precondition (Design-by-contract)
- **Location:** `scope-ref.ts:132-148`
- **Detail:** `formatScopeRef` rebuilds the string purely from the optional fields, ignoring `kind` and never checking the project→task→role dependency chain. A `ParsedScopeRef` with `taskId` set but `projectId` undefined produces `agent:x:task:y` — a string that `parseScopeRef` would then *reject*. Because the type allows each optional field independently (types.ts:10-17), this is a representable-but-invalid state the formatter happily serializes. The inverse parser validates; the formatter does not, so the two are not guaranteed mutual inverses for hand-constructed inputs.
- **Suggested:** Either (a) add a guard that throws when `taskId`/`roleName` are present without their required ancestors, or (b) drive the segment chain off `kind` so the field set and the emitted string can't diverge. Same applies to `ancestorScopeRefs` (scope-ref.ts:153-174), which has the identical "trust the fields" assumption.
- **Risk:** Low · **Effort:** ~20 min · **Tests:** add `formatScopeRef`/`scope-ref` cases for malformed `ParsedScopeRef` (there is currently **no** `scope-ref.test.ts` exercising `formatScopeRef` at all).

### C. `formatSessionHandle` does not validate `laneRef` before slicing it
- **Smell / Principle:** Missing precondition · Unsafe magic-offset slice
- **Location:** `session-handle.ts:51-53`
- **Detail:** When `ref.laneRef !== 'main'`, the code does `ref.laneRef.slice(5)` assuming a `lane:` prefix. The `LaneRef` type technically admits `'lane:'` (empty tail, since `` `lane:${string}` `` matches the empty string), so a caller-built `{ laneRef: 'lane:' }` yields `scope~` (empty lane suffix) silently. There is no `validateLaneRef` call on the format path. This compounds Finding A: neither direction of the handle⇄SessionRef conversion enforces lane validity.
- **Suggested:** Validate `ref.laneRef` (or reuse a `laneIdFromRef` helper — see first-pass Finding 4 — that asserts the prefix) before forming the suffix.
- **Risk:** Low · **Effort:** ~10 min · **Tests:** `session-handle.test.ts` format section.

### D. `parseSessionRef` over-trims and accepts inner whitespace inconsistently
- **Smell / Principle:** Inconsistent input normalization · Leaky parsing
- **Location:** `session-ref.ts:21-35`
- **Detail:** `parseSessionRef` calls `.trim()` on the whole string, on `parts[0]` (scopeRef), and on the laneId, but **not** on the substring between `<scopeRef>` and `/lane:`. More importantly, trimming the *scopeRef* segment means `'agent:x /lane:main'` (trailing space before `/`) is silently accepted and normalized, while the canonical grammar in `formatSessionRef` never emits such whitespace. The lenient trimming is undocumented and asymmetric with every other parser in the package (`parseScopeRef`, `parseScopeHandle`, `parseSessionHandle` do **not** trim). This is a quiet inconsistency in the public parsing contract.
- **Suggested:** Decide one policy: either trim uniformly across all parsers (document it) or reject leading/trailing whitespace. Avoid trimming only some segments.
- **Risk:** Low · **Effort:** ~15 min · **Tests:** there is **no** `session-ref.test.ts` at all — add round-trip + whitespace + invalid-lane coverage before changing behavior.

### E. `resolveQualifiedScopeInput` re-parses a string it could construct directly, and silently drops a role-without-project
- **Smell / Principle:** Wasteful re-parse · Silent data loss on edge input
- **Location:** `input.ts:130-152`
- **Detail:** Two distinct issues:
  1. Like the first-pass note on round-tripping, it hand-builds `scopeRef` (input.ts:142-145) then calls `parseScopeRef(scopeRef)` (input.ts:148) to re-derive `parsed`/`kind` from data it already had — an avoidable validate+split on already-validated fields.
  2. A `roleName` present with **no** `projectId` (e.g. an agent-only input that somehow carried a role) would be silently dropped: `scopeRef` only appends `:role:` after the project/task branches, but if `projectId` stays undefined the role segment is still appended at line 145, producing `agent:x:role:y` — which `parseScopeRef` then **rejects** at line 148 (a role is only legal after project). So the function can throw on an input the grammar arguably should never have produced, with an error message ("Invalid ScopeRef") that points at an internally-constructed string, not the user's input. The blast radius is small (the upstream parsers don't produce role-without-project today), but the construct-then-reparse pattern means any future grammar relaxation surfaces as a confusing internal error.
- **Suggested:** Construct the `ParsedScopeRef` directly (deriving `kind`) and use `formatScopeRef` for `scopeRef`, or guard role-without-project explicitly with a user-facing error referencing the original `input`.
- **Risk:** Low · **Effort:** ~25 min · **Tests:** `input.test.ts`.

### F. `parseScopeInput` recomputes `laneId` from `laneRef` with the same magic-5 slice in three branches
- **Smell / Principle:** Duplicated derived value · Magic offset (extends first-pass Finding 4 into input.ts)
- **Location:** `input.ts:60, 73, 83`
- **Detail:** `session.laneRef === 'main' ? 'main' : session.laneRef.slice(5)` (and the `laneRef.slice(5)` variants) appear three times within one function. The first pass flagged the `slice(5)` pattern broadly; worth calling out that `ResolvedScopeInput` carries **both** `laneId` and `laneRef` (input.ts:7-12), a redundant pair that must be kept in sync by hand at every construction site. A single `laneIdFromRef(laneRef)` (first-pass Finding 4) would collapse all three, and it's worth questioning whether `laneId` needs to be stored at all versus derived on demand.
- **Risk:** Low · **Effort:** ~15 min · **Tests:** `input.test.ts`.

### G. Test-coverage gaps beyond the first pass's note
- **Smell / Principle:** Test gap
- **Location:** `src/__tests__/`
- **Detail:** The first pass noted missing `lane-ref`/`session-ref` tests. Additionally, **`scope-ref.ts` has no dedicated test file** — `validateScopeRef`, `parseScopeRef`, `formatScopeRef`, and `ancestorScopeRefs` (the most logic-dense module, 66-line branching validator) are only exercised indirectly through `input.test.ts`/`scope-handle.test.ts`. `ancestorScopeRefs` in particular (the `project-role`-without-task ancestor ordering) has zero direct assertions. Add a `scope-ref.test.ts` covering each `kind`, every validator error branch, and the `formatScopeRef`/`ancestorScopeRefs` invariants before attempting Findings B/E.
- **Risk:** n/a (tests) · **Effort:** ~40 min
