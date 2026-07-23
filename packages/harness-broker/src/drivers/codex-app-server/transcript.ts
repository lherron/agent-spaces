import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

/**
 * T-04963 / T-06325 — operator transcript renderer for the Codex app-server pane.
 *
 * "Forge lanes" design: each operational region of a turn is a full-width tinted
 * band carrying a bright left keyline (`▎`) in the region's accent hue, so
 * consecutive rows form one continuous coloured spine — the eye reads the user's
 * input, tool activity, plan, and diffs as distinct lanes running down the pane
 * rather than one flat monochrome stream. The agent's own prose is deliberately
 * the ONE thing with no lane (open, full-width, warm) — structurally marking it
 * as the agent speaking, not operational work. The renderer process is
 * `exec bun`-launched from source into a tmux pane and cannot reach the
 * hrc-runtime render packages, so the styling is raw truecolor ANSI with no
 * dependencies.
 *
 * Region vocabulary (see the FG/BG "forge lanes" palette below):
 *   - user input      → violet lane, full multi-line text, `❯` gutter
 *   - agent prose     → NO lane (the primary voice), warm off-white
 *   - turn divider    → open molten `▶ turn` (the one bold hue)
 *   - tool call       → kiln-green lane, `$`/glyph gutter, grouped output
 *   - failed tool     → red lane
 *   - plan update     → brass lane, `☑/▸/☐` checklist
 *   - diff update     → teal lane, per-file `+a -r` filestat
 *   - turn footer     → kiln lane `✓ done · <tokens> · <elapsed>`
 *   - running row     → molten lane, live ember bar (ephemeral, never scrollback)
 *   - startup/chrome  → dim `·` lines (recede)
 *
 * Unlike `hrcchat turn` (one redrawn frame), this appends to a long-lived,
 * multi-turn scrollback pane, so it commits each event as it finalizes rather
 * than redrawing in place. Streaming `*.delta` events are folded into the
 * matching `*.completed`; per-step token usage is folded into the footer;
 * high-frequency telemetry (rate limits, thread status) is dropped upstream in
 * the mapper; and bare debug-level driver diagnostics are folded away here so the
 * pane stays quiet — but an unknown-notification diagnostic that carries native
 * params surfaces them as a labeled `data={…}` preview (T-05219).
 */

/**
 * "Forge lanes" palette (T-06325). An original scheme, not the hrc-ios one: the
 * agent is smithing code in a leased pane, so each operational actor is a
 * saturated material hue, and one bold molten accent is reserved for the turn
 * divider alone. Truecolor foregrounds — bright accents for lane keylines/glyphs
 * and a warm off-white for prose.
 */
const FG = {
  text: '38;2;237;230;218', // warm off-white — the agent's prose
  muted: '38;2;150;144;134', // secondary detail
  dim: '38;2;104;99;92', // chrome / de-emphasis
  iris: '38;2;150;134;248', // violet — the user's input lane (nothing else is violet)
  molten: '38;2;242;107;30', // the ONE bold hue — turn divider only
  hot: '38;2;255;226;168', // white-hot — the leading coal of the running row
  ember: '38;2;122;56;22', // a coal that has cooled — trails the running row
  kiln: '38;2;61;220;132', // phosphor green — tool/shell lane, success
  teal: '38;2;45;212;191', // cyan-teal — diff lane
  brass: '38;2;224;168;46', // warm gold — plan lane, caution
  red: '38;2;242;85;90', // failure lane
} as const

// Deep, low-lightness band tints — each keyed to its lane accent's hue.
const BG = {
  prompt: '48;2;32;28;52', // deep indigo — user input
  tool: '48;2;18;38;28', // deep kiln — tool call
  patch: '48;2;16;38;38', // deep teal — diff
  notice: '48;2;30;27;20', // warm neutral — plan / notices
  error: '48;2;46;20;22', // deep red — failure
  endturn: '48;2;18;34;26', // green-teal — turn footer
  forge: '48;2;44;24;12', // deep molten — the live running row (T-06365)
} as const

type Fg = keyof typeof FG
type Bg = keyof typeof BG

/** The signature device: a bright left keyline that turns a band into a lane. */
const KEYLINE = '▎ '

/**
 * Erase-in-line (EL0). With a background SGR active, this erases from the cursor
 * to the true end of the physical row IN THE CURRENT BACKGROUND COLOUR
 * (background-colour erase — both tmux and Ghostty implement it). It is how a
 * band reaches the pane edge without knowing the pane width.
 */
const ERASE_TO_EOL = '\x1b[K'

interface Seg {
  text: string
  fg?: Fg
  bold?: boolean
}

const BODY = '  '
const DEFAULT_WIDTH = 96
const MIN_WIDTH = 48
const MAX_WIDTH = 120
/** Fallback pane width when the live thunk has nothing to report (not a TTY). */
const FALLBACK_PANE_WIDTH = 80
const MAX_TOOL_OUTPUT_LINES = 3
const MAX_PREVIEW = 120
const MAX_INPUT_LINES = 40
const MAX_PLAN_STEPS = 12
const RESET = '\x1b[0m'
/** Tab stop used to expand tabs in foreign tool output into cells that paint. */
const TAB_WIDTH = 8
/** Stands in for a C0 control character that must never reach the terminal. */
const CONTROL_PLACEHOLDER = '·'

const TOOL_GLYPH: Record<string, string> = {
  command: '$',
  file_change: '✎',
  mcp_tool: '⚡',
  web_search: '⌕',
  image_view: '◐',
}

interface PlanMark {
  glyph: string
  fg: Fg
  dim: boolean
}

const PENDING_MARK: PlanMark = { glyph: '☐', fg: 'dim', dim: false }

const PLAN_GLYPH: Record<string, PlanMark> = {
  completed: { glyph: '☑', fg: 'kiln', dim: true },
  inProgress: { glyph: '▸', fg: 'brass', dim: false },
  in_progress: { glyph: '▸', fg: 'brass', dim: false },
  pending: PENDING_MARK,
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function clip(value: string, max = MAX_PREVIEW): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
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
 * The TYPOGRAPHIC measure: how wide prose may wrap and stay readable. Clamped at
 * both ends on purpose — a 200-column pane should not produce 200-column prose.
 * Deliberately NOT the measure a band fills to (see `paneWidth`).
 */
function clampWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) return DEFAULT_WIDTH
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(width)))
}

/**
 * The PHYSICAL measure: how many cells a band row may occupy. A pane is as wide
 * as it is, so this is never clamped upward — clamping the fill is what left
 * bands short of the edge (T-06343). Resolved fresh per row from the caller's
 * thunk, so a mid-stream pane resize is picked up without a SIGWINCH handler.
 */
function resolvePaneWidth(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return FALLBACK_PANE_WIDTH
  return Math.max(MIN_WIDTH, Math.floor(raw))
}

/**
 * Rewrite a styled row so every character it carries actually PAINTS a cell
 * (T-06351).
 *
 * Tool output is arbitrary bytes from someone else's program, and two kinds of
 * character punch a hole in a tinted band:
 *
 *  - TAB advances the cursor instead of writing cells, so the cells it skips keep
 *    whatever background was already there — the operator's pane colour, not the
 *    band tint. Tab-indented output (Go source via rg/sed is the common case) left
 *    visible rectangles of pane background mid-row. Expanded here to real spaces,
 *    which do paint, against tab stops measured across the whole row so the
 *    original column alignment survives.
 *  - ESC (and other C0 controls) would be interpreted by the terminal: a stray
 *    `ESC[0m` in tool output clears the band background for the remainder of the
 *    row, and any cursor-moving sequence corrupts the lane. Replaced with a visible
 *    placeholder rather than passed through.
 *
 * Runs before `clipSegs` so the clip budget counts cells, not source characters —
 * a tab counts as 1 character but occupies up to TAB_WIDTH cells.
 */
function paintableSegs(segs: Seg[]): Seg[] {
  let column = 0
  return segs.map((seg) => {
    let text = ''
    for (const ch of seg.text) {
      if (ch === '\t') {
        const stop = TAB_WIDTH - (column % TAB_WIDTH)
        text += ' '.repeat(stop)
        column += stop
        continue
      }
      // C0 controls (and DEL) are interpreted by the terminal, not printed: a stray
      // ESC[0m from a foreign program would clear the band background for the rest of
      // the row. Compared by code point rather than matched by a regex literal, which
      // would need a literal control character in the source.
      const code = ch.codePointAt(0) ?? 0
      text += code < 0x20 || code === 0x7f ? CONTROL_PLACEHOLDER : ch
      column += 1
    }
    return { ...seg, text }
  })
}

/**
 * Truncate a styled row to `budget` cells, preserving per-segment styling. A band
 * row must never wrap: a wrapped row splits the keyline off from its content and
 * lands the erase-to-EOL on the wrong physical row.
 */
function clipSegs(segs: Seg[], budget: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const seg of segs) {
    const room = budget - used
    if (room <= 0) break
    if (seg.text.length <= room) {
      out.push(seg)
      used += seg.text.length
      continue
    }
    out.push({ ...seg, text: `${seg.text.slice(0, room - 1)}…` })
    break
  }
  return out
}

/** Greedy word-wrap to a content width, preserving explicit newlines. */
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    if (rawLine.trim().length === 0) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of rawLine.split(/\s+/)) {
      if (line.length === 0) {
        line = word
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`
      } else {
        out.push(line)
        line = word
      }
    }
    if (line.length > 0) out.push(line)
  }
  return out
}

function formatTokens(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return str(value)
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s - m * 60)}s`
}

function parseMs(time: unknown): number {
  if (typeof time !== 'string') return Number.NaN
  return Date.parse(time)
}

function toolGlyph(name: string): string {
  return TOOL_GLYPH[name] ?? '⚙'
}

function toolPreview(input: unknown): string {
  const rec = asRecord(input)
  if (typeof rec['command'] === 'string') return clip(rec['command'])
  for (const value of Object.values(rec)) {
    if (typeof value === 'string' && value.length > 0) return clip(value)
  }
  return clip(str(input))
}

function toolOutput(payload: Record<string, unknown>): string {
  const result = asRecord(payload['result'])
  const raw =
    (typeof result['output'] === 'string' ? result['output'] : undefined) ?? str(payload['output'])
  return raw
}

/**
 * Headline for a failed tool call. Only some drivers set `message`; a codex
 * `commandExecution` reports its failure as `result.exitCode` and an
 * `mcpToolCall` as `result.error`, so a message-only read renders a bare `✗
 * command` with no reason at all (T-06401).
 */
function toolFailure(payload: Record<string, unknown>): string {
  const message = str(payload['message']).trim()
  if (message.length > 0) return message

  const result = asRecord(payload['result'])
  const error = str(result['error']).trim()
  if (error.length > 0) return error

  const exitCode = result['exitCode']
  if (typeof exitCode === 'number') return `exit ${exitCode}`

  const status = str(payload['status']).trim()
  return status.length > 0 ? status : 'failed'
}

function truncateOutput(output: string): string[] {
  const lines = output.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n')
  if (lines.length <= MAX_TOOL_OUTPUT_LINES) return lines
  const remaining = lines.length - MAX_TOOL_OUTPUT_LINES
  return [
    ...lines.slice(0, MAX_TOOL_OUTPUT_LINES),
    `… ${remaining} more line${remaining === 1 ? '' : 's'}`,
  ]
}

function shortId(id: string): string {
  const cleaned = id.replace(/^(inv-|turn-|input-)/, '')
  return cleaned.length <= 12 ? cleaned : `${cleaned.slice(0, 8)}…`
}

/**
 * Elapsed for a row that repaints several times a second (T-06365). Deliberately
 * NOT `formatElapsed`: that renders sub-second precision, which on a live counter
 * churns every frame and reads as noise rather than a stopwatch. Whole seconds
 * only, and nothing at all under one second — a turn that finishes that fast
 * should not flash a number on its way past.
 */
function formatLiveElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

function extractAssistantText(payload: Record<string, unknown>): string {
  if (typeof payload['text'] === 'string') return payload['text']
  const content = payload['content']
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      block !== null && typeof block === 'object'
        ? (block as Record<string, unknown>)['text']
        : undefined
    )
    .filter((t): t is string => typeof t === 'string')
    .join('')
}

/**
 * A fixed width, or a thunk resolved fresh per band row. Pass the thunk from a
 * live pane (`() => process.stdout.columns`): the renderer is exec'd into an
 * HRC-leased pane that may still be at tmux's 80-column default, and is resized
 * once a client attaches — a value snapshotted at construction goes stale and
 * pins every band to the launch-time width (T-06343).
 */
export type CodexTranscriptWidth = number | (() => number | undefined)

export interface CodexTranscriptModelOptions {
  invocationId: string
  emit: (line: string) => void
  color?: boolean | undefined
  width?: CodexTranscriptWidth | undefined
}

export interface CodexTranscriptModel {
  /** Fold one durable broker event into the transcript, emitting styled lines. */
  apply: (event: InvocationEventEnvelope) => void
  /** Surface a durable-read failure visibly (never silently dropped). */
  readFailure: (text: string) => void
}

/**
 * The ANSI primitives, shared by everything that paints a row in this design
 * language. Hoisted out of the transcript model (T-06365) so the live status row
 * — which is NOT part of the append-only transcript — renders as a real forge
 * lane instead of reimplementing the band assembly beside it.
 *
 * The PHYSICAL pane measure stays private: `band` is the only thing that may fill
 * to it, and it does that with erase-to-EOL rather than width arithmetic (T-06343).
 * Handing callers a pane width invites exactly the padding that bug was.
 */
interface Styler {
  /** Typographic: prose wrap/clip. Clamped — readability, not the pane. */
  contentWidth: () => number
  band: (bg: Bg, accent: Fg, segs: Seg[]) => string
  line: (segs: Seg[]) => string
  dimLine: (body: string) => string
}

function createStyler(color: boolean, width: CodexTranscriptWidth | undefined): Styler {
  // Both measures resolve fresh per row from the caller's width source, so a pane
  // resize after launch is picked up with no SIGWINCH handler (T-06343).
  const rawWidth = (): number | undefined => (typeof width === 'function' ? width() : width)
  const contentWidth = (): number =>
    Math.max(MIN_WIDTH - BODY.length, clampWidth(rawWidth()) - BODY.length)
  const paneWidth = (): number => resolvePaneWidth(rawWidth())

  // A segment's foreground and intensity are BOTH re-asserted so a preceding
  // bold/coloured segment never bleeds into the next; the band background is set
  // once and only cleared by the trailing reset, so `\x1b[39m`-style resets can
  // never punch a hole in the band.
  const paint = (segs: Seg[]): string =>
    segs.map((s) => `\x1b[${s.bold ? '1' : '22'};${s.fg ? FG[s.fg] : '39'}m${s.text}`).join('')

  /**
   * A full-width tinted lane row: a bright left keyline in the lane accent, the
   * band tint behind, painted segments, erase-to-EOL, reset. Consecutive rows of a
   * region share the accent, so the keyline forms one continuous coloured spine
   * down the pane.
   *
   * The fill is `ESC[K` rather than computed padding (T-06343). Padding to a width
   * the renderer believes the pane to be left every band short of the real edge —
   * the operator's own terminal background showed through on the right, so bands
   * read as jagged against a pane with a background colour set. Erase-to-EOL fills
   * to the row's TRUE end in the band tint, so there is no width arithmetic to get
   * wrong (and no UTF-16-vs-cells miscount on wide glyphs in tool output).
   *
   * Content is still clipped one column short of the pane so a row never reaches
   * the final column, where a tmux/terminal auto-wrap would spill an empty tinted
   * continuation line — and so an over-long preview can never wrap away its keyline.
   *
   * `paintableSegs` runs first so every character the row carries actually paints a
   * cell: a tab would otherwise skip cells and leave the pane's own background
   * showing INSIDE the band (T-06351).
   */
  function band(bg: Bg, accent: Fg, segs: Seg[]): string {
    const rowSegs: Seg[] = [{ text: KEYLINE, fg: accent, bold: true }, ...segs]
    if (!color) return rowSegs.map((s) => s.text).join('')
    const fitted = clipSegs(paintableSegs(rowSegs), paneWidth() - 1)
    return `\x1b[${BG[bg]}m${paint(fitted)}${ERASE_TO_EOL}${RESET}`
  }

  /** An unbanded (native-bg) styled line, indented under BODY. */
  function line(segs: Seg[]): string {
    if (!color) return `${BODY}${segs.map((s) => s.text).join('')}`
    return `${BODY}${paint(segs)}${RESET}`
  }

  return {
    contentWidth,
    band,
    line,
    dimLine: (body: string): string => line([{ text: `· ${body}`, fg: 'dim' }]),
  }
}

/**
 * The live "running" status row (T-06365).
 *
 * Structurally this is the UNRESOLVED form of the `✓ done` turn footer: same lane
 * position at the foot of the turn, replaced in place by the footer the moment the
 * turn lands. So it is a real band, and it takes the molten accent the turn divider
 * already owns — `▶ turn` opens the turn, this holds it open, `✓ done` closes it.
 *
 * The animation is a bar of metal in a fire rather than the braille dots every CLI
 * spinner reaches for: a white-hot coal breathes back and forth along `━━━━━━`, and
 * the cells behind it cool through molten → brass → dead ember. It ping-pongs
 * instead of marching in one direction — a conveyor reads as progress toward a
 * known end, and a turn has no known end. Heat only says "still working".
 */
export interface CodexStatusRow {
  /** One frame of the running row. `frame` is taken modulo the frame count. */
  running: (frame: number, elapsedMs: number) => string
}

const EMBER_CELLS = 6
const EMBER_GLYPH = '━'
/** Heat by distance behind the coal: white-hot, molten, brass, then dead ember. */
const EMBER_HEAT: readonly Fg[] = ['hot', 'molten', 'brass', 'ember']
/** Ping-pong period: out along the bar and back, with no held frame at either end. */
export const CODEX_STATUS_FRAME_COUNT = (EMBER_CELLS - 1) * 2

export function createCodexStatusRow(options: {
  color?: boolean | undefined
  width?: CodexTranscriptWidth | undefined
}): CodexStatusRow {
  const styler = createStyler(options.color ?? false, options.width)
  return {
    running(frame: number, elapsedMs: number): string {
      const phase =
        ((frame % CODEX_STATUS_FRAME_COUNT) + CODEX_STATUS_FRAME_COUNT) % CODEX_STATUS_FRAME_COUNT
      const coal = phase < EMBER_CELLS ? phase : CODEX_STATUS_FRAME_COUNT - phase
      const bar: Seg[] = Array.from({ length: EMBER_CELLS }, (_, i) => ({
        text: EMBER_GLYPH,
        fg: EMBER_HEAT[Math.min(Math.abs(i - coal), EMBER_HEAT.length - 1)] as Fg,
        bold: Math.abs(i - coal) <= 1,
      }))
      const elapsed = formatLiveElapsed(elapsedMs)
      return styler.band('forge', 'molten', [
        ...bar,
        { text: '  running', fg: 'text', bold: true },
        ...(elapsed.length > 0 ? [{ text: ` · ${elapsed}`, fg: 'dim' as Fg }] : []),
      ])
    },
  }
}

/**
 * Stateful transcript model. Coalesces assistant `*.delta` streams into the
 * finalized message, pairs `tool.call.started`/`completed` into a grouped band,
 * tracks per-turn usage + elapsed for the footer, renders plan/diff updates as
 * cards, and folds high-frequency telemetry away.
 */
export function createCodexTranscriptModel(
  options: CodexTranscriptModelOptions
): CodexTranscriptModel {
  const emit = options.emit
  const { contentWidth, band, line, dimLine } = createStyler(options.color ?? false, options.width)

  // Per-turn rolling state.
  const toolNames = new Map<string, string>()
  let assistantBuffer = ''
  let assistantOpen = false
  let turnStartMs = Number.NaN
  let latestTokens: unknown
  let headerShown = false

  // ── Region renderers ───────────────────────────────────────────────────
  function flushAssistant(payload: Record<string, unknown>): void {
    const text = extractAssistantText(payload) || assistantBuffer
    assistantBuffer = ''
    assistantOpen = false
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

  function apply(event: InvocationEventEnvelope): void {
    const p = asRecord(event.payload)
    switch (event.type) {
      // ── Startup / lifecycle (low-key, dim rail of '·' lines) ────────────
      case 'lifecycle.policy.accepted':
        emit(dimLine(`policy ${str(p['policyId'])} (${str(p['retentionMode']) || 'n/a'})`))
        return
      case 'terminal.surface.reported':
        emit(dimLine(`surface ${str(p['kind'])} ${str(p['paneId'])}`))
        return
      case 'invocation.started':
        emit(dimLine(`process pid=${str(p['pid'])}`))
        return
      case 'continuation.updated':
        emit(dimLine(`thread ${shortId(str(p['key']))}`))
        return
      case 'continuation.cleared':
        emit(dimLine(`thread cleared (${str(p['reason']) || 'n/a'})`))
        return
      case 'input.accepted':
        emit(dimLine(`input ${str(p['disposition']) || 'accepted'}`))
        return
      case 'invocation.ready': {
        if (!headerShown) {
          headerShown = true
          emit('')
          emit(line([{ text: `codex-app-server · ${shortId(options.invocationId)}`, fg: 'dim' }]))
        }
        emit(
          line([
            { text: '● ', fg: 'kiln' },
            { text: 'ready', fg: 'text', bold: true },
          ])
        )
        return
      }
      case 'invocation.exited':
        emit(dimLine(`exited code=${str(p['exitCode'])} signal=${str(p['signal'])}`))
        return
      case 'invocation.failed':
        emit(line([{ text: `✗ ${str(p['message'])}`, fg: 'red', bold: true }]))
        return
      case 'invocation.summary':
        emit(dimLine(`summary ${str(p['summary'] ?? p)}`))
        return
      case 'driver.notice':
        emit(line([{ text: `⚠ ${str(p['message'])}`, fg: 'brass' }]))
        return

      // ── Turn + message flow ─────────────────────────────────────────────
      case 'user.message':
        renderUserInput(str(p['content']))
        return
      case 'turn.started':
        turnStartMs = parseMs(event.time)
        latestTokens = undefined
        emit('')
        emit(
          line([
            { text: '▶ ', fg: 'molten', bold: true },
            { text: 'turn', fg: 'text', bold: true },
            { text: ` ${shortId(str(p['turnId']))}`, fg: 'dim' },
          ])
        )
        return
      case 'assistant.message.started':
        assistantBuffer = ''
        assistantOpen = true
        return
      case 'assistant.message.delta':
        if (assistantOpen) assistantBuffer += str(p['text'])
        return // streaming chunk — folded into the completed message
      case 'assistant.message.completed':
        flushAssistant(p)
        return

      // ── Tool calls (grouped: started band + ↳ output) ───────────────────
      case 'tool.call.started': {
        const name = str(p['name']) || 'tool'
        toolNames.set(str(p['toolCallId'] ?? p['callId']), name)
        emit(
          band('tool', 'kiln', [
            { text: `${toolGlyph(name)} `, fg: 'kiln', bold: true },
            { text: name, fg: 'text', bold: true },
            { text: `  ${toolPreview(p['input'])}`, fg: 'muted' },
          ])
        )
        return
      }
      case 'tool.call.delta':
        return // streaming chunk — folded into the completed output
      case 'tool.call.completed': {
        const output = toolOutput(p)
        const lines = output.trim().length > 0 ? truncateOutput(output) : []
        lines.forEach((body, idx) => {
          emit(
            band('tool', 'kiln', [
              { text: idx === 0 ? '↳ ' : '  ', fg: 'dim' },
              { text: body, fg: 'muted' },
            ])
          )
        })
        return
      }
      case 'tool.call.failed': {
        const name = str(p['name']) || toolNames.get(str(p['toolCallId'] ?? p['callId'])) || 'tool'
        emit(
          band('error', 'red', [
            { text: '✗ ', fg: 'red', bold: true },
            { text: name, fg: 'red', bold: true },
            { text: `  ${clip(toolFailure(p))}`, fg: 'red' },
          ])
        )
        const output = toolOutput(p)
        if (output.trim().length > 0) {
          truncateOutput(output).forEach((body, idx) => {
            emit(
              band('error', 'red', [
                { text: idx === 0 ? '↳ ' : '  ', fg: 'dim' },
                { text: body, fg: 'red' },
              ])
            )
          })
        }
        return
      }

      // ── Diagnostics + telemetry ─────────────────────────────────────────
      case 'diagnostic':
        renderDiagnostic(p)
        return
      case 'usage.updated': {
        // Track for the turn footer only — a codex turn emits a token update per
        // step, so rendering each one floods the pane. The final `✓ done` line
        // carries the final request's context usage. `usage.total` is cumulative
        // across every request in the invocation and would mislabel millions of
        // lifetime tokens as one turn's context size (T-06423).
        const last = asRecord(asRecord(p['usage'])['last'])
        latestTokens = last['totalTokens']
        return
      }
      case 'turn.completed': {
        const elapsed = formatElapsed(parseMs(event.time) - turnStartMs)
        const stats = [
          latestTokens !== undefined ? `${formatTokens(latestTokens)} tok` : '',
          elapsed,
        ]
          .filter((s) => s.length > 0)
          .join(' · ')
        emit('')
        emit(
          band('endturn', 'kiln', [
            { text: '✓ ', fg: 'kiln', bold: true },
            { text: 'done', fg: 'text', bold: true },
            ...(stats.length > 0 ? [{ text: ` · ${stats}`, fg: 'dim' as Fg }] : []),
          ])
        )
        return
      }
      case 'turn.failed':
        emit('')
        emit(
          band('error', 'red', [
            { text: '✗ ', fg: 'red', bold: true },
            { text: 'failed', fg: 'red', bold: true },
            {
              text: `  ${clip(str(p['message'] ?? p['finalOutput'] ?? p['code']))}`,
              fg: 'red',
            },
          ])
        )
        return
      case 'turn.interrupted':
        emit(line([{ text: '◼ interrupted', fg: 'brass' }]))
        return

      // Broker provenance — a sidecar-path record, not operator-facing. Kept in
      // the durable stream for downstream consumers; folded out of the pane.
      case 'provider.transcript.reported':
        return

      default:
        emit(dimLine(`${event.type} ${clip(str(event.payload))}`))
    }
  }

  function readFailure(text: string): void {
    emit(line([{ text: `✗ ${text}`, fg: 'red', bold: true }]))
  }

  return { apply, readFailure }
}
