import { describe, expect, test } from 'bun:test'
import type { ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent'

import {
  createResidentApprovalControl,
  createResidentSurfaceController,
} from './resident-controller'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('resident surface controller', () => {
  test('keeps exactly one writer and targets detach at that client', async () => {
    const calls: string[] = []
    const controller = createResidentSurfaceController({
      async setReadOnly(clientName, readOnly) {
        calls.push(`readonly:${clientName}:${readOnly}`)
      },
      async detachClient(clientName) {
        calls.push(`detach:${clientName}`)
      },
    })

    expect(await controller.attachClient('writer')).toEqual({ role: 'writer' })
    expect(await controller.attachClient('observer')).toEqual({ role: 'observer' })
    expect(controller.snapshot()).toEqual({
      writer: 'writer',
      observers: ['observer'],
      reservation: undefined,
    })

    await controller.detachWriter('quit')
    expect(calls).toContain('detach:writer')
    expect(controller.snapshot().writer).toBeUndefined()
    expect(controller.snapshot().observers).toEqual(['observer'])
  })

  test('serializes takeover and restores the prior writer when promotion fails', async () => {
    const calls: string[] = []
    let failPromotion = true
    const controller = createResidentSurfaceController({
      async setReadOnly(clientName, readOnly) {
        calls.push(`readonly:${clientName}:${readOnly}`)
        if (clientName === 'next' && !readOnly && failPromotion) throw new Error('attach failed')
      },
      async detachClient() {},
    })
    await controller.attachClient('current')
    await controller.attachClient('next')

    await expect(controller.takeControl('next')).rejects.toThrow('attach failed')
    expect(controller.snapshot()).toEqual({
      writer: 'current',
      observers: ['next'],
      reservation: undefined,
    })
    expect(calls.slice(-3)).toEqual([
      'readonly:current:true',
      'readonly:next:false',
      'readonly:current:false',
    ])

    failPromotion = false
    await controller.takeControl('next')
    expect(controller.snapshot()).toEqual({
      writer: 'next',
      observers: ['current'],
      reservation: undefined,
    })
  })
})

describe('resident native approval control', () => {
  test('keeps one native prompt pending and drain cancels it as denied', async () => {
    let toolCall:
      | ((event: ToolCallEvent, context: ExtensionContext) => Promise<unknown>)
      | undefined
    const prompt = deferred<boolean>()
    let promptSignal: AbortSignal | undefined
    const observations: string[] = []
    const control = createResidentApprovalControl({
      requiresApproval: () => true,
      onPending: (pending) => observations.push(`pending:${pending.toolCallId}`),
      onDecision: (decision) => observations.push(`decision:${decision.decision}`),
    })
    control.extensionFactory({
      on(event: string, handler: typeof toolCall) {
        if (event === 'tool_call') toolCall = handler
      },
    } as never)
    const context = {
      ui: {
        confirm(_title: string, _message: string, options?: { signal?: AbortSignal }) {
          promptSignal = options?.signal
          promptSignal?.addEventListener('abort', () => prompt.resolve(false), { once: true })
          return prompt.promise
        },
      },
    } as unknown as ExtensionContext

    const pending = toolCall?.(
      { type: 'tool_call', toolName: 'bash', toolCallId: 'call-1', input: { command: 'pwd' } },
      context
    )
    await Promise.resolve()
    expect(control.snapshot()).toEqual({ toolCallId: 'call-1', toolName: 'bash' })
    expect(promptSignal?.aborted).toBe(false)
    expect(observations).toEqual(['pending:call-1'])

    await control.drain()
    expect(await pending).toEqual({ block: true, reason: 'Resident host drained before approval' })
    expect(control.snapshot()).toBeUndefined()
    expect(observations).toEqual(['pending:call-1', 'decision:cancelled'])
  })

  test('journals the native human decision before allowing execution', async () => {
    let toolCall:
      | ((event: ToolCallEvent, context: ExtensionContext) => Promise<unknown>)
      | undefined
    const observations: string[] = []
    const control = createResidentApprovalControl({
      requiresApproval: () => true,
      onDecision: (decision) => observations.push(decision.decision),
    })
    control.extensionFactory({
      on(event: string, handler: typeof toolCall) {
        if (event === 'tool_call') toolCall = handler
      },
    } as never)
    const result = await toolCall?.(
      { type: 'tool_call', toolName: 'write', toolCallId: 'call-2', input: { path: 'x' } },
      { ui: { confirm: async () => true } } as unknown as ExtensionContext
    )
    expect(result).toBeUndefined()
    expect(observations).toEqual(['allow'])
  })
})
