import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')

test('asp run help exposes exactly the catalog harnesses and agent-harness default', () => {
  const result = spawnSync('bun', ['run', ASP_CLI, 'run', '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const help = `${result.stdout}${result.stderr}`

  expect(result.status).toBe(0)
  expect(help).toContain('--harness <id>')
  expect(help).toContain('--model <model>')
  expect(help).toMatch(/default:\s+agent-harness; supported: agent-harness,\s+claude, codex, muse/)
  expect({
    piAdvertised: /\bpi\b/.test(help),
    claudeAgentSdkAdvertised: help.includes('claude-agent-sdk'),
    piSdkAdvertised: help.includes('pi-sdk'),
  }).toEqual({ piAdvertised: false, claudeAgentSdkAdvertised: false, piSdkAdvertised: false })
})

test('asp harnesses JSON projects the catalog and its default', () => {
  const result = spawnSync('bun', ['run', ASP_CLI, 'harnesses', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

  expect(result.status).toBe(0)
  const output = JSON.parse(result.stdout) as {
    defaultHarness: string
    harnesses: Array<{ id: string }>
  }
  expect(output.defaultHarness).toBe('agent-harness')
  expect(output.harnesses.map(({ id }) => id)).toEqual(['agent-harness', 'claude', 'codex', 'muse'])
})

test('asp run rejects pi rather than mapping it to a local adapter', () => {
  const result = spawnSync('bun', ['run', ASP_CLI, 'run', 'not-a-target', '--harness', 'pi'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

  expect(result.status).not.toBe(0)
  expect(`${result.stdout}${result.stderr}`).toContain('Unknown harness "pi"')
})
