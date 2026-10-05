/**
 * Format-preserving edits to a target's compose list in asp-targets.toml.
 *
 * WHY: `asp add` and `asp remove` used to re-serialize the whole file, which
 * dropped every comment and reflowed unrelated tables. These helpers splice
 * only the compose array's text and leave the rest of the file byte-identical.
 * Any layout the scanner does not understand returns null so the caller can
 * fall back to a full re-serialize.
 */

import TOML from '@iarna/toml'
import { createCanonicalHasher } from 'spaces-runtime-contracts'

interface Span {
  start: number
  end: number
}

interface ComposeLocation {
  /** Span of the compose array value, `[` through `]` */
  array: Span
  /** Spans of each string element, quotes included */
  elements: Span[]
}

interface TargetLocation {
  /** Offset just past the `[targets.<name>]` header line, if the header exists */
  headerLineEnd?: number | undefined
  compose?: ComposeLocation | undefined
}

/** Result of a compose update. */
export interface ComposeEditResult {
  /** The new file content */
  toml: string
  /** False when the edit fell back to a full re-serialize (comments lost) */
  preserved: boolean
}

/**
 * Replace a target's compose list with `next`, preserving comments and
 * formatting. `next` must be the current list with some entries removed and/or
 * new entries appended; any other change falls back to re-serializing.
 */
export function updateTargetComposeToml(
  content: string,
  targetName: string,
  next: readonly string[]
): ComposeEditResult {
  const edited = editTargetCompose(content, targetName, next)
  if (edited !== null) return { toml: edited, preserved: true }
  const parsed = TOML.parse(content) as { targets?: Record<string, { compose?: string[] }> }
  const target = parsed.targets?.[targetName]
  if (!target) throw new Error(`Target "${targetName}" not found`)
  target.compose = [...next]
  return { toml: TOML.stringify(parsed as TOML.JsonMap), preserved: false }
}

/**
 * Splice the compose list for `targetName` to equal `next`, or return null when
 * a format-preserving edit is not possible.
 */
export function editTargetCompose(
  content: string,
  targetName: string,
  next: readonly string[]
): string | null {
  let parsed: Record<string, unknown>
  try {
    parsed = TOML.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
  const current = readCompose(parsed, targetName)
  if (current === null) return null

  // Plan: keep a subsequence of `current` that is a prefix of `next`, append the rest.
  const removeIndices: number[] = []
  let j = 0
  for (let i = 0; i < current.length; i++) {
    if (j < next.length && current[i] === next[j]) j++
    else removeIndices.push(i)
  }
  const appends = next.slice(j)

  let text = content
  for (const index of removeIndices.reverse()) {
    const edited = removeElement(text, targetName, index)
    if (edited === null) return null
    text = edited
  }
  for (const ref of appends) {
    const edited = appendElement(text, targetName, ref)
    if (edited === null) return null
    text = edited
  }

  // The edit must change exactly this target's compose list and nothing else.
  let result: Record<string, unknown>
  try {
    result = TOML.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  const expected = structuredClone(parsed)
  const expectedTarget = (expected['targets'] as Record<string, Record<string, unknown>>)[
    targetName
  ] as Record<string, unknown>
  expectedTarget['compose'] = [...next]
  if (canonicalJson(result) !== canonicalJson(expected)) return null
  return text
}

const canonicalHasher = createCanonicalHasher()

/**
 * Key-order-independent JSON through the one shared canonicalizer. The JSON
 * round-trip first turns TOML dates into their ISO strings, which the shared
 * serializer would otherwise render as empty objects.
 */
function canonicalJson(value: unknown): string {
  return canonicalHasher.canonicalize(JSON.parse(JSON.stringify(value)))
}

function readCompose(parsed: Record<string, unknown>, targetName: string): string[] | null {
  const targets = parsed['targets']
  if (!targets || typeof targets !== 'object') return null
  const target = (targets as Record<string, unknown>)[targetName]
  if (!target || typeof target !== 'object') return null
  const compose = (target as Record<string, unknown>)['compose']
  if (compose === undefined) return []
  if (!Array.isArray(compose) || !compose.every((ref) => typeof ref === 'string')) return null
  return compose as string[]
}

function removeElement(text: string, targetName: string, index: number): string | null {
  const compose = locateTarget(text, targetName)?.compose
  const element = compose?.elements[index]
  if (!compose || !element) return null

  const lineStart = text.lastIndexOf('\n', element.start - 1) + 1
  const lineEnd = indexOfLineEnd(text, element.end)
  const before = text.slice(lineStart, element.start)
  const after = text.slice(element.end, lineEnd)
  // Element on a line of its own (optionally with a trailing comma and comment): drop the line.
  if (before.trim() === '' && /^\s*,?\s*(#.*)?$/.test(after) && lineStart > compose.array.start) {
    const nextLineStart = lineEnd < text.length ? lineEnd + 1 : lineEnd
    return text.slice(0, lineStart) + text.slice(nextLineStart)
  }
  const following = compose.elements[index + 1]
  if (following) return text.slice(0, element.start) + text.slice(following.start)
  const previous = compose.elements[index - 1]
  if (previous) return text.slice(0, previous.end) + text.slice(element.end)
  // Only element on a shared line: leave an empty array.
  return `${text.slice(0, compose.array.start)}[]${text.slice(compose.array.end)}`
}

function appendElement(text: string, targetName: string, ref: string): string | null {
  const target = locateTarget(text, targetName)
  if (!target) return null
  const quoted = JSON.stringify(ref)
  const compose = target.compose
  if (!compose) {
    if (target.headerLineEnd === undefined) return null
    const insertAt = target.headerLineEnd
    const newline = insertAt > 0 && text[insertAt - 1] !== '\n' ? '\n' : ''
    return `${text.slice(0, insertAt)}${newline}compose = [${quoted}]\n${text.slice(insertAt)}`
  }
  const last = compose.elements[compose.elements.length - 1]
  if (!last) {
    return `${text.slice(0, compose.array.start)}[${quoted}]${text.slice(compose.array.end)}`
  }

  const lineStart = text.lastIndexOf('\n', last.start - 1) + 1
  const ownLine = text.slice(lineStart, last.start).trim() === '' && lineStart > compose.array.start
  if (!ownLine) {
    return `${text.slice(0, last.end)}, ${quoted}${text.slice(last.end)}`
  }
  // Multi-line array: add a line after the last element with its indent and comma style.
  const indent = text.slice(lineStart, last.start)
  const lineEnd = indexOfLineEnd(text, last.end)
  const trailingComma = /^\s*,/.test(text.slice(last.end, lineEnd))
  const head = trailingComma
    ? text.slice(0, lineEnd)
    : `${text.slice(0, last.end)},${text.slice(last.end, lineEnd)}`
  return `${head}\n${indent}${quoted}${trailingComma ? ',' : ''}${text.slice(lineEnd)}`
}

function indexOfLineEnd(text: string, from: number): number {
  const index = text.indexOf('\n', from)
  return index === -1 ? text.length : index
}

// ============================================================================
// Scanner
// ============================================================================

/**
 * Walk the document's statements and find `[targets.<name>]` and the compose
 * key that resolves to `targets.<name>.compose`. Returns null on any syntax the
 * scanner does not handle.
 */
function locateTarget(text: string, targetName: string): TargetLocation | null {
  const scanner = new Scanner(text)
  const location: TargetLocation = {}
  let table: string[] = []
  try {
    for (;;) {
      scanner.skipTrivia(true)
      if (scanner.done()) return location
      if (scanner.peek() === '[') {
        if (scanner.peek(1) === '[') {
          scanner.pos += 2
          table = [...scanner.readKey(']'), '[]']
          scanner.expect(']')
          scanner.expect(']')
        } else {
          scanner.pos += 1
          table = scanner.readKey(']')
          scanner.expect(']')
          if (samePath(table, ['targets', targetName])) {
            location.headerLineEnd = scanner.restOfLine()
            continue
          }
        }
        scanner.restOfLine()
        continue
      }
      const key = [...table, ...scanner.readKey('=')]
      scanner.expect('=')
      scanner.skipTrivia(false)
      if (samePath(key, ['targets', targetName, 'compose'])) {
        if (scanner.peek() !== '[') return null
        location.compose = scanner.readStringArray()
      } else {
        scanner.skipValue()
      }
      scanner.restOfLine()
    }
  } catch {
    return null
  }
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i])
}

class Scanner {
  pos = 0
  constructor(private readonly text: string) {}

  done(): boolean {
    return this.pos >= this.text.length
  }

  peek(offset = 0): string {
    return this.text[this.pos + offset] ?? ''
  }

  expect(char: string): void {
    this.skipTrivia(false)
    if (this.peek() !== char) throw new Error(`expected ${char} at ${this.pos}`)
    this.pos += 1
  }

  /** Skip spaces, tabs and comments; newlines too when `newlines` is set. */
  skipTrivia(newlines: boolean): void {
    while (!this.done()) {
      const char = this.peek()
      if (char === ' ' || char === '\t' || char === '\r' || (newlines && char === '\n')) {
        this.pos += 1
      } else if (char === '#') {
        this.pos = indexOfLineEnd(this.text, this.pos)
      } else {
        return
      }
    }
  }

  /** Consume trailing whitespace/comment through the newline; return the offset after it. */
  restOfLine(): number {
    this.skipTrivia(false)
    if (this.peek() === '\n') this.pos += 1
    else if (!this.done()) throw new Error(`unexpected content at ${this.pos}`)
    return this.pos
  }

  /** Read a dotted key up to `terminator` (not consumed). */
  readKey(terminator: string): string[] {
    const parts: string[] = []
    for (;;) {
      this.skipTrivia(false)
      const char = this.peek()
      if (char === '"' || char === "'") {
        const span = this.readString()
        parts.push(TOML.parse(`k = ${this.text.slice(span.start, span.end)}`)['k'] as string)
      } else {
        const match = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.pos))
        if (!match) throw new Error(`bad key at ${this.pos}`)
        parts.push(match[0])
        this.pos += match[0].length
      }
      this.skipTrivia(false)
      if (this.peek() === '.') {
        this.pos += 1
        continue
      }
      if (this.peek() !== terminator) throw new Error(`bad key at ${this.pos}`)
      return parts
    }
  }

  readString(): Span {
    const start = this.pos
    const quote = this.peek()
    const triple = this.text.startsWith(quote.repeat(3), this.pos)
    if (triple) {
      const close = this.text.indexOf(quote.repeat(3), this.pos + 3)
      if (close === -1) throw new Error('unterminated string')
      let end = close + 3
      // Up to two extra quotes may close a multi-line string.
      while (this.text[end] === quote && end - close < 5) end += 1
      this.pos = end
      return { start, end }
    }
    this.pos += 1
    while (!this.done()) {
      const char = this.peek()
      if (char === '\n') break
      if (quote === '"' && char === '\\') {
        this.pos += 2
        continue
      }
      this.pos += 1
      if (char === quote) return { start, end: this.pos }
    }
    throw new Error('unterminated string')
  }

  readStringArray(): ComposeLocation {
    const start = this.pos
    this.pos += 1
    const elements: Span[] = []
    for (;;) {
      this.skipTrivia(true)
      const char = this.peek()
      if (char === ']') {
        this.pos += 1
        return { array: { start, end: this.pos }, elements }
      }
      if (char !== '"' && char !== "'") throw new Error(`non-string compose entry at ${this.pos}`)
      elements.push(this.readString())
      this.skipTrivia(true)
      if (this.peek() === ',') this.pos += 1
      else if (this.peek() !== ']') throw new Error(`bad array at ${this.pos}`)
    }
  }

  /** Skip one value: string, array, inline table or bare scalar. */
  skipValue(): void {
    const char = this.peek()
    if (char === '"' || char === "'") {
      this.readString()
      return
    }
    if (char === '[' || char === '{') {
      const close = char === '[' ? ']' : '}'
      this.pos += 1
      for (;;) {
        this.skipTrivia(true)
        if (this.done()) throw new Error('unterminated value')
        if (this.peek() === close) {
          this.pos += 1
          return
        }
        if (this.peek() === ',') {
          this.pos += 1
          continue
        }
        if (char === '{') {
          this.readKey('=')
          this.expect('=')
          this.skipTrivia(false)
        }
        this.skipValue()
      }
    }
    const match = /^[^\s,\]}#]+/.exec(this.text.slice(this.pos))
    if (!match) throw new Error(`bad value at ${this.pos}`)
    this.pos += match[0].length
    // Local date-times may contain one space ("1979-05-27 07:32:00").
    const rest = /^ \d{2}:[^\s,\]}#]+/.exec(this.text.slice(this.pos))
    if (rest) this.pos += rest[0].length
  }
}
