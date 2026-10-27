import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAsp } from './__tests__/asp-cli.js'

test('install outside a project exits nonzero and names the missing asp-targets.toml', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asp-no-project-'))
  try {
    const result = runAsp(['install'], { ASP_HOME: join(root, 'home') }, root)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('No asp-targets.toml found')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unknown top-level command exits 2 and names the rejected command', () => {
  const result = runAsp(['definitely-not-a-command'])
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toContain('definitely-not-a-command')
})
