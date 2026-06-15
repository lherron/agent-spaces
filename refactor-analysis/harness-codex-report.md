# 🔧 Refactoring Analysis — spaces-harness-codex

**Target:** `packages/harness-codex/src`  ·  **Files read:** 14 source (+6 test files read for contracts)  ·  **Lines:** 2945 (source)
**Generated:** 2026-06-14  ·  **Package type:** general (harness adapter + JSON-RPC session driver)

## 🧭 Summary
The package is a Codex CLI harness: a `HarnessAdapter` (materialize/compose/run-args) plus a long-lived `CodexSession` and a headless `runCodexAppServerOneShot`, both driving the same `codex app-server` JSON-RPC protocol. The public boundary is large but coherent and well-typed. The highest-leverage structural debt is internal: a duplicated JSON-RPC notification-routing switch across the two RPC consumers, a duplicated `buildUserInputs`, and one piece of threaded-through dead config (`templateDir`). No behavior-changing redesigns are required; all findings preserve observable behavior.

## 🚪 Public boundary (assess first)
- **API surface (index.ts):** `CodexAdapter`, `codexAdapter` (singleton), `DEFAULT_CODEX_CLI_MODEL`, `DEFAULT_CODEX_ENABLED_FEATURES`, `CODEX_INTERACTIVE_HOOK_EVENTS`, hook helpers (`addCodexHookTrustState`, `buildHrcCodexHooksConfig`, `buildCodexHookTrustState`, `trustCodexHooksInConfigToml`), AGENTS helpers (`applyPraesidiumContextToCodexHome`, `renderPraesidiumContextBlock`), `buildCodexAppServerLaunchDescriptor`, types (`CodexAppServerLaunchDescriptor`, `PraesidiumContext`); `register`; and the whole `codex-session/index.ts` re-export (`CodexSession`, `runCodexAppServerOneShot`, `CodexSessionConfig`, `CodexApprovalPolicy`, `CodexSandboxMode`, one-shot option/result types).
- **Findings:** The surface is intentionally wide because it serves both ASP compose and the HRC broker drivers (hook-trust helpers are cross-repo consumers — see `JSON_RPC_ERROR_PREFIX`/`trustCodexHooksInConfigToml` doc comments). No leaky-abstraction or fat-interface defect at the boundary itself. One latent risk: `CodexSessionConfig.templateDir` is part of the public type but is never read (see Finding 4) — removing it is a public-surface contraction (M02).
- **Verdict:** 🟢 sound — wide but each export has a real external consumer; the one dead field routes through Expand/Contract.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. Duplicated JSON-RPC notification-routing switch across the two RPC consumers — [T15] Extract missing abstraction / [T03] Relocate by affinity
- **Location:** `codex-session/codex-session.ts:296-388` (`handleNotification`) vs `codex-session/run-one-shot.ts:110-191` (`handleNotification`)
- **Mechanism repaired:** A single protocol concept (codex app-server notification → unified event) is decoded in two places. The *item* mapping was already lifted into `event-mapping.ts`, but the notification *dispatch* (method-string → which mapper + emit) is still duplicated. Each new app-server notification method must be added in two switch arms or one consumer silently drops it — the exact failure mode the pre-hrc conformance doctrine warns against (a missing event = a driver gap).
- **Symptom that flagged it:** Two `switch (notification.method)` blocks over the same case labels (`error`, `turn/started`, `item/started`, `item/completed`, `item/agentMessage/delta`, the three `outputDelta`/`progress` cases, `turn/completed`).
- **Current → Suggested:** Extract a pure `classifyNotification(method, params)` in `event-mapping.ts` that returns the common `UnifiedSessionEvent[]` (the cases shared verbatim: `item/agentMessage/delta`, the delta/progress trio, `turn/started`). Each consumer keeps only its private glue (`CodexSession`'s `turnArtifacts`/`pendingTurn` bookkeeping; one-shot's `tokenUsage`, `finalOutput`-from-turn, queue). Do NOT collapse the two consumers into one — sync vs async-queued emit and the turn-resolution machinery legitimately differ.
- **Direction:** relocate (lift shared arms into the existing event-mapping seam)
- **Preservation:** test-suite — `event-mapping` already has the pure mappers under test; extracting the shared dispatch arms is type-checked and the two consumers' tests (`codex-session.test.ts`, `run-one-shot.test.ts`) pin observed events.
- **Falsifiable signal:** after extraction, deleting an arm from the shared classifier breaks BOTH consumers' tests simultaneously (today it breaks one).
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** M
- **Tests:** existing event-emission tests on both consumers; add a direct unit test on the extracted classifier.
- **Contraindication:** the divergent arms (`turn/completed`, `thread/tokenUsage/updated`, `error` formatting) are genuinely different per consumer — leave those in place; only the verbatim-identical arms are dedup-safe.

### 2. Duplicated `buildUserInputs` with divergent attachment handling — [T15] Extract missing abstraction (partial)
- **Location:** `codex-session/codex-session.ts:488-523` (async, `AttachmentRef[]`, image-size guard, URL handling) vs `codex-session/run-one-shot.ts:314-323` (sync, `string[]` image paths only)
- **Mechanism repaired:** Both build the codex `input` array `[{ type: 'text', text, text_elements: [] }, ...]`. The text-seed shape (`text_elements: []`) is the recurring concept duplicated; the attachment expansion legitimately differs (session accepts rich `AttachmentRef`, one-shot accepts bare image paths). Only the seed/`localImage` shape is shared.
- **Symptom that flagged it:** Identical literal `{ type: 'text', text, text_elements: [] }` seed and identical `{ type: 'localImage', path }` shape in two files.
- **Current → Suggested:** Extract a small `textInput(text)` + `localImageInput(path)` helper (or a `CODEX_INPUT_TEXT_SEED` builder) in `event-mapping.ts` or a new `codex-input.ts`; keep each consumer's attachment-policy loop local.
- **Direction:** relocate (lift the shape constructors, not the policy)
- **Preservation:** type/compiler-proof — pure value constructors; the produced array is byte-identical.
- **Falsifiable signal:** snapshot of the produced `input` array for a text-only prompt is identical pre/post.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** both consumers already exercise turn/start with a prompt; add a unit test on the seed constructor.
- **Contraindication:** do NOT unify the two attachment loops — they consume different input types and one has a size guard the other intentionally lacks; merging would be coincidental similarity that will diverge.

### 3. Five interactive-launch tool kinds repeat the same `tool_execution_start`/`end` projection — [T19] Conditional ↔ dispatch (leave as-is) / contra-flag
- **Location:** `codex-session/event-mapping.ts:188-264` (`mapItemStarted`), `:271-378` (`mapItemCompleted`)
- **Mechanism repaired:** N/A — assessed and **declined**. The per-`type` arms look like a growing type-switch, but each arm extracts a *different* field set (`command/cwd`, `changes`, `server/tool/arguments`, `query`, `path`) and produces different `toolName`/`result` shapes. A data-driven dispatch table would have to carry per-type projection functions anyway — no net structural simplification, and the explicit `Extract<...>` casts are what makes the field access type-safe.
- **Symptom that flagged it:** repeated `case '<type>': const x = item as Extract<...>` shape.
- **Direction:** none (where-NOT)
- **Risk:** —  ·  **API-impact:** internal-only
- **Contraindication:** this is the canonical "one arm per real protocol variant" — each variant is a distinct codex item type, not an accidental enum; collapsing it would obscure the field contracts. Left alone.

### 4. `CodexSessionConfig.templateDir` is threaded through but never read — [T16] Collapse premature abstraction
- **Location:** type `codex-session/types.ts:56`; wired in `register.ts:21` (`templateDir: options.codexTemplateDir`); **zero reads** anywhere in the package.
- **Mechanism repaired:** A config field whose variation never materializes. It is forwarded from `register` into the constructor and stored, but `CodexSession.start()` never consults it — the codex home is supplied via `homeDir`/`CODEX_HOME`. This is structure for a flexibility that does not exist.
- **Symptom that flagged it:** `grep templateDir` over non-test source returns only the declaration (types.ts) and the pass-through (register.ts); no consumer.
- **Current → Suggested:** Remove `templateDir` from `CodexSessionConfig` and the `register.ts` spread. Because `CodexSessionConfig` is a re-exported public type, route via Expand/Contract (M02): deprecate the field first if any external caller sets it, then remove.
- **Direction:** remove
- **Preservation:** type/compiler-proof — field is never read, so removal cannot change runtime behavior; only callers that *set* it (compile-time) are affected.
- **Falsifiable signal:** delete the field; `tsc` over the workspace surfaces every external setter — if none outside `register.ts`, removal is observationally inert.
- **Risk:** Low (behavior) / Med (it is a public type)  ·  **API-impact:** public-surface  ·  **Effort:** S
- **Tests:** no behavioral test covers it (because it does nothing); workspace typecheck is the gate.
- **Contraindication:** if `templateDir` is a deliberately-reserved option for a near-term feature, keep it but document the intent — confirm with the owner before removing.

### 5. `CodexSession` state lives in scattered booleans/optionals rather than a reified machine — [T10] Reify implicit state machine
- **Location:** `codex-session/codex-session.ts:74-86` (state + `pendingTurn` + `currentTurnId` + `threadId`), guards at `:100-101`, `:189`, `:226-228`, `:233`, `:276`
- **Mechanism repaired:** The lifecycle (`idle → running → streaming → running`, plus `error`/`stopped`) is encoded as a `UnifiedSessionState` string PLUS several independently-nullable companions (`pendingTurn` only valid while streaming; `threadId` only set after start). Invariants are re-checked at many sites (`if (this.state !== 'running' || !this.rpc || !this.threadId)`), and the `finally` at :226 conditionally rolls `streaming→running` because async handlers may have raced the state. This is the "must call start() first / boolean-soup" smell.
- **Symptom that flagged it:** repeated multi-clause state guards; the comment at :224-225 ("state may have changed to 'error' or 'stopped' via async handlers"); `pendingTurn` set/cleared in 4 places.
- **Current → Suggested:** Modest reification: a small private discriminated state (`{ phase:'idle' } | { phase:'running', rpc, threadId } | { phase:'streaming', rpc, threadId, pendingTurn } | ...`) makes `rpc`/`threadId`/`pendingTurn` non-optional within the phase that owns them, replacing the scattered `!this.rpc || !this.threadId` guards with one narrow. This is a redesign-adjacent change — flag as **behavior-preserving only if** the same errors throw on the same illegal transitions; verify against `codex-session.test.ts` state assertions.
- **Direction:** isolate (encode invariants in the type)
- **Preservation:** char-test < test-suite — needs the session's state/error tests to pin transition behavior before refactoring; the public `getState()`/`getMetadata()` outputs must be unchanged.
- **Falsifiable signal:** `getState()` returns the identical `UnifiedSessionState` value for every existing test scenario; the same `Error` messages throw from `start`/`sendPrompt` in the wrong state.
- **Risk:** Med  ·  **API-impact:** internal-only (state machine is private; `getState()` contract preserved)  ·  **Effort:** M
- **Tests:** existing `codex-session.test.ts` lifecycle tests; add transition-table characterization before editing.
- **Contraindication:** the `streaming→running` `finally` rollback and the `error`-wins precedence (`handleError` early-returns if already `error`) are real race-safety logic, not redundancy — any reification must preserve that precedence exactly, or it is a behavior change.

### 6. Per-key conditional `targetOverrides` build is a data-clump mapping — [T15]/[T03] (minor)
- **Location:** `adapters/codex-adapter.ts:580-604` (`composeTarget`, the `if (codexOptions.X) targetOverrides['Y'] = ...` block)
- **Mechanism repaired:** Six near-identical `if (opt.field) out[key] = opt.field` lines map `CodexOptionsWithStatusLine` → dotted-key override record. The recurring intent ("copy present option fields under their toml keys") is open-coded; the only irregular case is `status_line → tui.status_line`.
- **Symptom that flagged it:** six-line copy-with-rename clump.
- **Current → Suggested:** A small `[from, to][]` table iterated once. Low value but reduces the per-field add cost. Optional.
- **Direction:** relocate/extract (table-drive)
- **Preservation:** type/compiler-proof — identical record produced for identical input.
- **Falsifiable signal:** snapshot of `targetOverrides` for a fully-populated `codexOptions` is unchanged.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** `composeTarget` config-output tests.
- **Contraindication:** the `status_line` rename is the lone irregular row — the table must carry the per-field key, not assume identity, or it changes the emitted toml key.

### 7. `loadTargetBundle` repeats three identical `stat`-then-throw existence guards — [T15] Extract missing abstraction (minor)
- **Location:** `adapters/codex-adapter.ts:709-722`
- **Mechanism repaired:** Three copies of `const s = await stat(p); if (!s.isFile()/isDirectory()) throw new Error('... not found: ' + p)`. Same intent, repeated.
- **Symptom that flagged it:** three back-to-back stat+throw blocks differing only by path and label.
- **Current → Suggested:** `assertExists(path, kind: 'file'|'dir', label)` helper. Minor.
- **Direction:** extract
- **Preservation:** observational-equivalence — the thrown messages must match exactly (callers/tests may assert on "Codex config.toml not found: ..."); preserve the label strings verbatim.
- **Falsifiable signal:** error message strings byte-identical for each missing-artifact case.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** `loadTargetBundle` missing-file tests if present; otherwise add characterization on the messages first.
- **Contraindication:** if any consumer string-matches a specific message, the helper must reproduce it exactly — do not "improve" the wording.

## 🪶 Deliberately left alone (where-NOT)
- **`event-mapping.ts` per-item-type switches (Finding 3)** — each arm is a genuine protocol variant with a distinct field set; dispatch-table conversion yields no simplification and loses type-safe field extraction.
- **`spawnProc` injection seam (`types.ts:66`, used `codex-session.ts:119`)** — a deliberate, *used* substitution seam for unit-testing the session against a fake process (mirrors one-shot's injected `proc`). Not a premature abstraction; do NOT remove.
- **`buildExecArgs` / `buildResumeArgs` / `buildInteractiveArgs` three-way split (`codex-adapter.ts:248-326`)** — dispatched once in `buildRunArgs` by `interactive`/`continuationKey`; each builds a materially different argv (app-server vs `resume` vs fresh TUI). This is correct conditional→function decomposition, not duplication.
- **`errorMessage`/`toError` (`errors.ts`)** — small shared whole-value normalizers, already the single source; correctly reused across files.
- **Hook-trust hashing canonicalization (`codex-hooks.ts`)** — intricate but each step is load-bearing for byte-stable `trusted_hash` agreement with codex-cli; the doc comments justify the bypass-flag and key-source choices. Leave structure intact.
- **`--dangerously-bypass-hook-trust` flag (`codex-adapter.ts:286`)** — documented deliberate behavior (T-01798), interactive-only; not a smell.
- **Wide public export surface** — each export has a real cross-repo consumer (HRC broker drivers, ASP compose); not over-broad.

## 🔭 If applying: outside-in sequence
1. **Finding 4 (templateDir removal)** — public-surface; run Expand/Contract via the owner. Do first so the type is clean before touching the session.
2. **Finding 1 (notification-routing classifier)** — highest internal leverage; lift only the verbatim-identical arms into `event-mapping.ts`, leave divergent arms local.
3. **Finding 2 (input-seed constructors)** — small, sits next to Finding 1's work.
4. **Findings 6 & 7 (table-drive overrides, assertExists)** — mechanical, low risk.
5. **Finding 5 (state-machine reification)** — last; needs a characterization harness on transitions first, and is the only redesign-adjacent item.

## ✅ Safety checklist
- [ ] Characterize `CodexSession` transitions + `getState()`/`getMetadata()` outputs before Finding 5.
- [ ] Preserve exact thrown error-message strings (Findings 5, 7) — they are part of observable behavior.
- [ ] Workspace `tsc` after Finding 4 to enumerate any external `templateDir` setters before removal.
- [ ] Finding 1: confirm a deleted shared arm breaks BOTH consumers' tests (proves the dedup is real and covered).
- [ ] Re-run both `codex-session.test.ts` and `run-one-shot.test.ts` event-emission assertions after Findings 1–2.
- [ ] No `{...obj}` projection introduced that forwards extra props (none required by these findings).
- [ ] If table-driving (Finding 6) introduces a literal-comparison lint, add a scoped `// biome-ignore`.
