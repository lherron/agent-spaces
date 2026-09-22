import type {
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent'

import type { ResidentDetachReason } from './resident-detach.js'

export interface ResidentSurfaceTransport {
  setReadOnly(clientName: string, readOnly: boolean): void | Promise<void>
  detachClient(clientName: string, reason: ResidentDetachReason): void | Promise<void>
}

export interface ResidentSurfaceIdentity {
  surfaceId: string
  runtimeId: string
  sessionId: string
  incarnationId: string
}

export type ResidentSurfaceObservation =
  | { type: 'attached'; clientName: string; role: 'writer' | 'observer' }
  | { type: 'dropped'; clientName: string }
  | { type: 'detached'; clientName: string; reason: ResidentDetachReason }
  | { type: 'control-transferred'; from: string | undefined; to: string }
  | { type: 'disposed' }

export interface ResidentSurfaceSnapshot {
  identity: ResidentSurfaceIdentity
  writer: string | undefined
  observers: string[]
  reservation: string | undefined
  disposed: boolean
}

export interface ResidentSurfaceController {
  attachClient(
    clientName: string,
    options?: { readOnly?: boolean }
  ): Promise<{ role: 'writer' | 'observer' }>
  clientDropped(clientName: string): Promise<void>
  detachWriter(reason: ResidentDetachReason): Promise<void>
  takeControl(clientName: string): Promise<void>
  dispose(): Promise<void>
  snapshot(): ResidentSurfaceSnapshot
}

export interface ResidentSurfaceControllerOptions {
  identity: ResidentSurfaceIdentity
  transport: ResidentSurfaceTransport
  onObservation?: ((observation: ResidentSurfaceObservation) => void | Promise<void>) | undefined
  disposeHost(): void | Promise<void>
}

export function createResidentSurfaceController(
  controllerOptions: ResidentSurfaceControllerOptions
): ResidentSurfaceController {
  const identity = Object.freeze({ ...controllerOptions.identity })
  let writer: string | undefined
  let reservation: string | undefined
  let disposed = false
  const observers = new Set<string>()
  let tail = Promise.resolve()

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation)
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  const assertLive = (): void => {
    if (disposed) throw new Error('resident surface controller is disposed')
  }
  const observe = async (observation: ResidentSurfaceObservation): Promise<void> => {
    await controllerOptions.onObservation?.(observation)
  }

  return {
    attachClient(clientName, attachOptions = {}) {
      return serialized(async () => {
        assertLive()
        if (clientName === writer) return { role: 'writer' as const }
        if (attachOptions.readOnly === true || writer !== undefined || reservation !== undefined) {
          await controllerOptions.transport.setReadOnly(clientName, true)
          observers.add(clientName)
          await observe({ type: 'attached', clientName, role: 'observer' })
          return { role: 'observer' as const }
        }
        await controllerOptions.transport.setReadOnly(clientName, false)
        observers.delete(clientName)
        writer = clientName
        await observe({ type: 'attached', clientName, role: 'writer' })
        return { role: 'writer' as const }
      })
    },
    clientDropped(clientName) {
      return serialized(async () => {
        assertLive()
        if (writer === clientName) writer = undefined
        observers.delete(clientName)
        if (reservation === clientName) reservation = undefined
        await observe({ type: 'dropped', clientName })
      })
    },
    detachWriter(reason) {
      return serialized(async () => {
        assertLive()
        const target = writer
        if (target === undefined) throw new Error('resident surface has no writable client')
        await controllerOptions.transport.detachClient(target, reason)
        if (writer === target) writer = undefined
        await observe({ type: 'detached', clientName: target, reason })
      })
    },
    takeControl(clientName) {
      return serialized(async () => {
        assertLive()
        if (writer === clientName) return
        if (reservation !== undefined) {
          throw new Error(`resident surface takeover is reserved by ${reservation}`)
        }
        if (!observers.has(clientName)) {
          throw new Error(`resident surface client is not attached: ${clientName}`)
        }
        const priorWriter = writer
        reservation = clientName
        try {
          if (priorWriter !== undefined)
            await controllerOptions.transport.setReadOnly(priorWriter, true)
          try {
            await controllerOptions.transport.setReadOnly(clientName, false)
          } catch (error) {
            if (priorWriter !== undefined)
              await controllerOptions.transport.setReadOnly(priorWriter, false)
            throw error
          }
          if (priorWriter !== undefined) observers.add(priorWriter)
          observers.delete(clientName)
          writer = clientName
          await observe({ type: 'control-transferred', from: priorWriter, to: clientName })
        } finally {
          reservation = undefined
        }
      })
    },
    dispose() {
      return serialized(async () => {
        if (disposed) return
        await controllerOptions.disposeHost()
        disposed = true
        writer = undefined
        reservation = undefined
        observers.clear()
        await observe({ type: 'disposed' })
      })
    },
    snapshot() {
      return {
        identity,
        writer,
        observers: [...observers].sort(),
        reservation,
        disposed,
      }
    },
  }
}

export interface ResidentApprovalPending {
  toolCallId: string
  toolName: string
}

export interface ResidentApprovalDecision extends ResidentApprovalPending {
  decision: 'allow' | 'deny' | 'cancelled'
}

export interface ResidentApprovalControl {
  extensionFactory: ExtensionFactory
  snapshot(): ResidentApprovalPending | undefined
  drain(): Promise<void>
}

export function createResidentApprovalControl(options: {
  requiresApproval(event: ToolCallEvent): boolean
  describe?: ((event: ToolCallEvent) => { title: string; message: string }) | undefined
  onPending?: ((pending: ResidentApprovalPending) => void | Promise<void>) | undefined
  onDecision?: ((decision: ResidentApprovalDecision) => void | Promise<void>) | undefined
}): ResidentApprovalControl {
  let pending: ResidentApprovalPending | undefined
  let activeAbort: AbortController | undefined
  let activeSettlement: Promise<void> | undefined
  let draining = false

  const extensionFactory: ExtensionFactory = (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      if (!options.requiresApproval(event)) return undefined
      if (draining) return blocked('Resident host is draining')
      if (pending !== undefined) return blocked('Another resident approval is already pending')

      const nextPending = { toolCallId: event.toolCallId, toolName: event.toolName }
      const abort = new AbortController()
      const settled = deferredVoid()
      pending = nextPending
      activeAbort = abort
      activeSettlement = settled.promise

      try {
        await options.onPending?.(nextPending)
        const description = options.describe?.(event) ?? defaultApprovalDescription(event)
        const allowed = await ctx.ui.confirm(description.title, description.message, {
          signal: abort.signal,
        })
        const decision: ResidentApprovalDecision['decision'] = abort.signal.aborted
          ? 'cancelled'
          : allowed
            ? 'allow'
            : 'deny'
        await options.onDecision?.({ ...nextPending, decision })
        if (decision === 'allow') return undefined
        return blocked(
          decision === 'cancelled'
            ? 'Resident host drained before approval'
            : 'Denied by resident operator'
        )
      } finally {
        if (activeAbort === abort) {
          pending = undefined
          activeAbort = undefined
          activeSettlement = undefined
        }
        settled.resolve()
      }
    })
  }

  return {
    extensionFactory,
    snapshot: () => pending,
    async drain() {
      draining = true
      activeAbort?.abort()
      await activeSettlement
    },
  }
}

function blocked(reason: string): ToolCallEventResult {
  return { block: true, reason }
}

function defaultApprovalDescription(event: ToolCallEvent): { title: string; message: string } {
  return {
    title: `Allow ${event.toolName}?`,
    message: JSON.stringify(event.input, undefined, 2),
  }
}

function deferredVoid(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
