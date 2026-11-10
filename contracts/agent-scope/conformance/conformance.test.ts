import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  SCOPE_ERROR_CODES,
  type ScopeErrorCode,
  ScopeGrammarError,
  parseScopeRef,
  validateScopeRef,
} from '../src/index.js'
import {
  ENV_DOC_PATH,
  SCOPE_CASES_PATH,
  applyEnvTable,
  generateScopeCases,
  readEnvTable,
} from './generate.js'

const committed = JSON.parse(readFileSync(SCOPE_CASES_PATH, 'utf8')) as ReturnType<
  typeof generateScopeCases
>

describe('scope grammar fixture', () => {
  test('scope-cases.json is exactly what the package generates', () => {
    // Fails on any hand edit: a changed ok/refuse, input, added or removed case.
    // Fix by editing scope-case-inputs.ts and running `bun conformance/generate.ts`.
    expect(committed).toEqual(generateScopeCases())
  })

  test('every refusal is one of the five codes and every operation has cases', () => {
    const ops = new Set<string>()
    for (const c of committed.cases) {
      ops.add(c.op)
      if ('refuse' in c) expect(SCOPE_ERROR_CODES).toContain(c.refuse as never)
    }
    expect([...ops].sort()).toEqual([
      'identity.project',
      'input.resolve',
      'laneRef.normalize',
      'scopeHandle.format',
      'scopeHandle.parse',
      'scopeRef.format',
      'scopeRef.parse',
      'sessionHandle.parse',
      'sessionRef.format',
      'sessionRef.parse',
    ])
  })
})

describe('refusal codes on the package entry point', () => {
  test('a grammar error is a ScopeGrammarError carrying its code, message and name unchanged', () => {
    let thrown: unknown
    try {
      parseScopeRef('agent:')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ScopeGrammarError)
    expect(thrown).toBeInstanceOf(Error)
    const error = thrown as ScopeGrammarError
    const code: ScopeErrorCode = error.code
    expect(code).toBe('token_invalid')
    expect(error.name).toBe('Error')
    expect(error.message).toBe('Invalid ScopeRef "agent:": agentId must be 1..64 characters, got 0')
    expect(validateScopeRef('agent:')).toEqual({
      ok: false,
      error: 'agentId must be 1..64 characters, got 0',
      code: 'token_invalid',
    })
  })
})

describe('env table', () => {
  test('the rendered table in the doc is generated from env-table.json', () => {
    const doc = readFileSync(ENV_DOC_PATH, 'utf8')
    expect(doc).toBe(applyEnvTable(doc, readEnvTable()))
  })
})
