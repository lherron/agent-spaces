import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TurnId } from 'spaces-harness-broker-protocol'
import {
  type ClaudeAttributionAction,
  createClaudeTurnAttribution,
} from '../../../src/drivers/claude-code-tmux/turn-attribution'

const createTracker = (invocationId = 'inv_attr') => {
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

describe('claude-code-tmux disposition mirror', () => {
  test('keeps unmediated human ids disjoint from broker-minted submission ids', () => {
    const tracker = createTracker('namespace')
    const [priming] = tracker.observePlainUser('launch priming', { type: 'user' })
    expect(priming).toMatchObject({
      kind: 'executed',
      submissionId: 'human_submission_namespace_1',
    })
    if (priming?.kind !== 'executed') throw new Error('expected priming execution')
    tracker.observeTurnTerminal(priming.turnId)

    tracker.trackBrokerSubmission({
      submissionId: 'submission_namespace_1',
      content: 'mediated turn',
    })
    expect(tracker.observePlainUser('mediated turn', { type: 'user' })).toEqual([
      expect.objectContaining({
        kind: 'executed',
        submissionId: 'submission_namespace_1',
      }),
    ])
  })

  test('enqueue + prompt hook dedupes, then remove + queued_command absorbs once', () => {
    const tracker = createTracker()
    tracker.observeTurnStarted('turn_live' as TurnId)

    expect(tracker.observeQueueOperation(queueOp('enqueue', 'steer me'))).toEqual([])
    expect(tracker.observePromptHook('steer me')).toEqual([])
    expect(tracker.observeQueueOperation(queueOp('remove', 'steer me'))).toEqual([])
    expect(tracker.observeQueuedCommand('steer me', { type: 'queued_command' })).toEqual([
      expect.objectContaining({
        kind: 'absorbed',
        content: 'steer me',
        turnId: 'turn_live',
      }),
    ])
    expect(tracker.pendingCount).toBe(0)
  })

  test('remove burst stays absorb-pending until FIFO queued_command attachments arrive', () => {
    const tracker = createTracker()
    tracker.observeTurnStarted('turn_live' as TurnId)
    const prompts = ['one', 'two', 'three']
    const actions: ClaudeAttributionAction[] = []

    for (const prompt of prompts) tracker.observeQueueOperation(queueOp('enqueue', prompt))
    for (const prompt of prompts) {
      actions.push(...tracker.observeQueueOperation(queueOp('remove', prompt)))
    }
    for (const prompt of prompts) {
      actions.push(...tracker.observeQueuedCommand(prompt, { type: 'queued_command' }))
    }

    expect(actions).toEqual(
      prompts.map((content) =>
        expect.objectContaining({ kind: 'absorbed', content, turnId: 'turn_live' })
      )
    )
    expect(tracker.pendingCount).toBe(0)
  })

  test('unresolved remove warns once, stays pending, and later absorbs or cancels at teardown', () => {
    const tracker = createTracker()
    tracker.observeTurnStarted('turn_live' as TurnId)
    tracker.observeQueueOperation(queueOp('enqueue', 'later attachment'))

    expect(tracker.observeQueueOperation(queueOp('remove', 'later attachment'))).toEqual([])
    expect(tracker.pendingCount).toBe(1)

    const stop = { hook_event_name: 'Stop' }
    expect(tracker.settleOutstandingRemovals(stop)).toEqual([
      expect.objectContaining({
        kind: 'warning',
        message:
          'Claude queue remove reached a disposition boundary without queued_command evidence',
      }),
    ])
    expect(tracker.pendingCount).toBe(1)
    expect(tracker.settleOutstandingRemovals({ type: 'user' })).toEqual([])
    expect(tracker.pendingCount).toBe(1)

    expect(tracker.observeQueuedCommand('later attachment', { type: 'queued_command' })).toEqual([
      expect.objectContaining({
        kind: 'absorbed',
        content: 'later attachment',
        turnId: 'turn_live',
      }),
    ])
    expect(tracker.pendingCount).toBe(0)

    const teardown = createTracker('remove_teardown')
    teardown.observeQueueOperation(queueOp('enqueue', 'dies with seat'))
    teardown.observeQueueOperation(queueOp('remove', 'dies with seat'))
    expect(teardown.settleOutstandingRemovals(stop)).toEqual([
      expect.objectContaining({ kind: 'warning' }),
    ])
    expect(teardown.pendingCount).toBe(1)
    expect(teardown.teardown()).toEqual([
      expect.objectContaining({
        kind: 'cancelled',
        content: 'dies with seat',
        reason: 'teardown',
      }),
    ])
  })

  test('plain-user warns once and popAll recalls remove-pending items', () => {
    const plain = createTracker('plain_boundary')
    plain.observeTurnStarted('turn_live' as TurnId)
    plain.observeQueueOperation(queueOp('enqueue', 'removed before next user'))
    plain.observeQueueOperation(queueOp('remove', 'removed before next user'))
    plain.observeTurnTerminal('turn_live' as TurnId)
    expect(plain.observePlainUser('next user', { type: 'user' })).toEqual([
      expect.objectContaining({ kind: 'warning' }),
      expect.objectContaining({ kind: 'executed', content: 'next user' }),
    ])
    expect(plain.pendingCount).toBe(1)
    expect(plain.settleOutstandingRemovals({ hook_event_name: 'Stop' })).toEqual([])

    const popped = createTracker('popall_boundary')
    popped.observeQueueOperation(queueOp('enqueue', 'removed before recall'))
    popped.observeQueueOperation(queueOp('remove', 'removed before recall'))
    expect(popped.observeQueueOperation(queueOp('popAll', 'removed before recall'))).toEqual([
      expect.objectContaining({ kind: 'cancelled', reason: 'recalled' }),
    ])
    expect(popped.pendingCount).toBe(0)
  })

  test('dequeue is drain-pending only; the plain user row promotes FIFO 1:1', () => {
    const tracker = createTracker()
    tracker.observeTurnStarted('turn_original' as TurnId)
    tracker.observeQueueOperation(queueOp('enqueue', 'one'))
    tracker.observeQueueOperation(queueOp('enqueue', 'two'))

    expect(tracker.observeQueueOperation(queueOp('dequeue'))).toEqual([])
    expect(tracker.activeTurnId).toBe('turn_original')
    tracker.observeTurnTerminal('turn_original' as TurnId)
    const first = tracker.observePlainUser('one', { type: 'user' })
    expect(first).toEqual([
      expect.objectContaining({ kind: 'executed', content: 'one', turnId: 'turn_inv_attr_1' }),
    ])
    tracker.observeTurnTerminal('turn_inv_attr_1' as TurnId)

    tracker.observeQueueOperation(queueOp('dequeue'))
    const second = tracker.observePlainUser('two', { type: 'user' })
    expect(second).toEqual([
      expect.objectContaining({ kind: 'executed', content: 'two', turnId: 'turn_inv_attr_2' }),
    ])
    expect(tracker.pendingCount).toBe(0)
  })

  test('queued prompt hook evidence cannot promote before dequeue plus plain user evidence', () => {
    const tracker = createTracker()
    tracker.observeTurnStarted('turn_original' as TurnId)
    tracker.observeQueueOperation(queueOp('enqueue', 'one'))
    tracker.observeTurnTerminal('turn_original' as TurnId)

    expect(tracker.observePromptHook('one')).toEqual([])
    expect(tracker.activeTurnId).toBeUndefined()
    expect(tracker.observeQueueOperation(queueOp('dequeue'))).toEqual([])
    expect(tracker.observePlainUser('one', { type: 'user' })).toEqual([
      expect.objectContaining({ kind: 'executed', content: 'one', turnId: 'turn_inv_attr_1' }),
    ])
  })

  test('plain user transcript row dedupes turn already opened by prompt hook evidence', () => {
    const tracker = createTracker()

    expect(tracker.observePromptHook('typed prompt')).toEqual([
      expect.objectContaining({ kind: 'executed', content: 'typed prompt' }),
    ])
    expect(tracker.observePlainUser('typed prompt', { type: 'user' })).toEqual([])
  })

  test('archived round-B ordering interrupts the original before promoting the drain', () => {
    const tracker = createTracker()
    tracker.observeTurnStarted('turn_round_b' as TurnId)
    tracker.observeQueueOperation(queueOp('enqueue', 'CHARLIE'))
    tracker.observeQueueOperation(queueOp('enqueue', 'DELTA'))

    expect(tracker.observeQueueOperation(queueOp('dequeue'))).toEqual([])
    const interrupted = tracker.observeInterrupt({ message: '[Request interrupted by user]' })
    expect(interrupted).toEqual([{ kind: 'interrupted', turnId: 'turn_round_b' }])
    const promoted = tracker.observePlainUser('CHARLIE', { type: 'user' })
    expect(promoted).toEqual([
      expect.objectContaining({ kind: 'executed', content: 'CHARLIE', turnId: 'turn_inv_attr_1' }),
    ])
  })

  test('a requested interrupt terminalizes its evidenced target after a successor user row', () => {
    const tracker = createTracker()
    tracker.observeTurnStarted('turn_original' as TurnId)
    tracker.expectInterrupt()
    tracker.observeTurnStarted('turn_successor' as TurnId)

    expect(tracker.observeInterrupt({ message: '[Request interrupted by user]' })).toEqual([
      { kind: 'interrupted', turnId: 'turn_original' },
    ])
    expect(tracker.activeTurnId).toBe('turn_successor')
  })

  test('a requested interrupt marker after bounded completion is a silent duplicate', () => {
    const tracker = createTracker()
    tracker.observeTurnStarted('turn_fast' as TurnId)
    tracker.expectInterrupt()
    tracker.observeTurnTerminal('turn_fast' as TurnId)

    expect(tracker.observeInterrupt({ message: '[Request interrupted by user]' })).toEqual([])
  })

  test('popAll cancels recalled items and teardown cancels every survivor', () => {
    const tracker = createTracker()
    tracker.observeTurnStarted('turn_live' as TurnId)
    tracker.observeQueueOperation(queueOp('enqueue', 'recalled'))
    tracker.observeQueueOperation(queueOp('enqueue', 'dies with seat'))

    expect(tracker.observeQueueOperation(queueOp('popAll', 'recalled'))).toEqual([
      expect.objectContaining({ kind: 'cancelled', content: 'recalled', reason: 'recalled' }),
    ])
    expect(tracker.teardown()).toEqual([
      expect.objectContaining({
        kind: 'cancelled',
        content: 'dies with seat',
        reason: 'teardown',
      }),
    ])
  })

  test('unclassifiable queue vocabulary emits a warning instead of guessing', () => {
    const tracker = createTracker()
    const raw = queueOp('mystery', 'payload')
    expect(tracker.observeQueueOperation(raw)).toEqual([
      { kind: 'warning', message: 'Unknown Claude queue operation: mystery', raw },
    ])
    expect(tracker.observeQueueOperation(queueOp('dequeue'))[0]).toMatchObject({
      kind: 'warning',
      message: 'Unmatched Claude queue dequeue',
    })
  })

  test('broker correlation id opens only on execution and never on absorption', () => {
    const absorbed = createTracker('inv_broker_absorb')
    absorbed.observeTurnStarted('turn_live' as TurnId)
    absorbed.trackBrokerSubmission({
      submissionId: 'input_absorb',
      inputId: 'input_absorb',
      allocatedTurnId: 'turn_allocated' as TurnId,
      content: 'broker steer',
    })
    absorbed.observeQueueOperation(queueOp('enqueue', 'broker steer'))
    absorbed.observePromptHook('broker steer')
    absorbed.observeQueueOperation(queueOp('remove', 'broker steer'))
    const landed = absorbed.observeQueuedCommand('broker steer', {})
    expect(landed).toEqual([
      expect.objectContaining({
        kind: 'absorbed',
        submissionId: 'input_absorb',
        turnId: 'turn_live',
      }),
    ])
    expect(landed.some((action) => 'turnId' in action && action.turnId === 'turn_allocated')).toBe(
      false
    )

    const executed = createTracker('inv_broker_execute')
    executed.trackBrokerSubmission({
      submissionId: 'input_execute',
      inputId: 'input_execute',
      allocatedTurnId: 'turn_allocated' as TurnId,
      content: 'idle input',
    })
    expect(executed.observePlainUser('idle input', {})).toEqual([
      expect.objectContaining({
        kind: 'executed',
        submissionId: 'input_execute',
        turnId: 'turn_allocated',
      }),
    ])
  })
})

type ArchiveRow = Record<string, unknown>

const artifactRoot = join(process.env['HOME'] ?? '', 'praesidium/var/wrkq-artifacts/T-07849')
const archiveOne = join(artifactRoot, 'e2e-enqueue-pin-transcript-73efc2a5.jsonl')
const archiveTwo = join(artifactRoot, 'e2e-enqueue-pin2-transcript-36022e44.jsonl')
const archiveThree = join(artifactRoot, 'e2e-enqueue-pin3-transcript-f3003503.jsonl')
const preemptBoundaryArchive = join(
  import.meta.dir,
  '../../fixtures/claude-preempt-drain-boundary-d8c2534f.rows23-45.jsonl'
)
const archiveTest = existsSync(archiveOne) && existsSync(archiveTwo) ? test : test.skip
const archiveThreeTest = existsSync(archiveThree) ? test : test.skip

const readArchive = (path: string): ArchiveRow[] =>
  readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as ArchiveRow)

const promptFromUserRow = (row: ArchiveRow): string | 'interrupted' | undefined => {
  const message = row['message']
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  const content = (message as ArchiveRow)['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((part) =>
      part !== null && typeof part === 'object' && !Array.isArray(part)
        ? (part as ArchiveRow)['text']
        : undefined
    )
    .filter((value): value is string => typeof value === 'string')
    .join('')
  return text === '[Request interrupted by user]' ||
    text === '[Request interrupted by user for tool use]'
    ? 'interrupted'
    : undefined
}

const replayRows = (
  tracker: ReturnType<typeof createTracker>,
  rows: ArchiveRow[],
  actions: ClaudeAttributionAction[]
): void => {
  for (const row of rows) {
    if (row['type'] === 'queue-operation') {
      actions.push(
        ...tracker.observeQueueOperation(row as Parameters<typeof tracker.observeQueueOperation>[0])
      )
      continue
    }
    if (row['type'] === 'attachment') {
      const attachment = row['attachment']
      if (
        attachment !== null &&
        typeof attachment === 'object' &&
        !Array.isArray(attachment) &&
        (attachment as ArchiveRow)['type'] === 'queued_command'
      ) {
        const prompt = (attachment as ArchiveRow)['prompt']
        actions.push(
          ...tracker.observeQueuedCommand(typeof prompt === 'string' ? prompt : undefined, row)
        )
      }
      continue
    }
    if (row['type'] !== 'user') continue
    const prompt = promptFromUserRow(row)
    if (prompt === 'interrupted') actions.push(...tracker.observeInterrupt(row))
    else if (prompt !== undefined) actions.push(...tracker.observePlainUser(prompt, row))
  }
}

describe('T-07849 archived transcript replays', () => {
  archiveThreeTest('session 3 absorbs human remove×3 then attachment×3 FIFO', () => {
    const rows = readArchive(archiveThree)
    const tracker = createTracker('archive_pin3_human')
    const sequence = rows.slice(28, 55)
    const basePrompt = promptFromUserRow(sequence[0] ?? {})
    expect(typeof basePrompt).toBe('string')
    tracker.observePromptHook(
      basePrompt === 'interrupted' ? undefined : basePrompt,
      'turn_pin3_human' as TurnId
    )
    const actions: ClaudeAttributionAction[] = []

    replayRows(tracker, sequence, actions)

    expect(actions).toEqual([
      expect.objectContaining({
        kind: 'absorbed',
        content: 'ROUND3_DRAIN_ONE: reply exactly DRAIN_ONE',
      }),
      expect.objectContaining({
        kind: 'absorbed',
        content: 'ROUND3_DRAIN_TWO: reply exactly DRAIN_TWO',
      }),
      expect.objectContaining({
        kind: 'absorbed',
        content: 'ROUND3_DRAIN_THREE: reply exactly DRAIN_THREE',
      }),
    ])
    expect(tracker.pendingCount).toBe(0)
  })

  archiveThreeTest(
    'session 3 absorbs broker remove×3 then attachment×3 with input correlation',
    () => {
      const rows = readArchive(archiveThree)
      const sequence = rows.slice(58, 74)
      const tracker = createTracker('archive_pin3_broker')
      const basePrompt = promptFromUserRow(sequence[0] ?? {})
      expect(typeof basePrompt).toBe('string')
      tracker.observePromptHook(
        basePrompt === 'interrupted' ? undefined : basePrompt,
        'turn_pin3_broker' as TurnId
      )
      const prompts = sequence
        .filter((row) => row['type'] === 'queue-operation' && row['operation'] === 'enqueue')
        .map((row) => row['content'])
        .filter((content): content is string => typeof content === 'string')
      for (const [index, content] of prompts.entries()) {
        tracker.trackBrokerSubmission({
          submissionId: `input_pin3_${index + 1}`,
          inputId: `input_pin3_${index + 1}`,
          allocatedTurnId: `turn_allocated_${index + 1}` as TurnId,
          content,
        })
      }
      const actions: ClaudeAttributionAction[] = []

      replayRows(tracker, sequence, actions)

      expect(
        actions.map((action) => ({
          kind: action.kind,
          ...('submissionId' in action ? { submissionId: action.submissionId } : {}),
          ...('turnId' in action ? { turnId: action.turnId } : {}),
        }))
      ).toEqual([
        { kind: 'absorbed', submissionId: 'input_pin3_1', turnId: 'turn_pin3_broker' },
        { kind: 'absorbed', submissionId: 'input_pin3_2', turnId: 'turn_pin3_broker' },
        { kind: 'absorbed', submissionId: 'input_pin3_3', turnId: 'turn_pin3_broker' },
      ])
      expect(tracker.pendingCount).toBe(0)
    }
  )

  archiveTest('session 1 round 5 absorbs three prompts into one live turn', () => {
    const rows = readArchive(archiveOne)
    const tracker = createTracker('archive_round5')
    tracker.observeTurnStarted('turn_round5' as TurnId)
    const actions: ClaudeAttributionAction[] = []
    replayRows(tracker, rows.slice(218, 240), actions)
    expect(actions.filter((action) => action.kind === 'absorbed')).toHaveLength(3)
    expect(
      actions
        .filter((action) => action.kind === 'absorbed')
        .map((action) => ('turnId' in action ? action.turnId : undefined))
    ).toEqual(['turn_round5', 'turn_round5', 'turn_round5'])
    expect(tracker.pendingCount).toBe(0)
  })

  archiveTest('session 1 round 3 promotes three drained turns FIFO', () => {
    const rows = readArchive(archiveOne)
    const tracker = createTracker('archive_round3')
    tracker.observeTurnStarted('turn_round3' as TurnId)
    const actions: ClaudeAttributionAction[] = []
    replayRows(tracker, rows.slice(109, 112), actions)
    tracker.observeTurnTerminal('turn_round3' as TurnId)
    for (const [start, end] of [
      [113, 118],
      [120, 125],
      [127, 132],
    ] as const) {
      replayRows(tracker, rows.slice(start, end), actions)
      const active = tracker.activeTurnId
      if (active !== undefined) tracker.observeTurnTerminal(active)
    }
    expect(
      actions.filter((action) => action.kind === 'executed').map((action) => action.content)
    ).toEqual([
      'Reply with exactly: DONE-B3 (nothing else)',
      'Reply with exactly: DONE-C3 (nothing else)',
      'Reply with exactly: DONE-D3 (nothing else)',
    ])
  })

  archiveTest(
    'session 2 replays partial-drain recall, dequeue-before-Esc, steer, and teardown',
    () => {
      const rows = readArchive(archiveTwo)

      const roundA = createTracker('archive_round_a')
      roundA.observeTurnStarted('turn_round_a' as TurnId)
      const a: ClaudeAttributionAction[] = []
      replayRows(roundA, rows.slice(31, 36), a)
      roundA.observeTurnTerminal('turn_round_a' as TurnId)
      replayRows(roundA, rows.slice(36, 40), a)
      if (roundA.activeTurnId !== undefined) roundA.observeTurnTerminal(roundA.activeTurnId)
      replayRows(roundA, rows.slice(40, 42), a)
      expect(a.map((action) => action.kind)).toEqual(['executed', 'cancelled'])

      const roundB = createTracker('archive_round_b')
      roundB.observeTurnStarted('turn_round_b' as TurnId)
      const b: ClaudeAttributionAction[] = []
      replayRows(roundB, rows.slice(49, 56), b)
      expect(b.map((action) => action.kind)).toEqual(['interrupted', 'executed'])
      expect((b[0] as { turnId: string }).turnId).toBe('turn_round_b')
      if (roundB.activeTurnId !== undefined) roundB.observeTurnTerminal(roundB.activeTurnId)
      replayRows(roundB, rows.slice(65, 70), b)
      expect(b.filter((action) => action.kind === 'executed')).toHaveLength(2)

      const roundC = createTracker('archive_round_c')
      roundC.observeTurnStarted('turn_round_c' as TurnId)
      const c: ClaudeAttributionAction[] = []
      replayRows(roundC, rows.slice(109, 116), c)
      expect(c.filter((action) => action.kind === 'absorbed')).toHaveLength(1)

      const roundD = createTracker('archive_round_d')
      roundD.observeTurnStarted('turn_round_d' as TurnId)
      const d: ClaudeAttributionAction[] = []
      replayRows(roundD, rows.slice(271, 272), d)
      d.push(...roundD.teardown())
      expect(d).toEqual([expect.objectContaining({ kind: 'cancelled', reason: 'teardown' })])
    }
  )
})

describe('T-07859 archived preempt drain-boundary failure', () => {
  test('drained user rows have no request evidence and therefore must not trigger C-c', () => {
    const rows = readArchive(preemptBoundaryArchive)
    const drainedIndexes = rows
      .map((row, index) => ({ index, prompt: promptFromUserRow(row) }))
      .filter(
        (entry): entry is { index: number; prompt: string } =>
          typeof entry.prompt === 'string' && entry.prompt.includes('_QUEUED_')
      )
      .map((entry) => entry.index)

    expect(drainedIndexes).toHaveLength(2)
    const firstDrain = drainedIndexes[0]!
    expect(rows.slice(firstDrain).filter((row) => row['type'] === 'assistant')).toHaveLength(0)
    expect(
      rows
        .slice(firstDrain)
        .filter((row) => row['type'] === 'user')
        .map(promptFromUserRow)
        .filter((prompt) => prompt === 'interrupted')
    ).toHaveLength(2)
  })
})
