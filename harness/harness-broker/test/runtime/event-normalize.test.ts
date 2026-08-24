import { describe, expect, test } from 'bun:test'
import { normalizeEventPayload, safeStartedPayload } from '../../src/runtime/event-normalize'

describe('normalizeEventPayload — central event normalization + size bounding', () => {
  test('normalizes invocation.ready payload to { state: "ready" }', () => {
    const { payload } = normalizeEventPayload({
      type: 'invocation.ready',
      payload: { extra: 'ignored' },
    })
    expect(payload).toEqual({ state: 'ready' })
  })

  test('normalizes invocation.disposed payload to { disposed: true }', () => {
    const { payload } = normalizeEventPayload({
      type: 'invocation.disposed',
      payload: { disposed: true, extra: 'ignored' },
    })
    expect(payload).toEqual({ disposed: true })
  })

  test('constrains invocation.started to pid/command/args/cwd only', () => {
    const { payload } = normalizeEventPayload({
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
    expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([
      'args',
      'command',
      'cwd',
      'pid',
    ])
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
      payload: { messageId: 'm1', text: big },
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
      payload: { messageId: 'm1', text: 'short' },
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
    const first = normalizeEventPayload(input)
    const second = normalizeEventPayload(input)
    expect(first.payload).toEqual(second.payload)
    // The largest leaf (`big`) is truncated; the smallest survives.
    expect((first.payload as { big: string }).big).toBe('[TRUNCATED]')
    expect((first.payload as { small: string }).small).toBe('tiny')
  })
})
