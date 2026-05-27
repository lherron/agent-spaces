import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import type {
  InvocationEventEnvelope,
  InvocationId,
  MessageId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { createInvocationEventSequencer } from '../../events'
import { CLAUDE_CODE_TMUX_DRIVER_KIND } from './hook-events'

export type ClaudeTranscriptTailer = {
  start: (transcriptPath: string) => void
  handleHook: (hook: Record<string, unknown>) => void
  flushTerminal: () => void
  stop: () => void
}

export type ClaudeTranscriptTailerOptions = {
  emit: (event: InvocationEventEnvelope) => void
  now: () => Date
  invocationId: string
  getCurrentTurnId: () => string | undefined
}

type HeldAssistantMessage = {
  messageId: MessageId
  content: string
  turnId?: TurnId | undefined
  synthetic?: boolean | undefined
}

const POLL_INTERVAL_MS = 25

export function createClaudeTranscriptTailer(
  options: ClaudeTranscriptTailerOptions
): ClaudeTranscriptTailer {
  const invocationId = options.invocationId as InvocationId
  const sequencer = createInvocationEventSequencer({ now: options.now })
  const buffer = Buffer.alloc(64 * 1024)

  let activePath: string | undefined
  let offset = 0
  let partial = ''
  let held: HeldAssistantMessage | undefined
  let transcriptTurnId: string | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let messageCounter = 0
  let polling = false

  const emitHeld = (final: boolean): void => {
    if (held === undefined) return
    if (final && held.synthetic === true) {
      held = undefined
      return
    }
    const turnId = held.turnId ?? options.getCurrentTurnId()
    options.emit(
      sequencer.next(
        invocationId,
        'assistant.message.completed',
        {
          messageId: held.messageId,
          content: [{ type: 'text' as const, text: held.content }],
          final,
        },
        {
          ...(turnId !== undefined ? { turnId: turnId as TurnId } : {}),
          itemId: held.messageId,
          driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'assistant' },
        }
      )
    )
    held = undefined
  }

  const nextMessageId = (
    entry: Record<string, unknown>,
    message: Record<string, unknown>
  ): MessageId => {
    const id =
      getString(message, 'id') ??
      getString(message, 'uuid') ??
      getString(message, 'message_id') ??
      getString(entry, 'uuid') ??
      getString(entry, 'id') ??
      getString(entry, 'message_id')
    if (id !== undefined) return id as MessageId

    messageCounter += 1
    return `msg_${options.invocationId}_${messageCounter}` as MessageId
  }

  const processLine = (line: string): void => {
    if (line.trim().length === 0) return
    let entry: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      entry = parsed as Record<string, unknown>
    } catch {
      return
    }

    if (entry['type'] === 'user') {
      transcriptTurnId = options.getCurrentTurnId()
      return
    }

    if (entry['type'] !== 'assistant') return
    const messageValue = entry['message']
    if (messageValue === null || typeof messageValue !== 'object' || Array.isArray(messageValue)) {
      return
    }
    const message = messageValue as Record<string, unknown>
    if (message['role'] !== 'assistant') return

    const text = extractText(message['content'])
    if (text === undefined) {
      emitHeld(false)
      // Claude records tool requests as assistant-role transcript entries. Keep
      // them as non-terminal boundaries, but never as the terminal answer.
      if (transcriptTurnId !== undefined && hasToolUseContent(message['content'])) {
        held = {
          messageId: nextMessageId(entry, message),
          content: '',
          turnId: transcriptTurnId as TurnId,
          synthetic: true,
        }
      }
      return
    }

    emitHeld(false)
    held = {
      messageId: nextMessageId(entry, message),
      content: text,
      ...(transcriptTurnId !== undefined ? { turnId: transcriptTurnId as TurnId } : {}),
    }
  }

  const poll = (): void => {
    if (polling || activePath === undefined) return
    polling = true
    try {
      if (!existsSync(activePath)) return
      const stats = statSync(activePath)
      if (!stats.isFile()) return
      if (stats.size < offset) {
        offset = 0
        partial = ''
        transcriptTurnId = undefined
      }
      if (stats.size === offset) return

      const fd = openSync(activePath, 'r')
      try {
        while (offset < stats.size) {
          const bytesToRead = Math.min(buffer.length, stats.size - offset)
          const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset)
          if (bytesRead <= 0) break
          offset += bytesRead
          partial += buffer.subarray(0, bytesRead).toString('utf8')

          let newlineIndex = partial.indexOf('\n')
          while (newlineIndex >= 0) {
            const line = partial.slice(0, newlineIndex)
            partial = partial.slice(newlineIndex + 1)
            processLine(line)
            newlineIndex = partial.indexOf('\n')
          }
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      return
    } finally {
      polling = false
    }
  }

  const start = (transcriptPath: string): void => {
    if (activePath === transcriptPath && timer !== undefined) return
    if (timer !== undefined) {
      clearInterval(timer)
    }
    activePath = transcriptPath
    offset = 0
    partial = ''
    held = undefined
    transcriptTurnId = undefined
    timer = setInterval(poll, POLL_INTERVAL_MS)
    poll()
  }

  const flushTerminal = (): void => {
    poll()
    emitHeld(true)
  }

  return {
    start,
    handleHook(hook: Record<string, unknown>): void {
      const unwrapped = unwrapHookPayload(hook)
      const hookEventName = getString(unwrapped, 'hook_event_name')
      if (hookEventName === 'SessionStart') {
        const transcriptPath = getString(unwrapped, 'transcript_path')
        if (transcriptPath !== undefined && transcriptPath.length > 0) {
          start(transcriptPath)
        }
        return
      }
      if (
        hookEventName === 'Stop' ||
        hookEventName === 'SessionEnd' ||
        hookEventName === 'SubagentStop'
      ) {
        flushTerminal()
      }
    },

    flushTerminal,

    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
      activePath = undefined
      offset = 0
      partial = ''
      held = undefined
      transcriptTurnId = undefined
      polling = false
    },
  }
}

function unwrapHookPayload(hook: Record<string, unknown>): Record<string, unknown> {
  if (typeof hook['hook_event_name'] === 'string') return hook

  const hookEvent = hook['hookEvent']
  if (hookEvent !== null && typeof hookEvent === 'object' && !Array.isArray(hookEvent)) {
    const inner = hookEvent as Record<string, unknown>
    if (typeof inner['hook_event_name'] === 'string') return inner
  }

  return hook
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.length > 0 ? content : undefined
  if (!Array.isArray(content)) return undefined

  const text = content
    .map((part) => {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) return ''
      const record = part as Record<string, unknown>
      return record['type'] === 'text' && typeof record['text'] === 'string' ? record['text'] : ''
    })
    .filter((segment) => segment.length > 0)
    .join('')

  return text.length > 0 ? text : undefined
}

function hasToolUseContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((part) => {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) return false
      return (part as Record<string, unknown>)['type'] === 'tool_use'
    })
  )
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}
