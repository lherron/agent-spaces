/**
 * Muse transcript model (T-08590, campaign P-00522).
 *
 * Projects the same harness-agnostic broker events the codex transcript
 * projects (user.message, turn lifecycle, assistant deltas, tool calls,
 * usage) with a muse-native minimal style: plain prefixed lines, assistant
 * deltas coalesced, tool output truncated. Satisfies the shared
 * RendererTranscriptModel contract so the durable-read projection
 * (bootstrap/live gap, seq dedup, redraw) is reused unchanged.
 */
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { RendererTranscriptModel } from '../codex-app-server/renderer'

export interface MuseTranscriptModelOptions {
  emit: (line: string) => void
  /** Echo every event's raw type alongside its render (debugging). */
  verbose?: boolean | undefined
}

const MAX_TEXT = 2000

function summarize(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value
  }
  try {
    const rendered = JSON.stringify(value)
    return rendered.length > MAX_TEXT ? `${rendered.slice(0, MAX_TEXT)}…` : rendered
  } catch {
    return String(value)
  }
}

export function createMuseTranscriptModel(
  options: MuseTranscriptModelOptions
): RendererTranscriptModel {
  const emit = options.emit
  const verbose = options.verbose ?? false
  const assistantBuffers = new Map<string, string>()
  const toolBuffers = new Map<string, { name: string; text: string }>()

  function out(line: string, type?: string): void {
    emit(verbose && type ? `[${type}] ${line}` : line)
  }

  function flushAssistant(messageId: string, content?: Array<{ text?: string }>): void {
    const buffered = assistantBuffers.get(messageId) ?? ''
    const completed = (content ?? []).map((part) => part.text ?? '').join('')
    const text = completed || buffered
    assistantBuffers.delete(messageId)
    if (text) out(`assistant: ${summarize(text)}`, 'assistant.message.completed')
  }

  return {
    apply(event: InvocationEventEnvelope): void {
      const payload = event.payload as Record<string, unknown>
      switch (event.type) {
        case 'user.message': {
          const content = typeof payload['content'] === 'string' ? payload['content'] : ''
          out(`you: ${summarize(content)}`, event.type)
          return
        }
        case 'turn.started': {
          out(`turn ${String(payload['turnId'] ?? '?')} started`, event.type)
          return
        }
        case 'turn.completed': {
          out(`turn ${String(payload['turnId'] ?? '?')} completed`, event.type)
          if (payload['usage'] !== undefined) {
            out(`usage: ${summarize(payload['usage'])}`, 'usage.updated')
          }
          return
        }
        case 'turn.failed': {
          const code = typeof payload['code'] === 'string' ? ` (${payload['code']})` : ''
          out(
            `turn ${String(payload['turnId'] ?? '?')} failed: ${summarize(payload['message'] ?? '')}${code}`,
            event.type
          )
          return
        }
        case 'turn.interrupted': {
          out(`turn ${String(payload['turnId'] ?? '?')} interrupted`, event.type)
          return
        }
        case 'assistant.message.delta': {
          const messageId = String(payload['messageId'] ?? '')
          const text = typeof payload['text'] === 'string' ? payload['text'] : ''
          assistantBuffers.set(messageId, (assistantBuffers.get(messageId) ?? '') + text)
          return
        }
        case 'assistant.message.completed': {
          const messageId = String(payload['messageId'] ?? '')
          const content = Array.isArray(payload['content'])
            ? (payload['content'] as Array<{ text?: string }>)
            : undefined
          flushAssistant(messageId, content)
          return
        }
        case 'assistant.message.started': {
          return
        }
        case 'tool.call.started': {
          const toolCallId = String(payload['toolCallId'] ?? '')
          const name = typeof payload['name'] === 'string' ? payload['name'] : 'tool'
          toolBuffers.set(toolCallId, { name, text: '' })
          out(`tool ${name} started`, event.type)
          return
        }
        case 'tool.call.delta': {
          const toolCallId = String(payload['toolCallId'] ?? '')
          const text = typeof payload['text'] === 'string' ? payload['text'] : ''
          const entry = toolBuffers.get(toolCallId) ?? { name: 'tool', text: '' }
          entry.text += text
          toolBuffers.set(toolCallId, entry)
          return
        }
        case 'tool.call.completed': {
          const toolCallId = String(payload['toolCallId'] ?? '')
          const entry = toolBuffers.get(toolCallId)
          toolBuffers.delete(toolCallId)
          const name =
            (typeof payload['name'] === 'string' ? payload['name'] : undefined) ??
            entry?.name ??
            'tool'
          const result =
            payload['result'] !== undefined ? summarize(payload['result']) : (entry?.text ?? '')
          out(`tool ${name} completed${result ? `: ${result}` : ''}`, event.type)
          return
        }
        case 'tool.call.failed': {
          const name = typeof payload['name'] === 'string' ? payload['name'] : 'tool'
          out(`tool ${name} failed: ${summarize(payload['message'] ?? '')}`, event.type)
          toolBuffers.delete(String(payload['toolCallId'] ?? ''))
          return
        }
        case 'usage.updated': {
          out(`usage: ${summarize(payload['usage'])}`, event.type)
          return
        }
        case 'diagnostic': {
          const level = typeof payload['level'] === 'string' ? payload['level'] : 'info'
          out(`[${level}] ${summarize(payload['message'] ?? '')}`, event.type)
          return
        }
        case 'permission.requested': {
          out(
            `permission ${summarize(payload['kind'] ?? 'tool')} requested (default ${summarize(payload['defaultDecision'] ?? '')})`,
            event.type
          )
          return
        }
        case 'permission.resolved': {
          out(
            `permission ${summarize(payload['permissionRequestId'] ?? '')}: ${summarize(payload['decision'] ?? '')}`,
            event.type
          )
          return
        }
        case 'continuation.updated': {
          out(`session: ${summarize(payload['key'] ?? '')}`, event.type)
          return
        }
        case 'invocation.started':
        case 'invocation.ready':
        case 'invocation.exited':
        case 'invocation.failed': {
          out(
            `${event.type}: ${summarize(payload['state'] ?? payload['command'] ?? '')}`,
            event.type
          )
          return
        }
        default: {
          if (verbose) out(summarize(payload), event.type)
        }
      }
    },
    readFailure(text: string): void {
      out(`read failed: ${text}`)
    },
  }
}
