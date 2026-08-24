import { describe, expect, test } from 'bun:test'
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'
import type { DriverContext } from 'spaces-harness-broker'
import type { InvocationEventEnvelope, TurnId } from 'spaces-harness-broker-protocol'
import { createPiSdkPermissionBridge } from '../src/permissions'

type CapturedEvent = Pick<InvocationEventEnvelope, 'type' | 'payload'>

describe('pi SDK permission bridge', () => {
  test('applies local allow and deny policy without asking the broker', async () => {
    let requestCount = 0
    const brokerContext = {
      brokerOwnsPermissionLifecycle: true,
      requestPermission: async () => {
        requestCount += 1
        return { decision: 'deny' as const }
      },
    }
    const allowed = createPiSdkPermissionBridge({
      ctx: createContext([], brokerContext),
      policy: { mode: 'allow' },
      activeTurnId: () => 'turn-1' as TurnId,
    })
    const denied = createPiSdkPermissionBridge({
      ctx: createContext([], brokerContext),
      policy: { mode: 'deny' },
      activeTurnId: () => 'turn-1' as TurnId,
    })

    expect(await allowed.handle(toolCall())).toBeUndefined()
    expect(await denied.handle(toolCall())).toEqual({
      block: true,
      reason: 'Denied by invocation permission policy',
    })
    expect(requestCount).toBe(0)
  })

  test('broker-owned flow emits requested, awaits final decision, and never emits resolved', async () => {
    const events: CapturedEvent[] = []
    let requestCount = 0
    const ctx = createContext(events, {
      brokerOwnsPermissionLifecycle: true,
      requestPermission: async () => {
        requestCount += 1
        return { decision: 'deny', message: 'operator denied' }
      },
    })
    const bridge = createPiSdkPermissionBridge({
      ctx,
      policy: { mode: 'ask-client', timeoutMs: 1, defaultDecision: 'allow' },
      activeTurnId: () => 'turn-1' as TurnId,
    })

    expect(await bridge.handle(toolCall())).toEqual({
      block: true,
      reason: 'operator denied',
    })
    expect(requestCount).toBe(1)
    expect(events.map((event) => event.type)).toEqual(['permission.requested'])
  })
})

function toolCall(): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId: 'tool-1',
    toolName: 'bash',
    input: { command: 'touch forbidden' },
  } as ToolCallEvent
}

function createContext(events: CapturedEvent[], extra: Partial<DriverContext> = {}): DriverContext {
  const emit = ((type: string, payload: unknown) => {
    const event = { type, payload } as CapturedEvent
    events.push(event)
    return event
  }) as DriverContext['emit']
  return {
    invocationId: 'permission-test',
    clientCapabilities: {},
    emit,
    emitEvent: (() => {
      throw new Error('unused')
    }) as DriverContext['emitEvent'],
    ...extra,
  } as DriverContext
}
