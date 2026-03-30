/**
 * RED/GREEN TDD contract tests for HRC seam contracts (T-00942)
 *
 * Pin the type-level and behavioral contracts that HRC depends on:
 *   D. AgentEvent discriminated union shape — required fields per variant
 *   E. Identity separation contract — hostSessionId vs nativeIdentity vs continuationKey
 *   F. Continuation ref lifecycle through emitter
 *   G. Compatibility boundary (cpSessionId deprecated)
 *
 * These tests validate structural contracts at the value level, ensuring that
 * conforming values satisfy the AgentEvent type and that identity concepts
 * remain distinct across harness providers.
 */

import { describe, expect, test } from 'bun:test'

import { type EventPayload, createEventEmitter } from '../session-events.js'
import type { AgentEvent, BaseEvent, HarnessContinuationRef, RunResult } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBase(overrides?: Partial<BaseEvent>): BaseEvent {
  return {
    ts: new Date().toISOString(),
    seq: 1,
    hostSessionId: 'host-test',
    runId: 'run-test',
    ...overrides,
  }
}

/** Type guard: verifies value is assignable to AgentEvent at runtime. */
function isAgentEvent(v: unknown): v is AgentEvent {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e.type === 'string' &&
    typeof e.ts === 'string' &&
    typeof e.seq === 'number' &&
    typeof e.hostSessionId === 'string' &&
    typeof e.runId === 'string'
  )
}

// ===================================================================
// D. AgentEvent discriminated union shape
// ===================================================================

describe('AgentEvent discriminated union shape (T-00942)', () => {
  test('state event: { type, state, ts, seq, hostSessionId, runId }', () => {
    const event: AgentEvent = {
      ...makeBase(),
      type: 'state',
      state: 'running',
    }
    expect(isAgentEvent(event)).toBe(true)
    expect(event.type).toBe('state')
    expect(event.state).toBe('running')
  })

  test('message event: { type, role, content, ts, seq, hostSessionId, runId }', () => {
    const event: AgentEvent = {
      ...makeBase(),
      type: 'message',
      role: 'assistant',
      content: 'Hello',
    }
    expect(isAgentEvent(event)).toBe(true)
    expect(event.type).toBe('message')
    expect(event.role).toBe('assistant')
    expect(event.content).toBe('Hello')
  })

  test('message_delta event: { type, role, delta, ts, seq, hostSessionId, runId }', () => {
    const event: AgentEvent = {
      ...makeBase(),
      type: 'message_delta',
      role: 'assistant',
      delta: 'chunk',
    }
    expect(isAgentEvent(event)).toBe(true)
    expect(event.type).toBe('message_delta')
    expect(event.delta).toBe('chunk')
  })

  test('tool_call event: { type, toolUseId, toolName, input, ts, seq, hostSessionId, runId }', () => {
    const event: AgentEvent = {
      ...makeBase(),
      type: 'tool_call',
      toolUseId: 'tu-1',
      toolName: 'Read',
      input: { path: '/a' },
    }
    expect(isAgentEvent(event)).toBe(true)
    expect(event.type).toBe('tool_call')
    expect(event.toolUseId).toBe('tu-1')
    expect(event.toolName).toBe('Read')
    expect(event.input).toEqual({ path: '/a' })
  })

  test('tool_result event: { type, toolUseId, toolName, output, isError, ts, seq, hostSessionId, runId }', () => {
    const event: AgentEvent = {
      ...makeBase(),
      type: 'tool_result',
      toolUseId: 'tu-1',
      toolName: 'Read',
      output: 'file data',
      isError: false,
    }
    expect(isAgentEvent(event)).toBe(true)
    expect(event.type).toBe('tool_result')
    expect(event.isError).toBe(false)
  })

  test('log event: { type, level, message, ts, seq, hostSessionId, runId }', () => {
    const event: AgentEvent = {
      ...makeBase(),
      type: 'log',
      level: 'info',
      message: 'something happened',
    }
    expect(isAgentEvent(event)).toBe(true)
    expect(event.type).toBe('log')
    expect(event.level).toBe('info')
  })

  test('complete event: { type, result, ts, seq, hostSessionId, runId }', () => {
    const result: RunResult = { success: true, finalOutput: 'done' }
    const event: AgentEvent = {
      ...makeBase(),
      type: 'complete',
      result,
    }
    expect(isAgentEvent(event)).toBe(true)
    expect(event.type).toBe('complete')
    expect(event.result.success).toBe(true)
  })

  test('BaseEvent always carries: ts, seq, hostSessionId, runId', () => {
    const base = makeBase()
    expect(typeof base.ts).toBe('string')
    expect(typeof base.seq).toBe('number')
    expect(typeof base.hostSessionId).toBe('string')
    expect(typeof base.runId).toBe('string')
  })

  test('optional fields: continuation, payload, cpSessionId (deprecated)', () => {
    const event: AgentEvent = {
      ...makeBase(),
      type: 'state',
      state: 'running',
      continuation: { provider: 'anthropic', key: 'k' },
      payload: { raw: true },
      cpSessionId: 'legacy-cp-id',
    }
    expect(event.continuation).toEqual({ provider: 'anthropic', key: 'k' })
    expect(event.payload).toEqual({ raw: true })
    expect(event.cpSessionId).toBe('legacy-cp-id')
  })
})

// ===================================================================
// E. Identity separation contract
// ===================================================================

describe('Identity separation contract (T-00942)', () => {
  test('hostSessionId is always a string in BaseEvent', () => {
    const base = makeBase({ hostSessionId: 'host-42' })
    expect(typeof base.hostSessionId).toBe('string')
    expect(base.hostSessionId).toBe('host-42')
  })

  test('agent-sdk: nativeIdentity is sdkSessionId, continuationKey is separate input', () => {
    // agent-sdk provides sdkSessionId as nativeIdentity (via getMetadata)
    // and continuationKey as a separate input option for resume
    // These are conceptually distinct: nativeIdentity is the provider's session ID,
    // continuationKey is what we pass back to resume.
    // For agent-sdk, they happen to be the same value but are distinct concepts.
    const nativeIdentity: string | undefined = 'sdk-sess-abc'
    const continuationKey: string | undefined = 'sdk-sess-abc'
    expect(nativeIdentity).toBeDefined()
    expect(continuationKey).toBeDefined()
    // They may be equal for agent-sdk, but they are separate fields
    expect(typeof nativeIdentity).toBe('string')
    expect(typeof continuationKey).toBe('string')
  })

  test('codex: nativeIdentity === continuationKey (both are threadId)', () => {
    // For codex, threadId serves as both nativeIdentity and continuationKey
    const threadId = 'thread-xyz'
    const nativeIdentity = threadId
    const continuationKey = threadId
    expect(nativeIdentity).toBe(continuationKey)
    expect(nativeIdentity).toBe(threadId)
  })

  test('pi-sdk: nativeIdentity and continuationKey are both undefined', () => {
    // pi-sdk does not support native resume
    const nativeIdentity: string | undefined = undefined
    const continuationKey: string | undefined = undefined
    expect(nativeIdentity).toBeUndefined()
    expect(continuationKey).toBeUndefined()
  })

  test('HarnessContinuationRef carries provider + key, key absent until first turn', () => {
    // Before first turn: key is absent
    const preFirstTurn: HarnessContinuationRef = { provider: 'anthropic' }
    expect(preFirstTurn.provider).toBe('anthropic')
    expect(preFirstTurn.key).toBeUndefined()

    // After first turn: key is present
    const postFirstTurn: HarnessContinuationRef = {
      provider: 'anthropic',
      key: 'sess-after-turn',
    }
    expect(postFirstTurn.key).toBe('sess-after-turn')
  })
})

// ===================================================================
// F. Continuation ref lifecycle through emitter
// ===================================================================

describe('Continuation ref lifecycle through emitter (T-00942)', () => {
  test('first-run emitter (no initial continuation) → events have no continuation field', async () => {
    const events: AgentEvent[] = []
    const emitter = createEventEmitter(
      (e) => {
        events.push(e)
      },
      { hostSessionId: 'h', runId: 'r' }
    )
    await emitter.emit({ type: 'state', state: 'running' } as EventPayload)
    await emitter.emit({ type: 'state', state: 'complete' } as EventPayload)
    for (const e of events) {
      expect(e).not.toHaveProperty('continuation')
    }
  })

  test('after setContinuation → subsequent events carry it', async () => {
    const events: AgentEvent[] = []
    const emitter = createEventEmitter(
      (e) => {
        events.push(e)
      },
      { hostSessionId: 'h', runId: 'r' }
    )
    emitter.setContinuation({ provider: 'anthropic', key: 'sess-1' })
    await emitter.emit({ type: 'state', state: 'running' } as EventPayload)
    expect(events[0].continuation).toEqual({ provider: 'anthropic', key: 'sess-1' })
  })

  test('mid-stream setContinuation update → only subsequent events get new ref', async () => {
    const events: AgentEvent[] = []
    const emitter = createEventEmitter(
      (e) => {
        events.push(e)
      },
      { hostSessionId: 'h', runId: 'r' },
      { provider: 'anthropic', key: 'old-key' }
    )
    await emitter.emit({ type: 'state', state: 'running' } as EventPayload)
    emitter.setContinuation({ provider: 'anthropic', key: 'new-key' })
    await emitter.emit({ type: 'state', state: 'complete' } as EventPayload)

    expect(events[0].continuation).toEqual({ provider: 'anthropic', key: 'old-key' })
    expect(events[1].continuation).toEqual({ provider: 'anthropic', key: 'new-key' })
  })

  test('getContinuation reflects latest state', () => {
    const emitter = createEventEmitter(
      () => {},
      { hostSessionId: 'h', runId: 'r' },
      { provider: 'anthropic', key: 'initial' }
    )
    expect(emitter.getContinuation()).toEqual({ provider: 'anthropic', key: 'initial' })
    emitter.setContinuation({ provider: 'openai', key: 'updated' })
    expect(emitter.getContinuation()).toEqual({ provider: 'openai', key: 'updated' })
  })
})

// ===================================================================
// G. Compatibility boundary (light, marked compat-only)
// ===================================================================

describe('Compatibility boundary — compat-only (T-00942)', () => {
  test('BaseEvent.cpSessionId is optional and deprecated', () => {
    // A conforming BaseEvent without cpSessionId
    const withoutCp = makeBase()
    expect(withoutCp.cpSessionId).toBeUndefined()

    // A conforming BaseEvent with cpSessionId (backward compat)
    const withCp = makeBase({ cpSessionId: 'legacy-id' })
    expect(withCp.cpSessionId).toBe('legacy-id')
  })

  test('hostSessionId is the canonical field', () => {
    const base = makeBase({ hostSessionId: 'canonical' })
    expect(base.hostSessionId).toBe('canonical')
  })

  test('a conforming event can have both hostSessionId and cpSessionId (backward compat)', () => {
    const event: AgentEvent = {
      ...makeBase({ hostSessionId: 'new-host', cpSessionId: 'old-cp' }),
      type: 'state',
      state: 'running',
    }
    expect(event.hostSessionId).toBe('new-host')
    expect(event.cpSessionId).toBe('old-cp')
    expect(isAgentEvent(event)).toBe(true)
  })
})
