# 🔧 Refactoring Analysis — cli-kit

**Target:** cli-kit  ·  **Files read:** 2 (1 source + 1 test)  ·  **Lines:** 197 (src) + 205 (test)
**Generated:** 2026-06-14  ·  **Package type:** leaf (pure helpers, single dependency: commander)

## 🧭 Summary

A small, single-file leaf utility (`src/index.ts`) of Commander option-attachers, CLI value
validators, a dependency-injection wrapper, and an error-exit envelope. The internal structure is
already in good shape — it was clearly refactored once (named constants `DURATION_UNIT_MS`,
`STDIN_SENTINEL`; extracted helpers `formatErrorLine`/`readBody`; honest overloads on `repeatable`;
injected I/O seams). The highest-leverage observation is at the **public boundary**: the package
exports 13 symbols, but a full cross-repo scan (agent-spaces + hrc-runtime) shows **6 functions and 1
type have zero import sites anywhere**. The fat surface is the dominant finding; internals are nearly
spotless.

## 🚪 Public boundary (assess first)

- **API surface (exported):** `BuildDeps<D>` (type), `CliUsageError`, `attachJsonOption`,
  `attachServerOption`, `attachActorOption`, `repeatable`, `withDeps`, `parseDuration`,
  `parseJsonObject`, `parseCommaList`, `parseIntegerValue`, `consumeBody`, `exitWithError`.
- **Actual usage (grepped import sites across agent-spaces/packages + hrc-runtime/packages, excluding `dist/` and `*.test.*`):**
  - **Used:** `CliUsageError` (41+17), `exitWithError` (17+2), `parseDuration` (0+3),
    `consumeBody` (0+2), `parseIntegerValue` (0+1), `attachJsonOption` (0+1).
  - **Zero import sites in either repo:** `attachServerOption`, `attachActorOption`, `repeatable`,
    `withDeps`, `parseJsonObject`, `parseCommaList`, and the `BuildDeps<D>` type
    (`BuildDeps` is only referenced internally as `withDeps`' second parameter type — it leaves no
    independent reason to be exported once `withDeps` goes).
- **Findings:** The surface is **fatter than its usage** (T07). It is a *published* package
  (`version 0.1.1`, ships `dist/`), so unknown external consumers may exist (Hyrum's Law) — every
  removal is a public-contract change that must go through **Expand/Contract [M02]**, not a direct
  delete.
- **Verdict:** 🟡 needs care — internals sound, but ~half the exported functions are dead within the
  known consumer set and should be deprecated/contracted deliberately.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. Six exported functions + one exported type have no callers in either repo — [T07] Align interface to actual usage / [M02] Expand-Contract
- **Location:** `src/index.ts:4` (`BuildDeps`), `:17` (`attachServerOption`), `:24` (`attachActorOption`), `:31-39` (`repeatable`), `:41-54` (`withDeps`), `:83-96` (`parseJsonObject`), `:98-109` (`parseCommaList`)
- **Mechanism repaired:** A public surface wider than its real usage. Every export is a contract the maintainer must keep working under Hyrum's Law; unused exports are pure carrying cost (they constrain future change, inflate the `.d.ts`, and invite speculative coupling). Narrowing the interface to actual usage shrinks the supported contract.
- **Symptom that flagged it:** Cross-repo import scan returns 0 import sites for each of these 7 symbols across both `agent-spaces` and `hrc-runtime` (the cli package even ships its own local `collect` instead of importing `repeatable`).
- **Current → Suggested:** Run **Expand/Contract**: (1) annotate each with `@deprecated` in a release, (2) confirm no external consumer surfaces, (3) remove. Do NOT bulk-delete now — this is a published package and there may be downstream consumers not in these two repos.
- **Direction:** remove (via deprecate-then-contract)
- **Preservation:** test-suite + observational-equivalence across the *known* consumer set — removing a symbol with no import site cannot change observable behavior of any caller in-repo. The risk is purely unknown external callers, which Expand/Contract is designed to flush out.
- **Falsifiable signal:** After deprecation window, a clean `grep -r "import .* from 'cli-kit'"` across all known consumers (and any published-package telemetry / downstream repos) shows none of the 7 symbols; the cli-kit test suite for the removed symbols is deleted alongside them; `tsc` of all consumers stays green.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** S to deprecate, S to contract (small, self-contained functions)
- **Tests:** `index.test.ts` currently covers `attachServerOption`, `repeatable`, `withDeps`, `parseJsonObject`, `parseCommaList` — these char-tests are removed in the contract step, not before.
- **Contraindication:** If product intent is for cli-kit to be a *general* reusable CLI toolkit published for arbitrary downstream CLIs, some of these (e.g. `attachServerOption`, `parseJsonObject`) are deliberate library affordances kept ahead of demand. Confirm intent before contracting — this is exactly the "an unused seam can be a deliberate option" caveat. Treat removal as a deliberate scope decision, not an auto-apply.

### 2. `withDeps` documents Commander's positional/Command argv convention in prose — [T15] Extract missing abstraction (minor)
- **Location:** `src/index.ts:45-52`
- **Mechanism repaired:** The "last argv element is the `Command`, preceding are positionals" convention is an implicit Commander contract reconstructed by hand. It is currently the *only* place this knowledge lives, so there is no duplication to dedup — naming it would only help *if* a second site needed the same decode.
- **Symptom that flagged it:** `args.at(-1) as Command` + `args.slice(0, -1) as string[]` casts encode a structural assumption in comments rather than a type.
- **Current → Suggested:** Leave as-is. There is a single instance and the comment is accurate; extracting a `splitCommanderArgs` helper would add indirection without a second caller. Recorded only to show it was considered and rejected.
- **Direction:** (none — left alone)
- **Preservation:** n/a
- **Falsifiable signal:** A second function in this file (or a consumer) reconstructs the same `args.at(-1)`/`slice(0,-1)` decode → then extract. Until then, do not.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** n/a
- **Tests:** n/a
- **Contraindication:** Single instance → extracting now is premature abstraction (T16 in reverse). Where-NOT applies.

### 3. Two `as` casts in `repeatable`/`withDeps` are load-bearing, not removable — (analysis note, no change)
- **Location:** `src/index.ts:38` (`value as unknown as T`), `:49-50` (`args.at(-1) as Command`)
- **Mechanism repaired:** None needed. The `value as unknown as T` is reached *only* on the no-parser overload where the public signature already pins `T = string` (the overload at `:31` makes the cast sound at the boundary); the comment at `:28-30` correctly explains this. The `withDeps` casts reflect Commander's untyped variadic action signature, which has no safer typed form.
- **Symptom that flagged it:** Raw `as` casts often signal an interface misaligned with usage (T07).
- **Current → Suggested:** Leave. These are the minimal casts at an inherently-untyped third-party boundary; the overloads + guard (`isPlainObject` at `:79`) already do the real type work.
- **Direction:** (none — left alone)
- **Preservation:** type/compiler-proof — overloads constrain the only reachable callers.
- **Falsifiable signal:** A way to type Commander's action callback without `as` (e.g. a generic Commander overload) appears upstream → revisit.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** n/a
- **Contraindication:** Removing the cast would require weakening the honest overloads — a net loss. Where-NOT applies.

## 🪶 Deliberately left alone (where-NOT)

- **`DURATION_UNIT_MS` lookup `as number` (`:71`)** — the regex alternation at `:62` is *built from* `Object.keys(DURATION_UNIT_MS)`, so `match[2]` is provably a key. The cast is a TS-completeness wart, not a real partiality (T17 contra: the "can't happen" branch genuinely can't happen because the regex and the map share one source of truth). A `?? unreachable()` would add code without changing behavior.
- **`isPlainObject` guard (`:79-81`)** — a real reachable runtime check feeding a user-defined type guard; this is correct invariant-at-the-boundary work, not a candidate for collapse (T12 done right).
- **Injected `readFile`/`write`/`exit` seams (`:130`, `:185-188`)** — these substitution seams (T01) are already present and exercised by the tests via `captureExit`/injected `readFile`. No `new Concrete()`/singleton/static-in-logic smell remains; nothing to introduce or isolate.
- **`formatErrorLine` / `readBody` extractions (`:149`, `:169`)** — already extracted along correct cohesion lines (formatting vs. orchestration; I/O-wrap vs. policy). No T23 middle-man (each does real work), no further T03 relocation warranted in a single-file leaf.
- **`EXIT_CODE_USAGE`/`EXIT_CODE_INTERNAL` magic numbers (`:162-163`)** — already named constants; the earlier magic-number smell is fixed.
- **No T19/T22/T21 findings** — there is no growing type/enum switch, no nesting ≥4 (every function uses guard clauses already), and no param list >4 or data clump (the `{min}` and `{json,binName}` option objects are already whole-values). These mechanisms simply do not apply here.

## 🔭 If applying: outside-in sequence

1. **Confirm package scope intent first** (product/strategy call): is cli-kit an *internal* shared helper or a *general published toolkit*? This single decision gates Finding 1. Do not auto-apply; route to the human.
2. If internal-only: open the **Expand/Contract** for Finding 1 — deprecate the 7 zero-caller symbols (`attachServerOption`, `attachActorOption`, `repeatable`, `withDeps`, `parseJsonObject`, `parseCommaList`, `BuildDeps`), publish, observe, then contract (remove symbol + its char-tests together).
3. Re-run `tsc --noEmit` for cli-kit and every consumer; re-run cli-kit `bun test`.
4. No internal-only auto-applicable refactors remain — internals are already clean.

## ✅ Safety checklist

- [ ] Behavior of in-repo consumers unchanged (only zero-caller symbols touched).
- [ ] Field sets preserved — no spread/projection changes in this package (none present).
- [ ] No new biome lint (no literal-parameterization dedup performed; existing `as number` left as-is).
- [ ] Expand/Contract used for every public-surface change; nothing public deleted in one step.
- [ ] cli-kit `bun test` green; consumers' `tsc --noEmit` green.
- [ ] Package-scope intent confirmed with owner before contracting (Finding 1 contraindication).
