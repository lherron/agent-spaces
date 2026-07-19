import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentInspectionDisposition,
  AgentInspectionProvenance,
} from 'spaces-runtime-contracts'
import { type ResolvedContextSection, resolveContextTemplateDetailed } from './context-resolver.js'
import type { ContextTemplate } from './context-template.js'
import { inspectAgentSystemPrompt } from './system-prompt.js'

type ProvenanceReport = ResolvedContextSection & {
  disposition: AgentInspectionDisposition
  provenance: AgentInspectionProvenance
}

describe('T-06329 compilation provenance', () => {
  let tempRoot: string
  let agentRoot: string
  let agentsRoot: string
  let projectRoot: string
  let aspHome: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'compilation-provenance-'))
    agentRoot = join(tempRoot, 'agent')
    agentsRoot = join(tempRoot, 'agents')
    projectRoot = join(tempRoot, 'project')
    aspHome = join(tempRoot, 'asp-home')
    for (const directory of [agentRoot, agentsRoot, projectRoot, aspHome]) {
      await mkdir(directory, { recursive: true })
    }
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('preserves non-zero, timeout, and missing-command exec failures without compiling their output', async () => {
    const nonzeroCommand =
      "printf 'NONZERO-LEAK'; printf 'stderr-start:' >&2; printf 'x%.0s' {1..12000} >&2; printf ':stderr-end' >&2; exit 23"
    const timeoutCommand = "printf 'TIMEOUT-LEAK'; printf 'timeout-stderr' >&2; sleep 6"
    const missingCommand = 't06329-command-that-does-not-exist'
    const resolved = await resolveContextTemplateDetailed(
      template({
        promptSections: [
          { name: 'stable', type: 'inline', content: 'stable prompt' },
          { name: 'nonzero', type: 'exec', command: nonzeroCommand },
          { name: 'timeout', type: 'exec', command: timeoutCommand },
          { name: 'missing-command', type: 'exec', command: missingCommand },
        ],
      }),
      context()
    )

    expect(resolved.prompt?.content).toBe('stable prompt')
    expect(resolved.prompt?.content).not.toContain('NONZERO-LEAK')
    expect(resolved.prompt?.content).not.toContain('TIMEOUT-LEAK')

    const failures = resolved.promptSections.slice(1).map(asProvenanceReport)
    for (const [index, report] of failures.entries()) {
      expect(report.disposition).toMatchObject({
        kind: 'failed',
        source: { kind: 'exec' },
      })
      expectFailedExecReason(report.disposition)
      expectResolutionMetadata(report, index + 1)
    }

    expect(failures[0]?.disposition).toMatchObject({
      source: { kind: 'exec', command: nonzeroCommand },
    })
    const nonzeroReason = failedReason(failures[0]?.disposition)
    expect(nonzeroReason).toContain('23')
    expect(nonzeroReason).toContain('stderr-start:')
    expect(nonzeroReason).not.toContain(':stderr-end')
    expect(nonzeroReason.length).toBeLessThanOrEqual(8192)

    expect(failedReason(failures[1]?.disposition)).toMatch(/timeout[^\n]*true/i)
    expect(failedReason(failures[1]?.disposition)).toContain('timeout-stderr')
    expect(failures[2]?.disposition).toMatchObject({
      source: { kind: 'exec', command: missingCommand },
    })
    expect(failedReason(failures[2]?.disposition)).toContain('127')
    expect(failedReason(failures[2]?.disposition)).toMatch(/not found/i)
  }, 10_000)

  test('distinguishes successful empty exec and optional missing file from unreadable file', async () => {
    const unreadablePath = join(agentRoot, 'unreadable.md')
    await writeFile(unreadablePath, 'must not compile')
    await chmod(unreadablePath, 0o000)

    const resolved = await resolveContextTemplateDetailed(
      template({
        promptSections: [
          { name: 'empty-exec', type: 'exec', command: "printf ''" },
          {
            name: 'optional-missing',
            type: 'file',
            path: 'agent-root:///missing.md',
          },
          {
            name: 'unreadable',
            type: 'file',
            path: 'agent-root:///unreadable.md',
          },
        ],
      }),
      context()
    )

    const [emptyExec, optionalMissing, unreadable] = resolved.promptSections.map(asProvenanceReport)
    expect(emptyExec?.disposition).toEqual({ kind: 'skipped', reason: 'empty' })
    expect(optionalMissing?.disposition).toEqual({ kind: 'skipped', reason: 'empty' })
    expect(unreadable?.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'file', ref: 'agent-root:///unreadable.md' },
    })
    expect(failedReason(unreadable?.disposition)).toMatch(/unreadable|EACCES|permission/i)
    expect(emptyExec?.disposition).not.toEqual(unreadable?.disposition)
    expect(optionalMissing?.disposition).not.toEqual(unreadable?.disposition)
  })

  test('keeps prompt and reminder bytes pinned across success, failure, predicate skip, and empty', async () => {
    const resolved = await resolveContextTemplateDetailed(
      template({
        promptSections: [
          { name: 'prompt-success', type: 'inline', content: 'prompt-ok' },
          {
            name: 'prompt-failure',
            type: 'exec',
            command: "printf 'FAILED-PROMPT-BYTES'; exit 9",
          },
          {
            name: 'prompt-predicate-skip',
            type: 'inline',
            content: 'PREDICATE-PROMPT-BYTES',
            when: { runMode: 'heartbeat' },
          },
          { name: 'prompt-empty', type: 'inline', content: '' },
        ],
        reminderSections: [
          { name: 'reminder-success', type: 'inline', content: 'reminder-ok' },
          {
            name: 'reminder-failure',
            type: 'exec',
            command: "printf 'FAILED-REMINDER-BYTES'; exit 10",
          },
          {
            name: 'reminder-predicate-skip',
            type: 'inline',
            content: 'PREDICATE-REMINDER-BYTES',
            when: { runMode: 'heartbeat' },
          },
          { name: 'reminder-empty', type: 'exec', command: "printf ''" },
        ],
      }),
      context()
    )

    expect(resolved.prompt).toEqual({ content: 'prompt-ok', mode: 'replace' })
    expect(resolved.reminder).toBe('reminder-ok')
  })

  test('distinguishes service probe execution failure from a probe that ran and reported down', async () => {
    const failed = await resolveContextTemplateDetailed(
      template({
        promptSections: [
          {
            name: 'invalid-probe',
            type: 'service-probe',
            services: [{ name: 'invalid', endpoint: 'not-a-probeable-endpoint' }],
          },
        ],
      }),
      context()
    )
    const failedReport = asProvenanceReport(failed.promptSections[0])
    expect(failedReport.disposition).toMatchObject({
      kind: 'failed',
      source: { kind: 'service-probe', services: ['invalid'] },
    })
    expect(failedReason(failedReport.disposition)).toMatch(/execute|invalid|unsupported|probe/i)
    expect(failed.prompt).toBeUndefined()

    const down = await resolveContextTemplateDetailed(
      template({
        promptSections: [
          {
            name: 'down-probe',
            type: 'service-probe',
            services: [{ name: 'broker', endpoint: 'tcp://127.0.0.1:1' }],
          },
        ],
      }),
      context({
        serviceProbeResponses: [{ name: 'broker', endpoint: 'tcp://127.0.0.1:1', up: false }],
      })
    )
    const downReport = asProvenanceReport(down.promptSections[0])
    expect(downReport.disposition).toEqual({ kind: 'effective' })
    expect(downReport.content).toContain('❌')
    expect(downReport.content).toContain('broker')
    expect(down.prompt?.content).toBe(downReport.content)
  })

  test('reports the winning and shadowed template candidates plus deduplicated search roots', async () => {
    const shadowRoot = join(tempRoot, 'shadow-root')
    await mkdir(shadowRoot, { recursive: true })
    await writeFile(
      join(agentRoot, 'agent-profile.toml'),
      'schemaVersion = 2\n\n[instructions]\ntemplate = "selected.toml"\n'
    )
    const selectedPath = join(agentRoot, 'selected.toml')
    const shadowedPath = join(shadowRoot, 'selected.toml')
    await writeFile(selectedPath, promptTemplate('selected template'))
    await writeFile(shadowedPath, promptTemplate('shadowed template'))

    const inspected = await inspectAgentSystemPrompt({
      agentRoot,
      agentsRoot,
      agentRootSearchPath: [shadowRoot, shadowRoot, agentsRoot],
      aspHome,
      projectRoot,
      runMode: 'task',
    })

    expect(inspected?.prompt.content).toBe('selected template')
    const records = collectDispositionRecords(inspected)
    const winner = findDispositionRecord(records, 'effective', selectedPath)
    const shadowed = findDispositionRecord(records, 'overridden', shadowedPath)
    const duplicateRoot = findDispositionRecord(records, 'deduplicated', shadowRoot)

    expect(winner).toBeDefined()
    expect(shadowed?.disposition).toMatchObject({
      kind: 'overridden',
      byPartId: expect.any(String),
    })
    expect(duplicateRoot?.disposition).toMatchObject({
      kind: 'deduplicated',
      canonicalPartId: expect.any(String),
    })
    expect(winner?.provenance?.contributions.length).toBeGreaterThan(0)
    expect(shadowed?.provenance?.contributions.length).toBeGreaterThan(0)
    expect(duplicateRoot?.provenance?.contributions.length).toBeGreaterThan(0)
  })

  function context(overrides: Record<string, unknown> = {}) {
    return {
      agentRoot,
      agentsRoot,
      projectRoot,
      runMode: 'task',
      execCwd: agentRoot,
      execEnv: {},
      ...overrides,
    }
  }
})

function template(overrides: Partial<ContextTemplate>): ContextTemplate {
  return {
    schemaVersion: 2,
    mode: 'replace',
    promptSections: [],
    reminderSections: [],
    ...overrides,
  } as ContextTemplate
}

function asProvenanceReport(
  report: ResolvedContextSection | undefined
): ProvenanceReport | undefined {
  return report as ProvenanceReport | undefined
}

function failedReason(disposition: AgentInspectionDisposition | undefined): string {
  expect(disposition?.kind).toBe('failed')
  return disposition?.kind === 'failed' ? disposition.reason : ''
}

function expectFailedExecReason(disposition: AgentInspectionDisposition | undefined): void {
  const reason = failedReason(disposition)
  expect(reason).toMatch(/exit[ -]?code/i)
  expect(reason).toMatch(/signal/i)
  expect(reason).toMatch(/timeout/i)
  expect(reason).toMatch(/stderr/i)
}

function expectResolutionMetadata(report: ProvenanceReport | undefined, order: number): void {
  expect(report?.provenance.contributions.length).toBeGreaterThan(0)
  const metadata = collectObjects(report).find(
    (candidate) =>
      typeof candidate['stage'] === 'string' &&
      typeof candidate['operation'] === 'string' &&
      candidate['order'] === order
  )
  expect(metadata).toBeDefined()
}

type DispositionRecord = Record<string, unknown> & {
  disposition: AgentInspectionDisposition
  provenance?: AgentInspectionProvenance | undefined
}

function collectDispositionRecords(value: unknown): DispositionRecord[] {
  return collectObjects(value).filter((candidate): candidate is DispositionRecord => {
    const disposition = candidate['disposition']
    return (
      typeof disposition === 'object' &&
      disposition !== null &&
      typeof (disposition as Record<string, unknown>)['kind'] === 'string'
    )
  })
}

function findDispositionRecord(
  records: DispositionRecord[],
  kind: AgentInspectionDisposition['kind'],
  sourceRef: string
): DispositionRecord | undefined {
  return records.find(
    (record) => record.disposition.kind === kind && JSON.stringify(record).includes(sourceRef)
  )
}

function collectObjects(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(collectObjects)
  }
  if (typeof value !== 'object' || value === null) {
    return []
  }
  const record = value as Record<string, unknown>
  return [record, ...Object.values(record).flatMap(collectObjects)]
}

function promptTemplate(content: string): string {
  return `schema_version = 2
mode = "replace"

[[prompt]]
name = "content"
type = "inline"
content = "${content}"
`
}
