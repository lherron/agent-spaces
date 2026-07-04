/**
 * Line-oriented scanning shared by the grep-tripwire rules (rubric §2 M6/M7).
 *
 * WHY: Every tripwire is "a hit is a CANDIDATE, not a verdict". We scan real lines
 * (with 1-based line numbers for evidence) and skip fenced code blocks so quoted
 * example code does not generate noise. Callers still emit low-severity info.
 */

export interface LineHit {
  /** 1-based line number. */
  line: number
  /** The full source line (trimmed for display). */
  text: string
}

/**
 * Return every non-fenced line matching `pattern`, with its 1-based line number.
 * Lines inside ``` / ~~~ fences are skipped.
 */
export function scanLines(content: string, pattern: RegExp): LineHit[] {
  const hits: LineHit[] = []
  const lines = content.split(/\r?\n/)
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? ''
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      continue
    }
    if (pattern.test(raw)) {
      hits.push({ line: i + 1, text: raw.trim() })
    }
  }
  return hits
}
