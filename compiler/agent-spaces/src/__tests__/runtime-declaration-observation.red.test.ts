/** T-08701 v4/schema2 declaration observation through the agent-spaces package entrypoint. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as AgentSpaces from '../index.js'

type RuntimeContext = {
  agentId: string
  agentRoot?: string
  project:
    | { mode: 'root'; projectRoot: string; projectId?: string }
    | { mode: 'infer-from-cwd' }
    | { mode: 'none' }
  cwd: string
  runMode: 'task'
  agentSources?: { aspHome?: string; agentsRoot?: string }
  provisionDirectives?: Record<string, string | number | boolean>
}
type DeclarationResponse = Record<string, any> & { ok: boolean }
type ResolveRuntimeDeclaration = (
  request: {
    schemaVersion: 'aspc-resolve-runtime-declaration-request/v1'
    context: RuntimeContext
  },
  options?: Record<string, unknown>
) => Promise<DeclarationResponse>

let root = ''
let aspHome = ''
let agentsRoot = ''
let agentRoot = ''
let projectRoot = ''
let outsideRoot = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-declaration-red-'))
  aspHome = join(root, 'asp-home')
  agentsRoot = join(aspHome, 'agents')
  agentRoot = join(agentsRoot, 'smokey')
  projectRoot = join(root, 'project')
  outsideRoot = join(root, 'outside-smokey')
  await Promise.all([
    mkdir(agentRoot, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
  ])
  await writeProfile(agentRoot, 'verify', 'claude')
  await writeProfile(outsideRoot, 'outside', 'claude')
  await writeFile(
    join(projectRoot, 'asp-targets.toml'),
    `schema = 2

[targets.smokey]
compose = []

[targets.smokey.provisioning]
harness = "codex"
model = "gpt-5.6-sol"
`
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('T-08701 runtime declaration observation', () => {
  test('positive control: fixture sources are independently readable', async () => {
    expect(await readFile(join(agentRoot, 'agent-profile.toml'), 'utf8')).toContain(
      'role = "verify"'
    )
    expect(await readFile(join(projectRoot, 'asp-targets.toml'), 'utf8')).toContain(
      'harness = "codex"'
    )
  })

  test('honors exact caller source/root provenance and baseline then directive overlay', async () => {
    const alias = join(root, 'outside-alias')
    await symlink(outsideRoot, alias)
    const response = await operation()(
      request({
        agentRoot: alias,
        project: { mode: 'root', projectRoot, projectId: 'agent-spaces' },
        provisionDirectives: {
          harness: 'muse',
          model_provider: 'meta',
          model: 'muse-spark-1.3-contributor',
        },
      }),
      daemonDefaults()
    )

    expect(response.ok).toBe(true)
    expect(response.agentSources.provenance).toBe('caller-agent-root')
    expect(await realpath(response.placement.agentRoot)).toBe(await realpath(outsideRoot))
    expect(await realpath(response.agentSources.aspHome)).toBe(await realpath(aspHome))
    expect(await realpath(response.agentSources.agentsRoot)).toBe(await realpath(agentsRoot))
    expect(response.baselineProvisioning).toEqual({
      scalars: { harness: 'codex', model: 'gpt-5.6-sol', yolo: false, remote: false },
      declaredHarness: 'claude',
      effectiveHarness: 'codex',
    })
    expect(response.provisioning).toEqual({
      scalars: {
        harness: 'muse',
        model_provider: 'meta',
        model: 'muse-spark-1.3-contributor',
        yolo: false,
        remote: false,
      },
      declaredHarness: 'claude',
      effectiveHarness: 'muse',
    })
  })

  test('reports closed-vocabulary baseline scalars without driver projections', async () => {
    const response = await operation()(request(), daemonDefaults())
    expect(response.ok).toBe(true)
    expect(response.baselineProvisioning).toEqual({
      scalars: { harness: 'codex', model: 'gpt-5.6-sol', yolo: false, remote: false },
      declaredHarness: 'claude',
      effectiveHarness: 'codex',
    })
    for (const key of ['frontend', 'transport', 'provider', 'family', 'runtime']) {
      expect(response.baselineProvisioning).not.toHaveProperty(key)
      expect(response.provisioning).not.toHaveProperty(key)
    }
  })

  test('lets a directive replace the target-selected harness', async () => {
    const response = await operation()(
      request({ provisionDirectives: { harness: 'claude' } }),
      daemonDefaults()
    )
    expect(response.ok).toBe(true)
    expect(response.provisioning).toEqual({
      scalars: { harness: 'claude', model: 'gpt-5.6-sol', yolo: false, remote: false },
      declaredHarness: 'claude',
      effectiveHarness: 'claude',
    })
  })

  test('preserves agent-harness as its own first-party declaration', async () => {
    const response = await operation()(
      request({ provisionDirectives: { harness: 'agent-harness', model: 'gpt-5.6-terra' } }),
      daemonDefaults()
    )

    expect(response.ok).toBe(true)
    expect(response.provisioning).toEqual({
      scalars: {
        harness: 'agent-harness',
        model: 'gpt-5.6-terra',
        yolo: false,
        remote: false,
      },
      declaredHarness: 'claude',
      effectiveHarness: 'agent-harness',
    })
  })

  test('rejects a directive naming a harness outside the closed vocabulary', async () => {
    const response = await operation()(
      request({ provisionDirectives: { harness: 'pi-sdk' } }),
      daemonDefaults()
    )
    expect(response.ok).toBe(false)
    expect(response.failure).toMatchObject({ kind: 'incompatible', code: 'unsupported_harness' })
  })

  test('keeps root, infer-from-cwd, and none as three observable modes', async () => {
    const resolveDeclaration = operation()
    const rootMode = await resolveDeclaration(request(), daemonDefaults())
    const inferred = await resolveDeclaration(
      request({ project: { mode: 'infer-from-cwd' } }),
      daemonDefaults()
    )
    const none = await resolveDeclaration(request({ project: { mode: 'none' } }), {
      ...daemonDefaults(),
      environment: { ASP_PROJECT_ROOT_OVERRIDE: projectRoot },
    })

    expect(rootMode.ok).toBe(true)
    expect(await realpath(rootMode.placement.projectRoot)).toBe(await realpath(projectRoot))
    expect(rootMode.baselineProvisioning.effectiveHarness).toBe('codex')
    expect(inferred.ok).toBe(true)
    expect(inferred.markerProjectId).toBe('project')
    // K6: an exact caller agentRoot performs no roster search or substitution.
    expect(inferred.searchedAgentRoots).toEqual([])
    expect(none.ok).toBe(true)
    expect(none.placement).not.toHaveProperty('projectRoot')
    expect(none.source.projectTargets).toEqual({ state: 'absent', code: 'not_declared' })
    expect(none.baselineProvisioning).toEqual({
      scalars: { harness: 'claude', model: 'fixture-model', yolo: false, remote: false },
      declaredHarness: 'claude',
      effectiveHarness: 'claude',
    })
  })

  test('anchors caller-root searches without leaking daemon source configuration', async () => {
    const wrongAgentsRoot = join(root, 'wrong-daemon-agents')
    await mkdir(join(wrongAgentsRoot, 'smokey'), { recursive: true })
    await writeProfile(join(wrongAgentsRoot, 'smokey'), 'wrong-daemon', 'muse')
    await writeFile(join(aspHome, 'config.toml'), `agents-root = ${JSON.stringify(agentsRoot)}\n`)
    const options = {
      aspHome: join(root, 'wrong-daemon-home'),
      agentsRoot: wrongAgentsRoot,
      environment: {
        ASP_HOME: join(root, 'wrong-daemon-home'),
        ASP_AGENTS_ROOT: wrongAgentsRoot,
        ASP_PROJECT_ROOT_OVERRIDE: join(root, 'wrong-project'),
      },
    }
    const canonicalAgentRoot = await realpath(agentRoot)

    for (const project of [
      { mode: 'root' as const, projectRoot },
      { mode: 'infer-from-cwd' as const },
      { mode: 'none' as const },
    ]) {
      const response = await operation()(
        request({ agentRoot: undefined, project, agentSources: { agentsRoot } }),
        options
      )
      expect(response.ok).toBe(true)
      expect(await realpath(response.placement.agentRoot)).toBe(canonicalAgentRoot)
      expect(response.identity.role).toBe('verify')
      expect(response.searchedAgentRoots).toEqual([canonicalAgentRoot])
      expect(response.agentSources).toMatchObject({
        agentsRoot: await realpath(agentsRoot),
        provenance: 'caller',
      })
    }

    const aspHomeOnly = await operation()(
      request({ agentRoot: undefined, agentSources: { aspHome } }),
      options
    )
    expect(aspHomeOnly.ok).toBe(true)
    expect(await realpath(aspHomeOnly.placement.agentRoot)).toBe(await realpath(agentRoot))
    expect(aspHomeOnly.identity.role).toBe('verify')
    expect(aspHomeOnly.agentSources).toMatchObject({
      aspHome: await realpath(aspHome),
      agentsRoot: await realpath(agentsRoot),
      provenance: 'caller-asp-home-config',
    })
  })

  test('re-reads mutable profile and project sources on every call', async () => {
    const resolveDeclaration = operation()
    const first = await resolveDeclaration(request(), daemonDefaults())
    await writeProfile(agentRoot, 'changed-without-restart', 'muse')
    const second = await resolveDeclaration(request(), daemonDefaults())
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      'schema = 2\n[targets.smokey]\ncompose = []\n[targets.smokey.provisioning]\nharness = "claude"\n'
    )
    const third = await resolveDeclaration(request(), daemonDefaults())

    expect(first.identity.role).toBe('verify')
    expect(second.identity.role).toBe('changed-without-restart')
    expect(second.source.agentProfile.contentHash).not.toBe(first.source.agentProfile.contentHash)
    expect(third.baselineProvisioning.effectiveHarness).toBe('claude')
    expect(third.source.projectTargets.contentHash).not.toBe(
      first.source.projectTargets.contentHash
    )
  })

  test('keeps an existing agent root distinct from an absent profile declaration', async () => {
    await rm(join(agentRoot, 'agent-profile.toml'))

    const targetOnly = await operation()(request(), daemonDefaults())
    expect(targetOnly).toMatchObject({
      ok: true,
      source: { agentProfile: { state: 'absent', code: 'not_declared' } },
      baselineProvisioning: {
        scalars: { harness: 'codex', model: 'gpt-5.6-sol', yolo: false, remote: false },
        effectiveHarness: 'codex',
      },
    })
    expect(targetOnly.baselineProvisioning).not.toHaveProperty('declaredHarness')

    const defaultOnly = await operation()(request({ project: { mode: 'none' } }), daemonDefaults())
    expect(defaultOnly).toMatchObject({
      ok: true,
      source: {
        agentProfile: { state: 'absent', code: 'not_declared' },
        projectTargets: { state: 'absent', code: 'not_declared' },
      },
      baselineProvisioning: { scalars: {} },
    })
    // Fail closed: with no harness declared anywhere, none is invented.
    expect(defaultOnly.baselineProvisioning).not.toHaveProperty('effectiveHarness')
    expect(defaultOnly.baselineProvisioning).not.toHaveProperty('declaredHarness')
  })

  test.each([
    ['malformed TOML', 'version = [not valid'],
    ['schema-invalid TOML', 'version = 4\nunknown_key = true\n'],
  ])('rejects an invalid profile without target fallback: %s', async (_case, invalidProfile) => {
    const profilePath = join(agentRoot, 'agent-profile.toml')
    await writeFile(profilePath, invalidProfile)

    const response = await operation()(request(), daemonDefaults())

    expect(response).toMatchObject({
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
    expect(response).not.toHaveProperty('failure')
    expect(response).not.toHaveProperty('provisioning')
    expect(response).not.toHaveProperty('baselineProvisioning')
    expect(response.source.agentProfile).not.toHaveProperty('declaredHarness')
  })

  test('does not invent a harness scalar when the selected target omits one', async () => {
    await rm(join(agentRoot, 'agent-profile.toml'))
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      `schema = 2

[targets.smokey]
compose = []

[targets.smokey.provisioning]
model = "target-model-only"
`
    )

    const response = await operation()(
      request({ provisionDirectives: { harness: 'agent-harness' } }),
      daemonDefaults()
    )

    expect(response.ok).toBe(true)
    expect(response.baselineProvisioning).toEqual({
      scalars: { model: 'target-model-only', yolo: false, remote: false },
    })
    expect(response.baselineProvisioning).not.toHaveProperty('declaredHarness')
    expect(response.baselineProvisioning).not.toHaveProperty('effectiveHarness')
    expect(response.provisioning).toEqual({
      scalars: { model: 'target-model-only', harness: 'agent-harness', yolo: false, remote: false },
      effectiveHarness: 'agent-harness',
    })
    expect(response.provisioning).not.toHaveProperty('declaredHarness')
  })

  test.each([
    [
      true,
      false,
      { presentation: false, reasoning_effort: 'high' },
      { yolo: true, remote: false, presentation: false, reasoning_effort: 'high' },
    ],
    [
      false,
      true,
      { yolo: true, model_provider: 'openai-codex' },
      { yolo: true, remote: true, model_provider: 'openai-codex' },
    ],
  ] as const)(
    'keeps explicit target booleans and overlays directives: yolo=%s remote=%s',
    async (yolo, remote, provisionDirectives, expectedFinalBooleans) => {
      await rm(join(agentRoot, 'agent-profile.toml'))
      await writeFile(
        join(projectRoot, 'asp-targets.toml'),
        `schema = 2

[targets.smokey]
compose = []

[targets.smokey.provisioning]
harness = "codex"
model = "gpt-5.6-sol"
yolo = ${yolo}
remote = ${remote}
`
      )

      const response = await operation()(
        request({ provisionDirectives: { ...provisionDirectives } }),
        daemonDefaults()
      )

      expect(response.ok).toBe(true)
      expect(response.baselineProvisioning).toEqual({
        scalars: { harness: 'codex', model: 'gpt-5.6-sol', yolo, remote },
        effectiveHarness: 'codex',
      })
      expect(response.provisioning).toEqual({
        scalars: {
          harness: 'codex',
          model: 'gpt-5.6-sol',
          ...expectedFinalBooleans,
        },
        effectiveHarness: 'codex',
      })
    }
  )

  test.each([
    [
      'malformed TOML / mode none',
      'version = [not valid',
      () => request({ project: { mode: 'none' } }),
    ],
    [
      'schema-invalid TOML / mode none',
      'version = 4\nunknown_key = true\n',
      () => request({ project: { mode: 'none' } }),
    ],
    [
      'malformed TOML / valid targets without a selected agent',
      'version = [not valid',
      () => request({ agentId: 'not-targeted', agentRoot }),
    ],
    [
      'schema-invalid TOML / valid targets without a selected agent',
      'version = 4\nunknown_key = true\n',
      () => request({ agentId: 'not-targeted', agentRoot }),
    ],
  ])(
    'rejects invalid profiles without target fallback: %s',
    async (_case, invalidProfile, makeRequest) => {
      const profilePath = join(agentRoot, 'agent-profile.toml')
      await writeFile(profilePath, invalidProfile)

      const response = await operation()(makeRequest(), daemonDefaults())

      expect(response).toMatchObject({
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
        },
      })
      expect(response).not.toHaveProperty('failure')
      expect(response).not.toHaveProperty('provisioning')
      expect(response).not.toHaveProperty('baselineProvisioning')
      expect(response).not.toHaveProperty('placement')
    }
  )

  test('keeps valid-profile output byte-identical across an invalid-profile observation', async () => {
    const resolveDeclaration = operation()
    const fixedOptions = {
      ...daemonDefaults(),
      now: () => new Date('2026-09-17T08:00:00.000Z'),
    }
    const validProfile = await readFile(join(agentRoot, 'agent-profile.toml'), 'utf8')
    const before = await resolveDeclaration(request(), fixedOptions)

    await writeFile(join(agentRoot, 'agent-profile.toml'), 'version = [not valid')
    await resolveDeclaration(request(), fixedOptions)
    await writeFile(join(agentRoot, 'agent-profile.toml'), validProfile)

    expect(await resolveDeclaration(request(), fixedOptions)).toEqual(before)
    expect(before).toMatchObject({
      ok: true,
      source: {
        agentProfile: {
          state: 'valid',
          code: 'parsed',
          declaredHarness: 'claude',
        },
      },
      baselineProvisioning: {
        declaredHarness: 'claude',
        effectiveHarness: 'codex',
      },
    })
    expect(before.source.agentProfile).not.toHaveProperty('declaredProvider')
  })

  test('distinguishes declaration absent/invalid from unavailable/incompatible evidence', async () => {
    const resolveDeclaration = operation()
    const absent = await resolveDeclaration(
      request({ agentId: 'not-installed', agentRoot: undefined }),
      daemonDefaults()
    )
    expect(absent).toMatchObject({
      ok: false,
      resolution: { state: 'absent', code: 'agent_not_found' },
      source: { agentProfile: { state: 'absent', code: 'not_declared' } },
    })
    expect(absent).not.toHaveProperty('failure')

    // An invalid profile fails before project targets are read.
    await writeFile(join(agentRoot, 'agent-profile.toml'), 'version = [not valid')
    const invalidProfile = await resolveDeclaration(request(), daemonDefaults())
    expect(invalidProfile).toMatchObject({
      ok: false,
      resolution: { state: 'invalid', code: 'agent_profile_invalid' },
      source: {
        agentProfile: { state: 'invalid' },
        projectTargets: { state: 'absent', code: 'not_declared' },
      },
    })
    expect(invalidProfile).not.toHaveProperty('failure')

    // Invalid targets surface only once the profile parses.
    await writeProfile(agentRoot, 'verify', 'claude')
    await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = [not valid')
    const invalidTargets = await resolveDeclaration(request(), daemonDefaults())
    expect(invalidTargets).toMatchObject({
      ok: false,
      resolution: { state: 'invalid', code: 'project_targets_invalid' },
      source: {
        agentProfile: { state: 'valid' },
        projectTargets: { state: 'invalid' },
      },
    })
    expect(invalidTargets).not.toHaveProperty('failure')

    const nonDirectory = join(root, 'not-a-directory')
    await writeFile(nonDirectory, 'file')
    const incompatible = await resolveDeclaration(
      request({ agentRoot: nonDirectory }),
      daemonDefaults()
    )
    expect(incompatible).toMatchObject({
      ok: false,
      failure: { kind: 'incompatible', code: 'configured_context_mismatch' },
    })
    expect(incompatible).not.toHaveProperty('resolution')
  })
})

function operation(): ResolveRuntimeDeclaration {
  const value = (AgentSpaces as Record<string, unknown>)['resolveRuntimeDeclaration']
  expect(
    value,
    'agent-spaces must expose the request-time resolveRuntimeDeclaration producer operation'
  ).toBeFunction()
  return value as ResolveRuntimeDeclaration
}

function request(overrides: Partial<RuntimeContext> = {}) {
  return {
    schemaVersion: 'aspc-resolve-runtime-declaration-request/v1' as const,
    context: {
      agentId: 'smokey',
      agentRoot,
      project: { mode: 'root' as const, projectRoot, projectId: 'agent-spaces' },
      cwd: projectRoot,
      runMode: 'task' as const,
      agentSources: { aspHome, agentsRoot },
      ...overrides,
    },
  }
}

function daemonDefaults(): Record<string, unknown> {
  return {
    aspHome: join(root, 'wrong-daemon-home'),
    agentsRoot: join(root, 'wrong-daemon-agents'),
    environment: { ASP_PROJECT_ROOT_OVERRIDE: join(root, 'wrong-project') },
  }
}

async function writeProfile(path: string, role: string, harness: string): Promise<void> {
  await writeFile(
    join(path, 'agent-profile.toml'),
    `version = 4
operator = false

[identity]
display = "Smokey"
role = "${role}"

[provisioning]
harness = "${harness}"
model = "fixture-model"

[spaces]
base = []
`
  )
}
