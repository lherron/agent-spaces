/**
 * Generator for the scope and env contract fixtures (README.md).
 *
 *   bun conformance/generate.ts          write scope-cases.json and the env table in the doc
 *   bun conformance/generate.ts --check  exit 1 if either differs from what would be written
 *
 * scope-cases.json is computed: inputs from scope-case-inputs.ts, every `ok`
 * and `refuse` from the package's own functions. env-table.json is the source
 * of the rendered table in docs/identity-scope-and-env-contract.md.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ScopeGrammarError } from '../src/errors.js'
import { projectScopeIdentity } from '../src/identity-projection.js'
import { ASP_DEFAULT_TASK_ENV, resolveQualifiedScopeInput } from '../src/input.js'
import { normalizeLaneRef } from '../src/lane-ref.js'
import { formatScopeHandle, parseScopeHandle } from '../src/scope-handle.js'
import { formatScopeRef, parseScopeRef } from '../src/scope-ref.js'
import { parseSessionHandle } from '../src/session-handle.js'
import { formatSessionRef, parseSessionRef } from '../src/session-ref.js'
import type { LaneRef, ParsedScopeRef } from '../src/types.js'
import { SCOPE_CASE_INPUTS, type ScopeCaseInput } from './scope-case-inputs.js'

export const CONFORMANCE_DIR = dirname(fileURLToPath(import.meta.url))
export const SCOPE_CASES_PATH = join(CONFORMANCE_DIR, 'scope-cases.json')
export const ENV_TABLE_PATH = join(CONFORMANCE_DIR, 'env-table.json')
export const ENV_DOC_PATH = join(
  CONFORMANCE_DIR,
  '../../../docs/identity-scope-and-env-contract.md'
)

export type ScopeCase = ScopeCaseInput & ({ ok: unknown } | { refuse: string })

export type ScopeCasesDoc = {
  version: 1
  generatedBy: string
  cases: ScopeCase[]
}

function parts(parsed: {
  kind: string
  agentId: string
  projectId?: string
  taskId?: string
  roleName?: string
}) {
  const { kind, agentId, projectId, taskId, roleName } = parsed
  return {
    kind,
    agentId,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(roleName !== undefined ? { roleName } : {}),
  }
}

function withEnvDefaultTask<T>(value: string | undefined, run: () => T): T {
  const saved = process.env[ASP_DEFAULT_TASK_ENV]
  if (value === undefined) delete process.env[ASP_DEFAULT_TASK_ENV]
  else process.env[ASP_DEFAULT_TASK_ENV] = value
  try {
    return run()
  } finally {
    if (saved === undefined) delete process.env[ASP_DEFAULT_TASK_ENV]
    else process.env[ASP_DEFAULT_TASK_ENV] = saved
  }
}

/** Run one case's operation through the package. Throws what the package throws. */
export function runScopeCase(c: ScopeCaseInput): unknown {
  switch (c.op) {
    case 'scopeRef.parse':
      return parts(parseScopeRef(c.in))
    case 'scopeRef.format':
      // formatScopeRef reads only the parts; kind and scopeRef are not inputs.
      return formatScopeRef(c.in as ParsedScopeRef)
    case 'scopeHandle.parse':
      return parseScopeHandle(c.in).scopeRef
    case 'scopeHandle.format':
      return formatScopeHandle(parseScopeRef(c.in))
    case 'laneRef.normalize':
      return normalizeLaneRef(c.in ?? undefined)
    case 'sessionHandle.parse':
      return parseSessionHandle(c.in)
    case 'sessionRef.parse':
      return parseSessionRef(c.in)
    case 'sessionRef.format':
      return formatSessionRef({ scopeRef: c.in.scopeRef, laneRef: c.in.laneRef as LaneRef })
    case 'input.resolve': {
      const { envDefaultTask, ...opts } = c.opts
      const resolved = withEnvDefaultTask(envDefaultTask, () =>
        resolveQualifiedScopeInput(c.in, opts)
      )
      return { scopeRef: resolved.scopeRef, laneRef: resolved.laneRef }
    }
    case 'identity.project':
      return projectScopeIdentity(c.in)
  }
}

export function generateScopeCases(): ScopeCasesDoc {
  const ids = new Set<string>()
  const cases = SCOPE_CASE_INPUTS.map((c): ScopeCase => {
    if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id}`)
    ids.add(c.id)
    try {
      return { ...c, ok: runScopeCase(c) }
    } catch (error) {
      if (error instanceof ScopeGrammarError && c.op !== 'identity.project') {
        return { ...c, refuse: error.code }
      }
      throw new Error(`${c.id}: ${c.op} threw an error without a refusal code: ${String(error)}`)
    }
  })
  return { version: 1, generatedBy: 'contracts/agent-scope/conformance/generate.ts', cases }
}

/** One case per line, so a diff names the case that changed. */
export function serializeCases(
  doc: { cases: readonly unknown[] } & Record<string, unknown>
): string {
  const { cases, ...head } = doc
  const headJson = JSON.stringify(head)
  const lines = cases.map((c) => `    ${JSON.stringify(c)}`)
  return `${headJson.slice(0, -1)},\n  "cases": [\n${lines.join(',\n')}\n  ]\n}\n`
}

// --- env table ---------------------------------------------------------------

export type EnvWriter = { writer: string; when?: string }

export type EnvTableRow = {
  name: string
  format: string
  class: string
  copyOf?: string
  managed: EnvWriter[]
  unmanaged: EnvWriter[]
  readers: string[]
  note?: string
}

export type EnvTable = {
  version: 1
  writers: Record<string, string>
  classes: Record<string, string>
  rows: EnvTableRow[]
}

const DOC_BEGIN =
  '<!-- env-table:begin — generated from contracts/agent-scope/conformance/env-table.json by conformance/generate.ts; edit the JSON, then run `bun conformance/generate.ts` -->'
const DOC_END = '<!-- env-table:end -->'

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function writers(list: EnvWriter[]): string {
  if (list.length === 0) return 'not written'
  return list.map((w) => (w.when ? `${w.writer} (${w.when})` : w.writer)).join('; ')
}

export function renderEnvTable(table: EnvTable): string {
  const out: string[] = [DOC_BEGIN, '']
  out.push('Writers, by the step of the composition order that has the last word:', '')
  for (const [id, text] of Object.entries(table.writers)) out.push(`- \`${id}\`: ${text}`)
  out.push('', 'Classes:', '')
  for (const [id, text] of Object.entries(table.classes)) out.push(`- **${id}**: ${text}`)
  out.push(
    '',
    '| Variable | Format | Class | Managed writer | Unmanaged writer | Known readers |',
    '| --- | --- | --- | --- | --- | --- |'
  )
  for (const row of table.rows) {
    const cls = row.copyOf ? `${row.class} of \`${row.copyOf}\`` : row.class
    const format = row.note ? `${row.format} — ${row.note}` : row.format
    out.push(
      `| \`${row.name}\` | ${cell(format)} | ${cell(cls)} | ${cell(writers(row.managed))} | ${cell(
        writers(row.unmanaged)
      )} | ${row.readers.length === 0 ? 'none recorded' : row.readers.join(', ')} |`
    )
  }
  out.push('', DOC_END)
  return out.join('\n')
}

export function applyEnvTable(docText: string, table: EnvTable): string {
  const begin = docText.indexOf('<!-- env-table:begin')
  const end = docText.indexOf(DOC_END)
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error('env table markers not found in docs/identity-scope-and-env-contract.md')
  }
  return docText.slice(0, begin) + renderEnvTable(table) + docText.slice(end + DOC_END.length)
}

export function readEnvTable(): EnvTable {
  return JSON.parse(readFileSync(ENV_TABLE_PATH, 'utf8')) as EnvTable
}

function main(argv: string[]): number {
  const check = argv.includes('--check')
  const outputs: Array<[string, string]> = [
    [SCOPE_CASES_PATH, serializeCases(generateScopeCases())],
    [ENV_DOC_PATH, applyEnvTable(readFileSync(ENV_DOC_PATH, 'utf8'), readEnvTable())],
  ]
  let stale = 0
  for (const [path, text] of outputs) {
    let current: string | undefined
    try {
      current = readFileSync(path, 'utf8')
    } catch {
      current = undefined
    }
    if (current === text) continue
    if (check) {
      stale++
      process.stderr.write(`stale: ${path}\n`)
    } else {
      writeFileSync(path, text)
      process.stdout.write(`wrote ${path}\n`)
    }
  }
  return stale === 0 ? 0 : 1
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
