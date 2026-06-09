# Refactor analysis — `spaces-harness-claude` (packages/harness-claude)

packageType: **general** (harness-adapter wiring + SDK message decode; not perf/concurrent/data-heavy).

## Summary

This package was already worked over by the two prior passes (T-02028, T-02030) and shows it:
SDK-shape decoding is centralized in `sdk-message-decode.ts` with a handler table (T19 already
applied), `buildClaudeArgs` is a clean conditional-append builder, `invoke.ts`/`detect.ts` have
extracted helpers, and the spread-projections in `claude-agent-sdk-adapter.ts` are over the fixed
`ComposedTargetBundle` type (no excess-property hazard). The public boundary across the three export
maps (`.`, `./claude`, `./agent-sdk`) is coherent and intentional.

Net result: **one** low-risk, internal-only, behavior-preserving finding (a duplicated eligibility
predicate that the package's own design comment already warns about drifting). Everything else is
either already-fixed, load-bearing, or a behavior change that is tracked elsewhere and must not be
auto-applied. Honest applicable count: **1**.

## Public boundary verdict

- `src/index.ts` — re-exports the two adapter singletons/classes, `register`, and re-`export *`s the
  `claude` and `agent-sdk` barrels. Coherent.
- `src/claude/index.ts` — detection / invocation / validation surface. Each function is a real,
  separately-used entry point (verified against `invoke.test.ts`, `detect.test.ts`,
  `validate.test.ts`). No fat/leaky interface to realign.
- `src/agent-sdk/index.ts` — re-exports `AgentSession` + its config/seam types, the hooks bridge, the
  prompt queue, and a **pass-through re-export of the SDK's own `query`/`tool`/`createSdkMcpServer`**.
  That pass-through is a deliberate convenience boundary (hosts import the SDK primitives through the
  harness), not a middle-man to collapse.
- The adapters implement `HarnessAdapter` from `spaces-config` (an external contract). Any signature
  change here is **M02 expand/contract** territory and out of scope for an internal-only refactor.

Verdict: leave the boundary as-is. No widen/narrow indicated.

## Findings by mechanism

### [T15] Extract the duplicated "synthesizable user tool-result" eligibility predicate — APPLICABLE

- **Location:** `src/agent-sdk/agent-session.ts:753-779` (`emitUserToolResultIfNeeded`) and
  `src/agent-sdk/hooks-bridge.ts:357-378` (module-level `emitUserToolResultIfNeeded`).
- **Smell (verified, still present):** both functions open with the *identical* 4-clause early-return
  guard:
  `msgType !== 'user' || sawToolResultBlock || typeof msg['parent_tool_use_id'] !== 'string' || msg['tool_use_result'] === undefined`.
  This is the eligibility decision for "synthesize a tool-result from `tool_use_result`." The two
  bodies legitimately diverge (one emits a `UnifiedSessionEvent`, the other calls
  `bridge.emitPostToolUse`), so only the *predicate* is duplicated, not the action.
- **Mechanism / direction:** extract a missing abstraction — a small named predicate
  `isSynthesizableUserToolResult(msg, msgType, sawToolResultBlock): boolean` in
  `sdk-message-decode.ts` (the file whose own header comment says this exact class of SDK-shape logic
  "had already started to drift" and was centralized to give "a single source of truth"). Both
  call sites become `if (!isSynthesizableUserToolResult(...)) return`. This is the *same* dedup move
  the prior pass already made for `forEachToolBlock` / `normalizeToolResultBlocks`.
- **Preservation:** pure predicate extraction — the boolean result is bit-for-bit the conjunction of
  the four existing clauses; control flow and both emit bodies are untouched. Observable session
  events and hook emissions are unchanged.
- **How you'd know it helped:** the eligibility rule for "did the SDK hand us a parent-task user
  message carrying a `tool_use_result` we must lift" lives in exactly one place; the two consumers
  can no longer drift (which is the documented failure mode for this file's contents). Existing tests
  (`claude-adapter.test.ts`, the agent-sdk message tests) continue to pass; add one direct unit test
  on the new predicate (true case + each of the four false branches).
- **risk:** Low — **apiImpact:** internal-only (`sdk-message-decode.ts` exports are package-internal;
  not re-exported by name from any index barrel except as part of `export *` of the agent-sdk barrel,
  and the new predicate need not be added to the public surface — keep it internal).
- **Churn:** one new internal helper + one new small test; two two-line edits at the call sites. No
  lint hazard (no `typeof v === 'string'` literal-folding; the `typeof ... === 'string'` clause is
  copied verbatim into the helper, so no `useValidTypeof` trip).
- **Contraindication checked:** the duplication is *not* load-bearing here — both copies are meant to
  encode the same rule, and the file that should own it already exists for precisely this reason. (If
  the bodies had been identical too, this would instead be a relocate; they are not, so only the
  guard moves.)

## Deliberately left alone

- **`PromptQueue.close()` park-wakeup defect** (`src/agent-sdk/prompt-queue.ts:104-112`): `close()`
  sets `this.waiting = null` *without* resolving the parked promise, so a consumer that parked before
  `close()` never wakes and its `await` hangs. This is a real bug, but fixing it **changes observable
  behavior** (a redesign, not a refactor) and it is already tracked: `prompt-queue.test.ts:98-108`
  carries a `test.todo` referencing "BUGS.md harness-claude A1". Flagged, not auto-applied.
- **SDK pass-through re-export** (`agent-sdk/index.ts:9` re-exporting `query`/`tool`/
  `createSdkMcpServer`): looks like a middle-man (T23) but is a deliberate convenience boundary so
  hosts get the SDK primitives through the harness. Collapsing it would be a public-surface change for
  no internal gain. Left.
- **`ClaudeAgentSdkAdapter` delegating to `claudeAdapter`** (`claude-agent-sdk-adapter.ts`): every
  method forwards to the Claude adapter, overriding only `id`/output-path/`harnessId`. This reads as a
  middle-man, but the two are distinct registered harnesses with distinct ids and output paths; the
  delegation *is* the intended "same behavior, different identity" relationship. The spreads
  (`{...result.bundle, harnessId: this.id}`) forward exactly the fixed `ComposedTargetBundle` fields,
  so there is no excess-property/extra-field-forwarding hazard. Left.
- **`models` display-name table** (`claude-adapter.ts:79-88`): the model *ids* come from
  `spaces-config` constants (catalog-sourced, not magic literals); only the human display strings are
  inline, which is the natural place for them. Not a magic-number/primitive-obsession finding. Left.
- **`buildClaudeArgs` conditional-append chain** (`invoke.ts:122-180`): a flat sequence of
  `if (opt) args.push(...)`. This is a builder, not a growing type-switch — converting it to a
  dispatch table would *add* indirection for zero variation benefit (T16 says don't manufacture
  abstraction). Left.
- **`COMMON_CLAUDE_PATHS` / detection fallbacks** (`detect.ts`): the path list is intentional
  defense-in-depth across install layouts; not duplication to fold. Left.
- **`AgentSession.listenToOutput` flush-on-every-exit logic**: the `finally`-block re-emits
  (`emitStopIfNeeded`, `flushPendingTurns`, `emitAgentEnd`) are guarded by `*IfNeeded`/`hasEmitted*`
  idempotency flags — this is an already-reified "emit-once" state machine (T10 already applied), not
  boolean soup to untangle. Left.

## Outside-in apply sequence

1. (Make-safe) Confirm the existing agent-sdk message tests exercise both the session-event path and
   the hook-bridge path for a parent-task `tool_use_result` user message; if the bridge path lacks a
   direct assertion, add a characterization test first (T40).
2. Extract `isSynthesizableUserToolResult` into `sdk-message-decode.ts`; route both
   `emitUserToolResultIfNeeded` call sites through it (the single T15 finding).
3. Run `bun test` for the package; the predicate is pure so no behavior delta is expected.

No public-surface or High-risk findings. Nothing in this report should be applied beyond item (2);
the `PromptQueue.close()` defect is intentionally excluded as a tracked behavior change.
