import type { InputId, InvocationInput } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { terminateProcess } from '../../runtime/signals'
import type { CodexCliTmuxHookEnvelope } from '../codex-cli-tmux/hook-events'
import { extractCodexHookRecord } from '../codex-cli-tmux/hook-events'
import type { ApplyInputResult, DriverContext } from '../driver'
import { createHookCaptureSeam } from '../hook-capture'
import { getString } from '../hook-json'
import {
  type HookListenerHandle,
  buildHookSocketPath,
  listenForHookEnvelopes,
} from '../tmux-shared'
import type { CodexDriverEvents } from './driver-events'
import type { CodexDriverState, RendererControlEnvelope, ThreadResponse } from './driver-state'
import {
  asFrameRecord,
  buildThreadStartParams,
  codexTuiSocketDir,
  extractErrorCode,
  extractThreadId,
  findUntrustedHooks,
  frameString,
  isMissingThreadError,
  queueSubmissionId,
  queuedEntryRecords,
} from './driver-support'
import { CODEX_DRIVER_KIND } from './event-map'
import { buildCodexInput } from './input'
import { CodexRpcError, type JsonRpcNotification } from './rpc-client'

export type CodexDriverControl = ReturnType<typeof createCodexDriverControl>

/** `submission.lost` reason for an input that left Codex's queue unattributed. */
const SUBMISSION_LOST_LEFT_QUEUE = 'left-queue-unattributed' as const

function isLive(proc: { exitCode: number | null; signalCode: NodeJS.Signals | null }): boolean {
  return proc.exitCode === null && proc.signalCode === null
}

/**
 * Renderer control channel, thread start/resume, codex-tui hook trust and
 * the codex-tui queued-input delivery path.
 */
export function createCodexDriverControl(s: CodexDriverState, events: CodexDriverEvents) {
  const { requireCtx, emitDiagnostic, emitTerminalFailure, selfMintedProvenance } = events

  function closeRendererControlListener(): void {
    const listener = s.rendererControlListener
    s.rendererControlListener = undefined
    if (listener !== undefined) {
      void listener.close()
    }
  }

  function rendererEnvelopeMatchesFence(
    envelope: RendererControlEnvelope,
    expectedRuntimeId: string | undefined
  ): boolean {
    if (envelope.invocationId !== requireCtx().invocationId) return false
    if (expectedRuntimeId !== undefined && envelope.runtimeId !== expectedRuntimeId) return false
    if (
      s.rendererControlListener === undefined ||
      envelope.callbackSocket !== s.rendererControlListener.socketPath
    ) {
      return false
    }
    return true
  }

  async function handleRendererQuit(): Promise<void> {
    if (s.rendererQuitAccepted || s.terminalEmitted) return
    // Codex 0.163's remote TUI also exits 0 when it loses its server. On an
    // hrcpty seat the broker owns the app-server, so a quit that arrives after
    // that process is gone is a disconnect, not a user quit: the conversation
    // stays (T-12166).
    if (s.hrcpty !== undefined && s.proc !== undefined && !isLive(s.proc)) {
      emitDiagnostic('warn', 'Codex TUI exited after its app-server; continuation kept', {
        exitCode: s.proc.exitCode,
        signal: s.proc.signalCode,
      })
      return
    }
    s.rendererQuitAccepted = true
    s.stopping = true
    requireCtx().emit(
      'continuation.cleared',
      { reason: 'prompt_input_exit' },
      {
        driver: {
          kind: 'codex-app-server',
          rawType: 'app-server-renderer.quit',
        },
      }
    )
    if (s.proc !== undefined) {
      await terminateProcess({
        proc: s.proc,
        graceMs: s.spec?.process.limits?.stopGraceMs ?? 1000,
      })
    }
    setTimeout(closeRendererControlListener, 0)
  }

  /**
   * codex-tui presentation: the wrapper pipes the app-server's stderr (codex
   * tracing, ERROR by default) and forwards it line by line so it lands on the
   * durable stream instead of the TUI pane. Same disposition as the headless
   * stderr relay below (T-08232).
   */
  function handleAppServerStderr(
    envelope: Extract<RendererControlEnvelope, { type: 'app-server-renderer.stderr' }>
  ): void {
    const line = envelope.line?.trim() ?? ''
    if (line.length === 0) return
    emitDiagnostic('info', line)
  }

  function handleRendererExited(
    envelope: Extract<RendererControlEnvelope, { type: 'app-server-renderer.exited' }>
  ): void {
    if (s.rendererQuitAccepted || s.terminalEmitted) return
    emitDiagnostic('error', 'Codex app-server renderer exited unexpectedly', {
      exitCode: envelope.exitCode ?? null,
      signal: envelope.signal ?? null,
    })
  }

  /**
   * Accept a `thread/start` / `thread/resume` response: record the model Codex
   * resolved for the thread (T-08430), then return its id.
   */
  function acceptThread(response: ThreadResponse | undefined): string {
    const reported = response?.model ?? response?.thread?.model
    if (typeof reported === 'string' && reported.length > 0) {
      s.threadModel = { id: reported, source: 'provider-response' }
    } else if (s.driverSpec?.model !== undefined && s.driverSpec.model.length > 0) {
      s.threadModel = { id: s.driverSpec.model, source: 'harness-config' }
    }
    const rollout = response?.thread?.path
    s.threadRolloutPath = typeof rollout === 'string' && rollout.length > 0 ? rollout : undefined
    return extractThreadId(response)
  }

  /**
   * `model/rerouted` says the provider swapped the model out from under the
   * thread. It maps to an operator notice elsewhere; here it also moves thread
   * identity so the NEXT usage event is priced against what actually served it
   * (T-08430).
   */
  function observeModelReroute(notification: JsonRpcNotification): void {
    if (notification.method !== 'model/rerouted') return
    const toModel = frameString(asFrameRecord(notification.params)['toModel'])
    if (toModel !== undefined) {
      s.threadModel = { id: toModel, source: 'provider-response' }
    }
  }

  async function startThread(): Promise<string> {
    if (!s.rpc || !s.spec || !s.driverSpec) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Driver is not initialized')
    }

    const resumeThreadId =
      s.driverSpec.resumeThreadId ??
      (s.spec.continuation?.provider === 'codex' ? s.spec.continuation.key : undefined)

    const startParams = buildThreadStartParams(s.spec, s.driverSpec)
    if (!resumeThreadId) {
      return acceptThread(await s.rpc.sendRequest<ThreadResponse>('thread/start', startParams))
    }

    if (s.codexTui) await scrubQueuedInputs(resumeThreadId)

    try {
      return acceptThread(
        await s.rpc.sendRequest<ThreadResponse>('thread/resume', {
          ...startParams,
          threadId: resumeThreadId,
          history: null,
          path: null,
        })
      )
    } catch (error) {
      if (!isMissingThreadError(error)) {
        throw error
      }

      if ((s.driverSpec.resumeFallback ?? 'start-fresh') === 'fail') {
        const message = error instanceof Error ? error.message : 'Thread not found'
        const code = error instanceof CodexRpcError ? extractErrorCode(error) : undefined
        emitDiagnostic('error', message, code !== undefined ? { code } : undefined)
        emitTerminalFailure(message, code)
        throw new BrokerError(BrokerErrorCode.HarnessError, message, { code })
      }

      requireCtx().emit('driver.notice', {
        message: `Codex thread ${resumeThreadId} was not found; starting a fresh thread`,
        code: 'resume_fallback_start_fresh',
        data: { missingThreadId: resumeThreadId },
      })
      return acceptThread(await s.rpc.sendRequest<ThreadResponse>('thread/start', startParams))
    }
  }

  async function scrubQueuedInputs(targetThreadId: string): Promise<void> {
    if (!s.rpc) return
    const result = await s.rpc.sendRequest<unknown>('thread/queue/list', {
      threadId: targetThreadId,
    })
    const entries = queuedEntryRecords(result)
    for (const entry of entries) {
      const queuedSubmissionId =
        frameString(entry['queuedSubmissionId']) ?? frameString(entry['id'])
      if (queuedSubmissionId === undefined) continue
      await s.rpc.sendRequest('thread/queue/delete', {
        threadId: targetThreadId,
        queuedSubmissionId,
      })
      emitDiagnostic('info', 'Removed stale Codex queued input before resume', {
        queuedSubmissionId,
        clientUserMessageId: frameString(entry['clientUserMessageId']),
      })
    }
  }

  async function ensureCodexHookTrust(): Promise<void> {
    if (!s.codexTui || !s.rpc) return
    const result = await s.rpc.sendRequest<unknown>('hooks/list', {})
    const untrusted = findUntrustedHooks(result)
    if (untrusted.length === 0) return
    await s.rpc.sendRequest('config/batchWrite', {
      edits: untrusted.map(({ key, trustedHash }) => ({
        keyPath: `hooks.state.${key}.trusted_hash`,
        value: trustedHash,
      })),
      mergeStrategy: 'upsert',
      reloadUserConfig: true,
    })
  }

  /**
   * codex-tui delivery (T-13687). Codex's `thread/queue/add` acknowledgement
   * is the delivery boundary, and the call returns there with no turn id: the
   * driver is `observed`, so the broker's slot rules free the next input at a
   * turn boundary and attribution settles this input's fate later, from the
   * user item carrying its client id. Nothing here waits on attribution.
   */
  async function applyQueuedInput(
    input: InvocationInput,
    inputId: InputId
  ): Promise<ApplyInputResult> {
    if (!s.rpc || !s.threadId || !s.driverSpec) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Invocation is not ready')
    }
    // Armed before the write: a fast provider can report the user item before
    // queue/add's response arrives.
    s.pendingBrokerInputs.add(inputId)
    const completedTurnVersion = s.completedTurnVersion
    try {
      const response = await s.rpc.sendRequest<unknown>('thread/queue/add', {
        threadId: s.threadId,
        input: buildCodexInput(input, s.driverSpec.defaultImageAttachments),
        clientUserMessageId: inputId,
      })
      const queuedSubmissionId = queueSubmissionId(response)
      if (queuedSubmissionId === undefined) {
        throw new BrokerError(
          BrokerErrorCode.HarnessError,
          'Codex thread/queue/add response did not carry queuedSubmission.id'
        )
      }
      // The provider queue identity matters only while attribution is open.
      if (s.pendingBrokerInputs.has(inputId)) s.queuedSubmissions.set(inputId, queuedSubmissionId)
      requireCtx().emit(
        'driver.notice',
        {
          message: 'Codex queued input accepted',
          code: 'codex_tui_queue_add_ack',
          data: { queuedSubmissionId },
        },
        {
          inputId,
          driver: {
            kind: 'codex-app-server',
            rawType: 'thread/queue/add.response',
          },
        }
      )
      // A native terminal can precede queue/add's response. Reconcile again
      // now that the provider's queue identity is available.
      if (completedTurnVersion !== s.completedTurnVersion) void reconcilePendingQueuedInputs()
      if (s.queuedStartRequired && !s.turnActive) {
        await startQueuedSubmission(inputId, queuedSubmissionId)
      }
      return {}
    } catch (error) {
      forgetQueuedInput(inputId)
      throw error instanceof BrokerError
        ? error
        : new BrokerError(
            BrokerErrorCode.HarnessError,
            error instanceof Error ? error.message : 'Codex queue delivery failed'
          )
    }
  }

  function forgetQueuedInput(inputId: InputId): void {
    s.pendingBrokerInputs.delete(inputId)
    s.retiredSteerTurnsByInput.delete(inputId)
    s.queuedSubmissions.delete(inputId)
  }

  /**
   * Fate settler for delivered-but-unattributed inputs (T-13668, T-13687). At
   * a turn terminal, a COMPLETE provider queue read that no longer holds the
   * row, with no turn claiming the input, proves the body left Codex's queue
   * unattributed: it is settled `submission.lost`. Any failed or partial read
   * changes nothing. The slot is the broker's and is already free; the next
   * terminal reads again.
   */
  async function reconcilePendingQueuedInputs(): Promise<void> {
    const rpc = s.rpc
    const threadId = s.threadId
    if (!rpc || !threadId) return
    // Fence the read to inputs pending at this terminal, never later arrivals.
    const pending = [...s.queuedSubmissions].filter(([id]) => s.pendingBrokerInputs.has(id))
    if (pending.length === 0) return
    try {
      const queuedIds = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      for (;;) {
        const page = asFrameRecord(
          await rpc.sendRequest<unknown>('thread/queue/list', {
            threadId,
            ...(cursor !== undefined ? { cursor } : {}),
          })
        )
        // Absence is proof only after a complete, valid provider queue read.
        if (!Array.isArray(page['data'])) throw new Error('Invalid Codex queue/list data')
        for (const entry of page['data']) {
          const id = queueSubmissionId(entry)
          if (id === undefined) throw new Error('Codex queue/list entry lacks an id')
          queuedIds.add(id)
        }
        const next = page['nextCursor']
        if (next === null) break
        if (typeof next !== 'string' || next.length === 0 || cursors.has(next)) {
          throw new Error('Invalid or repeated Codex queue/list cursor')
        }
        cursors.add(next)
        cursor = next
      }
      // A newer turn may already have consumed the submission and still be
      // compacting before its user item. Its terminal will reconcile again.
      if (s.rpc !== rpc || s.threadId !== threadId || s.turnActive || s.terminalEmitted) return
      for (const [inputId, queuedSubmissionId] of pending) {
        if (
          !s.pendingBrokerInputs.has(inputId) ||
          s.queuedSubmissions.get(inputId) !== queuedSubmissionId ||
          queuedIds.has(queuedSubmissionId)
        )
          continue
        forgetQueuedInput(inputId)
        emitDiagnostic(
          'warn',
          'Codex queued submission left the queue without an attributed turn',
          {
            inputId,
            queuedSubmissionId,
          }
        )
        requireCtx().emit(
          'submission.lost',
          { submissionId: inputId, reason: SUBMISSION_LOST_LEFT_QUEUE },
          {
            inputId,
            driver: { kind: 'codex-app-server', rawType: 'thread/queue/list' },
            provenance: selfMintedProvenance(),
          }
        )
      }
    } catch (error) {
      if (s.rpc !== rpc || s.threadId !== threadId) return
      emitDiagnostic('warn', 'Could not reconcile pending Codex queued inputs', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function startNextQueuedSubmission(): Promise<void> {
    if (!s.rpc || !s.threadId) return
    for (const inputId of s.pendingBrokerInputs) {
      const queuedSubmissionId = s.queuedSubmissions.get(inputId)
      if (queuedSubmissionId === undefined) continue
      await startQueuedSubmission(inputId, queuedSubmissionId)
      return
    }
  }

  async function startQueuedSubmission(
    _inputId: InputId,
    queuedSubmissionId: string
  ): Promise<void> {
    if (!s.rpc || !s.threadId) return
    try {
      await s.rpc.sendRequest('thread/queue/start', {
        threadId: s.threadId,
        queuedSubmissionId,
      })
    } catch (error) {
      emitDiagnostic('warn', 'Codex queued submission did not start after interrupted turn', {
        queuedSubmissionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function startCodexTuiHookListener(
    driverCtx: DriverContext,
    expectedRuntimeId: string | undefined,
    socketDir?: string | undefined
  ): Promise<HookListenerHandle> {
    const socketPath = buildHookSocketPath(socketDir ?? codexTuiSocketDir(), 'codex-tui-hooks', {
      invocationId: driverCtx.invocationId,
      runtimeId: expectedRuntimeId,
    })
    const captureSeam = createHookCaptureSeam({
      ...(driverCtx.capture !== undefined ? { capture: driverCtx.capture } : {}),
      provider: 'openai',
      driverKind: CODEX_DRIVER_KIND,
      invocationId: driverCtx.invocationId,
      knownHookNames: new Set(['Stop', 'PostToolUse']),
      unknownHookFamily: 'diagnostic',
    })
    return listenForHookEnvelopes<CodexCliTmuxHookEnvelope>(socketPath, (envelope) => {
      if (envelope.invocationId !== driverCtx.invocationId) return
      if (expectedRuntimeId !== undefined && envelope.runtimeId !== expectedRuntimeId) return
      if (envelope.callbackSocket !== socketPath || envelope.generation !== 1) return
      const hook = extractCodexHookRecord(envelope)
      return captureSeam.ingest(
        {
          nativeType: getString(hook, 'hook_event_name'),
          hookData: hook,
          ...(envelope.turnId !== undefined ? { turnId: envelope.turnId } : {}),
        },
        () =>
          getString(hook, 'hook_event_name') === 'Stop' ? envelope.mailStopDecision : undefined
      )
    })
  }

  return {
    closeRendererControlListener,
    rendererEnvelopeMatchesFence,
    handleRendererQuit,
    handleAppServerStderr,
    handleRendererExited,
    acceptThread,
    observeModelReroute,
    startThread,
    scrubQueuedInputs,
    ensureCodexHookTrust,
    applyQueuedInput,
    reconcilePendingQueuedInputs,
    startNextQueuedSubmission,
    startQueuedSubmission,
    startCodexTuiHookListener,
  }
}
