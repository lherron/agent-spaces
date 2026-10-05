/**
 * The pane's ANSI styling primitives, shared by the transcript, the live status
 * row, the queue drawer and the muse renderer.
 *
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

export type CodexFg = keyof typeof FG
export type CodexBg = keyof typeof BG

/** The signature device: a bright left keyline that turns a band into a lane. */
const KEYLINE = '▎ '

/**
 * Erase-in-line (EL0). With a background SGR active, this erases from the cursor
 * to the true end of the physical row IN THE CURRENT BACKGROUND COLOUR
 * (background-colour erase — both tmux and Ghostty implement it). It is how a
 * band reaches the pane edge without knowing the pane width.
 */
const ERASE_TO_EOL = '\x1b[K'

export interface CodexSeg {
  text: string
  fg?: CodexFg
  bold?: boolean
}

const BODY = '  '
const DEFAULT_WIDTH = 96
const MIN_WIDTH = 48
const MAX_WIDTH = 120
/** Fallback pane width when the live thunk has nothing to report (not a TTY). */
const FALLBACK_PANE_WIDTH = 80
const RESET = '\x1b[0m'
/** Tab stop used to expand tabs in foreign tool output into cells that paint. */
const TAB_WIDTH = 8
/** Stands in for a C0 control character that must never reach the terminal. */
const CONTROL_PLACEHOLDER = '·'

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
function paintableSegs(segs: CodexSeg[]): CodexSeg[] {
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
function clipSegs(segs: CodexSeg[], budget: number): CodexSeg[] {
  const out: CodexSeg[] = []
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

/**
 * A fixed width, or a thunk resolved fresh per band row. Pass the thunk from a
 * live pane (`() => process.stdout.columns`): the renderer is exec'd into an
 * HRC-leased pane that may still be at tmux's 80-column default, and is resized
 * once a client attaches — a value snapshotted at construction goes stale and
 * pins every band to the launch-time width (T-06343).
 */
export type CodexTranscriptWidth = number | (() => number | undefined)

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
export interface CodexStyler {
  /** Typographic: prose wrap/clip. Clamped — readability, not the pane. */
  contentWidth: () => number
  band: (bg: CodexBg, accent: CodexFg, segs: CodexSeg[]) => string
  /** Full-width tinted block without the keyline; the tint alone separates. */
  slab: (bg: CodexBg, segs: CodexSeg[]) => string
  line: (segs: CodexSeg[]) => string
  dimLine: (body: string) => string
}

export function createCodexStyler(
  color: boolean,
  width: CodexTranscriptWidth | undefined
): CodexStyler {
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
  const paint = (segs: CodexSeg[]): string =>
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
  function band(bg: CodexBg, accent: CodexFg, segs: CodexSeg[]): string {
    const rowSegs: CodexSeg[] = [{ text: KEYLINE, fg: accent, bold: true }, ...segs]
    if (!color) return rowSegs.map((s) => s.text).join('')
    const fitted = clipSegs(paintableSegs(rowSegs), paneWidth() - 1)
    return `\x1b[${BG[bg]}m${paint(fitted)}${ERASE_TO_EOL}${RESET}`
  }

  /**
   * A full-width tinted block row WITHOUT the keyline: same tint, clip, and
   * erase-to-EOL assembly as `band`, but the background tint alone separates
   * the row — no bright spine. Opt-in per caller; `band` keeps its keyline so
   * existing lanes render byte-identically.
   */
  function slab(bg: CodexBg, segs: CodexSeg[]): string {
    if (!color) return segs.map((s) => s.text).join('')
    const fitted = clipSegs(paintableSegs(segs), paneWidth() - 1)
    return `\x1b[${BG[bg]}m${paint(fitted)}${ERASE_TO_EOL}${RESET}`
  }

  /** An unbanded (native-bg) styled line, indented under BODY. */
  function line(segs: CodexSeg[]): string {
    if (!color) return `${BODY}${segs.map((s) => s.text).join('')}`
    return `${BODY}${paint(segs)}${RESET}`
  }

  return {
    contentWidth,
    band,
    slab,
    line,
    dimLine: (body: string): string => line([{ text: `· ${body}`, fg: 'dim' }]),
  }
}
