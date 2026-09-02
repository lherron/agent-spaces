import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createPaneOutput } from '../../../src/drivers/codex-app-server/pane-output'
import { createCodexAppServerRendererProjection } from '../../../src/drivers/codex-app-server/renderer'

const ESC = String.fromCharCode(0x1b)
const CSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g')

let seq = 0
function event(type: string, payload: unknown): InvocationEventEnvelope {
  seq += 1
  return {
    invocationId: 'inv-a',
    seq,
    time: new Date(1_700_000_000_000 + seq * 1_000).toISOString(),
    type,
    payload,
  } as unknown as InvocationEventEnvelope
}

/**
 * Drive the REAL wiring — the same `createPaneOutput` the leased pane runs — over
 * a scripted event stream, and read back both what the footer is showing and what
 * the transcript committed. Building a lookalike here would only prove the
 * lookalike works.
 */
function pane(events: InvocationEventEnvelope[]): {
  footer: () => string
  committed: string[]
  run: () => Promise<void>
} {
  const chunks: string[] = []
  const committed: string[] = []
  let deliver: ((event: InvocationEventEnvelope) => void) | undefined

  const output = createPaneOutput({
    write: (chunk) => chunks.push(chunk),
    enabled: true,
    color: false,
    width: 100,
    now: () => 1_700_000_030_000,
    schedule: () => 1,
    clearScheduled: () => {},
  })

  const projection = createCodexAppServerRendererProjection({
    invocationId: 'inv-a',
    readSurface: {
      eventsSince: async () => ({ events: [], currentSeq: 0 }),
      observe: (handler) => {
        deliver = handler
        return { close: () => {} }
      },
    },
    sink: (line) => {
      committed.push(line)
      output.sink(line)
    },
    onEvent: output.onEvent,
    color: false,
    width: 100,
  })

  return {
    committed,
    // A paint writes the whole block as ONE chunk, so the last write is the footer
    // as it now stands — all of its rows, not just the last one.
    footer: () => (chunks.at(-1) ?? '').replace(CSI_PATTERN, ' '),
    run: async () => {
      await projection.start()
      for (const item of events) deliver?.(item)
    },
  }
}

const admissionRequested = (principalRef: string): InvocationEventEnvelope =>
  event('admission.requested', {
    submissionId: 'submission_inv-a_7',
    class: 'queue',
    origin: { principalRef },
  })

const queueEnqueued = (): InvocationEventEnvelope =>
  event('queue.enqueued', {
    submissionId: 'submission_inv-a_7',
    class: 'queue',
    position: 0,
    ttlMs: 1_800_000,
  })

describe('the pane drawer fills and drains against the real wiring (T-07906)', () => {
  test('a queued submission is on screen for exactly as long as it waits', async () => {
    const p = pane([
      event('turn.started', { turnId: 'turn-1' }),
      admissionRequested('agent:lance'),
      event('admission.admitted', { submissionId: 'submission_inv-a_7', class: 'queue' }),
      queueEnqueued(),
    ])
    await p.run()

    // Waiting: the drawer says who and how long. The transcript says nothing —
    // no line is committed about a state that has not finished happening.
    expect(p.footer()).toContain('waiting')
    expect(p.footer()).toContain('#7')
    expect(p.footer()).toContain('lance')
    expect(p.committed.join('\n')).not.toContain('#7')
  })

  test('the entry leaves the drawer when the submission reaches a turn', async () => {
    const p = pane([
      event('turn.started', { turnId: 'turn-1' }),
      admissionRequested('agent:lance'),
      queueEnqueued(),
      event('submission.executed', { submissionId: 'submission_inv-a_7', turnId: 'turn-2' }),
      event('user.message', { content: 'the message that was waiting' }),
    ])
    await p.run()

    expect(p.footer()).not.toContain('waiting')
    // ...and the body it was carrying is now history, in the transcript above.
    expect(p.committed.join('\n')).toContain('the message that was waiting')
  })

  test('an expiry drains the drawer AND commits the loud line, because it is news', async () => {
    const p = pane([
      event('turn.started', { turnId: 'turn-1' }),
      admissionRequested('agent:lance'),
      queueEnqueued(),
      event('queue.expired', { submissionId: 'submission_inv-a_7' }),
    ])
    await p.run()

    expect(p.footer()).not.toContain('waiting')
    expect(p.committed.join('\n')).toContain('#7 expired in the queue')
  })

  test('no footer row is ever committed to the transcript', async () => {
    const p = pane([
      event('turn.started', { turnId: 'turn-1' }),
      admissionRequested('agent:lance'),
      queueEnqueued(),
      event('assistant.message.completed', { text: 'a reply' }),
      event('turn.completed', { turnId: 'turn-1' }),
    ])
    await p.run()

    expect(p.committed.some((line) => line.includes('waiting'))).toBe(false)
    expect(p.committed.some((line) => line.includes('running'))).toBe(false)
    expect(p.committed.join('\n')).toContain('a reply')
  })
})
