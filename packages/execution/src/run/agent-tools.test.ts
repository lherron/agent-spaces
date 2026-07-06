import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import {
  type AgentLocalComponents,
  getProjectStorageId,
  sanitizeProjectAgentScopeSegment,
} from 'spaces-config'

import { prepareAgentToolRuntime, validateAgentTools } from './agent-tools.js'

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

function components(agentRoot: string, hasTools = true): AgentLocalComponents {
  return {
    agentRoot,
    agentName: basename(agentRoot),
    hasSkills: false,
    hasCommands: false,
    hasTools,
    skillsDir: join(agentRoot, 'skills'),
    commandsDir: join(agentRoot, 'commands'),
    toolsDir: join(agentRoot, 'tools'),
    toolsBinDir: join(agentRoot, 'tools', 'bin'),
    agentVarDir: join(agentRoot, 'var'),
  }
}

async function writeTool(agentRoot: string, name: string, source = '#!/bin/sh\necho ok\n') {
  const toolPath = join(agentRoot, 'tools', 'bin', name)
  await mkdir(join(agentRoot, 'tools', 'bin'), { recursive: true })
  await writeFile(toolPath, source)
  await chmod(toolPath, 0o755)
  return toolPath
}

describe('prepareAgentToolRuntime', () => {
  test('returns durable agent env when tools are disabled', async () => {
    const agentRoot = await createTempDir('agent-tools-none-')
    const projectRoot = await createTempDir('agent-tools-none-project-')
    const result = await prepareAgentToolRuntime({
      agentRoot,
      projectRoot,
      components: components(agentRoot, false),
    })
    const projectId = getProjectStorageId(projectRoot, basename(agentRoot))

    // T-04936: Durable agent/project env is a runtime placement contract, not
    // a tools contract. Only PATH and ASP_AGENT_TOOLS_* stay tools-gated.
    expect(result).toMatchObject({
      pathPrepend: [],
      warnings: [],
      env: {
        ASP_AGENT_ROOT: agentRoot,
        ASP_AGENT_NAME: basename(agentRoot),
        ASP_AGENT_VAR_DIR: join(agentRoot, 'var'),
        ASP_AGENT_STATE_DIR: join(agentRoot, 'var', 'state'),
        ASP_AGENT_CACHE_DIR: join(agentRoot, 'var', 'cache'),
        ASP_AGENT_LOG_DIR: join(agentRoot, 'var', 'logs'),
        ASP_PROJECT_ROOT: projectRoot,
        ASP_PROJECT_ID: projectId,
        ASP_PROJECT_STATE_DIR: join(agentRoot, 'var', 'state', 'projects', projectId),
      },
    })
    expect(result.env).not.toHaveProperty('ASP_AGENT_TOOLS_DIR')
    expect(result.env).not.toHaveProperty('ASP_AGENT_TOOLS_BIN')
    expect(result.env).not.toHaveProperty('PATH')
    await expect(stat(join(agentRoot, 'var', 'state'))).resolves.toMatchObject({})
    await expect(stat(join(agentRoot, 'var', 'cache'))).resolves.toMatchObject({})
    await expect(stat(join(agentRoot, 'var', 'logs'))).resolves.toMatchObject({})
    await expect(stat(result.env['ASP_PROJECT_STATE_DIR'] as string)).resolves.toMatchObject({})
  })

  test('returns durable agent env when component discovery is absent', async () => {
    const agentRoot = await createTempDir('agent-tools-profile-only-')
    const projectRoot = await createTempDir('agent-tools-profile-only-project-')
    const result = await prepareAgentToolRuntime({
      agentRoot,
      projectRoot,
    } as Parameters<typeof prepareAgentToolRuntime>[0])

    // T-04936: profile-only agent roots still need state/cache/log env even
    // when detectAgentLocalComponents() returns undefined.
    expect(result.pathPrepend).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.env).toMatchObject({
      ASP_AGENT_ROOT: agentRoot,
      ASP_AGENT_NAME: basename(agentRoot),
      ASP_AGENT_VAR_DIR: join(agentRoot, 'var'),
      ASP_AGENT_STATE_DIR: join(agentRoot, 'var', 'state'),
      ASP_AGENT_CACHE_DIR: join(agentRoot, 'var', 'cache'),
      ASP_AGENT_LOG_DIR: join(agentRoot, 'var', 'logs'),
      ASP_PROJECT_ROOT: projectRoot,
      ASP_PROJECT_STATE_DIR: join(
        agentRoot,
        'var',
        'state',
        'projects',
        getProjectStorageId(projectRoot, basename(agentRoot))
      ),
    })
    expect(result.env).not.toHaveProperty('ASP_AGENT_TOOLS_DIR')
    expect(result.env).not.toHaveProperty('ASP_AGENT_TOOLS_BIN')
    expect(result.env).not.toHaveProperty('PATH')
    await expect(stat(join(agentRoot, 'var', 'state'))).resolves.toMatchObject({})
  })

  test('prepends PATH, sets agent env, and creates state directories', async () => {
    const agentRoot = await createTempDir('agent-tools-valid-')
    await writeTool(agentRoot, 'spark-tool')

    const result = await prepareAgentToolRuntime(
      { agentRoot, components: components(agentRoot) },
      { PATH: '/usr/bin' }
    )

    expect(result.pathPrepend).toEqual([join(agentRoot, 'tools', 'bin')])
    expect(result.env['PATH']).toBe(`${join(agentRoot, 'tools', 'bin')}:/usr/bin`)
    expect(result.env).toMatchObject({
      ASP_AGENT_ROOT: agentRoot,
      ASP_AGENT_NAME: basename(agentRoot),
      ASP_AGENT_TOOLS_DIR: join(agentRoot, 'tools'),
      ASP_AGENT_TOOLS_BIN: join(agentRoot, 'tools', 'bin'),
      ASP_AGENT_VAR_DIR: join(agentRoot, 'var'),
      ASP_AGENT_STATE_DIR: join(agentRoot, 'var', 'state'),
      ASP_AGENT_CACHE_DIR: join(agentRoot, 'var', 'cache'),
      ASP_AGENT_LOG_DIR: join(agentRoot, 'var', 'logs'),
    })
    await expect(stat(join(agentRoot, 'var', 'state'))).resolves.toMatchObject({})
    await expect(stat(join(agentRoot, 'var', 'cache'))).resolves.toMatchObject({})
    await expect(stat(join(agentRoot, 'var', 'logs'))).resolves.toMatchObject({})
  })

  test('does not prepend tools bin twice when PATH already starts with it', async () => {
    const agentRoot = await createTempDir('agent-tools-idempotent-')
    await writeTool(agentRoot, 'spark-tool')
    const toolsBinDir = join(agentRoot, 'tools', 'bin')

    const result = await prepareAgentToolRuntime(
      { agentRoot, components: components(agentRoot) },
      { PATH: `${toolsBinDir}:/usr/bin` }
    )

    expect(result.pathPrepend).toEqual([])
    expect(result.env['PATH']).toBe(`${toolsBinDir}:/usr/bin`)
  })

  test('sets project env and project state directory using project storage id', async () => {
    const agentRoot = await createTempDir('agent-tools-project-')
    const projectRoot = await createTempDir('My Project-')
    await writeTool(agentRoot, 'spark-tool')

    const result = await prepareAgentToolRuntime({
      agentRoot,
      projectRoot,
      components: components(agentRoot),
    })
    const projectId = getProjectStorageId(projectRoot, basename(agentRoot))

    expect(result.env['ASP_PROJECT_ROOT']).toBe(projectRoot)
    expect(result.env['ASP_PROJECT_ID']).toBe(projectId)
    expect(result.env['ASP_PROJECT_STATE_DIR']).toBe(
      join(agentRoot, 'var', 'state', 'projects', projectId)
    )
    await expect(stat(result.env['ASP_PROJECT_STATE_DIR'] as string)).resolves.toMatchObject({})
  })

  test('prefers semantic project id over worktree basename for project state directory', async () => {
    const agentRoot = await createTempDir('agent-tools-semantic-project-')
    const projectRoot = await createTempDir('agent-spaces-T-05831-worktree-enablement-')
    await writeTool(agentRoot, 'spark-tool')

    const result = await prepareAgentToolRuntime({
      agentRoot,
      projectRoot,
      projectId: 'agent-spaces',
      components: components(agentRoot),
    })
    const projectId = `agent-spaces_${sanitizeProjectAgentScopeSegment(basename(agentRoot))}`

    expect(result.env['ASP_PROJECT_ROOT']).toBe(projectRoot)
    expect(result.env['ASP_PROJECT_ID']).toBe(projectId)
    expect(result.env['ASP_PROJECT_STATE_DIR']).toBe(
      join(agentRoot, 'var', 'state', 'projects', projectId)
    )
    await expect(stat(result.env['ASP_PROJECT_STATE_DIR'] as string)).resolves.toMatchObject({})
  })
})

describe('validateAgentTools', () => {
  test('invalid names fail', async () => {
    const agentRoot = await createTempDir('agent-tools-invalid-name-')
    await writeTool(agentRoot, 'BadTool')

    await expect(validateAgentTools(components(agentRoot))).rejects.toThrow(
      'Invalid agent tool name'
    )
  })

  test('reserved names fail', async () => {
    const agentRoot = await createTempDir('agent-tools-reserved-')
    await writeTool(agentRoot, 'git')

    await expect(validateAgentTools(components(agentRoot))).rejects.toThrow('reserved')
  })

  test('directory entries fail', async () => {
    const agentRoot = await createTempDir('agent-tools-directory-')
    await mkdir(join(agentRoot, 'tools', 'bin', 'spark-tool'), { recursive: true })

    await expect(validateAgentTools(components(agentRoot))).rejects.toThrow('regular file')
  })

  test('non-executable files fail', async () => {
    const agentRoot = await createTempDir('agent-tools-nonexec-')
    const toolPath = await writeTool(agentRoot, 'spark-tool')
    await chmod(toolPath, 0o644)

    await expect(validateAgentTools(components(agentRoot))).rejects.toThrow('must be executable')
  })

  test('safe symlinks inside tools succeed', async () => {
    const agentRoot = await createTempDir('agent-tools-symlink-')
    await mkdir(join(agentRoot, 'tools', 'bin'), { recursive: true })
    await mkdir(join(agentRoot, 'tools', 'lib'), { recursive: true })
    const target = join(agentRoot, 'tools', 'lib', 'spark-tool')
    await writeFile(target, '#!/bin/sh\necho ok\n')
    await chmod(target, 0o755)
    await symlink(target, join(agentRoot, 'tools', 'bin', 'spark-tool'))

    await expect(validateAgentTools(components(agentRoot))).resolves.toEqual([])
  })

  test('symlink escapes fail', async () => {
    const agentRoot = await createTempDir('agent-tools-symlink-escape-')
    const outsideRoot = await createTempDir('agent-tools-outside-')
    await mkdir(join(agentRoot, 'tools', 'bin'), { recursive: true })
    const target = join(outsideRoot, 'spark-tool')
    await writeFile(target, '#!/bin/sh\necho ok\n')
    await chmod(target, 0o755)
    await symlink(target, join(agentRoot, 'tools', 'bin', 'spark-tool'))

    await expect(validateAgentTools(components(agentRoot))).rejects.toThrow(
      'resolves outside <agentRoot>/tools'
    )
  })

  test('broken symlinks fail', async () => {
    const agentRoot = await createTempDir('agent-tools-broken-symlink-')
    await mkdir(join(agentRoot, 'tools', 'bin'), { recursive: true })
    await symlink(
      join(agentRoot, 'tools', 'missing'),
      join(agentRoot, 'tools', 'bin', 'spark-tool')
    )

    await expect(validateAgentTools(components(agentRoot))).rejects.toThrow('regular file')
  })

  test('executable text files without shebang warn', async () => {
    const agentRoot = await createTempDir('agent-tools-no-shebang-')
    await writeTool(agentRoot, 'spark-tool', 'echo ok\n')

    await expect(validateAgentTools(components(agentRoot))).resolves.toEqual([
      'Agent tool "spark-tool" is executable text but has no shebang',
    ])
  })

  test('binary-like executables without shebang do not warn', async () => {
    const agentRoot = await createTempDir('agent-tools-binary-')
    await writeTool(agentRoot, 'spark-tool', '\u0000ELF')

    await expect(validateAgentTools(components(agentRoot))).resolves.toEqual([])
  })
})
