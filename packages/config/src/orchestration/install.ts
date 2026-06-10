/**
 * Lock/store orchestration (install command).
 *
 * WHY: Orchestrates the full installation process:
 * - Parse targets from project manifest
 * - Resolve all space references
 * - Write lock file
 * - Populate store with space snapshots
 * - Materialize composed bundles under ASP_HOME
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

import {
  type AgentLocalComponents,
  type CodexOptions,
  type CommitSha,
  type ComposeTargetInput,
  DEFAULT_HARNESS,
  type HarnessAdapter,
  type HarnessId,
  LOCK_FILENAME,
  type LockFile,
  type LockSpaceEntry,
  type MaterializeSpaceInput,
  type ResolvedSpaceArtifact,
  type ResolvedSpaceManifest,
  type Sha256Integrity,
  type SpaceId,
  type SpaceKey,
  type SpaceRefString,
  type SpaceSettings,
  TARGETS_FILENAME,
  atomicWriteJson,
  createEmptyLockFile,
  getEffectiveCodexOptions,
  getLoadOrderEntries,
  isHarnessSupported,
  readSpaceToml,
  withLock,
  withProjectLock,
} from '../core/index.js'

import { linkDirectory } from '../materializer/link-components.js'
import {
  COMMIT_KEY_PREFIX_LEN,
  classifySpaceEntry,
  mergeLockFiles,
  resolveSpaceContentDir,
} from '../resolver/index.js'

import {
  type CacheRequiredEntry,
  PathResolver,
  type SnapshotOptions,
  cacheExists,
  computeHarnessPluginCacheKey,
  createSnapshot,
  ensureAspHome,
  getAspHome,
  pruneBundleVersions,
  sanitizeProjectAgentScopeSegment,
  snapshotExists,
  sweepAspTempArtifacts,
  writeCacheMetadataAt,
} from '../store/index.js'

import { fetch as gitFetch } from '../git/index.js'
import {
  type LintContext,
  type LintWarning,
  type SpaceLintData,
  WARNING_CODES,
  formatWarnings,
  lint as lintSpaces,
} from '../lint/index.js'

import {
  type ResolveOptions,
  type ResolveResult,
  getRegistryPath,
  loadLockFileIfExists,
  loadProjectManifest,
  resolveTarget,
} from './resolve.js'

/** Default plugin version used when a space declares none. */
const DEFAULT_PLUGIN_VERSION = '0.0.0'
const PLUGIN_MATERIALIZER_VERSION = 'plugin-materializer-v3-complete'
const TARGET_MATERIALIZER_VERSION = 'target-materializer-v2-published-output-path'
const TARGET_MANIFEST_FILENAME = '.asp-materialized.json'

/**
 * Options for install operation.
 */
export interface InstallOptions extends ResolveOptions {
  /** Harness to install for (default: 'claude') */
  harness?: HarnessId | undefined
  /** Harness adapter to use for materialization. Required for materializeTarget. */
  adapter?: HarnessAdapter | undefined
  /** Whether to update existing lock (default: false) */
  update?: boolean | undefined
  /** Targets to install (default: all) */
  targets?: string[] | undefined
  /** Whether to fetch registry updates (default: true) */
  fetchRegistry?: boolean | undefined
  /**
   * Space IDs to upgrade (default: all spaces).
   * When specified with update=true, only these spaces will be re-resolved
   * to their latest versions matching selectors. All other spaces will
   * keep their currently locked versions.
   */
  upgradeSpaceIds?: string[] | undefined
  /**
   * Force refresh from source (default: false).
   * Clears plugin cache and re-materializes all spaces from source.
   * Useful when source files have changed and you want to update the cache.
   */
  refresh?: boolean | undefined
  /**
   * Inherit project-level settings (for Pi: enables .pi/skills in project).
   * Maps to --inherit-project CLI flag.
   */
  inheritProject?: boolean | undefined
  /**
   * Inherit user-level settings (for Pi: enables ~/.pi/agent/skills).
   * Maps to --inherit-user CLI flag.
   */
  inheritUser?: boolean | undefined
  /**
   * Agent-local components (skills/ and commands/ directories) detected at the agent root.
   * When present, a synthetic plugin artifact is appended to the target bundle.
   */
  agentLocalComponents?: AgentLocalComponents | undefined
  /**
   * Semantic stable identity for agent/project placements. When present, this
   * drives the public codex-homes/<project>_<agent> scope path instead of cwd
   * basenames.
   */
  materializationIdentity?:
    | {
        agentId: string
        projectId: string
        frontend?: string | undefined
      }
    | undefined
}

/**
 * Result of materializing a single target.
 */
export interface TargetMaterializationResult {
  /** Target name */
  target: string
  /** Path to the target's output directory under ASP_HOME */
  outputPath: string
  /** Paths to materialized plugin directories */
  pluginDirs: string[]
  /** Path to composed MCP config (if any) */
  mcpConfigPath?: string | undefined
  /** Path to composed settings.json (if any) */
  settingsPath?: string | undefined
}

/**
 * Result of install operation.
 */
export interface InstallResult {
  /** Updated lock file */
  lock: LockFile
  /** Number of new snapshots created */
  snapshotsCreated: number
  /** Targets that were resolved */
  resolvedTargets: string[]
  /** Path to written lock file */
  lockPath: string
  /** Materialization results per target */
  materializations: TargetMaterializationResult[]
}

/**
 * Ensure registry is available and up to date.
 */
export async function ensureRegistry(options: InstallOptions): Promise<string> {
  await ensureAspHome()

  const repoPath = getRegistryPath(options)

  // If fetchRegistry is enabled, update the repo
  if (options.fetchRegistry !== false) {
    try {
      await gitFetch('origin', { cwd: repoPath, all: true })
    } catch {
      // Repository may not exist yet, that's ok
    }
  }

  return repoPath
}

/**
 * Populate store with the registry-backed snapshots referenced by a lock.
 *
 * Shared core behind both {@link populateStore} (install path) and the
 * materialize-from-refs path; returns the number of snapshots created.
 */
export async function populateSnapshotsFromLock(
  lock: LockFile,
  registryPath: string,
  aspHome: string
): Promise<number> {
  const paths = new PathResolver({ aspHome })
  const snapshotOptions: SnapshotOptions = {
    paths,
    cwd: registryPath,
  }

  let created = 0

  for (const entry of Object.values(lock.spaces)) {
    // Skip filesystem-backed entries (@dev / project / agent) — no snapshot needed
    if (classifySpaceEntry(entry) !== 'registry') {
      continue
    }

    // Check if snapshot already exists
    if (await snapshotExists(entry.integrity, snapshotOptions)) {
      continue
    }

    // Create snapshot from registry
    await createSnapshot(entry.id, entry.commit, snapshotOptions)

    created++
  }

  return created
}

/**
 * Populate store with space snapshots from lock.
 */
export async function populateStore(lock: LockFile, options: InstallOptions): Promise<number> {
  const aspHome = options.aspHome ?? getAspHome()
  const registryPath = getRegistryPath(options)
  return populateSnapshotsFromLock(lock, registryPath, aspHome)
}

/**
 * Write lock file atomically.
 */
export async function writeLockFile(lock: LockFile, projectPath: string): Promise<string> {
  const lockPath = join(projectPath, LOCK_FILENAME)
  await atomicWriteJson(lockPath, lock)
  return lockPath
}

/**
 * Per-target context shared by the space-materialization helpers.
 */
interface MaterializeTargetContext {
  paths: PathResolver
  registryPath: string
  harnessId: HarnessId
  adapter: HarnessAdapter
  options: InstallOptions
}

function materializationLockPath(paths: PathResolver, key: string): string {
  const safeKey = sanitizeProjectAgentScopeSegment(key)
  return join(paths.temp, 'locks', `${safeKey}.lock`)
}

function uniqueStagingDir(paths: PathResolver, prefix: string): string {
  return join(paths.temp, '.staging', `${prefix}-${process.pid}-${randomUUID()}`)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function hashDirectory(
  root: string,
  options: { excludeRelativePaths?: Set<string> | undefined } = {}
): Promise<string> {
  const entries: string[] = []
  const excludeRelativePaths = options.excludeRelativePaths ?? new Set()

  async function visit(dir: string, prefix: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true })
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = join(dir, dirent.name)
      const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name
      if (excludeRelativePaths.has(relativePath)) {
        continue
      }
      const stats = await lstat(fullPath)
      if (dirent.isDirectory()) {
        entries.push(`dir ${relativePath} ${stats.mode}`)
        await visit(fullPath, relativePath)
      } else if (dirent.isSymbolicLink()) {
        entries.push(`symlink ${relativePath} ${stats.mode} ${await readlink(fullPath)}`)
      } else if (dirent.isFile()) {
        const content = await readFile(fullPath)
        entries.push(
          `file ${relativePath} ${stats.mode} ${createHash('sha256').update(content).digest('hex')}`
        )
      }
    }
  }

  await visit(root, '')
  return sha256Hex(entries.join('\n'))
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

function computeTargetFingerprint(input: {
  harnessId: HarnessId
  targetName: string
  identity?: InstallOptions['materializationIdentity']
  target: LockFile['targets'][string] | undefined
  artifacts: Array<
    Pick<ResolvedSpaceArtifact, 'spaceKey' | 'spaceId' | 'pluginName' | 'pluginVersion'> & {
      contentHash: string
    }
  >
  settingsInputs: SpaceSettings[]
  codexOptions: CodexOptions | undefined
}): string {
  return sha256Hex(
    stableJson({
      schemaVersion: TARGET_MATERIALIZER_VERSION,
      harnessId: input.harnessId,
      targetName: input.targetName,
      identity: input.identity,
      compose: input.target?.compose ?? [],
      roots: input.target?.roots ?? [],
      loadOrder: input.target?.loadOrder ?? [],
      artifacts: input.artifacts,
      settingsInputs: input.settingsInputs,
      codexOptions: input.codexOptions,
    })
  )
}

async function validateMaterializedTarget(
  outputPath: string,
  fingerprint: string
): Promise<boolean> {
  try {
    const manifestPath = join(outputPath, TARGET_MANIFEST_FILENAME)
    const manifestFile = Bun.file(manifestPath)
    if (!(await manifestFile.exists())) {
      return false
    }
    const manifest = (await manifestFile.json()) as {
      fingerprint?: string
      complete?: boolean
      requiredPaths?: string[]
    }
    if (manifest.fingerprint !== fingerprint || manifest.complete !== true) {
      return false
    }
    for (const requiredPath of manifest.requiredPaths ?? []) {
      if (!(await pathExists(join(outputPath, requiredPath)))) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

function targetRequiredPaths(bundle: {
  rootDir: string
  settingsPath?: string | undefined
  mcpConfigPath?: string | undefined
  pluginDirs?: string[] | undefined
}): string[] {
  const required = new Set<string>()
  if (bundle.settingsPath) {
    required.add(relative(bundle.rootDir, bundle.settingsPath))
  }
  if (bundle.mcpConfigPath) {
    required.add(relative(bundle.rootDir, bundle.mcpConfigPath))
  }
  if (bundle.pluginDirs) {
    for (const pluginDir of bundle.pluginDirs) {
      required.add(relative(bundle.rootDir, pluginDir))
    }
  }
  return Array.from(required).sort()
}

/**
 * Materialize a single locked space entry into a plugin artifact.
 *
 * Returns the resolved artifact plus the settings to feed composition, or null
 * when the space does not support the selected harness (and is skipped).
 */
async function materializeSpaceEntry(
  entry: LockSpaceEntry,
  ctx: MaterializeTargetContext
): Promise<{ artifact: ResolvedSpaceArtifact; settings: SpaceSettings } | null> {
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
  let spaceKey: SpaceKey
  if (isAgentSpace) {
    spaceKey = `${entry.id}@agent` as SpaceKey
  } else if (isProjectSpace) {
    spaceKey = `${entry.id}@project` as SpaceKey
  } else if (isDev) {
    spaceKey = `${entry.id}@dev` as SpaceKey
  } else {
    spaceKey = `${entry.id}@${entry.commit.slice(0, COMMIT_KEY_PREFIX_LEN)}` as SpaceKey
  }

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
  if (!isHarnessSupported(supports, harnessId)) {
    // Skip spaces that do not support the selected harness
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

  if (isMutableLocalSpace) {
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
        const files = Array.from(new Set(result.files)).sort()
        await writeCacheMetadataAt(stagingDir, {
          schemaVersion: 1,
          complete: true,
          pluginName,
          pluginVersion,
          integrity: entry.integrity as Sha256Integrity,
          cacheKey,
          createdAt: new Date().toISOString(),
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
  }
}

/**
 * Load the effective codex options for a target, if the project carries an
 * asp-targets.toml manifest. Returns undefined when there is no manifest.
 */
async function loadEffectiveCodexOptions(
  projectPath: string,
  targetName: string,
  aspHome: string | undefined
): Promise<CodexOptions | undefined> {
  const manifestPath = join(projectPath, TARGETS_FILENAME)
  if (!existsSync(manifestPath)) {
    return undefined
  }
  const manifest = await loadProjectManifest(projectPath, aspHome)
  return getEffectiveCodexOptions(manifest, targetName)
}

/**
 * Materialize a single target to the ASP_HOME project bundle directory.
 *
 * Uses the harness adapter's two-phase approach:
 * 1. materializeSpace() - Creates plugin artifacts with harness-specific transforms
 * 2. composeTarget() - Assembles artifacts into the target bundle
 */
export async function materializeTarget(
  targetName: string,
  lock: LockFile,
  options: InstallOptions
): Promise<TargetMaterializationResult> {
  const aspHome = options.aspHome ?? getAspHome()
  await sweepAspTempArtifacts({ aspHome }).catch(() => {})
  const paths = new PathResolver({ aspHome })
  const registryPath = getRegistryPath(options)

  // Get harness adapter (must be provided by caller)
  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = options.adapter
  if (!adapter) {
    throw new Error(
      `materializeTarget requires an adapter. Use the execution package to get a harness adapter for '${harnessId}'.`
    )
  }

  const publicScopeRoot = options.materializationIdentity
    ? join(
        aspHome,
        'codex-homes',
        `${sanitizeProjectAgentScopeSegment(
          options.materializationIdentity.projectId
        )}_${sanitizeProjectAgentScopeSegment(options.materializationIdentity.agentId)}`
      )
    : join(
        aspHome,
        'codex-homes',
        `${sanitizeProjectAgentScopeSegment(basename(options.projectPath))}_${sanitizeProjectAgentScopeSegment(
          targetName
        )}`
      )

  // Get spaces in load order for this target (from lock)
  const entries = getLoadOrderEntries(lock, targetName)

  // Phase 1: Materialize each space using the harness adapter
  // This handles harness-specific transforms like hooks.toml → hooks.json for Claude
  const ctx: MaterializeTargetContext = { paths, registryPath, harnessId, adapter, options }
  const artifacts: ResolvedSpaceArtifact[] = []
  const settingsInputs: SpaceSettings[] = []

  for (const entry of entries) {
    const result = await materializeSpaceEntry(entry, ctx)
    if (!result) {
      // Space does not support the selected harness — skipped
      continue
    }
    artifacts.push(result.artifact)
    settingsInputs.push(result.settings)
  }

  // Phase 1b: Materialize agent-local components as a synthetic plugin (appended last)
  if (options.agentLocalComponents) {
    const agentArtifact = await materializeAgentLocalComponents(options.agentLocalComponents, paths)
    if (agentArtifact) {
      artifacts.push(agentArtifact)
      settingsInputs.push({}) // no settings from agent components
    }
  }
  const artifactFingerprints = []
  for (const artifact of artifacts) {
    artifactFingerprints.push({
      spaceKey: artifact.spaceKey,
      spaceId: artifact.spaceId,
      pluginName: artifact.pluginName,
      pluginVersion: artifact.pluginVersion,
      contentHash: await hashDirectory(artifact.artifactPath, {
        excludeRelativePaths: new Set(['.asp-cache.json']),
      }),
    })
  }

  // Phase 2: Compose target using harness adapter
  // This handles assembling artifacts into the final target bundle
  const target = lock.targets[targetName]
  const codexOptions = await loadEffectiveCodexOptions(
    options.projectPath,
    targetName,
    options.aspHome
  )
  const composeInput: ComposeTargetInput = {
    targetName,
    compose: (target?.compose ?? []) as SpaceRefString[],
    roots: (target?.roots ?? []) as SpaceKey[],
    loadOrder: (target?.loadOrder ?? []) as SpaceKey[],
    artifacts,
    settingsInputs,
    codexOptions,
  }

  const fingerprint = computeTargetFingerprint({
    harnessId,
    targetName,
    identity: options.materializationIdentity,
    target,
    artifacts: artifactFingerprints,
    settingsInputs,
    codexOptions,
  })
  const versionRoot = join(publicScopeRoot, 'bundles', '.versions', fingerprint)
  const outputPath = adapter.getTargetOutputPath(versionRoot, targetName)

  const publishTarget = async (): Promise<void> => {
    if (await validateMaterializedTarget(outputPath, fingerprint)) {
      return
    }

    const stagingRoot = uniqueStagingDir(
      paths,
      `bundle-${sanitizeProjectAgentScopeSegment(targetName)}-${fingerprint.slice(0, 16)}`
    )
    const stagingOutputPath = adapter.getTargetOutputPath(stagingRoot, targetName)
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    try {
      const { bundle } = await adapter.composeTarget(composeInput, stagingOutputPath, {
        clean: true,
        publishedOutputPath: outputPath,
        inheritProject: options.inheritProject,
        inheritUser: options.inheritUser,
      })
      const requiredPaths = targetRequiredPaths(bundle)
      await writeFile(
        join(stagingOutputPath, TARGET_MANIFEST_FILENAME),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            complete: true,
            materializerVersion: TARGET_MATERIALIZER_VERSION,
            fingerprint,
            harnessId,
            targetName,
            identity: options.materializationIdentity,
            generatedAt: new Date().toISOString(),
            requiredPaths,
          },
          null,
          2
        )}\n`
      )
      await mkdir(join(publicScopeRoot, 'bundles', '.versions'), { recursive: true })
      try {
        await rename(stagingRoot, versionRoot)
      } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error
        }
        if (!(await validateMaterializedTarget(outputPath, fingerprint))) {
          throw error
        }
      }
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  await withLock(
    materializationLockPath(
      paths,
      `bundle-scope-${sha256Hex(join(publicScopeRoot, 'bundles')).slice(0, 32)}`
    ),
    async () => {
      await publishTarget()
      await pruneBundleVersions({
        versionsRoot: join(publicScopeRoot, 'bundles', '.versions'),
        currentFingerprints: new Set([fingerprint]),
        referenceRoots: [paths.temp],
      })
    },
    { stale: 60_000, retries: 600 }
  )

  if (!(await validateMaterializedTarget(outputPath, fingerprint))) {
    throw new Error(`Materialized target did not validate after publish: ${outputPath}`)
  }

  const bundle = await adapter.loadTargetBundle(outputPath, targetName)
  const stagingRoot = join(paths.temp, '.staging')
  await Promise.all(
    artifacts
      .filter((artifact) => artifact.artifactPath.startsWith(stagingRoot))
      .map((artifact) =>
        rm(artifact.artifactPath, { recursive: true, force: true }).catch(() => {})
      )
  )

  return {
    target: targetName,
    outputPath: bundle.rootDir,
    pluginDirs: bundle.pluginDirs ?? [],
    mcpConfigPath: bundle.mcpConfigPath,
    settingsPath: bundle.settingsPath,
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

  // Copy skills/ if present (forceCopy — mutable source files)
  if (components.hasSkills) {
    await linkDirectory(components.skillsDir, join(tmpDir, 'skills'), {
      forceCopy: true,
      followSymlinks: true,
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

/**
 * Install targets from project manifest.
 *
 * This:
 * 1. Loads project manifest
 * 2. Resolves all specified targets (or all if not specified)
 * 3. Merges resolution results into a lock file
 * 4. Populates store with space snapshots
 * 5. Writes lock file
 * 6. Materializes composed bundles under ASP_HOME
 */
export async function install(options: InstallOptions): Promise<InstallResult> {
  // Ensure registry is available
  const registryPath = await ensureRegistry(options)

  // Load project manifest
  const manifest = await loadProjectManifest(options.projectPath, options.aspHome)

  // Determine which targets to resolve
  const targetNames = options.targets ?? Object.keys(manifest.targets)

  if (targetNames.length === 0) {
    throw new Error('No targets found in project manifest')
  }

  // Build pinnedSpaces map for selective upgrades
  // When upgradeSpaceIds is specified, we only re-resolve those spaces
  // and keep all others at their currently locked versions
  let pinnedSpaces: Map<SpaceId, CommitSha> | undefined
  if (options.update && options.upgradeSpaceIds && options.upgradeSpaceIds.length > 0) {
    const existingLock = await loadLockFileIfExists(options.projectPath)
    if (existingLock) {
      pinnedSpaces = new Map()
      const upgradeSet = new Set(options.upgradeSpaceIds)

      // For each space in the lock that is NOT being upgraded, pin it
      for (const [_key, entry] of Object.entries(existingLock.spaces)) {
        if (!upgradeSet.has(entry.id)) {
          pinnedSpaces.set(entry.id as SpaceId, entry.commit as CommitSha)
        }
      }
    }
  }

  // Build resolve options with pinnedSpaces
  const resolveOptions = { ...options, pinnedSpaces }

  // Resolve all targets
  const results: ResolveResult[] = []
  for (const name of targetNames) {
    const result = await resolveTarget(name, resolveOptions)
    results.push(result)
  }

  // Merge lock files - start with empty and merge each result
  let mergedLock = createEmptyLockFile({
    type: 'git',
    url: registryPath,
  })
  for (const result of results) {
    mergedLock = mergeLockFiles(mergedLock, result.lock)
  }

  // Populate store with snapshots
  const snapshotsCreated = await populateStore(mergedLock, options)

  // Run lint checks (halt on errors)
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })
  const lintData: SpaceLintData[] = Object.entries(mergedLock.spaces).map(([key, entry]) => {
    const pluginPath = resolveSpaceContentDir(classifySpaceEntry(entry), entry, {
      agentPath: options.agentPath,
      projectPath: options.projectPath,
      registryPath,
      paths,
    })
    return {
      key: key as SpaceKey,
      manifest: {
        schema: 1 as const,
        id: entry.id,
        plugin: entry.plugin,
      },
      pluginPath,
    }
  })
  const lintContext: LintContext = { spaces: lintData }
  const lintWarnings: LintWarning[] = await lintSpaces(lintContext)
  const skillErrors = lintWarnings.filter(
    (warning) => warning.code === WARNING_CODES.SKILL_MD_MISSING_FRONTMATTER
  )
  if (skillErrors.length > 0) {
    const formatted = formatWarnings(skillErrors)
    throw new Error(`Skill lint errors found:\n${formatted}`)
  }

  // Write lock file with project lock
  const lockPath = await withProjectLock(options.projectPath, async () => {
    return writeLockFile(mergedLock, options.projectPath)
  })

  // Materialize each target to the ASP_HOME project bundle directory
  const materializations: TargetMaterializationResult[] = []
  for (const targetName of targetNames) {
    const matResult = await materializeTarget(targetName, mergedLock, options)
    materializations.push(matResult)
  }

  return {
    lock: mergedLock,
    snapshotsCreated,
    resolvedTargets: targetNames,
    lockPath,
    materializations,
  }
}

// ============================================================================
// Install Need Helpers
// ============================================================================

/**
 * Check if two compose arrays match.
 */
function composeArraysMatch(manifestCompose: string[], lockCompose: string[]): boolean {
  if (manifestCompose.length !== lockCompose.length) {
    return false
  }
  return manifestCompose.every((ref, i) => ref === lockCompose[i])
}

/**
 * Check if install is needed (lock out of date).
 *
 * Compares the project manifest targets with the lock file.
 * Returns true if:
 * - Lock file doesn't exist
 * - Any target in manifest is missing from lock
 * - Any target's compose array differs
 */
export async function installNeeded(options: InstallOptions): Promise<boolean> {
  // Load lock file, if it doesn't exist, install is needed
  const existingLock = await loadLockFileIfExists(options.projectPath)
  if (!existingLock) {
    return true
  }

  // Load project manifest
  const manifest = await loadProjectManifest(options.projectPath, options.aspHome)

  // Get targets to check (specific targets or all)
  const targetNames = options.targets ?? Object.keys(manifest.targets)

  for (const name of targetNames) {
    const target = manifest.targets[name]
    if (!target) continue

    const lockTarget = existingLock.targets[name]
    if (!lockTarget) {
      return true
    }

    const manifestCompose = target.compose ?? []
    const lockCompose = lockTarget.compose ?? []
    if (!composeArraysMatch(manifestCompose, lockCompose)) {
      return true
    }
  }

  return false
}
