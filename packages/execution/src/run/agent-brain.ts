import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { AgentLocalComponents } from 'spaces-config'

export type GbrainCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type GbrainCommandRunner = (
  argv: string[],
  env: Record<string, string>
) => Promise<GbrainCommandResult>

export interface AgentBrainRuntimeContext {
  agentRoot: string
  agentName?: string | undefined
  components?: AgentLocalComponents | undefined
}

export type AgentBrainEnvResult = {
  GBRAIN_HOME: string
  BRAIN_REPO: string
}

export async function prepareAgentBrainRuntime(
  context: AgentBrainRuntimeContext,
  baseEnv: Record<string, string> = {},
  runner: GbrainCommandRunner = defaultGbrainCommandRunner
): Promise<AgentBrainEnvResult> {
  const agentName =
    context.agentName ?? context.components?.agentName ?? basename(context.agentRoot)
  const gbrainHome = baseEnv['GBRAIN_HOME'] ?? deriveGbrainHome(context.agentRoot, agentName)
  const brainRepo = baseEnv['BRAIN_REPO'] ?? join(context.agentRoot, 'brain')
  const env: AgentBrainEnvResult = {
    GBRAIN_HOME: gbrainHome,
    BRAIN_REPO: brainRepo,
  }

  await ensureDirectory(brainRepo, 'BRAIN_REPO')
  await ensureDirectory(gbrainHome, 'GBRAIN_HOME')

  if (!(await isInitialized(gbrainHome))) {
    await runGbrainCommand(['init', '--pglite'], env, runner)
  }

  const sources = await runGbrainCommand(['sources', 'list'], env, runner)
  const existingPath = findSourcePath(sources.stdout, agentName)
  if (existingPath !== undefined && existingPath !== brainRepo) {
    await runGbrainCommand(['sources', 'remove', agentName], env, runner)
  }
  if (existingPath !== brainRepo) {
    await runGbrainCommand(['sources', 'add', agentName, '--path', brainRepo], env, runner)
  }

  return env
}

function deriveGbrainHome(agentRoot: string, agentName: string): string {
  const agentsDir = dirname(agentRoot)
  const varDir = dirname(agentsDir)
  const praesidiumRoot = dirname(varDir)

  if (basename(agentsDir) === 'agents' && basename(varDir) === 'var') {
    return join(praesidiumRoot, 'var', 'state', 'gbrain', agentName)
  }

  return join(agentRoot, 'var', 'state', 'gbrain')
}

async function ensureDirectory(path: string, label: string): Promise<void> {
  try {
    const stats = await stat(path)
    if (!stats.isDirectory()) {
      throw new Error(`${label} must be a directory: ${path}`)
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      await mkdir(path, { recursive: true })
      return
    }
    throw error
  }
}

async function isInitialized(gbrainHome: string): Promise<boolean> {
  const configExists = await pathExists(join(gbrainHome, '.gbrain', 'config.json'))
  const pgliteExists = await pathExists(join(gbrainHome, '.gbrain', 'brain.pglite'))
  return configExists && pgliteExists
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function runGbrainCommand(
  argv: string[],
  env: AgentBrainEnvResult,
  runner: GbrainCommandRunner
): Promise<GbrainCommandResult> {
  let result: GbrainCommandResult
  try {
    result = await runner(argv, env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to run gbrain ${argv.join(' ')}: ${message}`)
  }

  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || `exit code ${result.exitCode}`
    throw new Error(`gbrain ${argv.join(' ')} failed: ${detail}`)
  }

  return result
}

function findSourcePath(stdout: string, sourceName: string): string | undefined {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return undefined
  }

  const jsonPath = findSourcePathFromJson(trimmed, sourceName)
  if (jsonPath !== undefined) {
    return jsonPath
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (columns[0] === sourceName && columns.length > 1) {
      return columns.slice(1).join(' ')
    }
  }

  return undefined
}

function findSourcePathFromJson(stdout: string, sourceName: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }

  return findSourcePathInJsonValue(parsed, sourceName)
}

function findSourcePathInJsonValue(value: unknown, sourceName: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSourcePathInJsonValue(item, sourceName)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }

  if (!isRecord(value)) {
    return undefined
  }

  const direct = value[sourceName]
  if (typeof direct === 'string') {
    return direct
  }
  if (isRecord(direct) && typeof direct['path'] === 'string') {
    return direct['path']
  }

  if (typeof value['name'] === 'string' && value['name'] === sourceName) {
    if (typeof value['path'] === 'string') {
      return value['path']
    }
    if (typeof value['repo'] === 'string') {
      return value['repo']
    }
  }

  const sources = value['sources']
  if (sources !== undefined) {
    return findSourcePathInJsonValue(sources, sourceName)
  }

  return undefined
}

function defaultGbrainCommandRunner(
  argv: string[],
  env: Record<string, string>
): Promise<GbrainCommandResult> {
  const binary = process.env['GBRAIN_BIN'] ?? 'gbrain'

  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, {
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
