import { describe, expect, test } from 'bun:test'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { DriverContext } from 'spaces-harness-broker'
import type { InvocationEventEnvelope, TurnId } from 'spaces-harness-broker-protocol'
import { PiSdkTurnEventMapper } from '../src/event-mapper'

type CapturedEvent = Pick<InvocationEventEnvelope, 'type' | 'payload' | 'turnId' | 'itemId'>

describe('PiSdkTurnEventMapper', () => {
  test('collapses model rounds, holds the latest final flag, and advances continuation on settle', () => {
    const { ctx, events } = createContext()
    const mapper = new PiSdkTurnEventMapper({
      ctx,
      provider: 'openai',
      sessionFile: () => '/tmp/pi-session.jsonl',
    })
    mapper.beginTurn({ turnId: 'turn-1' as TurnId, structured: false })

    mapper.handle(piEvent({ type: 'agent_start' }))
    mapper.handle(piEvent({ type: 'turn_start' }))
    emitAssistant(mapper, 'first round')
    mapper.handle(
      piEvent({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { command: 'exit 7' },
      })
    )
    mapper.handle(
      piEvent({
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'bash',
        result: { exitCode: 7 },
        isError: false,
      })
    )
    mapper.handle(piEvent({ type: 'turn_end' }))
    mapper.handle(piEvent({ type: 'turn_start' }))
    emitAssistant(mapper, 'final round')
    mapper.handle(piEvent({ type: 'agent_end' }))

    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)
    mapper.handle(piEvent({ type: 'agent_settled' }))

    const completions = events.filter(
      (event) => event.type === 'assistant.message.completed'
    ) as Array<CapturedEvent & { payload: { final?: boolean; content: unknown } }>
    expect(completions.map((event) => event.payload.final)).toEqual([false, true])
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'tool.call.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'tool.call.failed')).toHaveLength(0)
    expect(events.at(-1)?.type).toBe('continuation.updated')
  })

  test('synthesizes the only final message for valid structured output', () => {
    const { ctx, events } = createContext()
    const mapper = new PiSdkTurnEventMapper({
      ctx,
      provider: 'anthropic',
      sessionFile: () => '/tmp/structured.jsonl',
    })
    mapper.beginTurn({ turnId: 'turn-structured' as TurnId, structured: true })
    emitAssistant(mapper, 'I will call the tool.')
    mapper.recordStructuredResult('{"answer":42}')
    mapper.handle(piEvent({ type: 'agent_settled' }))

    const finalMessages = events.filter(
      (event) =>
        event.type === 'assistant.message.completed' &&
        (event.payload as { final?: boolean }).final === true
    )
    expect(finalMessages).toHaveLength(1)
    expect(finalMessages[0]?.payload).toEqual({
      messageId: 'turn-structured_structured_final',
      content: [{ type: 'text', text: '{"answer":42}' }],
      final: true,
    })
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
  })

  test('retries one structured miss then fails visibly without continuation', () => {
    const { ctx, events } = createContext()
    const mapper = new PiSdkTurnEventMapper({
      ctx,
      provider: 'openai',
      sessionFile: () => '/tmp/must-not-advance.jsonl',
    })
    mapper.beginTurn({ turnId: 'turn-miss' as TurnId, structured: true })
    mapper.recordStructuredMiss('invalid args')
    mapper.handle(piEvent({ type: 'agent_settled' }))

    expect(mapper.consumeSettlementAction()).toBe('retry')
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(0)

    mapper.beginStructuredRetry()
    mapper.handle(piEvent({ type: 'agent_settled' }))

    const failure = events.find((event) => event.type === 'turn.failed')
    expect(failure?.payload).toMatchObject({ code: 'structured_output_unsatisfied' })
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'continuation.updated')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'diagnostic')).toHaveLength(2)
  })

  test('fails an unterminated tool bracket only on infrastructure failure', () => {
    const { ctx, events } = createContext()
    const mapper = new PiSdkTurnEventMapper({
      ctx,
      provider: 'openai',
      sessionFile: () => '/tmp/not-advanced.jsonl',
    })
    mapper.beginTurn({ turnId: 'turn-infra' as TurnId, structured: false })
    mapper.handle(
      piEvent({
        type: 'tool_execution_start',
        toolCallId: 'tool-infra',
        toolName: 'bash',
        args: { command: 'echo hello' },
      })
    )
    mapper.requestFailure('sdk_transport_failed', 'session event stream failed')
    mapper.settleRequestedTerminal()

    expect(events.filter((event) => event.type === 'tool.call.failed')).toHaveLength(1)
    expect(events.find((event) => event.type === 'tool.call.failed')?.payload).toMatchObject({
      code: 'sdk_transport_failed',
    })
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)
  })
})

function emitAssistant(mapper: PiSdkTurnEventMapper, text: string): void {
  mapper.handle(piEvent({ type: 'message_start', message: assistantMessage('') }))
  mapper.handle(
    piEvent({
      type: 'message_update',
      message: assistantMessage(text),
      assistantMessageEvent: { type: 'text_delta', delta: text },
    })
  )
  mapper.handle(piEvent({ type: 'message_end', message: assistantMessage(text) }))
}

function assistantMessage(text: string): unknown {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
    stopReason: 'stop',
  }
}

function piEvent(event: Record<string, unknown>): AgentSessionEvent {
  return event as unknown as AgentSessionEvent
}

function createContext(): { ctx: DriverContext; events: CapturedEvent[] } {
  const events: CapturedEvent[] = []
  const emit = ((type: string, payload: unknown, extra?: Record<string, unknown>) => {
    const event = {
      type,
      payload,
      ...(typeof extra?.turnId === 'string' ? { turnId: extra.turnId } : {}),
      ...(typeof extra?.itemId === 'string' ? { itemId: extra.itemId } : {}),
    } as CapturedEvent
    events.push(event)
    return event
  }) as DriverContext['emit']
  return {
    events,
    ctx: {
      invocationId: 'invocation-test',
      clientCapabilities: {},
      emit,
      emitEvent: (() => {
        throw new Error('unused')
      }) as DriverContext['emitEvent'],
    } as DriverContext,
  }
}
