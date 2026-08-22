/**
 * T-07319 RED (AC-5, AC-6): REQUIRED_BOUNDARY_CHECKS is wired deliberately, not
 * left dormant. Ruled addendum (b), primary #20151: agent-spaces KEEPS the
 * export as the contract-side statement of the compiler-owns-mechanics
 * invariant and guards its SHAPE here; consumption (running the `rg` targets in
 * hrc-runtime's check-boundaries roster) is WS3/T-07318 and is out of scope.
 *
 * This guard therefore never executes a command, adds a runner, or touches the
 * export or its NOTE block. It also must not defeat the NOTE: every `command`
 * literal in the source is deliberately split mid-token so the file does not
 * match the boundary patterns it ships, and nothing below reunites them —
 * every literal here is derived from the imported constant.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type BoundaryCheck, REQUIRED_BOUNDARY_CHECKS } from '../src/boundary-checks'

const SEVERITIES = new Set(['warning', 'error'])

/**
 * POSIX-ish word lexer: enough to prove a command is a well-formed word list
 * with balanced quoting. Returns undefined for an unterminated quote.
 */
function shellWords(command: string): string[] | undefined {
  const words: string[] = []
  let current = ''
  let started = false
  let quote: "'" | '"' | undefined

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (character === undefined) {
      continue
    }
    if (character === '\\' && quote !== "'" && index + 1 < command.length) {
      current += command[index + 1] ?? ''
      started = true
      index += 1
      continue
    }
    if (quote) {
      if (character === quote) {
        quote = undefined
        continue
      }
      current += character
      started = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      started = true
      continue
    }
    if (/\s/.test(character)) {
      if (started) {
        words.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += character
    started = true
  }

  if (quote) {
    return undefined
  }
  if (started) {
    words.push(current)
  }
  return words
}

/** Pure predicate: the per-check half of AC-5(a) and AC-5(b). */
function boundaryCheckProblems(check: BoundaryCheck): string[] {
  const problems: string[] = []
  if (typeof check.id !== 'string' || check.id.trim().length === 0) {
    problems.push('id must be a non-empty string')
  }
  if (typeof check.description !== 'string' || check.description.trim().length === 0) {
    problems.push('description must be a non-empty string')
  }
  if (!SEVERITIES.has(check.severity)) {
    problems.push(`severity must be warning|error, got ${String(check.severity)}`)
  }
  if (check.allowedPaths !== undefined) {
    if (!Array.isArray(check.allowedPaths) || check.allowedPaths.length === 0) {
      problems.push('allowedPaths, when present, must be a non-empty array')
    } else if (
      check.allowedPaths.some((path) => typeof path !== 'string' || path.trim().length === 0)
    ) {
      problems.push('allowedPaths entries must be non-empty strings')
    }
  }

  const command = check.command
  if (typeof command !== 'string' || !command.startsWith('rg ')) {
    problems.push('command must begin with the ripgrep invocation')
    return problems
  }
  const words = shellWords(command)
  if (!words) {
    problems.push('command has an unterminated quote')
    return problems
  }
  if (words.length < 2) {
    problems.push('command must lex to at least two words')
  }
  if (!words.slice(1).some((word) => !word.startsWith('-'))) {
    problems.push('command must carry at least one non-flag path word')
  }
  return problems
}

describe('REQUIRED_BOUNDARY_CHECKS', () => {
  test('AC-5: shape holds, commands parse, and the split literals stay split', () => {
    expect(Array.isArray(REQUIRED_BOUNDARY_CHECKS)).toBe(true)
    expect(REQUIRED_BOUNDARY_CHECKS.length).toBeGreaterThan(0)

    const problems = REQUIRED_BOUNDARY_CHECKS.flatMap((check) =>
      boundaryCheckProblems(check).map((problem) => `${check.id}: ${problem}`)
    )
    expect(problems).toEqual([])

    const ids = REQUIRED_BOUNDARY_CHECKS.map((check) => check.id)
    expect(ids).toEqual([...new Set(ids)])

    // Split-literal safety: neither the source that ships the checks nor this
    // guard may contain a whole command verbatim.
    const sourcePath = fileURLToPath(new URL('../src/boundary-checks.ts', import.meta.url))
    const source = readFileSync(sourcePath, 'utf8')
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const reunited = REQUIRED_BOUNDARY_CHECKS.flatMap((check) => [
      ...(source.includes(check.command) ? [`${check.id}: verbatim in boundary-checks.ts`] : []),
      ...(self.includes(check.command) ? [`${check.id}: verbatim in the guard`] : []),
    ])
    expect(reunited).toEqual([])
  })

  test('AC-6: the shape predicate rejects malformed checks', () => {
    const valid: BoundaryCheck = {
      id: 'example-check',
      description: 'Example check used only as the negative control baseline.',
      command: "rg 'example-pattern' packages/example/src",
      severity: 'error',
    }
    expect(boundaryCheckProblems(valid)).toEqual([])

    const malformed: Array<{ label: string; check: BoundaryCheck }> = [
      {
        label: 'bad severity',
        check: { ...valid, severity: 'fatal' as BoundaryCheck['severity'] },
      },
      {
        label: 'not a ripgrep invocation',
        check: { ...valid, command: "grep -r 'example-pattern' packages/example/src" },
      },
      {
        label: 'unterminated quote',
        check: { ...valid, command: "rg 'example-pattern packages/example/src" },
      },
    ]

    const accepted = malformed
      .filter((fixture) => boundaryCheckProblems(fixture.check).length === 0)
      .map((fixture) => fixture.label)
    expect(accepted).toEqual([])
  })
})
