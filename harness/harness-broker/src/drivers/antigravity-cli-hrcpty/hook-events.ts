import type {
  EventProvenance,
  InputId,
  MessageId,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { CapturedRecord } from '../../capture/capture-gate'
import type { DriverContext } from '../driver'
import { withDeliveryEvidence, withSteerRequiresOwnTurn } from '../driver'
import { asRecord, getNumber, getString } from '../hook-json'
import { queryMailHintDecision, queryMailStopDecision } from '../mail-stop-gate'
import { type AntigravityHookEnvelope, WORKSPACE_MISMATCH } from './hook-bridge'
import { ANTIGRAVITY_DRIVER_KIND, ANTIGRAVITY_HOOK_GENERATION } from './launch'
import {
  type TranscriptRow,
  createAntigravityTranscript,
  framedUserRequest,
  stopContinuationText,
} from './transcript'

type EmitExtra = NonNullable<Parameters<DriverContext['emit']>[2]>
type Reply = Record<string, unknown>
type Delivery = { text: string; inputId: InputId | undefined; turnId: TurnId }
type Steer = {
  text: string
  inputId: InputId | undefined
  handout?: { route: 'PreInvocation' | 'Stop'; turnId: TurnId; firstStep: number }
  resolve: () => void
  reject: (error: Error) => void
}
type Tool = {
  id: ToolCallId
  name: string
  row?: TranscriptRow
  post?: { error: string | undefined; extra: EmitExtra }
}
type Turn = {
  id: TurnId
  inputId: InputId | undefined
  latestHook: { event: string; startedAt: number }
  openedAt: number
  finalOutput?: string
  producedContent: boolean
  mailContinuation?: { text: string; firstStep: number } | undefined
  terminal?: 'completed' | 'interrupted'
}

// A Stop decision may still carry mail after the CLI bridge has returned its
// fallback. Keep the gate request alive long enough to recover that reason.
const MAIL_STOP_QUERY_TIMEOUT_MS = 2_500

const HOOKS = new Set([
  'SessionStart',
  'PreInvocation',
  'PostInvocation',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'StatusLine',
])

export function createAntigravityHookEvents(options: {
  ctx: DriverContext
  env: Record<string, string>
  callbackSocket: string
  onReady: (provenance?: EventProvenance) => void
  onWorkspaceMismatch: () => void
  onMissedMail: (text: string) => void
}) {
  const { ctx, env } = options
  const transcript = createAntigravityTranscript(ctx)
  const tools = new Map<number, Tool>()
  let turnNumber = 0
  let humanSubmissions = 0
  let ready = false
  let closed = false
  let active: Turn | undefined
  let pendingDelivery: Delivery | undefined
  let steer: Steer | undefined
  let transcriptPath: string | undefined
  let firstStep = 0
  let conversationId: string | undefined
  let contextSize: number | undefined
  let statusTime = 0
  let idle = false
  const missedMail: string[] = []

  function flushMissedMail(): void {
    if (!idle || active !== undefined) return
    for (const text of missedMail.splice(0)) options.onMissedMail(text)
  }

  function retainMissedMail(text: string): void {
    missedMail.push(text)
    flushMissedMail()
  }

  function nextTurnId(): TurnId {
    return `turn_${ctx.invocationId}_${++turnNumber}` as TurnId
  }

  function extraFor(rawType: string, turn?: Turn, provenance?: EventProvenance): EmitExtra {
    return {
      driver: { kind: ANTIGRAVITY_DRIVER_KIND, rawType },
      turnId: turn?.id,
      inputId: turn?.inputId,
      provenance,
    }
  }

  function drainTranscript(turn: Turn): void {
    if (transcriptPath === undefined) return
    transcript.drain(transcriptPath, firstStep, (row, provenance) => {
      const extra = { ...extraFor(row.type, turn, provenance), sourceTime: row.time }
      const text = framedUserRequest(row.content)
      if (row.type === 'USER_INPUT' && row.source === 'USER_EXPLICIT' && text !== undefined) {
        ctx.emit('user.message', { content: text, turnId: turn.id, inputId: turn.inputId }, extra)
      }

      const stopReason =
        row.type === 'SYSTEM_MESSAGE' && row.source === 'SYSTEM'
          ? stopContinuationText(row.content)
          : undefined
      const mail = turn.mailContinuation
      if (mail !== undefined && row.step >= mail.firstStep && stopReason === mail.text) {
        turn.mailContinuation = undefined
      }
      const pending = steer
      const handout = pending?.handout
      const injectedText =
        handout?.route === 'PreInvocation' &&
        row.type === 'USER_INPUT' &&
        row.source === 'SYSTEM_SDK'
          ? text
          : handout?.route === 'Stop'
            ? stopReason
            : undefined
      if (
        pending !== undefined &&
        handout?.turnId === turn.id &&
        row.step >= handout.firstStep &&
        injectedText === pending.text
      ) {
        steer = undefined
        if (pending.inputId !== undefined) {
          ctx.emit(
            'submission.absorbed',
            { submissionId: pending.inputId, turnId: turn.id },
            { ...extra, inputId: pending.inputId }
          )
        }
        pending.resolve()
      }

      if (row.type === 'PLANNER_RESPONSE') {
        if (row.content) {
          const messageId = `msg_${ctx.invocationId}_${row.step}` as MessageId
          ctx.emit(
            'assistant.message.completed',
            { messageId, content: [{ type: 'text', text: row.content }] },
            { ...extra, itemId: messageId }
          )
          turn.finalOutput = row.content
          turn.producedContent = true
        }
        if (row.inputTokens !== undefined || row.outputTokens !== undefined) {
          const inputTokens = row.inputTokens ?? 0
          const outputTokens = row.outputTokens ?? 0
          const cacheReadTokens = row.cacheReadTokens ?? 0
          ctx.emit(
            'usage.updated',
            {
              usage: { inputTokens, outputTokens, cacheReadInputTokens: cacheReadTokens },
              model:
                row.model === undefined
                  ? undefined
                  : { id: row.model, source: 'provider-response' },
              context: {
                usedTokens: inputTokens + cacheReadTokens + outputTokens,
                windowTokens: contextSize,
              },
            },
            extra
          )
        }
      }

      const tool = tools.get(row.step)
      if (tool !== undefined) tool.row = row
    })
  }

  function settleTools(turn: Turn, extra: EmitExtra, atTerminal: boolean): void {
    for (const [step, tool] of tools) {
      const { id, name, row, post } = tool
      if (row === undefined && !(post !== undefined && atTerminal)) continue
      if (post !== undefined && !post.error) {
        ctx.emit('tool.call.completed', { toolCallId: id, name, result: row?.content }, post.extra)
      } else if (post !== undefined || atTerminal || row?.status === 'ERROR') {
        ctx.emit(
          'tool.call.failed',
          {
            toolCallId: id,
            name,
            code: post === undefined ? 'antigravity_tool_no_post_hook' : 'antigravity_tool_error',
            message: row?.error || post?.error || row?.content || 'Antigravity tool failed',
          },
          post?.extra ?? { ...extra, turnId: turn.id }
        )
      } else {
        continue
      }
      tools.delete(step)
    }
  }

  function endTurn(turn: Turn, terminal: 'completed' | 'interrupted', extra: EmitExtra): void {
    if (active !== turn) return
    drainTranscript(turn)
    settleTools(turn, extra, true)
    turn.terminal = terminal
    active = undefined
    tools.clear()
    const pending = steer
    steer = undefined
    if (terminal === 'completed') {
      ctx.emit(
        'turn.completed',
        {
          turnId: turn.id,
          status: terminal,
          finalOutput: turn.finalOutput,
          producedContent: turn.producedContent,
        },
        extra
      )
      if (turn.mailContinuation !== undefined && turn.latestHook.event === 'Stop') {
        retainMissedMail(turn.mailContinuation.text)
      }
    } else {
      ctx.emit(
        'turn.interrupted',
        { turnId: turn.id, status: terminal, finalOutput: turn.finalOutput },
        extra
      )
    }
    pending?.reject(
      withSteerRequiresOwnTurn(
        withDeliveryEvidence(
          new Error('Antigravity turn ended before the steer appeared in its transcript'),
          pending.handout === undefined ? 'not_written' : 'possibly_written'
        )
      )
    )
  }

  function observeStatus(envelope: AntigravityHookEnvelope, provenance?: EventProvenance): void {
    const turn = active
    if (
      envelope.startedAt < statusTime ||
      (turn !== undefined && envelope.startedAt < turn.openedAt)
    ) {
      return
    }
    statusTime = envelope.startedAt
    const window = getNumber(asRecord(envelope.payload['context_window']), 'context_window_size')
    if (window !== undefined && window > 0) contextSize = window
    idle = envelope.payload['agent_state'] === 'idle'
    if (idle && !ready) {
      ready = true
      options.onReady(provenance)
    }
    if (turn === undefined) {
      flushMissedMail()
      return
    }
    const extra = extraFor('StatusLine', turn, provenance)
    if (idle && envelope.startedAt >= turn.latestHook.startedAt) {
      endTurn(turn, turn.latestHook.event === 'Stop' ? 'completed' : 'interrupted', extra)
    } else if (!idle) {
      drainTranscript(turn)
    }
  }

  function observeHook(
    envelope: AntigravityHookEnvelope,
    provenance?: EventProvenance
  ): Turn | undefined {
    const { event, payload, startedAt } = envelope
    if (event === 'StatusLine') {
      observeStatus(envelope, provenance)
      return
    }
    const nextConversationId = getString(payload, 'conversationId')
    if (nextConversationId && conversationId !== nextConversationId) {
      conversationId = nextConversationId
      ctx.emit(
        'continuation.updated',
        { provider: 'google', kind: 'conversation', key: conversationId },
        extraFor(event, undefined, provenance)
      )
    }
    if (event === 'PreInvocation' && envelope.workspaceMismatch !== undefined) {
      closed = true
      ctx.emit(
        'continuation.cleared',
        { reason: WORKSPACE_MISMATCH },
        extraFor(event, active, provenance)
      )
      options.onWorkspaceMismatch()
      ctx.emit(
        'invocation.failed',
        {
          reason: WORKSPACE_MISMATCH,
          message: 'Antigravity reported a working directory different from the seat directory',
          data: envelope.workspaceMismatch,
        },
        extraFor(event, active, provenance)
      )
      return
    }

    transcriptPath = getString(payload, 'transcriptPath') ?? transcriptPath
    if (active === undefined && event === 'PreInvocation' && payload['invocationNum'] === 0) {
      const prompt = getString(payload, 'lastUserInput')
      const delivery = pendingDelivery?.text === prompt ? pendingDelivery : undefined
      if (delivery !== undefined) pendingDelivery = undefined
      idle = false
      firstStep = Math.max(0, (getNumber(payload, 'initialNumSteps') ?? 1) - 1)
      active = {
        id: delivery?.turnId ?? nextTurnId(),
        inputId: delivery?.inputId,
        latestHook: { event, startedAt },
        openedAt: startedAt,
        producedContent: false,
      }
      const extra = extraFor(event, active, provenance)
      ctx.emit(
        'turn.started',
        {
          turnId: active.id,
          inputId: active.inputId,
          source: 'hook-observed',
          sessionId: conversationId,
          prompt,
        },
        extra
      )
      // Every executed prompt names its submission, as Claude's attribution
      // does. A prompt the broker did not deliver (the launch prompt carried in
      // argv, or text typed by an attached human) gets a minted id. HRC binds a
      // launch-carried run only through this event.
      ctx.emit(
        'submission.executed',
        {
          submissionId:
            delivery?.inputId ?? `human_submission_${ctx.invocationId}_${++humanSubmissions}`,
          turnId: active.id,
        },
        extra
      )
    }

    const turn = active
    if (turn === undefined || startedAt < turn.openedAt) return
    if (startedAt >= turn.latestHook.startedAt) {
      turn.latestHook = { event, startedAt }
    }
    const extra = extraFor(event, turn, provenance)
    const toolCall = asRecord(payload['toolCall'])
    const step = getNumber(payload, 'stepIdx')
    const id = getString(toolCall, 'id') as ToolCallId | undefined
    const name = getString(toolCall, 'name')
    if (
      event === 'PreToolUse' &&
      step !== undefined &&
      id !== undefined &&
      name !== undefined &&
      !tools.has(step)
    ) {
      tools.set(step, { id, name })
      turn.producedContent = true
      ctx.emit('tool.call.started', { toolCallId: id, name, input: toolCall['args'] }, extra)
    }
    const tool = step === undefined ? undefined : tools.get(step)
    if (event === 'PostToolUse' && tool !== undefined && tool.id === id) {
      tool.post = { error: getString(payload, 'error'), extra }
    }
    drainTranscript(turn)
    settleTools(turn, extra, false)
    return turn
  }

  function accept(
    envelope: AntigravityHookEnvelope
  ): Promise<Reply | undefined> | Reply | undefined {
    if (
      closed ||
      envelope.invocationId !== ctx.invocationId ||
      envelope.runtimeId !== env['HARNESS_BROKER_RUNTIME_ID'] ||
      envelope.generation !== ANTIGRAVITY_HOOK_GENERATION ||
      envelope.callbackSocket !== options.callbackSocket ||
      !Number.isFinite(envelope.startedAt) ||
      !HOOKS.has(envelope.event)
    )
      return

    let turn: Turn | undefined
    let provenance: EventProvenance | undefined
    if (ctx.capture !== undefined) {
      ctx.capture.ingest(
        {
          provider: 'google',
          driverKind: ANTIGRAVITY_DRIVER_KIND,
          sourceKind: 'hook',
          sourceKey: options.callbackSocket,
          nativeType: envelope.event,
          rawBytes: Buffer.from(JSON.stringify(envelope)),
        },
        (captured: CapturedRecord) => {
          provenance = captured.provenance()
          turn = observeHook(envelope, provenance)
          return { disposition: 'normalized' }
        }
      )
    } else {
      turn = observeHook(envelope)
    }
    if (closed) return {}
    const { event, payload, startedAt } = envelope
    if (event === 'Stop') {
      return decideStop(payload, turn, startedAt, provenance)
    }
    if (event === 'PreInvocation' && turn !== undefined) {
      if (steer !== undefined && steer.handout === undefined) {
        steer.handout = {
          route: 'PreInvocation',
          turnId: turn.id,
          firstStep: Math.max(transcript.nextStep, getNumber(payload, 'initialNumSteps') ?? 0),
        }
        return { injectSteps: [{ userMessage: steer.text }] }
      }
      if (payload['invocationNum'] === 0) {
        return queryMailHintDecision({ hook_event_name: event }, env, 'PreInvocation').then(
          (hint) => (hint === undefined ? {} : { injectSteps: [{ ephemeralMessage: hint.hint }] })
        )
      }
    }
    return event === 'PreToolUse' ? { decision: 'allow' } : {}
  }

  async function decideStop(
    payload: Record<string, unknown>,
    turn: Turn | undefined,
    startedAt: number,
    provenance?: EventProvenance
  ): Promise<Reply> {
    const mail = await queryMailStopDecision(
      { ...payload, hook_event_name: 'Stop' },
      env,
      MAIL_STOP_QUERY_TIMEOUT_MS
    )
    if (closed || turn === undefined) return { decision: 'stop' }
    if (active !== turn) {
      if (
        turn.terminal === 'completed' &&
        turn.latestHook.event === 'Stop' &&
        turn.latestHook.startedAt === startedAt &&
        mail !== undefined
      ) {
        retainMissedMail(mail.reason)
      }
      return { decision: 'stop' }
    }
    if (turn.latestHook.event !== 'Stop' || turn.latestHook.startedAt !== startedAt) {
      return { decision: 'stop' }
    }
    if (steer !== undefined && steer.handout === undefined) {
      steer.handout = { route: 'Stop', turnId: turn.id, firstStep: transcript.nextStep }
      return { decision: 'continue', reason: steer.text }
    }
    if (mail !== undefined) {
      turn.mailContinuation = { text: mail.reason, firstStep: transcript.nextStep }
      return { decision: 'continue', reason: mail.reason }
    }
    endTurn(turn, 'completed', extraFor('Stop', turn, provenance))
    return { decision: 'stop' }
  }

  return {
    accept,
    get activeTurn() {
      return active?.id
    },
    prepareDelivery(text: string, inputId: InputId | undefined): TurnId {
      const turnId = nextTurnId()
      pendingDelivery = { text, inputId, turnId }
      return turnId
    },
    clearDelivery(turnId: TurnId): void {
      if (pendingDelivery?.turnId === turnId) pendingDelivery = undefined
    },
    holdSteer(text: string, inputId: InputId | undefined): Promise<void> {
      return new Promise((resolve, reject) => {
        steer = { text, inputId, resolve, reject }
      })
    },
    close(): void {
      closed = true
      missedMail.length = 0
      steer?.reject(
        withDeliveryEvidence(
          new Error('Antigravity invocation closed with a pending steer'),
          steer.handout === undefined ? 'not_written' : 'possibly_written'
        )
      )
      steer = undefined
    },
  }
}
