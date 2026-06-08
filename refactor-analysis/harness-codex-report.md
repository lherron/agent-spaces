# harness-codex SOLID / code-smell audit

Package: `packages/harness-codex/` (npm: `spaces-harness-codex`)
Audited: all non-test source under `src/` (adapters/, codex-session/, errors.ts, index.ts, register.ts).

## Overall

This package was part of the repo-wide SOLID cleanup pass (commit e238805) and is in good
shape. The adapter is already split into focused modules (`codex-config`, `codex-agents`,
`codex-discovery`, `codex-hooks`), the shared app-server event mapping has already been
deduped into `event-mapping.ts`, and helper extraction (`probeCodexCandidate`,
`appendInteractiveCommonFlags`, `buildExecArgs`/`buildResumeArgs`/`buildInteractiveArgs`)
is clean and well-commented. Findings below are mostly residual duplication between the two
JSON-RPC consumers (`codex-session.ts` and `run-one-shot.ts`) that the dedupe pass did not
fully collapse, plus a couple of small magic-value items. Nothing is a structural problem.

---

## Redundant local interface declarations duplicate event-mapping exports
- File: packages/harness-codex/src/codex-session/codex-session.ts:46
- Risk: Low
- API-impact: internal-only
- Smell: `ThreadStartResponse` (line 46) and `ThreadResumeResponse` (line 50) are declared
  locally, but identical interfaces are already exported from `event-mapping.ts:60` and
  consumed by `run-one-shot.ts`. The session file already imports many types from
  `event-mapping.js`, so these two locals are duplicated definitions of the same shape.
- Proposed change: delete the two local interfaces and add `ThreadStartResponse`,
  `ThreadResumeResponse` to the existing `import type { ... } from './event-mapping.js'`
  block. Purely internal; the casts on lines 163/176 stay structurally identical.

## Duplicated `CLIENT_INFO` constant across both RPC consumers
- File: packages/harness-codex/src/codex-session/run-one-shot.ts:23
- Risk: Low
- API-impact: internal-only
- Smell: The `CLIENT_INFO = { name: 'agent-spaces', version: process.env['npm_package_version'] ?? 'unknown' }`
  literal is identical in `codex-session.ts:41` and `run-one-shot.ts:23`.
- Proposed change: define it once (e.g. export `const CLIENT_INFO` from `event-mapping.ts`
  or a small `rpc-protocol.ts`) and import it into both files. Both are internal modules
  (not re-exported), so this is behavior-preserving and internal-only.

## Duplicated `formatCodexError` helper across both RPC consumers
- File: packages/harness-codex/src/codex-session/run-one-shot.ts:350
- Risk: Low
- API-impact: internal-only
- Smell: `formatCodexError` exists in both `codex-session.ts:496` and `run-one-shot.ts:350`.
  The `details`/`info` tail-construction is byte-identical; only the header prefix differs
  (session builds a `turn/thread/will retry` header, one-shot uses the fixed
  `'Codex app-server error'`).
- Proposed change: extract a shared `formatCodexErrorBody(params)` (the message+details+info
  tail) into `event-mapping.ts` and have each file prepend its own header. Both call sites
  are internal; the emitted error strings are unchanged.

## Repeated `tool_execution_update` delta cases in the notification switch
- File: packages/harness-codex/src/codex-session/codex-session.ts:380
- Risk: Med
- API-impact: internal-only
- Smell: The `item/commandExecution/outputDelta` (380), `item/fileChange/outputDelta` (390)
  and `item/mcpToolCall/progress` (400) cases each emit a near-identical
  `tool_execution_update` event (toolUseId/partialOutput-or-message/payload). The same
  triple is mirrored in `run-one-shot.ts:160/170/180`.
- Proposed change: extract a small private helper `mapDeltaNotification(method, params)` in
  `event-mapping.ts` that returns the unified `tool_execution_update` event for these
  delta/progress methods, and call it from both switches. Tagged Med because it restructures
  the internal notification-dispatch flow in two files; behavior-preserving.

## Parallel notification-method switches not sharing a dispatch path
- File: packages/harness-codex/src/codex-session/run-one-shot.ts:107
- Risk: Med
- API-impact: internal-only
- Smell: `handleNotification` in `run-one-shot.ts:107` and `codex-session.ts:304` are large
  parallel switches over the same `notification.method` set (`error`, `turn/started`,
  `item/started`, `item/completed`, the three deltas, `turn/completed`). Item-started and
  item-completed handling is already deduped via `mapItemStarted`/`mapItemCompleted`; the
  surrounding `emitEvent` wiring is still copy-paste.
- Proposed change: factor the shared item/delta-mapping arms into one pure mapper (see prior
  finding) so each switch keeps only its own lifecycle glue (turn-completion resolution,
  artifact accumulation). Med because it touches both consumers' control flow.

## Magic JSON-RPC error code/string in resume-recovery guard
- File: packages/harness-codex/src/codex-session/run-one-shot.ts:322
- Risk: Low
- API-impact: internal-only
- Smell: `isNoRolloutFoundResumeError` hard-codes `/^JSON-RPC error -32600:/i` — the `-32600`
  code and the `JSON-RPC error ` prefix are produced by `rpc-client.ts:154`. The coupling to
  that prefix string is implicit and only enforced by a regex literal.
- Proposed change: name the prefix/format once (or expose a `JSON_RPC_ERROR_PREFIX` constant
  from `rpc-client.ts`) and reference it from the matcher, so the producer and the matcher
  can't silently drift. Internal-only; behavior-preserving.

## Repeated thread/start + thread/resume param objects
- File: packages/harness-codex/src/codex-session/run-one-shot.ts:209
- Risk: Low
- API-impact: internal-only
- Smell: The `thread/start` and `thread/resume` param objects (run-one-shot.ts:209 & 222) and
  again in `codex-session.ts:151 & 166` repeat the same long list of `…: null` fields
  (modelProvider/config/baseInstructions/developerInstructions, etc.). The defaults are
  copy-pasted across four sites.
- Proposed change: add small builders (e.g. `buildThreadStartParams(...)` /
  `buildThreadResumeParams(...)`) co-located with the shared protocol types so the null-field
  boilerplate lives once. Behavior-preserving; both files are internal.

## Terse single-letter locals in version comparison loop
- File: packages/harness-codex/src/adapters/codex-discovery.ts:29
- Risk: Low
- API-impact: internal-only
- Smell: `isVersionAtLeast` uses `i`, `p`, `m` for index/parsed/min — terse locals in a
  numeric-comparison loop. Minor readability only.
- Proposed change: rename to `index`, `current`, `minimum` (locals only — the exported
  function signature is untouched).

---

## Notes / non-findings

- `event-mapping.ts` is the single source of truth for the `CodexThreadItem` union and the
  item mappers; the `as Extract<...>` narrowing per case is verbose but type-safe and
  intentional — not flagged.
- `codex-hooks.ts` is dense (canonical-JSON hashing, trust-state keying) but each function has
  one clear job and is well-named; its literals are already named constants
  (`DEFAULT_HOOK_TIMEOUT_SECONDS`, label/matcher maps). No action.
- `composeTarget` in `codex-adapter.ts` is long (~170 lines) but is a linear materialization
  pipeline with already-extracted helpers; splitting it further risks obscuring the ordered
  side-effect sequence. Not flagged (would be Med-at-best and low value).
- `errors.ts`, `index.ts`, `register.ts`, `types.ts`, `codex-config.ts`, `codex-agents.ts` are
  clean.

No High-risk or public-surface findings: every item above is behavior-preserving and confined
to non-exported internals.
