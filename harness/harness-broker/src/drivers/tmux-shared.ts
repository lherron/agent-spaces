import type { InvocationInput } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../errors'
import { shellQuote } from '../runtime/shell-quote'
import {
  type TmuxExec,
  TmuxPaneController,
  type TmuxPaneControllerLease,
  type TmuxPaneInputSelector,
} from '../runtime/tmux'
import type { DriverContext } from './driver'

export {
  type HookEnvelopeDecision,
  type HookEnvelopeResult,
  type HookListenerHandle,
  buildHookSocketPath,
  getInvocationRuntimeId,
  listenForHookEnvelopes,
} from './hook-callback/listener'
export { shellQuote }

/** Concatenate the text parts of an invocation input into a single string. */
export function extractText(input: InvocationInput): string {
  return input.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter((segment) => segment.length > 0)
    .join('')
}

/** Sleep helper shared by the tmux drivers' input-delivery paths. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const inputFingerprint = (line: string, cursorX: number): string => `${cursorX}\0${line}`

/** Codex renders dim placeholder text after an otherwise empty `› ` prompt. */
export const selectCodexCliPaneInput: TmuxPaneInputSelector = (snapshot) => {
  const markerIndex = snapshot.styledLine.indexOf('›')
  const dimIndex = snapshot.styledLine.indexOf('\x1b[2m', Math.max(0, markerIndex))
  const afterPrompt = snapshot.line.replace(/^\s*›[ \u00a0]?/u, '')
  const placeholderOnly =
    snapshot.cursorX === 2 && markerIndex >= 0 && dimIndex > markerIndex && afterPrompt.length > 0
  const empty =
    snapshot.cursorX === 2 && (/^\s*›[ \u00a0]*$/u.test(snapshot.line) || placeholderOnly)
  return {
    empty,
    fingerprint: empty ? 'codex-cli:empty' : inputFingerprint(snapshot.line, snapshot.cursorX),
  }
}

/**
 * Claude's input box is empty when its cursor rests after the bare `❯ ` marker.
 * Claude also renders dim presentation text on that otherwise-empty row: the
 * "Press up to edit queued messages" hint while a steer is queued, and an idle
 * seat's prompt suggestion (T-12094). With the cursor still at the marker, dim
 * text is not editor input; typed text is undimmed and moves the cursor.
 */
export const selectClaudeCodePaneInput: TmuxPaneInputSelector = (snapshot) => {
  const markerIndex = snapshot.styledLine.indexOf('❯')
  const dimIndex = snapshot.styledLine.indexOf('\x1b[2m', Math.max(0, markerIndex))
  const afterPrompt = snapshot.line.replace(/^\s*❯[ \u00a0]?/u, '')
  const dimTextOnly =
    snapshot.cursorX === 2 && markerIndex >= 0 && dimIndex > markerIndex && afterPrompt.length > 0
  const empty = snapshot.cursorX === 2 && (/^\s*❯[ \u00a0]*$/u.test(snapshot.line) || dimTextOnly)
  return {
    empty,
    fingerprint: empty ? 'claude-code:empty' : inputFingerprint(snapshot.line, snapshot.cursorX),
    prompt: /^\s*❯[ \u00a0]/u.test(snapshot.line),
  }
}

/** Pi uses an unprefixed blank editor row for an empty input buffer. */
export const selectPiTuiPaneInput: TmuxPaneInputSelector = (snapshot) => {
  const empty = snapshot.cursorX === 0 && snapshot.line.trim().length === 0
  return {
    empty,
    fingerprint: empty ? 'pi-tui:empty' : inputFingerprint(snapshot.line, snapshot.cursorX),
  }
}

/**
 * SessionEnd reasons that mean the OPERATOR deliberately ended the conversation,
 * so the captured continuation must be dropped (next launch is fresh). An
 * external pane-kill / crash reports `other` (or fires no SessionEnd at all) and
 * is intentionally absent here, so `--resume` durability survives pane
 * recreation (T-01761 ariadne case). Shared by both tmux drivers so HRC's
 * continuation.cleared -> broker-tmux lease reap fires identically for each.
 *
 * NOTE: invocation-manager's SESSION_LEAVE_REASONS is a deliberately smaller set
 * (no `clear`) and is intentionally NOT this constant.
 */
export const USER_INITIATED_END_REASONS = new Set(['prompt_input_exit', 'logout', 'clear'])

/** Surface ids reported by a consumed pane lease. */
export interface PaneLeaseSurface {
  socketPath: string
  sessionId: string
  windowId: string
  paneId: string
  sessionName?: string | undefined
  windowName?: string | undefined
}

export interface ConsumePaneLeaseResult {
  controller: TmuxPaneController
  surface: PaneLeaseSurface
}

/**
 * Validate the runtime pane lease shape (`runtime.terminalSurface`), construct a
 * {@link TmuxPaneController} against it, inspect the pane, and assert the tmux
 * server's reported ids match the lease. Throws a {@link BrokerError} on any
 * shape/identity mismatch. Shared by both tmux drivers' `start()`.
 */
export async function consumePaneLease(
  driverCtx: DriverContext,
  opts: {
    driverKind: string
    tmuxBin?: string | undefined
    exec?: TmuxExec | undefined
  }
): Promise<ConsumePaneLeaseResult> {
  const lease = driverCtx.runtime?.terminalSurface
  if (lease === undefined) {
    throw new BrokerError(
      BrokerErrorCode.InvalidInvocationState,
      `${opts.driverKind} start requires a runtime pane lease (runtime.terminalSurface); HRC / the pre-HRC harness owns the tmux server and must hand the driver a pane`
    )
  }
  if (lease.kind !== 'tmux-pane') {
    throw new BrokerError(
      BrokerErrorCode.InvalidInvocationState,
      `${opts.driverKind} requires an hrc-owned tmux-pane lease: runtime.terminalSurface.kind === 'tmux-pane' (got ${String(
        (lease as { kind?: unknown }).kind
      )})`
    )
  }
  if (lease.ownership !== 'hrc') {
    throw new BrokerError(
      BrokerErrorCode.InvalidInvocationState,
      `${opts.driverKind} requires an hrc-owned tmux-pane lease: runtime.terminalSurface.ownership === 'hrc' (got ${String(
        (lease as { ownership?: unknown }).ownership
      )})`
    )
  }

  const controllerLease: TmuxPaneControllerLease = {
    paneId: lease.paneId,
    sessionId: lease.sessionId,
    windowId: lease.windowId,
    ...(lease.sessionName !== undefined ? { sessionName: lease.sessionName } : {}),
    ...(lease.windowName !== undefined ? { windowName: lease.windowName } : {}),
    allowedOps: lease.allowedOps,
  }
  const controller = new TmuxPaneController({
    socketPath: lease.socketPath,
    ...(opts.tmuxBin !== undefined ? { tmuxBin: opts.tmuxBin } : {}),
    ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
    lease: controllerLease,
  })

  let inspection: { paneId: string; sessionId: string; windowId: string }
  try {
    inspection = await controller.inspect()
  } catch (error) {
    throw new BrokerError(
      BrokerErrorCode.InvalidInvocationState,
      `leased pane not found or id mismatch: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (
    inspection.paneId !== lease.paneId ||
    inspection.sessionId !== lease.sessionId ||
    inspection.windowId !== lease.windowId
  ) {
    throw new BrokerError(
      BrokerErrorCode.InvalidInvocationState,
      `leased pane not found or id mismatch: tmux reported ${inspection.sessionId}/${inspection.windowId}/${inspection.paneId}, lease ${lease.sessionId}/${lease.windowId}/${lease.paneId}`
    )
  }

  return {
    controller,
    surface: {
      socketPath: lease.socketPath,
      sessionId: lease.sessionId,
      windowId: lease.windowId,
      paneId: lease.paneId,
      ...(lease.sessionName !== undefined ? { sessionName: lease.sessionName } : {}),
      ...(lease.windowName !== undefined ? { windowName: lease.windowName } : {}),
    },
  }
}
