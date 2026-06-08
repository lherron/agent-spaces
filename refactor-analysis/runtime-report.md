# spaces-runtime (packages/runtime) — SOLID / code-smell audit

Audited every non-test source file under `packages/runtime/src/`. This package was
part of the recent repo-wide SOLID/code-smell cleanup pass (commit e238805) and is
in very good shape: named constants instead of magic literals, guard-clause /
early-return control flow, extracted private helpers, shared internal modules
(`file-reader.ts`, `type-guards.ts`), and documented intentional swallows. Most
files have zero findings. The handful below are minor, behavior-preserving polish
items — none are structural defects.

## Trivial pass-through wrapper `interpolateContent`
- File: packages/runtime/src/context-resolver.ts:585
- Risk: Low
- API-impact: internal-only
- Smell: `interpolateContent(content, context)` is a one-line alias that just calls
  `interpolateVariables(content, context)` with no added behavior. It is used in 4
  call sites, all of which could call `interpolateVariables` directly. The indirection
  adds a name to track without earning its keep.
- Proposed change: Inline `interpolateContent` at its 4 call sites (398, 483, 489, 505)
  and delete the wrapper, OR keep it but document it as a deliberate semantic alias.
  Either way behavior is identical. (Low priority — `expandTemplate` already exists as
  the public alias; this internal one is redundant.)

## Trivial pass-through wrapper `readTargetContent`
- File: packages/runtime/src/agent-memory/store.ts:202
- Risk: Low
- API-impact: internal-only
- Smell: `readTargetContent(config)` is a one-line wrapper returning
  `readFileOrEmpty(config.path)`; it adds no logic over the shared helper. Used in 3
  call sites (101, 121, 138).
- Proposed change: Inline to `readFileOrEmpty(config.path)` at the 3 call sites and
  delete the wrapper. Behavior-preserving.

## Duplicate predicate scan in `findMatches`
- File: packages/runtime/src/agent-memory/store.ts:226
- Risk: Low
- API-impact: internal-only
- Smell: `findMatches` runs `entries.filter((e) => e.includes(oldSubstr))` to count
  matches, then on the unique-match path runs `entries.findIndex((e) => e.includes(oldSubstr))`
  — re-scanning the array with the same predicate to recover the index it already
  walked past.
- Proposed change: Capture the index in a single pass (e.g. build an array of matching
  indices, or track the first matching index alongside the count) and return that index
  directly instead of a second `findIndex`. Behavior-preserving; only removes the
  redundant second scan.

## Pinned model version literal in public options type
- File: packages/runtime/src/session/options.ts:12
- Risk: High
- API-impact: public-surface
- Smell: `model?: 'haiku' | 'sonnet' | 'opus' | 'opus-4-6'` mixes alias names with a
  pinned version literal `'opus-4-6'`. The repo policy ("Don't pin model versions; use
  aliases") is to use opus/sonnet/haiku aliases only. The pin is also on an exported
  type union.
- Proposed change: Removing/renaming the `'opus-4-6'` member is a public-surface type
  change and could break callers that pass that literal — DEFER to a human to decide
  whether to drop it, keep it for back-compat, or route through the model catalog.

## `MaterializeResult` declared in system-prompt.ts but consumed cross-module
- File: packages/runtime/src/system-prompt.ts:33
- Risk: Med
- API-impact: public-surface
- Smell: `materialize-io.ts` imports the `MaterializeResult` type from `system-prompt.ts`,
  while `system-prompt.ts` imports the writer functions from `materialize-io.ts` — a
  mild circular type/value dependency between the two modules. It type-checks fine
  (type-only import one direction), but the result shape arguably belongs next to the
  writers that produce it.
- Proposed change: Optionally relocate `MaterializeResult` into `materialize-io.ts`
  (or a small shared types module) and re-export. This touches an exported type and the
  package `index.ts` re-export path, so DEFER — it is a public-surface move, not a pure
  internal refactor.

## Summary
The package is already clean from the recent SOLID pass. No long functions (largest are
well under control and already decomposed into named helpers), no deep nesting, no dead
exports, no god objects. Findings are limited to two redundant pass-through wrappers, one
double-scan micro-dedup, and two deferred public-surface items (a pinned model literal and
a type-location nit).
