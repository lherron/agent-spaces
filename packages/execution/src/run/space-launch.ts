import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type ComposeTargetInput,
  type ComposedTargetBundle,
  DEFAULT_HARNESS,
  type HarnessAdapter,
  type HarnessDetection,
  type HarnessRunOptions,
  type LockFile,
  PathResolver,
  type ResolvedSpaceArtifact,
  type SpaceKey,
  type SpaceRefString,
  type SpaceSettings,
  computeClosure,
  createSnapshot,
  ensureDir,
  generateLockFileForTarget,
  getAspHome,
  isHarnessSupported,
  lockFileExists,
  parseSpaceRef,
  readLockJson,
  readSpaceToml,
  resolveSpaceManifest,
  serializeLockJson,
} from 'spaces-config'

import { harnessRegistry } from '../harness/index.js'

import { executeHarnessRun } from './execute.js'
import type { GlobalRunOptions, RunResult } from './types.js'
import { cleanupTempDir, createTempDir, mergeDefined, resolveInteractive } from './util.js'

async function persistGlobalLock(newLock: LockFile, globalLockPath: string): Promise<void> {
  let existingLock: LockFile | undefined

  if (await lockFileExists(globalLockPath)) {
    try {
      existingLock = await readLockJson(globalLockPath)
    } catch {
      // If corrupt, we'll overwrite with new lock
    }
  }

  const mergedLock: LockFile = existingLock
    ? {
        lockfileVersion: newLock.lockfileVersion,
        resolverVersion: newLock.resolverVersion,
        generatedAt: newLock.generatedAt,
        registry: newLock.registry,
        spaces: { ...existingLock.spaces, ...newLock.spaces },
        targets: { ...existingLock.targets, ...newLock.targets },
      }
    : newLock

  await writeFile(globalLockPath, serializeLockJson(mergedLock), 'utf-8')
}

interface ExecuteSpaceRunArgs {
  adapter: HarnessAdapter
  detection: HarnessDetection
  bundle: ComposedTargetBundle
  options: GlobalRunOptions
  aspHome: string
  defaultCwd: string
  tempDir: string
  lock: LockFile
}

async function executeSpaceRun({
  adapter,
  detection,
  bundle,
  options,
  aspHome,
  defaultCwd,
  tempDir,
  lock,
}: ExecuteSpaceRunArgs): Promise<RunResult> {
  const cliRunOptions: HarnessRunOptions = {
    aspHome,
    model: options.model,
    modelReasoningEffort: options.modelReasoningEffort,
    extraArgs: options.extraArgs,
    interactive: resolveInteractive(options.interactive),
    prompt: options.prompt,
    settingSources: options.settingSources,
    permissionMode: options.permissionMode,
    settings: options.settings,
    yolo: options.yolo,
    debug: options.debug,
    projectPath: options.cwd ?? defaultCwd,
    cwd: options.cwd ?? defaultCwd,
    artifactDir: options.artifactDir,
    continuationKey: options.continuationKey,
    remoteControl: options.remoteControl,
    sessionNamePrefix: options.sessionNamePrefix,
  }
  const runOptions = mergeDefined<HarnessRunOptions>({}, cliRunOptions)

  if (runOptions.interactive === false && runOptions.prompt === undefined) {
    throw new Error('Non-interactive mode requires a prompt')
  }

  const execution = await executeHarnessRun(adapter, detection, bundle, runOptions, {
    env: options.env,
    dryRun: options.dryRun,
    pagePrompts: options.pagePrompts,
  })

  const shouldCleanup = options.dryRun ? false : (options.cleanup ?? !options.interactive)
  if (shouldCleanup) {
    await cleanupTempDir(tempDir)
  }

  return {
    build: {
      pluginDirs: bundle.pluginDirs ?? [],
      mcpConfigPath: bundle.mcpConfigPath,
      settingsPath: bundle.settingsPath,
      warnings: [],
      lock,
    },
    invocation: execution.invocation,
    exitCode: execution.exitCode,
    command: execution.command,
    displayCommand: execution.displayCommand,
  }
}

/**
 * Run a space reference in global mode (without a project).
 *
 * Allows `asp run space:my-space@stable` without being in a project. The space
 * is resolved from the registry, materialized, and run with the harness.
 * For @dev selector, runs directly from the filesystem.
 */
export async function runGlobalSpace(
  spaceRefString: SpaceRefString,
  options: GlobalRunOptions = {}
): Promise<RunResult> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })
  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)
  const detection = await adapter.detect()

  const ref = parseSpaceRef(spaceRefString)
  const registryPath = options.registryPath ?? paths.repo

  if (ref.selector.kind === 'dev') {
    const spacePath = join(registryPath, 'spaces', ref.id)
    return runLocalSpace(spacePath, options)
  }

  const closure = await computeClosure([spaceRefString], { cwd: registryPath })

  for (const spaceKey of closure.loadOrder) {
    const space = closure.spaces.get(spaceKey)
    if (!space) continue
    await createSnapshot(space.id, space.commit, { paths, cwd: registryPath })
  }

  const lock = await generateLockFileForTarget('_global', [spaceRefString], closure, {
    cwd: registryPath,
    registry: { type: 'git', url: registryPath },
  })

  await persistGlobalLock(lock, paths.globalLock)

  const tempDir = await createTempDir(aspHome)
  const outputDir = join(tempDir, harnessId)
  const artifactRoot = join(tempDir, 'artifacts')
  await ensureDir(outputDir)
  await ensureDir(artifactRoot)

  try {
    const artifacts: ResolvedSpaceArtifact[] = []
    const settingsInputs: SpaceSettings[] = []
    const loadOrder: SpaceKey[] = []
    const rootKeys = new Set(closure.roots)

    for (const spaceKey of closure.loadOrder) {
      const space = closure.spaces.get(spaceKey)
      if (!space) throw new Error(`Space not found in closure: ${spaceKey}`)

      const supports = space.manifest.harness?.supports
      if (!isHarnessSupported(supports, harnessId)) {
        if (rootKeys.has(spaceKey)) {
          throw new Error(`Space "${space.id}" does not support harness "${harnessId}"`)
        }
        continue
      }

      const lockEntry = lock.spaces[spaceKey]
      const pluginName =
        lockEntry?.plugin?.name ?? space.manifest.plugin?.name ?? (space.id as string)
      const pluginVersion = lockEntry?.plugin?.version ?? space.manifest.plugin?.version
      const snapshotIntegrity = lockEntry?.integrity ?? `sha256:${'0'.repeat(64)}`
      const snapshotPath = paths.snapshot(snapshotIntegrity)

      const manifest = {
        ...space.manifest,
        schema: 1 as const,
        id: space.id,
        plugin: {
          ...(space.manifest.plugin ?? {}),
          name: pluginName,
          ...(pluginVersion ? { version: pluginVersion } : {}),
        },
      }

      const artifactPath = join(artifactRoot, spaceKey.replace(/[^a-zA-Z0-9._-]/g, '_'))
      await adapter.materializeSpace(
        {
          manifest,
          snapshotPath,
          spaceKey,
          integrity: snapshotIntegrity as `sha256:${string}`,
        },
        artifactPath,
        { force: true, useHardlinks: true }
      )

      artifacts.push({
        spaceKey,
        spaceId: space.id,
        artifactPath,
        pluginName,
        ...(pluginVersion ? { pluginVersion } : {}),
      })

      settingsInputs.push(space.manifest.settings ?? {})
      loadOrder.push(spaceKey)
    }

    const roots = closure.roots.filter((key) => loadOrder.includes(key))
    const composeInput: ComposeTargetInput = {
      targetName: ref.id as string,
      compose: [spaceRefString],
      roots,
      loadOrder,
      artifacts,
      settingsInputs,
    }

    const { bundle } = await adapter.composeTarget(composeInput, outputDir, {
      clean: true,
      inheritProject: options.inheritProject,
      inheritUser: options.inheritUser,
    })

    return await executeSpaceRun({
      adapter,
      detection,
      bundle,
      options,
      aspHome,
      defaultCwd: process.cwd(),
      tempDir,
      lock,
    })
  } catch (error) {
    await cleanupTempDir(tempDir)
    throw error
  }
}

/**
 * Run a local space directory in dev mode (without a project).
 *
 * Allows `asp run ./my-space` for local development. The space is read
 * directly from the filesystem.
 */
export async function runLocalSpace(
  spacePath: string,
  options: GlobalRunOptions = {}
): Promise<RunResult> {
  const aspHome = options.aspHome ?? getAspHome()
  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)
  const detection = await adapter.detect()

  const manifestPath = join(spacePath, 'space.toml')
  const rawManifest = await readSpaceToml(manifestPath)
  const manifest = resolveSpaceManifest(rawManifest)
  const supports = manifest.harness?.supports
  if (!isHarnessSupported(supports, harnessId)) {
    throw new Error(`Space "${manifest.id}" does not support harness "${harnessId}"`)
  }

  const tempDir = await createTempDir(aspHome)
  const outputDir = join(tempDir, harnessId)
  const artifactRoot = join(tempDir, 'artifacts')
  await ensureDir(outputDir)
  await ensureDir(artifactRoot)

  try {
    const spaceKey = `${manifest.id}@local` as SpaceKey
    const pluginName = manifest.plugin.name
    const pluginVersion = manifest.plugin.version
    const artifactPath = join(artifactRoot, spaceKey.replace(/[^a-zA-Z0-9._-]/g, '_'))

    await adapter.materializeSpace(
      {
        manifest,
        snapshotPath: spacePath,
        spaceKey,
        integrity: 'sha256:dev' as `sha256:${string}`,
      },
      artifactPath,
      { force: true, useHardlinks: false }
    )

    const composeInput: ComposeTargetInput = {
      targetName: manifest.id,
      compose: [`space:${manifest.id}@dev` as SpaceRefString],
      roots: [spaceKey],
      loadOrder: [spaceKey],
      artifacts: [
        {
          spaceKey,
          spaceId: manifest.id,
          artifactPath,
          pluginName,
          ...(pluginVersion ? { pluginVersion } : {}),
        },
      ],
      settingsInputs: [manifest.settings ?? {}],
    }

    const { bundle } = await adapter.composeTarget(composeInput, outputDir, {
      clean: true,
      inheritProject: options.inheritProject,
      inheritUser: options.inheritUser,
    })

    const syntheticLock: LockFile = {
      lockfileVersion: 1 as const,
      resolverVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      registry: { type: 'git' as const, url: 'local' },
      spaces: {},
      targets: {},
    }

    return await executeSpaceRun({
      adapter,
      detection,
      bundle,
      options,
      aspHome,
      defaultCwd: spacePath,
      tempDir,
      lock: syntheticLock,
    })
  } catch (error) {
    await cleanupTempDir(tempDir)
    throw error
  }
}
