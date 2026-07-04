import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeSystemPromptArtifact } from '../commands/token-rent.js'

const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function runAsp(args: string[]): string {
  return execFileSync('bun', ['run', ASP_CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

describe('token-rent', () => {
  test('splits resident system prompt artifacts on composed section boundaries', () => {
    const sections = analyzeSystemPromptArtifact(
      ['# Praesidium Platform\nshared motd', '# Clod\nsoul', '# Conventions\nrules'].join(
        '\n\n---\n\n'
      ),
      2
    )

    expect(sections.map((section) => section.source)).toEqual([
      'AGENT_MOTD.md',
      'SOUL.md',
      'conventions.md',
    ])
    expect(sections[0]?.tokensPerDay).toBe((sections[0]?.tokens ?? 0) * 2)
  })

  test('reports live sqlite runs against compiled_runtime_plans systemPromptFile artifacts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'asp-token-rent-'))
    try {
      const db = join(tempDir, 'state.sqlite')
      const agentsRoot = join(tempDir, 'agents')
      const promptFile = join(tempDir, 'system-prompt.md')
      await mkdir(agentsRoot, { recursive: true })
      await writeFile(join(agentsRoot, 'USER.md'), '# User\nboot reminder\n')
      await writeFile(
        promptFile,
        [
          '# Praesidium Platform\nresident platform',
          '# Alice\nresident soul',
          '# Conventions\nresident rules',
        ].join('\n\n---\n\n')
      )

      execFileSync('sqlite3', [
        db,
        [
          'create table runs (scope_ref text not null, updated_at text not null);',
          'create table compiled_runtime_plans (plan_hash text primary key, created_at text not null, plan_projection_json text not null);',
          "insert into runs values ('agent:alice:project:demo:task:one', '2026-06-01T12:00:00.000Z');",
          "insert into runs values ('agent:alice:project:demo:task:two', '2026-06-02T12:00:00.000Z');",
        ].join('\n'),
      ])
      execFileSync('sqlite3', [
        db,
        `insert into compiled_runtime_plans values ('hash1', '2026-06-02T13:00:00.000Z', ${sqlString(
          JSON.stringify({
            placement: {
              agentRoot: join(agentsRoot, 'alice'),
              correlation: { sessionRef: { scopeRef: 'agent:alice:project:demo:task:two' } },
            },
            harness: { family: 'codex' },
            artifacts: { systemPromptFile: promptFile },
          })
        )});`,
      ])

      const stdout = runAsp([
        'token-rent',
        '--agent',
        'alice',
        '--json',
        '--hrc-db',
        db,
        '--agents-root',
        agentsRoot,
        '--usage-since',
        '2026-06-01T00:00:00.000Z',
        '--now',
        '2026-06-03T00:00:00.000Z',
      ])
      const report = JSON.parse(stdout) as {
        agents: Array<{ agent: string; runs: number; sessionsPerDay: number; sections: unknown[] }>
        deadLayerCandidates: Array<{ path: string; regime: string }>
      }

      expect(report.agents[0]?.agent).toBe('alice')
      expect(report.agents[0]?.runs).toBe(2)
      expect(report.agents[0]?.sessionsPerDay).toBe(1)
      expect(report.agents[0]?.sections).toHaveLength(3)
      expect(report.deadLayerCandidates).toContainEqual(
        expect.objectContaining({ path: 'USER.md', regime: 'session-start' })
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
