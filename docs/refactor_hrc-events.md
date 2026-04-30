# hrc-events Refactor Notes

## Purpose

`hrc-events` is the shared event-normalization and validation package for HRC harness output. It defines hook-derived session event types, Zod schemas for those normalized events, monitor-output schemas for `hrc monitor`, and pure normalizers that translate Claude hook payloads, Codex OTEL log records, and Pi hook envelopes into a common event vocabulary consumed by `hrc-server` and `hrc-cli`.

## Public Surface

The package exports a single module, `hrc-events`, via `src/index.ts`; it has no HTTP routes or CLI commands.

- Event primitives and guards from `src/events.ts`: `ContentBlock`, `ToolResult`, `UserPromptEvent`, `AgentMessageEvent`, `ToolExecutionStartEvent`, `ToolExecutionUpdateEvent`, `ToolExecutionEndEvent`, `NoticeEvent`, `ContextCompactionEvent`, `SubagentStartEvent`, `HookDerivedEvent`, `HookDerivedEventType`, and `isHookDerivedEvent`.
- Zod schemas from `src/schemas.ts`: `ContentBlockSchema`, `ToolResultSchema`, `UserPromptEventSchema`, `AgentMessageEventSchema`, `ToolExecutionStartEventSchema`, `ToolExecutionUpdateEventSchema`, `ToolExecutionEndEventSchema`, `NoticeEventSchema`, `ContextCompactionEventSchema`, `SubagentStartEventSchema`, and `HookDerivedEventSchema`.
- Claude hook normalization from `src/hook-normalizer.ts`: `normalizeClaudeHook`, `formatToolSummary`, `ProgressHint`, and `NormalizeHookResult`.
- Codex OTEL normalization from `src/otel-normalizer.ts`: `normalizeCodexOtelEvent`, `OtelLogRecordInput`, and `NormalizeOtelResult`.
- Pi hook normalization from `src/pi-normalizer.ts`: `normalizePiHookEvent`, `PiHookEnvelopeInput`, `PiSemanticEvent`, and `NormalizePiHookResult`.
- Tool-output formatting from `src/tool-output-formatter.ts`: `formatToolOutput` and `ToolOutputFormatResult`.
- Monitor output contract from `src/monitor-schema.ts`: `MonitorEvent`, `MonitorResult`, `MonitorResultSchema`, `MonitorFailureKind`, `MonitorFailureKindSchema`, `ContextChangedReason`, `ContextChangedReasonSchema`, `MonitorEventName`, `MonitorEventNameSchema`, and `MonitorEventSchema`.

Current in-repo consumers are `packages/hrc-server/src/index.ts` for all three normalizers, `packages/hrc-server/src/hrc-event-helper.ts` for event payload types, and `packages/hrc-cli/src/monitor-watch.ts` plus its tests for monitor result/schema exports.

## Internal Structure

- `src/events.ts` defines TypeScript-only normalized event interfaces and the `HookDerivedEvent` union.
- `src/schemas.ts` mirrors the hook-derived event model as runtime Zod validators.
- `src/hook-normalizer.ts` unwraps direct or HRC-wrapped Claude hook payloads and maps `PreToolUse`, `PostToolUse`, `Notification`, `PreCompact`, `SubagentStart`, and completion hooks into events and progress hints.
- `src/tool-output-formatter.ts` extracts displayable tool output, with special handling for `Write` previews and `Edit` diffs.
- `src/otel-normalizer.ts` maps selected Codex OTEL records into hook-derived tool and notice events while leaving transport events unmapped.
- `src/pi-normalizer.ts` maps Pi hook envelopes into both legacy `HookDerivedEvent[]` and richer `PiSemanticEvent[]`, and extracts Pi continuation keys from `session_start`.
- `src/monitor-schema.ts` defines stable monitor result, failure, context-change, event-name, and JSON-line Zod schemas.
- `src/index.ts` is a barrel export for the package.
- `MONITOR_HARNESS_AUDIT.md` records harness signal coverage and known gaps for Claude, Codex, Pi, and tmux.

## Dependencies

Production dependencies are `zod` for runtime schemas and `diff` for line-diff formatting in `formatToolOutput`. Test/development dependencies are Bun's test runner through `@types/bun`, `@types/diff`, and `typescript`. The package is otherwise intentionally decoupled from `hrc-server`, `hrc-core`, and harness packages.

## Test Coverage

There are 57 test cases across 4 test files:

- `src/__tests__/hook-normalizer.test.ts` covers Claude hook normalization, wrapped HRC payloads, completion hooks, missing tool IDs, and `formatToolSummary`.
- `src/__tests__/otel-normalizer.test.ts` covers Codex tool decisions/results, user prompts, conversation starts, transport events, unknown events, and event-name fallbacks.
- `src/__tests__/pi-normalizer.test.ts` covers Pi semantic tool events, turn lifecycle events, message events, and continuation extraction.
- `src/__tests__/monitor-schema.acceptance.test.ts` locks monitor discriminators, validates monitor payload shape, and checks the audit document has required harness gap sections.

Main gaps: `formatToolOutput` has no direct tests for `Write` previews, `Edit` structured patches, line-diff output, array content extraction, stdout-vs-stderr precedence, or cyclic response fallback. `src/schemas.ts` has no direct parse tests for `HookDerivedEventSchema` or schema/type equivalence against `src/events.ts`. `MonitorEventSchema` validates field types but not cross-field invariants such as `failureKind` only appearing with failure results.

## Recommended Refactors and Reductions

1. Derive public event types from schemas or add schema/type drift tests. `src/events.ts` and `src/schemas.ts` duplicate every hook-derived event shape by hand; `ToolExecutionEndEvent`, `ContextCompactionEvent`, and `SubagentStartEvent` can diverge from their schema counterparts without a failing test. Either define the TypeScript types with `z.infer` from `src/schemas.ts`, or add acceptance tests that parse representative values for each exported event type.

2. Tighten `MonitorEventSchema` cross-field validation. `src/monitor-schema.ts` comments say `failureKind` is present when `result` indicates failure and `reason` is present for `context_changed`, but the schema currently accepts any valid `failureKind` or `reason` with any event/result. Add a `superRefine` or discriminated terminal-event schema so impossible combinations are rejected at the package boundary.

3. Consolidate repeated record/string coercion helpers. `asToolInputRecord` and `getString` in `src/hook-normalizer.ts`, `asRecord`, `getString`, `getBoolean`, and `textFrom` in `src/pi-normalizer.ts`, `getAttrString`, `getAttrBool`, and `tryParseJson` in `src/otel-normalizer.ts`, and `asToolInputRecord` / `stringifyToolValue` in `src/tool-output-formatter.ts` repeat the same untyped input-normalization patterns. A small private `src/input.ts` helper would reduce duplicated guards without changing the public API.

4. Reduce duplicate Pi turn signals. `src/pi-normalizer.ts` maps `turn_start` and `turn_end` to `notice` payloads in `events` while also emitting `PiSemanticEvent` values with `eventKind` `turn.started` and `turn.completed`. If `PiSemanticEvent` is the canonical turn lifecycle path, remove or gate the legacy notice emission to avoid duplicate timeline noise downstream.

5. Split and test tool-specific output formatting. `formatToolOutput` in `src/tool-output-formatter.ts` owns generic extraction, `Write` preview formatting, `Edit` structured patch formatting, and fallback stringification. Moving the `Write` and `Edit` branches into private functions such as `formatWriteOutput` and `formatEditOutput` would make the untested behaviors easier to cover and would keep the exported function focused on dispatch.
