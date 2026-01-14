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

import {
  DEFAULT_HARNESS,
  type HarnessId,
  LOCK_FILENAME,
  type LockFile,
  type SpaceKey,
  getLoadOrderEntries,
  lockFileExists,
  readLockJson,
  readSpaceToml,
} from 'spaces-core'

import {
  type SettingsInput,
  composeMcpFromSpaces,
  composeSettingsFromSpaces,
  materializeSpaces,
} from 'spaces-materializer'

import { DEV_COMMIT_MARKER, DEV_INTEGRITY } from 'spaces-resolver'
import { PathResolver, ensureDir, getAspHome } from 'spaces-store'

import {
  type LintContext,
  type LintWarning,
  type SpaceLintData,
  WARNING_CODES,
  lint,
} from 'spaces-lint'

import { install } from './install.js'
import { type ResolveOptions, getRegistryPath } from './resolve.js'

/**
 * Options for build operation.
 */
export interface BuildOptions extends ResolveOptions {
  /** Output directory for materialized plugins */
  outputDir: string
  /** Harness to build for (default: 'claude') */
  harness?: HarnessId | undefined
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
  /** Path to composed settings.json (if any) */
  settingsPath?: string | undefined
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

  // Get harness (default to claude)
  const harnessId = options.harness ?? DEFAULT_HARNESS

  // Ensure we have a lock file
  let lock: LockFile
  let lockWasMissing = false
  const lockPath = join(options.projectPath, LOCK_FILENAME)
  if (await lockFileExists(lockPath)) {
    lock = await readLockJson(lockPath)
  } else if (options.autoInstall !== false) {
    // Run install to generate lock
    lockWasMissing = true
    const installResult = await install({
      ...options,
      harness: harnessId,
      targets: [targetName],
    })
    lock = installResult.lock
  } else {
    throw new Error('No lock file found. Run install first or set autoInstall: true')
  }

  // Get spaces in load order for this target (from lock - now includes @dev refs)
  const entries = getLoadOrderEntries(lock, targetName)
  const registryPath = getRegistryPath(options)

  // Build materialization inputs from locked spaces
  // For @dev entries, use filesystem path; for others, use store snapshot
  const inputs = entries.map((entry) => {
    const isDev =
      entry.commit === (DEV_COMMIT_MARKER as string) || entry.integrity === DEV_INTEGRITY

    return {
      manifest: {
        schema: 1 as const,
        id: entry.id,
        plugin: entry.plugin,
      },
      // @dev entries: use filesystem path; others: use store snapshot
      snapshotPath: isDev
        ? join(registryPath, 'spaces', entry.id)
        : paths.snapshot(entry.integrity),
      spaceKey: isDev
        ? (`${entry.id}@dev` as SpaceKey)
        : (`${entry.id}@${entry.commit.slice(0, 12)}` as SpaceKey),
      integrity: entry.integrity,
    }
  })

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

  // Compose settings from all spaces
  const settingsOutputPath = join(options.outputDir, 'settings.json')
  const settingsInputs: SettingsInput[] = []

  // Read settings from each snapshot's space.toml
  for (const input of inputs) {
    try {
      const spaceTomlPath = join(input.snapshotPath, 'space.toml')
      const manifest = await readSpaceToml(spaceTomlPath)
      if (manifest.settings) {
        settingsInputs.push({
          spaceId: input.manifest.id,
          settings: manifest.settings,
        })
      }
    } catch {
      // Space.toml may not exist or may not have settings - that's fine
    }
  }

  await composeSettingsFromSpaces(settingsInputs, settingsOutputPath)
  const settingsPath = settingsOutputPath

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

  // Add W101 warning if lock file was missing and auto-generated
  if (lockWasMissing) {
    warnings.unshift({
      code: WARNING_CODES.LOCK_MISSING,
      message:
        'Lock file was missing and has been auto-generated. Run "asp install" to generate it explicitly.',
      severity: 'info',
    })
  }

  return {
    pluginDirs,
    mcpConfigPath,
    settingsPath,
    warnings,
    lock,
  }
}

/**
 * Build all targets in a project.
 */
export async function buildAll(options: BuildOptions): Promise<Map<string, BuildResult>> {
  const lockPath = join(options.projectPath, LOCK_FILENAME)
  const lock = await readLockJson(lockPath)
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
