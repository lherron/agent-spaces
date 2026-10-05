/**
 * Target bundle publication: compose a target's plugin artifacts through the
 * harness adapter into a fingerprinted, versioned bundle under the scope's
 * codex-homes root, validated by its `.asp-materialized.json` manifest.
 */

import { createHash } from 'node:crypto'
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

import { createCanonicalHasher } from 'spaces-runtime-contracts'

import { resolveNowIso } from '../core/compile-clock.js'
// Internal legacy seam (EN-15986): the install path addresses adapters by
// their pre-cutover ids. T-08702 deletes it with the v1 flow.
import type { HarnessId } from '../core/types/harness.js'

import {
  type CodexOptions,
  type ComposeTargetInput,
  DEFAULT_HARNESS,
  type HygieneGateFinding,
  type LockFile,
  type ResolvedSpaceArtifact,
  type SpaceKey,
  type SpaceRefString,
  type SpaceSettings,
  TARGETS_FILENAME,
  getEffectiveCodexOptions,
  getLoadOrderEntries,
  withLock,
} from '../core/index.js'

import {
  PathResolver,
  getAspHome,
  pruneBundleVersions,
  sanitizeProjectAgentScopeSegment,
  sweepAspTempArtifacts,
} from '../store/index.js'

import type { InstallOptions } from './install.js'
import { materializationLockPath, uniqueStagingDir } from './materialization-staging.js'
import {
  type MaterializeTargetContext,
  materializeAgentLocalComponents,
  materializeSpaceEntry,
} from './plugin-artifacts.js'
import { getRegistryPath, loadProjectManifest } from './resolve.js'

const TARGET_MATERIALIZER_VERSION = 'target-materializer-v3-ask-user-question-timeout'
const TARGET_MANIFEST_FILENAME = '.asp-materialized.json'

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
  /**
   * Ordered roots from which the selected harness discovers effective skills.
   *
   * Most adapters discover from plugin directories. Pi SDK instead merges the
   * composed skills into one bundle directory, which must remain observable by
   * callers rather than being inferred from generic plugin metadata.
   */
  effectiveSkillRoots: string[]
  /** Path to composed MCP config (if any) */
  mcpConfigPath?: string | undefined
  /** Path to composed settings.json (if any) */
  settingsPath?: string | undefined
  /**
   * Hygiene findings force-admitted to reusable cache under force-compose
   * (`ASP_FORCE_COMPOSE_HYGIENE`). Empty/absent on a clean gate pass. Threaded up
   * so the compile path can surface them as deterministic warning diagnostics.
   */
  hygieneWarnings?: HygieneGateFinding[] | undefined
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Install-path hash material is serialized by the single shared canonical-JSON
 * implementation in spaces-runtime-contracts (codepoint key ordering), not a
 * local serializer.
 */
const canonicalHasher = createCanonicalHasher()

function stableJson(value: unknown): string {
  return canonicalHasher.canonicalize(value)
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
    for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
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

function isPublishCollision(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EEXIST' || code === 'ENOTEMPTY'
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
  const hygieneWarnings: HygieneGateFinding[] = []

  for (const entry of entries) {
    const result = await materializeSpaceEntry(entry, ctx)
    if (!result) {
      // Space does not support the selected harness — skipped
      continue
    }
    artifacts.push(result.artifact)
    settingsInputs.push(result.settings)
    if (result.hygieneWarnings) {
      hygieneWarnings.push(...result.hygieneWarnings)
    }
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
            generatedAt: resolveNowIso(options.compileContext),
            requiredPaths,
          },
          null,
          2
        )}\n`
      )
      await mkdir(join(publicScopeRoot, 'bundles', '.versions'), { recursive: true })
      if (!(await validateMaterializedTarget(outputPath, fingerprint))) {
        await rm(versionRoot, { recursive: true, force: true }).catch(() => {})
      }
      try {
        await rename(stagingRoot, versionRoot)
      } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
        if (!isPublishCollision(error)) {
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
    effectiveSkillRoots:
      bundle.piSdk?.skillsDir !== undefined ? [bundle.piSdk.skillsDir] : (bundle.pluginDirs ?? []),
    mcpConfigPath: bundle.mcpConfigPath,
    settingsPath: bundle.settingsPath,
    ...(hygieneWarnings.length > 0 ? { hygieneWarnings } : {}),
  }
}
