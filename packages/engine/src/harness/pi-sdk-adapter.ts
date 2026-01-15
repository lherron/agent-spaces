/**
 * PiSdkAdapter - Harness adapter for Pi SDK
 *
 * Implements the HarnessAdapter interface for Pi SDK, supporting:
 * - Extension bundling with Bun
 * - Skills directory handling (Agent Skills standard)
 * - Hook script materialization and bundle manifest generation
 * - SDK-backed runner invocation
 */

import { readdirSync } from 'node:fs'
import { constants, access, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AspError,
  type ComposeTargetInput,
  type ComposeTargetOptions,
  type ComposeTargetResult,
  type ComposedTargetBundle,
  type HarnessAdapter,
  type HarnessDetection,
  type HarnessRunOptions,
  type HarnessValidationResult,
  type LockWarning,
  type MaterializeSpaceInput,
  type MaterializeSpaceOptions,
  type MaterializeSpaceResult,
  copyDir,
  linkOrCopy,
} from 'spaces-core'
import {
  INSTRUCTIONS_FILE_AGNOSTIC,
  INSTRUCTIONS_FILE_CLAUDE,
  readHooksWithPrecedence,
} from 'spaces-materializer'
import {
  type ExtensionBuildOptions,
  PiBundleError,
  bundleExtension,
  discoverExtensions,
} from './pi-adapter.js'

// ============================================================================
// Constants & Types
// ============================================================================

const RUNNER_PATH = fileURLToPath(new URL('./pi-sdk/runner.js', import.meta.url))
const SDK_ENTRY_CANDIDATES = [
  'packages/coding-agent/dist/index.js',
  'packages/coding-agent/src/index.ts',
]

interface PiSdkBundleExtensionEntry {
  spaceId: string
  path: string
}

interface PiSdkBundleContextEntry {
  spaceId: string
  path: string
  label?: string | undefined
}

interface PiSdkBundleHookEntry {
  event: string
  script: string
  tools?: string[] | undefined
  blocking?: boolean | undefined
}

interface PiSdkBundleManifest {
  schemaVersion: 1
  harnessId: 'pi-sdk'
  targetName: string
  rootDir: string
  extensions: PiSdkBundleExtensionEntry[]
  skillsDir?: string | undefined
  contextFiles: PiSdkBundleContextEntry[]
  hooks: PiSdkBundleHookEntry[]
}

// ============================================================================
// Helper utilities
// ============================================================================

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isFile()
  } catch {
    return false
  }
}

function normalizeBundlePath(path: string): string {
  return path.replaceAll('\\', '/')
}

async function resolveSdkEntry(sdkRoot: string): Promise<string | null> {
  for (const candidate of SDK_ENTRY_CANDIDATES) {
    const entryPath = join(sdkRoot, candidate)
    if (await fileExists(entryPath)) {
      return entryPath
    }
  }
  return null
}

async function resolveInstructionFile(snapshotPath: string): Promise<string | null> {
  const agentPath = join(snapshotPath, INSTRUCTIONS_FILE_AGNOSTIC)
  if (await fileExists(agentPath)) {
    return agentPath
  }

  const claudePath = join(snapshotPath, INSTRUCTIONS_FILE_CLAUDE)
  if (await fileExists(claudePath)) {
    return claudePath
  }

  return null
}

async function resolveHookScriptRelative(script: string, hooksDir: string): Promise<string> {
  const normalized = script.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, '').replace(/^hooks\//, '')

  if (/\s/.test(normalized)) {
    return script
  }

  if (isAbsolute(normalized)) {
    if (await isFile(normalized)) {
      return normalized
    }
    throw new AspError(`Hook script not found: "${script}"`, 'HOOK_SCRIPT_NOT_FOUND')
  }

  const directPath = join(hooksDir, normalized)
  if (await isFile(directPath)) {
    return normalized
  }

  if (!normalized.startsWith('scripts/')) {
    const scriptsPath = join(hooksDir, 'scripts', normalized)
    if (await isFile(scriptsPath)) {
      return normalizeBundlePath(join('scripts', normalized))
    }
  }

  if (!normalized.includes('/') && !normalized.includes('\\')) {
    return script
  }

  throw new AspError(
    `Hook script not found: "${script}" (tried "${directPath}")`,
    'HOOK_SCRIPT_NOT_FOUND'
  )
}

// ============================================================================
// PiSdkAdapter Implementation
// ============================================================================

export class PiSdkAdapter implements HarnessAdapter {
  readonly id = 'pi-sdk' as const
  readonly name = 'Pi SDK'

  async detect(): Promise<HarnessDetection> {
    const sdkRoot = process.env['ASP_PI_SDK_ROOT']
    if (sdkRoot) {
      const entry = await resolveSdkEntry(sdkRoot)
      if (!entry) {
        return {
          available: false,
          error: `Pi SDK not found under ASP_PI_SDK_ROOT (${sdkRoot})`,
        }
      }

      return {
        available: true,
        version: 'dev',
        path: 'bun',
        capabilities: ['sdk'],
      }
    }

    try {
      await import('@mariozechner/pi-coding-agent')
      return {
        available: true,
        version: 'unknown',
        path: 'bun',
        capabilities: ['sdk'],
      }
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  validateSpace(_input: MaterializeSpaceInput): HarnessValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  async materializeSpace(
    input: MaterializeSpaceInput,
    cacheDir: string,
    options: MaterializeSpaceOptions
  ): Promise<MaterializeSpaceResult> {
    const warnings: string[] = []
    const files: string[] = []

    try {
      if (options.force) {
        await rm(cacheDir, { recursive: true, force: true })
      }
      await mkdir(cacheDir, { recursive: true })

      const manifestWithPi = input.manifest as typeof input.manifest & {
        pi?: {
          build?: {
            format?: 'esm' | 'cjs' | undefined
            target?: 'bun' | 'node' | undefined
            external?: string[] | undefined
          }
        }
      }
      const buildOpts: ExtensionBuildOptions = {
        format: manifestWithPi.pi?.build?.format,
        target: manifestWithPi.pi?.build?.target,
        external: manifestWithPi.pi?.build?.external,
      }

      const extensionsDir = join(cacheDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })

      const sourceExtensions = await discoverExtensions(input.snapshotPath)
      const spaceId = input.manifest.id

      for (const srcPath of sourceExtensions) {
        const srcBasename = basename(srcPath)
        const srcName = srcBasename.replace(/\.(ts|js)$/, '')
        const outName = `${spaceId}__${srcName}.js`
        const outPath = join(extensionsDir, outName)

        try {
          await bundleExtension(srcPath, outPath, buildOpts)
          files.push(`extensions/${outName}`)
        } catch (err) {
          if (err instanceof PiBundleError) {
            warnings.push(`Failed to bundle ${srcBasename}: ${err.stderr}`)
          } else {
            throw err
          }
        }
      }

      const srcSkillsDir = join(input.snapshotPath, 'skills')
      const destSkillsDir = join(cacheDir, 'skills')
      try {
        const skillsStats = await stat(srcSkillsDir)
        if (skillsStats.isDirectory()) {
          await copyDir(srcSkillsDir, destSkillsDir)
          const skillEntries = await readdir(destSkillsDir)
          for (const entry of skillEntries) {
            files.push(`skills/${entry}`)
          }
        }
      } catch {
        // Skills directory doesn't exist
      }

      const srcHooksDir = join(input.snapshotPath, 'hooks')
      const destHooksDir = join(cacheDir, 'hooks')
      try {
        const hooksStats = await stat(srcHooksDir)
        if (hooksStats.isDirectory()) {
          await copyDir(srcHooksDir, destHooksDir)
          const hookEntries = await readdir(destHooksDir)
          for (const entry of hookEntries) {
            files.push(`hooks/${entry}`)
          }
        }
      } catch {
        // Hooks directory doesn't exist
      }

      const contextDir = join(cacheDir, 'context')
      const instructionPath = await resolveInstructionFile(input.snapshotPath)
      if (instructionPath) {
        await mkdir(contextDir, { recursive: true })
        const contextName = `${spaceId}.md`
        const destPath = join(contextDir, contextName)
        await linkOrCopy(instructionPath, destPath)
        files.push(`context/${contextName}`)
      }

      return {
        artifactPath: cacheDir,
        files,
        warnings,
      }
    } catch (err) {
      await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  async composeTarget(
    input: ComposeTargetInput,
    outputDir: string,
    options: ComposeTargetOptions
  ): Promise<ComposeTargetResult> {
    const warnings: LockWarning[] = []

    if (options.clean) {
      await rm(outputDir, { recursive: true, force: true })
    }
    await mkdir(outputDir, { recursive: true })

    const extensionsDir = join(outputDir, 'extensions')
    const skillsDir = join(outputDir, 'skills')
    const hooksDir = join(outputDir, 'hooks')
    const contextDir = join(outputDir, 'context')

    await mkdir(extensionsDir, { recursive: true })
    await mkdir(skillsDir, { recursive: true })
    await mkdir(hooksDir, { recursive: true })
    await mkdir(contextDir, { recursive: true })

    const extensions: PiSdkBundleExtensionEntry[] = []
    const contextFiles: PiSdkBundleContextEntry[] = []
    const hooks: PiSdkBundleHookEntry[] = []

    for (const artifact of input.artifacts) {
      const srcExtDir = join(artifact.artifactPath, 'extensions')
      try {
        const stats = await stat(srcExtDir)
        if (stats.isDirectory()) {
          const entries = (await readdir(srcExtDir)).sort()
          for (const file of entries) {
            const srcPath = join(srcExtDir, file)
            const destPath = join(extensionsDir, file)
            await linkOrCopy(srcPath, destPath)
            extensions.push({
              spaceId: artifact.spaceId,
              path: normalizeBundlePath(join('extensions', file)),
            })
          }
        }
      } catch {
        // Extensions directory doesn't exist in this artifact
      }

      const srcSkillsDir = join(artifact.artifactPath, 'skills')
      try {
        const stats = await stat(srcSkillsDir)
        if (stats.isDirectory()) {
          const skillEntries = await readdir(srcSkillsDir, { withFileTypes: true })
          for (const entry of skillEntries) {
            if (entry.isDirectory()) {
              const srcPath = join(srcSkillsDir, entry.name)
              const destPath = join(skillsDir, entry.name)
              await copyDir(srcPath, destPath)
            }
          }
        }
      } catch {
        // Skills directory doesn't exist in this artifact
      }

      const srcHooksDir = join(artifact.artifactPath, 'hooks')
      try {
        const stats = await stat(srcHooksDir)
        if (stats.isDirectory()) {
          const destHooksDir = join(hooksDir, artifact.spaceId)
          await copyDir(srcHooksDir, destHooksDir)

          const hooksResult = await readHooksWithPrecedence(srcHooksDir)
          const filteredHooks = hooksResult.hooks.filter(
            (hook) => !hook.harness || hook.harness === 'pi-sdk'
          )

          for (const hook of filteredHooks) {
            const resolvedScript = await resolveHookScriptRelative(hook.script, srcHooksDir)
            let scriptPath = resolvedScript

            if (!/\s/.test(resolvedScript) && !isAbsolute(resolvedScript)) {
              scriptPath = normalizeBundlePath(join('hooks', artifact.spaceId, resolvedScript))
            }

            hooks.push({
              event: hook.event,
              script: scriptPath,
              tools: hook.tools,
              blocking: hook.blocking,
            })
          }
        }
      } catch {
        // Hooks directory doesn't exist in this artifact
      }

      const srcContextDir = join(artifact.artifactPath, 'context')
      try {
        const stats = await stat(srcContextDir)
        if (stats.isDirectory()) {
          const contextEntries = await readdir(srcContextDir, { withFileTypes: true })
          for (const entry of contextEntries) {
            if (entry.isFile()) {
              const srcPath = join(srcContextDir, entry.name)
              const destPath = join(contextDir, entry.name)
              await linkOrCopy(srcPath, destPath)
              contextFiles.push({
                spaceId: artifact.spaceId,
                path: normalizeBundlePath(join('context', entry.name)),
                label: `space:${artifact.spaceId} instructions`,
              })
            }
          }
        }
      } catch {
        // Context directory doesn't exist in this artifact
      }
    }

    let hasSkills = false
    try {
      const skillsEntries = await readdir(skillsDir)
      if (skillsEntries.length > 0) {
        hasSkills = true
      }
    } catch {
      // No skills
    }

    let hasHooks = false
    try {
      const hookEntries = await readdir(hooksDir)
      if (hookEntries.length > 0) {
        hasHooks = true
      }
    } catch {
      // No hooks
    }

    let hasContext = false
    try {
      const contextEntries = await readdir(contextDir)
      if (contextEntries.length > 0) {
        hasContext = true
      }
    } catch {
      // No context
    }

    const bundleManifest: PiSdkBundleManifest = {
      schemaVersion: 1,
      harnessId: 'pi-sdk',
      targetName: input.targetName,
      rootDir: outputDir,
      extensions,
      skillsDir: hasSkills ? 'skills' : undefined,
      contextFiles,
      hooks,
    }

    const manifestPath = join(outputDir, 'bundle.json')
    await writeFile(manifestPath, JSON.stringify(bundleManifest, null, 2))

    const bundle: ComposedTargetBundle = {
      harnessId: 'pi-sdk',
      targetName: input.targetName,
      rootDir: outputDir,
      piSdk: {
        bundleManifestPath: manifestPath,
        extensionsDir,
        skillsDir: hasSkills ? skillsDir : undefined,
        hooksDir: hasHooks ? hooksDir : undefined,
        contextDir: hasContext ? contextDir : undefined,
      },
    }

    return { bundle, warnings }
  }

  buildRunArgs(bundle: ComposedTargetBundle, options: HarnessRunOptions): string[] {
    if (!bundle.piSdk) {
      throw new AspError(
        'Pi SDK bundle is missing - cannot build run args',
        'PI_SDK_BUNDLE_MISSING'
      )
    }

    const args: string[] = [RUNNER_PATH]
    const bundleRoot = bundle.rootDir
    const projectPath = options.projectPath ?? bundle.rootDir
    const cwd = options.cwd ?? projectPath

    args.push('--bundle', bundleRoot, '--project', projectPath, '--cwd', cwd)

    const mode = options.interactive === false ? 'print' : 'interactive'
    args.push('--mode', mode)

    if (options.prompt) {
      args.push('--prompt', options.prompt)
    }

    if (options.model) {
      args.push('--model', options.model)
    }

    if (options.yolo) {
      args.push('--yolo')
    }

    const sdkRoot = process.env['ASP_PI_SDK_ROOT']
    if (sdkRoot) {
      args.push('--sdk-root', sdkRoot)
    }

    let hasExtensions = false
    try {
      const entries = readdirSync(bundle.piSdk.extensionsDir, { withFileTypes: true })
      hasExtensions = entries.some((entry) => entry.isFile() && entry.name.endsWith('.js'))
    } catch {
      // No extensions directory
    }

    if (!hasExtensions) {
      args.push('--no-extensions')
    }

    args.push('--no-skills')

    if (options.extraArgs) {
      args.push(...options.extraArgs)
    }

    return args
  }

  getTargetOutputPath(aspModulesDir: string, targetName: string): string {
    return join(aspModulesDir, targetName, 'pi-sdk')
  }
}

export const piSdkAdapter = new PiSdkAdapter()
