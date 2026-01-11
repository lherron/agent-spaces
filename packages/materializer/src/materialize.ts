/**
 * Plugin materialization orchestration.
 *
 * WHY: This is the main entry point that coordinates all materialization
 * steps to produce a complete plugin directory from a space snapshot.
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sha256Integrity, SpaceKey, SpaceManifest } from '@agent-spaces/core'
import { MaterializationError } from '@agent-spaces/core'
import {
  type CacheMetadata,
  type PathResolver,
  cacheExists,
  computePluginCacheKey,
  writeCacheMetadata,
} from '@agent-spaces/store'
import { ensureHooksExecutable, validateHooks } from './hooks-builder.js'
import { linkComponents } from './link-components.js'
import { composeMcpFromSpaces } from './mcp-composer.js'
import { writePluginJson } from './plugin-json.js'

/**
 * Materialization input for a single space.
 */
export interface MaterializeInput {
  /** Space key (id@commit) */
  spaceKey: SpaceKey
  /** Space manifest */
  manifest: SpaceManifest
  /** Integrity hash of the snapshot */
  integrity: Sha256Integrity
  /** Path to the snapshot in store */
  snapshotPath: string
}

/**
 * Materialization result for a single plugin.
 */
export interface MaterializeResult {
  /** Space key */
  spaceKey: SpaceKey
  /** Path to the materialized plugin */
  pluginPath: string
  /** Cache key used */
  cacheKey: string
  /** Whether this was a cache hit */
  cached: boolean
  /** Warnings generated during materialization */
  warnings: string[]
}

/**
 * Options for materialization.
 */
export interface MaterializeOptions {
  /** Path resolver */
  paths: PathResolver
  /** Force re-materialization even if cached */
  force?: boolean | undefined
}

/**
 * Materialize a single space into a plugin directory.
 */
export async function materializeSpace(
  input: MaterializeInput,
  options: MaterializeOptions
): Promise<MaterializeResult> {
  const warnings: string[] = []

  // Compute cache key
  const pluginName = input.manifest.plugin?.name ?? input.manifest.id
  const pluginVersion = input.manifest.plugin?.version ?? input.manifest.version ?? '0.0.0'
  const cacheKey = computePluginCacheKey(input.integrity, pluginName, pluginVersion)
  const pluginPath = options.paths.pluginCache(cacheKey)

  // Skip cache for @dev refs (integrity = sha256:dev) since content can change
  const isDev = input.integrity === 'sha256:dev'

  // Check cache (skip for @dev refs)
  if (!isDev && !options.force && (await cacheExists(cacheKey, { paths: options.paths }))) {
    return {
      spaceKey: input.spaceKey,
      pluginPath,
      cacheKey,
      cached: true,
      warnings: [],
    }
  }

  // Materialize fresh
  try {
    // Clean any partial previous attempt
    await rm(pluginPath, { recursive: true, force: true })
    await mkdir(pluginPath, { recursive: true })

    // Write plugin.json
    await writePluginJson(input.manifest, pluginPath)

    // Link components from snapshot
    const _linked = await linkComponents(input.snapshotPath, pluginPath)

    // Validate and fix hooks
    const hookResult = await validateHooks(pluginPath)
    warnings.push(...hookResult.warnings)
    if (!hookResult.valid) {
      warnings.push(...hookResult.errors)
    }
    await ensureHooksExecutable(pluginPath)

    // Write cache metadata
    const metadata: CacheMetadata = {
      pluginName,
      pluginVersion,
      integrity: input.integrity,
      cacheKey,
      createdAt: new Date().toISOString(),
      spaceKey: input.spaceKey,
    }
    await writeCacheMetadata(cacheKey, metadata, { paths: options.paths })

    return {
      spaceKey: input.spaceKey,
      pluginPath,
      cacheKey,
      cached: false,
      warnings,
    }
  } catch (err) {
    // Clean up on failure
    await rm(pluginPath, { recursive: true, force: true }).catch(() => {})
    throw new MaterializationError(
      err instanceof Error ? err.message : String(err),
      input.manifest.id
    )
  }
}

/**
 * Materialize multiple spaces into plugin directories.
 */
export async function materializeSpaces(
  inputs: MaterializeInput[],
  options: MaterializeOptions
): Promise<MaterializeResult[]> {
  const results: MaterializeResult[] = []

  for (const input of inputs) {
    const result = await materializeSpace(input, options)
    results.push(result)
  }

  return results
}

/**
 * Full materialization result including MCP config.
 */
export interface FullMaterializationResult {
  /** Individual plugin results */
  plugins: MaterializeResult[]
  /** Composed MCP config path (if any) */
  mcpConfigPath?: string | undefined
  /** All warnings */
  warnings: string[]
}

/**
 * Materialize spaces and compose MCP config.
 */
export async function materializeWithMcp(
  inputs: MaterializeInput[],
  options: MaterializeOptions & {
    /** Output directory for composed MCP config */
    mcpOutputDir?: string | undefined
  }
): Promise<FullMaterializationResult> {
  // Materialize all spaces
  const plugins = await materializeSpaces(inputs, options)

  // Collect all warnings
  const warnings = plugins.flatMap((p) => p.warnings)

  // Compose MCP configs if output dir provided
  let mcpConfigPath: string | undefined
  if (options.mcpOutputDir !== undefined) {
    const spacesDirs = plugins.map((p) => ({
      spaceId: p.spaceKey.split('@')[0] ?? p.spaceKey,
      dir: p.pluginPath,
    }))

    const mcpOutput = join(options.mcpOutputDir, 'mcp.json')
    const { config, warnings: mcpWarnings } = await composeMcpFromSpaces(spacesDirs, mcpOutput)

    warnings.push(...mcpWarnings)
    if (Object.keys(config.mcpServers).length > 0) {
      mcpConfigPath = mcpOutput
    }
  }

  return {
    plugins,
    mcpConfigPath,
    warnings,
  }
}

/**
 * Get plugin paths in load order for Claude invocation.
 */
export function getPluginPaths(results: MaterializeResult[]): string[] {
  return results.map((r) => r.pluginPath)
}
