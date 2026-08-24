import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { assertSharedCommandTurn } from '../testing/pre-hrc-broker-contract-assertions.js'

const invocationId = 'inv_shared_command'
const turnId = 'turn_command'
const expectedMarker = 'SHARED_MARKER'

function event(
  seq: number,
  type: InvocationEventEnvelope['type'],
  overrides: Partial<InvocationEventEnvelope> = {}
): InvocationEventEnvelope {
  return {
    invocationId,
    seq,
    time: '2026-05-26T00:00:00.000Z',
    type,
    ...overrides,
  } as InvocationEventEnvelope
}

function commandTurnEvents({
  toolName,
  toolCallId = 'tool_call_1',
  completedToolCallId = toolCallId,
  completedIsError,
  markerLocation = 'assistant-delta',
}: {
  toolName: string
  toolCallId?: string
  completedToolCallId?: string
  completedIsError?: boolean | undefined
  markerLocation?: 'assistant-delta' | 'assistant-completed' | 'turn-completed' | 'absent'
}): InvocationEventEnvelope[] {
  const events: InvocationEventEnvelope[] = [
    event(1, 'turn.started', { turnId, payload: { turnId } }),
    event(2, 'tool.call.started', {
      turnId,
      payload: {
        toolCallId,
        name: toolName,
        input: { command: `printf '${expectedMarker}'` },
      },
    }),
  ]

  events.push(
    event(3, 'tool.call.completed', {
      turnId,
      payload: {
        toolCallId: completedToolCallId,
        name: toolName,
        isError: completedIsError,
        result: { exitCode: 0, output: `${expectedMarker}\n` },
      },
    })
  )

  if (markerLocation === 'assistant-delta') {
    events.push(event(4, 'assistant.message.delta', { turnId, payload: { text: expectedMarker } }))
  }
  if (markerLocation === 'assistant-completed') {
    events.push(
      event(4, 'assistant.message.completed', {
        turnId,
        payload: { content: [{ type: 'text', text: expectedMarker }] },
      })
    )
  }

  events.push(
    event(5, 'turn.completed', {
      turnId,
      payload: {
        turnId,
        status: 'completed',
        finalOutput: markerLocation === 'turn-completed' ? expectedMarker : 'done',
      },
    })
  )

  return events
}

describe('assertSharedCommandTurn RED', () => {
  test('accepts a Codex-shaped command turn with assistant marker text', () => {
    const failures = assertSharedCommandTurn(commandTurnEvents({ toolName: 'command' }), {
      turnId,
      expectedMarker,
    })

    expect(failures).toEqual([])
  })

  test('accepts a Claude-shaped Bash turn with marker in final turn output', () => {
    const failures = assertSharedCommandTurn(
      commandTurnEvents({ toolName: 'Bash', markerLocation: 'turn-completed' }),
      { turnId, expectedMarker }
    )

    expect(failures).toEqual([])
  })

  test('reports missing, mismatched, and error tool completions plus absent marker', () => {
    expect(
      assertSharedCommandTurn(
        commandTurnEvents({ toolName: 'command' }).filter(
          (candidate) => candidate.type !== 'tool.call.completed'
        ),
        { turnId, expectedMarker }
      )
    ).not.toEqual([])

    expect(
      assertSharedCommandTurn(
        commandTurnEvents({ toolName: 'command', completedToolCallId: 'different_tool_call' }),
        { turnId, expectedMarker }
      )
    ).not.toEqual([])

    expect(
      assertSharedCommandTurn(commandTurnEvents({ toolName: 'Bash', completedIsError: true }), {
        turnId,
        expectedMarker,
      })
    ).not.toEqual([])

    expect(
      assertSharedCommandTurn(
        commandTurnEvents({ toolName: 'command', markerLocation: 'absent' }),
        { turnId, expectedMarker }
      )
    ).not.toEqual([])
  })
})
