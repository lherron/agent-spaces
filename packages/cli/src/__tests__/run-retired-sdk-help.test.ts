import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')

test('asp run help stops advertising retired SDK harnesses', () => {
  const result = spawnSync('bun', ['run', ASP_CLI, 'run', '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const help = `${result.stdout}${result.stderr}`

  expect(result.status).toBe(0)
  expect(help).toContain('--harness <id>')
  expect(help).toContain('--model <model>')
  expect({
    claudeAgentSdkAdvertised: help.includes('claude-agent-sdk'),
    piSdkAdvertised: help.includes('pi-sdk'),
  }).toEqual({ claudeAgentSdkAdvertised: false, piSdkAdvertised: false })
})
