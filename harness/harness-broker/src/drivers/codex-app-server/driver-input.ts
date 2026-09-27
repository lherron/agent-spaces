import type { InputId, InvocationInput, TurnId } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { type ApplyInputResult, withDeliveryEvidence, withSteerRequiresOwnTurn } from '../driver'
import { extractText } from '../tmux-shared'
import type { CodexDriverControl } from './driver-control'
import type { CodexDriverEvents } from './driver-events'
import type {
  CodexDriverState,
  PendingSteer,
  ThreadTurnsListResponse,
  TurnStartResponse,
  TurnSteerResponse,
} from './driver-state'
import {
  currentActiveTurnFromTurnsList,
  errorMessage,
  isDefiniteTurnMismatchError,
  turnStartResponseId,
  waitForSteerResponseOrTargetTerminal,
} from './driver-support'
import { buildCodexInput, buildTurnStartParams } from './input'

/** Input actuation: headless `turn/start`, codex-tui queue delivery, and `turn/steer`. */
export function createCodexDriverInput(
  s: CodexDriverState,
  events: CodexDriverEvents,
  control: CodexDriverControl
) {
  const { requireCtx, emitDiagnostic, retirePendingSteer } = events
  const { applyQueuedInput } = control

  // Driver applies the input immediately — broker manager owns all policy,
  // disposition, and queue semantics. No policy or busy checks here.
  async function applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
    if (!s.rpc || !s.spec || !s.driverSpec || !s.threadId) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Invocation is not ready')
    }

    const inputId = input.inputId ?? (`input_${Date.now().toString(36)}` as InputId)
    if (s.codexTui) return applyQueuedInput(input, inputId)
    s.currentInputId = inputId
    requireCtx().emit(
      'user.message',
      {
        content: extractText(input),
        inputId,
        role: 'user' as const,
      },
      {
        inputId,
        driver: { kind: 'codex-app-server', rawType: 'broker.input' },
      }
    )

    // Wire turn timeout
    const turnTimeoutMs = s.spec.process.limits?.turnTimeoutMs
    let turnTimedOut = false

    if (turnTimeoutMs !== undefined && turnTimeoutMs > 0) {
      s.turnTimeout = setTimeout(() => {
        // Skip timeout if stopping/exited — the stop path handles turn teardown
        if (s.stopping || s.terminalEmitted) return
        turnTimedOut = true
        if (s.turnActive && s.currentTurnId) {
          requireCtx().emit(
            'turn.failed',
            {
              turnId: s.currentTurnId,
              status: 'failed',
              message: 'Turn timed out',
              code: 'Timeout',
            },
            { turnId: s.currentTurnId, inputId: s.currentInputId }
          )
          s.turnActive = false
        }
        // Defer the RPC close to the next event-loop turn so a concurrent
        // stop() (arriving from a same-tick timer) can pre-empt it.
        // stop() clears turnTimeout, cancelling this deferred close.
        s.turnTimeout = setTimeout(() => {
          if (!s.stopping && !s.terminalEmitted) {
            s.rpc?.close(new Error('Turn timed out'))
          }
        }, 0)
      }, turnTimeoutMs)
    }

    let deliveredTurnId: TurnId | undefined
    try {
      s.acknowledgedTurnId = undefined
      await s.rpc.sendRequest<TurnStartResponse>(
        'turn/start',
        buildTurnStartParams({
          threadId: s.threadId,
          cwd: s.spec.process.cwd,
          input,
          driver: s.driverSpec,
        }),
        (response, rawFrame) => {
          const responseTurnId = turnStartResponseId(response)
          if (responseTurnId === undefined) {
            throw new BrokerError(
              BrokerErrorCode.HarnessError,
              'Codex turn/start response did not carry turn.id',
              { rawFrame }
            )
          }
          // This callback runs synchronously in the JSON-RPC response
          // handler, before a following turn/started frame can normalize.
          s.acknowledgedTurnId = responseTurnId
          deliveredTurnId = responseTurnId
          s.currentTurnId = responseTurnId
          s.turnActive = true
        }
      )
    } catch (error) {
      if (s.turnTimeout !== undefined) clearTimeout(s.turnTimeout)
      s.turnTimeout = undefined
      if (turnTimedOut) {
        if (s.stopping || s.terminalEmitted) {
          return { ...(deliveredTurnId ? { turnId: deliveredTurnId } : {}) }
        }
        throw new BrokerError(BrokerErrorCode.Timeout, 'Turn timed out')
      }
      if (s.terminalEmitted || s.turnActive || s.stopping) {
        return { ...(deliveredTurnId ? { turnId: deliveredTurnId } : {}) }
      }
      if (error instanceof BrokerError) throw error
      throw new BrokerError(
        BrokerErrorCode.HarnessError,
        error instanceof Error ? error.message : 'Codex turn failed to start'
      )
    }
    if (s.turnTimeout !== undefined) clearTimeout(s.turnTimeout)
    s.turnTimeout = undefined

    if (deliveredTurnId === undefined) {
      throw new BrokerError(
        BrokerErrorCode.HarnessError,
        'Codex turn/start response completed without a correlated turn id'
      )
    }
    return { turnId: deliveredTurnId }
  }

  /**
   * T-07155 — mid-turn steer via the app-server `turn/steer` RPC.
   *
   * The broker manager normally calls this while a turn is active; it owns
   * all policy and disposition. Apply the text to the provider's ACTIVE turn.
   * If the provider is already idle, return typed no-write evidence that asks
   * the manager to start an own turn with this same submission instead.
   *
   * The app-server requires `expectedTurnId`, but a broker observation is not
   * a valid actuation precondition: Codex can roll a turn after the broker has
   * observed it and before this driver gets the steer. Resolve the provider's
   * active turn immediately before the write, fence that exact thread + turn,
   * then require both the RPC result and native user item to agree. Native
   * confirmation wins. Every unconfirmed terminal or ambiguous RPC outcome
   * fails open into an own turn with the same submission; this deliberately
   * accepts duplicate delivery rather than risk silently dropping a steer.
   */
  async function applySteerNow(input: InvocationInput): Promise<void> {
    if (!s.rpc || !s.spec || !s.driverSpec || !s.threadId) {
      throw withDeliveryEvidence(
        new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Invocation is not ready'),
        'not_written'
      )
    }
    if (input.inputId === undefined) {
      throw withDeliveryEvidence(
        new BrokerError(
          BrokerErrorCode.DispatchValidationFailed,
          'Codex steer requires a broker input id'
        ),
        'not_written'
      )
    }
    const steerInputId = input.inputId
    const steerThreadId = s.threadId
    // A `turn_mismatch` is a pre-write CAS miss, not an input delivery. Keep
    // resolving until this invocation ceases to have an active turn or the
    // provider accepts; a retry count would itself reject an otherwise active
    // steer merely because Codex rolled several times.
    for (let attempt = 1; ; attempt += 1) {
      if (s.stopping) {
        throw withDeliveryEvidence(
          new BrokerError(
            BrokerErrorCode.InvalidInvocationState,
            'Codex steer invocation is stopping'
          ),
          'not_written'
        )
      }
      let steerTurnId: TurnId
      let authoritativeTurnResolution = false
      try {
        const providerTurns = await s.rpc.sendRequest<ThreadTurnsListResponse>(
          'thread/turns/list',
          {
            threadId: steerThreadId,
            limit: 2,
            sortDirection: 'desc',
            itemsView: 'notLoaded',
          }
        )
        const resolution = currentActiveTurnFromTurnsList(
          providerTurns,
          steerThreadId,
          s.turnActive ? s.currentTurnId : undefined
        )
        if (resolution.issue !== undefined) {
          emitDiagnostic('warn', resolution.issue, resolution.data)
        }
        if (resolution.turnId === undefined) {
          throw withSteerRequiresOwnTurn(
            withDeliveryEvidence(
              new BrokerError(
                BrokerErrorCode.InvalidInvocationState,
                'Codex steer found no usable active turn; starting an own turn',
                { threadId: steerThreadId }
              ),
              'not_written'
            )
          )
        }
        steerTurnId = resolution.turnId
        authoritativeTurnResolution = resolution.authoritative
      } catch (error) {
        if (error !== null && typeof error === 'object' && 'deliveryEvidence' in error) {
          throw error
        }
        const observedTurnId = s.turnActive ? s.currentTurnId : undefined
        if (observedTurnId === undefined) {
          throw withSteerRequiresOwnTurn(
            withDeliveryEvidence(
              new BrokerError(
                BrokerErrorCode.InvalidInvocationState,
                'Codex could not resolve an active turn; starting an own turn',
                {
                  threadId: steerThreadId,
                  cause: errorMessage(error, String(error)),
                }
              ),
              'not_written'
            )
          )
        }
        steerTurnId = observedTurnId
        emitDiagnostic('warn', 'Codex thread/turns/list failed; attempting best-effort steer', {
          inputId: steerInputId,
          threadId: steerThreadId,
          turnId: steerTurnId,
          cause: errorMessage(error, String(error)),
        })
      }
      // The newest bounded `thread/turns/list` page is the provider's
      // authoritative observation at the actuation boundary. Keep local state
      // aligned for later interrupts and native event normalization, but do
      // not use an older observation as the steer fence.
      s.currentTurnId = steerTurnId
      s.turnActive = true
      let settlePendingSteer!: PendingSteer['settle']
      const confirmation = new Promise<'native-observed' | 'target-terminal'>((resolve) => {
        settlePendingSteer = resolve
      })
      const pendingSteer: PendingSteer = {
        inputId: steerInputId,
        threadId: steerThreadId,
        turnId: steerTurnId,
        nativeObserved: false,
        confirmation,
        settle: settlePendingSteer,
      }
      s.pendingSteers.set(steerInputId, pendingSteer)
      try {
        const response = await waitForSteerResponseOrTargetTerminal(
          s.rpc.sendRequest<TurnSteerResponse>('turn/steer', {
            threadId: steerThreadId,
            expectedTurnId: steerTurnId,
            clientUserMessageId: steerInputId,
            input: buildCodexInput(input, s.driverSpec.defaultImageAttachments),
          }),
          pendingSteer.confirmation,
          steerThreadId,
          steerTurnId
        )
        if (response?.turnId !== steerTurnId) {
          emitDiagnostic(
            'error',
            'Codex turn/steer response conflicts with the armed turn identity',
            {
              inputId: steerInputId,
              threadId: steerThreadId,
              expectedTurnId: steerTurnId,
              responseTurnId: response?.turnId ?? null,
              nativeContextEntryObserved: pendingSteer.nativeObserved,
            },
            {
              turnId: steerTurnId,
              inputId: steerInputId,
              driver: { kind: 'codex-app-server', rawType: 'turn/steer' },
            }
          )
          if (pendingSteer.nativeObserved) return
          retirePendingSteer(pendingSteer)
          s.pendingSteers.delete(steerInputId)
          throw withSteerRequiresOwnTurn(
            withDeliveryEvidence(
              new BrokerError(
                BrokerErrorCode.HarnessError,
                'Codex turn/steer response did not match the armed turn; starting an own turn'
              ),
              'possibly_written'
            )
          )
        }
        const confirmationResult = await pendingSteer.confirmation
        if (confirmationResult === 'target-terminal') {
          throw withSteerRequiresOwnTurn(
            withDeliveryEvidence(
              new BrokerError(
                BrokerErrorCode.InvalidInvocationState,
                'Codex steer target terminalized without native landing evidence; starting an own turn',
                { threadId: steerThreadId, attemptedTurnId: steerTurnId }
              ),
              'possibly_written'
            )
          )
        }
        return
      } catch (error) {
        if (isDefiniteTurnMismatchError(error) && !pendingSteer.nativeObserved) {
          s.pendingSteers.delete(steerInputId)
          if (!authoritativeTurnResolution) {
            retirePendingSteer(pendingSteer)
            throw withSteerRequiresOwnTurn(
              withDeliveryEvidence(
                new BrokerError(
                  BrokerErrorCode.InvalidInvocationState,
                  'Codex best-effort steer missed the active turn; starting an own turn',
                  { threadId: steerThreadId, attemptedTurnId: steerTurnId }
                ),
                'not_written'
              )
            )
          }
          emitDiagnostic(
            'info',
            'Codex turn/steer precondition rolled before write; resolving current turn',
            { inputId: steerInputId, threadId: steerThreadId, turnId: steerTurnId, attempt },
            {
              turnId: steerTurnId,
              inputId: steerInputId,
              driver: { kind: 'codex-app-server', rawType: 'turn/steer' },
            }
          )
          continue
        }
        if (pendingSteer.nativeObserved) {
          emitDiagnostic(
            'error',
            'Codex turn/steer RPC failed after native context entry',
            {
              inputId: steerInputId,
              threadId: steerThreadId,
              turnId: steerTurnId,
              error: errorMessage(error, String(error)),
            },
            {
              turnId: steerTurnId,
              inputId: steerInputId,
              driver: { kind: 'codex-app-server', rawType: 'turn/steer' },
            }
          )
          return
        }
        if (error !== null && typeof error === 'object' && 'deliveryEvidence' in error) {
          throw error
        }
        s.pendingSteers.delete(steerInputId)
        retirePendingSteer(pendingSteer)
        throw withSteerRequiresOwnTurn(
          withDeliveryEvidence(
            new BrokerError(
              BrokerErrorCode.HarnessError,
              `${errorMessage(error, 'Codex turn/steer failed')}; starting an own turn`
            ),
            'possibly_written'
          )
        )
      }
    }
  }

  return { applyInputNow, applySteerNow }
}
