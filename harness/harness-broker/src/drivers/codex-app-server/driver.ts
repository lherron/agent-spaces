import type {
  CodexAppServerDriverSpec,
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { CaptureNormalizer } from '../../capture/capture-gate'
import { BrokerError } from '../../errors'
import { terminateProcess } from '../../runtime/signals'
import type { Driver } from '../driver'
import { CODEX_APP_SERVER_AUTHORITY } from '../evidence-authority'
import { CODEX_CAPABILITIES, CODEX_TUI_CAPABILITIES } from './capabilities'
import { createCodexDriverControl } from './driver-control'
import { createCodexDriverEvents } from './driver-events'
import { createCodexDriverInput } from './driver-input'
import { createCodexDriverNormalizer } from './driver-normalize'
import { createCodexDriverStart } from './driver-start'
import {
  CODEX_APP_SERVER_DRIVER_VERSION,
  type CodexAppServerDriverOptions,
  createCodexDriverState,
} from './driver-state'
import { isCodexTuiSpec } from './driver-support'
import { createCodexNotificationMapper } from './event-map'
import { createPermissionRequestIdAllocator } from './permissions'

export type { CodexAppServerDriverOptions } from './driver-state'

const bunRuntime =
  typeof Bun !== 'undefined' ? (Bun as unknown as { execPath?: string }) : undefined
if (bunRuntime !== undefined && bunRuntime.execPath === undefined) {
  Object.defineProperty(Bun, 'execPath', {
    value: process.execPath,
    configurable: true,
  })
}
export function createCodexAppServerDriver(options: CodexAppServerDriverOptions = {}): Driver {
  const s = createCodexDriverState()
  const mapCodexNotification = createCodexNotificationMapper({
    modelIdentity: () => s.threadModel,
  })
  const permissionRequestIds = createPermissionRequestIdAllocator()
  const events = createCodexDriverEvents(s)
  const control = createCodexDriverControl(s, events)
  const normalizer = createCodexDriverNormalizer(s, events, control, mapCodexNotification)
  const { start } = createCodexDriverStart(
    s,
    options,
    permissionRequestIds,
    events,
    control,
    normalizer
  )
  const { applyInputNow, applySteerNow } = createCodexDriverInput(s, events, control)
  const { settleAllPendingSteers } = events
  const { closeRendererControlListener } = control
  const { normalizeCommittedRecord } = normalizer

  return {
    kind: 'codex-app-server',
    version: CODEX_APP_SERVER_DRIVER_VERSION,
    get bracketMintingMode() {
      return s.codexTui ? ('observed' as const) : ('delivery-acknowledged' as const)
    },
    evidenceAuthority: CODEX_APP_SERVER_AUTHORITY,
    nativeSourceKind: 'provider-jsonrpc',
    get preemptMode() {
      return s.codexTui ? null : ('atomic' as const)
    },
    steerLandingEvidence: 'transcript',
    interruptLandingEvidence: 'ack',
    resolvesSteerAtActuation: true,
    capabilities(candidate?: HarnessInvocationSpec): InvocationCapabilities {
      if (candidate?.driver.kind === 'codex-app-server') {
        s.codexTui = isCodexTuiSpec(candidate.driver as CodexAppServerDriverSpec)
      }
      return s.codexTui ? CODEX_TUI_CAPABILITIES : CODEX_CAPABILITIES
    },

    captureNormalizer(): CaptureNormalizer {
      return normalizeCommittedRecord
    },

    start,

    applyInputNow,
    applySteerNow,

    async interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (req.scope !== 'turn') {
        return {
          accepted: false,
          effect: 'unsupported',
          reason: 'Codex invocation-scope interrupt is unsupported',
        }
      }
      if (!s.rpc || !s.threadId || !s.turnActive || s.currentTurnId === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      const turnId = s.currentTurnId
      try {
        await s.rpc.sendRequest('turn/interrupt', { threadId: s.threadId, turnId })
      } catch (error) {
        throw new BrokerError(
          BrokerErrorCode.HarnessError,
          error instanceof Error ? error.message : 'Codex turn/interrupt failed'
        )
      }
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
      s.stopping = true
      settleAllPendingSteers('target-terminal')
      closeRendererControlListener()
      if (s.hookListener !== undefined) {
        const listener = s.hookListener
        s.hookListener = undefined
        await listener.close()
      }
      // Clear any pending turn timeout; the stop takes precedence.
      if (s.turnTimeout !== undefined) {
        clearTimeout(s.turnTimeout)
        s.turnTimeout = undefined
      }
      if (s.codexTui) {
        await s.paneController?.interrupt().catch(() => undefined)
        s.rpc?.close()
        return { accepted: true, state: s.terminalEmitted ? 'exited' : 'failed' }
      }
      if (!s.proc) {
        return { accepted: false, state: 'failed' }
      }
      await terminateProcess({
        proc: s.proc,
        graceMs: req.graceMs ?? s.spec?.process.limits?.stopGraceMs ?? 1000,
      })
      return { accepted: true, state: s.terminalEmitted ? 'exited' : 'failed' }
    },

    async dispose(): Promise<void> {
      closeRendererControlListener()
      if (s.hookListener !== undefined) await s.hookListener.close().catch(() => undefined)
      s.reportedTranscriptPaths.clear()
      s.ungatedFrames.length = 0
      s.rpc?.close()
      s.ctx = undefined
      s.spec = undefined
      s.driverSpec = undefined
      s.proc = undefined
      s.rpc = undefined
      s.paneController = undefined
      s.hookListener = undefined
      s.attachTokenPath = undefined
      s.websocketSocketPath = undefined
      s.pendingBrokerInputs.clear()
      settleAllPendingSteers('target-terminal')
      s.retiredSteerTurnsByInput.clear()
      s.observedUserItems.clear()
      s.queuedSubmissions.clear()
      s.attributionByTurn.clear()
      s.firstItemSeen.clear()
      for (const waiter of s.attributionWaiters.values()) {
        waiter.reject(new Error('Codex TUI invocation disposed'))
      }
      s.attributionWaiters.clear()
      s.threadId = undefined
      s.currentInputId = undefined
      s.currentTurnId = undefined
      s.turnActive = false
      s.startedEmitted = false
      s.terminalEmitted = false
      s.stopping = false
      s.starting = false
      s.rendererQuitAccepted = false
    },
  }
}

export {
  buildThreadStartParams,
  defaultProviderTranscriptDir,
  validateInitializeHandshake,
} from './driver-support'
