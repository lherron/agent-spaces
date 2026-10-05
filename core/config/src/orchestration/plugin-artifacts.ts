/**
 * Plugin artifacts for a target bundle: each locked space materialized through
 * the harness adapter (mutable dev/project/agent spaces into per-run staging,
 * immutable registry spaces into the content-addressed plugin cache behind the
 * compose-time hygiene gate), plus the synthetic agent-local-components plugin.
 */

import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { resolveNowIso } from '../core/compile-clock.js'
// Internal legacy seam (EN-15986): the install path addresses adapters by
// their pre-cutover ids. T-08702 deletes it with the v1 flow.
import type { HarnessId } from '../core/types/harness.js'

import {
  type AgentLocalComponents,
  type HarnessAdapter,
  type HygieneGateFinding,
  type LockSpaceEntry,
  MaterializationHygieneError,
  type MaterializeSpaceInput,
  type ResolvedSpaceArtifact,
  type ResolvedSpaceManifest,
  type Sha256Integrity,
  type SpaceKey,
  type SpaceSettings,
  readSpaceToml,
  withLock,
} from '../core/index.js'

import { evaluateHygieneGate, forceComposeEnabled } from '../materializer/hygiene-gate.js'
import { linkDirectory } from '../materializer/link-components.js'
import { classifySpaceEntry, resolveSpaceContentDir, spaceKeyForEntry } from '../resolver/index.js'

import {
  type CacheRequiredEntry,
  type PathResolver,
  cacheExists,
  computeHarnessPluginCacheKey,
  sanitizeProjectAgentScopeSegment,
  writeCacheMetadataAt,
} from '../store/index.js'

import type { InstallOptions } from './install.js'
import { materializationLockPath, uniqueStagingDir } from './materialization-staging.js'

/** Default plugin version used when a space declares none. */
const DEFAULT_PLUGIN_VERSION = '0.0.0'
const PLUGIN_MATERIALIZER_VERSION = 'plugin-materializer-v3-complete'

/**
 * Per-target context shared by the space-materialization helpers.
 */
export interface MaterializeTargetContext {
  paths: PathResolver
  registryPath: string
  harnessId: HarnessId
  adapter: HarnessAdapter
  options: InstallOptions
}

async function buildCacheRequiredEntries(
  artifactPath: string,
  paths: string[]
): Promise<CacheRequiredEntry[]> {
  const entries: CacheRequiredEntry[] = []
  for (const path of Array.from(new Set(paths)).sort()) {
    const stats = await lstat(join(artifactPath, path))
    if (stats.isDirectory()) {
      entries.push({ path, kind: 'directory' })
    } else if (stats.isSymbolicLink()) {
      entries.push({ path, kind: 'symlink' })
    } else if (stats.isFile()) {
      entries.push({ path, kind: 'file' })
    }
  }
  return entries
}

/**
 * Materialize a single locked space entry into a plugin artifact.
 *
 * Returns the resolved artifact plus the settings to feed composition, or null
 * when the space does not support the selected harness (and is skipped).
 */
export async function materializeSpaceEntry(
  entry: LockSpaceEntry,
  ctx: MaterializeTargetContext
): Promise<{
  artifact: ResolvedSpaceArtifact
  settings: SpaceSettings
  hygieneWarnings?: HygieneGateFinding[] | undefined
} | null> {
  const { paths, registryPath, harnessId, adapter, options } = ctx

  const kind = classifySpaceEntry(entry)
  const isDev = kind === 'dev'
  const isProjectSpace = kind === 'project'
  const isAgentSpace = kind === 'agent'

  // Compute cache key
  const pluginName = entry.plugin?.name ?? entry.id
  const pluginVersion = entry.plugin?.version ?? DEFAULT_PLUGIN_VERSION
  const cacheKey = computeHarnessPluginCacheKey(
    harnessId,
    PLUGIN_MATERIALIZER_VERSION,
    entry.integrity as Sha256Integrity,
    pluginName,
    pluginVersion
  )
  const publishedCacheDir = paths.pluginCache(cacheKey)

  // Build space key
  const spaceKey: SpaceKey = spaceKeyForEntry(entry, kind)

  // Build snapshot path
  // - Agent spaces: read from agent's spaces/ directory
  // - Project spaces: read from project's spaces/ directory
  // - @dev spaces: read from registry's spaces/ directory
  // - Others: read from content-addressed store
  const snapshotPath = resolveSpaceContentDir(kind, entry, {
    agentPath: options.agentPath,
    projectPath: options.projectPath,
    registryPath,
    paths,
  })

  // Read manifest for settings and harness support filtering
  let manifest: ResolvedSpaceManifest | undefined
  try {
    const spaceTomlPath = join(snapshotPath, 'space.toml')
    const parsed = await readSpaceToml(spaceTomlPath)
    manifest = {
      ...parsed,
      schema: 1,
      id: entry.id,
      plugin: {
        ...parsed.plugin,
        name: pluginName,
        version: pluginVersion,
      },
    } as ResolvedSpaceManifest
  } catch {
    manifest = undefined
  }

  const supports = manifest?.harness?.supports
  if (supports !== undefined && !(supports as readonly string[]).includes(harnessId)) {
    // Skip spaces that do not declare the selected canonical harness id.
    // Removed ids and aliases never translate (T-08701).
    return null
  }

  const input: MaterializeSpaceInput = {
    spaceKey,
    manifest:
      manifest ??
      ({
        schema: 1,
        id: entry.id,
        plugin: {
          ...entry.plugin,
          name: pluginName,
          version: pluginVersion,
        },
      } as ResolvedSpaceManifest),
    snapshotPath,
    integrity: entry.integrity,
  }

  const isMutableLocalSpace = isDev || isProjectSpace || isAgentSpace
  let artifactPath = publishedCacheDir
  // Force-compose findings admitted to reusable cache under ASP_FORCE_COMPOSE_HYGIENE
  // (immutable branch only). Empty on a clean gate pass; threaded up so the compile
  // path can surface them as deterministic warning diagnostics.
  let hygieneWarnings: HygieneGateFinding[] | undefined

  if (isMutableLocalSpace) {
    // Mutable dev/project/agent staging is NEVER admitted to reusable cache, so the
    // cache-admission hygiene gate does NOT apply here (T-05574 amendment). Widening
    // it to this branch would turn the gate into boot-time content policy.
    artifactPath = uniqueStagingDir(
      paths,
      `space-${sanitizeProjectAgentScopeSegment(String(spaceKey))}`
    )
    await adapter.materializeSpace(input, artifactPath, { force: false, useHardlinks: false })
  } else {
    const ensurePublishedCache = async (): Promise<void> => {
      if (await cacheExists(cacheKey, { paths })) {
        return
      }

      const stagingDir = uniqueStagingDir(paths, `cache-${cacheKey.slice(0, 16)}`)
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      try {
        const result = await adapter.materializeSpace(input, stagingDir, {
          force: false,
          useHardlinks: true,
        })

        // Compose-time hygiene gate (cache-admission) — immutable REGISTRY fresh
        // write. Runs on the materialized staging tree BEFORE writeCacheMetadataAt;
        // a block throws (the catch below removes the staging dir, so no blessed
        // cache entry is left). Force-compose admits the write and carries findings
        // out as warnings. See T-05574.
        const gate = await evaluateHygieneGate({
          pluginPath: stagingDir,
          sourceRoot: snapshotPath,
          spaceKey,
        })
        if (gate.blocking.length > 0) {
          if (!forceComposeEnabled()) {
            throw new MaterializationHygieneError(spaceKey, stagingDir, gate.blocking)
          }
          hygieneWarnings = gate.blocking
        }

        const files = Array.from(new Set(result.files)).sort()
        await writeCacheMetadataAt(stagingDir, {
          schemaVersion: 1,
          complete: true,
          pluginName,
          pluginVersion,
          integrity: entry.integrity as Sha256Integrity,
          cacheKey,
          createdAt: resolveNowIso(options.compileContext),
          spaceKey,
          files,
          requiredEntries: await buildCacheRequiredEntries(stagingDir, files),
        })
        try {
          await mkdir(paths.cache, { recursive: true })
          await rename(stagingDir, publishedCacheDir)
        } catch (error) {
          await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error
          }
          if (!(await cacheExists(cacheKey, { paths }))) {
            throw error
          }
        }
      } catch (error) {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    }

    await withLock(materializationLockPath(paths, `cache-${cacheKey}`), ensurePublishedCache, {
      stale: 60_000,
      retries: 600,
    })
  }

  return {
    artifact: {
      spaceKey,
      spaceId: entry.id,
      artifactPath,
      pluginName,
      pluginVersion,
    },
    // Read settings from snapshot's space.toml for composition
    settings: manifest?.settings ?? {},
    ...(hygieneWarnings !== undefined ? { hygieneWarnings } : {}),
  }
}

/**
 * Materialize agent-local skills and commands as a synthetic plugin artifact.
 *
 * Agent-local components (skills/ and commands/ directories at the agent root)
 * are copied into a temporary directory structured as a plugin, then returned
 * as a ResolvedSpaceArtifact to be appended to the artifacts array.
 *
 * Key properties:
 * - Uses forceCopy (not hardlinks) since agent files are mutable
 * - Always rebuilt on every run (no caching — mutable local files)
 * - Appended last to artifacts[] so it gets the highest numeric prefix in the bundle
 *
 * @param components - Detected agent-local components
 * @param paths - Path resolver for ASP_HOME locations
 * @returns Artifact entry or undefined if no components exist
 */
export async function materializeAgentLocalComponents(
  components: AgentLocalComponents | undefined,
  paths: PathResolver
): Promise<ResolvedSpaceArtifact | undefined> {
  if (!components || (!components.hasSkills && !components.hasCommands)) {
    return undefined
  }

  const agentName = basename(components.agentRoot)
  const pluginName = `${agentName}-agent`

  // Build in a unique temp directory under ASP_HOME/tmp. This directory is a
  // per-compose source artifact; sharing it by agent basename races under
  // parallel starts.
  const tmpDir = uniqueStagingDir(
    paths,
    `agent-components-${sanitizeProjectAgentScopeSegment(agentName)}`
  )
  await mkdir(tmpDir, { recursive: true })

  // Write minimal plugin.json
  const pluginDir = join(tmpDir, '.claude-plugin')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'plugin.json'),
    JSON.stringify(
      {
        name: pluginName,
        version: DEFAULT_PLUGIN_VERSION,
        description: 'Agent-local skills and commands',
      },
      null,
      2
    )
  )

  // Copy skills/ if present (forceCopy — mutable source files). Preserve
  // selected directory symlinks so compatibility lowerings retain the same
  // package attribution and metadata as direct Pi discovery.
  if (components.hasSkills) {
    await linkDirectory(components.skillsDir, join(tmpDir, 'skills'), {
      forceCopy: true,
    })
  }

  // Copy commands/ if present
  if (components.hasCommands) {
    await linkDirectory(components.commandsDir, join(tmpDir, 'commands'), {
      forceCopy: true,
      followSymlinks: true,
    })
  }

  return {
    spaceKey: `${pluginName}@local` as SpaceKey,
    spaceId: pluginName,
    artifactPath: tmpDir,
    pluginName,
    pluginVersion: DEFAULT_PLUGIN_VERSION,
  }
}
