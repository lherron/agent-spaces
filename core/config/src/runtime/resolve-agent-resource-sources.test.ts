import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import type { AgentLocalComponents } from '../core/types/agent-local.js'
import type { RuntimePlacement } from '../core/types/placement.js'
import { git, resolveAgentResourceSources } from '../index.js'
import * as materializer from '../materializer/materialize.js'
import * as install from '../orchestration/install.js'
import * as runtimeMaterialization from './materialize-agent-runtime.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`))
  roots.push(root)
  return root
}

async function writeSpace(
  registryRoot: string,
  id: string,
  options: {
    dependencies?: string[]
    pluginName?: string
    supports?: string[]
    resources?: boolean
  } = {}
): Promise<void> {
  const root = join(registryRoot, 'spaces', id)
  await mkdir(root, { recursive: true })
  const dependencies = options.dependencies ?? []
  await writeFile(
    join(root, 'space.toml'),
    [
      'schema = 1',
      `id = "${id}"`,
      '',
      '[plugin]',
      `name = "${options.pluginName ?? id}"`,
      '',
      '[harness]',
      `supports = [${(options.supports ?? ['pi']).map((value) => `"${value}"`).join(', ')}]`,
      ...(dependencies.length > 0
        ? ['', '[deps]', `spaces = [${dependencies.map((value) => `"${value}"`).join(', ')}]`]
        : []),
      '',
    ].join('\n')
  )
  if (options.resources !== false) {
    await mkdir(join(root, 'skills', `${id}-skill`), { recursive: true })
    await mkdir(join(root, 'extensions'), { recursive: true })
    await mkdir(join(root, 'commands'), { recursive: true })
    await writeFile(join(root, 'skills', `${id}-skill`, 'SKILL.md'), `# ${id}\n`)
    await writeFile(join(root, 'extensions', `${id}.ts`), 'export default {}\n')
    await writeFile(join(root, 'commands', `${id}.md`), `# ${id}\n`)
  }
}

async function createFixture(options: { unsupported?: boolean; missingCommit?: boolean } = {}) {
  const root = await tempRoot('agent-resource-sources')
  const registryRoot = join(root, 'registry')
  const aspHome = join(root, 'asp-home')
  const agentRoot = join(root, 'agents', 'larry')
  const projectRoot = join(root, 'project')

  await mkdir(registryRoot, { recursive: true })
  await writeSpace(registryRoot, 'base', { pluginName: 'shared-plugin' })
  await git.initRepo(registryRoot, { initialBranch: 'main' })
  await git.gitExec(['config', 'user.email', 'resource-sources@example.test'], {
    cwd: registryRoot,
  })
  await git.gitExec(['config', 'user.name', 'Resource Sources Test'], { cwd: registryRoot })
  await git.add(['spaces/base'], { cwd: registryRoot })
  const committedBase = await git.commit('base fixture', { cwd: registryRoot })
  const immutableCommit = options.missingCommit ? 'f'.repeat(40) : committedBase

  await writeSpace(registryRoot, 'current', {
    dependencies: [`space:base@git:${immutableCommit}`],
    pluginName: 'shared-plugin',
    supports: options.unsupported ? ['codex'] : ['pi-sdk'],
  })

  await mkdir(join(agentRoot, 'skills', 'agent-skill'), { recursive: true })
  await mkdir(join(agentRoot, 'commands'), { recursive: true })
  await mkdir(join(agentRoot, 'tools', 'bin'), { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(agentRoot, 'SOUL.md'), '# Larry\n')
  await writeFile(join(agentRoot, 'skills', 'agent-skill', 'SKILL.md'), '# agent\n')
  await writeFile(join(agentRoot, 'commands', 'agent-command.md'), '# agent command\n')
  await writeFile(
    join(agentRoot, 'agent-profile.toml'),
    [
      'version = 3',
      '',
      '[spaces]',
      'base = ["space:current@dev"]',
      '',
      '[provisioning]',
      'harness = "agent-harness"',
      'model = "gpt-5.6-sol"',
      'reasoning = "high"',
      '',
    ].join('\n')
  )

  const placement: RuntimePlacement = {
    agentRoot,
    projectRoot,
    cwd: projectRoot,
    runMode: 'task',
    bundle: { kind: 'agent-project', agentName: 'larry', projectRoot },
    correlation: {
      sessionRef: {
        scopeRef: 'agent:larry:project:agent-spaces:task:T-07543',
        laneRef: 'main',
      },
    },
  }
  const agentLocalComponents: AgentLocalComponents = {
    agentRoot,
    agentName: 'larry',
    hasSkills: true,
    hasCommands: true,
    hasTools: true,
    skillsDir: join(agentRoot, 'skills'),
    commandsDir: join(agentRoot, 'commands'),
    toolsDir: join(agentRoot, 'tools'),
    toolsBinDir: join(agentRoot, 'tools', 'bin'),
    agentVarDir: join(agentRoot, 'var'),
  }

  return { agentLocalComponents, agentRoot, aspHome, placement, projectRoot, registryRoot }
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else files.push(relative(root, path))
    }
  }
  await visit(root)
  return files.sort()
}

describe('resolveAgentResourceSources', () => {
  test('returns ordered attributed mutable, immutable, and agent-local roots without materializing', async () => {
    const fixture = await createFixture()
    const materializeSpace = spyOn(materializer, 'materializeSpace')
    const materializeTarget = spyOn(install, 'materializeTarget')
    const materializeAgentRuntimeResources = spyOn(
      runtimeMaterialization,
      'materializeAgentRuntimeResources'
    )

    const resolved = await resolveAgentResourceSources({
      placement: fixture.placement,
      aspHome: fixture.aspHome,
      registryPathOverride: fixture.registryRoot,
      agentLocalComponents: fixture.agentLocalComponents,
      baseEnvironment: { BASE_ONLY: 'present' },
      reqDispatchEnv: { AGENT_ID: 'spoofed', DISPATCH_ONLY: 'present' },
      runtime: {
        async prepareAgentToolRuntime(_context, baseEnv) {
          expect(baseEnv?.['AGENT_ID']).toBe('larry')
          return {
            env: { TOOL_RUNTIME: 'prepared' },
            pathPrepend: [fixture.agentLocalComponents.toolsBinDir],
            warnings: ['tool runtime warning'],
          }
        },
      },
    })

    expect(resolved.cwd).toBe(fixture.projectRoot)
    expect(resolved.effectiveConfig).toEqual({ model: 'gpt-5.6-sol', reasoning: 'high' })
    expect(resolved.environment).toMatchObject({
      BASE_ONLY: 'present',
      DISPATCH_ONLY: 'present',
      AGENT_ID: 'larry',
      TOOL_RUNTIME: 'prepared',
    })
    expect(resolved.pathPrepend).toEqual([fixture.agentLocalComponents.toolsBinDir])
    expect(resolved.orderedSpaces.map(({ ref, source }) => ({ ref, source }))).toEqual([
      { ref: expect.stringContaining('space:base@git:'), source: 'immutable-snapshot' },
      { ref: 'space:current@dev', source: 'mutable' },
    ])
    expect(resolved.orderedSpaces[0]?.root).toContain(join(fixture.aspHome, 'snapshots'))
    expect(resolved.orderedSpaces[1]?.root).toBe(join(fixture.registryRoot, 'spaces', 'current'))

    expect(resolved.skillRoots.map((root) => [root.owner.kind, root.precedence])).toEqual([
      ['space', 0],
      ['space', 1],
      ['agent-local', 2],
    ])
    expect(resolved.extensionRoots.map((root) => root.owner.kind)).toEqual(['space', 'space'])
    expect(resolved.promptTemplateRoots.map((root) => root.owner.kind)).toEqual([
      'space',
      'space',
      'agent-local',
    ])
    expect(resolved.skillRoots.at(-1)?.root).toBe(fixture.agentLocalComponents.skillsDir)
    expect(resolved.promptTemplateRoots.at(-1)?.root).toBe(fixture.agentLocalComponents.commandsDir)
    expect(resolved.warnings).toContain('tool runtime warning')
    expect(resolved.warnings.some((warning) => warning.includes('W205'))).toBe(true)

    expect(materializeSpace).not.toHaveBeenCalled()
    expect(materializeTarget).not.toHaveBeenCalled()
    expect(materializeAgentRuntimeResources).not.toHaveBeenCalled()
    const files = await listRelativeFiles(fixture.aspHome)
    expect(files.some((file) => file.endsWith('bundle.json'))).toBe(false)
    expect(files.some((file) => file.endsWith('.asp-materialized.json'))).toBe(false)
  })

  test('fails visibly when a selected space does not support agent-harness', async () => {
    const fixture = await createFixture({ unsupported: true })

    await expect(
      resolveAgentResourceSources({
        placement: fixture.placement,
        aspHome: fixture.aspHome,
        registryPathOverride: fixture.registryRoot,
        agentLocalComponents: fixture.agentLocalComponents,
        runtime: {
          async prepareAgentToolRuntime() {
            return { env: {}, pathPrepend: [], warnings: [] }
          },
        },
      })
    ).rejects.toThrow(/current.*does not support.*agent-harness/i)
  })

  test('propagates missing pinned immutable content instead of warning or materializing', async () => {
    const fixture = await createFixture({ missingCommit: true })

    await expect(
      resolveAgentResourceSources({
        placement: fixture.placement,
        aspHome: fixture.aspHome,
        registryPathOverride: fixture.registryRoot,
        agentLocalComponents: fixture.agentLocalComponents,
        runtime: {
          async prepareAgentToolRuntime() {
            return { env: {}, pathPrepend: [], warnings: [] }
          },
        },
      })
    ).rejects.toThrow(/current.*base/i)

    const files = await listRelativeFiles(fixture.aspHome)
    expect(files.some((file) => file.endsWith('bundle.json'))).toBe(false)
    expect(files.some((file) => file.endsWith('.asp-materialized.json'))).toBe(false)
  })
})
