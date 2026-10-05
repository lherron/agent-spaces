import { join } from 'node:path'
import type { InputId, InvocationInput, TurnId } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError, errorMessage } from '../../errors'
import { CodexRpcError } from '../codex-app-server/rpc-client'
import { classifyCodexRolloutLine } from '../codex-rollout/native'
import type { ApplyInputResult, CancelInputResult, DriverContext } from '../driver'
import { withDeliveryEvidence } from '../driver'
import { getString } from '../hook-json'
import {
  type CodexDesktopNativeAttempt,
  type CodexDesktopNativeAttemptStore,
  isUnresolvedCodexDesktopAttempt,
  openCodexDesktopNativeAttemptStore,
} from './native-attempt-store'
import {
  type CodexDesktopQueueHelper,
  listAllQueued,
  queueEntryClientId,
  queueEntryId,
  queueSubmissionId,
} from './queue-helper'
import { type ObservedUserMessage, turnIdOf } from './rollout-normalizer'
import {
  CODEX_DESKTOP_DRIVER_KIND,
  type CodexDesktopDriverSpec,
  desktopInstallationKey,
} from './spec'

export interface NativeDeliveryDeps {
  ctx(): DriverContext
  spec(): CodexDesktopDriverSpec
  openQueueHelper(spec: CodexDesktopDriverSpec): Promise<CodexDesktopQueueHelper>
  /** Ingest any new rollout lines so execution evidence is current. */
  readRows(): void
}

/**
 * Deliver broker input through the desktop's native queue with a durable
 * attempt fence: one unresolved write at a time, never resent once possibly
 * written, executed only on client-id evidence in the committed rollout.
 */
export function createNativeDelivery(deps: NativeDeliveryDeps) {
  let attemptStore: CodexDesktopNativeAttemptStore | undefined
  let installationKey = ''
  let deliveryReason: string | undefined
  const ownedInputIds = new Set<string>()

  function requireAttemptStore(): CodexDesktopNativeAttemptStore {
    if (attemptStore === undefined) {
      throw new BrokerError(BrokerErrorCode.ResourceError, 'Codex desktop attempt store is closed')
    }
    return attemptStore
  }

  function attemptData(row: CodexDesktopNativeAttempt): Record<string, unknown> {
    return {
      attemptState: row.state,
      inputId: row.inputId,
      clientUserMessageId: row.clientUserMessageId,
      nativeThreadId: row.threadId,
      observationWatermark: row.observationWatermark,
      ...(row.principalRef !== undefined ? { principalRef: row.principalRef } : {}),
      ...(row.scopeRef !== undefined ? { scopeRef: row.scopeRef } : {}),
      ...(row.envelopeId !== undefined ? { envelopeId: row.envelopeId } : {}),
      ...(row.queuedSubmissionId !== undefined
        ? { queuedSubmissionId: row.queuedSubmissionId }
        : {}),
      ...(row.turnId !== undefined ? { turnId: row.turnId } : {}),
      ...(row.detail !== undefined ? { detail: row.detail } : {}),
    }
  }

  function emitAttempt(row: CodexDesktopNativeAttempt, code: string, message: string): void {
    deps.ctx().emit(
      'driver.notice',
      { message, code, data: attemptData(row) },
      {
        inputId: row.inputId as InputId,
        ...(row.turnId !== undefined ? { turnId: row.turnId as TurnId } : {}),
        driver: { kind: CODEX_DESKTOP_DRIVER_KIND, rawType: 'broker.native-attempt' },
      }
    )
  }

  function updateAttempt(
    inputId: string,
    patch: Parameters<CodexDesktopNativeAttemptStore['update']>[2],
    code?: string,
    message?: string
  ): CodexDesktopNativeAttempt {
    const row = requireAttemptStore().update(installationKey, inputId, patch)
    if (code !== undefined && message !== undefined) emitAttempt(row, code, message)
    return row
  }

  function currentAttempt(inputId: string): CodexDesktopNativeAttempt {
    return requireAttemptStore().get(installationKey, inputId) as CodexDesktopNativeAttempt
  }

  function currentObservationWatermark(): number {
    return (deps.ctx().capture?.records() ?? [])
      .filter(
        (record) =>
          record.driverKind === CODEX_DESKTOP_DRIVER_KIND &&
          typeof record.sourceCursor['byteOffset'] === 'number'
      )
      .reduce((maximum, record) => Math.max(maximum, Number(record.sourceCursor['byteOffset'])), 0)
  }

  function findCommittedExecution(attempt: CodexDesktopNativeAttempt): TurnId | undefined {
    const records = deps.ctx().capture?.records() ?? []
    const startedTurns = new Set<string>()
    for (const record of records) {
      if (record.driverKind !== CODEX_DESKTOP_DRIVER_KIND) continue
      const classified = classifyCodexRolloutLine(Buffer.from(record.rawBytes).toString('utf8'))
      if ('outcome' in classified) continue
      if (classified.payloadType === 'task_started') {
        const turnId = turnIdOf(classified.payload)
        if (turnId !== undefined) startedTurns.add(turnId)
        continue
      }
      if (classified.payloadType !== 'item_completed' || classified.item === undefined) continue
      if (getString(classified.item, 'type') !== 'UserMessage') continue
      if (getString(classified.item, 'client_id') !== attempt.clientUserMessageId) continue
      const cursor = record.sourceCursor['byteOffset']
      if (typeof cursor === 'number' && cursor < attempt.observationWatermark) continue
      const turnId = turnIdOf(classified.payload)
      if (turnId !== undefined && startedTurns.has(turnId)) return turnId
    }
    return undefined
  }

  /** Settle an attempt from rollout evidence, then from the native queue listing. */
  async function reconcile(attempt: CodexDesktopNativeAttempt): Promise<CodexDesktopNativeAttempt> {
    deps.readRows()
    const committedTurnId = findCommittedExecution(attempt)
    if (committedTurnId !== undefined) {
      const executed = updateAttempt(attempt.inputId, {
        state: 'executed',
        turnId: committedTurnId,
        detail: 'reconciled from committed rollout evidence',
      })
      deps.ctx().admissionStateChanged?.()
      return executed
    }
    const afterRollout = requireAttemptStore().get(installationKey, attempt.inputId) ?? attempt
    if (afterRollout.state === 'executed') return afterRollout
    let helper: CodexDesktopQueueHelper | undefined
    try {
      helper = await deps.openQueueHelper(deps.spec())
      const entries = await listAllQueued(helper, deps.spec().threadId)
      deliveryReason = undefined
      const queued = entries.find(
        (entry) => queueEntryClientId(entry) === attempt.clientUserMessageId
      )
      if (queued !== undefined) {
        const queuedSubmissionId = queueEntryId(queued)
        if (queuedSubmissionId === undefined) {
          throw new Error('Matching native queue row did not carry queuedSubmission.id')
        }
        deliveryReason = undefined
        return updateAttempt(
          attempt.inputId,
          { state: 'queued', queuedSubmissionId, detail: 'reconciled from native queue/list' },
          'CODEX_DESKTOP_NATIVE_ATTEMPT_RECONCILED_QUEUED',
          'Codex desktop native queued input recovered without a second add'
        )
      }
      if (attempt.state === 'writing' || attempt.state === 'indeterminate') {
        return updateAttempt(attempt.inputId, {
          state: 'indeterminate',
          detail: 'possibly-written attempt absent from queue and committed rollout',
        })
      }
      return requireAttemptStore().get(installationKey, attempt.inputId) ?? attempt
    } catch (error) {
      deliveryReason = `desktop queue helper unavailable: ${errorMessage(error)}`
      deps.ctx().emit('driver.notice', {
        message: `Codex desktop delivery degraded: ${deliveryReason}`,
        code: 'CODEX_DESKTOP_DELIVERY_DEGRADED',
        data: { desktopAvailability: 'unknown', delivery: 'disabled' },
      })
      return requireAttemptStore().get(installationKey, attempt.inputId) ?? attempt
    } finally {
      helper?.close()
    }
  }

  return {
    deliveryReason: () => deliveryReason,

    harnessLocalQueueDepth(): number {
      return attemptStore?.unresolved(installationKey) === undefined ? 0 : 1
    },

    /** Open this installation's attempt store and adopt every input it already owns. */
    open(spec: CodexDesktopDriverSpec, durableStateDir: string | undefined): void {
      deliveryReason = undefined
      ownedInputIds.clear()
      attemptStore?.close()
      attemptStore = openCodexDesktopNativeAttemptStore(
        spec.nativeAttemptStorePath ??
          (durableStateDir === undefined
            ? undefined
            : join(durableStateDir, 'codex-desktop-native-attempts.db'))
      )
      installationKey = desktopInstallationKey(spec)
      for (const attempt of attemptStore.list(installationKey)) {
        ownedInputIds.add(attempt.clientUserMessageId)
      }
    },

    close(): void {
      attemptStore?.close()
      attemptStore = undefined
    },

    /** Resolve a write left in flight by a previous broker before observing new work. */
    async reconcileUnresolved(): Promise<void> {
      const unresolved = requireAttemptStore().unresolved(installationKey)
      if (unresolved !== undefined) await reconcile(unresolved)
    },

    claimOwnUserMessage(message: ObservedUserMessage): boolean {
      const { clientId, byteOffset, turnId, publish } = message
      const attempt =
        clientId === undefined ? undefined : requireAttemptStore().get(installationKey, clientId)
      const attemptWatermark =
        attempt?.observationWatermark ?? deps.spec().adoptionWatermark?.byteOffset ?? 0
      const afterAdoption = typeof byteOffset !== 'number' || byteOffset >= attemptWatermark
      const own =
        clientId !== undefined &&
        afterAdoption &&
        message.turnStarted &&
        ownedInputIds.has(clientId)
      if (own && attempt !== undefined && attempt.state !== 'executed') {
        updateAttempt(
          attempt.inputId,
          { state: 'executed', turnId },
          publish ? 'CODEX_DESKTOP_NATIVE_ATTEMPT_EXECUTED' : undefined,
          publish ? 'Codex desktop native input execution observed' : undefined
        )
        deps.ctx().admissionStateChanged?.()
      }
      return own
    },

    async applyInput(input: InvocationInput): Promise<ApplyInputResult> {
      const inputId = input.inputId
      if (inputId === undefined) {
        throw withDeliveryEvidence(
          new BrokerError(
            BrokerErrorCode.DispatchValidationFailed,
            'Desktop queue inputId is required'
          ),
          'not_written'
        )
      }
      const store = requireAttemptStore()
      const unresolved = store.unresolved(installationKey)
      if (unresolved !== undefined) {
        if (unresolved.inputId !== inputId) {
          throw withDeliveryEvidence(
            new BrokerError(
              BrokerErrorCode.InvalidInvocationState,
              `Desktop native write remains unresolved for ${unresolved.inputId}`
            ),
            'not_written'
          )
        }
        await reconcile(unresolved)
        if (isUnresolvedCodexDesktopAttempt(store.get(installationKey, inputId) ?? unresolved)) {
          return {}
        }
      }

      const existing = store.get(installationKey, inputId)
      if (existing?.state === 'executed' || existing?.state === 'cancelled') return {}
      const observationWatermark = currentObservationWatermark()
      const prepared =
        existing?.state === 'rejected'
          ? updateAttempt(inputId, {
              state: 'prepared',
              detail: 'retry after definitive rejection',
            })
          : store.prepare({
              installationKey,
              invocationId: deps.ctx().invocationId,
              inputId,
              clientUserMessageId: inputId,
              threadId: deps.spec().threadId,
              principalRef: input.metadata?.['principalRef'],
              scopeRef: input.metadata?.['scopeRef'],
              envelopeId: input.metadata?.['envelopeId'],
              observationWatermark,
            })
      ownedInputIds.add(inputId)
      emitAttempt(
        prepared,
        'CODEX_DESKTOP_NATIVE_ATTEMPT_PREPARED',
        'Codex desktop native input persisted before queue write'
      )

      const beforeAdd = await reconcile(prepared)
      if (beforeAdd.state !== 'prepared') return {}
      if (deliveryReason !== undefined) {
        updateAttempt(inputId, {
          state: 'rejected',
          detail: `definitive pre-write helper failure: ${deliveryReason}`,
        })
        throw withDeliveryEvidence(
          new BrokerError(BrokerErrorCode.DriverUnavailable, deliveryReason),
          'not_written'
        )
      }
      let helper: CodexDesktopQueueHelper | undefined
      try {
        helper = await deps.openQueueHelper(deps.spec())
        updateAttempt(inputId, { state: 'writing', detail: 'thread/queue/add request begun' })
        const response = await helper.add(deps.spec().threadId, input, inputId)
        const queuedSubmissionId = queueSubmissionId(response)
        if (queuedSubmissionId === undefined) {
          throw new Error('Codex thread/queue/add response did not carry queuedSubmission.id')
        }
        deliveryReason = undefined
        updateAttempt(
          inputId,
          { state: 'queued', queuedSubmissionId, detail: 'native queue add acknowledged' },
          'CODEX_DESKTOP_NATIVE_ATTEMPT_QUEUED',
          'Codex desktop queued input accepted'
        )
        return {}
      } catch (error) {
        if (error instanceof CodexRpcError) {
          updateAttempt(
            inputId,
            { state: 'rejected', detail: errorMessage(error) },
            'CODEX_DESKTOP_NATIVE_ATTEMPT_REJECTED',
            'Codex desktop native queue rejected the input'
          )
          throw withDeliveryEvidence(error, 'not_written')
        }
        updateAttempt(inputId, { state: 'indeterminate', detail: errorMessage(error) })
        const reconciled = await reconcile(currentAttempt(inputId))
        if (reconciled.state === 'indeterminate') {
          emitAttempt(
            reconciled,
            'CODEX_DESKTOP_NATIVE_ATTEMPT_INDETERMINATE',
            'Codex desktop queue write outcome is indeterminate; automatic resend is fenced'
          )
        }
        return {}
      } finally {
        helper?.close()
      }
    },

    async cancel(inputId: string): Promise<CancelInputResult> {
      const row = requireAttemptStore().get(installationKey, inputId)
      if (row === undefined) return { outcome: 'not_owned' }
      deps.readRows()
      const refreshed = currentAttempt(inputId)
      if (refreshed.state === 'executed')
        return { outcome: 'executed', turnId: refreshed.turnId as TurnId }
      if (refreshed.queuedSubmissionId === undefined) {
        return { outcome: 'indeterminate', reason: 'native queue id was not acknowledged' }
      }
      let helper: CodexDesktopQueueHelper | undefined
      try {
        helper = await deps.openQueueHelper(deps.spec())
        const queued = await listAllQueued(helper, deps.spec().threadId)
        const owned = queued.find(
          (entry) =>
            queueEntryId(entry) === refreshed.queuedSubmissionId &&
            queueEntryClientId(entry) === refreshed.clientUserMessageId
        )
        if (owned === undefined) {
          updateAttempt(inputId, {
            state: 'indeterminate',
            detail: 'owned queue row disappeared before delete',
          })
          return { outcome: 'indeterminate', reason: 'owned native queue row disappeared' }
        }
        await helper.delete(deps.spec().threadId, refreshed.queuedSubmissionId)
        deps.readRows()
        const afterDelete = currentAttempt(inputId)
        if (afterDelete.state === 'executed') {
          return { outcome: 'executed', turnId: afterDelete.turnId as TurnId }
        }
        const remaining = await listAllQueued(helper, deps.spec().threadId)
        if (remaining.some((entry) => queueEntryId(entry) === refreshed.queuedSubmissionId)) {
          updateAttempt(inputId, {
            state: 'indeterminate',
            detail: 'native delete did not remove owned row',
          })
          return { outcome: 'indeterminate', reason: 'native delete outcome is indeterminate' }
        }
        const cancelled = updateAttempt(
          inputId,
          { state: 'cancelled', detail: 'owned native queue row delete acknowledged' },
          'CODEX_DESKTOP_NATIVE_ATTEMPT_CANCELLED',
          'Codex desktop owned queued input cancelled'
        )
        deps.ctx().admissionStateChanged?.()
        return cancelled.state === 'cancelled'
          ? { outcome: 'cancelled' }
          : { outcome: 'indeterminate', reason: cancelled.detail ?? 'cancel state changed' }
      } catch (error) {
        updateAttempt(inputId, { state: 'indeterminate', detail: errorMessage(error) })
        return { outcome: 'indeterminate', reason: errorMessage(error) }
      } finally {
        helper?.close()
      }
    },
  }
}

export type NativeDelivery = ReturnType<typeof createNativeDelivery>
