/**
 * T-09061: an agent whose profile declares `[placement] launch =
 * "participant-only"` is never compiled for an HRC launch, whatever else its
 * home contains (SOUL.md included). The refusal is the first thing
 * compileRuntimePlan does, so a partial request is enough to exercise it.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compileRuntimePlan } from '../compile-runtime-plan.js'
import type { RuntimeCompileRequest } from '../index.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function agentHome(profile: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'participant-only-'))
  roots.push(root)
  const agentRoot = join(root, 'foundry')
  await mkdir(agentRoot, { recursive: true })
  await writeFile(join(agentRoot, 'SOUL.md'), '# Foundry\n')
  await writeFile(join(agentRoot, 'agent-profile.toml'), profile)
  return agentRoot
}

function requestFor(agentRoot: string): RuntimeCompileRequest {
  return {
    placement: { agentRoot, bundle: { kind: 'agent-default' }, cwd: agentRoot, runMode: 'task' },
    requested: {},
  } as unknown as RuntimeCompileRequest
}

async function diagnosticCodes(agentRoot: string): Promise<string[]> {
  try {
    const response = await compileRuntimePlan(requestFor(agentRoot))
    return response.diagnostics.map((d) => d.code)
  } catch {
    return ['<threw>']
  }
}

describe('participant-only agents (T-09061)', () => {
  test('refuses to compile, even with SOUL.md present', async () => {
    const agentRoot = await agentHome(
      'version = 4\n\n[provisioning]\nharness = "agent-harness"\n\n[placement]\nlaunch = "participant-only"\n'
    )

    const response = await compileRuntimePlan(requestFor(agentRoot))

    expect(response.ok).toBe(false)
    expect(response.diagnostics).toHaveLength(1)
    expect(response.diagnostics[0]).toMatchObject({
      level: 'error',
      code: 'agent_participant_only',
    })
    expect(response.diagnostics[0]?.message).toContain('participant-only')
  })

  test('control: a launchable profile is not refused as participant-only', async () => {
    const agentRoot = await agentHome('version = 4\n\n[provisioning]\nharness = "agent-harness"\n')

    expect(await diagnosticCodes(agentRoot)).not.toContain('agent_participant_only')
  })
})
