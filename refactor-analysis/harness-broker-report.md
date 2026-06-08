# harness-broker SOLID / code-smell audit

Package: `packages/harness-broker/` (npm name `spaces-harness-broker`)
Audited: every non-test `.ts` under `src/` (42 source files, ~10k LOC).

## Overall assessment

This package was the subject of a deliberate SOLID/code-smell cleanup pass in the
most recent commit (`e238805 refactor(packages): SOLID/code-smell cleanup pass
across all 17 packages`). It shows: per-policy lookup tables instead of if-chains
(`busyPolicyHandlers`, `inferDriverHealth`), pure parsers split out of stateful
classes (`tmux-parse.ts`, `tmux-env.ts`), named constants with traceability
comments, guard-clause de-nesting, and a single shared inspection-summary builder
to prevent projection drift. Long functions that remain (e.g. the hook
normalizers, `invocation-manager.applyEventState`) are genuinely irreducible
dispatch tables over an external event vocabulary and are already factored into
named helpers.

Findings below are mostly cross-file micro-duplication of tiny private helpers.
None are urgent. A few are deferred only because they touch the public `index.ts`
surface or carry behavior-change risk.

---

## Duplicated USER_INITIATED_END_REASONS set across the two tmux hook normalizers
- File: packages/harness-broker/src/drivers/codex-cli-tmux/hook-events.ts:23
- Risk: Low
- API-impact: internal-only
- Smell: `new Set(['prompt_input_exit', 'logout', 'clear'])` is byte-identical to
  `USER_INITIATED_END_REASONS` in claude-code-tmux/hook-events.ts:22. Same literal
  set maintained in two driver modules.
- Proposed change: lift the set to a shared internal module (e.g.
  `drivers/tmux-shared.ts`) as `USER_INITIATED_END_REASONS` and import it in both
  normalizers. Behavior-preserving; the related `SESSION_LEAVE_REASONS` in
  invocation-manager.ts:73 is a deliberately smaller set (no `clear`) and should
  stay distinct.

## Duplicated JSON-poke helpers (getString/getNumber/asHookRecord/unwrapHookPayload/asRecord)
- File: packages/harness-broker/src/drivers/claude-code-tmux/hook-events.ts:682
- Risk: Low
- API-impact: internal-only
- Smell: `getString`, `getNumber`, `unwrapHookPayload`, `asHookRecord`/`asRecord`
  are re-declared with identical bodies across claude-code-tmux/hook-events.ts,
  claude-code-tmux/hook-transcript.ts:169/179, codex-cli-tmux/hook-events.ts:277/335,
  codex-cli-tmux/hook-transcript.ts:341/346, and codex-cli-tmux/driver.ts:402/409.
- Proposed change: extract a single internal `hook-json.ts` (or add to
  `tmux-shared.ts`) exporting `getString`/`getNumber`/`asRecord`/`unwrapHookPayload`
  and import everywhere. Pure functions; no behavior change.

## Duplicated `sleep` helper and inline setTimeout-promises
- File: packages/harness-broker/src/runtime/tmux.ts:535
- Risk: Low
- API-impact: internal-only
- Smell: `sleep(ms)` is defined locally in tmux.ts:535 and again in
  tmux-shared.ts:21; tmux.ts:240 (`sendPastedLine`) also open-codes the same
  `new Promise((resolve) => setTimeout(resolve, 1_000))` inline instead of calling
  the local `sleep`.
- Proposed change: have tmux.ts use a single `sleep` (import from a shared runtime
  util or reuse the local one at line 240). Behavior-preserving.

## Unnamed submit-gap magic literal in TmuxManager send paths
- File: packages/harness-broker/src/runtime/tmux.ts:232
- Risk: Low
- API-impact: internal-only
- Smell: `TmuxManager.sendKeys` (line 233) and `sendPastedLine` (line 240) use a
  bare `1_000`/`1000` ms gap, while the controller path names the analogous value
  `LEGACY_PASTE_GAP_MS` (line 106) and the codex driver names it
  `INPUT_SUBMIT_GAP_MS`. The raw literal in `TmuxManager` is the odd one out.
- Proposed change: introduce a module-level named constant (e.g.
  `MANAGER_SEND_KEYS_GAP_MS = 1_000`) and reference it in both `TmuxManager`
  methods. Value-identical, no behavior change.

## Collapsible duplicate `unsupported` branches in codex interrupt()
- File: packages/harness-broker/src/drivers/codex-app-server/driver.ts:438
- Risk: Low
- API-impact: internal-only
- Smell: `interrupt()` returns two nearly identical
  `{ accepted: false, effect: 'unsupported', reason: '...' }` objects, branching
  only on `req.scope === 'turn'` to vary the reason string — an if/else where the
  shape is constant.
- Proposed change: compute the `reason` string from `req.scope` and return a single
  response object. The two reason strings are internal/diagnostic (not asserted by
  the protocol contract), so keep the wording byte-identical to preserve behavior.

## `broker_${process.pid}` instance-id computed in two places
- File: packages/harness-broker/src/cli.ts:235
- Risk: Low
- API-impact: internal-only
- Smell: `brokerInstanceId = broker_${process.pid}` is computed in cli.ts:235 and
  independently defaulted in broker.ts:135 (`options.brokerInstanceId ?? broker_${process.pid}`).
  The cli passes its own copy into the broker, duplicating the format string.
- Proposed change: let `runUnix` omit `brokerInstanceId` and rely on the broker's
  own default (already `broker_${process.pid}`), or export a tiny
  `defaultBrokerInstanceId()` helper. Behavior-identical (same pid, same format).

## `applyEventState` switch is a long multi-responsibility function
- File: packages/harness-broker/src/invocation-manager.ts:495
- Risk: Med
- API-impact: internal-only
- Smell: ~150-line switch projecting every event type into many `inv.*` fields —
  multiple concerns (pid capture, turn lifecycle, terminal handling, queue
  eviction) in one function. Already partly factored, but large.
- Proposed change: OPTIONAL split into per-group private helpers
  (`applyHarnessLifecycle`, `applyTurnLifecycle`, `applyTerminal`) dispatched from
  the switch. Med risk because it restructures the manager's central state-machine
  flow and the `turn.completed` fall-through to the shared turn-end case is subtle;
  worth a careful diff + full manager test run if attempted. Not auto-applied.

---

## Deferred (High-risk OR public-surface)

## index.ts exports an internal hook-normalizer factory asymmetrically
- File: packages/harness-broker/src/index.ts:31
- Risk: High
- API-impact: public-surface
- Smell: `index.ts` re-exports `createCodexCliTmuxHookEventNormalizer` and
  `CODEX_CLI_TMUX_DRIVER_KIND` from the codex-cli driver but does NOT export the
  symmetric `createClaudeCodeHookEventNormalizer` / `CLAUDE_CODE_TMUX_DRIVER_KIND`
  nor `createCodexAppServerDriver` — an asymmetric public surface that looks like
  it may be an oversight rather than intent.
- Proposed change: DEFER. Either adding or removing exports changes the package's
  public API; a human must decide which symbols are meant to be public.

## buildThreadStartParams / buildTurnStartParams duplicate the codex spec defaults
- File: packages/harness-broker/src/drivers/codex-app-server/driver.ts:558
- Risk: Med
- API-impact: public-surface
- Smell: `buildThreadStartParams` (driver.ts) and `buildTurnStartParams` (input.ts)
  independently derive `approvalPolicy ?? 'never'`, `model ?? null`, and the
  sandbox encoding from the same `CodexAppServerDriverSpec`. Both are `export`ed.
- Proposed change: DEFER. Both functions are exported (public-surface) and feed the
  native Codex RPC wire shape; consolidating the defaults risks altering one call's
  params. A human should confirm the two native calls truly want identical defaults
  before deduping.

---

## Summary counts
- Auto-applicable (Low/Med AND internal-only): 7
- Deferred (High-risk OR public-surface): 2
