import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as realPi from '@mariozechner/pi-coding-agent'
import type { Skill } from '@mariozechner/pi-coding-agent'

// Capture the options createAgentSession is called with, while keeping every
// other export (AuthStorage / ModelRegistry / SessionManager / DefaultResourceLoader)
// REAL so PiSession.start() builds and reloads a genuine resource loader.
let captured: { resourceLoader?: unknown } | undefined

mock.module('@mariozechner/pi-coding-agent', () => ({
  ...realPi,
  createAgentSession: async (options: { resourceLoader?: unknown }) => {
    captured = options
    return {
      session: { subscribe: () => () => {}, abort: () => {} },
      extensionsResult: {},
    }
  },
}))

const { PiSession } = await import('./pi-session.js')
type PiSessionConfig = ConstructorParameters<typeof PiSession>[0]
type Loader = InstanceType<typeof realPi.DefaultResourceLoader>

const tmpDirs: string[] = []

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function skill(name: string, description = `desc-${name}`): Skill {
  return {
    name,
    description,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { source: 'test' } as unknown as Skill['sourceInfo'],
    disableModelInvocation: false,
  }
}

/** Write a skill Pi discovers under `<agentDir>/skills/<name>/SKILL.md`. */
function discoveredSkill(agentDir: string, name: string, description?: string): void {
  const dir = join(agentDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  const frontmatter = description === undefined ? '' : `description: ${description}\n`
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n${frontmatter}---\n\nBody.\n`)
}

const ext = (() => ({})) as unknown as NonNullable<PiSessionConfig['extensions']>[number]

/**
 * Every session gets its own cwd and Pi global agent dir under the OS temp dir,
 * so start() never builds AuthStorage under the real $HOME/.pi/agent and never
 * discovers the user's own skills or context files.
 */
function sessionConfig(overrides: Partial<PiSessionConfig> = {}): PiSessionConfig & {
  cwd: string
  globalAgentDir: string
} {
  return {
    ownerId: 'owner',
    cwd: tmp('pi-start-cwd-'),
    globalAgentDir: tmp('pi-start-agent-'),
    persistSessions: false,
    ...overrides,
  } as PiSessionConfig & { cwd: string; globalAgentDir: string }
}

async function startAndCaptureLoader(
  config: PiSessionConfig,
  options?: Parameters<InstanceType<typeof PiSession>['start']>[0]
): Promise<Loader> {
  await new PiSession(config).start(options)
  expect(captured).toBeDefined()
  const loader = captured?.resourceLoader as Loader | undefined
  expect(loader).toBeDefined()
  return loader as Loader
}

describe('PiSession.start() resource wiring', () => {
  beforeEach(() => {
    captured = undefined
  })

  afterAll(() => {
    mock.restore()
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('passes a resourceLoader whose reload() surfaces every supplied resource', async () => {
    const loader = await startAndCaptureLoader(
      sessionConfig({
        systemPrompt: 'SYS-PROMPT',
        extensions: [ext],
        additionalExtensionPaths: [],
        skills: [skill('cfg-skill')],
        contextFiles: [{ path: 'CTX.md', content: 'ctx' }],
      }),
      { skills: [skill('start-skill')] }
    )

    // The loader has already been reload()ed inside start().
    expect(loader.getSystemPrompt()).toBe('SYS-PROMPT')
    expect(loader.getSkills().skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(['cfg-skill', 'start-skill'])
    )
    expect(loader.getAgentsFiles().agentsFiles.map((f) => f.path)).toContain('CTX.md')
    expect(loader.getExtensions().extensions.length).toBeGreaterThanOrEqual(1)
  })

  test.each([
    ['no resource inputs', {}],
    ['empty resource arrays', { extensions: [], skills: [], contextFiles: [] }],
  ])(
    'no-resource regression: %s passes NO resourceLoader (Pi normal discovery)',
    async (_label, overrides) => {
      await new PiSession(sessionConfig(overrides)).start()

      expect(captured).toBeDefined()
      expect(captured?.resourceLoader).toBeUndefined()
    }
  )

  test('a systemPrompt alone still builds a loader that serves it and nothing else', async () => {
    const loader = await startAndCaptureLoader(sessionConfig({ systemPrompt: 'only-sys' }))

    expect(loader.getSystemPrompt()).toBe('only-sys')
    expect(loader.getExtensions().extensions).toEqual([])
    expect(loader.getSkills().skills).toEqual([])
    expect(loader.getAgentsFiles().agentsFiles).toEqual([])
  })

  test('additionalExtensionPaths load the extension file alongside supplied extension factories', async () => {
    const extDir = tmp('pi-start-ext-')
    const extPath = join(extDir, 'path-ext.ts')
    writeFileSync(extPath, 'export default function pathExtension() {}\n')

    const loader = await startAndCaptureLoader(
      sessionConfig({ extensions: [ext, ext], additionalExtensionPaths: [extPath] })
    )

    const { extensions, errors } = loader.getExtensions()
    expect(errors).toEqual([])
    expect(extensions).toHaveLength(3)
    expect(extensions.map((e) => e.resolvedPath)).toContain(extPath)
  })

  test('supplied skills add to skills discovered under the agent dir and keep their diagnostics', async () => {
    const config = sessionConfig({ skills: [skill('alpha'), skill('beta')] })
    discoveredSkill(config.globalAgentDir, 'discovered', 'found on disk')
    // A discovered skill with no description is refused with a diagnostic.
    discoveredSkill(config.globalAgentDir, 'broken')

    const loader = await startAndCaptureLoader(config)

    const { skills, diagnostics } = loader.getSkills()
    expect(skills.map((s) => s.name)).toEqual(['discovered', 'alpha', 'beta'])
    expect(diagnostics.map((d) => d.path)).toContain(
      join(config.globalAgentDir, 'skills', 'broken', 'SKILL.md')
    )
  })

  test('a supplied skill replaces a discovered skill of the same name', async () => {
    const config = sessionConfig({ skills: [skill('shared', 'supplied copy')] })
    discoveredSkill(config.globalAgentDir, 'shared', 'discovered copy')

    const loader = await startAndCaptureLoader(config)

    expect(loader.getSkills().skills.map((s) => [s.name, s.description])).toEqual([
      ['shared', 'supplied copy'],
    ])
  })

  test('explicit context files append after the discovered AGENTS.md and CLAUDE.md', async () => {
    const config = sessionConfig({ contextFiles: [{ path: 'CTX.md', content: 'ctx' }] })
    writeFileSync(join(config.globalAgentDir, 'AGENTS.md'), 'agents')
    writeFileSync(join(config.cwd, 'CLAUDE.md'), 'claude')

    const loader = await startAndCaptureLoader(config)

    expect(loader.getAgentsFiles().agentsFiles).toEqual([
      { path: join(config.globalAgentDir, 'AGENTS.md'), content: 'agents' },
      { path: join(config.cwd, 'CLAUDE.md'), content: 'claude' },
      { path: 'CTX.md', content: 'ctx' },
    ])
  })

  test('an explicit context file at a discovered path replaces the discovered content', async () => {
    const config = sessionConfig()
    const agentsPath = join(config.cwd, 'AGENTS.md')
    writeFileSync(agentsPath, 'discovered')

    const loader = await startAndCaptureLoader({
      ...config,
      contextFiles: [{ path: agentsPath, content: 'injected' }],
    })

    expect(loader.getAgentsFiles().agentsFiles).toEqual([{ path: agentsPath, content: 'injected' }])
  })

  test('start() options override the config systemPrompt and append to the config resources', async () => {
    const extDir = tmp('pi-start-ext-')
    const extPath = join(extDir, 'cfg-ext.ts')
    writeFileSync(extPath, 'export default function cfgExtension() {}\n')

    const loader = await startAndCaptureLoader(
      sessionConfig({
        systemPrompt: 'from-config',
        extensions: [ext],
        skills: [skill('cfg')],
        contextFiles: [{ path: 'cfg.md', content: 'c' }],
        additionalExtensionPaths: [extPath],
      }),
      {
        systemPrompt: 'from-start',
        extensions: [ext],
        skills: [skill('start')],
        contextFiles: [{ path: 'start.md', content: 's' }],
      }
    )

    expect(loader.getSystemPrompt()).toBe('from-start')
    expect(loader.getSkills().skills.map((s) => s.name)).toEqual(['cfg', 'start'])
    expect(loader.getAgentsFiles().agentsFiles.map((f) => f.path)).toEqual(['cfg.md', 'start.md'])
    // Two factories (config + start) plus the config's extension path.
    expect(loader.getExtensions().extensions).toHaveLength(3)
    expect(loader.getExtensions().extensions.map((e) => e.resolvedPath)).toContain(extPath)
  })
})
