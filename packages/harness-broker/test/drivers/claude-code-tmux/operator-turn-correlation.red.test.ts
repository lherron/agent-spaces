import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

type ClaudeCodeHookEventNormalizer = {
  normalizeHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
}

const now = () => new Date('2026-05-26T22:30:00.000Z')

const eventShape = (event: InvocationEventEnvelope) => ({
  type: event.type,
  turnId: event.turnId,
  invocationId: event.invocationId,
})

const eventShapes = (events: InvocationEventEnvelope[]) => events.map(eventShape)

function createAllocator(invocationId: string) {
  let turnCounter = 0
  return () => {
    turnCounter += 1
    return `turn_${invocationId}_${turnCounter}`
  }
}

const createNormalizer = async (
  invocationId: string,
  allocateTurnId = createAllocator(invocationId)
): Promise<ClaudeCodeHookEventNormalizer> => {
  const target = (await import('../../../src/drivers/claude-code-tmux/hook-events')) as {
    createClaudeCodeHookEventNormalizer: (options: {
      invocationId: string
      now: () => Date
      allocateTurnId?: (() => string) | undefined
    }) => ClaudeCodeHookEventNormalizer
  }

  return target.createClaudeCodeHookEventNormalizer({
    invocationId,
    now,
    allocateTurnId,
  })
}

describe('claude-code-tmux operator turn correlation RED', () => {
  test('turn-id-less operator prompt after a completed manager turn opens and completes a fresh turn', async () => {
    const invocationId = 'inv'
    const allocateTurnId = createAllocator(invocationId)
    const normalizer = await createNormalizer(invocationId, allocateTurnId)
    const managerTurnId = allocateTurnId()

    const events = [
      ...normalizer.normalizeHook({
        hook_event_name: 'UserPromptSubmit',
        turn_id: managerTurnId,
        prompt: 'manager turn',
      }),
      ...normalizer.normalizeHook({ hook_event_name: 'Stop', turn_id: managerTurnId }),
      ...normalizer.normalizeHook({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'operator typed turn',
      }),
      ...normalizer.normalizeHook({ hook_event_name: 'Stop' }),
    ]

    expect(eventShapes(events)).toEqual([
      { invocationId, type: 'turn.started', turnId: 'turn_inv_1' },
      { invocationId, type: 'turn.completed', turnId: 'turn_inv_1' },
      { invocationId, type: 'turn.started', turnId: 'turn_inv_2' },
      { invocationId, type: 'turn.completed', turnId: 'turn_inv_2' },
    ])
  })

  test('cold-start turn-id-less operator prompt mints the first turn id', async () => {
    const invocationId = 'inv'
    const normalizer = await createNormalizer(invocationId)

    const events = normalizer.normalizeHook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'operator typed first',
    })

    expect(eventShapes(events)).toEqual([
      { invocationId, type: 'turn.started', turnId: 'turn_inv_1' },
    ])
  })

  test('manager prompt and stop still correlate to the id returned by the shared allocator', async () => {
    const invocationId = 'inv'
    const allocateTurnId = createAllocator(invocationId)
    const normalizer = await createNormalizer(invocationId, allocateTurnId)
    const applyInputTurnId = allocateTurnId()

    const events = [
      ...normalizer.normalizeHook({
        hook_event_name: 'UserPromptSubmit',
        turn_id: applyInputTurnId,
        prompt: 'manager turn',
      }),
      ...normalizer.normalizeHook({ hook_event_name: 'Stop', turn_id: applyInputTurnId }),
    ]

    expect(eventShapes(events)).toEqual([
      { invocationId, type: 'turn.started', turnId: applyInputTurnId },
      { invocationId, type: 'turn.completed', turnId: applyInputTurnId },
    ])
  })
})
