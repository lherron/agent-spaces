import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RuntimeCompileRequest, RuntimeCompileResponse } from 'spaces-runtime-contracts'

import { AspcInspectionAuthorityError, createAspcService } from '../src/index.js'
import type { AspcCompiler } from '../src/service.js'

type Fixture = {
  root: string
  agentsRoot: string
  projectRoot: string
  codyRoot: string
}

let fixture: Fixture

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'aspc-inspection-authority-'))
  const agentsRoot = join(root, 'trusted-agents')
  const projectRoot = join(root, 'trusted-project')
  const codyRoot = join(agentsRoot, 'cody')
  await mkdir(codyRoot, { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  await writeFile(
    join(codyRoot, 'agent-profile.toml'),
    `version = 3

[identity]
display = "Cody"
role = "engineer"

[provisioning]
harness = "codex"

[spaces]
base = []
`
  )
  await writeFile(join(codyRoot, 'SOUL.md'), 'Cody soul\n')
  await writeFile(
    join(codyRoot, 'context-template.toml'),
    `schema_version = 2
mode = "replace"

[[prompt]]
name = "authority"
type = "inline"
content = "project={{projectId}} pinned={{env.PINNED_VALUE}}"
`
  )

  const brokenRoot = join(agentsRoot, 'broken')
  await mkdir(brokenRoot, { recursive: true })
  await writeFile(join(brokenRoot, 'agent-profile.toml'), 'version = [broken')
  await writeFile(join(brokenRoot, 'SOUL.md'), 'broken source remains visible\n')

  const ignoredRoot = join(agentsRoot, 'soul-only')
  await mkdir(ignoredRoot, { recursive: true })
  await writeFile(join(ignoredRoot, 'SOUL.md'), 'not a canonical source\n')
  fixture = { root, agentsRoot, projectRoot, codyRoot }
})

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true })
})

describe('ASPC identifier-only inspection authority', () => {
  test('catalogs a project-neutral live roster without ambient or fabricated context', async () => {
    const service = serviceWith(compilerReturning(successfulCompileResponse()))
    const first = await service.catalogAgentInspection({})
    process.env['ASPC_AUTHORITY_AMBIENT_TEST'] = 'changed-after-startup'
    const second = await service.catalogAgentInspection({})
    Reflect.deleteProperty(process.env, 'ASPC_AUTHORITY_AMBIENT_TEST')

    expect(first).toEqual(second)
    expect(first.projectId).toBeNull()
    expect(first.contexts).toEqual({})
    expect(first.agents.map(({ agentId }) => agentId)).toEqual(['broken', 'cody'])
    expect(first.agents.every((row) => row.defaultContextSummary === undefined)).toBe(true)
    expect(first.agents.find(({ agentId }) => agentId === 'broken')?.errorCount).toBeGreaterThan(0)

    const lateRoot = join(fixture.agentsRoot, 'late-agent')
    await mkdir(lateRoot)
    await writeFile(
      join(lateRoot, 'agent-profile.toml'),
      'version = 3\n[provisioning]\nharness = "pi"\n'
    )
    const refreshed = await service.catalogAgentInspection({})
    expect(refreshed.agents.map(({ agentId }) => agentId)).toContain('late-agent')
  })

  test('resolves trusted project context and lists only producer-supported selectors', async () => {
    const sparkyRoot = join(fixture.agentsRoot, 'sparky')
    await mkdir(sparkyRoot)
    await writeFile(
      join(sparkyRoot, 'agent-profile.toml'),
      'version = 3\n[provisioning]\nharness = "pi-sdk"\nmodel = "openai-codex/gpt-5.5"\n'
    )
    const resolvedIds: string[] = []
    const service = createAspcService({
      compiler: compilerReturning(successfulCompileResponse()),
      agentsRoot: fixture.agentsRoot,
      resolveProjectRoot(projectId) {
        resolvedIds.push(projectId)
        return projectId === 'agent-spaces' ? fixture.projectRoot : undefined
      },
    })

    const catalog = await service.catalogAgentInspection({ projectId: 'agent-spaces' })
    expect(resolvedIds).toEqual(['agent-spaces'])
    expect(catalog.projectId).toBe('agent-spaces')
    expect(catalog.contexts['cody']?.map(({ identifiers }) => identifiers.interaction)).toEqual([
      'interactive',
      'headless',
    ])
    expect(catalog.contexts['broken']).toBeUndefined()
    expect(catalog.contexts['sparky']).toEqual([
      {
        identifiers: {
          agentId: 'sparky',
          projectId: 'agent-spaces',
          mode: 'task',
          scope: 'agent:sparky:project:agent-spaces',
          lane: 'main',
          harness: 'pi-sdk',
          frontend: 'pi-sdk',
          interaction: 'nonInteractive',
        },
        declaredOverrides: {},
      },
    ])
    expect(catalog.agents.find(({ agentId }) => agentId === 'cody')?.defaultContextSummary).toEqual(
      {
        projectId: 'agent-spaces',
        mode: 'task',
        lane: 'main',
        harness: 'codex',
        frontend: 'codex-cli',
        interaction: 'interactive',
      }
    )
    expect(JSON.stringify(catalog)).not.toContain(fixture.agentsRoot)
    expect(JSON.stringify(catalog)).not.toContain(fixture.projectRoot)
  })

  test('assembles the full evaluation context internally before one canonical compile', async () => {
    const calls: Array<{
      request: RuntimeCompileRequest
      options: Parameters<AspcCompiler>[1]
    }> = []
    const compiler: AspcCompiler = async (request, options) => {
      calls.push({ request, options })
      return successfulCompileResponse()
    }
    const service = createAspcService({
      compiler,
      agentsRoot: fixture.agentsRoot,
      resolveProjectRoot: () => fixture.projectRoot,
      environment: () => ({ PINNED_VALUE: 'from-producer', EMPTY: '' }),
      now: () => '2026-08-23T14:00:00.000Z',
    })
    const catalog = await service.catalogAgentInspection({ projectId: 'agent-spaces' })
    const option = catalog.contexts['cody']?.[0]
    expect(option).toBeDefined()

    const outcome = await service.inspectAgentSelection({
      agentId: 'cody',
      request: {
        schemaVersion: 'agent-inspection-request/v1',
        identifiers: option!.identifiers,
        declaredOverrides: option!.declaredOverrides,
      },
    })

    expect(outcome.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.request.placement).toMatchObject({
      root: fixture.projectRoot,
      targetDir: fixture.projectRoot,
      agentRoot: fixture.codyRoot,
    })
    expect(calls[0]?.request.materialization.initialPrompt).toContain('pinned=from-producer')
    expect(calls[0]?.options?.compileContext).toMatchObject({
      nowIso: '2026-08-23T14:00:00.000Z',
      idSalt: 'aspc-agent-inspection:agent-spaces',
    })
    expect(JSON.stringify(outcome)).not.toContain(fixture.agentsRoot)
    expect(JSON.stringify(outcome)).not.toContain('PINNED_VALUE')
  })

  test('fails closed for route mismatch, unlisted context, missing source, and unknown project', async () => {
    let compileCalls = 0
    const service = createAspcService({
      compiler: async () => {
        compileCalls += 1
        return successfulCompileResponse()
      },
      agentsRoot: fixture.agentsRoot,
      resolveProjectRoot: (projectId) =>
        projectId === 'agent-spaces' ? fixture.projectRoot : undefined,
    })
    const catalog = await service.catalogAgentInspection({ projectId: 'agent-spaces' })
    const option = catalog.contexts['cody']![0]!
    const request = {
      schemaVersion: 'agent-inspection-request/v1' as const,
      identifiers: option.identifiers,
      declaredOverrides: option.declaredOverrides,
    }

    await expectAuthorityError(
      service.inspectAgentSelection({ agentId: 'other', request }),
      'INVALID_AGENT_INSPECTION_SELECTION',
      400
    )
    await expectAuthorityError(
      service.inspectAgentSelection({
        agentId: 'cody',
        request: { ...request, identifiers: { ...request.identifiers, interaction: 'bogus' } },
      }),
      'INVALID_AGENT_INSPECTION_SELECTION',
      400
    )
    await expectAuthorityError(
      service.inspectAgentSelection({
        agentId: 'missing',
        request: { ...request, identifiers: { ...request.identifiers, agentId: 'missing' } },
      }),
      'AGENT_INSPECTION_AGENT_NOT_FOUND',
      404
    )
    await expectAuthorityError(
      service.catalogAgentInspection({ projectId: 'unknown' }),
      'AGENT_INSPECTION_PROJECT_NOT_FOUND',
      404
    )
    await rm(join(fixture.codyRoot, 'agent-profile.toml'))
    await expectAuthorityError(
      service.inspectAgentSelection({ agentId: 'cody', request }),
      'AGENT_INSPECTION_AGENT_NOT_FOUND',
      404
    )
    expect(compileCalls).toBe(0)
  })

  test('rejects every client root/context attempt before touching the producer', async () => {
    let resolverCalls = 0
    const service = createAspcService({
      compiler: compilerReturning(successfulCompileResponse()),
      agentsRoot: fixture.agentsRoot,
      resolveProjectRoot: () => {
        resolverCalls += 1
        return fixture.projectRoot
      },
    })
    await expect(
      service.catalogAgentInspection({
        projectId: 'agent-spaces',
        projectRoot: '/caller/project',
        agentsRoot: '/caller/agents',
      } as never)
    ).rejects.toThrow()
    await expect(
      service.inspectAgentSelection({
        agentId: 'cody',
        request: {} as never,
        evaluationContext: { paths: { projectRoot: '/caller/project' } },
      } as never)
    ).rejects.toThrow()
    expect(resolverCalls).toBe(0)
  })
})

function serviceWith(compiler: AspcCompiler) {
  return createAspcService({
    compiler,
    agentsRoot: fixture.agentsRoot,
    resolveProjectRoot: () => fixture.projectRoot,
  })
}

function compilerReturning(response: RuntimeCompileResponse): AspcCompiler {
  return async () => response
}

function successfulCompileResponse(): RuntimeCompileResponse {
  return {
    schemaVersion: 'agent-runtime-compile-response/v1',
    ok: true,
    plan: {
      schemaVersion: 'agent-runtime-plan/v1',
      compiler: { name: 'agent-spaces', version: 'test' },
      compileId: 'compile-authority',
      planHash: 'plan-authority',
      createdAt: '2026-08-23T14:00:00.000Z',
      identity: {} as never,
      placement: {} as never,
      resolvedBundle: { bundleIdentity: 'bundle-authority' } as never,
      harness: { family: 'codex', runtime: 'codex-cli', provider: 'openai' },
      model: {
        provider: 'openai',
        modelId: 'gpt-5.6-sol',
        requestedModel: 'gpt-5.6-sol',
      },
      executionProfiles: [],
      artifacts: { bundleIdentity: 'bundle-authority' },
      lockedEnv: { lockedEnvKeys: [] },
      diagnostics: [],
    },
    diagnostics: [],
  }
}

async function expectAuthorityError(
  promise: Promise<unknown>,
  code: AspcInspectionAuthorityError['code'],
  status: AspcInspectionAuthorityError['status']
): Promise<void> {
  try {
    await promise
    throw new Error('expected authority operation to reject')
  } catch (error) {
    expect(error).toBeInstanceOf(AspcInspectionAuthorityError)
    expect((error as AspcInspectionAuthorityError).code).toBe(code)
    expect((error as AspcInspectionAuthorityError).status).toBe(status)
  }
}
