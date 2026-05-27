import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import type {
  InvocationEventEnvelope,
  InvocationId,
  MessageId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { createInvocationEventSequencer } from '../../events'
import { CODEX_CLI_TMUX_DRIVER_KIND } from './hook-events'

export type CodexTranscriptTailer = {
  start: (transcriptPath: string) => void
  stop: () => void
}

export type CodexTranscriptTailerOptions = {
  emit: (event: InvocationEventEnvelope) => void
  now: () => Date
  invocationId: string
  getCurrentTurnId: () => string | undefined
}

type HeldAgentMessage = {
  messageId: MessageId
  content: string
}

const POLL_INTERVAL_MS = 25

export function createCodexTranscriptTailer(
  options: CodexTranscriptTailerOptions
): CodexTranscriptTailer {
  const invocationId = options.invocationId as InvocationId
  const sequencer = createInvocationEventSequencer({ now: options.now })
  const buffer = Buffer.alloc(64 * 1024)

  let activePath: string | undefined
  let offset = 0
  let partial = ''
  let held: HeldAgentMessage | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let messageCounter = 0
  let polling = false

  const emitHeld = (final: boolean): void => {
    if (held === undefined) return
    const turnId = options.getCurrentTurnId()
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
          driver: { kind: CODEX_CLI_TMUX_DRIVER_KIND, rawType: 'agent_message' },
        }
      )
    )
    held = undefined
  }

  const nextMessageId = (
    entry: Record<string, unknown>,
    payload: Record<string, unknown>
  ): MessageId => {
    const id =
      getString(payload, 'id') ??
      getString(payload, 'message_id') ??
      getString(payload, 'item_id') ??
      getString(entry, 'id') ??
      getString(entry, 'message_id') ??
      getString(entry, 'item_id')
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

    if (entry['type'] !== 'event_msg') return
    const payloadValue = entry['payload']
    if (payloadValue === null || typeof payloadValue !== 'object' || Array.isArray(payloadValue)) {
      return
    }
    const payload = payloadValue as Record<string, unknown>
    const payloadType = getString(payload, 'type')

    if (payloadType === 'agent_message') {
      const message = getString(payload, 'message')
      if (message === undefined) return
      emitHeld(false)
      held = {
        messageId: nextMessageId(entry, payload),
        content: message,
      }
      return
    }

    if (payloadType === 'task_complete') {
      emitHeld(true)
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

  return {
    start(transcriptPath: string): void {
      if (activePath === transcriptPath && timer !== undefined) return
      if (timer !== undefined) {
        clearInterval(timer)
      }
      activePath = transcriptPath
      offset = 0
      partial = ''
      held = undefined
      timer = setInterval(poll, POLL_INTERVAL_MS)
      poll()
    },

    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
      activePath = undefined
      offset = 0
      partial = ''
      held = undefined
      polling = false
    },
  }
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}
