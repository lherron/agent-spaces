import { lstat, mkdir, open, readdir, realpath, stat } from 'node:fs/promises'
import { delimiter, join, sep } from 'node:path'

import { type AgentLocalComponents, getProjectStorageId } from 'spaces-config'

export interface AgentToolRuntimeContext {
  agentRoot: string
  projectRoot?: string | undefined
  components: AgentLocalComponents
}

export interface AgentToolEnvResult {
  /** Env vars to merge over the current launch env. Includes PATH when tools are enabled. */
  env: Record<string, string>
  /** Paths prepended to PATH. For v1 this is either [] or [toolsBinDir]. */
  pathPrepend: string[]
  /** Non-blocking warnings, e.g. executable text file without shebang. */
  warnings: string[]
}

/** Any-execute permission bits (owner/group/other) used to check a tool is runnable. */
const EXECUTABLE_MODE_BITS = 0o111
/** Bytes read from the head of a tool file when sniffing for a shebang. */
const SHEBANG_SNIFF_BYTES = 4096
/** ASCII codes for the shebang prefix `#!`. */
const SHEBANG_HASH = 0x23 // '#'
const SHEBANG_BANG = 0x21 // '!'

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9._-]*$/
const RESERVED_TOOL_NAMES = new Set([
  'sh',
  'bash',
  'zsh',
  'env',
  'sudo',
  'su',
  'node',
  'npm',
  'npx',
  'bun',
  'bunx',
  'python',
  'python3',
  'pip',
  'pip3',
  'ruby',
  'perl',
  'go',
  'cargo',
  'claude',
  'codex',
  'pi',
  'hrc',
  'hrcchat',
  'acp',
  'asp',
  'wrkq',
  'stackctl',
  'agentchat',
  'git',
  'gh',
  'curl',
  'wget',
  'jq',
  'sed',
  'awk',
  'grep',
  'find',
  'xargs',
  'make',
  'just',
])

export async function prepareAgentToolRuntime(
  context: AgentToolRuntimeContext,
  baseEnv: Record<string, string> = {}
): Promise<AgentToolEnvResult> {
  const { components, projectRoot } = context
  if (!components.hasTools) {
    return { env: {}, pathPrepend: [], warnings: [] }
  }

  const warnings = await validateAgentTools(components)
  const stateDir = join(components.agentVarDir, 'state')
  const cacheDir = join(components.agentVarDir, 'cache')
  const logDir = join(components.agentVarDir, 'logs')

  await mkdir(stateDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  await mkdir(logDir, { recursive: true })

  const env: Record<string, string> = {
    ASP_AGENT_ROOT: components.agentRoot,
    ASP_AGENT_NAME: components.agentName,
    ASP_AGENT_TOOLS_DIR: components.toolsDir,
    ASP_AGENT_TOOLS_BIN: components.toolsBinDir,
    ASP_AGENT_VAR_DIR: components.agentVarDir,
    ASP_AGENT_STATE_DIR: stateDir,
    ASP_AGENT_CACHE_DIR: cacheDir,
    ASP_AGENT_LOG_DIR: logDir,
  }

  if (projectRoot) {
    const projectId = getProjectStorageId(projectRoot)
    const projectStateDir = join(stateDir, 'projects', projectId)
    await mkdir(projectStateDir, { recursive: true })
    env['ASP_PROJECT_ROOT'] = projectRoot
    env['ASP_PROJECT_ID'] = projectId
    env['ASP_PROJECT_STATE_DIR'] = projectStateDir
  }

  const currentPath = baseEnv['PATH'] ?? process.env['PATH'] ?? ''
  const pathEntries = currentPath ? currentPath.split(delimiter) : []
  const shouldPrependToolsBin = pathEntries[0] !== components.toolsBinDir
  env['PATH'] = shouldPrependToolsBin
    ? currentPath
      ? `${components.toolsBinDir}${delimiter}${currentPath}`
      : components.toolsBinDir
    : currentPath

  return {
    env,
    pathPrepend: shouldPrependToolsBin ? [components.toolsBinDir] : [],
    warnings,
  }
}

export async function validateAgentTools(components: AgentLocalComponents): Promise<string[]> {
  if (!components.hasTools) {
    return []
  }

  const warnings: string[] = []
  const toolsRootReal = await realpath(components.toolsDir)
  const entries = await readdir(components.toolsBinDir, { withFileTypes: true })

  for (const entry of entries) {
    const name = entry.name
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid agent tool name "${name}": expected /^[a-z][a-z0-9._-]*$/`)
    }
    if (RESERVED_TOOL_NAMES.has(name)) {
      throw new Error(`Agent tool "${name}" is reserved and cannot be used`)
    }

    const entryPath = join(components.toolsBinDir, name)
    const entryLstat = await lstat(entryPath)
    let resolvedPath = entryPath
    if (entryLstat.isSymbolicLink()) {
      try {
        resolvedPath = await realpath(entryPath)
      } catch {
        throw new Error(`Agent tool "${name}" must be a regular file or safe symlink`)
      }
      if (!isUnderToolsRoot(resolvedPath, toolsRootReal)) {
        throw new Error(
          `Agent tool "${name}" symlink resolves outside <agentRoot>/tools: ${resolvedPath}`
        )
      }
    } else if (!entryLstat.isFile()) {
      throw new Error(`Agent tool "${name}" must be a regular file or safe symlink`)
    }

    const resolvedStats = await stat(resolvedPath)
    if (!resolvedStats.isFile()) {
      throw new Error(`Agent tool "${name}" must be a regular file or safe symlink`)
    }
    if ((resolvedStats.mode & EXECUTABLE_MODE_BITS) === 0) {
      throw new Error(`Agent tool "${name}" must be executable`)
    }

    if (await isExecutableTextWithoutShebang(resolvedPath)) {
      warnings.push(`Agent tool "${name}" is executable text but has no shebang`)
    }
  }

  return warnings
}

function isUnderToolsRoot(resolvedPath: string, toolsRootReal: string): boolean {
  return resolvedPath === toolsRootReal || resolvedPath.startsWith(`${toolsRootReal}${sep}`)
}

async function isExecutableTextWithoutShebang(filePath: string): Promise<boolean> {
  const file = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(SHEBANG_SNIFF_BYTES)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead === 0) {
      return false
    }
    const prefix = buffer.subarray(0, bytesRead)
    if (prefix.includes(0)) {
      return false
    }
    return !(prefix[0] === SHEBANG_HASH && prefix[1] === SHEBANG_BANG)
  } finally {
    await file.close()
  }
}
