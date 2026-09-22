import { describe, expect, test } from 'bun:test'
import type { ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent'

import {
  createResidentApprovalControl,
  createResidentSurfaceController,
  createResidentTmuxTransport,
} from './resident-controller'
import type { ResidentSurfaceTransport } from './resident-controller'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function surfaceController(transport: ResidentSurfaceTransport) {
  return createResidentSurfaceController({
    identity: {
      surfaceId: 'surface-1',
      runtimeId: 'runtime-1',
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
    },
    transport,
    disposeHost: () => undefined,
  })
}

describe('resident surface controller', () => {
  test('owns immutable live identity, observations, and explicit disposal', async () => {
    const observations: string[] = []
    let disposed = false
    const controller = createResidentSurfaceController({
      identity: {
        surfaceId: 'surface-1',
        runtimeId: 'runtime-1',
        sessionId: 'session-1',
        incarnationId: 'incarnation-1',
      },
      transport: {
        async setReadOnly() {},
        async detachClient() {},
      },
      onObservation: (observation) => observations.push(observation.type),
      disposeHost: async () => {
        disposed = true
      },
    })

    await controller.attachClient('writer')
    expect(controller.snapshot().identity).toEqual({
      surfaceId: 'surface-1',
      runtimeId: 'runtime-1',
      sessionId: 'session-1',
      incarnationId: 'incarnation-1',
    })
    await controller.detachWriter('quit')
    await controller.dispose()
    expect(disposed).toBe(true)
    expect(controller.snapshot().disposed).toBe(true)
    expect(observations).toEqual(['attached', 'detached', 'disposed'])
    await expect(controller.attachClient('later')).rejects.toThrow('disposed')
  })

  test('keeps exactly one writer and targets detach at that client', async () => {
    const calls: string[] = []
    const controller = surfaceController({
      async setReadOnly(clientName, readOnly) {
        calls.push(`readonly:${clientName}:${readOnly}`)
      },
      async detachClient(clientName) {
        calls.push(`detach:${clientName}`)
      },
    })

    expect(await controller.attachClient('writer')).toEqual({ role: 'writer' })
    expect(await controller.attachClient('observer')).toEqual({ role: 'observer' })
    expect(controller.snapshot()).toMatchObject({
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
    const controller = surfaceController({
      async setReadOnly(clientName, readOnly) {
        calls.push(`readonly:${clientName}:${readOnly}`)
        if (clientName === 'next' && !readOnly && failPromotion) throw new Error('attach failed')
      },
      async detachClient() {},
    })
    await controller.attachClient('current')
    await controller.attachClient('next')

    await expect(controller.takeControl('next')).rejects.toThrow('attach failed')
    expect(controller.snapshot()).toMatchObject({
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
    expect(controller.snapshot()).toMatchObject({
      writer: 'next',
      observers: ['current'],
      reservation: undefined,
    })
  })

  test('fails closed when takeover promotion and incumbent restoration both fail', async () => {
    let failRestoration = false
    const subject = surfaceController({
      async setReadOnly(clientName, readOnly) {
        if (clientName === 'next' && !readOnly) throw new Error('promotion failed')
        if (clientName === 'current' && !readOnly && failRestoration)
          throw new Error('restoration failed')
      },
      async detachClient() {},
    })
    await subject.attachClient('current')
    await subject.attachClient('next')
    failRestoration = true
    await expect(subject.takeControl('next')).rejects.toThrow('restoration failed')
    expect(subject.snapshot()).toMatchObject({
      writer: undefined,
      observers: ['current', 'next'],
      reservation: undefined,
    })
  })

  test('retains physical transfer truth and degrades readiness when observation fails', async () => {
    const controller = createResidentSurfaceController({
      identity: {
        surfaceId: 'surface-1',
        runtimeId: 'runtime-1',
        sessionId: 'session-1',
        incarnationId: 'incarnation-1',
      },
      transport: { setReadOnly: () => undefined, detachClient: () => undefined },
      onObservation: (observation) => {
        if (observation.type === 'control-transferred') throw new Error('journal unavailable')
      },
      disposeHost: () => undefined,
    })
    await controller.attachClient('current')
    await controller.attachClient('next')
    await expect(controller.takeControl('next')).resolves.toBeUndefined()
    expect(controller.snapshot()).toMatchObject({
      writer: 'next',
      observers: ['current'],
      observationFailure: 'journal unavailable',
    })
    expect(() => controller.assertReady()).toThrow('journal unavailable')
  })
})

describe('native tmux transport', () => {
  test('queries flags, changes only mismatched mode, verifies, and targets detach', async () => {
    const flags = new Map([
      ['writer', 'attached,UTF-8'],
      ['observer', 'attached,read-only,UTF-8'],
    ])
    const calls: string[][] = []
    const transport = createResidentTmuxTransport({
      socketPath: '/tmp/resident.sock',
      async exec(args) {
        calls.push(args)
        if (args[0] === 'display-message') {
          return { status: 0, stdout: flags.get(args[3] ?? '') ?? '', stderr: '' }
        }
        if (args[0] === 'switch-client') {
          const client = args[3] ?? ''
          const current = flags.get(client) ?? ''
          flags.set(
            client,
            current.includes('read-only')
              ? current.replace(',read-only', '')
              : `${current},read-only`
          )
          return { status: 0, stdout: '', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
    })

    await transport.setReadOnly('writer', true)
    await transport.setReadOnly('observer', true)
    await transport.detachClient('writer', 'quit')
    expect(calls.filter((args) => args[0] === 'switch-client')).toHaveLength(1)
    expect(calls.at(-1)).toEqual(['detach-client', '-t', 'writer'])
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
