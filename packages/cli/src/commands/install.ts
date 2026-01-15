/**
 * Install command - Generate/update lock file and materialize to asp_modules.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { Command } from 'commander'

import { getClaudeCommand } from 'spaces-claude'
import { type ComposedTargetBundle, getEffectiveClaudeOptions, readTargetsToml } from 'spaces-core'
import { type HarnessId, harnessRegistry, install, isHarnessId } from 'spaces-engine'

import { findProjectRoot } from '../index.js'
import {
  blank,
  colors,
  commandBlock,
  createSpinner,
  error,
  formatDuration,
  formatPath,
  header,
  info,
  success,
  symbols,
} from '../ui.js'

/**
 * Validate harness option and return the harness ID.
 */
function validateHarness(harness: string | undefined): HarnessId {
  const harnessId = harness ?? 'claude'

  if (!isHarnessId(harnessId)) {
    blank()
    error(`Unknown harness "${harnessId}"`)
    console.log(colors.muted('Available harnesses:'))
    for (const adapter of harnessRegistry.getAll()) {
      console.log(colors.muted(`  - ${adapter.id}`))
    }
    blank()
    process.exit(1)
  }

  return harnessId
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function formatCommand(commandPath: string, args: string[]): string {
  return [shellQuote(commandPath), ...args.map(shellQuote)].join(' ')
}

async function buildPiBundle(
  outputPath: string,
  targetName: string
): Promise<ComposedTargetBundle> {
  const extensionsDir = join(outputPath, 'extensions')
  const skillsDir = join(outputPath, 'skills')
  const hookBridgePath = join(outputPath, 'asp-hooks.bridge.js')

  let skillsDirPath: string | undefined
  try {
    const entries = await readdir(skillsDir)
    if (entries.length > 0) {
      skillsDirPath = skillsDir
    }
  } catch {
    // No skills directory
  }

  let hookBridge: string | undefined
  try {
    const stats = await stat(hookBridgePath)
    if (stats.isFile()) {
      hookBridge = hookBridgePath
    }
  } catch {
    // No hook bridge
  }

  return {
    harnessId: 'pi',
    targetName,
    rootDir: outputPath,
    pi: {
      extensionsDir,
      skillsDir: skillsDirPath,
      hookBridgePath: hookBridge,
    },
  }
}

async function buildPiSdkBundle(
  outputPath: string,
  targetName: string
): Promise<ComposedTargetBundle> {
  const manifestPath = join(outputPath, 'bundle.json')
  let manifest: { harnessId?: string; schemaVersion?: number } | undefined

  try {
    const raw = await readFile(manifestPath, 'utf-8')
    manifest = JSON.parse(raw) as { harnessId?: string; schemaVersion?: number }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Pi SDK bundle manifest not found: ${manifestPath} (${message})`)
  }

  if (manifest?.harnessId !== 'pi-sdk') {
    throw new Error(`Unexpected Pi SDK bundle harness: ${manifest?.harnessId ?? 'unknown'}`)
  }

  const extensionsDir = join(outputPath, 'extensions')
  const skillsDir = join(outputPath, 'skills')
  const hooksDir = join(outputPath, 'hooks')
  const contextDir = join(outputPath, 'context')

  let skillsDirPath: string | undefined
  try {
    const entries = await readdir(skillsDir)
    if (entries.length > 0) {
      skillsDirPath = skillsDir
    }
  } catch {
    // No skills directory
  }

  let hooksDirPath: string | undefined
  try {
    const entries = await readdir(hooksDir)
    if (entries.length > 0) {
      hooksDirPath = hooksDir
    }
  } catch {
    // No hooks directory
  }

  let contextDirPath: string | undefined
  try {
    const entries = await readdir(contextDir)
    if (entries.length > 0) {
      contextDirPath = contextDir
    }
  } catch {
    // No context directory
  }

  return {
    harnessId: 'pi-sdk',
    targetName,
    rootDir: outputPath,
    piSdk: {
      bundleManifestPath: manifestPath,
      extensionsDir,
      skillsDir: skillsDirPath,
      hooksDir: hooksDirPath,
      contextDir: contextDirPath,
    },
  }
}

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Resolve targets and materialize to asp_modules/')
    .option('--targets <names...>', 'Specific targets to install')
    .option('--harness <id>', 'Coding agent harness to use (default: claude, e.g., pi, pi-sdk)')
    .option('--update', 'Update existing lock (re-resolve selectors)')
    .option('--refresh', 'Force re-copy from source (clear cache)')
    .option('--no-fetch', 'Skip fetching registry updates')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      // Validate harness option
      const _harness = validateHarness(options.harness)
      const harnessId = _harness
      const startTime = Date.now()

      // Find project root
      const projectPath = options.project ?? (await findProjectRoot())
      if (!projectPath) {
        blank()
        error('No asp-targets.toml found')
        console.log(colors.muted('  Run from a project directory or use --project'))
        blank()
        process.exit(1)
      }

      // Start spinner
      const spinner = createSpinner('Resolving dependencies...')
      spinner.start()

      try {
        const result = await install({
          projectPath,
          aspHome: options.aspHome,
          registryPath: options.registry,
          targets: options.targets,
          update: options.update,
          refresh: options.refresh,
          fetchRegistry: options.fetch !== false,
          harness: harnessId,
        })

        spinner.stop()
        const duration = Date.now() - startTime

        // Success header
        blank()
        success(
          `Installed ${result.resolvedTargets.length} target${result.resolvedTargets.length !== 1 ? 's' : ''} in ${formatDuration(duration)}`
        )

        // Lock file info
        info('lock', formatPath(result.lockPath))

        // Load manifest for claude options
        const manifestPath = `${projectPath}/asp-targets.toml`
        const manifest = await readTargetsToml(manifestPath)

        const adapter = harnessRegistry.getOrThrow(harnessId)
        let harnessPath: string = harnessId
        try {
          const detection = await adapter.detect()
          harnessPath = detection.path ?? harnessId
        } catch {
          // Harness may not be installed; fall back to id
        }

        // Each target
        header('Targets')

        for (const mat of result.materializations) {
          const claudeOptions = getEffectiveClaudeOptions(manifest, mat.target)

          // Generate command
          let command: string
          if (harnessId === 'claude') {
            try {
              command = await getClaudeCommand({
                pluginDirs: mat.pluginDirs,
                mcpConfig: mat.mcpConfigPath,
                settings: mat.settingsPath,
                settingSources: '',
                model: claudeOptions.model,
                permissionMode: claudeOptions.permission_mode,
                args: claudeOptions.args,
              })
            } catch {
              // Claude not installed - build a generic command
              const pluginArgs = mat.pluginDirs.map((d) => `--plugin-dir ${d}`).join(' ')
              command = `claude ${pluginArgs} --settings ${mat.settingsPath}`
            }
          } else {
            const bundle =
              harnessId === 'pi'
                ? await buildPiBundle(mat.outputPath, mat.target)
                : harnessId === 'pi-sdk'
                  ? await buildPiSdkBundle(mat.outputPath, mat.target)
                  : (() => {
                      throw new Error(`Unsupported harness: ${harnessId}`)
                    })()
            const args = adapter.buildRunArgs(bundle, {
              projectPath,
              extraArgs: undefined,
              model: claudeOptions.model,
            })
            command = formatCommand(harnessPath, args)
          }

          // Target display
          blank()
          console.log(`  ${symbols.pointer} ${colors.emphasis(mat.target)}`)
          console.log(
            `    ${colors.muted(`${mat.pluginDirs.length} plugin${mat.pluginDirs.length !== 1 ? 's' : ''}${mat.mcpConfigPath ? ' · mcp' : ''}`)}`
          )

          commandBlock('run', command)
        }

        blank()
      } catch (err) {
        spinner.stop()
        blank()
        error(err instanceof Error ? err.message : String(err))
        blank()
        process.exit(1)
      }
    })
}
