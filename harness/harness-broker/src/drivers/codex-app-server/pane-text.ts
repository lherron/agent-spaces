/** Plain-text shaping for pane rows: coercion, one-line clipping, word wrap. */

const MAX_PREVIEW = 120

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function str(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

export function clip(value: string, max = MAX_PREVIEW): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/** Greedy word-wrap to a content width, preserving explicit newlines. */
export function wrap(text: string, width: number): string[] {
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
