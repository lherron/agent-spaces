import type { InputId, InvocationInput, TurnId } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import type { DriverContext } from '../driver'
import { withDeliveryEvidence } from '../driver'
import { newMuseCommandId } from './command-id'
import { MUSE_DRIVER_KIND } from './event-map'
import { buildMuseTurnStartParams } from './input'
import type { MuseRpcPeer } from './rpc-client'

interface PendingSteer {
  inputId: InputId
  sessionId: string
  turnId: TurnId
  nativeObserved: boolean
}

export interface MuseSteerDelivery {
  rpc: MuseRpcPeer
  sessionId: string
  /** The turn the steer is fenced to (`expectedTurnId`). */
  turnId: TurnId
  input: InvocationInput & { inputId: InputId }
  /** Muse absorbed the steer into a newer running turn; re-arm to it. */
  onTurnRoll: (absorbingTurnId: TurnId) => void
}

export interface MuseSteerFence {
  deliver(delivery: MuseSteerDelivery): Promise<void>
  /** Agent-visible transcript text: the steer may already have landed natively. */
  observeAgentText(turnId: string, text: string): void
  /** A retracted turn takes its pending steers with it. */
  retractTurn(turnId: TurnId | undefined): void
  clear(): void
}

/**
 * turn/steer with the expectedTurnId fence. An accepted steer absorbed after
 * a native turn roll re-arms to the absorbing turn instead of failing; a
 * response with no turn id, or a failed RPC, is reported as possibly written.
 */
export function createMuseSteerFence(options: {
  emitDiagnostic: (
    level: 'info' | 'error',
    message: string,
    extra: Parameters<DriverContext['emit']>[2]
  ) => void
}): MuseSteerFence {
  const pendingSteers = new Map<InputId, PendingSteer>()

  async function deliver(delivery: MuseSteerDelivery): Promise<void> {
    const { rpc, sessionId, turnId: steerTurnId, input } = delivery
    const steerInputId = input.inputId
    const steerExtra = (turnId: TurnId) => ({
      turnId,
      inputId: steerInputId,
      driver: { kind: MUSE_DRIVER_KIND, rawType: 'turn/steer' },
    })
    const pendingSteer: PendingSteer = {
      inputId: steerInputId,
      sessionId,
      turnId: steerTurnId,
      nativeObserved: false,
    }
    pendingSteers.set(steerInputId, pendingSteer)
    try {
      const response = await rpc.sendRequest<{ turnId?: string }>('turn/steer', {
        commandId: newMuseCommandId(),
        sessionId,
        expectedTurnId: steerTurnId,
        input: await buildMuseTurnStartParams({
          commandId: newMuseCommandId(),
          sessionId,
          input,
        }).then((params) => params['input']),
      })
      const absorbedTurnId =
        typeof response?.turnId === 'string' && response.turnId.length > 0
          ? (response.turnId as TurnId)
          : undefined
      if (absorbedTurnId === undefined) {
        options.emitDiagnostic(
          'error',
          'muse turn/steer response conflicts with the armed turn identity',
          steerExtra(steerTurnId)
        )
        throw withDeliveryEvidence(
          new BrokerError(
            BrokerErrorCode.HarnessError,
            'muse turn/steer response did not match the armed turn'
          ),
          'possibly_written'
        )
      }
      if (absorbedTurnId !== steerTurnId) {
        // Native turn roll: the armed turn ended server-side between the
        // admission check and the steer landing, and muse absorbed the
        // input into the now-running turn (TurnSteerResult.turnId is "the
        // running turn that absorbed the input"). The text did not leak —
        // it landed in a known turn — so re-arm to the absorbing turn and
        // report delivery instead of failing the input.
        delivery.onTurnRoll(absorbedTurnId)
        options.emitDiagnostic(
          'info',
          'muse turn/steer absorbed after native turn roll',
          steerExtra(absorbedTurnId)
        )
      }
    } catch (error) {
      if (pendingSteer.nativeObserved) {
        options.emitDiagnostic(
          'error',
          'muse turn/steer RPC failed after native transcript entry',
          steerExtra(steerTurnId)
        )
      }
      if (error !== null && typeof error === 'object' && 'deliveryEvidence' in error) {
        throw error
      }
      throw withDeliveryEvidence(
        new BrokerError(
          BrokerErrorCode.HarnessError,
          error instanceof Error ? error.message : 'muse turn/steer failed'
        ),
        'possibly_written'
      )
    }
  }

  return {
    deliver,
    observeAgentText(turnId, text) {
      if (!text) return
      for (const pending of pendingSteers.values()) {
        if (pending.turnId === (turnId as TurnId)) pending.nativeObserved = true
      }
    },
    retractTurn(turnId) {
      for (const [inputId, pending] of pendingSteers) {
        if (pending.turnId === turnId) pendingSteers.delete(inputId)
      }
    },
    clear() {
      pendingSteers.clear()
    },
  }
}
