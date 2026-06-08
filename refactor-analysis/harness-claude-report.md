# harness-claude (spaces-harness-claude) — SOLID / code-smell audit

Audited every non-test source file under `packages/harness-claude/src/`. The
package was refactored in the most recent repo-wide pass (commit e238805) and is
in good shape: decode logic is centralized in `sdk-message-decode.ts` behind a
handler table, helpers are extracted, guard clauses are used throughout. The
findings below are the genuine residue — mostly small dedupe / named-constant /
dead-entry items. No god objects or behavior changes proposed.

## Duplicate path entry in COMMON_CLAUDE_PATHS
- File: packages/harness-claude/src/claude/detect.ts:52
- Risk: Low
- API-impact: internal-only
- Smell: Dead / redundant data — `'/usr/local/bin/claude'` is listed twice in the
  `COMMON_CLAUDE_PATHS` array (line 49 "Homebrew Intel" and line 52 "Linux
  standard locations"). The second occurrence is never reachable as a distinct
  check; `isExecutable` already returned for it on the first pass.
- Proposed change: Remove the duplicate line 52 entry (keep one
  `'/usr/local/bin/claude'`), leaving the comment grouping intact. Pure dead-data
  removal; search order for every other path is unchanged.

## Repeated `sdk-tool-` fallback-id prefix (magic string across two files)
- File: packages/harness-claude/src/agent-sdk/agent-session.ts:618
- Risk: Low
- API-impact: internal-only
- Smell: Magic string — the synthetic tool-use-id template `` `sdk-tool-${...}` ``
  appears 3x in `agent-session.ts` (lines 618, 662, 682) and once in
  `hooks-bridge.ts:280` (`generateToolUseId`). The literal prefix is duplicated
  with no shared constant, so a future rename can drift between the two
  correlation sources.
- Proposed change: Introduce a module-level `const SDK_TOOL_ID_PREFIX = 'sdk-tool-'`
  (or a tiny `nextSyntheticToolUseId(counter)` helper) in `sdk-message-decode.ts`
  and reference it from both files. Behavior-preserving (same string, same
  counter semantics).

## `handleSdkMessage` does multiple jobs (long branching method)
- File: packages/harness-claude/src/agent-sdk/agent-session.ts:581
- Risk: Med
- API-impact: internal-only
- Smell: Long function (~70 lines, 581–652) with several responsibilities:
  emit message_start/update/end, track subagent context enter/exit, handle
  standalone `tool_use`, handle standalone `tool_result`, then fall through to
  generic content-block walking. The subagent-context bookkeeping is interleaved
  with the per-type dispatch.
- Proposed change: Extract private helpers `emitMessageLifecycle(message, msg)`
  (the message_start/update/end block, 581–603), `handleStandaloneToolUse(msg)`
  (617–632), and `handleStandaloneToolResult(msg)` (635–644). Leaves
  `handleSdkMessage` as a short dispatcher. Private-only, no event-shape change.

## Duplicated tool-block emit pipeline between agent-session and hooks-bridge
- File: packages/harness-claude/src/agent-sdk/agent-session.ts:661
- Risk: Med
- API-impact: internal-only
- Smell: Duplicated logic — `processToolUseBlock` / `processToolResultBlock` /
  `emitUserToolResultIfNeeded` exist with near-identical structure both as
  `AgentSession` methods (agent-session.ts:661–737) and as free functions in
  `hooks-bridge.ts:327–377`. They share id-resolution, name/input extraction,
  error/structured-content handling, and the `tool_use_result` synthesis guard;
  they differ only in the sink (UnifiedSessionEvent vs HookEventBus payload).
  The guard in `emitUserToolResultIfNeeded` (msgType !== 'user' || sawToolResult
  || no parent_tool_use_id || no tool_use_result) is byte-for-byte identical in
  both files.
- Proposed change: Lift the shared *decoding* into `sdk-message-decode.ts` as a
  pure helper returning a normalized `{ toolUseId, toolName, blocks, isError,
  structuredContent }` descriptor, and have each sink format its own event from
  that descriptor. Extract the identical user-tool-result guard predicate into a
  shared `shouldSynthesizeUserToolResult(msg, msgType, sawToolResultBlock)`
  helper. Keeps both emit shapes; removes the drift risk. Med because it spans
  two internal modules.

## `extractResponseText` overlaps `mapSdkContent` text-flattening
- File: packages/harness-claude/src/agent-sdk/agent-session.ts:742
- Risk: Low
- API-impact: internal-only
- Smell: Mild duplication — `extractResponseText` (742–772) re-implements
  "walk assistant content blocks, collect `type === 'text'` text, join" which is
  also done by the `text` handler in `TOOL_RESULT_BLOCK_HANDLERS`
  (sdk-message-decode.ts) and inside `mapSdkContent`. It's a third hand-rolled
  text walk over the same block shape.
- Proposed change: Route the assistant-content text extraction through a small
  shared helper in `sdk-message-decode.ts` (e.g. `flattenAssistantText(content)`),
  preserving the `'\n'` join and the `result`-message early return. Behavior-
  preserving; keep the distinct join separator.

## `parseClaudeVersion` inline regex / repeated `'unknown'` sentinel
- File: packages/harness-claude/src/claude/detect.ts:158
- Risk: Low
- API-impact: internal-only
- Smell: Magic literal / single-responsibility — the semver-extraction regex and
  fallback chain (`match?.[1] ?? (stdout.trim() || 'unknown')`) live inline in
  `queryVersion`. The literal `'unknown'` sentinel is repeated (lines 152, 159,
  161).
- Proposed change: Extract a private `parseClaudeVersion(stdout: string): string`
  pure helper and a `const UNKNOWN_VERSION = 'unknown'` constant. Internal-only,
  no signature change to `queryVersion`/`detectClaude`.

## `getMessageContent` / `mapSdkMessage` repeat the assistant|user + message-object guard
- File: packages/harness-claude/src/agent-sdk/agent-session.ts:775
- Risk: Low
- API-impact: internal-only
- Smell: Repeated type guard — `getMessageContent` (775), `mapSdkMessage` (793),
  and `resolveMessageId` (782) each re-derive "msg.message is a non-null object"
  / extract `.content` from `msg.message`. The "extract `.content`" step is
  duplicated in `getMessageContent` and `mapSdkMessage`.
- Proposed change: Add a tiny private `getSdkMessageObject(msg)` returning the
  inner `message` record (or undefined) and reuse it across the three functions.
  Behavior-preserving guard consolidation.

## Inverted/duplicated deny-result construction in resolveViaHookEventBus
- File: packages/harness-claude/src/agent-sdk/hooks-bridge.ts:163
- Risk: Low
- API-impact: internal-only
- Smell: Awkward control flow / duplication — lines 163–173 build two `deny`
  results that differ only by whether `interrupt` is spread in. The
  `message: response.message ?? 'Permission denied'` literal is repeated, and the
  `if (response.interrupt === undefined)` split is harder to read than a single
  object with a conditional spread.
- Proposed change: Collapse to one return:
  `return { behavior: 'deny', message: response.message ?? DENIED, ...(response.interrupt !== undefined ? { interrupt: response.interrupt } : {}) }`
  and hoist `'Permission denied'` to a `const`. Identical output; one branch
  fewer. Internal helper, not exported.

## Inline init-message plugin-name extraction in captureInitMessage
- File: packages/harness-claude/src/agent-sdk/agent-session.ts:518
- Risk: Low
- API-impact: internal-only
- Smell: Mixed responsibilities — `captureInitMessage` both captures the SDK
  session id (the load-bearing behavior) and does a map/filter to log plugin
  names (pure diagnostics, lines 518–529). The diagnostic block inflates a method
  whose name implies "capture session identity".
- Proposed change: Extract `logInitPlugins(msg)` private helper for the
  map/filter/console.log block; `captureInitMessage` keeps only the session-id
  capture + the one call. Internal-only, log output unchanged.

## `close()` cannot wake a parked async-iterator consumer (DEFER)
- File: packages/harness-claude/src/agent-sdk/prompt-queue.ts:104
- Risk: High
- API-impact: internal-only
- Smell: Latent correctness smell (NOT a pure refactor). `close()` sets
  `this.waiting = null` but never resolves the pending promise created in the
  `[Symbol.asyncIterator]` `await new Promise(...)` (lines 86–93). A consumer
  already parked in that promise when `close()` is called is not woken by
  `close()` itself — it relies on a subsequent `push` or the in-promise
  `this.closed` re-check that only runs at registration time. The comment
  "Wake up any waiting consumer" overstates what the code does.
- Proposed change: DEFER. A real fix (capture and resolve the parked resolver
  with `null` on close) changes shutdown behavior on the SDK turn path and needs
  a human + regression test. Flagged High despite the type being internal-only.
