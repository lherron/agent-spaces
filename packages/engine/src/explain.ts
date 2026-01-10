/**
 * Debug/explain output for resolved targets.
 *
 * WHY: Provides human-readable and machine-readable explanations
 * of resolved targets, including load order, dependencies, and warnings.
 */

import {
  type LockFile,
  type LockSpaceEntry,
  type LockTargetEntry,
  type SpaceKey,
  lockFileExists,
  readLockJson,
} from '@agent-spaces/core'

import { type LintContext, type LintWarning, type SpaceLintData, lint } from '@agent-spaces/lint'

import { PathResolver, getAspHome, snapshotExists } from '@agent-spaces/store'

import type { ResolveOptions } from './resolve.js'

/**
 * Space information for explanation.
 */
export interface SpaceInfo {
  /** Space key */
  key: SpaceKey
  /** Space ID */
  id: string
  /** Commit SHA */
  commit: string
  /** Plugin name */
  pluginName: string
  /** Plugin version (if any) */
  pluginVersion?: string | undefined
  /** Content integrity */
  integrity: string
  /** Path in registry */
  path: string
  /** Dependencies */
  deps: SpaceKey[]
  /** How this version was resolved */
  resolvedFrom?: {
    selector?: string
    tag?: string
    semver?: string
  }
  /** Whether snapshot exists in store */
  inStore: boolean
}

/**
 * Target explanation.
 */
export interface TargetExplanation {
  /** Target name */
  name: string
  /** Original compose list */
  compose: string[]
  /** Root space keys */
  roots: SpaceKey[]
  /** Load order (dependencies first) */
  loadOrder: SpaceKey[]
  /** Environment hash */
  envHash: string
  /** Detailed space info in load order */
  spaces: SpaceInfo[]
  /** Warnings */
  warnings: LintWarning[]
}

/**
 * Full explanation output.
 */
export interface ExplainResult {
  /** Registry URL */
  registryUrl: string
  /** Lock file version */
  lockVersion: number
  /** When lock was generated */
  generatedAt: string
  /** Target explanations */
  targets: Record<string, TargetExplanation>
}

/**
 * Options for explain operation.
 */
export interface ExplainOptions extends ResolveOptions {
  /** Specific targets to explain (default: all) */
  targets?: string[] | undefined
  /** Whether to check store for snapshots (default: true) */
  checkStore?: boolean | undefined
  /** Whether to run lint checks (default: true) */
  runLint?: boolean | undefined
}

/**
 * Build space info from lock entry.
 */
async function buildSpaceInfo(
  key: SpaceKey,
  entry: LockSpaceEntry,
  options: { paths: PathResolver; cwd: string },
  checkStore: boolean
): Promise<SpaceInfo> {
  const inStore = checkStore ? await snapshotExists(entry.integrity, options) : true

  const info: SpaceInfo = {
    key,
    id: entry.id as string,
    commit: entry.commit as string,
    pluginName: entry.plugin.name,
    pluginVersion: entry.plugin.version,
    integrity: entry.integrity as string,
    path: entry.path,
    deps: entry.deps.spaces,
    inStore,
  }

  // Only set resolvedFrom if present (exactOptionalPropertyTypes)
  if (entry.resolvedFrom) {
    info.resolvedFrom = entry.resolvedFrom
  }

  return info
}

/**
 * Explain a target from lock file.
 */
async function explainTarget(
  name: string,
  target: LockTargetEntry,
  lock: LockFile,
  options: ExplainOptions
): Promise<TargetExplanation> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })
  const registryPath = options.registryPath ?? paths.repo
  const checkStore = options.checkStore !== false
  const snapshotOpts = { paths, cwd: registryPath }

  // Build space info for each space in load order
  const spaces: SpaceInfo[] = []
  for (const key of target.loadOrder) {
    const entry = lock.spaces[key]
    if (!entry) {
      throw new Error(`Space not found in lock: ${key}`)
    }
    const info = await buildSpaceInfo(key, entry, snapshotOpts, checkStore)
    spaces.push(info)
  }

  // Run lint if requested
  let warnings: LintWarning[] = []
  if (options.runLint !== false) {
    const lintData: SpaceLintData[] = spaces.map((space) => ({
      key: space.key,
      manifest: {
        schema: 1 as const,
        id: space.id as any,
        plugin: {
          name: space.pluginName,
          version: space.pluginVersion,
        },
      },
      pluginPath: paths.snapshot(space.integrity as any),
    }))

    const lintContext: LintContext = { spaces: lintData }
    warnings = await lint(lintContext)
  }

  // Include warnings from lock if present (convert LockWarning to LintWarning)
  if (target.warnings) {
    for (const lockWarning of target.warnings) {
      warnings.push({
        code: lockWarning.code,
        message: lockWarning.message,
        severity: 'warning',
      })
    }
  }

  return {
    name,
    compose: target.compose as string[],
    roots: target.roots,
    loadOrder: target.loadOrder,
    envHash: target.envHash as string,
    spaces,
    warnings,
  }
}

/**
 * Explain targets from a project.
 *
 * This provides detailed information about:
 * - Load order and dependencies
 * - Plugin identities
 * - How versions were resolved
 * - Whether snapshots are in store
 * - Any lint warnings
 */
export async function explain(options: ExplainOptions): Promise<ExplainResult> {
  // Check for lock file
  if (!(await lockFileExists(options.projectPath))) {
    throw new Error('No lock file found. Run install first.')
  }

  // Load lock file
  const lock = await readLockJson(options.projectPath)

  // Determine which targets to explain
  const targetNames = options.targets ?? Object.keys(lock.targets)

  // Build explanations
  const targets: Record<string, TargetExplanation> = {}
  for (const name of targetNames) {
    const target = lock.targets[name]
    if (!target) {
      throw new Error(`Target not found in lock: ${name}`)
    }
    targets[name] = await explainTarget(name, target, lock, options)
  }

  return {
    registryUrl: lock.registry.url,
    lockVersion: lock.lockfileVersion,
    generatedAt: lock.generatedAt,
    targets,
  }
}

/**
 * Format explanation as human-readable text.
 */
export function formatExplainText(result: ExplainResult): string {
  const lines: string[] = []

  lines.push(`Registry: ${result.registryUrl}`)
  lines.push(`Lock version: ${result.lockVersion}`)
  lines.push(`Generated: ${result.generatedAt}`)
  lines.push('')

  for (const [name, target] of Object.entries(result.targets)) {
    lines.push(`Target: ${name}`)
    lines.push(`  Compose: ${target.compose.join(', ')}`)
    lines.push(`  Env hash: ${target.envHash.slice(0, 16)}...`)
    lines.push('')
    lines.push('  Load order:')

    for (const space of target.spaces) {
      const version = space.pluginVersion ? `@${space.pluginVersion}` : ''
      const storeStatus = space.inStore ? '' : ' [NOT IN STORE]'
      lines.push(`    ${space.pluginName}${version}${storeStatus}`)
      lines.push(`      Key: ${space.key}`)
      lines.push(`      Commit: ${space.commit.slice(0, 12)}`)
      if (space.resolvedFrom?.selector) {
        lines.push(`      Selector: ${space.resolvedFrom.selector}`)
      }
      if (space.deps.length > 0) {
        lines.push(`      Deps: ${space.deps.join(', ')}`)
      }
    }

    if (target.warnings.length > 0) {
      lines.push('')
      lines.push('  Warnings:')
      for (const warning of target.warnings) {
        lines.push(`    [${warning.code}] ${warning.message}`)
      }
    }

    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Format explanation as JSON.
 */
export function formatExplainJson(result: ExplainResult): string {
  return JSON.stringify(result, null, 2)
}
