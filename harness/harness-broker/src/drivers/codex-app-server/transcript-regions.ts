/** Multi-row transcript regions: prose, user input, plan, reasoning, diff, diagnostics. */
import type { CodexFg, CodexStyler } from './pane-style'
import { asRecord, clip, str, wrap } from './pane-text'

const MAX_INPUT_LINES = 40
const MAX_PLAN_STEPS = 12

interface PlanMark {
  glyph: string
  fg: CodexFg
  dim: boolean
}

const PENDING_MARK: PlanMark = { glyph: '☐', fg: 'dim', dim: false }

const PLAN_GLYPH: Record<string, PlanMark> = {
  completed: { glyph: '☑', fg: 'kiln', dim: true },
  inProgress: { glyph: '▸', fg: 'brass', dim: false },
  in_progress: { glyph: '▸', fg: 'brass', dim: false },
  pending: PENDING_MARK,
}

/**
 * A bounded, labeled `data={…}` preview of a diagnostic `payload.data` (T-05219).
 * Unknown Codex notifications carry their native params here; this surfaces them
 * in-pane so a novel method is legible. Always goes through `JSON.stringify` (so
 * an object is never rendered as `[object Object]`) with a readable marker for
 * unserializable values, then clips to the shared preview budget. Returns
 * undefined when there is nothing to show — a bare debug diagnostic still folds
 * out of the pane.
 */
function diagnosticDataPreview(data: unknown): string | undefined {
  if (data === undefined || data === null) return undefined
  let json: string | undefined
  try {
    json = JSON.stringify(data)
  } catch {
    json = undefined
  }
  const rendered = json ?? '<unserializable>'
  return `data=${clip(rendered)}`
}

/**
 * Flatten one codex reasoning-summary title to plain prose. Codex ships each
 * summary part as a markdown-bold header (`**Evaluating the constraint**`) and
 * occasionally with backticks or `#` markers; the pane renders reasoning as quiet
 * prose, not a markdown document, so the emphasis syntax is stripped rather than
 * styled. Whitespace (including the `\n\n` seams between parts) is collapsed.
 */
function cleanReasoningTitle(raw: string): string {
  return raw
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface TranscriptRegions {
  /** The agent's finalized prose. */
  prose: (text: string) => void
  userInput: (content: string) => void
  /** Plan / diff / reasoning cards, or a plain leveled diagnostic line. */
  diagnostic: (payload: Record<string, unknown>) => void
}

/**
 * Multi-row regions of the transcript: each renders one finalized event as a
 * blank-line-bracketed block in its own lane (or, for prose and reasoning, in
 * none).
 */
export function createTranscriptRegions(
  emit: (line: string) => void,
  styler: CodexStyler
): TranscriptRegions {
  const { contentWidth, band, line } = styler

  function renderProse(text: string): void {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    // Prose is the primary voice: UNbanded, bright text; only headings bold,
    // bullets get a dim marker. Light-touch markdown, no full parser.
    //
    // Bracketed by a blank row on BOTH sides, like every other region (user input,
    // plan, diff). Prose is the one thing with no lane, so the negative space
    // around it is what marks where it starts and stops — opening that space and
    // not closing it left the agent's voice running straight into the next tool
    // band, which is the one boundary the design most wants to be legible.
    emit('')
    for (const raw of wrap(trimmed, contentWidth())) {
      const heading = /^#{1,3}\s+/.exec(raw)
      const bullet = /^[-*]\s+/.exec(raw)
      if (heading) {
        emit(line([{ text: raw.slice(heading[0].length), fg: 'text', bold: true }]))
      } else if (bullet) {
        emit(
          line([
            { text: '– ', fg: 'dim' },
            { text: raw.slice(bullet[0].length), fg: 'text' },
          ])
        )
      } else {
        emit(line([{ text: raw, fg: 'text' }]))
      }
    }
    emit('')
  }

  /** The user's input — indigo prompt band, full multi-line text (the fix for a
   *  truncated dispatch that previously showed only its priming first line). */
  function renderUserInput(content: string): void {
    const wrapped = wrap(content.trim(), contentWidth())
    if (wrapped.length === 0 || wrapped.every((l) => l.length === 0)) return
    const shown = wrapped.slice(0, MAX_INPUT_LINES)
    const hidden = wrapped.length - shown.length
    emit('')
    shown.forEach((body, idx) => {
      emit(
        band('prompt', 'iris', [
          { text: idx === 0 ? '❯ ' : '  ', fg: 'iris', bold: idx === 0 },
          { text: body, fg: 'text' },
        ])
      )
    })
    if (hidden > 0) {
      emit(
        band('prompt', 'iris', [
          { text: `  … ${hidden} more line${hidden === 1 ? '' : 's'}`, fg: 'dim' },
        ])
      )
    }
    emit('')
  }

  function renderPlan(data: Record<string, unknown>): void {
    const steps = Array.isArray(data['steps']) ? data['steps'] : []
    if (steps.length === 0) return
    const shown = steps.slice(0, MAX_PLAN_STEPS)
    const hidden = steps.length - shown.length
    emit('')
    emit(
      band('notice', 'brass', [
        { text: '◇ ', fg: 'brass', bold: true },
        { text: 'plan', fg: 'brass', bold: true },
        { text: `  ${steps.length} step${steps.length === 1 ? '' : 's'}`, fg: 'dim' },
      ])
    )
    for (const entry of shown) {
      const rec = asRecord(entry)
      const status = str(rec['status']) || 'pending'
      const mark = PLAN_GLYPH[status] ?? PENDING_MARK
      const stepText = clip(str(rec['step']), contentWidth() - 6)
      emit(
        band('notice', 'brass', [
          { text: `${mark.glyph} `, fg: mark.fg, bold: !mark.dim },
          { text: stepText, fg: mark.dim ? 'dim' : 'text' },
        ])
      )
    }
    if (hidden > 0) {
      emit(band('notice', 'brass', [{ text: `… ${hidden} more`, fg: 'dim' }]))
    }
    emit('')
  }

  /**
   * The agent's interior reasoning — its private train of thought, surfaced by
   * codex as a handful of section titles. It is the SAME actor as the agent's
   * prose, so like prose it takes NO lane; but it is thought, not speech, so it is
   * rendered a register quieter — a cool `muted` grey echo rather than the warm
   * off-white of the spoken voice. The `∴` header glyph is owned by nothing else
   * in the vocabulary, and the whole block is blank-line bracketed, so it never
   * reads as a chrome `·` line, as the agent speaking, or as the `✓ done` footer.
   * The raw summary object never reaches the pane as a `data={…}` JSON preview.
   */
  function renderReasoning(data: Record<string, unknown>): void {
    const notes = str(data['summary'])
      .split(/\n{2,}/)
      .map(cleanReasoningTitle)
      .filter((title) => title.length > 0)
    if (notes.length === 0) return
    emit('')
    emit(
      line([
        { text: '∴ ', fg: 'muted', bold: true },
        { text: 'thinking', fg: 'muted', bold: true },
        { text: `  ${notes.length} note${notes.length === 1 ? '' : 's'}`, fg: 'dim' },
      ])
    )
    for (const note of notes) {
      for (const body of wrap(note, contentWidth() - 2)) {
        emit(line([{ text: `  ${body}`, fg: 'muted' }]))
      }
    }
    if (data['truncated'] === true) {
      emit(line([{ text: '  … more', fg: 'dim' }]))
    }
    emit('')
  }

  function renderDiff(data: Record<string, unknown>): void {
    const files = Array.isArray(data['files']) ? data['files'] : []
    if (files.length === 0) return
    const added = Number(data['totalAdded']) || 0
    const removed = Number(data['totalRemoved']) || 0
    const truncated = Number(data['truncated']) || 0
    emit('')
    emit(
      band('patch', 'teal', [
        { text: '± ', fg: 'teal', bold: true },
        { text: `${files.length} file${files.length === 1 ? '' : 's'}`, fg: 'text', bold: true },
        { text: '  +', fg: 'dim' },
        { text: String(added), fg: 'kiln' },
        { text: ' -', fg: 'dim' },
        { text: String(removed), fg: 'red' },
      ])
    )
    for (const entry of files) {
      const rec = asRecord(entry)
      emit(
        band('patch', 'teal', [
          { text: clip(str(rec['path']), contentWidth() - 14), fg: 'muted' },
          { text: '  +', fg: 'dim' },
          { text: String(Number(rec['added']) || 0), fg: 'kiln' },
          { text: ' -', fg: 'dim' },
          { text: String(Number(rec['removed']) || 0), fg: 'red' },
        ])
      )
    }
    if (truncated > 0) {
      emit(
        band('patch', 'teal', [
          { text: `… ${truncated} more file${truncated === 1 ? '' : 's'}`, fg: 'dim' },
        ])
      )
    }
    emit('')
  }

  function renderDiagnostic(p: Record<string, unknown>): void {
    // Plan / diff updates ride on `diagnostic` (discriminated by `kind`) so the
    // renderer can present them without a new protocol event type.
    const kind = str(p['kind'])
    if (kind === 'plan') {
      renderPlan(asRecord(p['data']))
      return
    }
    if (kind === 'diff') {
      renderDiff(asRecord(p['data']))
      return
    }
    if (kind === 'reasoning') {
      renderReasoning(asRecord(p['data']))
      return
    }
    const level = str(p['level']) || 'info'
    const message = str(p['message'])
    // Debug/trace diagnostics are the unknown-native-notification trace. The
    // high-frequency native methods are already dropped upstream in the mapper,
    // so what reaches here is a genuinely-novel method. Fold the BARE ones out of
    // the pane (T-06325 quiet-pane rule), but when one carries structured params
    // surface them as a bounded, labeled compact preview so the novel method is
    // legible in-pane, not just on the durable stream (T-05219).
    if (level === 'debug' || level === 'trace') {
      const preview = diagnosticDataPreview(p['data'])
      if (preview === undefined) return
      const body = message.length > 0 ? `· ${message}  ${preview}` : `· ${preview}`
      emit(line([{ text: body, fg: 'dim' }]))
      return
    }
    if (message.length === 0) return
    if (level === 'error') emit(line([{ text: `✗ ${message}`, fg: 'red' }]))
    else if (level === 'warn') emit(line([{ text: `⚠ ${message}`, fg: 'brass' }]))
    else emit(line([{ text: `ℹ ${message}`, fg: 'teal' }]))
  }

  return { prose: renderProse, userInput: renderUserInput, diagnostic: renderDiagnostic }
}
