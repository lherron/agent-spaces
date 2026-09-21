import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateAgentProfiles } from './validate-agent-profiles.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'validate-agent-profiles-'))
  roots.push(value)
  return value
}

const quiet = { log() {}, error() {} }

describe('validateAgentProfiles', () => {
  test('accepts a valid direct-child v4 profile through validateAgentRoot', () => {
    const agentsRoot = root()
    const agentRoot = join(agentsRoot, 'cody')
    mkdirSync(agentRoot)
    writeFileSync(join(agentRoot, 'SOUL.md'), '# Cody\n')
    writeFileSync(join(agentRoot, 'agent-profile.toml'), 'version = 4\n')

    expect(validateAgentProfiles(agentsRoot, quiet)).toEqual({
      root: agentsRoot,
      discovered: 1,
      passed: 1,
      failed: 0,
    })
  })

  test('fails an invalid profile and an empty fleet', () => {
    const agentsRoot = root()
    const agentRoot = join(agentsRoot, 'legacy')
    mkdirSync(agentRoot)
    writeFileSync(join(agentRoot, 'SOUL.md'), '# Legacy\n')
    writeFileSync(join(agentRoot, 'agent-profile.toml'), 'version = 3\n')

    expect(validateAgentProfiles(agentsRoot, quiet)).toMatchObject({
      discovered: 1,
      passed: 0,
      failed: 1,
    })
    expect(validateAgentProfiles(root(), quiet)).toMatchObject({
      discovered: 0,
      passed: 0,
      failed: 1,
    })
  })
})
