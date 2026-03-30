/**
 * RED/GREEN TDD contract tests for session-events.ts (T-00942)
 *
 * Pin the HRC-dependent seams:
 *   A. mapUnifiedEvents adapter contract — UnifiedSessionEvent → AgentEvent mapping
 *   B. createEventEmitter lifecycle — seq, continuation, idle
 *   C. mapContentToText — text extraction from various content shapes
 *
 * RED CONDITIONS (must fail before implementation):
 *   These tests pin the current behavior. They should be RED only if the
 *   source functions are missing or have different signatures. Since these
 *   test existing code, they should go GREEN immediately — the "red" phase
 *   validates that the tests are wired correctly and exercising real code.
 *
 * GREEN CONDITIONS:
 *   All assertions pass against the current session-events.ts implementation.
 */

import { describe, expect, test } from 'bun:test'

import type { UnifiedSessionEvent } from 'spaces-execution'

import {
  type EventPayload,
  createEventEmitter,
  mapContentToText,
  mapUnifiedEvents,
} from './session-events.js'
import type { AgentEvent, HarnessContinuationRef } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect emitted EventPayloads from mapUnifiedEvents. */
function mapEvent(
  event: UnifiedSessionEvent,
  opts?: {
    allowSessionIdUpdate?: boolean
    state?: { assistantBuffer: string; lastAssistantText?: string }
  }
): { turnEnded: boolean; emitted: EventPayload[]; continuationKeys: string[] } {
  const emitted: EventPayload[] = []
  const continuationKeys: string[] = []
  const state = opts?.state ?? { assistantBuffer: '', lastAssistantText: undefined }
  const result = mapUnifiedEvents(
    event,
    (e) => emitted.push(e),
    (key) => continuationKeys.push(key),
    state,
    { allowSessionIdUpdate: opts?.allowSessionIdUpdate ?? true }
  )
  return { ...result, emitted, continuationKeys }
}

// ===================================================================
// A. mapUnifiedEvents adapter contract
// ===================================================================

describe('mapUnifiedEvents adapter contract (T-00942)', () => {
  test('agent_start with sdkSessionId → calls onContinuationKeyObserved', () => {
    const { turnEnded, continuationKeys } = mapEvent({
      type: 'agent_start',
      sessionId: 'legacy-id',
      sdkSessionId: 'sdk-123',
    })
    expect(turnEnded).toBe(false)
    expect(continuationKeys).toEqual(['sdk-123'])
  })

  test('agent_start without sdkSessionId → falls back to event.sessionId', () => {
    const { turnEnded, continuationKeys } = mapEvent({
      type: 'agent_start',
      sessionId: 'fallback-id',
    })
    expect(turnEnded).toBe(false)
    expect(continuationKeys).toEqual(['fallback-id'])
  })

  test('agent_start with allowSessionIdUpdate=false → no continuation key observed', () => {
    const { continuationKeys } = mapEvent(
      { type: 'agent_start', sessionId: 'ignored', sdkSessionId: 'also-ignored' },
      { allowSessionIdUpdate: false }
    )
    expect(continuationKeys).toEqual([])
  })

  test('sdk_session_id → calls onContinuationKeyObserved with sdkSessionId', () => {
    const { turnEnded, continuationKeys } = mapEvent({
      type: 'sdk_session_id',
      sdkSessionId: 'sdk-456',
    })
    expect(turnEnded).toBe(false)
    expect(continuationKeys).toEqual(['sdk-456'])
  })

  test('message_start (assistant) → resets buffer', () => {
    const state = { assistantBuffer: 'stale text', lastAssistantText: undefined }
    const { turnEnded } = mapEvent(
      { type: 'message_start', message: { role: 'assistant', content: '' } },
      { state }
    )
    expect(turnEnded).toBe(false)
    expect(state.assistantBuffer).toBe('')
  })

  test('message_start (user) → does not reset buffer', () => {
    const state = { assistantBuffer: 'keep this', lastAssistantText: undefined }
    mapEvent({ type: 'message_start', message: { role: 'user', content: 'hello' } }, { state })
    expect(state.assistantBuffer).toBe('keep this')
  })

  test('message_update with textDelta → emits message_delta', () => {
    const state = { assistantBuffer: '', lastAssistantText: undefined }
    const { turnEnded, emitted } = mapEvent(
      { type: 'message_update', textDelta: 'Hello world' },
      { state }
    )
    expect(turnEnded).toBe(false)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      type: 'message_delta',
      role: 'assistant',
      delta: 'Hello world',
    })
    expect(state.assistantBuffer).toBe('Hello world')
  })

  test('message_update with contentBlocks → extracts text, emits message_delta', () => {
    const state = { assistantBuffer: '', lastAssistantText: undefined }
    const { emitted } = mapEvent(
      {
        type: 'message_update',
        contentBlocks: [
          { type: 'text', text: 'part1' },
          { type: 'text', text: 'part2' },
        ],
      },
      { state }
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      type: 'message_delta',
      role: 'assistant',
      delta: 'part1part2',
    })
    expect(state.assistantBuffer).toBe('part1part2')
  })

  test('message_update with empty textDelta → no emission', () => {
    const { emitted } = mapEvent({ type: 'message_update', textDelta: '' })
    expect(emitted).toHaveLength(0)
  })

  test('message_end (assistant) → emits full message with buffered text', () => {
    const state = { assistantBuffer: 'buffered content', lastAssistantText: undefined }
    // content is an empty array of content blocks → mapContentToText returns undefined
    // so finalText falls back to state.assistantBuffer
    const { turnEnded, emitted } = mapEvent(
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      { state }
    )
    expect(turnEnded).toBe(false)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: 'buffered content',
    })
    expect(state.lastAssistantText).toBe('buffered content')
  })

  test('message_end (assistant) with content → prefers content over buffer', () => {
    const state = { assistantBuffer: 'buffer', lastAssistantText: undefined }
    const { emitted } = mapEvent(
      {
        type: 'message_end',
        message: { role: 'assistant', content: 'from content' },
      },
      { state }
    )
    expect(emitted[0]).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: 'from content',
    })
  })

  test('message_end (non-assistant) → no emission', () => {
    const { emitted } = mapEvent({
      type: 'message_end',
      message: { role: 'user', content: 'user msg' },
    })
    expect(emitted).toHaveLength(0)
  })

  test('tool_execution_start → emits tool_call with toolUseId, toolName, input', () => {
    const { turnEnded, emitted } = mapEvent({
      type: 'tool_execution_start',
      toolUseId: 'tu-1',
      toolName: 'Read',
      input: { path: '/foo' },
    })
    expect(turnEnded).toBe(false)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      type: 'tool_call',
      toolUseId: 'tu-1',
      toolName: 'Read',
      input: { path: '/foo' },
    })
  })

  test('tool_execution_start with parentToolUseId → includes parentToolUseId', () => {
    const { emitted } = mapEvent({
      type: 'tool_execution_start',
      toolUseId: 'tu-2',
      toolName: 'Write',
      input: {},
      parentToolUseId: 'tu-parent',
    })
    expect(emitted[0]).toMatchObject({
      type: 'tool_call',
      toolUseId: 'tu-2',
      parentToolUseId: 'tu-parent',
    })
  })

  test('tool_execution_start without parentToolUseId → no parentToolUseId field', () => {
    const { emitted } = mapEvent({
      type: 'tool_execution_start',
      toolUseId: 'tu-3',
      toolName: 'Bash',
      input: {},
    })
    expect(emitted[0]).not.toHaveProperty('parentToolUseId')
  })

  test('tool_execution_end → emits tool_result with toolUseId, output, isError', () => {
    const { turnEnded, emitted } = mapEvent({
      type: 'tool_execution_end',
      toolUseId: 'tu-1',
      toolName: 'Read',
      result: { content: [{ type: 'text', text: 'file contents' }] },
      isError: false,
    })
    expect(turnEnded).toBe(false)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tu-1',
      toolName: 'Read',
      isError: false,
    })
  })

  test('tool_execution_end with isError=true → isError is true', () => {
    const { emitted } = mapEvent({
      type: 'tool_execution_end',
      toolUseId: 'tu-err',
      toolName: 'Bash',
      result: { content: [{ type: 'text', text: 'error' }] },
      isError: true,
    })
    expect(emitted[0]).toMatchObject({ type: 'tool_result', isError: true })
  })

  test('turn_end → returns { turnEnded: true }', () => {
    const { turnEnded, emitted } = mapEvent({ type: 'turn_end' })
    expect(turnEnded).toBe(true)
    expect(emitted).toHaveLength(0)
  })

  test('agent_end → returns { turnEnded: true }', () => {
    const { turnEnded, emitted } = mapEvent({ type: 'agent_end' })
    expect(turnEnded).toBe(true)
    expect(emitted).toHaveLength(0)
  })

  test('unknown event type → returns { turnEnded: false }, no emission', () => {
    const { turnEnded, emitted } = mapEvent({ type: 'turn_start' } as UnifiedSessionEvent)
    expect(turnEnded).toBe(false)
    expect(emitted).toHaveLength(0)
  })
})

// ===================================================================
// B. createEventEmitter lifecycle
// ===================================================================

describe('createEventEmitter lifecycle (T-00942)', () => {
  test('seq starts at 1 and increments', async () => {
    const events: AgentEvent[] = []
    const emitter = createEventEmitter(
      (e) => {
        events.push(e)
      },
      { hostSessionId: 'host-1', runId: 'run-1' }
    )
    await emitter.emit({ type: 'state', state: 'running' } as EventPayload)
    await emitter.emit({ type: 'state', state: 'complete' } as EventPayload)
    expect(events[0].seq).toBe(1)
    expect(events[1].seq).toBe(2)
  })

  test('hostSessionId and runId are attached to every event', async () => {
    const events: AgentEvent[] = []
    const emitter = createEventEmitter(
      (e) => {
        events.push(e)
      },
      { hostSessionId: 'host-abc', runId: 'run-xyz' }
    )
    await emitter.emit({ type: 'state', state: 'running' } as EventPayload)
    expect(events[0].hostSessionId).toBe('host-abc')
    expect(events[0].runId).toBe('run-xyz')
  })

  test('ts is a valid ISO timestamp on every event', async () => {
    const events: AgentEvent[] = []
    const emitter = createEventEmitter(
      (e) => {
        events.push(e)
      },
      { hostSessionId: 'h', runId: 'r' }
    )
    await emitter.emit({ type: 'state', state: 'running' } as EventPayload)
    const parsed = Date.parse(events[0].ts)
    expect(Number.isNaN(parsed)).toBe(false)
  })

  test('continuation is attached when provided at creation', async () => {
    const events: AgentEvent[] = []
    const ref: HarnessContinuationRef = { provider: 'anthropic', key: 'sess-init' }
    const emitter = createEventEmitter(
      (e) => {
        events.push(e)
      },
      { hostSessionId: 'h', runId: 'r' },
      ref
    )
    await emitter.emit({ type: 'state', state: 'running' } as EventPayload)
    expect(events[0].continuation).toEqual({ provider: 'anthropic', key: 'sess-init' })
  })

  test('setContinuation updates subsequent events', async () => {
    const events: AgentEvent[] = []
    const emitter = createEventEmitter(
      (e) => {
        events.push(e)
      },
      { hostSessionId: 'h', runId: 'r' }
    )
    await emitter.emit({ type: 'state', state: 'running' } as EventPayload)
    emitter.setContinuation({ provider: 'anthropic', key: 'sess-new' })
    await emitter.emit({ type: 'state', state: 'complete' } as EventPayload)
    expect(events[0].continuation).toBeUndefined()
    expect(events[1].continuation).toEqual({ provider: 'anthropic', key: 'sess-new' })
  })

  test('getContinuation returns current ref', () => {
    const emitter = createEventEmitter(() => {}, { hostSessionId: 'h', runId: 'r' })
    expect(emitter.getContinuation()).toBeUndefined()
    emitter.setContinuation({ provider: 'openai', key: 'thread-1' })
    expect(emitter.getContinuation()).toEqual({ provider: 'openai', key: 'thread-1' })
  })

  test('no continuation field when none set', async () => {
    const events: AgentEvent[] = []
    const emitter = createEventEmitter(
      (e) => {
        events.push(e)
      },
      { hostSessionId: 'h', runId: 'r' }
    )
    await emitter.emit({ type: 'state', state: 'running' } as EventPayload)
    expect(events[0]).not.toHaveProperty('continuation')
  })

  test('idle() resolves after emissions complete', async () => {
    let resolved = false
    const emitter = createEventEmitter(
      () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            resolved = true
            r()
          }, 10)
        ),
      { hostSessionId: 'h', runId: 'r' }
    )
    void emitter.emit({ type: 'state', state: 'running' } as EventPayload)
    expect(resolved).toBe(false)
    await emitter.idle()
    expect(resolved).toBe(true)
  })
})

// ===================================================================
// C. mapContentToText
// ===================================================================

describe('mapContentToText (T-00942)', () => {
  test('string passthrough: returns the string', () => {
    expect(mapContentToText('hello')).toBe('hello')
  })

  test('content block array with text blocks: joins text', () => {
    const blocks = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]
    expect(mapContentToText(blocks)).toBe('firstsecond')
  })

  test('mixed content blocks (text + non-text): only text extracted', () => {
    const blocks = [
      { type: 'text', text: 'keep' },
      { type: 'image', data: 'abc', mimeType: 'image/png' },
      { type: 'text', text: 'this' },
    ]
    expect(mapContentToText(blocks)).toBe('keepthis')
  })

  test('empty array: returns undefined', () => {
    expect(mapContentToText([])).toBeUndefined()
  })

  test('non-array non-string: returns undefined', () => {
    expect(mapContentToText(42)).toBeUndefined()
    expect(mapContentToText({})).toBeUndefined()
    expect(mapContentToText(true)).toBeUndefined()
  })

  test('null/undefined: returns undefined', () => {
    expect(mapContentToText(null)).toBeUndefined()
    expect(mapContentToText(undefined)).toBeUndefined()
  })
})
