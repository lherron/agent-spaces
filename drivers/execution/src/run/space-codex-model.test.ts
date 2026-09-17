/**
 * T-08581: a space `[codex.config] model` is the model Codex runs, so placement
 * and model audit must report it instead of the adapter default.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { auditProjectModels } from './model-audit.js'
import { planPlacementRuntime } from './placement-plan.js'

const SPACE_MODEL = 'muse-spark-1.3-contributor'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })))
  tempDirs = []
})

async function createFixture(profileModel?: string) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'space-codex-model-'))
  tempDirs.push(projectRoot)
  const aspHome = join(projectRoot, 'asp-home')
  const agentRoot = join(projectRoot, 'agents', 'mux')
  await mkdir(aspHome, { recursive: true })
  await mkdir(join(agentRoot, 'spaces', 'muse-meta'), { recursive: true })
  await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')
  await writeFile(
    join(agentRoot, 'agent-profile.toml'),
    [
      'version = 3',
      '',
      '[provisioning]',
      'harness = "codex"',
      ...(profileModel ? [`model = "${profileModel}"`] : []),
      '',
      '[spaces]',
      'base = [ "space:agent:muse-meta" ]',
      '',
    ].join('\n')
  )
  await writeFile(
    join(agentRoot, 'spaces', 'muse-meta', 'space.toml'),
    [
      'schema = 1',
      'id = "muse-meta"',
      '',
      '[codex.config]',
      `model = "${SPACE_MODEL}"`,
      'model_provider = "meta"',
      '',
      '[codex.config.model_providers.meta]',
      'name = "Meta Model API"',
      '',
    ].join('\n')
  )
  return { projectRoot, aspHome, agentRoot }
}

describe('space [codex.config] model reporting (T-08581)', () => {
  test('placement reports the space model without pushing it onto launch argv', async () => {
    const { projectRoot, aspHome, agentRoot } = await createFixture()
    const compose = ['space:agent:muse-meta']
    const plan = await planPlacementRuntime({
      placement: {
        agentRoot,
        projectRoot,
        runMode: 'query',
        bundle: { kind: 'agent-project', agentName: 'mux', projectRoot },
      },
      placementContext: {
        resolvedBundle: {
          bundleIdentity: 'x',
          runMode: 'query',
          cwd: projectRoot,
          instructions: [],
          spaces: [],
        },
        materialization: {
          spec: { kind: 'spaces', spaces: compose },
          effectiveConfig: { compose, harness: 'codex' },
          manifest: {
            schema: 1,
            targets: { mux: { compose, provisioning: { harness: 'codex' } } },
          },
        },
      } as unknown as Parameters<typeof planPlacementRuntime>[0]['placementContext'],
      frontend: 'codex-cli',
      aspHome,
    })

    expect(plan.model.ok).toBe(true)
    if (!plan.model.ok) return
    expect(plan.model.info.model).toBe(SPACE_MODEL)
    expect(plan.model.info.effectiveModel).toBe(SPACE_MODEL)
    expect(plan.model.info.explicit).toBe(false)
    expect(plan.runOptions.model).toBeUndefined()
  })

  test('model audit reports the space model as ok', async () => {
    const { projectRoot, aspHome } = await createFixture()
    const rows = await auditProjectModels({ projectPath: projectRoot, aspHome })
    const row = rows.find((candidate) => candidate.agentId === 'mux')
    expect(row).toMatchObject({
      harnessId: 'codex',
      sourceModel: SPACE_MODEL,
      resolvedModel: SPACE_MODEL,
      sourceMode: 'space_codex_config',
      status: 'ok',
    })
    expect(row?.launchModel).toBeUndefined()
  })

  test('an explicit profile model still wins over the space model', async () => {
    const { projectRoot, aspHome } = await createFixture('gpt-5.6-sol')
    const rows = await auditProjectModels({ projectPath: projectRoot, aspHome })
    const row = rows.find((candidate) => candidate.agentId === 'mux')
    expect(row).toMatchObject({ sourceModel: 'gpt-5.6-sol', sourceMode: 'explicit_profile' })
  })
})
