/**
 * Summary line for exec-shaped `tool.call.started` events (T-10932).
 *
 * A tool call is exec-shaped when its input carries a string `cmd` /
 * `command`, an argv-array `command`, or a code-mode `codeMode` program.
 * Every other tool (Read, Edit, Grep, MCP, Agent, …) gets no summary.
 *
 * Precedence: driver-supplied summary > non-empty `input.description` (Claude
 * Code's model-written line) > derived `Running <prog>...` > `Running <name>...`.
 */

/** Tools whose `command` input is a payload, not a shell command. */
const NON_EXEC_TOOLS = new Set(['apply_patch'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

export function toolCallSummary(
  name: string,
  input: unknown,
  existing?: unknown
): string | undefined {
  if (typeof existing === 'string' && existing.trim().length > 0) return existing
  if (NON_EXEC_TOOLS.has(name) || input === null || typeof input !== 'object') return undefined
  const fields = input as Record<string, unknown>

  let programs: string[] | undefined
  if (typeof fields['codeMode'] === 'string') {
    programs = codeModePrograms(fields['codeMode'])
  } else {
    const command = typeof fields['cmd'] === 'string' ? fields['cmd'] : fields['command']
    if (typeof command === 'string') {
      programs = listOf(scriptProgram(command))
    } else if (isArgv(command)) {
      programs = listOf(argvProgram(command))
    }
  }
  if (programs === undefined) return undefined

  const description = fields['description']
  if (typeof description === 'string' && description.trim().length > 0) {
    return collapse(description)
  }
  return collapse(`Running ${programs.length > 0 ? programs.join(', ') : name}...`)
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function listOf(program: string | undefined): string[] {
  return program === undefined ? [] : [program]
}

function isArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((arg) => typeof arg === 'string')
}

// ---------------------------------------------------------------------------
// Codex code mode: string-literal `cmd:` scans only.
// ---------------------------------------------------------------------------

function codeModePrograms(code: string): string[] {
  const programs: string[] = []
  const add = (program: string | undefined) => {
    if (program !== undefined && !programs.includes(program)) programs.push(program)
  }
  for (const match of code.matchAll(/\bcmd\s*:\s*(["'`])/g)) {
    const literal = readJsLiteral(code, (match.index ?? 0) + match[0].length - 1)
    if (literal !== undefined) add(scriptProgram(literal))
  }
  if (programs.length > 0) return programs
  for (const match of code.matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/g)) add(match[1])
  return programs
}

/**
 * Decode the JS string literal opening at `start`. A template literal yields
 * its prefix up to the first `${`.
 */
function readJsLiteral(code: string, start: number): string | undefined {
  const quote = code[start]
  let out = ''
  for (let i = start + 1; i < code.length; i += 1) {
    const ch = code[i] as string
    if (ch === quote) return out
    if (quote === '`' && ch === '$' && code[i + 1] === '{') return out
    if (ch === '\\') {
      i += 1
      const next = code[i]
      if (next === undefined) return undefined
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next
      continue
    }
    out += ch
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Shell: first program of the script after unwrapping.
// ---------------------------------------------------------------------------

function argvProgram(argv: string[]): string | undefined {
  const head = basename(argv[0] as string)
  if (SHELLS.has(head)) {
    const flag = argv.findIndex((arg, i) => i > 0 && /^-[a-z]*c$/.test(arg))
    const script = flag >= 0 ? argv[flag + 1] : undefined
    if (script !== undefined) return scriptProgram(script)
  }
  return programFromWords(argv)
}

/** First program of a shell script, skipping `cd` segments. */
function scriptProgram(script: string): string | undefined {
  for (const words of shellSegments(script)) {
    const program = programFromWords(words)
    if (program !== undefined) return program
  }
  return undefined
}

function programFromWords(words: string[]): string | undefined {
  let i = 0
  const skipAssignments = () => {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i += 1
  }
  skipAssignments()
  if (i < words.length && basename(words[i] as string) === 'env') {
    i += 1
    while (i < words.length && (words[i] as string).startsWith('-')) {
      i += (words[i] as string) === '-u' ? 2 : 1
    }
    skipAssignments()
  }
  const word = words[i]
  if (word === undefined) return undefined
  const program = basename(word)
  if (program === 'cd' || program.length === 0) return undefined
  if (SHELLS.has(program)) {
    const rest = words.slice(i)
    const flag = rest.findIndex((arg, j) => j > 0 && /^-[a-z]*c$/.test(arg))
    const script = flag >= 0 ? rest[flag + 1] : undefined
    if (script !== undefined) return scriptProgram(script) ?? program
  }
  return program
}

function basename(word: string): string {
  const parts = word.split('/')
  return parts[parts.length - 1] ?? word
}

/**
 * Split a script into word lists at unquoted `;`, `&`, `|` and newlines,
 * honouring single/double quotes, `$(…)` and backslash escapes.
 */
function shellSegments(script: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i] as string
    if (ch === "'") {
      const close = script.indexOf("'", i + 1)
      word += script.slice(i + 1, close < 0 ? script.length : close)
      inWord = true
      i = close < 0 ? script.length : close
    } else if (ch === '"') {
      inWord = true
      for (i += 1; i < script.length && script[i] !== '"'; i += 1) {
        if (script[i] === '\\' && i + 1 < script.length) i += 1
        word += script[i]
      }
    } else if (ch === '$' && script[i + 1] === '(') {
      // Command substitution stays inside the current word.
      let depth = 0
      for (; i < script.length; i += 1) {
        const c = script[i] as string
        word += c
        if (c === '(') depth += 1
        else if (c === ')' && --depth === 0) break
      }
      inWord = true
    } else if (ch === '\\' && i + 1 < script.length) {
      i += 1
      if (script[i] !== '\n') {
        word += script[i]
        inWord = true
      }
    } else if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      endSegment()
    } else if (ch === ' ' || ch === '\t') {
      endWord()
    } else {
      word += ch
      inWord = true
    }
  }
  endSegment()
  return segments
}
