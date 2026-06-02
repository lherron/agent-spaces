import { describe, expect, test } from 'bun:test'

import type { UnifiedSessionEvent } from 'spaces-runtime'

import { createPiEventMappingState, mapPiEventToUnified } from './pi-session.js'
import type { PiAgentSessionEvent } from './types.js'

function assistantMessageEnd(messageId: string, text: string): PiAgentSessionEvent {
  return {
    type: 'message_end',
    messageId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }
}

function turnEnd(messageId: string, text: string): PiAgentSessionEvent {
  return {
    type: 'turn_end',
    messageId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }
}

function turnEndBare(): PiAgentSessionEvent {
  return { type: 'turn_end' }
}

function toolOnlyAssistantMessageEnd(messageId: string): PiAgentSessionEvent {
  return {
    type: 'message_end',
    messageId,
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'spark', arguments: {} }],
    },
  }
}

function messageEndEvents(
  events: UnifiedSessionEvent[]
): Extract<UnifiedSessionEvent, { type: 'message_end' }>[] {
  return events.filter(
    (event): event is Extract<UnifiedSessionEvent, { type: 'message_end' }> =>
      event.type === 'message_end'
  )
}

/** final flags for every assistant-bearing message_end, in emission order. */
function assistantFinalFlags(events: UnifiedSessionEvent[]): unknown[] {
  return messageEndEvents(events)
    .filter((event) => event.message?.role === 'assistant')
    .map((event) => (event.payload as { final?: unknown } | undefined)?.final)
}

describe('pi session event mapping', () => {
  test('turn_end assistant message fallback emits unified assistant message_end', () => {
    const state = createPiEventMappingState()
    const events = mapPiEventToUnified(
      {
        type: 'turn_end',
        messageId: 'pi-msg-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from pi' }],
        },
      } satisfies PiAgentSessionEvent,
      'session-1',
      state
    )

    expect(events.map((event) => event.type)).toEqual(['message_end', 'turn_end'])
    expect((events[0] as Extract<UnifiedSessionEvent, { type: 'message_end' }>).message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello from pi' }],
    })
  })

  test('turn_end fallback preserves true empty response detection', () => {
    const events = mapPiEventToUnified(
      {
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [],
        },
      } satisfies PiAgentSessionEvent,
      'session-1'
    )

    expect(events.map((event) => event.type)).toEqual(['turn_end'])
  })

  test('turn_end fallback does not duplicate an observed assistant message_end', () => {
    const state = createPiEventMappingState()

    const direct = mapPiEventToUnified(
      {
        type: 'message_end',
        messageId: 'pi-msg-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'already observed' }],
        },
      } satisfies PiAgentSessionEvent,
      'session-1',
      state
    )
    const end = mapPiEventToUnified(
      {
        type: 'turn_end',
        messageId: 'pi-msg-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'already observed' }],
        },
      } satisfies PiAgentSessionEvent,
      'session-1',
      state
    )

    expect([...direct, ...end].map((event) => event.type)).toEqual(['message_end', 'turn_end'])
  })

  test('agent_end messages fallback captures latest assistant when turn_end lacks it', () => {
    const events = mapPiEventToUnified(
      {
        type: 'agent_end',
        messages: [
          { role: 'user', content: 'prompt' },
          { role: 'assistant', content: [{ type: 'text', text: 'final assistant' }] },
        ],
      } satisfies PiAgentSessionEvent,
      'session-1'
    )

    expect(events.map((event) => event.type)).toEqual(['message_end', 'agent_end'])
    expect((events[0] as Extract<UnifiedSessionEvent, { type: 'message_end' }>).message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'final assistant' }],
    })
  })

  test('message_update maps only true text deltas, not cumulative message content', () => {
    const delta = mapPiEventToUnified(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'SP' },
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'SP' }],
        },
      } satisfies PiAgentSessionEvent,
      'session-1'
    )
    const textEnd = mapPiEventToUnified(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_end', content: 'SPARKY_T01517_SMOKE_2' },
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'SPARKY_T01517_SMOKE_2' }],
        },
      } satisfies PiAgentSessionEvent,
      'session-1'
    )

    expect(delta[0]).toMatchObject({ type: 'message_update', textDelta: 'SP' })
    expect(textEnd[0]).toEqual({ type: 'message_update' })
  })

  test('holds latest assistant message, emits intermediates as non-final, and finalizes on turn_end', () => {
    const state = createPiEventMappingState()

    const first = mapPiEventToUnified(
      assistantMessageEnd('pi-msg-1', 'first note'),
      'session-1',
      state
    )
    expect(first).toEqual([])

    const second = mapPiEventToUnified(
      assistantMessageEnd('pi-msg-2', 'second note'),
      'session-1',
      state
    )
    expect(messageEndEvents(second)).toEqual([
      {
        type: 'message_end',
        messageId: 'pi-msg-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'first note' }],
        },
        payload: { final: false },
      },
    ])

    const third = mapPiEventToUnified(
      assistantMessageEnd('pi-msg-3', 'final note'),
      'session-1',
      state
    )
    expect(messageEndEvents(third)).toEqual([
      {
        type: 'message_end',
        messageId: 'pi-msg-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'second note' }],
        },
        payload: { final: false },
      },
    ])

    const end = mapPiEventToUnified(turnEnd('pi-msg-3', 'final note'), 'session-1', state)
    expect(end.map((event) => event.type)).toEqual(['message_end', 'turn_end'])
    expect(messageEndEvents(end)).toEqual([
      {
        type: 'message_end',
        messageId: 'pi-msg-3',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final note' }],
        },
        payload: { final: true },
      },
    ])
  })

  test('single assistant message turn emits only the final message on turn_end', () => {
    const state = createPiEventMappingState()

    const direct = mapPiEventToUnified(
      assistantMessageEnd('pi-msg-1', 'only final'),
      'session-1',
      state
    )
    expect(direct).toEqual([])

    const end = mapPiEventToUnified(turnEnd('pi-msg-1', 'only final'), 'session-1', state)
    expect(end.map((event) => event.type)).toEqual(['message_end', 'turn_end'])
    expect(messageEndEvents(end)).toEqual([
      {
        type: 'message_end',
        messageId: 'pi-msg-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'only final' }],
        },
        payload: { final: true },
      },
    ])
  })

  test('agent lifecycle: native turn_ends are internal; only agent_end finalizes (N-1 final:false + 1 final:true)', () => {
    const state = createPiEventMappingState()
    const all: UnifiedSessionEvent[] = []
    const push = (event: PiAgentSessionEvent): void => {
      all.push(...mapPiEventToUnified(event, 'session-1', state))
    }

    push({ type: 'agent_start' })
    // Three native model-rounds inside ONE operator turn. Each round closes with
    // a native turn_end that must NOT finalize the held assistant message.
    push({ type: 'turn_start' })
    push(assistantMessageEnd('pi-msg-1', 'first note'))
    push(turnEndBare())
    push({ type: 'turn_start' })
    push(assistantMessageEnd('pi-msg-2', 'second note'))
    push(turnEndBare())
    push({ type: 'turn_start' })
    push(assistantMessageEnd('pi-msg-3', 'final note'))
    push(turnEndBare())
    push({ type: 'agent_end' })

    // >=2 intermediate final:false BEFORE the terminal, then exactly one final:true.
    expect(assistantFinalFlags(all)).toEqual([false, false, true])

    const assistantEnds = messageEndEvents(all).filter(
      (event) => event.message?.role === 'assistant'
    )
    expect(assistantEnds).toEqual([
      {
        type: 'message_end',
        messageId: 'pi-msg-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first note' }] },
        payload: { final: false },
      },
      {
        type: 'message_end',
        messageId: 'pi-msg-2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'second note' }] },
        payload: { final: false },
      },
      {
        type: 'message_end',
        messageId: 'pi-msg-3',
        message: { role: 'assistant', content: [{ type: 'text', text: 'final note' }] },
        payload: { final: true },
      },
    ])

    // The terminal final:true is the LAST event before agent_end, never after it.
    const terminalIdx = all.findIndex(
      (event) =>
        event.type === 'message_end' &&
        (event.payload as { final?: unknown } | undefined)?.final === true
    )
    const agentEndIdx = all.findIndex((event) => event.type === 'agent_end')
    expect(terminalIdx).toBeGreaterThanOrEqual(0)
    expect(terminalIdx).toBeLessThan(agentEndIdx)
  })

  test('agent lifecycle: tool-only assistant message_end surfaces no completion', () => {
    const state = createPiEventMappingState()

    expect(mapPiEventToUnified({ type: 'agent_start' }, 'session-1', state)).toEqual([
      { type: 'agent_start', sessionId: 'session-1' },
    ])
    expect(mapPiEventToUnified({ type: 'turn_start' }, 'session-1', state)).toEqual([
      { type: 'turn_start' },
    ])
    // A tool-call-only assistant message is not a natural assistant message: it
    // must NOT surface as a completion (its tool call surfaces via tool_execution).
    expect(
      mapPiEventToUnified(toolOnlyAssistantMessageEnd('pi-msg-tool'), 'session-1', state)
    ).toEqual([])

    // The text reply for the round is the held terminal, finalized at agent_end.
    expect(
      mapPiEventToUnified(assistantMessageEnd('pi-msg-1', 'done'), 'session-1', state)
    ).toEqual([])
    const end = mapPiEventToUnified({ type: 'agent_end' }, 'session-1', state)
    expect(assistantFinalFlags(end)).toEqual([true])
    expect(messageEndEvents(end)[0]?.message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    })
  })
})
