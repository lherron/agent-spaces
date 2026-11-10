/**
 * The `unmanaged` env cases of the scope and env contract
 * (contracts/agent-scope/conformance/README.md): each placement, taken from a
 * real `asp agent` launch, must produce exactly the expected map.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { RuntimePlacement } from '../core/types/placement.js'
import { buildAgentSessionEnv } from './agent-session-env.js'

type EnvCase = {
  id: string
  kind: string
  in: { placement?: unknown }
  expected: Record<string, string>
}

const fixture = fileURLToPath(import.meta.resolve('agent-scope/conformance/env-cases.json'))
const cases = (JSON.parse(readFileSync(fixture, 'utf8')) as { cases: EnvCase[] }).cases.filter(
  (c) => c.kind === 'unmanaged'
)

describe('buildAgentSessionEnv: unmanaged env cases', () => {
  test('the fixture has unmanaged cases', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  for (const c of cases) {
    test(c.id, () => {
      expect(buildAgentSessionEnv(c.in.placement as RuntimePlacement)).toEqual(c.expected)
    })
  }
})
