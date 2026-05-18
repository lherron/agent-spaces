import { describe, expect, test } from 'bun:test'

import type { UnifiedSessionEvent } from 'spaces-runtime'

import { createPiEventMappingState, mapPiEventToUnified } from './pi-session.js'
import type { PiAgentSessionEvent } from './types.js'

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
})
