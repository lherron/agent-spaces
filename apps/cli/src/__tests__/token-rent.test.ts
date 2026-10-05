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

  test('reports live sqlite runs against the latest broker invocation system prompt', async () => {
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
          'create table runs (scope_ref text not null, lane_ref text not null, updated_at text not null);',
          'create table continuities (scope_ref text not null, lane_ref text not null, agent_id text not null, primary key(scope_ref, lane_ref));',
          'create table broker_invocations (invocation_id text primary key, broker_driver text not null, spec_projection_json text, created_at text not null);',
          "insert into continuities values ('agent:historical-label:project:demo:task:one', 'main', 'alice'), ('agent:historical-label:project:demo:task:two', 'main', 'alice');",
          "insert into runs values ('agent:historical-label:project:demo:task:one', 'main', '2026-06-01T12:00:00.000Z');",
          "insert into runs values ('agent:historical-label:project:demo:task:two', 'main', '2026-06-02T12:00:00.000Z');",
        ].join('\n'),
      ])
      execFileSync('sqlite3', [
        db,
        `insert into broker_invocations values ('inv-1', 'claude-code-tmux', ${sqlString(
          JSON.stringify({
            specVersion: 'harness-broker.invocation/v1',
            invocationId: 'inv-1',
            harness: { frontend: 'claude-code', driver: 'claude-code-tmux' },
            launch: { systemPromptFile: promptFile, systemPromptMode: 'append' },
            correlation: { scopeRef: 'agent:alice:project:demo:task:two' },
          })
        )}, '2026-06-02T13:00:00.000Z');`,
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

  test('prices v2 broker invocation prompts: claude launch.systemPromptFile and codex AGENTS.md block', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'asp-token-rent-v2-'))
    try {
      const db = join(tempDir, 'state.sqlite')
      const agentsRoot = join(tempDir, 'agents')
      const claudePrompt = join(tempDir, 'system-prompt.md')
      const codexHome = join(tempDir, 'codex-home')
      await mkdir(agentsRoot, { recursive: true })
      await mkdir(codexHome, { recursive: true })
      const aliceText = ['# Praesidium Platform\nshared motd', '# Alice\nalice soul'].join(
        '\n\n---\n\n'
      )
      await writeFile(claudePrompt, aliceText)
      const bobText = ['# Praesidium Platform\nshared motd', '# Bob\nbob soul text'].join(
        '\n\n---\n\n'
      )
      await writeFile(
        join(codexHome, 'AGENTS.md'),
        `<!-- Generated by agent-spaces. -->\n\nspace instructions outside the block\n\n<!-- BEGIN praesidium-context -->\n${bobText}\n<!-- END praesidium-context -->\n`
      )

      const claudeSpec = {
        specVersion: 'harness-broker.invocation/v1',
        invocationId: 'inv-a',
        harness: { frontend: 'claude-code', driver: 'claude-code-tmux' },
        process: { command: 'claude', args: [], cwd: tempDir, lockedEnv: {} },
        launch: { systemPromptFile: claudePrompt, systemPromptMode: 'append' },
        correlation: { scopeRef: 'agent:alice:project:demo:task:T-1' },
      }
      const codexSpec = {
        specVersion: 'harness-broker.invocation/v1',
        invocationId: 'inv-b',
        harness: { frontend: 'codex', driver: 'codex-app-server' },
        process: { command: 'codex', args: [], cwd: tempDir, lockedEnv: { CODEX_HOME: codexHome } },
        correlation: { scopeRef: 'agent:bob:project:demo' },
      }
      execFileSync('sqlite3', [
        db,
        [
          'create table runs (scope_ref text not null, lane_ref text not null, updated_at text not null);',
          'create table continuities (scope_ref text not null, lane_ref text not null, agent_id text not null, primary key(scope_ref, lane_ref));',
          'create table compiled_runtime_plans (plan_hash text primary key, created_at text not null, plan_projection_json text not null);',
          'create table broker_invocations (invocation_id text primary key, broker_driver text not null, spec_projection_json text, created_at text not null);',
          "insert into continuities values ('agent:alice:project:demo:task:T-1', 'main', 'alice'), ('agent:bob:project:demo', 'main', 'bob');",
          "insert into runs values ('agent:alice:project:demo:task:T-1', 'main', '2026-10-01T12:00:00.000Z');",
          "insert into runs values ('agent:bob:project:demo', 'main', '2026-10-02T12:00:00.000Z');",
          // v2 plans carry only selection — no agent, no prompt.
          `insert into compiled_runtime_plans values ('v2hash', '2026-10-02T13:00:00.000Z', ${sqlString(
            JSON.stringify({
              schemaVersion: 'agent-runtime-plan/v2',
              planHash: 'v2hash',
              selection: { harness: 'claude' },
            })
          )});`,
          `insert into broker_invocations values ('inv-a', 'claude-code-tmux', ${sqlString(JSON.stringify(claudeSpec))}, '2026-10-01T12:00:00.000Z');`,
          `insert into broker_invocations values ('inv-b', 'codex-app-server', ${sqlString(JSON.stringify(codexSpec))}, '2026-10-02T12:00:00.000Z');`,
        ].join('\n'),
      ])

      const stdout = runAsp([
        'token-rent',
        '--json',
        '--hrc-db',
        db,
        '--agents-root',
        agentsRoot,
        '--usage-since',
        '2026-10-01T00:00:00.000Z',
        '--now',
        '2026-10-03T00:00:00.000Z',
      ])
      const report = JSON.parse(stdout) as {
        agents: Array<{
          agent: string
          residentTokens: number
          systemPromptFile?: string
          missingPromptArtifact?: string
        }>
      }
      const byAgent = new Map(report.agents.map((agent) => [agent.agent, agent]))

      expect(byAgent.get('alice')?.missingPromptArtifact).toBeUndefined()
      expect(byAgent.get('alice')?.systemPromptFile).toBe(claudePrompt)
      expect(byAgent.get('alice')?.residentTokens).toBe(
        aliceText.split('\n\n---\n\n').reduce((sum, s) => sum + Math.ceil(s.length / 4), 0)
      )
      expect(byAgent.get('bob')?.missingPromptArtifact).toBeUndefined()
      expect(byAgent.get('bob')?.systemPromptFile).toBe(join(codexHome, 'AGENTS.md'))
      expect(byAgent.get('bob')?.residentTokens).toBe(
        bobText.split('\n\n---\n\n').reduce((sum, s) => sum + Math.ceil(s.length / 4), 0)
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
