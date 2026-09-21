/** T-08563 rev 5 service/registration and placement-prompt behavior reds. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LegacyRuntimeCompileResponse as RuntimeCompileResponse } from 'spaces-runtime-contracts/internal/compiler-plan-v1'
import * as Aspc from '../src/index.js'

type Handler = (request: { id: string | number; method: string; params: unknown }) => Promise<any>
type DynamicService = Record<string, (...args: any[]) => Promise<any>>
const METHODS = [
  'aspc.resolveRuntimeDeclaration',
  'aspc.inspectRuntimePlacement',
  'aspc.observeRuntimeCapability',
  'aspc.observeContinuationArtifact',
] as const

let root = ''
let agentsRoot = ''
let projectRoot = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aspc-runtime-observation-red-'))
  agentsRoot = join(root, 'agents')
  projectRoot = join(root, 'project')
  await mkdir(projectRoot, { recursive: true })
  await makeAgent('prompted', true)
  await makeAgent('no-prompt', false)
  await makeAgent('invalid-prompt', true)
  await writeFile(
    join(agentsRoot, 'prompted', 'context-template.toml'),
    `schema_version = 2
mode = "replace"
max_chars = 10000

[[prompt]]
name = "runtime"
type = "inline"
content = "present={{env.RUNTIME_PROMPT_VALUE}}"

[[reminder]]
name = "runtime-reminder"
type = "inline"
content = "remember"
`
  )
  await writeFile(join(agentsRoot, 'invalid-prompt', 'context-template.toml'), 'schema_version = [')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('T-08563 ASPC runtime observation service', () => {
  test('positive control: existing service hello and compiler injection are live', async () => {
    const service = Aspc.createAspcService({ compiler: async () => successfulCompileResponse() })
    const hello = await service.hello({
      clientInfo: { name: 'runtime-observation-red' },
      protocolVersions: ['aspc/0.1'],
    })
    expect(hello.protocolVersion).toBe('aspc/0.1')
    expect(hello.capabilities.compileHarnessInvocation).toBe(true)
    expect(hello.capabilities).not.toHaveProperty('compileRuntimePlan')
  })

  test('registers all four methods and advertises exact hello capability booleans', async () => {
    const server = recordingServer()
    Aspc.registerAspcCompileMethods(server)
    for (const method of METHODS) expect(server.handlers.has(method)).toBe(true)

    const hello = await requiredHandler(
      server.handlers,
      'aspc.hello'
    )({
      id: 1,
      method: 'aspc.hello',
      params: { clientInfo: { name: 'runtime-red' }, protocolVersions: ['aspc/0.1'] },
    })
    for (const capability of [
      'resolveRuntimeDeclaration',
      'inspectRuntimePlacement',
      'observeRuntimeCapability',
      'observeContinuationArtifact',
    ]) {
      expect(hello.capabilities[capability], `hello capability ${capability}`).toBe(true)
    }
  })

  test('returns typed incompatible/unsupported_schema from every advertised method', async () => {
    const server = recordingServer()
    Aspc.registerAspcCompileMethods(server)
    for (const method of METHODS) {
      const response = await requiredHandler(
        server.handlers,
        method
      )({
        id: method,
        method,
        params: { schemaVersion: 'not-v1' },
      })
      if (method === 'aspc.inspectRuntimePlacement') {
        // Rev 5's inspection failure arm embeds the declaration failure.
        expect(response).toMatchObject({
          ok: false,
          declaration: {
            ok: false,
            failure: { kind: 'incompatible', code: 'unsupported_schema' },
          },
        })
      } else {
        expect(response).toMatchObject({
          ok: false,
          failure: { kind: 'incompatible', code: 'unsupported_schema' },
        })
        expect(response).not.toHaveProperty('resolution')
      }
    }
  })

  test('returns a present composed prompt and its summary', async () => {
    const service = dynamicService()
    const response = await service.inspectRuntimePlacement(
      inspectRequest('prompted', {
        RUNTIME_PROMPT_VALUE: 'from-dispatch',
      })
    )
    expect(response.ok).toBe(true)
    // T-08579 (T-08563 rev 5.2): dispatchEnv is launch-process input only and
    // never a template interpolation input, so the ambient value renders.
    expect(response.prompt).toMatchObject({
      state: 'present',
      value: {
        systemPromptMode: 'replace',
        systemPrompt: expect.stringContaining('present=ambient'),
        nearMaxChars: false,
      },
    })
    expect(response.prompt.value.promptTotalChars).toBeGreaterThan(0)
    expect(response.prompt.value.totalContextChars).toBeGreaterThan(0)
    expect(response.prompt.value.promptSectionSizes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: expect.any(String), chars: expect.any(Number) }),
      ])
    )
    expect(response.prompt.value.reminderSectionSizes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: expect.any(String), chars: expect.any(Number) }),
      ])
    )
    expect(response.inspection.schemaVersion).toBe('agent-inspection/v1')
    expect(response.effectiveEnvironmentHash).toEqual(expect.any(String))
  })

  test('keeps a valid no-template agent ok with absent/prompt_not_declared', async () => {
    const response = await dynamicService().inspectRuntimePlacement(inspectRequest('no-prompt'))
    expect(response).toMatchObject({
      ok: true,
      prompt: { state: 'absent', code: 'prompt_not_declared' },
      inspection: { schemaVersion: 'agent-inspection/v1' },
    })
    expect(response).not.toHaveProperty('failure')
  })

  test('keeps prompt resolution failure ok with partial inspection and compiled plan facts', async () => {
    const response = await dynamicService().inspectRuntimePlacement(
      inspectRequest('invalid-prompt')
    )
    expect(response).toMatchObject({
      ok: true,
      prompt: { state: 'invalid', code: 'prompt_resolution_failed' },
      inspection: { completeness: { kind: 'partial' } },
    })
    expect(response.inspection.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'prompt_resolution_failed' })])
    )
    expect(
      response.inspection.parts.some((part: { kind?: string }) => part.kind !== 'prompt'),
      'successful compile facts must survive prompt failure'
    ).toBe(true)
    expect(JSON.stringify(response.inspection)).toContain('plan_runtime_observation_red')
  })

  test('T-08579: dispatchEnv changes neither prompt facts nor the environment hash', async () => {
    const service = dynamicService()
    const first = await service.inspectRuntimePlacement(
      inspectRequest('prompted', { RUNTIME_PROMPT_VALUE: 'A' })
    )
    const repeat = await service.inspectRuntimePlacement(
      inspectRequest('prompted', { RUNTIME_PROMPT_VALUE: 'A' })
    )
    const changed = await service.inspectRuntimePlacement(
      inspectRequest('prompted', { RUNTIME_PROMPT_VALUE: 'B' })
    )
    expect(repeat.prompt).toEqual(first.prompt)
    expect(repeat.effectiveEnvironmentHash).toBe(first.effectiveEnvironmentHash)
    expect(changed.prompt).toEqual(first.prompt)
    expect(changed.prompt.value.systemPrompt).toContain('present=ambient')
    expect(changed.effectiveEnvironmentHash).toBe(first.effectiveEnvironmentHash)
  })

  test('rejects invalid profiles without target fallback through the service', async () => {
    const fixtures = [
      ['parse-invalid', 'version = [not valid'],
      ['schema-invalid', 'version = 4\nunknown_key = true\n'],
    ] as const
    for (const [agentId, profile] of fixtures) {
      const agentRoot = join(agentsRoot, agentId)
      await mkdir(agentRoot, { recursive: true })
      await writeFile(join(agentRoot, 'agent-profile.toml'), profile)
    }
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      `schema = 2

[targets.parse-invalid]
compose = []

[targets.parse-invalid.provisioning]
harness = "codex"
model = "gpt-5.6-sol"

[targets.schema-invalid]
compose = []

[targets.schema-invalid.provisioning]
harness = "codex"
model = "gpt-5.6-sol"
`
    )

    const service = dynamicService()
    for (const [agentId] of fixtures) {
      const agentRoot = join(agentsRoot, agentId)
      const rejected = await service.resolveRuntimeDeclaration(
        declarationRequest(agentId, agentRoot, {
          mode: 'root',
          projectRoot,
          projectId: 'agent-spaces',
        })
      )
      // Fail closed (T-08701): an invalid profile is never usable, even with
      // valid project targets present. Targets are never read.
      expect(rejected).toMatchObject({
        ok: false,
        resolution: { state: 'invalid', code: 'agent_profile_invalid' },
        source: {
          agentProfile: {
            state: 'invalid',
            diagnostics: [
              {
                severity: 'error',
                code: 'agent_profile_invalid',
                source: 'agent-profile',
              },
            ],
          },
          projectTargets: { state: 'absent', code: 'not_declared' },
        },
      })
      expect(rejected).not.toHaveProperty('failure')
      expect(rejected).not.toHaveProperty('provisioning')
      expect(rejected).not.toHaveProperty('baselineProvisioning')
    }

    const invalidWithoutTarget = await service.resolveRuntimeDeclaration(
      declarationRequest('parse-invalid', join(agentsRoot, 'parse-invalid'), { mode: 'none' })
    )
    expect(invalidWithoutTarget).toMatchObject({
      ok: false,
      resolution: { state: 'invalid', code: 'agent_profile_invalid' },
      source: {
        agentProfile: { state: 'invalid' },
        projectTargets: { state: 'absent', code: 'not_declared' },
        selectedTarget: { state: 'absent', code: 'not_declared' },
      },
    })
    expect(invalidWithoutTarget).not.toHaveProperty('failure')
    expect(invalidWithoutTarget).not.toHaveProperty('provisioning')
    expect(invalidWithoutTarget).not.toHaveProperty('baselineProvisioning')
  })
})

function dynamicService(): DynamicService {
  const service = Aspc.createAspcService({
    compiler: async () => successfulCompileResponse(),
    agentsRoot,
    environment: { RUNTIME_PROMPT_VALUE: 'ambient' },
  }) as unknown as DynamicService
  expect(
    service.inspectRuntimePlacement,
    'AspcService.inspectRuntimePlacement must compose declaration, partial inspection, and prompt state'
  ).toBeFunction()
  return service
}

function inspectRequest(agentId: string, dispatchEnv?: Record<string, string>) {
  return {
    schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
    context: {
      agentId,
      agentRoot: join(agentsRoot, agentId),
      project: { mode: 'root', projectRoot, projectId: 'agent-spaces' },
      cwd: projectRoot,
      runMode: 'task',
      agentSources: { agentsRoot },
    },
    ...(dispatchEnv ? { dispatchEnv } : {}),
  }
}

function declarationRequest(
  agentId: string,
  agentRoot: string,
  project: { mode: 'root'; projectRoot: string; projectId: string } | { mode: 'none' }
) {
  return {
    schemaVersion: 'aspc-resolve-runtime-declaration-request/v1',
    context: {
      agentId,
      agentRoot,
      project,
      cwd: projectRoot,
      runMode: 'task',
      agentSources: { agentsRoot },
    },
  }
}

function recordingServer() {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    register(method: string, handler: Handler): void {
      handlers.set(method, handler)
    },
  }
}

function requiredHandler(handlers: Map<string, Handler>, method: string): Handler {
  const handler = handlers.get(method)
  expect(handler, `${method} must be registered`).toBeFunction()
  return handler as Handler
}

async function makeAgent(agentId: string, template: boolean): Promise<void> {
  const path = join(agentsRoot, agentId)
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'agent-profile.toml'),
    `version = 4

[identity]
display = "${agentId}"

[provisioning]
harness = "claude"

[spaces]
base = []
${template ? '\n[instructions]\ntemplate = "context-template.toml"\n' : ''}`
  )
}

function successfulCompileResponse(): RuntimeCompileResponse {
  return {
    schemaVersion: 'agent-runtime-compile-response/v1',
    ok: true,
    plan: {
      schemaVersion: 'agent-runtime-plan/v1',
      compiler: { name: 'agent-spaces', version: 'red' },
      compileId: 'compile_runtime_observation_red',
      planHash: 'plan_runtime_observation_red',
      createdAt: '2026-09-17T04:00:00.000Z',
      identity: {} as never,
      placement: {} as never,
      resolvedBundle: { bundleIdentity: 'bundle_runtime_observation_red' } as never,
      harness: { family: 'codex', runtime: 'codex-cli', provider: 'openai' },
      model: { provider: 'openai', modelId: 'gpt-5', requestedModel: 'gpt-5' },
      executionProfiles: [
        {
          kind: 'terminal',
          profileId: 'profile-red',
          controllerKind: 'foreground-terminal',
        } as never,
      ],
      artifacts: { lockHash: 'lock-red', bundleIdentity: 'bundle_runtime_observation_red' },
      lockedEnv: { lockedEnvKeys: [] },
      diagnostics: [],
    },
    diagnostics: [],
  }
}
