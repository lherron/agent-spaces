/**
 * asp output must survive a slow pipe reader (T-10368).
 *
 * Bun puts fd 1 into O_NONBLOCK as soon as `process.stdout` is materialized
 * (chalk's color probe does it), after which `console.log` silently drops
 * everything past the ~64 KB pipe buffer when the reader lags. This drives the
 * real asp binary through `| (sleep 1; cat)` with a >200 KB JSON report.
 */

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')
const MIN_REPORT_BYTES = 200 * 1024

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Run asp with its stdout piped into a reader that waits 1s before draining. */
function runAspThroughSlowReader(args: string[]): string {
  return execFileSync('sh', ['-c', '"$@" | (sleep 1; cat)', 'sh', 'bun', 'run', ASP_CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function runAspToFile(args: string[]): string {
  return execFileSync('bun', ['run', ASP_CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

describe('asp stdout through a slow pipe', () => {
  test('token-rent --json delivers a >200 KB report intact to a reader that lags', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'asp-slow-pipe-'))
    try {
      const db = join(tempDir, 'state.sqlite')
      const agentsRoot = join(tempDir, 'agents')
      const promptFile = join(tempDir, 'system-prompt.md')
      await mkdir(agentsRoot, { recursive: true })
      // Every section becomes one report row, so enough sections push the JSON past 200 KB.
      const sections = Array.from(
        { length: 600 },
        (_, i) => `# Section ${i}\n${'resident text '.repeat(20)}`
      )
      await writeFile(promptFile, sections.join('\n\n---\n\n'))

      const spec = {
        specVersion: 'harness-broker.invocation/v1',
        invocationId: 'inv-a',
        harness: { frontend: 'claude-code', driver: 'claude-code-tmux' },
        process: { command: 'claude', args: [], cwd: tempDir, lockedEnv: {} },
        launch: { systemPromptFile: promptFile, systemPromptMode: 'append' },
        correlation: { scopeRef: 'agent:alice:project:demo' },
      }
      execFileSync('sqlite3', [
        db,
        [
          'create table runs (scope_ref text not null, lane_ref text not null, updated_at text not null);',
          'create table continuities (scope_ref text not null, lane_ref text not null, agent_id text not null, primary key(scope_ref, lane_ref));',
          'create table broker_invocations (invocation_id text primary key, broker_driver text not null, spec_projection_json text, created_at text not null);',
          "insert into continuities values ('agent:alice:project:demo', 'main', 'alice');",
          "insert into runs values ('agent:alice:project:demo', 'main', '2026-10-01T12:00:00.000Z');",
          `insert into broker_invocations values ('inv-a', 'claude-code-tmux', ${sqlString(JSON.stringify(spec))}, '2026-10-01T12:00:00.000Z');`,
        ].join('\n'),
      ])

      const args = [
        'token-rent',
        '--agent',
        'alice',
        '--json',
        '--hrc-db',
        db,
        '--agents-root',
        agentsRoot,
        '--usage-since',
        '2026-10-01T00:00:00.000Z',
        '--now',
        '2026-10-03T00:00:00.000Z',
      ]
      const reference = runAspToFile(args)
      expect(Buffer.byteLength(reference)).toBeGreaterThan(MIN_REPORT_BYTES)

      const piped = runAspThroughSlowReader(args)
      expect(Buffer.byteLength(piped)).toBe(Buffer.byteLength(reference))
      const report = JSON.parse(piped) as { agents: Array<{ sections: unknown[] }> }
      expect(report.agents[0]?.sections).toHaveLength(600)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }, 60_000)
})
