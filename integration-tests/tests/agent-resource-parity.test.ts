import { chmod, cp, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import type { Skill } from '@earendil-works/pi-coding-agent'

import { compareProjections } from '../lib/agent-resource-parity/compare.js'
import { inventoryAgents } from '../lib/agent-resource-parity/inventory.js'
import { observeCompiler } from '../lib/agent-resource-parity/observe-compiler.js'
import { observeSdk } from '../lib/agent-resource-parity/observe-sdk.js'
import { projectResources } from '../lib/agent-resource-parity/projection.js'
import { createParityReplayContext } from '../lib/agent-resource-parity/replay-context.js'
import { verifyParityRows } from '../lib/agent-resource-parity/verify.js'
import { compilerRuntime } from './compiler-runtime.js'

async function fixtureSkill(root: string): Promise<Skill> {
  const skillDir = join(root, 'fixture')
  await mkdir(join(skillDir, 'nested'), { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: fixture\ndescription: fixture skill\n---\n# Fixture\n'
  )
  await writeFile(join(skillDir, 'nested', 'asset.txt'), 'raw asset\n')
  await chmod(join(skillDir, 'nested', 'asset.txt'), 0o755)
  await symlink('nested/asset.txt', join(skillDir, 'asset-link'))
  return {
    name: 'fixture',
    description: 'fixture skill',
    disableModelInvocation: false,
    filePath: join(skillDir, 'SKILL.md'),
    baseDir: skillDir,
    sourceInfo: { source: 'fixture' } as Skill['sourceInfo'],
  }
}

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const skillDir = join(root, name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`
  )
}

describe('agent resource parity task fixture', () => {
  test('fails closed for invalid candidates and stale exclusions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-resource-parity-inventory-'))
    const agentsRoot = join(root, 'agents')
    await mkdir(join(agentsRoot, 'valid'), { recursive: true })
    await writeFile(join(agentsRoot, 'valid', 'SOUL.md'), '# Valid\n')
    await writeFile(
      join(agentsRoot, 'valid', 'agent-profile.toml'),
      'version = 3\n\n[spaces]\nbase = []\n'
    )
    await mkdir(join(agentsRoot, 'excluded'), { recursive: true })
    await writeFile(
      join(agentsRoot, 'excluded', 'agent-profile.toml'),
      'version = 3\n\n[spaces]\nbase = []\n'
    )
    await expect(
      inventoryAgents({
        agentsRoot,
        exclusions: [
          {
            agentId: 'excluded',
            expectedDiagnostic: 'SOUL.md is required in agent root: {agentRoot}',
          },
        ],
      })
    ).resolves.toMatchObject({ valid: [{ agentId: 'valid' }], excluded: [{ agentId: 'excluded' }] })
    await expect(inventoryAgents({ agentsRoot, exclusions: [] })).rejects.toThrow(
      'Invalid agent candidate excluded'
    )
  })

  test('observes matching task-mode resources through compiler lowering and SDK Pi loading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-resource-parity-observe-'))
    const aspHome = join(root, 'asp-home')
    const agentSpaces = join(root, 'agents', 'spaces')
    const agentRoot = join(root, 'agents', 'fixture-agent')
    const projectRoot = join(root, 'agent-spaces')
    const codexShim = join(import.meta.dir, '../fixtures/codex-shim/codex')
    const originalCodexPath = process.env['ASP_CODEX_PATH']
    const originalAgentsRoot = process.env['ASP_AGENTS_ROOT']
    await cp(
      join(import.meta.dir, '../fixtures/sample-registry/spaces/base'),
      join(agentSpaces, 'base'),
      {
        recursive: true,
      }
    )
    await mkdir(projectRoot, { recursive: true })
    await mkdir(join(agentSpaces, 'base', 'skills', 'composed'), { recursive: true })
    await writeFile(
      join(agentSpaces, 'base', 'skills', 'composed', 'SKILL.md'),
      '---\nname: composed\ndescription: composed skill\n---\n# Composed\n'
    )
    await writeSkill(join(agentSpaces, 'base', 'skills'), 'local', 'composed duplicate loses')
    await writeSkill(join(agentRoot, 'skills'), 'local', 'agent-local skill')
    await writeFile(join(agentRoot, 'SOUL.md'), '# Fixture soul\n')
    await writeFile(
      join(agentRoot, 'agent-profile.toml'),
      `version = 3

[spaces]
base = ["space:base@dev"]

[instructions]
template = "context-template.toml"
`
    )
    const execCommand = "printf 'replayed exec'"
    await writeFile(
      join(agentRoot, 'context-template.toml'),
      `schema_version = 2
mode = "replace"

[[prompt]]
name = "task"
type = "inline"
content = "task={{taskId}} lane={{lane}}"

[[prompt]]
name = "exec"
type = "exec"
command = "${execCommand}"

[[prompt]]
name = "failed-exec"
type = "exec"
command = "printf 'failure detail' >&2; exit 23"

[[prompt]]
name = "services"
type = "service-probe"
services = [{ name = "broker", endpoint = "tcp://127.0.0.1:1" }]

[[reminder]]
name = "reminder"
type = "inline"
content = "remember task={{taskId}}"
`
    )
    const resolverContext = createParityReplayContext({
      agentRoot,
      agentsRoot: dirname(agentRoot),
      agentRootSearchPath: [agentRoot, dirname(agentRoot)],
      projectRoot,
      projectId: 'agent-spaces',
      agentId: 'fixture-agent',
      agentName: 'Fixture Agent',
      taskId: 'T-PARITY',
      lane: 'main',
      runMode: 'task',
      env: {},
      cwd: projectRoot,
      predicateCwd: projectRoot,
      predicateEnv: {},
      execCwd: projectRoot,
      execEnv: {},
      execResults: [
        {
          sectionName: 'exec',
          command: execCommand,
          occurrence: 1,
          exitStatus: 0,
          stdout: 'replayed exec',
          stderr: '',
        },
        {
          sectionName: 'failed-exec',
          command: "printf 'failure detail' >&2; exit 23",
          occurrence: 1,
          exitStatus: 23,
          stdout: '',
          stderr: 'failure detail',
        },
      ],
      serviceProbeResponses: [{ name: 'broker', endpoint: 'tcp://127.0.0.1:1', up: false }],
    })
    const placement = {
      agentRoot,
      projectRoot,
      cwd: projectRoot,
      runMode: 'task' as const,
      bundle: { kind: 'agent-project' as const, agentName: 'fixture-agent', projectRoot },
      correlation: {
        sessionRef: {
          scopeRef: 'agent:fixture-agent:project:agent-spaces:task:T-PARITY',
          laneRef: 'main',
        },
      },
    }
    process.env['ASP_CODEX_PATH'] = codexShim
    process.env['ASP_AGENTS_ROOT'] = dirname(agentRoot)
    try {
      const compiler = await observeCompiler({
        agentId: 'fixture-agent',
        mode: 'task',
        aspHome,
        runtime: compilerRuntime,
        request: {
          placement,
          aspHome,
          provider: 'openai',
          frontend: 'codex-cli',
          interactionMode: 'headless',
          model: 'gpt-5.6-sol',
          resolverContext,
        },
      })
      const sdk = await observeSdk({
        agentId: 'fixture-agent',
        mode: 'task',
        options: {
          agentId: 'fixture-agent',
          projectId: 'agent-spaces',
          agentRoot,
          projectRoot,
          cwd: projectRoot,
          aspHome,
          runMode: 'task',
          scopeRef: placement.correlation.sessionRef.scopeRef,
          laneRef: 'main',
          resolverContext,
        },
      })
      expect(() => verifyParityRows([{ compiler, sdk }])).not.toThrow()
      expect(compiler.prompt.content.toString()).toContain('task=T-PARITY lane=main')
      expect(compiler.prompt.content.toString()).toContain('replayed exec')
      expect(compiler.skills.catalog.map((skill) => skill.name)).toEqual(['local', 'composed'])
      expect(compiler.skills.catalog[0]?.description).toBe('agent-local skill')
    } finally {
      if (originalCodexPath === undefined) process.env['ASP_CODEX_PATH'] = undefined
      else process.env['ASP_CODEX_PATH'] = originalCodexPath
      if (originalAgentsRoot === undefined) process.env['ASP_AGENTS_ROOT'] = undefined
      else process.env['ASP_AGENTS_ROOT'] = originalAgentsRoot
    }
  })

  test('compares raw prompt/reminder bytes and selected skill package metadata without absolute roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-resource-parity-'))
    const skill = await fixtureSkill(root)
    const input = {
      agentId: 'fixture-agent',
      mode: 'task' as const,
      prompt: { mode: 'replace' as const, content: 'task=T-PARITY\n' },
      reminder: '',
      skills: [skill],
      skillRoots: [root],
    }
    const left = await projectResources(input)
    const right = await projectResources(input)

    expect(compareProjections(left, right)).toEqual([])
    expect(left.reminder.present).toBe(true)
    expect(left.skills.catalog[0]?.filePath).toBe('skill://fixture/SKILL.md')
    expect(left.skills.packages.get('fixture')).toContainEqual(
      expect.objectContaining({ path: 'asset-link', kind: 'symlink', target: 'nested/asset.txt' })
    )
    expect(left.skills.packages.get('fixture')).toContainEqual(
      expect.objectContaining({ path: 'nested/asset.txt', kind: 'file', executable: true })
    )
  })

  test('reports a bounded stable first-byte mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-resource-parity-diff-'))
    const skill = await fixtureSkill(root)
    const base = {
      agentId: 'fixture-agent',
      mode: 'task' as const,
      reminder: undefined,
      skills: [skill],
      skillRoots: [root],
    }
    const left = await projectResources({ ...base, prompt: { mode: 'replace', content: 'left' } })
    const right = await projectResources({ ...base, prompt: { mode: 'replace', content: 'lift' } })
    expect(compareProjections(left, right)).toEqual([
      expect.objectContaining({
        path: 'prompt/content.bin',
        message: expect.stringContaining('bytes differ at 1'),
      }),
    ])
    expect(() => verifyParityRows([{ compiler: left, sdk: right }])).toThrow(
      '[fixture-agent/task] prompt/content.bin: bytes differ at 1'
    )
  })

  test('negative controls identify each projected resource class', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-resource-parity-controls-'))
    const skill = await fixtureSkill(root)
    const base = await projectResources({
      agentId: 'fixture-agent',
      mode: 'task',
      prompt: { mode: 'replace', content: 'prompt' },
      reminder: 'reminder',
      skills: [skill],
      skillRoots: [root],
    })
    const paths = (right: typeof base) => compareProjections(base, right).map(({ path }) => path)
    expect(
      paths({ ...base, prompt: { ...base.prompt, content: Buffer.from('pr0mpt') } })
    ).toContain('prompt/content.bin')
    expect(paths({ ...base, prompt: { ...base.prompt, mode: 'append' } })).toContain(
      'prompt/mode.txt'
    )
    expect(paths({ ...base, reminder: { present: false } })).toContain('reminder/presence.txt')
    expect(
      paths({ ...base, reminder: { present: true, content: Buffer.from('remind3r') } })
    ).toContain('reminder/content.bin')
    expect(paths({ ...base, skills: { ...base.skills, catalog: [] } })).toContain(
      'skills/catalog.json'
    )
    expect(paths({ ...base, skills: { ...base.skills, packages: new Map() } })).toContain(
      'skills/packages/fixture'
    )
  })
})
