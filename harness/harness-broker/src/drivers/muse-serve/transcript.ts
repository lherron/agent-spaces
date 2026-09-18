/**
 * Muse transcript model (T-08590, campaign P-00522).
 *
 * Projects the same harness-agnostic broker events the codex transcript
 * projects (user.message, turn lifecycle, assistant deltas, tool calls,
 * usage) with muse-native content and the shared forge-lanes render language:
 * the band/keyline/ANSI primitives come from
 * codex-app-server/transcript (`createCodexStyler`), so a muse pane reads
 * like a codex pane — iris user lane, molten turn divider, kiln tool lane,
 * red failure lane, dim chrome. Styling is opt-in via `color` (the renderer
 * entry enables it on a TTY exactly like the codex entry); with `color`
 * unset the model emits the historical plain prefixed lines byte-for-byte.
 *
 * Consecutive duplicate assistant texts without an intervening turn.started
 * are folded out: muse natively re-emits an agent message item (a new item id
 * with identical text, observed live when a steered duplicate landed), and
 * the pane should not print the same prose twice.
 */
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { RendererTranscriptModel } from '../codex-app-server/renderer'
import {
  type CodexSeg,
  type CodexTranscriptWidth,
  createCodexStyler,
} from '../codex-app-server/transcript'

export interface MuseTranscriptModelOptions {
  emit: (line: string) => void
  /** Echo every event's raw type alongside its render (debugging). */
  verbose?: boolean | undefined
  /**
   * Render with the forge-lanes ANSI language (default false, preserving the
   * historical plain lines). The renderer entry sets this from NO_COLOR/TTY.
   */
  color?: boolean | undefined
  /** Pane width thunk for band clipping. */
  width?: CodexTranscriptWidth | undefined
}

const MAX_TEXT = 2000
const MAX_FIRST_LINE = 160

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

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > MAX_FIRST_LINE ? `${line.slice(0, MAX_FIRST_LINE)}…` : line
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

export function createMuseTranscriptModel(
  options: MuseTranscriptModelOptions
): RendererTranscriptModel {
  const emit = options.emit
  const verbose = options.verbose ?? false
  const color = options.color ?? false
  const { band, line, dimLine } = createCodexStyler(color, options.width)
  const assistantBuffers = new Map<string, string>()
  const toolBuffers = new Map<string, { name: string; text: string }>()
  let lastAssistantText: string | undefined

  function out(lineText: string, type?: string): void {
    emit(verbose && type ? `[${type}] ${lineText}` : lineText)
  }

  function styled(segs: CodexSeg[]): string {
    return line(segs)
  }

  function flushAssistant(messageId: string, content?: Array<{ text?: string }>): void {
    const buffered = assistantBuffers.get(messageId) ?? ''
    const completed = (content ?? []).map((part) => part.text ?? '').join('')
    const text = completed || buffered
    assistantBuffers.delete(messageId)
    if (!text) return
    if (text === lastAssistantText) return
    lastAssistantText = text
    if (!color) {
      out(`assistant: ${summarize(text)}`, 'assistant.message.completed')
      return
    }
    for (const body of summarize(text).split('\n')) {
      out(styled([{ text: body, fg: 'text' }]), 'assistant.message.completed')
    }
  }

  function renderUserMessage(payload: Record<string, unknown>, type: string): void {
    const content = typeof payload['content'] === 'string' ? payload['content'] : ''
    if (!color) {
      out(`you: ${summarize(content)}`, type)
      return
    }
    const body = summarize(content).trim()
    if (body.length === 0) return
    out('', type)
    body
      .split('\n')
      .slice(0, 40)
      .forEach((row, idx) => {
        out(
          band('prompt', 'iris', [
            { text: idx === 0 ? '❯ ' : '  ', fg: 'iris', bold: idx === 0 },
            { text: row, fg: 'text' },
          ]),
          type
        )
      })
    out('', type)
  }

  function renderTurnStarted(payload: Record<string, unknown>, type: string): void {
    const turnId = String(payload['turnId'] ?? '?')
    lastAssistantText = undefined
    if (!color) {
      out(`turn ${turnId} started`, type)
      return
    }
    out('', type)
    out(
      styled([
        { text: '▶ ', fg: 'molten', bold: true },
        { text: 'turn', fg: 'text', bold: true },
        { text: ` ${shortId(turnId)}`, fg: 'dim' },
      ]),
      type
    )
  }

  function renderTurnCompleted(payload: Record<string, unknown>, type: string): void {
    const turnId = String(payload['turnId'] ?? '?')
    if (!color) {
      out(`turn ${turnId} completed`, type)
      if (payload['usage'] !== undefined) {
        out(`usage: ${summarize(payload['usage'])}`, 'usage.updated')
      }
      return
    }
    const usage = payload['usage'] as { inputTokens?: unknown; outputTokens?: unknown } | undefined
    const stats =
      usage !== undefined &&
      typeof usage.inputTokens === 'number' &&
      typeof usage.outputTokens === 'number'
        ? ` · ${usage.inputTokens + usage.outputTokens} tok`
        : ''
    out('', type)
    out(
      band('endturn', 'kiln', [
        { text: '✓ ', fg: 'kiln', bold: true },
        { text: 'done', fg: 'text', bold: true },
        ...(stats.length > 0 ? [{ text: stats, fg: 'dim' as const }] : []),
      ]),
      type
    )
    if (payload['usage'] !== undefined) {
      out(dimLine(`usage: ${summarize(payload['usage'])}`), 'usage.updated')
    }
  }

  function renderTurnFailed(payload: Record<string, unknown>, type: string): void {
    const code = typeof payload['code'] === 'string' ? ` (${payload['code']})` : ''
    const message = `turn ${String(payload['turnId'] ?? '?')} failed: ${summarize(payload['message'] ?? '')}${code}`
    if (!color) {
      out(message, type)
      return
    }
    out('', type)
    out(
      band('error', 'red', [
        { text: '✗ ', fg: 'red', bold: true },
        { text: 'failed', fg: 'red', bold: true },
        { text: `  ${firstLine(summarize(payload['message'] ?? ''))}${code}`, fg: 'red' },
      ]),
      type
    )
  }

  function renderTurnInterrupted(payload: Record<string, unknown>, type: string): void {
    const message = `turn ${String(payload['turnId'] ?? '?')} interrupted`
    out(!color ? message : line([{ text: '◼ interrupted', fg: 'brass' }]), type)
  }

  function renderAssistantDelta(payload: Record<string, unknown>): void {
    const messageId = String(payload['messageId'] ?? '')
    const text = typeof payload['text'] === 'string' ? payload['text'] : ''
    assistantBuffers.set(messageId, (assistantBuffers.get(messageId) ?? '') + text)
  }

  function renderAssistantCompleted(payload: Record<string, unknown>): void {
    const messageId = String(payload['messageId'] ?? '')
    const content = Array.isArray(payload['content'])
      ? (payload['content'] as Array<{ text?: string }>)
      : undefined
    flushAssistant(messageId, content)
  }

  function toolInputSummary(input: unknown): string {
    if (typeof input === 'string') return firstLine(input)
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      const record = input as Record<string, unknown>
      for (const key of ['command', 'cmd', 'commandLine']) {
        const value = record[key]
        if (typeof value === 'string' && value.length > 0) return firstLine(value)
      }
      return firstLine(summarize(input))
    }
    return ''
  }

  function renderToolStarted(payload: Record<string, unknown>, type: string): void {
    const toolCallId = String(payload['toolCallId'] ?? '')
    const name = typeof payload['name'] === 'string' ? payload['name'] : 'tool'
    toolBuffers.set(toolCallId, { name, text: '' })
    const summary = toolInputSummary(payload['input'])
    if (!color) {
      out(`tool ${name} started${summary ? `: ${summary}` : ''}`, type)
      return
    }
    out(
      band('tool', 'kiln', [
        { text: `$ ${name}`, fg: 'kiln', bold: true },
        ...(summary.length > 0 ? [{ text: ` · ${summary}`, fg: 'muted' as const }] : []),
      ]),
      type
    )
  }

  function renderToolDelta(payload: Record<string, unknown>): void {
    const toolCallId = String(payload['toolCallId'] ?? '')
    const text = typeof payload['text'] === 'string' ? payload['text'] : ''
    const entry = toolBuffers.get(toolCallId) ?? { name: 'tool', text: '' }
    entry.text += text
    toolBuffers.set(toolCallId, entry)
  }

  function renderToolCompleted(payload: Record<string, unknown>, type: string): void {
    const toolCallId = String(payload['toolCallId'] ?? '')
    const entry = toolBuffers.get(toolCallId)
    toolBuffers.delete(toolCallId)
    const name =
      (typeof payload['name'] === 'string' ? payload['name'] : undefined) ?? entry?.name ?? 'tool'
    const result =
      payload['result'] !== undefined ? summarize(payload['result']) : (entry?.text ?? '')
    if (!color) {
      out(`tool ${name} completed${result ? `: ${result}` : ''}`, type)
      return
    }
    const preview = firstLine(result)
    out(
      band('tool', 'kiln', [
        { text: `$ ${name}`, fg: 'kiln', bold: true },
        ...(preview.length > 0 ? [{ text: ` · ${preview}`, fg: 'muted' as const }] : []),
      ]),
      type
    )
  }

  function renderToolFailed(payload: Record<string, unknown>, type: string): void {
    const name = typeof payload['name'] === 'string' ? payload['name'] : 'tool'
    const message = `tool ${name} failed: ${summarize(payload['message'] ?? '')}`
    toolBuffers.delete(String(payload['toolCallId'] ?? ''))
    if (!color) {
      out(message, type)
      return
    }
    out(
      band('error', 'red', [
        { text: '✗ ', fg: 'red', bold: true },
        { text: `${name} failed`, fg: 'red', bold: true },
        { text: `  ${firstLine(summarize(payload['message'] ?? ''))}`, fg: 'red' },
      ]),
      type
    )
  }

  function renderChrome(body: string, type: string): void {
    out(!color ? body : dimLine(body), type)
  }

  function renderDiagnostic(payload: Record<string, unknown>, type: string): void {
    const level = typeof payload['level'] === 'string' ? payload['level'] : 'info'
    // Debug telemetry (usage counters and the like) already has a rendered
    // form elsewhere; keep it off the pane unless explicitly debugging.
    if (level === 'debug' && !verbose) return
    const body = `[${level}] ${summarize(payload['message'] ?? '')}`
    if (!color) {
      out(body, type)
      return
    }
    if (level === 'error' || level === 'warn') {
      const accent = level === 'error' ? 'red' : 'brass'
      out(band('error', accent, [{ text: body, fg: accent }]), type)
      return
    }
    out(dimLine(body), type)
  }

  return {
    apply(event: InvocationEventEnvelope): void {
      const payload = event.payload as Record<string, unknown>
      switch (event.type) {
        case 'user.message':
          renderUserMessage(payload, event.type)
          return
        case 'turn.started':
          renderTurnStarted(payload, event.type)
          return
        case 'turn.completed':
          renderTurnCompleted(payload, event.type)
          return
        case 'turn.failed':
          renderTurnFailed(payload, event.type)
          return
        case 'turn.interrupted':
          renderTurnInterrupted(payload, event.type)
          return
        case 'assistant.message.delta':
          renderAssistantDelta(payload)
          return
        case 'assistant.message.completed':
          renderAssistantCompleted(payload)
          return
        case 'assistant.message.started':
          return
        case 'tool.call.started':
          renderToolStarted(payload, event.type)
          return
        case 'tool.call.delta':
          renderToolDelta(payload)
          return
        case 'tool.call.completed':
          renderToolCompleted(payload, event.type)
          return
        case 'tool.call.failed':
          renderToolFailed(payload, event.type)
          return
        case 'usage.updated':
          // Per-chunk usage payloads are telemetry, not transcript: keep them
          // off the pane unless explicitly debugging (matches debug
          // diagnostics). The endturn band keeps the compact token count.
          if (!verbose) return
          renderChrome(`usage: ${summarize(payload['usage'])}`, event.type)
          return
        case 'diagnostic':
          renderDiagnostic(payload, event.type)
          return
        case 'permission.requested':
          renderChrome(
            `permission ${summarize(payload['kind'] ?? 'tool')} requested (default ${summarize(payload['defaultDecision'] ?? '')})`,
            event.type
          )
          return
        case 'permission.resolved':
          renderChrome(
            `permission ${summarize(payload['permissionRequestId'] ?? '')}: ${summarize(payload['decision'] ?? '')}`,
            event.type
          )
          return
        case 'continuation.updated':
          renderChrome(`session: ${summarize(payload['key'] ?? '')}`, event.type)
          return
        case 'invocation.started':
        case 'invocation.ready':
        case 'invocation.exited':
        case 'invocation.failed':
          renderChrome(
            `${event.type}: ${summarize(payload['state'] ?? payload['command'] ?? '')}`,
            event.type
          )
          return
        default: {
          if (verbose) out(summarize(payload), event.type)
        }
      }
    },
    readFailure(text: string): void {
      const body = `read failed: ${text}`
      if (!color) {
        out(body)
        return
      }
      out(band('error', 'red', [{ text: body, fg: 'red', bold: true }]))
    },
  }
}
