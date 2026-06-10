import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import { TARGETS_FILENAME, parseTargetsToml } from '../core/config/index.js'
import { getAspHome } from './paths.js'

interface ConfigOptions {
  aspHome?: string
  env?: Record<string, string | undefined>
}

interface AspConfigFile {
  'agents-root'?: unknown
}

export type AgentRootSearchEntryKind = 'project' | 'canonical'

export interface AgentRootSearchEntry {
  root: string
  kind: AgentRootSearchEntryKind
  exists: boolean
  projectRoot?: string | undefined
  declaredPath?: string | undefined
}

export interface AgentRootSearchWarning {
  code: 'declared_agents_root_missing'
  message: string
  root: string
  projectRoot: string
  declaredPath: string
}

export interface AgentRootSearchPath {
  roots: string[]
  entries: AgentRootSearchEntry[]
  warnings: AgentRootSearchWarning[]
}

export function getAgentsRoot(opts?: ConfigOptions): string | undefined {
  const explicit = getConfiguredRoot('ASP_AGENTS_ROOT', 'agents-root', opts)
  if (explicit) return explicit

  const env = opts?.env
  const home = env?.['HOME'] ?? (!opts ? homedir() : undefined)
  if (!home) return undefined
  const conventionPath = join(home, 'praesidium', 'var', 'agents')
  return existsSync(conventionPath) ? conventionPath : undefined
}

export function getAgentRootsForProject(
  projectRoot?: string | undefined,
  opts?: ConfigOptions
): string[] {
  return getAgentRootSearchPathForProject(projectRoot, opts).roots
}

export function getAgentRootSearchPathForProject(
  projectRoot?: string | undefined,
  opts?: ConfigOptions
): AgentRootSearchPath {
  const entries: AgentRootSearchEntry[] = []
  const warnings: AgentRootSearchWarning[] = []
  const roots: string[] = []

  if (projectRoot) {
    const manifestPath = join(projectRoot, TARGETS_FILENAME)
    if (existsSync(manifestPath)) {
      const content = readFileSync(manifestPath, 'utf8')
      const manifest = parseTargetsToml(content, manifestPath)
      const declaredPath = manifest['agents-root']
      if (declaredPath) {
        const root = resolveProjectAgentsRoot(projectRoot, declaredPath, opts?.env ?? process.env)
        const exists = existsSync(root)
        entries.push({
          root,
          kind: 'project',
          exists,
          projectRoot,
          declaredPath,
        })
        if (exists) {
          roots.push(root)
        } else {
          warnings.push({
            code: 'declared_agents_root_missing',
            message: `Declared project agents root does not exist: ${root}`,
            root,
            projectRoot,
            declaredPath,
          })
        }
      }
    }
  }

  const canonical = getAgentsRoot(opts)
  if (canonical) {
    entries.push({
      root: canonical,
      kind: 'canonical',
      exists: existsSync(canonical),
    })
    roots.push(canonical)
  }

  return { roots: dedupeRoots(roots), entries, warnings }
}

function getConfiguredRoot(
  envKey: 'ASP_AGENTS_ROOT',
  configKey: 'agents-root',
  opts?: ConfigOptions
): string | undefined {
  const env = opts?.env ?? process.env
  const fromEnv = env[envKey]
  if (fromEnv) return expandHomePath(fromEnv, env)

  const config = readAspConfig(opts)
  const fromConfig = config?.[configKey]
  return typeof fromConfig === 'string' ? expandHomePath(fromConfig, env) : undefined
}

function readAspConfig(opts?: ConfigOptions): AspConfigFile | undefined {
  const aspHome = opts?.aspHome ?? getAspHome()
  const configPath = join(aspHome, 'config.toml')
  if (!existsSync(configPath)) return undefined

  try {
    const content = readFileSync(configPath, 'utf8')
    return parseToml(content) as AspConfigFile
  } catch {
    return undefined
  }
}

function expandHomePath(value: string, env: Record<string, string | undefined>): string {
  if (!value.startsWith('~')) return value

  const home = env['HOME'] ?? homedir()
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return value
}

function resolveProjectAgentsRoot(
  projectRoot: string,
  value: string,
  env: Record<string, string | undefined>
): string {
  const expanded = expandHomePath(value, env)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(projectRoot, expanded)
}

function dedupeRoots(roots: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const root of roots) {
    const key = resolve(root)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(root)
  }
  return result
}
