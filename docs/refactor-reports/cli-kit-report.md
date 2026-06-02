# 🔧 Refactoring Analysis

**Target:** `packages/cli-kit/src` (single source file: `index.ts`)
**Lines analyzed:** 130 (source) + 177 (tests)
**Generated:** 2026-06-01  ·  **Focus:** all

## Summary

`cli-kit` is a small, cohesive collection of stateless Commander helpers and CLI
input validators. It is a flat module of free functions plus one custom error
class (`CliUsageError`). There are **no classes with behavior**, **no inheritance
hierarchies**, and **no internal collaborators that get instantiated**, so most of
the classic SOLID failure modes simply do not apply. The code is clean, well
tested (12 cases across all exported symbols), and uses the project's
`prop?: T | undefined` optional convention.

The findings below are minor and largely stylistic. None are urgent. The package
is in good health.

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🟢 | Module is a single grab-bag of CLI helpers, but each function does exactly one thing and is < 25 lines. The only mild concern is the module mixing three loose concerns (commander option attachers, value validators, error/exit handling) in one file. |
| Open/Closed | 🟡 | `parseDuration` uses a `switch` on the unit token that must be edited to add a new unit; the regex and the switch are two places to keep in sync. |
| Liskov Substitution | 🟢 | No subclassing beyond a trivial `Error` subclass that adds no overrides — fully substitutable for `Error`. |
| Interface Segregation | 🟢 | No interfaces; the largest exported "shape" is the `{ min: number }` / `{ json?; binName }` option objects, all narrow. |
| Dependency Inversion | 🟡 | `consumeBody` and `exitWithError` reach directly for concrete process/fs effects (`readFileSync`, `process.exit`, `process.stderr.write`) inside otherwise pure helpers — no injection seam. Tests work around this by monkey-patching `process`. |

## 🎯 Priority Refactorings

### 1. `parseDuration` duplicates unit knowledge across a regex and a switch — Open/Closed
- **Location:** `packages/cli-kit/src/index.ts:46-65`
- **Current:** The accepted units are encoded once in the regex `(ms|s|m|h)` and again in the `switch (match[2])`. Adding `d` (days) means editing two spots; the `default:` branch is also dead code, because any token reaching the switch already matched the regex alternation — the throw can never fire.
- **Suggested:** Replace the switch with a single `Record<string, number>` multiplier table and derive the regex alternation from its keys:
  ```ts
  const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }
  const DURATION_RE = new RegExp(`^(\\d+)(${Object.keys(UNIT_MS).join('|')})$`)
  ```
  New units become one map entry. This also removes the unreachable `default` branch.
- **Risk:** Low  ·  **Effort:** ~10 min  ·  **Tests:** Existing `parseDuration` cases (`index.test.ts:108-117`) already cover all four units and the invalid case; no new tests required, optionally add a day-unit case if `d` is added.

### 2. Side-effecting helpers have no injection seam — Dependency Inversion
- **Location:** `consumeBody` `packages/cli-kit/src/index.ts:103-116`; `exitWithError` `packages/cli-kit/src/index.ts:118-130`
- **Current:** `consumeBody` calls `readFileSync(...)` directly (including the `/dev/stdin` path), and `exitWithError` calls `process.stderr.write` and `process.exit` directly. The test suite has to monkey-patch global `process` (`index.test.ts:36-58`) to exercise `exitWithError`, which is a smell signaling a missing seam.
- **Suggested:** Accept optional injected effects with the real ones as defaults, e.g. `consumeBody(opts, { readFile = readFileSync } = {})` and `exitWithError(err, { ..., write = process.stderr.write.bind(process.stderr), exit = process.exit })`. This keeps the public call sites unchanged while making the I/O testable without global patching. Given this is a tiny utility lib, this is optional polish, not a defect.
- **Risk:** Low  ·  **Effort:** ~20 min  ·  **Tests:** Could simplify `captureExit` in `index.test.ts` to pass spies instead of replacing `process.exit`/`process.stderr.write`.

### 3. Inconsistent validator argument ordering — code consistency (minor SRP/API ergonomics)
- **Location:** `parseJsonObject(flag, raw)` `:67`, `parseCommaList(raw, flag)` `:82`, `parseIntegerValue(flag, raw, options)` `:95`
- **Current:** The `flag` and `raw` parameters appear in different orders across the three validators (`(flag, raw)` vs `(raw, flag)` vs `(flag, raw, options)`). For a "shared CLI kit" intended for reuse across packages, this inconsistency is an easy source of caller bugs that the type system cannot catch (both params are `string`).
- **Suggested:** Standardize on one order (recommend `(flag, raw, options?)` to match `parseIntegerValue` and `parseJsonObject`). Update the single out-of-step signature, `parseCommaList`.
- **Risk:** Med (signature change ripples to every caller across packages)  ·  **Effort:** ~15 min + caller sweep  ·  **Tests:** Update `parseCommaList` call in `index.test.ts:126-127` and any cross-package callers.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Dead/unreachable code: `default` throw can never execute because the regex already constrains the unit | `index.ts:62-63` | 🟡 |
| Duplicated source of truth: duration units listed in both regex and switch | `index.ts:47` & `:53-61` | 🟡 |
| Hidden hard dependency on `readFileSync` / `process.exit` / `process.stderr.write` inside otherwise pure helpers (testability) | `index.ts:108,113,124,126,129` | 🟡 |
| Inconsistent `(flag, raw)` vs `(raw, flag)` parameter order across validators | `index.ts:67,82,95` | 🟡 |
| Magic literal `'/dev/stdin'` for stdin reads (non-portable; fragile on some platforms) | `index.ts:113` | 🟠 |
| Loose grab-bag module mixing option-attachers, validators, and error/exit handling in one file (mild) | `index.ts` (whole file) | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Collapse `parseDuration`'s regex + switch into a single unit→multiplier map (Refactoring #1) — removes the dead `default` branch and the duplicated unit list in one change.
2. Remove the now-unreachable `default:` throw at `index.ts:62-63` even if the larger refactor is deferred.
3. Standardize validator parameter order (Refactoring #3) while the package still has few external callers — cheaper now than later.

## ⚠️ Technical Debt Notes

- The package is intentionally a flat utility module; if it keeps growing it may be worth splitting `index.ts` into `options.ts` (commander attachers), `validators.ts` (parse* helpers), and `errors.ts` (`CliUsageError` + `exitWithError`) with a barrel `index.ts`. Not warranted at 130 lines today.
- `consumeBody` reading `/dev/stdin` synchronously is non-portable (won't behave on platforms without that device node) and couples the helper to a POSIX path. Consider `readFileSync(0, 'utf8')` (fd 0) which is the portable stdin read in Node/Bun.
- `withDeps` relies on positional argument shape from Commander (`args.at(-1)` is the `Command`), an implicit contract; a comment documenting that invariant would reduce surprise for new callers.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (current suite covers every exported symbol)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run `bun run test` between each
- [ ] For Refactoring #3, run `bun run typecheck` and grep all packages for `parseCommaList` callers before changing its signature
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

These are issues not covered by the first pass. They focus on input-validation
correctness, type soundness, and test gaps rather than the SOLID/structure
findings above. Several were confirmed by running the helpers directly.

### A1. `parseIntegerValue` silently accepts non-numeric and fractional garbage — missing-edge-case / contract bug
- **Smell:** Leaky validator — `Number.parseInt` does *prefix* parsing, so the validator passes inputs it should reject.
- **Location:** `packages/cli-kit/src/index.ts:96`
- **Detail:** `Number.parseInt('10abc', 10)` returns `10`, so `parseIntegerValue('--x', '10abc', { min: 0 })` returns `10` (confirmed). Likewise `'3.9'` → `3` (silently truncates a float), `'  7 '` → `7` (silently strips whitespace), and `'0x10'` → `0` (the `x...` suffix is dropped). For a flag that promises "must be an integer", accepting `10abc`/`3.9` is a real validation hole — a malformed `--limit 5x` would be accepted as `5`. The first report only flagged parameter-order and DI concerns here, not the parsing semantics. Fix: validate with a strict regex (`/^-?\d+$/`) or compare `String(value) === raw.trim()` before the range check.
- **Risk:** Low (tightens validation; could break callers that *relied* on lax parsing — unlikely)  ·  **Effort:** ~10 min  ·  **Tests:** add cases for `'10abc'`, `'3.9'`, `' 7 '` to `index.test.ts:130`.

### A2. `parseIntegerValue` upper-bound and overflow are unguarded — missing-edge-case
- **Smell:** Asymmetric bounds check.
- **Location:** `packages/cli-kit/src/index.ts:95-101`
- **Detail:** The option object exposes only `{ min: number }`; there is no `max`, and very large inputs (e.g. `'99999999999999999999'`) parse to an imprecise float beyond `Number.MAX_SAFE_INTEGER` yet pass `Number.isFinite` and the `>= min` check. For values used as counts/timeouts/limits this can produce surprising downstream behavior. Consider an optional `max` and a `Number.isSafeInteger` guard.
- **Risk:** Low  ·  **Effort:** ~10 min  ·  **Tests:** add an out-of-safe-range case.

### A3. `repeatable<T>()` with no `parse` is type-unsound — leaky abstraction / unsafe cast
- **Smell:** Unsound generic — the `value as T` cast lies to the type system.
- **Location:** `packages/cli-kit/src/index.ts:31`
- **Detail:** When `parse` is omitted, raw strings are cast to `T` via `(value as T)`. Calling `repeatable<number>()` (no parser) yields an array typed `number[]` whose elements are actually strings — confirmed: `collect('5', undefined)` → `['5']` typed as `number[]`. Any non-`string` `T` without a parser silently corrupts the element type with zero compile-time warning. Fix: split into two overloads — `repeatable(): (v,p)=>string[]` and `repeatable<T>(parse: (raw)=>T): (v,p)=>T[]` — so omitting the parser forces `T = string`.
- **Risk:** Low (type-only change)  ·  **Effort:** ~15 min  ·  **Tests:** existing `repeatable` test (`index.test.ts:83`) always passes a parser; add a no-parser case asserting `string[]`.

### A4. `consumeBody` treats an empty `file` path as "no file" — silent edge case
- **Smell:** Truthiness check masks an invalid input.
- **Location:** `packages/cli-kit/src/index.ts:107`
- **Detail:** `if (opts.file)` is falsy for `file: ''`, so an explicitly-empty file path silently falls through to the positional branch instead of erroring (confirmed: `consumeBody({ file: '' })` → `undefined`). If a caller wires `--file` to an empty string, the body is silently dropped rather than surfacing a usage error. Prefer `opts.file !== undefined` to distinguish "unset" from "empty".
- **Risk:** Low  ·  **Effort:** ~5 min  ·  **Tests:** add an empty-`file` case.

### A5. `withDeps` swallows the missing-Command case and mistypes positionals — contract / defensive-programming gap
- **Smell:** Optimistic casts on an implicit Commander contract.
- **Location:** `packages/cli-kit/src/index.ts:38-43`
- **Detail:** When invoked with zero args, `args.at(-1)` is `undefined`, `command?.opts()` short-circuits to `{}`, and the handler runs with empty opts/positionals instead of failing loudly (confirmed: `withDeps(...)()` resolves silently). Also, `args.slice(0, -1) as string[]` blindly casts — if the last arg isn't a `Command` (e.g. Commander passes an options object before the command, or the action is wired with a variadic), the real last positional is dropped and the non-Command value is mis-read. The cast hides both failure modes. The first report's tech-debt note mentions documenting the `args.at(-1)` invariant; this is the stronger point that the invariant is *unchecked* and fails silently. Consider asserting the final arg is a `Command` instance and throwing otherwise.
- **Risk:** Med (touches the action-wiring contract used across CLIs)  ·  **Effort:** ~15 min  ·  **Tests:** add a case asserting it throws when no `Command` is passed.

### A6. `consumeBody` does no error wrapping around `readFileSync` — error-message quality
- **Smell:** Raw I/O error leaks to the user instead of a `CliUsageError`.
- **Location:** `packages/cli-kit/src/index.ts:108,112`
- **Detail:** A missing/unreadable `--file` throws a raw `ENOENT` `Error`, which `exitWithError` then reports with exit code **1** (treated as an internal error) rather than **2** (usage error), even though a bad file path is a user-input problem. Wrapping the read in `try/catch` and rethrowing as `CliUsageError` would give consistent exit semantics with the other validators. (The repo's "never silently capture errors" rule still holds — this rethrows with a clearer message, it does not swallow.)
- **Risk:** Low  ·  **Effort:** ~10 min  ·  **Tests:** add a missing-file case asserting `CliUsageError`.

### A7. Test gap: `consumeBody` stdin (`'-'`) path is entirely untested — test gap
- **Smell:** Untested branch.
- **Location:** test file `packages/cli-kit/src/index.test.ts:137-141`; code under test `index.ts:111-113`
- **Detail:** The `consumeBody` test exercises the inline and file branches but never the `positional === '-'` → `/dev/stdin` read. That branch (already flagged as non-portable in the first report's tech-debt note) has **zero** coverage, so a regression in the stdin path would pass CI. Worth at least a documented gap, ideally a test that injects a readable fd.
- **Risk:** n/a (analysis)  ·  **Effort:** ~15 min to add a test  ·  **Tests:** new stdin-branch case.

### A8. `parseJsonObject` return type understates what it returns — minor contract precision
- **Smell:** Type widening loses the validated narrowing.
- **Location:** `packages/cli-kit/src/index.ts:67,79`
- **Detail:** After the runtime guard rejects arrays, `null`, and non-objects, the function still returns `Record<string, unknown>` via `as`. That's acceptable, but the `as` cast is the only thing tying the runtime guard to the static type; if the guard at `:75` is ever weakened (e.g. the array check removed) the cast would silently start lying. A user-defined type guard (`function isPlainObject(v): v is Record<string,unknown>`) would keep the runtime check and the static type in lock-step. Minor.
- **Risk:** Low  ·  **Effort:** ~10 min  ·  **Tests:** none required.

### A9. Tests mutate global `process.exit`/`process.stderr.write` — shared-state / test-isolation fragility
- **Smell:** Global monkey-patch in tests (relates to but is distinct from the first report's "missing DI seam" point, which was about the *source*; this is about the *test harness's* safety).
- **Location:** `packages/cli-kit/src/index.test.ts:36-58`
- **Detail:** `captureExit` swaps global `process.exit` and `process.stderr.write`. Restoration is in a `finally`, which is correct, but the `expect(fn).toThrow(...)` runs *inside* the try — if Bun ever runs these `exitWithError` tests with concurrency, the global swap would race with any other test writing to stderr. With Bun's default per-file serialization this is currently safe, but it is a latent isolation hazard worth noting alongside the DI-seam fix (#2 above), which would remove the need to patch globals at all.
- **Risk:** Low  ·  **Effort:** subsumed by Refactoring #2  ·  **Tests:** convert to injected spies if #2 lands.
