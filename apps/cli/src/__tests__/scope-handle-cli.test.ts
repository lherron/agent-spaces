/**
 * T-00894: `asp agent` accepts ScopeHandle / SessionHandle shorthand as well as
 * canonical ScopeRefs, and canonicalizes it on both the resolve and the execute
 * path. Handle parsing itself lives in agent-scope; these tables pin that the CLI
 * routes every handle shape through it.
 */

import { describe, expect } from 'bun:test'
import { AGENT_ROOT, PROJECT_ROOT, cliTest, runAsp } from './asp-cli'

function agentRun(
  scope: string,
  mode: 'resolve' | 'query',
  withProjectRoot: boolean,
  ...rest: string[]
) {
  return runAsp([
    'agent',
    scope,
    mode,
    ...(mode === 'query' ? ['test prompt'] : []),
    '--agent-root',
    AGENT_ROOT,
    ...(withProjectRoot ? ['--project-root', PROJECT_ROOT] : []),
    ...rest,
  ])
}

describe('ScopeHandle in asp agent resolve (T-00894)', () => {
  const rows: Array<{
    input: string
    withProjectRoot: boolean
    scopeRef: string
    laneRef: string
  }> = [
    {
      input: 'alice@demo',
      withProjectRoot: true,
      scopeRef: 'agent:alice:project:demo:task:primary',
      laneRef: 'main',
    },
    {
      input: 'agent:alice:project:demo',
      withProjectRoot: true,
      scopeRef: 'agent:alice:project:demo:task:primary',
      laneRef: 'main',
    },
    {
      input: 'alice@demo:t1/reviewer',
      withProjectRoot: true,
      scopeRef: 'agent:alice:project:demo:task:t1:role:reviewer',
      laneRef: 'main',
    },
    {
      input: 'alice@demo~repair',
      withProjectRoot: true,
      scopeRef: 'agent:alice:project:demo:task:primary',
      laneRef: 'lane:repair',
    },
    {
      input: 'alice@demo~main',
      withProjectRoot: true,
      scopeRef: 'agent:alice:project:demo:task:primary',
      laneRef: 'main',
    },
    { input: 'agent:alice', withProjectRoot: false, scopeRef: 'agent:alice', laneRef: 'main' },
  ]

  for (const row of rows) {
    cliTest(
      `asp agent resolve canonicalizes ${row.input} to ${row.scopeRef} on ${row.laneRef}`,
      () => {
        const result = agentRun(row.input, 'resolve', row.withProjectRoot, '--json')

        expect(result.exitCode).toBe(0)
        const parsed = JSON.parse(result.stdout)
        expect(parsed.placement.correlation.sessionRef.scopeRef).toBe(row.scopeRef)
        expect(parsed.placement.correlation.sessionRef.laneRef).toBe(row.laneRef)
      }
    )
  }
})

describe('ScopeHandle in asp agent execute (T-00894)', () => {
  const rows: Array<{
    input: string
    withProjectRoot: boolean
    scopeRef: string
    laneRef: string
  }> = [
    {
      input: 'alice@demo',
      withProjectRoot: true,
      scopeRef: 'agent:alice:project:demo:task:primary',
      laneRef: 'main',
    },
    { input: 'alice', withProjectRoot: false, scopeRef: 'agent:alice', laneRef: 'main' },
    { input: 'alice~deploy', withProjectRoot: false, scopeRef: 'agent:alice', laneRef: 'deploy' },
    {
      input: 'agent:alice:project:demo:task:t1:role:reviewer',
      withProjectRoot: true,
      scopeRef: 'agent:alice:project:demo:task:t1:role:reviewer',
      laneRef: 'main',
    },
  ]

  for (const row of rows) {
    cliTest(
      `asp agent ${row.input} query --dry-run puts ${row.scopeRef} on ${row.laneRef} in the spec env`,
      () => {
        const result = agentRun(
          row.input,
          'query',
          row.withProjectRoot,
          '--harness',
          'claude',
          '--dry-run',
          '--json'
        )

        expect(result.exitCode).toBe(0)
        const parsed = JSON.parse(result.stdout)
        expect(parsed.spec.env.AGENT_SCOPE_REF).toBe(row.scopeRef)
        expect(parsed.spec.env.AGENT_LANE_REF).toBe(row.laneRef)
      }
    )
  }
})

describe('invalid ScopeHandle errors (T-00894)', () => {
  for (const input of ['@demo', '', 'alice@']) {
    cliTest(
      `invalid scope handle ${JSON.stringify(input)} exits non-zero naming the rejected input`,
      () => {
        const result = agentRun(input, 'resolve', false)

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain(
          `Invalid scope input "${input}": expected a ScopeHandle, SessionHandle, or ScopeRef`
        )
      }
    )
  }
})
