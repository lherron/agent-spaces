/**
 * Integration tests for Codex harness install/build/run flows.
 *
 * WHY: Ensures codex harness CLI paths produce codex.home materialization
 * and that run/build commands accept the codex harness flag.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { exec } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'

import {
  cleanupTempAspHome,
  cleanupTempProject,
  createTempAspHome,
  createTempProject,
  getCodexTestEnv,
} from './setup.js'

const execAsync = promisify(exec)

/** Path to CLI entry point */
const CLI_PATH = path.join(import.meta.dir, '..', '..', 'packages', 'cli', 'bin', 'asp.js')

/**
 * Run CLI command and capture output.
 */
async function runCli(
  args: string[],
  options: {
    env?: Record<string, string>
    cwd?: string
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const command = `bun ${CLI_PATH} ${args.join(' ')}`
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
    })
    return { stdout, stderr, exitCode: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? 1,
    }
  }
}

async function writeCodexSpace(projectDir: string): Promise<void> {
  const spaceDir = path.join(projectDir, 'spaces', 'codex-space')
  await fs.mkdir(spaceDir, { recursive: true })
  await fs.writeFile(
    path.join(spaceDir, 'space.toml'),
    [
      'schema = 1',
      'id = "codex-space"',
      'version = "1.0.0"',
      'description = "Codex harness test space"',
      '',
      '[plugin]',
      'name = "codex-space"',
      '',
      '[harness]',
      'supports = ["codex"]',
      '',
    ].join('\n')
  )

  await fs.writeFile(
    path.join(spaceDir, 'AGENTS.md'),
    ['# Codex Instructions', '', 'Codex instructions for testing.'].join('\n')
  )

  const commandsDir = path.join(spaceDir, 'commands')
  await fs.mkdir(commandsDir, { recursive: true })
  await fs.writeFile(
    path.join(commandsDir, 'hello.md'),
    ['# /hello', '', 'Say hello from Codex.'].join('\n')
  )

  const skillsDir = path.join(spaceDir, 'skills', 'codex-skill')
  await fs.mkdir(skillsDir, { recursive: true })
  await fs.writeFile(
    path.join(skillsDir, 'SKILL.md'),
    [
      '---',
      'name: codex-skill',
      'description: Skill fixture for codex harness tests',
      '---',
      '',
      '# Codex Skill',
      '',
      'Use this skill to validate codex skill materialization.',
    ].join('\n')
  )

  const mcpDir = path.join(spaceDir, 'mcp')
  await fs.mkdir(mcpDir, { recursive: true })
  await fs.writeFile(
    path.join(mcpDir, 'mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          echo: {
            command: 'echo',
            args: ['codex'],
          },
        },
      },
      null,
      2
    )
  )
}

describe('asp codex harness', () => {
  let aspHome: string
  let projectDir: string

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      'codex-target': {
        priming_prompt: 'Register with agentchat and send READY',
        compose: ['space:project:codex-space'],
      },
    })
    await writeCodexSpace(projectDir)
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('install --harness codex materializes codex.home', async () => {
    const testEnv = getCodexTestEnv(aspHome)
    const { stdout, exitCode } = await runCli(
      ['install', '--harness', 'codex', '--asp-home', aspHome],
      { env: testEnv, cwd: projectDir }
    )

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Installed')

    const codexHome = path.join(projectDir, 'asp_modules', 'codex-target', 'codex', 'codex.home')
    const agentsPath = path.join(codexHome, 'AGENTS.md')
    const configPath = path.join(codexHome, 'config.toml')
    const promptsDir = path.join(codexHome, 'prompts')
    const skillsDir = path.join(codexHome, 'skills', 'codex-skill')

    const agents = await fs.readFile(agentsPath, 'utf-8')
    expect(agents).toContain('<!-- BEGIN space: codex-space@1.0.0 -->')
    expect(agents).toContain('Codex instructions for testing.')

    const config = await fs.readFile(configPath, 'utf-8')
    expect(config).toContain('sandbox_mode = "workspace-write"')
    expect(config).toContain('approval_policy = "on-request"')
    expect(config).toContain('project_doc_fallback_filenames')
    expect(config).toContain('AGENTS.md')
    expect(config).toContain('AGENT.md')
    expect(config).toContain('mcp_servers')

    const promptExists = await fs
      .access(path.join(promptsDir, 'hello.md'))
      .then(() => true)
      .catch(() => false)
    expect(promptExists).toBe(true)

    const skillExists = await fs
      .access(path.join(skillsDir, 'SKILL.md'))
      .then(() => true)
      .catch(() => false)
    expect(skillExists).toBe(true)
  })

  test('run --harness codex --dry-run includes CODEX_HOME', async () => {
    const testEnv = getCodexTestEnv(aspHome)
    const { stdout, exitCode } = await runCli(
      ['run', 'codex-target', '--harness', 'codex', '--dry-run', '--model', 'gpt-5.2-codex'],
      { env: testEnv, cwd: projectDir }
    )

    expect(exitCode).toBe(0)
    expect(stdout).toContain('CODEX_HOME=')
    expect(stdout).toContain('codex')
    expect(stdout).toContain('--model gpt-5.2-codex')
  })

  test('run --harness codex with prompt stays interactive by default', async () => {
    const testEnv = getCodexTestEnv(aspHome)
    const { stdout, exitCode } = await runCli(
      ['run', 'codex-target', 'investigate', '--harness', 'codex', '--dry-run'],
      { env: testEnv, cwd: projectDir }
    )

    expect(exitCode).toBe(0)
    const command = stdout.split('Command:')[1]?.trim() ?? ''
    expect(command).toContain('investigate')
    expect(command).not.toContain(' exec ')
  })

  test('run --harness codex --no-interactive forces exec mode', async () => {
    const testEnv = getCodexTestEnv(aspHome)
    const { stdout, exitCode } = await runCli(
      ['run', 'codex-target', 'investigate', '--harness', 'codex', '--dry-run', '--no-interactive'],
      { env: testEnv, cwd: projectDir }
    )

    expect(exitCode).toBe(0)
    const command = stdout.split('Command:')[1]?.trim() ?? ''
    expect(command).toContain(' exec ')
    expect(command).toContain('investigate')
  })

  test('run --harness codex concatenates priming_prompt and user prompt', async () => {
    const testEnv = getCodexTestEnv(aspHome)
    const { stdout, exitCode } = await runCli(
      ['run', 'codex-target', 'plan-next-steps', '--harness', 'codex', '--dry-run'],
      { env: testEnv, cwd: projectDir }
    )

    expect(exitCode).toBe(0)
    const command = stdout.split('Command:')[1]?.trim() ?? ''
    expect(command).toContain('Register with agentchat and send READY\n\nplan-next-steps')
  })

  test('run local space --harness codex --dry-run includes CODEX_HOME', async () => {
    const testEnv = getCodexTestEnv(aspHome)
    const spacePath = path.join(projectDir, 'spaces', 'codex-space')
    const { stdout, exitCode } = await runCli(
      ['run', spacePath, '--harness', 'codex', '--dry-run'],
      { env: testEnv, cwd: projectDir }
    )

    expect(exitCode).toBe(0)
    expect(stdout).toContain('CODEX_HOME=')
    expect(stdout).toContain('codex')
  })

  test('build --harness codex completes', async () => {
    const outputDir = await fs.mkdtemp('/tmp/asp-codex-build-')
    const testEnv = getCodexTestEnv(aspHome)

    const { stdout, exitCode } = await runCli(
      ['build', 'codex-target', '--harness', 'codex', '--output', outputDir, '--asp-home', aspHome],
      { env: testEnv, cwd: projectDir }
    )

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Build complete')

    await fs.rm(outputDir, { recursive: true, force: true })
  })
})
