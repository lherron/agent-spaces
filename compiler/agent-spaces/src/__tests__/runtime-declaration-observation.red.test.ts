/** T-08563 rev 5 declaration reds through the agent-spaces package entrypoint. */
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
  await writeFile(join(agentRoot, 'SOUL.md'), 'Smokey declaration fixture\n')
  await writeFile(join(outsideRoot, 'SOUL.md'), 'Outside roster fixture\n')
  await writeFile(
    join(projectRoot, 'asp-targets.toml'),
    `schema = 1

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

describe('T-08563 runtime declaration observation', () => {
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
        provisionDirectives: { harness: 'pi-sdk', model: 'openai-codex/gpt-5.5' },
      }),
      daemonDefaults()
    )

    expect(response.ok).toBe(true)
    expect(response.agentSources.provenance).toBe('caller-agent-root')
    expect(await realpath(response.placement.agentRoot)).toBe(await realpath(outsideRoot))
    expect(await realpath(response.agentSources.aspHome)).toBe(await realpath(aspHome))
    expect(await realpath(response.agentSources.agentsRoot)).toBe(await realpath(agentsRoot))
    expect(response.baselineProvisioning).toMatchObject({
      declaredHarness: 'claude',
      effectiveHarness: 'codex',
      provider: 'openai',
    })
    expect(response.provisioning).toMatchObject({
      effectiveHarness: 'pi-sdk',
      frontend: 'pi-sdk',
      provider: 'openai',
    })
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
    expect(none.baselineProvisioning.effectiveHarness).toBe('claude')
  })

  test('anchors caller-root searches without leaking daemon source configuration', async () => {
    const wrongAgentsRoot = join(root, 'wrong-daemon-agents')
    await mkdir(join(wrongAgentsRoot, 'smokey'), { recursive: true })
    await writeProfile(join(wrongAgentsRoot, 'smokey'), 'wrong-daemon', 'pi')
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
    await writeProfile(agentRoot, 'changed-without-restart', 'pi')
    const second = await resolveDeclaration(request(), daemonDefaults())
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      'schema = 1\n[targets.smokey]\ncompose = []\n[targets.smokey.provisioning]\nharness = "claude"\n'
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
      baselineProvisioning: { effectiveHarness: 'codex', provider: 'openai' },
    })

    const defaultOnly = await operation()(request({ project: { mode: 'none' } }), daemonDefaults())
    expect(defaultOnly).toMatchObject({
      ok: true,
      source: {
        agentProfile: { state: 'absent', code: 'not_declared' },
        projectTargets: { state: 'absent', code: 'not_declared' },
      },
      baselineProvisioning: { effectiveHarness: 'claude', provider: 'anthropic' },
    })
  })

  test.each([
    ['malformed TOML', 'version = [not valid'],
    ['schema-invalid TOML', 'version = 3\nunknown_key = true\n'],
  ])(
    'keeps target-only resolution available for an invalid profile: %s',
    async (_case, invalidProfile) => {
      const profilePath = join(agentRoot, 'agent-profile.toml')
      await writeFile(profilePath, invalidProfile)

      const response = await operation()(request(), daemonDefaults())
      const canonicalProfilePath = join(await realpath(agentRoot), 'agent-profile.toml')

      expect(response).toMatchObject({
        ok: true,
        source: {
          agentProfile: {
            state: 'invalid',
            diagnostics: [
              {
                severity: 'error',
                code: 'agent_profile_invalid',
                source: 'agent-profile',
                path: canonicalProfilePath,
              },
            ],
          },
          projectTargets: { state: 'valid', code: 'parsed' },
          selectedTarget: { state: 'valid', code: 'parsed' },
        },
        baselineProvisioning: {
          scalars: { harness: 'codex', model: 'gpt-5.6-sol' },
          effectiveHarness: 'codex',
          provider: 'openai',
        },
        provisioning: {
          scalars: { harness: 'codex', model: 'gpt-5.6-sol' },
          effectiveHarness: 'codex',
          provider: 'openai',
        },
        diagnostics: [
          {
            severity: 'error',
            code: 'agent_profile_invalid',
            source: 'agent-profile',
            path: canonicalProfilePath,
          },
        ],
      })
      expect(response.source.agentProfile).not.toHaveProperty('declaredHarness')
      expect(response.source.agentProfile).not.toHaveProperty('declaredProvider')
      expect(response.baselineProvisioning).not.toHaveProperty('declaredHarness')
      expect(response.provisioning).not.toHaveProperty('declaredHarness')
      expect(response.baselineProvisioning.scalars).toEqual({
        harness: 'codex',
        model: 'gpt-5.6-sol',
      })
      expect(response.provisioning.scalars).toEqual({
        harness: 'codex',
        model: 'gpt-5.6-sol',
      })
      expect(response.placement.projectRoot).toBe(await realpath(projectRoot))
      expect(response.bundle.ref).toEqual(response.placement.bundle)
    }
  )

  test('does not invent a harness scalar when the selected target omits one', async () => {
    await writeFile(join(agentRoot, 'agent-profile.toml'), 'version = [not valid')
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      `schema = 1

[targets.smokey]
[targets.smokey.provisioning]
model = "target-model-only"
`
    )

    const response = await operation()(
      request({ provisionDirectives: { harness: 'pi-sdk' } }),
      daemonDefaults()
    )

    expect(response.ok).toBe(true)
    expect(response.baselineProvisioning).toEqual({
      scalars: { model: 'target-model-only' },
      effectiveHarness: 'claude',
      frontend: 'claude-code',
      provider: 'anthropic',
      family: 'claude',
      runtime: 'claude-code',
    })
    expect(response.baselineProvisioning).not.toHaveProperty('declaredHarness')
    expect(response.provisioning).toEqual({
      scalars: { model: 'target-model-only', harness: 'pi-sdk' },
      effectiveHarness: 'pi-sdk',
      frontend: 'pi-sdk',
      provider: 'openai',
      family: 'pi-sdk',
      runtime: 'pi-sdk',
    })
    expect(response.provisioning).not.toHaveProperty('declaredHarness')
  })

  test.each([
    [true, false, { yolo: false, viewer: 'none' }, { yolo: false, remote: false, viewer: 'none' }],
    [false, true, { remote: false }, { yolo: false, remote: false }],
  ] as const)(
    'keeps explicit target booleans and overlays directives: yolo=%s remote=%s',
    async (yolo, remote, provisionDirectives, expectedFinalBooleans) => {
      await writeFile(join(agentRoot, 'agent-profile.toml'), 'version = [not valid')
      await writeFile(
        join(projectRoot, 'asp-targets.toml'),
        `schema = 1

[targets.smokey]
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
        frontend: 'codex-cli',
        provider: 'openai',
        family: 'codex',
        runtime: 'codex-cli',
      })
      expect(response.provisioning).toEqual({
        scalars: {
          harness: 'codex',
          model: 'gpt-5.6-sol',
          ...expectedFinalBooleans,
        },
        effectiveHarness: 'codex',
        frontend: 'codex-cli',
        provider: 'openai',
        family: 'codex',
        runtime: 'codex-cli',
      })
    }
  )

  test.each([
    [
      'malformed TOML / mode none',
      'version = [not valid',
      () => request({ project: { mode: 'none' } }),
      'absent',
    ],
    [
      'schema-invalid TOML / mode none',
      'version = 3\nunknown_key = true\n',
      () => request({ project: { mode: 'none' } }),
      'absent',
    ],
    [
      'malformed TOML / valid targets without a selected agent',
      'version = [not valid',
      () => request({ agentId: 'not-targeted', agentRoot }),
      'valid',
    ],
    [
      'schema-invalid TOML / valid targets without a selected agent',
      'version = 3\nunknown_key = true\n',
      () => request({ agentId: 'not-targeted', agentRoot }),
      'valid',
    ],
  ])(
    'keeps fail-open target-only resolution without a valid target: %s',
    async (_case, invalidProfile, makeRequest, expectedTargetState) => {
      const profilePath = join(agentRoot, 'agent-profile.toml')
      await writeFile(profilePath, invalidProfile)

      const response = await operation()(makeRequest(), daemonDefaults())
      const canonicalProfilePath = join(await realpath(agentRoot), 'agent-profile.toml')

      expect(response).toMatchObject({
        ok: true,
        source: {
          agentProfile: {
            state: 'invalid',
            diagnostics: [
              {
                code: 'agent_profile_invalid',
                source: 'agent-profile',
                path: canonicalProfilePath,
              },
            ],
          },
          selectedTarget: { state: 'absent', code: 'not_declared' },
        },
        baselineProvisioning: { scalars: {}, effectiveHarness: 'claude' },
        provisioning: { scalars: {}, effectiveHarness: 'claude' },
        diagnostics: [
          {
            code: 'agent_profile_invalid',
            source: 'agent-profile',
            path: canonicalProfilePath,
          },
        ],
      })
      expect(response.source.projectTargets).toMatchObject(
        expectedTargetState === 'valid'
          ? { state: 'valid', code: 'parsed' }
          : { state: 'absent', code: 'not_declared' }
      )
      expect(response.baselineProvisioning.scalars).toEqual({})
      expect(response.provisioning.scalars).toEqual({})
      expect(response.baselineProvisioning.scalars).not.toHaveProperty('harness')
      expect(response.provisioning.scalars).not.toHaveProperty('harness')
      expect(response.baselineProvisioning).not.toHaveProperty('declaredHarness')
      expect(response.provisioning).not.toHaveProperty('declaredHarness')
      expect(response).not.toHaveProperty('resolution')
      expect(response.bundle.ref).toEqual(response.placement.bundle)
      if (expectedTargetState === 'valid') {
        expect(response.placement.projectRoot).toBe(await realpath(projectRoot))
      } else {
        expect(response.placement).not.toHaveProperty('projectRoot')
      }
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
          declaredProvider: 'anthropic',
        },
      },
      baselineProvisioning: {
        declaredHarness: 'claude',
        effectiveHarness: 'codex',
        provider: 'openai',
      },
    })
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

    await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = [not valid')
    await writeFile(join(agentRoot, 'agent-profile.toml'), 'version = [not valid')
    const invalid = await resolveDeclaration(request(), daemonDefaults())
    expect(invalid).toMatchObject({
      ok: false,
      resolution: { state: 'invalid', code: 'project_targets_invalid' },
      source: {
        agentProfile: { state: 'invalid' },
        projectTargets: { state: 'invalid' },
      },
    })
    expect(invalid).not.toHaveProperty('failure')

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
    `version = 3
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
