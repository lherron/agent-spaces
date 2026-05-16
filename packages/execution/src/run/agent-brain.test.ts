import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentLocalComponents } from 'spaces-config'

const AGENT_BRAIN_MODULE = './agent-brain.js'

type GbrainCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type GbrainCommandRunner = (
  argv: string[],
  env: Record<string, string>
) => Promise<GbrainCommandResult>

type GbrainCommandCall = {
  argv: string[]
  env: Record<string, string>
}

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })))
  tempDirs = []
})

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(path)
  return path
}

async function createStandardAgentRoot(agentName = 'smokey'): Promise<{
  praesidiumRoot: string
  agentRoot: string
}> {
  const praesidiumRoot = join(await createTempDir('agent-brain-praesidium-'), 'praesidium')
  const agentRoot = join(praesidiumRoot, 'var', 'agents', agentName)
  await mkdir(agentRoot, { recursive: true })
  return { praesidiumRoot, agentRoot }
}

function components(agentRoot: string): AgentLocalComponents {
  return {
    agentRoot,
    agentName: basename(agentRoot),
    hasSkills: false,
    hasCommands: false,
    hasTools: false,
    skillsDir: join(agentRoot, 'skills'),
    commandsDir: join(agentRoot, 'commands'),
    toolsDir: join(agentRoot, 'tools'),
    toolsBinDir: join(agentRoot, 'tools', 'bin'),
    agentVarDir: join(agentRoot, 'var'),
  }
}

function conventionalGbrainHome(praesidiumRoot: string, agentName = 'smokey'): string {
  return join(praesidiumRoot, 'var', 'state', 'gbrain', agentName)
}

function defaultBrainRepo(agentRoot: string): string {
  return join(agentRoot, 'brain')
}

function commandRecorder(
  handler: (argv: string[], env: Record<string, string>) => Promise<GbrainCommandResult>
): {
  calls: GbrainCommandCall[]
  runner: GbrainCommandRunner
} {
  const calls: GbrainCommandCall[] = []
  return {
    calls,
    runner: async (argv, env) => {
      calls.push({ argv, env })
      return handler(argv, env)
    },
  }
}

function successfulRunner(sourcesListStdout = ''): {
  calls: GbrainCommandCall[]
  runner: GbrainCommandRunner
} {
  return commandRecorder(async (argv) => {
    if (argv.join(' ') === 'sources list') {
      return { exitCode: 0, stdout: sourcesListStdout, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  })
}

async function loadPrepareAgentBrainRuntime(): Promise<
  (
    context: {
      agentRoot: string
      components: AgentLocalComponents
      brain?: {
        enabled: boolean
        search_mode?: 'conservative' | 'balanced' | 'tokenmax'
        resolver?: string
      }
    },
    baseEnv?: Record<string, string>,
    runner?: GbrainCommandRunner
  ) => Promise<Record<string, string>>
> {
  const module = (await import(AGENT_BRAIN_MODULE)) as {
    prepareAgentBrainRuntime: (
      context: {
        agentRoot: string
        components: AgentLocalComponents
        brain?: {
          enabled: boolean
          search_mode?: 'conservative' | 'balanced' | 'tokenmax'
          resolver?: string
        }
      },
      baseEnv?: Record<string, string>,
      runner?: GbrainCommandRunner
    ) => Promise<Record<string, string>>
  }

  return module.prepareAgentBrainRuntime
}

async function loadResolveAgentBrainRuntime(): Promise<
  (
    context: {
      agentRoot: string
      components: AgentLocalComponents
      brain?: {
        enabled: boolean
        search_mode?: 'conservative' | 'balanced' | 'tokenmax'
        resolver?: string
      }
    },
    baseEnv?: Record<string, string>,
    runner?: GbrainCommandRunner
  ) => Promise<Record<string, unknown>>
> {
  const module = (await import(AGENT_BRAIN_MODULE)) as {
    resolveAgentBrainRuntime: (
      context: {
        agentRoot: string
        components: AgentLocalComponents
        brain?: {
          enabled: boolean
          search_mode?: 'conservative' | 'balanced' | 'tokenmax'
          resolver?: string
        }
      },
      baseEnv?: Record<string, string>,
      runner?: GbrainCommandRunner
    ) => Promise<Record<string, unknown>>
  }

  return module.resolveAgentBrainRuntime
}

async function runPrepareAgentBrainRuntime(
  agentRoot: string,
  baseEnv: Record<string, string>,
  runner: GbrainCommandRunner
): Promise<Record<string, string>> {
  const prepareAgentBrainRuntime = await loadPrepareAgentBrainRuntime()

  return prepareAgentBrainRuntime({ agentRoot, components: components(agentRoot) }, baseEnv, runner)
}

describe('prepareAgentBrainRuntime', () => {
  test('absent brain profile preserves conventional runtime wiring', async () => {
    const { agentRoot, praesidiumRoot } = await createStandardAgentRoot()
    const gbrainHome = conventionalGbrainHome(praesidiumRoot)
    const brainRepo = defaultBrainRepo(agentRoot)
    const { runner } = successfulRunner()
    const resolveAgentBrainRuntime = await loadResolveAgentBrainRuntime()

    await expect(
      resolveAgentBrainRuntime({ agentRoot, components: components(agentRoot) }, {}, runner)
    ).resolves.toMatchObject({
      kind: 'enabled',
      env: { GBRAIN_HOME: gbrainHome, BRAIN_REPO: brainRepo },
      GBRAIN_HOME: gbrainHome,
      BRAIN_REPO: brainRepo,
      resolver: 'RESOLVER.md',
    })
  })

  test('enabled brain profile resolves runtime env', async () => {
    const { agentRoot, praesidiumRoot } = await createStandardAgentRoot()
    const gbrainHome = conventionalGbrainHome(praesidiumRoot)
    const brainRepo = defaultBrainRepo(agentRoot)
    const { runner } = successfulRunner()
    const resolveAgentBrainRuntime = await loadResolveAgentBrainRuntime()

    await expect(
      resolveAgentBrainRuntime(
        { agentRoot, components: components(agentRoot), brain: { enabled: true } },
        {},
        runner
      )
    ).resolves.toMatchObject({
      kind: 'enabled',
      env: { GBRAIN_HOME: gbrainHome, BRAIN_REPO: brainRepo },
      GBRAIN_HOME: gbrainHome,
      BRAIN_REPO: brainRepo,
      resolver: 'RESOLVER.md',
    })
  })

  test('disabled brain profile returns disabled result without runtime env', async () => {
    const { agentRoot } = await createStandardAgentRoot()
    const { calls, runner } = successfulRunner()
    const resolveAgentBrainRuntime = await loadResolveAgentBrainRuntime()
    const prepareAgentBrainRuntime = await loadPrepareAgentBrainRuntime()

    const resolution = await resolveAgentBrainRuntime(
      { agentRoot, components: components(agentRoot), brain: { enabled: false } },
      {},
      runner
    )

    expect(resolution).toEqual({
      kind: 'disabled',
      env: {},
      reason: 'profile-disabled',
      resolver: 'RESOLVER.md',
    })
    expect(calls).toHaveLength(0)
    expect('GBRAIN_HOME' in (resolution.env as Record<string, unknown>)).toBe(false)
    expect('BRAIN_REPO' in (resolution.env as Record<string, unknown>)).toBe(false)

    await expect(
      prepareAgentBrainRuntime(
        { agentRoot, components: components(agentRoot), brain: { enabled: false } },
        {},
        runner
      )
    ).resolves.toEqual({})
  })

  test('loads disabled brain profile from agent-profile.toml', async () => {
    const { agentRoot } = await createStandardAgentRoot()
    await writeFile(
      join(agentRoot, 'agent-profile.toml'),
      `
schemaVersion = 2

[brain]
enabled = false
`
    )
    const { calls, runner } = successfulRunner()
    const resolveAgentBrainRuntime = await loadResolveAgentBrainRuntime()

    await expect(
      resolveAgentBrainRuntime({ agentRoot, components: components(agentRoot) }, {}, runner)
    ).resolves.toEqual({
      kind: 'disabled',
      env: {},
      reason: 'profile-disabled',
      resolver: 'RESOLVER.md',
    })
    expect(calls).toHaveLength(0)
  })

  test('brain profile carries search_mode and resolver overrides into admission result', async () => {
    const { agentRoot } = await createStandardAgentRoot()
    const { runner } = successfulRunner()
    const resolveAgentBrainRuntime = await loadResolveAgentBrainRuntime()

    await expect(
      resolveAgentBrainRuntime(
        {
          agentRoot,
          components: components(agentRoot),
          brain: {
            enabled: true,
            search_mode: 'tokenmax',
            resolver: 'custom/RESOLVER.md',
          },
        },
        {},
        runner
      )
    ).resolves.toMatchObject({
      kind: 'enabled',
      search_mode: 'tokenmax',
      resolver: 'custom/RESOLVER.md',
    })
  })

  test('creates missing BRAIN_REPO directory', async () => {
    const { agentRoot } = await createStandardAgentRoot()
    const brainRepo = defaultBrainRepo(agentRoot)
    const { runner } = successfulRunner()

    await runPrepareAgentBrainRuntime(agentRoot, {}, runner)

    await expect(stat(brainRepo)).resolves.toMatchObject({})
  })

  test('creates missing GBRAIN_HOME directory', async () => {
    const { agentRoot, praesidiumRoot } = await createStandardAgentRoot()
    const gbrainHome = conventionalGbrainHome(praesidiumRoot)
    const { runner } = successfulRunner()

    await runPrepareAgentBrainRuntime(agentRoot, {}, runner)

    await expect(stat(gbrainHome)).resolves.toMatchObject({})
  })

  test('runs gbrain init --pglite when uninitialized', async () => {
    const { agentRoot, praesidiumRoot } = await createStandardAgentRoot()
    const gbrainHome = conventionalGbrainHome(praesidiumRoot)
    const { calls, runner } = successfulRunner()

    await runPrepareAgentBrainRuntime(agentRoot, {}, runner)

    expect(calls).toContainEqual({
      argv: ['init', '--pglite'],
      env: { GBRAIN_HOME: gbrainHome, BRAIN_REPO: defaultBrainRepo(agentRoot) },
    })
  })

  test('skips init when already initialized', async () => {
    const { agentRoot, praesidiumRoot } = await createStandardAgentRoot()
    const gbrainHome = conventionalGbrainHome(praesidiumRoot)
    await mkdir(join(gbrainHome, '.gbrain'), { recursive: true })
    await writeFile(join(gbrainHome, '.gbrain', 'config.json'), '{}')
    await writeFile(join(gbrainHome, '.gbrain', 'brain.pglite'), '')
    const { calls, runner } = successfulRunner()

    await runPrepareAgentBrainRuntime(agentRoot, {}, runner)

    expect(calls.some((call) => call.argv.join(' ') === 'init --pglite')).toBe(false)
  })

  test('registers source agentName when sources list reports no matching entry', async () => {
    const { agentRoot, praesidiumRoot } = await createStandardAgentRoot()
    const gbrainHome = conventionalGbrainHome(praesidiumRoot)
    const brainRepo = defaultBrainRepo(agentRoot)
    const { calls, runner } = successfulRunner('')

    await runPrepareAgentBrainRuntime(agentRoot, {}, runner)

    expect(calls).toContainEqual({
      argv: ['sources', 'add', 'smokey', '--path', brainRepo],
      env: { GBRAIN_HOME: gbrainHome, BRAIN_REPO: brainRepo },
    })
  })

  test('repairs source when sources list points agentName at a stale path', async () => {
    const { agentRoot, praesidiumRoot } = await createStandardAgentRoot()
    const gbrainHome = conventionalGbrainHome(praesidiumRoot)
    const brainRepo = defaultBrainRepo(agentRoot)
    const { calls, runner } = successfulRunner('smokey /tmp/stale-brain\n')

    await runPrepareAgentBrainRuntime(agentRoot, {}, runner)

    expect(calls).toContainEqual({
      argv: ['sources', 'remove', 'smokey'],
      env: { GBRAIN_HOME: gbrainHome, BRAIN_REPO: brainRepo },
    })
    expect(calls).toContainEqual({
      argv: ['sources', 'add', 'smokey', '--path', brainRepo],
      env: { GBRAIN_HOME: gbrainHome, BRAIN_REPO: brainRepo },
    })
    expect(calls.findIndex((call) => call.argv.join(' ') === 'sources remove smokey')).toBeLessThan(
      calls.findIndex((call) => call.argv.join(' ') === `sources add smokey --path ${brainRepo}`)
    )
  })

  test('respects explicit GBRAIN_HOME from baseEnv override', async () => {
    const { agentRoot, praesidiumRoot } = await createStandardAgentRoot()
    const explicitGbrainHome = join(await createTempDir('agent-brain-explicit-home-'), 'home')
    const conventionalHome = conventionalGbrainHome(praesidiumRoot)
    const { calls, runner } = successfulRunner()

    const env = await runPrepareAgentBrainRuntime(
      agentRoot,
      { GBRAIN_HOME: explicitGbrainHome },
      runner
    )

    expect(env['GBRAIN_HOME']).toBe(explicitGbrainHome)
    expect(env['GBRAIN_HOME']).not.toBe(conventionalHome)
    await expect(stat(explicitGbrainHome)).resolves.toMatchObject({})
    expect(calls).toContainEqual({
      argv: ['init', '--pglite'],
      env: { GBRAIN_HOME: explicitGbrainHome, BRAIN_REPO: defaultBrainRepo(agentRoot) },
    })
  })

  test('respects explicit BRAIN_REPO from baseEnv override', async () => {
    const { agentRoot } = await createStandardAgentRoot()
    const explicitBrainRepo = join(await createTempDir('agent-brain-explicit-repo-'), 'brain')
    const conventionalRepo = defaultBrainRepo(agentRoot)
    const { runner } = successfulRunner()

    const env = await runPrepareAgentBrainRuntime(
      agentRoot,
      { BRAIN_REPO: explicitBrainRepo },
      runner
    )

    expect(env['BRAIN_REPO']).toBe(explicitBrainRepo)
    expect(env['BRAIN_REPO']).not.toBe(conventionalRepo)
    await expect(stat(explicitBrainRepo)).resolves.toMatchObject({})
  })

  test('throws when the injected runner reports gbrain is missing', async () => {
    const { agentRoot } = await createStandardAgentRoot()
    const missingGbrainRunner: GbrainCommandRunner = async () => {
      throw Object.assign(new Error('spawn gbrain ENOENT'), { code: 'ENOENT' })
    }
    const prepareAgentBrainRuntime = await loadPrepareAgentBrainRuntime()

    await expect(
      prepareAgentBrainRuntime(
        { agentRoot, components: components(agentRoot) },
        {},
        missingGbrainRunner
      )
    ).rejects.toThrow('gbrain')
  })

  test('throws when gbrain init --pglite exits non-zero', async () => {
    const { agentRoot } = await createStandardAgentRoot()
    const { runner } = commandRecorder(async (argv) => {
      if (argv.join(' ') === 'init --pglite') {
        return { exitCode: 2, stdout: '', stderr: 'init exploded' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const prepareAgentBrainRuntime = await loadPrepareAgentBrainRuntime()

    await expect(
      prepareAgentBrainRuntime({ agentRoot, components: components(agentRoot) }, {}, runner)
    ).rejects.toThrow('init exploded')
  })

  test('throws when source registration fails', async () => {
    const { agentRoot } = await createStandardAgentRoot()
    const { runner } = commandRecorder(async (argv) => {
      if (argv.join(' ') === 'sources add smokey --path '.concat(defaultBrainRepo(agentRoot))) {
        return { exitCode: 9, stdout: '', stderr: 'source add failed' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const prepareAgentBrainRuntime = await loadPrepareAgentBrainRuntime()

    await expect(
      prepareAgentBrainRuntime({ agentRoot, components: components(agentRoot) }, {}, runner)
    ).rejects.toThrow('source add failed')
  })

  test('throws when an existing BRAIN_REPO path is not a directory', async () => {
    const { agentRoot } = await createStandardAgentRoot()
    await writeFile(defaultBrainRepo(agentRoot), 'not a directory')
    const { runner } = successfulRunner()
    const prepareAgentBrainRuntime = await loadPrepareAgentBrainRuntime()

    await expect(
      prepareAgentBrainRuntime({ agentRoot, components: components(agentRoot) }, {}, runner)
    ).rejects.toThrow('directory')
  })

  test('returns env exactly equal to GBRAIN_HOME and BRAIN_REPO', async () => {
    const { agentRoot, praesidiumRoot } = await createStandardAgentRoot()
    const gbrainHome = conventionalGbrainHome(praesidiumRoot)
    const brainRepo = defaultBrainRepo(agentRoot)
    const { runner } = successfulRunner()
    const prepareAgentBrainRuntime = await loadPrepareAgentBrainRuntime()

    await expect(
      prepareAgentBrainRuntime(
        { agentRoot, components: components(agentRoot) },
        { PATH: '/usr/bin' },
        runner
      )
    ).resolves.toEqual({
      GBRAIN_HOME: gbrainHome,
      BRAIN_REPO: brainRepo,
    })
  })
})
