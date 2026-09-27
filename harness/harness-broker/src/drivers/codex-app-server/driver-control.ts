import type { InputId, InvocationInput, TurnId } from 'spaces-harness-broker-protocol'
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

/**
 * Renderer control channel, thread start/resume, codex-tui hook trust and
 * the codex-tui queued-input delivery path.
 */
export function createCodexDriverControl(s: CodexDriverState, events: CodexDriverEvents) {
  const {
    requireCtx,
    emitDiagnostic,
    emitTerminalFailure,
    failActiveTurn,
    ensureUnknownAttribution,
  } = events

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
    s.rendererQuitAccepted = true
    s.stopping = true
    if (s.turnTimeout !== undefined) {
      clearTimeout(s.turnTimeout)
      s.turnTimeout = undefined
    }
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

  async function applyQueuedInput(
    input: InvocationInput,
    inputId: InputId
  ): Promise<ApplyInputResult> {
    if (!s.rpc || !s.threadId || !s.driverSpec) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Invocation is not ready')
    }
    s.pendingBrokerInputs.add(inputId)
    const attributed = new Promise<TurnId>((resolve, reject) => {
      s.attributionWaiters.set(inputId, { resolve, reject })
    })
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
      s.queuedSubmissions.set(inputId, queuedSubmissionId)
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
      if (s.queuedStartRequired && !s.turnActive) {
        await startQueuedSubmission(inputId, queuedSubmissionId)
      }
      const timeoutMs = s.spec?.process.limits?.turnTimeoutMs
      const observedTurnId =
        timeoutMs !== undefined && timeoutMs > 0
          ? await Promise.race([
              attributed,
              new Promise<never>((_resolve, reject) => {
                s.turnTimeout = setTimeout(() => {
                  const timeout = new BrokerError(
                    BrokerErrorCode.Timeout,
                    'Turn attribution timed out'
                  )
                  ensureUnknownAttribution(s.currentTurnId)
                  failActiveTurn({
                    message: timeout.message,
                    code: 'Timeout',
                    retryable: false,
                    reason: 'turn-timeout',
                  })
                  reject(timeout)
                }, timeoutMs)
              }),
            ])
          : await attributed
      if (s.turnTimeout !== undefined) clearTimeout(s.turnTimeout)
      s.turnTimeout = undefined
      s.queuedSubmissions.delete(inputId)
      return { turnId: observedTurnId }
    } catch (error) {
      s.pendingBrokerInputs.delete(inputId)
      s.retiredSteerTurnsByInput.delete(inputId)
      s.attributionWaiters.delete(inputId)
      s.queuedSubmissions.delete(inputId)
      if (s.turnTimeout !== undefined) clearTimeout(s.turnTimeout)
      s.turnTimeout = undefined
      throw error instanceof BrokerError
        ? error
        : new BrokerError(
            BrokerErrorCode.HarnessError,
            error instanceof Error ? error.message : 'Codex queue delivery failed'
          )
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
    startNextQueuedSubmission,
    startQueuedSubmission,
    startCodexTuiHookListener,
  }
}
