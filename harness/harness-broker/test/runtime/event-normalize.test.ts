import { describe, expect, test } from 'bun:test'
import type { InvocationEventType } from 'spaces-harness-broker-protocol'
import {
  type NormalizeEventPayloadInput,
  normalizeEventPayload,
  safeStartedPayload,
} from '../../src/runtime/event-normalize'
import { messageIdFrom } from '../ids'

/**
 * Feeds the normalizer a payload that breaks its declared shape (extra keys,
 * missing fields, foreign leaves), as a misbehaving driver would at runtime.
 * Repairing exactly that is the normalizer's job.
 */
const normalizeMalformed = <K extends InvocationEventType>(input: {
  type: K
  payload: object
  maxEventBytes?: number
}) =>
  // deliberately invalid: the payload does not satisfy InvocationEventPayloadMap[K].
  normalizeEventPayload(input as NormalizeEventPayloadInput<K>)

describe('normalizeEventPayload — central event normalization + size bounding', () => {
  test('normalizes invocation.ready payload to { state: "ready" }', () => {
    const { payload } = normalizeMalformed({
      type: 'invocation.ready',
      payload: { extra: 'ignored' },
    })
    expect(payload).toEqual({ state: 'ready' })
  })

  test('normalizes invocation.disposed payload to { disposed: true }', () => {
    const { payload } = normalizeMalformed({
      type: 'invocation.disposed',
      payload: { disposed: true, extra: 'ignored' },
    })
    expect(payload).toEqual({ disposed: true })
  })

  test('constrains invocation.started to pid/command/args/cwd only', () => {
    const { payload } = normalizeMalformed({
      type: 'invocation.started',
      payload: {
        pid: 7,
        command: 'codex',
        args: ['app-server'],
        cwd: '/work',
        // A leaked env block must be dropped by the positive projection.
        env: { CODEX_HOME: '/tmp/codex-home' },
      },
    })
    expect(Object.keys(payload).sort()).toEqual(['args', 'command', 'cwd', 'pid'])
    expect(JSON.stringify(payload)).not.toContain('CODEX_HOME')
  })

  test('serializes started args under cwd as stable cwd-relative paths', () => {
    const { payload } = normalizeEventPayload({
      type: 'invocation.started',
      payload: {
        command: 'codex',
        args: ['/work/project/bin/fake-codex.ts', '--literal'],
        cwd: '/work/project',
      },
    })
    expect((payload as { args: string[] }).args).toEqual([
      '/work/project/bin/fake-codex.ts',
      '--literal',
    ])
    expect(JSON.stringify(payload)).toContain('"<cwd>/bin/fake-codex.ts"')
    expect(JSON.stringify(payload)).not.toContain('/work/project/bin/fake-codex.ts')
  })

  test('safeStartedPayload returns non-object payloads unchanged', () => {
    expect(safeStartedPayload('plain')).toBe('plain')
    expect(safeStartedPayload(null)).toBeNull()
  })

  test('truncates an oversized payload field to [TRUNCATED] and returns a broker diagnostic', () => {
    const big = 'x'.repeat(5000)
    const { payload, diagnostics } = normalizeEventPayload({
      type: 'assistant.message.delta',
      payload: { messageId: messageIdFrom('m1'), text: big },
      maxEventBytes: 256,
    })
    expect((payload as { messageId: string }).messageId).toBe('m1')
    expect((payload as { text: string }).text).toBe('[TRUNCATED]')
    expect(diagnostics?.length ?? 0).toBeGreaterThan(0)
    expect(diagnostics?.[0]).toMatchObject({
      level: 'warn',
      source: 'broker',
      data: { eventType: 'assistant.message.delta', maxEventBytes: 256 },
    })
  })

  test('does not truncate payloads within maxEventBytes', () => {
    const { payload, diagnostics } = normalizeEventPayload({
      type: 'assistant.message.delta',
      payload: { messageId: messageIdFrom('m1'), text: 'short' },
      maxEventBytes: 4096,
    })
    expect((payload as { text: string }).text).toBe('short')
    expect(diagnostics ?? []).toHaveLength(0)
  })

  test('does not truncate when maxEventBytes is unset', () => {
    const big = 'y'.repeat(5000)
    const { payload, diagnostics } = normalizeEventPayload({
      type: 'diagnostic',
      payload: { level: 'info', message: big },
    })
    expect((payload as { message: string }).message).toBe(big)
    expect(diagnostics ?? []).toHaveLength(0)
  })

  test('truncation is deterministic — largest leaf first, stable across runs', () => {
    const input = {
      type: 'assistant.message.delta' as const,
      payload: { small: 'tiny', big: 'z'.repeat(4000), medium: 'm'.repeat(500) },
      maxEventBytes: 600,
    }
    const first = normalizeMalformed(input)
    const second = normalizeMalformed(input)
    expect(first.payload).toEqual(second.payload)
    // The largest leaf (`big`) is truncated; the smallest survives.
    expect(first.payload).toHaveProperty('big', '[TRUNCATED]')
    expect(first.payload).toHaveProperty('small', 'tiny')
  })
})
