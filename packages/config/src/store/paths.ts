/**
 * Path management for Agent Spaces storage.
 *
 * WHY: All agent-spaces data lives under ASP_HOME (~/.asp by default).
 * This module provides consistent path builders for all storage locations.
 */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { Sha256Integrity } from '../core/index.js'

/**
 * Default ASP_HOME location.
 */
export const DEFAULT_ASP_HOME = join(homedir(), '.asp')

/**
 * Get the ASP_HOME directory path.
 * Uses ASP_HOME env var if set, otherwise defaults to ~/.asp
 */
export function getAspHome(): string {
  return process.env['ASP_HOME'] ?? DEFAULT_ASP_HOME
}

/**
 * Storage structure under ASP_HOME:
 *
 * ~/.asp/
 * ├── repo/              # Registry git repository
 * │   ├── .git/
 * │   ├── spaces/        # Space sources
 * │   └── registry/      # Metadata (dist-tags.json)
 * ├── snapshots/         # Content-addressed space snapshots
 * │   └── <sha256>/      # Keyed by integrity hash
 * │       ├── space.toml
 * │       ├── commands/
 * │       └── ...
 * ├── cache/             # Materialized plugin cache
 * │   └── <cacheKey>/    # Keyed by pluginCacheKey
 * │       ├── .claude-plugin/
 * │       └── ...
 * ├── codex-homes/       # Project+agent scope homes and composed bundles
 * │   └── <projectSlug>_<agentSlug>/
 * │       ├── sessions/  # Codex runtime state
 * │       └── bundles/
 * │           └── <target>/<harness>/
 * └── tmp/               # Temporary files during operations
 */

/**
 * Get the registry repo directory path.
 */
export function getRepoPath(): string {
  return join(getAspHome(), 'repo')
}

/**
 * Get the content-addressed snapshots directory path.
 */
export function getSnapshotsPath(): string {
  return join(getAspHome(), 'snapshots')
}

/**
 * @deprecated Use getSnapshotsPath instead
 */
export function getStorePath(): string {
  return getSnapshotsPath()
}

/**
 * Get the plugin cache directory path.
 */
export function getCachePath(): string {
  return join(getAspHome(), 'cache')
}

/**
 * Get the project bundle storage path.
 */
export function getProjectsPath(aspHome?: string | undefined): string {
  return join(aspHome ?? getAspHome(), 'projects')
}

/**
 * Get the temp directory path.
 */
export function getTempPath(): string {
  return join(getAspHome(), 'tmp')
}

/**
 * Get the path for a space snapshot.
 * Snapshots are keyed by their integrity hash.
 */
export function getSnapshotPath(integrity: Sha256Integrity): string {
  // Extract just the hash part (without "sha256:" prefix)
  const hash = integrity.replace('sha256:', '')
  return join(getSnapshotsPath(), hash)
}

/**
 * Get the path for a cached plugin.
 * Plugins are cached by their cache key (derived from integrity + plugin identity).
 */
export function getPluginCachePath(cacheKey: string): string {
  return join(getCachePath(), cacheKey)
}

/**
 * Get the path to the spaces directory in the registry.
 */
export function getSpacesPath(): string {
  return join(getRepoPath(), 'spaces')
}

/**
 * Get the path to a specific space in the registry.
 */
export function getSpaceSourcePath(spaceId: string): string {
  return join(getSpacesPath(), spaceId)
}

/**
 * Get the path to the registry metadata directory.
 */
export function getRegistryMetaPath(): string {
  return join(getRepoPath(), 'registry')
}

/**
 * Get the path to dist-tags.json.
 */
export function getDistTagsPath(): string {
  return join(getRegistryMetaPath(), 'dist-tags.json')
}

/**
 * Get the path to the global lock file.
 * Used for global mode runs (asp run space:id@selector).
 */
export function getGlobalLockPath(): string {
  return join(getAspHome(), 'global-lock.json')
}

export function sanitizeProjectAgentScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
  return sanitized || 'default'
}

export function getProjectAgentScopeId(projectPath: string, targetName: string): string {
  const projectSlug = sanitizeProjectAgentScopeSegment(basename(resolve(projectPath)))
  const targetSlug = sanitizeProjectAgentScopeSegment(targetName)
  return `${projectSlug}_${targetSlug}`
}

export function getProjectAgentScopePath(
  aspHome: string,
  projectPath: string,
  targetName: string
): string {
  return join(aspHome, 'codex-homes', getProjectAgentScopeId(projectPath, targetName))
}

export function getProjectStorageId(projectPath: string, targetName?: string | undefined): string {
  if (targetName !== undefined) {
    return getProjectAgentScopeId(projectPath, targetName)
  }
  return sanitizeProjectAgentScopeSegment(basename(resolve(projectPath)))
}

/**
 * Get the root path for bundles associated with a project.
 */
export function getProjectDataPath(projectPath: string, aspHome?: string | undefined): string {
  return join(aspHome ?? getAspHome(), 'codex-homes', getProjectStorageId(projectPath))
}

/**
 * Get the targets directory for a project bundle set.
 */
export function getProjectTargetsPath(projectPath: string, aspHome?: string | undefined): string {
  return join(getProjectDataPath(projectPath, aspHome), 'bundles')
}

export function getProjectHarnessBundleRootPath(
  projectPath: string,
  targetName: string,
  aspHome?: string | undefined
): string {
  return join(getProjectAgentScopePath(aspHome ?? getAspHome(), projectPath, targetName), 'bundles')
}

/**
 * Get the harness-specific composed bundle path for a project target.
 */
export function getProjectHarnessOutputPath(
  projectPath: string,
  targetName: string,
  harnessId: string,
  aspHome?: string | undefined
): string {
  return join(
    getProjectHarnessBundleRootPath(projectPath, targetName, aspHome),
    targetName,
    harnessId
  )
}

export function getLegacyProjectStorageId(projectPath: string): string {
  const normalizedProjectPath = resolve(projectPath)
  const projectSlug = sanitizeProjectAgentScopeSegment(basename(normalizedProjectPath))
  const projectHash = createHash('sha256').update(normalizedProjectPath).digest('hex').slice(0, 8)
  return `${projectSlug}-${projectHash}`
}

export function getLegacyProjectHarnessOutputPath(
  projectPath: string,
  targetName: string,
  harnessId: string,
  aspHome?: string | undefined
): string {
  return join(
    getProjectsPath(aspHome),
    getLegacyProjectStorageId(projectPath),
    'targets',
    targetName,
    harnessId
  )
}

/**
 * Check if a project target bundle exists under ASP_HOME.
 */
export async function projectHarnessOutputExists(
  projectPath: string,
  targetName: string,
  harnessId: string,
  aspHome?: string | undefined
): Promise<boolean> {
  const harnessPath = getProjectHarnessOutputPath(projectPath, targetName, harnessId, aspHome)
  try {
    const { stat } = await import('node:fs/promises')
    const stats = await stat(harnessPath)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Ensure a directory exists, creating it if necessary.
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/**
 * Ensure all ASP_HOME directories exist.
 */
export async function ensureAspHome(): Promise<void> {
  await Promise.all([
    ensureDir(getRepoPath()),
    ensureDir(getSnapshotsPath()),
    ensureDir(getCachePath()),
    ensureDir(getProjectsPath()),
    ensureDir(getTempPath()),
  ])
}

/**
 * Options for path resolution.
 */
export interface PathOptions {
  /** Override ASP_HOME for testing */
  aspHome?: string | undefined
}

/**
 * Path resolver with custom ASP_HOME.
 */
export class PathResolver {
  readonly aspHome: string

  constructor(options: PathOptions = {}) {
    this.aspHome = options.aspHome ?? getAspHome()
  }

  get repo(): string {
    return join(this.aspHome, 'repo')
  }

  get snapshots(): string {
    return join(this.aspHome, 'snapshots')
  }

  /** @deprecated Use snapshots instead */
  get store(): string {
    return this.snapshots
  }

  get cache(): string {
    return join(this.aspHome, 'cache')
  }

  get projects(): string {
    return join(this.aspHome, 'projects')
  }

  get temp(): string {
    return join(this.aspHome, 'tmp')
  }

  get globalLock(): string {
    return join(this.aspHome, 'global-lock.json')
  }

  projectData(projectPath: string): string {
    return getProjectDataPath(projectPath, this.aspHome)
  }

  projectTargets(projectPath: string): string {
    return getProjectTargetsPath(projectPath, this.aspHome)
  }

  projectHarnessBundleRoot(projectPath: string, targetName: string): string {
    return getProjectHarnessBundleRootPath(projectPath, targetName, this.aspHome)
  }

  projectHarnessOutput(projectPath: string, targetName: string, harnessId: string): string {
    return getProjectHarnessOutputPath(projectPath, targetName, harnessId, this.aspHome)
  }

  snapshot(integrity: Sha256Integrity): string {
    const hash = integrity.replace('sha256:', '')
    return join(this.snapshots, hash)
  }

  pluginCache(cacheKey: string): string {
    return join(this.cache, cacheKey)
  }

  spaceSource(spaceId: string): string {
    return join(this.repo, 'spaces', spaceId)
  }

  async ensureAll(): Promise<void> {
    await Promise.all([
      ensureDir(this.repo),
      ensureDir(this.snapshots),
      ensureDir(this.cache),
      ensureDir(this.projects),
      ensureDir(this.temp),
    ])
  }
}
