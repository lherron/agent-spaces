import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createTestDriver } from '../../src/testing/test-driver'
import { testDriverSpec } from '../helpers'
import { messageIdFrom } from '../ids'

/**
 * Every driver event passes through the broker's central event-safety path
 * before it is sequenced. These tests drive it the way a (misbehaving) driver
 * does: emit a payload through the real manager seam and read the envelope the
 * broker publishes. Payloads deliberately break their declared shape (extra
 * keys, foreign leaves), which is exactly what the normalizer repairs.
 */
let seq = 0
async function emitThrough(
  type: InvocationEventType,
  payload: object,
  options: { maxEventBytes?: number; cwd?: string } = {}
): Promise<{ emitted: InvocationEventEnvelope | undefined; events: InvocationEventEnvelope[] }> {
  seq += 1
  const events: InvocationEventEnvelope[] = []
  const { driver, controller } = createTestDriver()
  const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event) })
  const spec = testDriverSpec(`inv_event_normalize_${seq}`)
  await broker.start({
    spec: {
      ...spec,
      process: {
        ...spec.process,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.maxEventBytes !== undefined
          ? { limits: { maxEventBytes: options.maxEventBytes } }
          : {}),
      },
    },
  })
  const before = events.length
  // deliberately invalid: the payload need not satisfy InvocationEventPayloadMap[type].
  controller.emitRaw(type, payload as never)
  const emitted = events.slice(before).find((event) => event.type === type)
  return { emitted, events: events.slice(before) }
}

describe('normalizeEventPayload — central event normalization + size bounding', () => {
  test.each([
    {
      row: 'invocation.ready',
      type: 'invocation.ready' as const,
      payload: { extra: 'ignored' },
      expected: { state: 'ready' },
    },
    {
      row: 'invocation.disposed',
      type: 'invocation.disposed' as const,
      payload: { disposed: true, extra: 'ignored' },
      expected: { disposed: true },
    },
  ])(
    'a driver-emitted $row drops driver-supplied extra keys',
    async ({ type, payload, expected }) => {
      const { emitted } = await emitThrough(type, payload)
      expect(emitted?.payload).toEqual(expected)
    }
  )

  test('constrains invocation.started to pid/command/args/cwd only', async () => {
    const { emitted } = await emitThrough('invocation.started', {
      pid: 7,
      command: 'codex',
      args: ['app-server'],
      cwd: '/work',
      // A leaked env block must be dropped by the positive projection.
      env: { CODEX_HOME: '/tmp/codex-home' },
    })
    expect(Object.keys(emitted?.payload ?? {}).sort()).toEqual(['args', 'command', 'cwd', 'pid'])
    expect(JSON.stringify(emitted)).not.toContain('CODEX_HOME')
  })

  test('serializes started args under cwd as stable cwd-relative paths', async () => {
    const { emitted } = await emitThrough('invocation.started', {
      command: 'codex',
      args: ['/work/project/bin/fake-codex.ts', '--literal'],
      cwd: '/work/project',
    })
    expect((emitted?.payload as { args: string[] }).args).toEqual([
      '/work/project/bin/fake-codex.ts',
      '--literal',
    ])
    // What goes on the wire / into the ledger is the JSON form.
    expect(JSON.stringify(emitted)).toContain('"<cwd>/bin/fake-codex.ts"')
    expect(JSON.stringify(emitted)).not.toContain('/work/project/bin/fake-codex.ts')
  })

  test('an event larger than maxEventBytes has its largest leaf replaced by [TRUNCATED] and a warn diagnostic', async () => {
    const { emitted, events } = await emitThrough(
      'assistant.message.delta',
      { messageId: messageIdFrom('m1'), text: 'x'.repeat(5000) },
      { maxEventBytes: 256 }
    )
    expect(emitted?.payload).toMatchObject({ messageId: 'm1', text: '[TRUNCATED]' })
    const diagnostics = events.filter((event) => event.type === 'diagnostic')
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.payload).toMatchObject({
      level: 'warn',
      source: 'broker',
      data: { eventType: 'assistant.message.delta', maxEventBytes: 256 },
    })
  })

  test.each([
    {
      row: 'within maxEventBytes',
      type: 'assistant.message.delta' as const,
      payload: { messageId: messageIdFrom('m1'), text: 'short' },
      maxEventBytes: 4096,
    },
    {
      row: 'with maxEventBytes unset',
      type: 'diagnostic' as const,
      payload: { level: 'info', message: 'y'.repeat(5000) },
      maxEventBytes: undefined,
    },
  ])(
    'an event $row is published untouched with no diagnostic',
    async ({ type, payload, maxEventBytes }) => {
      const { emitted, events } = await emitThrough(
        type,
        payload,
        maxEventBytes !== undefined ? { maxEventBytes } : {}
      )
      expect(emitted?.payload).toMatchObject(payload)
      expect(events.filter((event) => event.type === 'diagnostic')).toHaveLength(
        type === 'diagnostic' ? 1 : 0
      )
    }
  )

  test('truncation takes the largest leaf first and keeps the small ones', async () => {
    const { emitted } = await emitThrough(
      'diagnostic',
      { level: 'info', message: 'tiny', data: { big: 'z'.repeat(4000), medium: 'm'.repeat(500) } },
      { maxEventBytes: 600 }
    )
    expect(emitted?.payload).toMatchObject({
      message: 'tiny',
      data: { big: '[TRUNCATED]', medium: 'm'.repeat(500) },
    })
    const repeated = await emitThrough(
      'diagnostic',
      { level: 'info', message: 'tiny', data: { big: 'z'.repeat(4000), medium: 'm'.repeat(500) } },
      { maxEventBytes: 600 }
    )
    expect(repeated.emitted?.payload).toEqual(emitted?.payload)
  })
})
