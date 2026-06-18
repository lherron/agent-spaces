import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')
const RESOURCE_AGENT_ROOT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'config',
  'src',
  '__fixtures__',
  'resources',
  'agents',
  'smokey'
)

function runAspResourcesPlan(): { stdout: string; stderr: string } {
  const result = spawnSync(
    'bun',
    [
      'run',
      ASP_CLI,
      'resources',
      'plan',
      'smokey',
      '--project',
      'agent-spaces',
      '--agent-root',
      RESOURCE_AGENT_ROOT,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  expect(result.status).toBe(0)
  return { stdout: result.stdout, stderr: result.stderr }
}

describe('asp resources plan', () => {
  test('prints byte-stable plan JSON with human summary on stderr', () => {
    const first = runAspResourcesPlan()
    const second = runAspResourcesPlan()

    expect(first.stdout).toBe(second.stdout)
    const plan = JSON.parse(first.stdout) as {
      schema: string
      resources: Array<{ resourceKind: string; desiredJson: { trigger?: { cooldown?: string } } }>
    }
    expect(plan.schema).toBe('agent-authored-runtime-resources.plan/v1')
    expect(plan.resources.map((resource) => resource.resourceKind)).toEqual([
      'scheduled-job',
      'interface-binding',
      'event-hook',
    ])
    expect(plan.resources[2]?.desiredJson.trigger?.cooldown).toBe('300s')
    expect(first.stderr).toContain('Compiled resources plan for smokey@agent-spaces: 3 resources')
  })
})
