/**
 * The `locked` env cases of the scope and env contract
 * (contracts/agent-scope/conformance/README.md): the ASP_PROJECT entry of the
 * lockedEnv that Bun's CLI preparation composes, through the same steps
 * preparePlacementCliRuntime takes: deriveHandleParts → buildAgentchatEnv →
 * composeAgentLocalEnv. raspd runs the same cases in a cargo test.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { RuntimePlacement } from 'spaces-config'

import { deriveHandleParts } from '../broker-invocation.js'
import { composeAgentLocalEnv } from '../compose-agent-local-env.js'
import { buildAgentchatEnv } from '../prepare-cli-runtime.js'

type LockedCase = {
  id: string
  kind: string
  in: { scopeRef: string; projectRoot?: string }
  expected: Record<string, string>
}

const fixture = fileURLToPath(import.meta.resolve('agent-scope/conformance/env-cases.json'))
const cases = (JSON.parse(readFileSync(fixture, 'utf8')) as { cases: LockedCase[] }).cases.filter(
  (c) => c.kind === 'locked'
)

const noToolRuntime = {
  prepareAgentToolRuntime: async () => ({ env: {}, pathPrepend: [], warnings: [] }),
}

async function lockedAspProject(c: LockedCase): Promise<Record<string, string>> {
  const placement = {
    agentRoot: '/home/operator/praesidium/var/agents/alice',
    ...(c.in.projectRoot !== undefined ? { projectRoot: c.in.projectRoot } : {}),
    runMode: 'task',
    bundle: { kind: 'agent-project', agentName: 'alice' },
    correlation: { sessionRef: { scopeRef: c.in.scopeRef, laneRef: 'main' } },
  } as RuntimePlacement
  const composed = await composeAgentLocalEnv(
    {
      placement,
      agentLocalComponents: undefined,
      aspHome: '/home/operator/praesidium/var/spaces-repo',
      agentchatEnv: buildAgentchatEnv(placement, deriveHandleParts(placement)),
    },
    noToolRuntime
  )
  const value = composed.lockedEnv['ASP_PROJECT']
  return value === undefined ? {} : { ASP_PROJECT: value }
}

describe('Bun lockedEnv: locked env cases', () => {
  test('the fixture has locked cases', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  for (const c of cases) {
    test(c.id, async () => {
      expect(await lockedAspProject(c)).toEqual(c.expected)
    })
  }
})
