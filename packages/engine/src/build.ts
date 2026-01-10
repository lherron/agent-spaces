/**
 * Materialization orchestration (build command).
 *
 * WHY: Orchestrates the materialization process:
 * - Resolve target to get spaces in load order
 * - Materialize each space to plugin directory
 * - Compose MCP configuration
 * - Validate results
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { type LockFile, type SpaceKey, lockFileExists, readLockJson } from '@agent-spaces/core'

import { getLoadOrderEntries } from '@agent-spaces/core'

import { composeMcpFromSpaces, materializeSpaces } from '@agent-spaces/materializer'

import { PathResolver, ensureDir, getAspHome } from '@agent-spaces/store'

import { type LintContext, type LintWarning, type SpaceLintData, lint } from '@agent-spaces/lint'

import { install } from './install.js'
import type { ResolveOptions } from './resolve.js'

/**
 * Options for build operation.
 */
export interface BuildOptions extends ResolveOptions {
  /** Output directory for materialized plugins */
  outputDir: string
  /** Whether to clean output dir first (default: true) */
  clean?: boolean | undefined
  /** Whether to run install if needed (default: true) */
  autoInstall?: boolean | undefined
  /** Whether to run lint checks (default: true) */
  runLint?: boolean | undefined
}

/**
 * Result of build operation.
 */
export interface BuildResult {
  /** Paths to materialized plugin directories */
  pluginDirs: string[]
  /** Path to composed MCP config (if any) */
  mcpConfigPath?: string | undefined
  /** Lint warnings */
  warnings: LintWarning[]
  /** The lock file used */
  lock: LockFile
}

/**
 * Build (materialize) a target.
 *
 * This:
 * 1. Resolves the target (using lock if available)
 * 2. Ensures all spaces are in the store
 * 3. Materializes each space to plugin directory
 * 4. Composes MCP configuration
 * 5. Runs lint checks
 */
export async function build(targetName: string, options: BuildOptions): Promise<BuildResult> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })

  // Clean output directory if requested
  if (options.clean !== false) {
    try {
      await rm(options.outputDir, { recursive: true, force: true })
    } catch {
      // Directory may not exist
    }
  }
  await ensureDir(options.outputDir)

  // Ensure we have a lock file
  let lock: LockFile
  if (await lockFileExists(options.projectPath)) {
    lock = await readLockJson(options.projectPath)
  } else if (options.autoInstall !== false) {
    // Run install to generate lock
    const installResult = await install({
      ...options,
      targets: [targetName],
    })
    lock = installResult.lock
  } else {
    throw new Error('No lock file found. Run install first or set autoInstall: true')
  }

  // Get spaces in load order for this target
  const entries = getLoadOrderEntries(lock, targetName)

  // Build materialization inputs
  const inputs = entries.map((entry) => ({
    manifest: {
      schema: 1 as const,
      id: entry.id,
      plugin: entry.plugin,
    },
    snapshotPath: paths.snapshot(entry.integrity),
    spaceKey: `${entry.id}@${entry.commit.slice(0, 12)}` as SpaceKey,
    integrity: entry.integrity,
  }))

  // Materialize all spaces
  const materializeResults = await materializeSpaces(inputs, { paths })

  // Get plugin directories
  const pluginDirs = materializeResults.map((r) => r.pluginPath)

  // Compose MCP configuration if any spaces have MCP
  let mcpConfigPath: string | undefined
  const mcpOutputPath = join(options.outputDir, 'mcp.json')
  const spacesDirs = materializeResults.map((r) => ({
    spaceId: r.spaceKey.split('@')[0] ?? r.spaceKey,
    dir: r.pluginPath,
  }))
  const mcpResult = await composeMcpFromSpaces(spacesDirs, mcpOutputPath)
  if (Object.keys(mcpResult.config.mcpServers).length > 0) {
    mcpConfigPath = mcpOutputPath
  }

  // Run lint checks
  let warnings: LintWarning[] = []
  if (options.runLint !== false) {
    const lintData: SpaceLintData[] = entries.map((entry, i) => ({
      key: `${entry.id}@${entry.commit.slice(0, 12)}` as SpaceKey,
      manifest: {
        schema: 1 as const,
        id: entry.id,
        plugin: entry.plugin,
      },
      pluginPath: pluginDirs[i] ?? '',
    }))

    const lintContext: LintContext = { spaces: lintData }
    warnings = await lint(lintContext)
  }

  return {
    pluginDirs,
    mcpConfigPath,
    warnings,
    lock,
  }
}

/**
 * Build all targets in a project.
 */
export async function buildAll(options: BuildOptions): Promise<Map<string, BuildResult>> {
  const lock = await readLockJson(options.projectPath)
  const results = new Map<string, BuildResult>()

  for (const targetName of Object.keys(lock.targets)) {
    const targetOutputDir = join(options.outputDir, targetName)
    const result = await build(targetName, {
      ...options,
      outputDir: targetOutputDir,
    })
    results.set(targetName, result)
  }

  return results
}
