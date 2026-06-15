# 🔧 Refactoring Analysis — spaces-harness-claude

**Target:** packages/harness-claude/src  ·  **Files read:** 14 source (+8 test read for contracts)  ·  **Lines:** 3474 total (~2.0k non-test)
**Generated:** 2026-06-14  ·  **Package type:** leaf (harness adapter; wraps Claude CLI + Agent SDK)

## 🧭 Summary
The package has two clear sub-boundaries: a CLI wrapper (`claude/`) and an in-process Agent SDK driver (`agent-sdk/`), unified by two `HarnessAdapter` implementations. The public surface is broad but mostly intentional. The highest-leverage findings are a module-level detection cache that is a hidden global seam, a one-method pass-through adapter that re-states the whole interface, and an implicit lifecycle state machine in `AgentSession` guarded by scattered booleans. Most duplication has already been extracted into `sdk-message-decode.ts` (verified — do not re-flag).

## 🚪 Public boundary (assess first)
- **API surface:** `index.ts` re-exports two adapter classes + singletons (`ClaudeAdapter`/`claudeAdapter`, `ClaudeAgentSdkAdapter`/`claudeAgentSdkAdapter`), `register`, the entire `claude/index.js` (detect/invoke/validate — ~18 functions+types), and the entire `agent-sdk/index.js` (`AgentSession`, `HooksBridge`, `PromptQueue`, `processSDKMessage`, plus a re-export of `query`/`tool`/`createSdkMcpServer` straight from `@anthropic-ai/claude-agent-sdk`).
- **Findings:**
  - `export * from './claude/index.js'` and `export * from './agent-sdk/index.js'` (index.ts:6–7) export the union of two large modules wholesale. Many functions (`invokeClaudeOrThrow`, `runClaudePrompt`, `formatClaudeCommand`, `getClaudeCommand`, `validatePluginsWithCollisionCheck`, `checkPluginNameCollisions`) are convenience/legacy helpers that may have no external caller — `export *` makes every one of them a Hyrum's-Law liability. (T07) Direction: narrow — but requires usage census across `hrc-runtime`/`acp` before contracting.
  - `agent-sdk/index.js:9` re-exports `createSdkMcpServer, query, tool` directly from the third-party SDK. This couples this package's public API to the SDK's surface: an SDK rename/removal silently breaks `spaces-harness-claude` consumers. (T07/T23)
- **Verdict:** 🟡 needs care — the boundary is sound in shape (two adapters + a register fn is the right spine) but over-wide via two `export *` barrels and a passthrough of a vendor surface. Contraction is public-surface → Expand/Contract only.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. Module-level Claude-detection cache is a hidden global seam — [T01] Introduce substitution seam
- **Location:** `claude/detect.ts:33` (`let cachedInfo: ClaudeInfo | null = null`), read/written by `detectClaude`, `getClaudePath`, mutated by `clearClaudeCache`.
- **Mechanism repaired:** shared mutable module state behind pure-looking functions. `detectClaude()`/`getClaudePath()` carry cross-call memory that is invisible at the call site and shared process-wide; the only way to reset it is the exported `clearClaudeCache()` (which exists *solely* for tests — a tell that the global is a test-seam leak).
- **Symptom that flagged it:** an exported `clearClaudeCache` whose sole purpose is to undo a module-global; `afterEach(clearClaudeCache)` in `detect.test.ts`.
- **Current → Suggested:** keep the free functions and their behavior, but back the cache with an injectable cache object / class instance (`class ClaudeDetector { #cached … }`) and have the module-level functions delegate to a default instance. Tests construct a fresh detector instead of mutating a global.
- **Direction:** isolate
- **Preservation:** test-suite — observable behavior (cache-on-first-call, path priority, throw-on-`ASP_CLAUDE_PATH`-miss) is preserved by keeping the default-instance delegation; existing tests still pass.
- **Falsifiable signal:** two independently-constructed detectors do not share cached state; the default-instance path still returns cached info on the second call.
- **Risk:** Med  ·  **API-impact:** public-surface (`clearClaudeCache` is exported; changing/removing it is a contract change)  ·  **Effort:** M
- **Tests:** existing `detect.test.ts`; add a per-instance isolation test.
- **Contraindication:** the cache is genuinely useful (avoids re-spawning `claude --version`); do NOT remove caching — only relocate it behind a seam. If no second consumer ever needs isolation, this can stay as a deliberate process-global.

### 2. `ClaudeAgentSdkAdapter` is a near-total pass-through — [T23] Remove middle man / collapse pass-throughs
- **Location:** `adapters/claude-agent-sdk-adapter.ts` (entire class — 11 of 12 members delegate verbatim to `claudeAdapter`; only `id`, output path, and the `harnessId` rewrite in `composeTarget`/`loadTargetBundle` differ).
- **Mechanism repaired:** a delegating-only class restates the full `HarnessAdapter` interface to vary three things (harness id, output subdir, bundle `harnessId` stamp). Each new adapter method must be added in two places forever.
- **Symptom that flagged it:** every method body is `return claudeAdapter.<same>(…)`; the only real logic is `{ ...bundle, harnessId: this.id }`.
- **Current → Suggested:** extract the variation into a small config (`{ id, outputSubdir }`) and have one adapter implementation parameterized by it, or have `ClaudeAgentSdkAdapter extends ClaudeAdapter` overriding only `id`, `getTargetOutputPath`, and the two `harnessId`-stamping methods. Behavior identical.
- **Direction:** remove (collapse the pass-through layer)
- **Preservation:** type/compiler-proof + test-suite — `claude-agent-sdk-adapter.test.ts` pins the delegation; inheritance/parameterization keeps the same method results.
- **Falsifiable signal:** `claude-agent-sdk-adapter.test.ts` stays green; bundles still carry `harnessId: 'claude-agent-sdk'`.
- **Risk:** Med  ·  **API-impact:** public-surface (the class + singleton are exported; consumers may `instanceof`)  ·  **Effort:** M
- **Tests:** `claude-agent-sdk-adapter.test.ts`.
- **Contraindication:** if the two adapters are expected to diverge soon (e.g. SDK-specific materialize), the duplication is deliberate option value — keep them separate and just dedup the bodies via a shared helper rather than inheritance.

### 3. `AgentSession` lifecycle is a boolean-soup state machine — [T10] Reify implicit state machine
- **Location:** `agent-sdk/agent-session.ts` — `state` enum (`'idle'|'running'|'stopped'|'error'`) plus a fleet of correlated booleans: `isListening`, `hasEmittedAgentStart`, `hasEmittedAgentEnd`, `stopEmitted`, `stopResolve`/`stopPromise`, `pendingTurnIds`, `currentSubagentContext` (lines 128–152).
- **Mechanism repaired:** the true session lifecycle (idle → running → stopped/error, with one-shot start/end/stop emissions) is encoded as ~6 independent latches that must be flipped in the right order across `start`/`stop`/`listenToOutput`/`processMessage`. "must call start before sendPrompt" is enforced only by an ad-hoc `if (this.state !== 'running') throw`.
- **Symptom that flagged it:** multiple `hasEmittedX`/`xEmitted` one-shot guards; `finally` block re-deriving terminal state; the comment-heavy `stop()`/`listenToOutput()` recovery paths.
- **Current → Suggested:** introduce a small explicit emission gate (`once(emitAgentStart)`) and centralize the legal transitions in one `transition(to)` method that owns the invariants, rather than each method poking `this.state` directly. This is a redesign-adjacent change — flag as **redesign** (it changes the internal control structure, not just shape), so land it behind characterization tests first.
- **Direction:** isolate (consolidate latches into one transition surface)
- **Preservation:** char-test — needs new characterization tests around the emission ordering (agent_start once, agent_end once, turn_end flushed on every exit path) BEFORE touching; current suite only covers `getMetadata`.
- **Falsifiable signal:** for any input sequence, `agent_start`/`agent_end` each emit exactly once and every `turn_start` gets a matching `turn_end`.
- **Risk:** High  ·  **API-impact:** internal-only (lifecycle is private; observable events unchanged)  ·  **Effort:** L
- **Tests:** add characterization tests over the event stream first; `agent-session.getMetadata.test.ts` is the only existing coverage.
- **Contraindication:** the guards are load-bearing on real crash paths (child-exit, abort, empty-resume). Do not collapse them naively — each `flushPendingTurns`/`emitStopIfNeeded` exists to unblock awaiting callers. Treat as redesign, not mechanical refactor.

### 4. `AgentSession.start()` carries a `console.log` and an in-band `process.*` shell pin — [T18]/[T01] (mixed)
- **Location:** `agent-sdk/agent-session.ts:206` (`env: { ...this.runtimeEnv.env, SHELL: SDK_CHILD_SHELL }`) and `:217` + `:539` `console.log` diagnostics.
- **Mechanism repaired:** diagnostics go straight to `console.log`/`console.error` throughout the session (start, init plugins, stop, listener failure). There is a clean `runtimeEnv` seam for pid/env but none for logging, so tests cannot assert or silence diagnostics and there is no level control.
- **Symptom that flagged it:** ~8 `console.*` calls embedded in lifecycle logic; a deliberate `RuntimeEnv` seam already exists for env/pid but logging was left un-seamed.
- **Current → Suggested:** add a `logger?` to `AgentSessionOpts` (defaulting to `console`) mirroring the existing `runtimeEnv` seam. Pure relocation of the sink.
- **Direction:** isolate
- **Preservation:** observational-equivalence — default logger is `console`, so output is byte-identical unless injected.
- **Falsifiable signal:** with an injected logger, no diagnostics reach `console`; default path unchanged.
- **Risk:** Low  ·  **API-impact:** internal-only (`AgentSessionOpts` is exported but additive-optional)  ·  **Effort:** S
- **Tests:** new test asserting injected logger receives `session.start` line.
- **Contraindication:** none significant; keep the exact message strings (they're grepped in ops — see MEMORY `HRC_LAUNCH_TIMING`/`[agent-sdk]` prefixes). Preserve the `[agent-sdk]` prefix verbatim.

### 5. `buildClaudeArgs` is a long sequential append chain — [T22] Guard clauses / flatten (minor) + data-clump observation
- **Location:** `claude/invoke.ts:122–180`.
- **Mechanism repaired:** 9 sequential `if (options.x) args.push(...)` blocks; readable but the ordering is load-bearing and untyped (the pinned ordering test at `detect.test.ts:58` proves callers depend on byte order). The append-mode/replace-mode precedence (`appendSystemPrompt` else `systemPrompt`, :163) is the one piece of real logic buried in the chain.
- **Symptom that flagged it:** flat 60-line builder with one branch carrying actual precedence semantics.
- **Current → Suggested:** leave the structure (it is clear and order-tested) but consider a declarative flag→args table only if a third caller appears. **Where-NOT likely applies today.**
- **Direction:** relocate (defer)
- **Preservation:** test-suite — `buildClaudeArgs` ordering is pinned.
- **Falsifiable signal:** N/A unless restructured.
- **Risk:** Low  ·  **API-impact:** public-surface (`buildClaudeArgs` exported + order-contracted)  ·  **Effort:** S
- **Tests:** `detect.test.ts` ordering cases.
- **Contraindication:** the flat form is honest and the order is a tested contract; a table would obscure the order without removing a real smell. Recommend leaving alone (listed for completeness).

### 6. `ClaudeInvokeOptions` is a 16-field god-options object spanning two concerns — [T21] Introduce parameter object / whole value
- **Location:** `claude/invoke.ts:30–61` (`ClaudeInvokeOptions`), consumed by `buildClaudeArgs` (CLI-flag fields only) and `invokeClaude`/`spawnClaude` (process fields: `cwd`/`env`/`captureOutput`/`timeout`).
- **Mechanism repaired:** one options bag mixes *argv-construction* fields (pluginDirs, model, settings, systemPrompt…) with *process-execution* fields (cwd, env, captureOutput, timeout). `buildClaudeArgs` reads only the former; `buildSpawnOptions` already had to `Pick<…, 'cwd' | 'env'>` (line 84) to carve the subset out — evidence the bag is two whole-values fused.
- **Symptom that flagged it:** the existing `Pick<ClaudeInvokeOptions, 'cwd' | 'env'>` workaround; `buildClaudeArgs` silently ignoring half the type's fields.
- **Current → Suggested:** split into `ClaudeArgsOptions` (flag fields) and `ClaudeProcessOptions` (cwd/env/capture/timeout), with `ClaudeInvokeOptions = ClaudeArgsOptions & ClaudeProcessOptions` preserved as the public alias. Internal functions take the narrow type. Behavior unchanged.
- **Direction:** isolate (separate the two whole-values; keep the union public)
- **Preservation:** type/compiler-proof — the union alias keeps every existing call type-compatible (Expand half: add new narrow types, keep old union).
- **Falsifiable signal:** `buildClaudeArgs` signature accepts only `ClaudeArgsOptions`; existing callers still compile against the union.
- **Risk:** Med  ·  **API-impact:** public-surface (`ClaudeInvokeOptions` exported)  ·  **Effort:** M
- **Tests:** `invoke.test.ts` (552 lines, broad).
- **Contraindication:** if no caller ever wants the narrow type, the union is fine as-is — this is mild. Route via Expand/Contract since the type is exported.

### 7. `convertContentBlock` reuses the tool-result handler table for non-tool blocks — [T15] (already extracted) — verify-only, where-NOT
- **Location:** `agent-sdk/sdk-message-decode.ts:96–188`.
- **Mechanism repaired (already done):** the previously copy-pasted block decoding is centralized in `TOOL_RESULT_BLOCK_HANDLERS` and shared by `normalizeToolResultBlocks` + `convertContentBlock`. This is a correct prior extraction.
- **Symptom that would have flagged it:** none remaining — duplication is gone.
- **Note:** `convertContentBlock` passes a throwaway `[]` for `textParts` (line 187). That is intentional (callers only want the block). Do NOT "fix" by changing the handler signature — the shared table is the right shape.
- **Direction:** none (leave alone)
- **Risk:** Low  ·  **API-impact:** public-surface (`convertContentBlock` exported)  ·  **Effort:** —
- **Contraindication:** this IS the where-NOT — the abstraction is load-bearing and shared by two real consumers (`agent-session` map + tool-result normalize). Flagging it as "premature" would be wrong.

### 8. Duplicated tool-event emission between `AgentSession` and `HooksBridge.processSDKMessage` — [T03] Relocate by affinity (observe, do not merge)
- **Location:** `agent-session.ts:697–775` (`handleToolBlocks`/`processToolUseBlock`/`processToolResultBlock`/`emitUserToolResultIfNeeded`) vs `hooks-bridge.ts:306–374` (`processSDKMessage`/`processToolUseBlock`/`processToolResultBlock`/`emitUserToolResultIfNeeded`).
- **Mechanism repaired:** the two walk the SAME blocks via the SAME shared `forEachToolBlock`/`isSynthesizableUserToolResult` predicates, but emit to two different sinks (UnifiedSessionEvent stream vs HookEventBus). The decode predicates are already shared; only the per-block *action* differs.
- **Symptom that flagged it:** structurally identical functions with the same names in both files, differing only in `this.emitEvent(...)` vs `bridge.emitPostToolUse(...)`.
- **Current → Suggested:** the eligibility logic is already centralized (correct). The remaining twin is the *iteration+dispatch* scaffolding. This is **defense-in-depth-adjacent / two sinks** — merging risks coupling the event stream to the hook bus. Recommend leaving as-is unless a third sink appears; if merged, do it via a shared `ToolBlockEmitter` visitor that both pass their sink into — preserving the exact emitted shapes.
- **Direction:** relocate (deferred — borderline coincidental-vs-shared)
- **Preservation:** char-test — would need event-shape characterization on both sinks before merging.
- **Falsifiable signal:** both sinks receive byte-identical events before/after.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** M
- **Contraindication:** the two sinks are genuinely independent (one feeds the unified session API, one the hook bus); the similarity may be coincidental and could diverge (the bus path has `emittedToolUseIds` dedup the session path lacks). Treat divergence as real — do NOT force-merge.

### 9. `shellQuote` regex literal is an untyped magic pattern reused in two spots — [T15] (minor)
- **Location:** `claude/invoke.ts:107–114` (`/^[a-zA-Z0-9_./-]+$/`).
- **Mechanism repaired:** the "safe-token" character class is an inline literal in `shellQuote`; `formatClaudeCommand` maps every arg through it. Low severity, single concept, single use site for the literal.
- **Symptom that flagged it:** a security-relevant regex inline with no name.
- **Current → Suggested:** name it `const SHELL_SAFE_TOKEN = /…/` for documentation. Behavior identical.
- **Direction:** isolate
- **Preservation:** observational-equivalence — same regex, same matches.
- **Falsifiable signal:** `formatClaudeCommand` quoting unchanged for spaces/quotes/plain tokens.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Contraindication:** trivial; only worth doing alongside other invoke.ts edits.

## 🪶 Deliberately left alone (where-NOT)
- **`sdk-message-decode.ts` handler table** — a correct, already-landed T15 extraction shared by two real consumers. Re-flagging as premature abstraction would be wrong (#7).
- **Twin tool-emission scaffolding (#8)** — two genuinely independent sinks with one already diverging (`emittedToolUseIds` dedup only on the bus path). Force-merging would couple the unified event stream to the hook bus; treat the copies as load-bearing until a third sink materializes.
- **`buildClaudeArgs` flat append chain (#5)** — order is a tested public contract; the flat form is honest. A dispatch table would hide the ordering without removing a real smell.
- **Model alias list in `ClaudeAdapter.models`** — the `CLAUDE_*`/`ALIAS_*` constants are imported from `spaces-config` (single source of truth in `config/src/core/models.ts`); no drift or primitive-obsession here. Per MEMORY (`no-model-version-pinning`), aliases are correct — leave as-is.
- **`PromptQueue`** — small, focused, single-responsibility async queue with a tested close/wake invariant. No mechanism applies.

## 🔭 If applying: outside-in sequence
1. **Boundary census first** (#1 `clearClaudeCache`, #2 adapter passthrough, #6 options type) — these are public-surface; run a grep across `hrc-runtime`/`acp`/`cli` for each exported symbol before any Expand/Contract.
2. Land Low-risk internal isolations: #4 logger seam, #9 named regex.
3. #6 options split via Expand (add narrow types, keep union alias) — compiler-proof, low blast radius.
4. #2 adapter collapse via inheritance/parameterization — behind the existing adapter test.
5. #1 detection-cache seam — behind existing detect tests; keep default-instance delegation.
6. **Defer to redesign tasks:** #3 (AgentSession state machine — needs characterization tests first) and #8 (twin emitters — needs dual-sink characterization). Do NOT auto-apply.

## ✅ Safety checklist
- [ ] No `export *`-contracted symbol removed without a downstream usage census (Hyrum's Law).
- [ ] `ClaudeInvokeOptions` / `clearClaudeCache` / adapter classes changed only via Expand/Contract (public-surface).
- [ ] `[agent-sdk]` log message strings preserved verbatim (ops greps them).
- [ ] No `{...obj, harnessId}` spread changed in a way that drops/forwards extra bundle fields (#2 must preserve the exact field set).
- [ ] AgentSession event ordering (agent_start/agent_end once; turn_end on every exit path) characterized before #3.
- [ ] `detect` cache behavior (first-call memo, ASP_CLAUDE_PATH-miss throw) green after #1.
- [ ] Any deduped regex literal carries a `// biome-ignore` only if a lint (e.g. control-char class) fires.
