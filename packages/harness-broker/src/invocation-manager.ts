import type {
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationState,
  InvocationStartResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  InvocationStatusResponse,
  InvocationDisposeRequest,
  InvocationDisposeResponse,
  InvocationEventEnvelope,
  ContinuationUpdate,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from './errors'
import type { Driver, DriverContext } from './drivers/driver'
import type { InvocationEventSequencer } from './events'

/** Terminal states that allow dispose. */
const TERMINAL_STATES = new Set<InvocationState>(['exited', 'failed'])

export interface Invocation {
  readonly invocationId: string
  readonly spec: HarnessInvocationSpec
  state: InvocationState
  capabilities: InvocationCapabilities
  driver: Driver
  continuation?: ContinuationUpdate | undefined
  terminalEmitted: boolean
}

export interface InvocationManagerOptions {
  sequencer: InvocationEventSequencer
  onEvent: (event: InvocationEventEnvelope) => void
}

export interface InvocationManager {
  start(
    spec: HarnessInvocationSpec,
    driver: Driver
  ): Promise<InvocationStartResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  status(invocationId: string): InvocationStatusResponse
  dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse>
  get(invocationId: string): Invocation | undefined
  activeCount(): number
}

export function createInvocationManager(
  options: InvocationManagerOptions
): InvocationManager {
  const { sequencer, onEvent } = options
  const invocations = new Map<string, Invocation>()

  function requireInvocation(invocationId: string): Invocation {
    const inv = invocations.get(invocationId)
    if (!inv) {
      throw new BrokerError(
        BrokerErrorCode.UnknownInvocation,
        `Unknown invocation: ${invocationId}`,
        { invocationId }
      )
    }
    return inv
  }

  function emit(inv: Invocation, type: InvocationEventEnvelope['type'], payload: unknown): void {
    const event = sequencer.next(inv.invocationId, type, payload)
    if (inv.spec.correlation !== undefined) {
      event.correlation = inv.spec.correlation
    }
    onEvent(event)
  }

  function emitTerminal(
    inv: Invocation,
    type: 'invocation.exited' | 'invocation.failed',
    payload: unknown
  ): void {
    if (inv.terminalEmitted) {
      return
    }
    inv.terminalEmitted = true
    emit(inv, type, payload)
  }

  return {
    async start(
      spec: HarnessInvocationSpec,
      driver: Driver
    ): Promise<InvocationStartResponse> {
      // Check if there's already an active invocation
      for (const existing of invocations.values()) {
        if (!TERMINAL_STATES.has(existing.state) && existing.state !== 'disposed') {
          throw new BrokerError(
            BrokerErrorCode.InvalidInvocationState,
            'A non-terminal invocation already exists; single-invocation broker rejects concurrent starts',
            { existingInvocationId: existing.invocationId }
          )
        }
      }

      const invocationId =
        spec.invocationId ?? `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

      const inv: Invocation = {
        invocationId,
        spec,
        state: 'starting',
        capabilities: driver.capabilities(),
        driver,
        terminalEmitted: false,
      }
      invocations.set(invocationId, inv)

      const ctx: DriverContext = {
        invocationId,
        emit(event: InvocationEventEnvelope): void {
          onEvent(event)
        },
      }

      try {
        await driver.start(spec, ctx)
      } catch (err) {
        inv.state = 'failed'
        emitTerminal(inv, 'invocation.failed', {
          message: err instanceof Error ? err.message : 'Driver start failed',
        })
        throw err
      }

      // Emit lifecycle events
      emit(inv, 'invocation.started', {
        command: spec.process.command,
        args: spec.process.args,
        cwd: spec.process.cwd,
      })
      emit(inv, 'invocation.ready', {})

      inv.state = 'ready'

      return {
        invocationId,
        state: inv.state,
        capabilities: inv.capabilities,
      }
    },

    async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
      const inv = requireInvocation(req.invocationId)

      if (TERMINAL_STATES.has(inv.state) || inv.state === 'disposed') {
        return { accepted: false, state: inv.state }
      }

      inv.state = 'stopping'
      emit(inv, 'invocation.stopping', { reason: req.reason })

      const result = await inv.driver.stop(req)

      // Terminal state determined by driver
      const terminalState = result.state === 'failed' ? 'failed' : 'exited'
      inv.state = terminalState

      if (terminalState === 'failed') {
        emitTerminal(inv, 'invocation.failed', {
          message: req.reason ?? 'Stopped',
        })
      } else {
        emitTerminal(inv, 'invocation.exited', {})
      }

      return { accepted: true, state: inv.state }
    },

    status(invocationId: string): InvocationStatusResponse {
      const inv = requireInvocation(invocationId)
      return {
        invocationId: inv.invocationId,
        state: inv.state,
        capabilities: inv.capabilities,
        continuation: inv.continuation,
      }
    },

    async dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse> {
      const inv = requireInvocation(req.invocationId)

      if (!TERMINAL_STATES.has(inv.state) && inv.state !== 'disposed') {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `Cannot dispose invocation in state: ${inv.state}`,
          { invocationId: inv.invocationId, state: inv.state }
        )
      }

      await inv.driver.dispose()
      inv.state = 'disposed'

      return { disposed: true }
    },

    get(invocationId: string): Invocation | undefined {
      return invocations.get(invocationId)
    },

    activeCount(): number {
      let count = 0
      for (const inv of invocations.values()) {
        if (!TERMINAL_STATES.has(inv.state) && inv.state !== 'disposed') {
          count++
        }
      }
      return count
    },
  }
}
