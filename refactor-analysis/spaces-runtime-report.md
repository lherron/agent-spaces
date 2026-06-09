# Refactor analysis — `spaces-runtime` (packages/runtime)

packageType: **general** (config/prompt-assembly + a small concurrent corner in agent-memory)

## Summary

This package assembles agent system prompts from TOML context templates (parse →
discover → resolve → materialize), plus two small registries (harness, session) and an
agent-memory store with file locking. It has **real external consumers** — `spaces-execution`
and `agent-spaces` import `expandTemplate` / `materializeSystemPrompt` from `spaces-runtime` —
so the package root is a load-bearing public boundary and any export change is `public-surface`.

The two prior passes (T-02028, T-02030) did thorough work: type guards and file-reading are
already centralized (`type-guards.ts`, `file-reader.ts`), the default template is built as an
object instead of via a TOML round-trip, magic separators/timeouts are named constants, the
`{{env.*}}` interpolation contract is documented, and swallowed-`catch` sites carry intent
comments. Most low-hanging fruit is genuinely gone.

I found **2 high-confidence findings**, both **T16 de-abstraction** (remove structure whose
variation never materialized), both **internal-only** and auto-applicable. The rest of the
package is left alone with reasons below.

## Public boundary verdict

`src/index.ts` re-exports a focused, intentional surface: parse/resolve/expand/discover/
materialize/inspect functions plus their result types, and the harness/session/agent-memory
subtrees. The `session/index.ts` and `agent-memory/index.ts` barrels are clean. Verdict:
**the boundary is well-shaped — do not touch it.** `isMissingFileError` and `readFileOrEmpty`
are correctly kept package-internal (not re-exported from the root); `isMissingFileError` is
only consumed inside `file-reader.ts` itself, but it is a named, documented predicate and is a
reasonable seam — leave it.

No fat/leaky interfaces, no expand/contract needed.

## Findings by mechanism

### Finding 1 — [T16] Dead sourceless-slot branches in `resolveSlotSection`
- **Location:** `src/context-resolver.ts:425-472` (`resolveSlotSection` sourceless block at
  lines 429-438, the `section.source === 'scaffold'` branch at line 440, and the
  `resolveAdditionalBaseSlot` function at lines 461-472).
- **Mechanism / direction:** DE-ABSTRACT. Remove the branches that handle slots with no
  `source` and the literal `source === 'scaffold'`. These were a generality the data never
  reaches:
  - `parseContextTemplate` **requires** `source` for every `slot` section
    (`parseRequiredString(input['source'], ...)`, context-template.ts:230; test
    "requires source for v2 slot sections", context-template.test.ts:185). So no *parsed*
    template can produce a sourceless slot or a `source = "scaffold"` slot.
  - The only path that builds `ContextTemplate` objects directly (`buildDefaultTemplate` /
    `buildScaffoldSections`, system-prompt.ts:329-381) emits **only `file` and `inline`
    sections** — never a `slot` section. Scaffold packets are turned into inline+file
    sections there, not into a slot.
  - Repo-wide grep finds no `source = "scaffold"` and no constructed sourceless slot anywhere
    (config's placement-resolver emits a `{ slot: 'additional-base', ... }` *packet*, an
    unrelated shape consumed via `scaffoldPackets`, not a context-template slot section).
  The reachable slot paths are the sourced ones: `instructions.additionalBase` →
  `resolveFileRefSlot`, `*Exec` → `resolveCommandSlot`, other dot-paths → `resolveFileRefSlot`
  (covered by the test at context-resolver.test.ts:265).
- **Preservation:** Observable behavior is identical because the removed code is unreachable
  under the parser invariant + the object-builder audit above. After removal,
  `resolveSlotSection` keeps exactly its reachable behavior for sourced slots.
- **Risk:** Med. **apiImpact:** internal-only (all three are module-private functions; the slot
  *type* and the public resolver signature are unchanged).
- **Tests:** existing resolver tests cover the sourced slot paths and stay green; no test
  exercises the sourceless branches (consistent with their being dead). Add a one-line note or
  leave coverage as-is. No new lint.
- **Contraindication checked:** Is the sourceless branch a *deliberate* future-extension seam?
  It is unreachable today and there is no documented forward plan referencing it; the parser
  actively forbids the only inputs that would reach it. If a future schema wants sourceless
  slots, it must relax the parser anyway, at which point this code would be re-derived. Safe to
  remove. (If reviewers prefer to keep it as a documented option, that is a legitimate
  where-NOT — but then the parser-side rejection should be cited in a comment so the
  dead-by-construction status is explicit.)

### Finding 2 — [T16] Unused `schemaVersion` parameter threaded through the section parser
- **Location:** `src/context-template.ts:151-172` — `parseSections(... schemaVersion)` and
  `parseSection(... _schemaVersion)`; the param is already underscore-prefixed (ignored).
- **Mechanism / direction:** DE-ABSTRACT. `ContextTemplateSchemaVersion` is the single literal
  `2` (line 5; `parseSchemaVersion` rejects everything else). The version is threaded into
  `parseSections` → `parseSection` solely to be discarded. This is a multi-version-parsing seam
  whose variation never materialized. Drop the parameter from both signatures (and the
  corresponding argument at the two call sites, lines 98-99 and 164).
- **Preservation:** Behavior identical — the value is never read. Pure signature cleanup.
- **Risk:** Low. **apiImpact:** internal-only (both functions are module-private; the public
  `parseContextTemplate` signature and `ContextTemplate.schemaVersion` field are untouched).
- **Tests:** no test references these internal signatures; suite stays green. No new lint.
- **Contraindication checked:** Keeping a version param "for when schema v3 lands" is the
  classic premature-abstraction trap — when v3 arrives the parser branching will be designed
  then, and re-adding a param is trivial. Remove now.

## Deliberately left alone

- **`expandTemplate` / `materializeSystemPrompt` / all root exports** — public surface with
  live cross-package consumers (`spaces-execution/run/identity.ts`,
  `agent-spaces/prepare-cli-runtime.ts`, `agent-spaces/broker-invocation.ts`). No change.
- **Nested conditional spread in `inspectAgentSystemPrompt` (system-prompt.ts:192-202)** — the
  `templateSource ? ... : profile.additionalBase ? ... : {}` ternary is dense but correct and
  produces an exact, excess-property-safe object shape. Flattening it into named locals is a
  pure readability micro-refactor with non-trivial churn and equal behavior; not worth the risk
  on a path the prior passes already shaped. Left.
- **`HarnessRegistry` / `SessionRegistry`** — near-parallel small registries
  (`register`/`get`/`getOrThrow`/`clear`). Tempting to extract a generic `Registry<K,V>`, but
  they diverge meaningfully (harness has async `detect`/`getAvailable`; session has
  `createSession`), and a one-instantiation generic base would be exactly the kind of
  premature abstraction this analysis is meant to *remove*, not add. The duplication is
  shallow, stable, and load-bearing-by-divergence. Left.
- **`buildHandle` calling `buildScopeRef`** (template-vars.ts) — proper reuse, not duplication.
  Left.
- **Swallowed `catch {}` in `resolveExecSection`, `probeServiceEndpoint`, `describeSectionSource`
  file branch** — each is intentional (documented) and load-bearing: a failing exec/probe must
  contribute no content rather than abort prompt assembly. Correct error handling; not a smell.
  Left.
- **`acquireAdvisoryLock` → `acquireProcessLock` fallback** (agent-memory/store.ts) — real
  defense-in-depth (fcntl advisory lock with an in-process queue fallback). Two distinct
  mechanisms, deliberately not collapsed. Left.
- **Magic constants** (timeouts, caps, separators, default ports) — already named and, in the
  caps case, documented with budget rationale. Left.
- **`when`-predicate evaluation in `matchesWhenPredicate`** — a flat series of guard checks
  (≤1 nesting level), each early-returning false. Already in guard-clause shape. Left.

## Outside-in apply sequence

1. **[T40 already satisfied]** Public boundary is pinned by existing characterization tests
   (`context-resolver.test.ts`, `system-prompt.test.ts`, `context-template.test.ts`) plus the
   live cross-package consumers. No new make-safe step required before the two internal edits.
2. **Finding 2** (Low, signature-only): drop `schemaVersion`/`_schemaVersion` from
   `parseSections`/`parseSection` and their two call sites. Run `just build` + the template
   tests.
3. **Finding 1** (Med, dead-branch removal): delete the sourceless block, the
   `source === 'scaffold'` branch, and `resolveAdditionalBaseSlot`; leave the sourced-slot
   logic intact. Run the full runtime test suite (resolver tests exercise the surviving paths).
4. Re-run `just verify` for the package and confirm the two external consumers still typecheck
   against the unchanged root exports.

Both findings are internal-only and Low/Med → auto-applicable. No public-surface or High-risk
findings to surface.
