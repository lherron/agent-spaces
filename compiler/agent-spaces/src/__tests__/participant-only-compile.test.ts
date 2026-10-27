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

/**
 * The request names an agent id that disagrees with the agent root, so a
 * launchable profile passes the participant-only gate and stops at the very
 * next one (`configured_context_mismatch`) before anything is materialized.
 */
function requestFor(agentRoot: string): RuntimeCompileRequest {
  return {
    placement: { agentRoot, bundle: { kind: 'agent-default' }, cwd: agentRoot, runMode: 'task' },
    materialization: {},
    agent: { id: 'not-foundry' },
    requested: {},
  } as unknown as RuntimeCompileRequest
}

const LAUNCHABLE = 'version = 4\n\n[provisioning]\nharness = "agent-harness"\n'

describe('participant-only agents (T-09061)', () => {
  test.each([
    [
      'participant-only is refused, even with SOUL.md present',
      `${LAUNCHABLE}\n[placement]\nlaunch = "participant-only"\n`,
      'agent_participant_only',
      'participant-only',
    ],
    [
      'a launchable profile passes the participant-only gate',
      LAUNCHABLE,
      'configured_context_mismatch',
      'disagrees',
    ],
  ])('%s', async (_name, profile, code, message) => {
    const agentRoot = await agentHome(profile)

    const response = await compileRuntimePlan(requestFor(agentRoot))

    expect(response.ok).toBe(false)
    expect(response.diagnostics).toHaveLength(1)
    expect(response.diagnostics[0]).toMatchObject({ level: 'error', code })
    expect(response.diagnostics[0]?.message).toContain(message)
  })
})
