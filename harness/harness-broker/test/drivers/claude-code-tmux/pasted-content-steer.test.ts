import { describe, expect, test } from 'bun:test'
import type { TurnId } from 'spaces-harness-broker-protocol'
import { createClaudeTurnAttribution } from '../../../src/drivers/claude-code-tmux/turn-attribution'

// Claude Code wraps a multi-line pasted prompt in `<pasted_content id="N">`
// on every native surface: the UserPromptSubmit hook, the queue-operation
// enqueue/remove, the queued_command attachment and the transcript user row.
// The broker tracked the unwrapped body, so the wrapped queue rows minted a
// phantom human submission that later out-ranked the real steer (exact beats
// contains) and the steer run was reaped as run_abandoned_by_runtime.
// Recorded on inv-3e4c4b19 (rt-8c634550, 2026-10-09): steers _2/_3/_5/_7
// became human_submission_* while the unwrapped _4/_6 attributed correctly.

const createTracker = (invocationId: string) => {
  let turn = 0
  return createClaudeTurnAttribution({
    invocationId,
    allocateTurnId: () => `turn_${invocationId}_${++turn}`,
  })
}

const queueOp = (operation: string, content?: string) => ({
  type: 'queue-operation' as const,
  operation,
  ...(content !== undefined ? { content } : {}),
})

const wrap = (body: string) => `<pasted_content id="1208">\n${body}\n</pasted_content id="1208">`

const steerBody = (n: number) =>
  `[T-10632 · mable@hrc-runtime:primary (gen 52) → you]\nSteer ${n}.\n\nReadback line ${n}.`

describe('claude-code-tmux attribution of pasted_content-wrapped steers', () => {
  test('a steer that lands at a turn boundary starts its own turn under the broker id, twice in a row', () => {
    const tracker = createTracker('boundary')
    tracker.observeTurnStarted('turn_operator' as TurnId)

    for (const n of [1, 2]) {
      const body = steerBody(n)
      tracker.trackBrokerSubmission({
        submissionId: `submission_boundary_${n}`,
        inputId: `submission_boundary_${n}` as never,
        content: body,
      })
      // Recorded order (seq 763-770): prompt hook, enqueue, Stop, dequeue, user row.
      tracker.observePromptHook(wrap(body))
      tracker.observeQueueOperation(queueOp('enqueue', wrap(body)))
      tracker.observeTurnTerminal(tracker.activeTurnId as TurnId)
      tracker.observeQueueOperation(queueOp('dequeue'))
      const actions = tracker.observePlainUser(wrap(body), { type: 'user' })

      expect(actions.filter((action) => action.kind === 'warning')).toEqual([])
      expect(actions).toContainEqual(
        expect.objectContaining({ kind: 'executed', submissionId: `submission_boundary_${n}` })
      )
      expect(tracker.pendingCount).toBe(0)
    }
  })

  test('a steer absorbed mid-turn coalesces under the broker id', () => {
    const tracker = createTracker('absorbed')
    tracker.observeTurnStarted('turn_live' as TurnId)
    const body = steerBody(5)
    tracker.trackBrokerSubmission({
      submissionId: 'submission_absorbed_5',
      inputId: 'submission_absorbed_5' as never,
      content: body,
    })

    // Recorded order (raw_001459..001474): hook, enqueue, remove, queued_command.
    expect(tracker.observePromptHook(wrap(body))).toEqual([])
    expect(tracker.observeQueueOperation(queueOp('enqueue', wrap(body)))).toEqual([])
    expect(tracker.observeQueueOperation(queueOp('remove', wrap(body)))).toEqual([])
    expect(tracker.observeQueuedCommand(wrap(body), { type: 'queued_command' })).toEqual([
      expect.objectContaining({
        kind: 'absorbed',
        submissionId: 'submission_absorbed_5',
        turnId: 'turn_live',
      }),
    ])
    expect(tracker.pendingCount).toBe(0)
  })

  test('a human-typed wrapped paste still mints its own human submission', () => {
    const tracker = createTracker('human')
    tracker.observeTurnStarted('turn_live' as TurnId)
    const body = 'operator pasted\ntwo lines'
    tracker.observeQueueOperation(queueOp('enqueue', wrap(body)))
    tracker.observeQueueOperation(queueOp('remove', wrap(body)))
    expect(tracker.observeQueuedCommand(wrap(body), { type: 'queued_command' })).toEqual([
      expect.objectContaining({
        kind: 'absorbed',
        submissionId: 'human_submission_human_1',
      }),
    ])
    expect(tracker.pendingCount).toBe(0)
  })
})
