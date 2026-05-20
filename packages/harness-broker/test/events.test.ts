import { describe, expect, test } from 'bun:test'
import { createInvocationEventSequencer } from '../src/events'

describe('invocation event sequencing', () => {
  test('seq is monotonic per invocation and starts at 1', () => {
    const sequencer = createInvocationEventSequencer({
      now: () => new Date('2026-05-20T18:00:00.000Z'),
    })

    expect([
      sequencer.next('inv_a', 'invocation.started', {}),
      sequencer.next('inv_a', 'invocation.ready', {}),
      sequencer.next('inv_b', 'invocation.started', {}),
    ]).toMatchObject([{ seq: 1 }, { seq: 2 }, { seq: 1 }])
  })

  test('event envelope includes invocationId', () => {
    const sequencer = createInvocationEventSequencer({
      now: () => new Date('2026-05-20T18:00:00.000Z'),
    })

    expect(sequencer.next('inv_with_id', 'invocation.ready', {})).toMatchObject({
      invocationId: 'inv_with_id',
      seq: 1,
      time: '2026-05-20T18:00:00.000Z',
      type: 'invocation.ready',
      payload: {},
    })
  })

  test('correlation is echoed verbatim and never interpreted', () => {
    const correlation = {
      'client.session': 'runtime-123',
      phase: 'opaque-client-value',
      seq: 'not-a-broker-seq',
    }
    const sequencer = createInvocationEventSequencer({
      now: () => new Date('2026-05-20T18:00:00.000Z'),
      correlation,
    })

    const event = sequencer.next('inv_corr', 'driver.notice', { message: 'notice' })

    expect(event.correlation).toEqual(correlation)
    expect(event.seq).toBe(1)
    expect(event.type).toBe('driver.notice')
  })
})
