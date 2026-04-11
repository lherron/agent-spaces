import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import { getAspHome } from './paths.js'

interface ConfigOptions {
  aspHome?: string
  env?: Record<string, string | undefined>
}

interface AspConfigFile {
  'agents-root'?: unknown
  'projects-root'?: unknown
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

export function getProjectsRoot(opts?: ConfigOptions): string | undefined {
  return getConfiguredRoot('ASP_PROJECTS_ROOT', 'projects-root', opts)
}

function getConfiguredRoot(
  envKey: 'ASP_AGENTS_ROOT' | 'ASP_PROJECTS_ROOT',
  configKey: 'agents-root' | 'projects-root',
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
