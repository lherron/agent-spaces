import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

// T-08565 red contract: this is an independent, comparison-only executable
// oracle. Its output must not be broker envelopes or execution authority.
const REPO_ROOT = resolve(import.meta.dir, '../../..')
const RELEASE_ENTRY = join(REPO_ROOT, 'scripts/asp-release/entries/harness-broker.ts')
const RELEASE = {
  releaseId: 'asp-90dd75083a32-20260917T040000Z-red001',
  sourceCommit: '90dd75083a32a78f07c8dc2358175db799e94475',
  builtAt: '2026-09-17T04:00:00.000Z',
}
const SCHEMA = 'harness-broker.offline-evidence/v1'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function artifact(name: string, rows: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'offline-provider-red-'))
  roots.push(root)
  const path = join(root, name)
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  return path
}

async function runProvider(input: {
  artifactPath: string
  afterLine: number
  limit: number
  brokerEvents?: InvocationEventEnvelope[]
  snapshot?: unknown
  maxBytes?: number
}): Promise<{ exitCode: number; stdout: string; response: any }> {
  const child = Bun.spawn(
    [
      'bun',
      `--define=ASP_RELEASE_EMBEDDED_IDENTITY=${JSON.stringify(RELEASE)}`,
      RELEASE_ENTRY,
      'evidence-read',
    ],
    { cwd: REPO_ROOT, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
  )
  child.stdin.write(
    `${JSON.stringify({
      schema: SCHEMA,
      operation: 'providerObservations',
      artifactPath: input.artifactPath,
      afterLine: input.afterLine,
      limit: input.limit,
      ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
      brokerEvents: input.brokerEvents ?? [],
      ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
    })}\n`
  )
  child.stdin.end()
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([code, text]) => [code, text] as const)
  return {
    exitCode,
    stdout,
    response: stdout.trim() === '' ? undefined : JSON.parse(stdout.trim()),
  }
}

function brokerToolEvent(seq: number, command = `printf broker-${seq}`): InvocationEventEnvelope {
  return {
    invocationId: 'inv_provider_compare',
    seq,
    time: new Date(seq * 1000).toISOString(),
    type: 'tool.call.started',
    payload: {
      toolCallId: `call-${seq}`,
      name: 'Bash',
      input: { command },
    },
  } as InvocationEventEnvelope
}

function sumCounts(pages: any[]): Record<string, number> {
  const keys = [
    'lines',
    'parsedRecords',
    'invalidJsonRecords',
    'applicableObservations',
    'ignoredRecords',
    'unsupportedRecords',
    'unknownRecords',
  ]
  return Object.fromEntries(
    keys.map((key) => [key, pages.reduce((total, page) => total + page.counts[key], 0)])
  )
}

describe('T-08565 offline provider comparison oracle', () => {
  test('Codex and Claude tool pairs split across pages equal one-page parsing', async () => {
    const corpora = [
      artifact('codex.jsonl', [
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-cross-page',
            name: 'exec_command',
            arguments: '{"cmd":"date"}',
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-cross-page',
            output: 'Tue',
          },
        },
      ]),
      artifact('claude.jsonl', [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu-cross-page', name: 'Bash', input: { command: 'pwd' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu-cross-page', content: 'workspace' },
            ],
          },
        },
      ]),
    ]

    for (const artifactPath of corpora) {
      const first = await runProvider({ artifactPath, afterLine: 0, limit: 1 })
      expect(first.exitCode).toBe(0)
      expect(first.response.page).toEqual({ scannedThroughLine: 1, hasMore: true })
      const second = await runProvider({
        artifactPath,
        afterLine: 1,
        limit: 1,
        snapshot: first.response.snapshot,
      })
      expect(second.exitCode).toBe(0)
      expect(second.response.snapshot).toEqual(first.response.snapshot)
      expect(second.response.page).toEqual({ scannedThroughLine: 2, hasMore: false })

      const onePage = await runProvider({ artifactPath, afterLine: 0, limit: 100 })
      expect(onePage.exitCode).toBe(0)
      expect([...first.response.observations, ...second.response.observations]).toEqual(
        onePage.response.observations
      )
      expect([...first.response.warnings, ...second.response.warnings]).toEqual(
        onePage.response.warnings
      )
      expect(sumCounts([first.response, second.response])).toEqual(
        expect.objectContaining(sumCounts([onePage.response]))
      )
      expect(first.response.observations[0].correlationKey).toBe(
        second.response.observations[0].correlationKey
      )
    }
  })

  test('broker comparison forms are independently normalized rather than echoing provider observations', async () => {
    // Deliberately divergent inputs are a negative guard against echoing. Import
    // independence and mutated-normalizer disagreement remain separate A7 gates.
    const artifactPath = artifact('codex-divergence.jsonl', [
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'provider-call',
          name: 'exec_command',
          arguments: '{"cmd":"date"}',
        },
      },
    ])
    const run = await runProvider({
      artifactPath,
      afterLine: 0,
      limit: 10,
      brokerEvents: [brokerToolEvent(41, 'printf deliberately-different')],
    })

    expect(run.exitCode).toBe(0)
    expect(run.response.observations).toHaveLength(1)
    expect(run.response.brokerComparisons).toEqual([
      expect.objectContaining({ seq: 41, type: 'tool.call.started' }),
    ])
    expect(run.response.brokerComparisons[0].normalizedPayload).not.toEqual(
      run.response.observations[0].normalizedPayload
    )
    expect(run.response.brokerComparisons[0].payloadHash).not.toBe(
      run.response.observations[0].payloadHash
    )
  })

  test('2001 broker events are complete across capped chunks including a final-cursor call', async () => {
    const artifactPath = artifact('codex-batched.jsonl', [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'one' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'two' }],
        },
      },
    ])
    const events = Array.from({ length: 2001 }, (_, index) => brokerToolEvent(index + 1))

    const first = await runProvider({
      artifactPath,
      afterLine: 0,
      limit: 1,
      brokerEvents: events.slice(0, 1000),
    })
    expect(first.exitCode).toBe(0)
    const second = await runProvider({
      artifactPath,
      afterLine: first.response.page.scannedThroughLine,
      limit: 1,
      snapshot: first.response.snapshot,
      brokerEvents: events.slice(1000, 2000),
    })
    expect(second.exitCode).toBe(0)
    const final = await runProvider({
      artifactPath,
      afterLine: second.response.page.scannedThroughLine,
      limit: 1,
      snapshot: second.response.snapshot,
      brokerEvents: events.slice(2000),
    })
    expect(final.exitCode).toBe(0)
    expect(final.response.observations).toEqual([])
    expect(final.response.page).toEqual({ scannedThroughLine: 2, hasMore: false })

    const allForms = [
      ...first.response.brokerComparisons,
      ...second.response.brokerComparisons,
      ...final.response.brokerComparisons,
    ]
    expect(allForms.map((form: { seq: number }) => form.seq)).toEqual(
      Array.from({ length: 2001 }, (_, index) => index + 1)
    )
    expect(new Set(allForms.map((form: { seq: number }) => form.seq)).size).toBe(2001)
    expect(first.response.snapshot).toEqual(second.response.snapshot)
    expect(second.response.snapshot).toEqual(final.response.snapshot)

    const repeatedFinal = await runProvider({
      artifactPath,
      afterLine: 2,
      limit: 1,
      snapshot: final.response.snapshot,
      brokerEvents: events.slice(2000),
    })
    expect(repeatedFinal.exitCode).toBe(0)
    expect(repeatedFinal.response).toEqual(final.response)
  })

  test('one broker event larger than the stdin cap is typed and never silently omitted', async () => {
    const artifactPath = artifact('codex-oversize.jsonl', [
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'ok' } },
    ])
    const oversized = brokerToolEvent(77, 'x'.repeat(8 * 1024 * 1024))
    const run = await runProvider({
      artifactPath,
      afterLine: 0,
      limit: 1,
      brokerEvents: [oversized],
    })

    expect(run.exitCode).toBe(2)
    expect(run.response).toMatchObject({
      ok: false,
      operation: 'providerObservations',
      error: { code: 'offline_record_too_large', data: { kind: 'broker_event', seq: 77 } },
    })
    expect(run.response.brokerComparisons).toBeUndefined()
  })
})
