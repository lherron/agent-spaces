import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { DriverContext } from 'spaces-harness-broker'
import type { InputId, MessageId, ToolCallId, TurnId } from 'spaces-harness-broker-protocol'

export type PiSdkSettlementAction = 'retry' | 'terminal'

interface PendingAssistantMessage {
  messageId: MessageId
  content: string
}

export interface PiSdkTurnEventMapperOptions {
  ctx: DriverContext
  provider: string
  sessionFile: () => string | undefined
}

/**
 * Maps one pi agent lifecycle to one broker turn. Pi's turn_start/turn_end are
 * model-round boundaries, so they are intentionally ignored as broker turn
 * boundaries; only agent_settled can terminate the broker turn.
 */
export class PiSdkTurnEventMapper {
  readonly #ctx: DriverContext
  readonly #provider: string
  readonly #sessionFile: () => string | undefined

  #turnId: TurnId | undefined
  #inputId: InputId | undefined
  #messageCounter = 0
  #activeMessageId: MessageId | undefined
  #assistantBuffer = ''
  #pendingAssistant: PendingAssistantMessage | undefined
  #lastAssistantText: string | undefined
  #toolActivity = false
  readonly #openTools = new Map<ToolCallId, string>()
  #structured = false
  #structuredAttempt = 0
  #structuredResult: string | undefined
  #structuredMiss: string | undefined
  #settlementAction: PiSdkSettlementAction | undefined
  #terminal = false
  #requestedTerminal:
    | { kind: 'interrupted'; reason: string }
    | { kind: 'failed'; code: string; message: string }
    | undefined
  #assistantFailure: string | undefined

  constructor(options: PiSdkTurnEventMapperOptions) {
    this.#ctx = options.ctx
    this.#provider = options.provider
    this.#sessionFile = options.sessionFile
  }

  beginTurn(options: {
    turnId: TurnId
    inputId?: InputId | undefined
    structured: boolean
  }): void {
    if (this.#turnId !== undefined && !this.#terminal) {
      throw new Error('Cannot begin a pi SDK turn while another turn is active')
    }
    this.#turnId = options.turnId
    this.#inputId = options.inputId
    this.#messageCounter = 0
    this.#activeMessageId = undefined
    this.#assistantBuffer = ''
    this.#pendingAssistant = undefined
    this.#lastAssistantText = undefined
    this.#toolActivity = false
    this.#openTools.clear()
    this.#structured = options.structured
    this.#structuredAttempt = 0
    this.#structuredResult = undefined
    this.#structuredMiss = undefined
    this.#settlementAction = undefined
    this.#terminal = false
    this.#requestedTerminal = undefined
    this.#assistantFailure = undefined
  }

  beginStructuredRetry(): void {
    this.#requireTurnId()
    this.#settlementAction = undefined
    this.#activeMessageId = undefined
    this.#assistantBuffer = ''
    this.#pendingAssistant = undefined
    this.#structuredResult = undefined
    this.#structuredMiss = undefined
    this.#assistantFailure = undefined
  }

  recordStructuredResult(canonicalJson: string): void {
    this.#structuredResult = canonicalJson
    this.#structuredMiss = undefined
  }

  recordStructuredMiss(message: string): void {
    this.#structuredResult = undefined
    this.#structuredMiss = message
  }

  requestInterruption(reason = 'operator-interrupt'): void {
    if (this.#turnId !== undefined && !this.#terminal) {
      this.#requestedTerminal = { kind: 'interrupted', reason }
    }
  }

  requestFailure(code: string, message: string): void {
    if (this.#turnId !== undefined && !this.#terminal) {
      this.#requestedTerminal = { kind: 'failed', code, message }
    }
  }

  consumeSettlementAction(): PiSdkSettlementAction | undefined {
    const action = this.#settlementAction
    this.#settlementAction = undefined
    return action
  }

  get activeTurnId(): TurnId | undefined {
    return this.#turnId !== undefined && !this.#terminal ? this.#turnId : undefined
  }

  get isTerminal(): boolean {
    return this.#terminal
  }

  handle(event: AgentSessionEvent): void {
    if (this.#turnId === undefined || this.#terminal) return

    switch (event.type) {
      case 'agent_start':
      case 'agent_end':
      case 'turn_start':
      case 'turn_end':
        // These are pi lifecycle/model-round boundaries, not broker terminals.
        return
      case 'message_start': {
        if (event.message.role !== 'assistant') return
        this.#flushPendingAssistant(false)
        this.#messageCounter += 1
        this.#activeMessageId = `${this.#turnId}_message_${this.#messageCounter}` as MessageId
        this.#assistantBuffer = ''
        this.#ctx.emit(
          'assistant.message.started',
          { messageId: this.#activeMessageId },
          this.#extra()
        )
        return
      }
      case 'message_update': {
        if (event.assistantMessageEvent.type !== 'text_delta') return
        const text = event.assistantMessageEvent.delta
        if (text.length === 0) return
        const messageId = this.#ensureMessageId()
        this.#assistantBuffer += text
        this.#ctx.emit('assistant.message.delta', { messageId, text }, this.#extra())
        return
      }
      case 'message_end': {
        if (event.message.role !== 'assistant') return
        const messageId = this.#ensureMessageId()
        const content = assistantText(event.message.content) || this.#assistantBuffer
        this.#pendingAssistant = { messageId, content }
        this.#lastAssistantText = content
        this.#assistantBuffer = ''
        this.#activeMessageId = undefined
        this.#ctx.emit('usage.updated', { usage: event.message.usage }, this.#extra())
        if (event.message.stopReason === 'error') {
          this.#assistantFailure = event.message.errorMessage ?? 'pi model turn failed'
        }
        return
      }
      case 'tool_execution_start': {
        this.#flushPendingAssistant(false)
        this.#toolActivity = true
        this.#openTools.set(event.toolCallId as ToolCallId, event.toolName)
        this.#ctx.emit(
          'tool.call.started',
          {
            toolCallId: event.toolCallId as ToolCallId,
            name: event.toolName,
            input: event.args,
          },
          this.#extra({ itemId: event.toolCallId })
        )
        return
      }
      case 'tool_execution_update': {
        this.#ctx.emit(
          'tool.call.delta',
          {
            toolCallId: event.toolCallId as ToolCallId,
            data: event.partialResult,
          },
          this.#extra({ itemId: event.toolCallId })
        )
        return
      }
      case 'tool_execution_end': {
        this.#toolActivity = true
        this.#openTools.delete(event.toolCallId as ToolCallId)
        this.#ctx.emit(
          'tool.call.completed',
          {
            toolCallId: event.toolCallId as ToolCallId,
            name: event.toolName,
            result: event.result,
            isError: event.isError,
          },
          this.#extra({ itemId: event.toolCallId })
        )
        return
      }
      case 'agent_settled':
        this.#settle()
        return
      default:
        return
    }
  }

  /** Fallback for a session implementation that rejects without agent_settled. */
  settleRequestedTerminal(): void {
    if (this.#turnId !== undefined && !this.#terminal && this.#requestedTerminal !== undefined) {
      this.#settleRequestedTerminal()
    }
  }

  #settle(): void {
    if (this.#requestedTerminal !== undefined) {
      this.#settleRequestedTerminal()
      return
    }

    if (this.#assistantFailure !== undefined) {
      this.#flushPendingAssistant(true)
      this.#failOpenTools('pi_tool_infrastructure_failure', this.#assistantFailure)
      this.#emitFailed('turn_failed', this.#assistantFailure)
      return
    }

    if (this.#structured) {
      this.#flushPendingAssistant(false)
      if (this.#structuredResult !== undefined) {
        const messageId = `${this.#turnId}_structured_final` as MessageId
        this.#ctx.emit(
          'assistant.message.started',
          { messageId },
          this.#extra({ itemId: messageId })
        )
        this.#ctx.emit(
          'assistant.message.completed',
          { messageId, content: [{ type: 'text', text: this.#structuredResult }], final: true },
          this.#extra({ itemId: messageId })
        )
        this.#emitCompleted(this.#structuredResult)
        return
      }

      const miss = this.#structuredMiss ?? 'respond_structured was not called'
      if (this.#structuredAttempt === 0) {
        this.#structuredAttempt = 1
        this.#ctx.emit(
          'diagnostic',
          {
            level: 'warn',
            source: 'driver',
            kind: 'structured_output_retry',
            message: `Structured output miss; retrying once: ${miss}`,
          },
          this.#extra()
        )
        this.#settlementAction = 'retry'
        return
      }

      this.#ctx.emit(
        'diagnostic',
        {
          level: 'error',
          source: 'driver',
          kind: 'structured_output_unsatisfied',
          message: `Structured output unsatisfied after retry: ${miss}`,
        },
        this.#extra()
      )
      this.#emitFailed(
        'structured_output_unsatisfied',
        `Structured output unsatisfied after retry: ${miss}`
      )
      return
    }

    this.#flushPendingAssistant(true)
    this.#emitCompleted(this.#lastAssistantText)
  }

  #settleRequestedTerminal(): void {
    const terminal = this.#requestedTerminal
    if (terminal === undefined) return
    this.#flushPendingAssistant(true)
    if (terminal.kind === 'interrupted') {
      const turnId = this.#requireTurnId()
      this.#failOpenTools('tool_interrupted', terminal.reason)
      this.#ctx.emit(
        'turn.interrupted',
        {
          turnId,
          status: 'interrupted',
          reason: terminal.reason,
          ...(this.#lastAssistantText !== undefined
            ? { finalOutput: this.#lastAssistantText }
            : {}),
        },
        this.#extra()
      )
      this.#finishTerminal()
      return
    }
    this.#failOpenTools(terminal.code, terminal.message)
    this.#emitFailed(terminal.code, terminal.message)
  }

  #emitCompleted(finalOutput: string | undefined): void {
    const turnId = this.#requireTurnId()
    this.#ctx.emit(
      'turn.completed',
      {
        turnId,
        status: 'completed',
        producedContent: Boolean(finalOutput) || this.#toolActivity,
        ...(finalOutput !== undefined ? { finalOutput } : {}),
      },
      this.#extra()
    )
    const sessionFile = this.#sessionFile()
    if (sessionFile !== undefined) {
      this.#ctx.emit('continuation.updated', {
        provider: this.#provider,
        key: sessionFile,
        kind: 'session',
      })
    }
    this.#finishTerminal()
  }

  #emitFailed(code: string, message: string): void {
    const turnId = this.#requireTurnId()
    this.#ctx.emit(
      'turn.failed',
      {
        turnId,
        status: 'failed',
        code,
        message,
        ...(this.#lastAssistantText !== undefined ? { finalOutput: this.#lastAssistantText } : {}),
      },
      this.#extra()
    )
    this.#finishTerminal()
  }

  #finishTerminal(): void {
    this.#terminal = true
    this.#settlementAction = 'terminal'
    this.#requestedTerminal = undefined
  }

  #failOpenTools(code: string, message: string): void {
    for (const [toolCallId, name] of this.#openTools) {
      this.#ctx.emit(
        'tool.call.failed',
        { toolCallId, name, code, message },
        this.#extra({ itemId: toolCallId })
      )
    }
    this.#openTools.clear()
  }

  #flushPendingAssistant(final: boolean): void {
    const pending = this.#pendingAssistant
    if (pending === undefined) return
    this.#ctx.emit(
      'assistant.message.completed',
      {
        messageId: pending.messageId,
        content: [{ type: 'text', text: pending.content }],
        final,
      },
      this.#extra({ itemId: pending.messageId })
    )
    this.#pendingAssistant = undefined
  }

  #ensureMessageId(): MessageId {
    if (this.#activeMessageId !== undefined) return this.#activeMessageId
    this.#messageCounter += 1
    this.#activeMessageId = `${this.#requireTurnId()}_message_${this.#messageCounter}` as MessageId
    this.#ctx.emit(
      'assistant.message.started',
      { messageId: this.#activeMessageId },
      this.#extra({ itemId: this.#activeMessageId })
    )
    return this.#activeMessageId
  }

  #requireTurnId(): TurnId {
    if (this.#turnId === undefined) throw new Error('No active pi SDK turn')
    return this.#turnId
  }

  #extra(extra: { itemId?: string | undefined } = {}): {
    turnId: TurnId
    inputId?: InputId | undefined
    itemId?: string | undefined
    driver: { kind: string; rawType?: string | undefined }
  } {
    return {
      turnId: this.#requireTurnId(),
      ...(this.#inputId !== undefined ? { inputId: this.#inputId } : {}),
      ...(extra.itemId !== undefined ? { itemId: extra.itemId } : {}),
      driver: { kind: 'pi-sdk' },
    }
  }
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
    )
    .map((part) => part.text)
    .join('')
}
