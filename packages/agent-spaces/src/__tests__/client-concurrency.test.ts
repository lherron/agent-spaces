/**
 * Concurrency / multi-session coverage (REFACTOR-BACKLOG agent-spaces A8).
 *
 * The rest of the suite drives a single session to completion. These tests
 * exercise the highest-risk stateful, global-mutating seams directly at the
 * unit level (no real materialization): the `process.env` overlay
 * (`applyEnvOverlay`) and the event emitter (`createEventEmitter`).
 *
 * NOTE: two of the most important assertions here document UNFIXED defects
 * tracked in docs/refactor-reports/BUGS.md and are intentionally registered as
 * `.todo` so the suite stays green. Do NOT promote them to live assertions
 * until the underlying bug is fixed:
 *   - BUGS.md agent-spaces A1: global `process.env` overlay race — overlapping
 *     overlays clobber each other's values and restore in completion order
 *     rather than LIFO.
 *   - BUGS.md agent-spaces A2: `createEventEmitter` swallows `onEvent` errors
 *     via `void lastEmission.catch(() => {})`, so a throwing consumer is
 *     invisible to the caller and to `idle()`.
 */
import { afterEach, describe, expect, it, test } from 'bun:test'

import { applyEnvOverlay } from '../runtime-env.js'
import { createEventEmitter } from '../session-events.js'

const PROBE_KEYS = ['ASP_TEST_CONCURRENCY_A', 'ASP_TEST_CONCURRENCY_B', 'ASP_TEST_CONCURRENCY_C']

afterEach(() => {
  for (const key of PROBE_KEYS) {
    delete process.env[key]
  }
})

describe('applyEnvOverlay (sequential / non-overlapping)', () => {
  it('restores prior values when overlays are applied and restored in LIFO order', () => {
    process.env['ASP_TEST_CONCURRENCY_A'] = 'original'

    const restoreOuter = applyEnvOverlay({ ASP_TEST_CONCURRENCY_A: 'outer' })
    expect(process.env['ASP_TEST_CONCURRENCY_A']).toBe('outer')

    const restoreInner = applyEnvOverlay({ ASP_TEST_CONCURRENCY_A: 'inner' })
    expect(process.env['ASP_TEST_CONCURRENCY_A']).toBe('inner')

    // LIFO unwind: inner first, then outer.
    restoreInner()
    expect(process.env['ASP_TEST_CONCURRENCY_A']).toBe('outer')
    restoreOuter()
    expect(process.env['ASP_TEST_CONCURRENCY_A']).toBe('original')
  })

  it('deletes keys that were absent before the overlay', () => {
    expect(process.env['ASP_TEST_CONCURRENCY_B']).toBeUndefined()
    const restore = applyEnvOverlay({ ASP_TEST_CONCURRENCY_B: 'value' })
    expect(process.env['ASP_TEST_CONCURRENCY_B']).toBe('value')
    restore()
    expect(process.env['ASP_TEST_CONCURRENCY_B']).toBeUndefined()
  })

  // BUGS.md agent-spaces A1: two overlapping overlays on the same key clobber
  // each other and restore in completion order, not LIFO. Marked `.todo` until
  // the overlay is scoped/serialized per-call. Promoting this to a live `it`
  // would fail today (the second restore clobbers the still-active first turn's
  // value back to the original instead of leaving it intact).
  it.todo('isolates env between two concurrent (overlapping) overlays [BUGS.md agent-spaces A1]')
})

describe('createEventEmitter (ordering)', () => {
  it('delivers events to onEvent in FIFO seq order even with async callbacks', async () => {
    const seen: number[] = []
    const emitter = createEventEmitter(
      async (event) => {
        // First event delays longer than the second to prove FIFO serialization.
        await new Promise((resolve) => setTimeout(resolve, event.seq === 1 ? 20 : 0))
        seen.push(event.seq)
      },
      { hostSessionId: 'host-1', runId: 'run-1' }
    )

    await Promise.all([
      emitter.emit({ type: 'message', role: 'assistant', content: 'first' }),
      emitter.emit({ type: 'message', role: 'assistant', content: 'second' }),
    ])
    await emitter.idle()

    expect(seen).toEqual([1, 2])
  })

  it('stamps monotonically increasing seq and shared base identifiers', async () => {
    const events: Array<{ seq: number; hostSessionId: string; runId: string }> = []
    const emitter = createEventEmitter(
      (event) => {
        events.push({
          seq: event.seq,
          hostSessionId: event.hostSessionId,
          runId: event.runId,
        })
      },
      { hostSessionId: 'host-xyz', runId: 'run-xyz' }
    )

    await emitter.emit({ type: 'state', state: 'running' } as never)
    await emitter.emit({ type: 'complete' } as never)
    await emitter.idle()

    expect(events.map((e) => e.seq)).toEqual([1, 2])
    expect(events.every((e) => e.hostSessionId === 'host-xyz')).toBe(true)
    expect(events.every((e) => e.runId === 'run-xyz')).toBe(true)
  })

  // BUGS.md agent-spaces A2: a throwing `onEvent` is swallowed by
  // `void lastEmission.catch(() => {})`, so neither the returned `emit` promise
  // nor `idle()` rejects. Marked `.todo` until emit failures are surfaced.
  // Promoting this would fail today because the rejection never propagates.
  test.todo('surfaces a throwing onEvent consumer to the caller / idle() [BUGS.md agent-spaces A2]')
})
