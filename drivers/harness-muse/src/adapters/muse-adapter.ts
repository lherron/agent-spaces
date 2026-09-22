/**
 * Muse CLI adapter (spike 11, T-08591, campaign P-00522).
 *
 * HarnessAdapter for `asp run --harness muse`. Composition reuses the
 * spike-1 composer (AGENTS.md concat, skills merge, settings.json staging);
 * execution maps onto `muse exec` — the headless one-shot CLI. Serve is
 * broker-owned and never spawned here: the CLI spawns and waits, so it needs
 * a command that runs a turn to completion itself.
 *
 * Writer-side flag mapping (live `muse exec --help`, muse 1.3.0):
 * - model → --model, reasoning effort → --reasoning-effort (native flags).
 * - yolo → --yolo (disables approval and sandbox, trusts the workspace).
 *   Finer approval control has NO valid exec mapping (no approval flag;
 *   permission profiles are named and unenumerated) → data-carried for the
 *   broker driver (MuseServeDriverSpec.approvalMode).
 * - Prompt separation: options.prompt is the MODEL-CALLED prompt (positional
 *   PROMPT); the echoed command (displayCommand) is rendered separately by
 *   run.ts — the two are never the same string.
 * - Images → repeatable --image.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ComposeTargetInput,
  ComposeTargetOptions,
  ComposeTargetResult,
  ComposedTargetBundle,
  HarnessAdapter,
  HarnessDetection,
  HarnessModelInfo,
  HarnessRunOptions,
  HarnessValidationResult,
  MaterializeSpaceInput,
  MaterializeSpaceOptions,
  MaterializeSpaceResult,
  McpConfig,
  ProjectManifest,
} from 'spaces-config'
import { copyDir } from 'spaces-config'
import { composeMuseWorkspace, loadMuseWorkspaceBundle } from '../composer.js'
import { detectMuse } from '../detect.js'
import { prepareMuseHome } from '../prepare-home.js'

const MUSE_INSTRUCTIONS_FILES = ['AGENTS.md', 'AGENT.md', 'instructions.md'] as const

function isDirectorySync(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Stable per-target HOME dir for CLI runs (session history survives). */
export function museCliHomeDir(bundleRootDir: string): string {
  return join(bundleRootDir, 'muse.home')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MuseAdapter implements HarnessAdapter {
  readonly id = 'muse' as const
  readonly name = 'Muse'
  /**
   * Model ids from the serve model catalog (meta provider, muse 1.3.0);
   * the -contributor variant is the catalog default. Bare ids match serve's
   * own modelId vocabulary and pass through to `muse exec --model` verbatim.
   */
  readonly models: HarnessModelInfo[] = [
    {
      id: 'muse-spark-1.3-contributor',
      name: 'Muse Spark 1.3 Contributor',
      default: true,
      identityKind: 'full',
    },
    { id: 'muse-spark-1.3', name: 'Muse Spark 1.3', identityKind: 'full' },
    { id: 'muse-spark-1.2-contributor', name: 'Muse Spark 1.2 Contributor', identityKind: 'full' },
    { id: 'muse-spark-1.2', name: 'Muse Spark 1.2', identityKind: 'full' },
  ]

  async detect(): Promise<HarnessDetection> {
    const detection = await detectMuse()
    if (!detection.available) {
      return { available: false, error: detection.error }
    }
    return {
      available: true,
      version: detection.version,
      path: detection.path,
      capabilities: ['serve', 'exec'],
    }
  }

  validateSpace(input: MaterializeSpaceInput): HarnessValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    const skillsDir = join(input.snapshotPath, 'skills')
    if (isDirectorySync(skillsDir)) {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!existsSync(join(skillsDir, entry.name, 'SKILL.md'))) {
          warnings.push(`Skill "${entry.name}" missing SKILL.md`)
        }
      }
    }

    const mcpPath = join(input.snapshotPath, 'mcp', 'mcp.json')
    if (existsSync(mcpPath)) {
      try {
        const parsed = JSON.parse(readFileSync(mcpPath, 'utf-8')) as McpConfig
        if (!parsed || typeof parsed !== 'object' || !parsed.mcpServers) {
          warnings.push('mcp.json is missing mcpServers')
        } else {
          for (const [name, server] of Object.entries(parsed.mcpServers)) {
            if (!server.command) warnings.push(`MCP server "${name}" missing command`)
            if (server.type !== 'stdio') {
              warnings.push(`MCP server "${name}" has unsupported type "${server.type}"`)
            }
          }
        }
      } catch (error) {
        warnings.push(`Failed to parse mcp.json: ${errorMessage(error)}`)
      }
    }

    return { valid: errors.length === 0, errors, warnings }
  }

  async materializeSpace(
    input: MaterializeSpaceInput,
    cacheDir: string,
    options: MaterializeSpaceOptions
  ): Promise<MaterializeSpaceResult> {
    const warnings: string[] = []
    const files: string[] = []
    const useHardlinks = options.useHardlinks !== false
    if (options.force) {
      await rm(cacheDir, { recursive: true, force: true })
    }
    await mkdir(cacheDir, { recursive: true })

    const srcSkillsDir = join(input.snapshotPath, 'skills')
    if (await isDirectory(srcSkillsDir)) {
      await copyDir(srcSkillsDir, join(cacheDir, 'skills'), { useHardlinks })
      for (const entry of await readdir(join(cacheDir, 'skills'))) {
        files.push(`skills/${entry}`)
      }
    }

    for (const filename of MUSE_INSTRUCTIONS_FILES) {
      const src = join(input.snapshotPath, filename)
      if (await fileExists(src)) {
        await copyFile(src, join(cacheDir, filename))
        files.push(filename)
        break
      }
    }

    const srcMcpDir = join(input.snapshotPath, 'mcp')
    if (await isDirectory(srcMcpDir)) {
      await copyDir(srcMcpDir, join(cacheDir, 'mcp'), { useHardlinks })
      files.push('mcp/mcp.json')
    }

    return { artifactPath: cacheDir, files, warnings }
  }

  async composeTarget(
    input: ComposeTargetInput,
    outputDir: string,
    options: ComposeTargetOptions
  ): Promise<ComposeTargetResult> {
    const { bundle, warnings } = await composeMuseWorkspace(
      {
        targetName: input.targetName,
        spaces: input.artifacts.map((artifact) => ({
          spaceId: artifact.spaceId,
          ...(artifact.pluginVersion !== undefined ? { version: artifact.pluginVersion } : {}),
          dir: artifact.artifactPath,
        })),
      },
      outputDir,
      options.clean === true ? { clean: true } : {}
    )

    const homeWarnings = await this.prepareCliHome(outputDir, bundle.skillsDir, input.targetName)

    return {
      bundle: {
        harnessId: this.id,
        targetName: input.targetName,
        rootDir: outputDir,
        pluginDirs: [bundle.workspaceDir],
        mcpConfigPath: bundle.settingsPath,
        muse: {
          workspaceDir: bundle.workspaceDir,
          agentsPath: bundle.agentsPath,
          skillsDir: bundle.skillsDir,
          settingsPath: bundle.settingsPath,
          manifestPath: bundle.manifestPath,
        },
      },
      warnings: [
        ...warnings.map((warning) => ({ code: warning.code, message: warning.message })),
        ...homeWarnings.map((message) => ({ code: 'W_HOME', message })),
      ],
    }
  }

  /**
   * Seed the stable CLI HOME (skills + auth, fingerprint-gated so session
   * history survives). Best-effort: warnings, never throws.
   */
  async prepareCliHome(
    bundleRootDir: string,
    skillsDir: string,
    targetName: string
  ): Promise<string[]> {
    try {
      const prepared = await prepareMuseHome(`cli-${targetName}`, {
        homeDir: museCliHomeDir(bundleRootDir),
        // Operator HOME: the CLI runs as the operator, so keychain-bound
        // oauth must keep resolving; sessions/skills stay in the stable
        // bundle home via the XDG dirs (T-08592).
        homeMode: 'operator',
        workspaceSkillsDir: skillsDir,
        reuse: true,
      })
      return prepared.warnings
    } catch (error) {
      return [`muse HOME prep failed: ${errorMessage(error)}`]
    }
  }

  buildRunArgs(bundle: ComposedTargetBundle, options: HarnessRunOptions): string[] {
    if (options.interactive === false) {
      return buildExecArgs(bundle, options)
    }
    if (options.continuationKey !== undefined) {
      return buildResumeArgs(options)
    }
    return buildInteractiveArgs(options)
  }

  getTargetOutputPath(aspModulesDir: string, targetName: string): string {
    return join(aspModulesDir, targetName, this.id)
  }

  async loadTargetBundle(outputDir: string, targetName: string): Promise<ComposedTargetBundle> {
    const bundle = await loadMuseWorkspaceBundle(outputDir, targetName)
    return {
      harnessId: 'muse',
      targetName,
      rootDir: outputDir,
      pluginDirs: [bundle.workspaceDir],
      mcpConfigPath: bundle.settingsPath,
      muse: {
        workspaceDir: bundle.workspaceDir,
        agentsPath: bundle.agentsPath,
        skillsDir: bundle.skillsDir,
        settingsPath: bundle.settingsPath,
        manifestPath: bundle.manifestPath,
      },
    }
  }

  getRunEnv(bundle: ComposedTargetBundle, _options: HarnessRunOptions): Record<string, string> {
    // Operator HOME: the CLI runs as the operator, so keychain-bound oauth
    // must keep resolving; skills/sessions live in the stable bundle home
    // via the XDG dirs (T-08592).
    const home = museCliHomeDir(bundle.rootDir)
    return {
      HOME: homedir(),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
    }
  }

  getDefaultRunOptions(manifest: ProjectManifest, targetName: string): Partial<HarnessRunOptions> {
    const target = manifest.targets[targetName]
    return {
      ...(target?.priming !== undefined ? { prompt: target.priming } : {}),
    }
  }
}

function buildExecArgs(bundle: ComposedTargetBundle, options: HarnessRunOptions): string[] {
  // Trusted by default: matches `serve --trust-workspace` so project rules
  // (AGENTS.md) and delegation load on the exec path too.
  const args = [
    'exec',
    '--trust-workspace',
    ...(options.yolo ? ['--yolo'] : []),
    '--workspace',
    options.cwd ?? options.projectPath ?? bundle.rootDir,
  ]
  if (options.model) {
    args.push('--model', options.model)
  }
  if (options.modelReasoningEffort) {
    args.push('--reasoning-effort', options.modelReasoningEffort)
  }
  for (const image of options.imageAttachments ?? []) {
    args.push('--image', image)
  }
  if (options.extraArgs) {
    args.push(...options.extraArgs)
  }
  if (options.prompt) {
    args.push(options.prompt)
  }
  return args
}

function buildResumeArgs(options: HarnessRunOptions): string[] {
  const key = options.continuationKey
  // TUI invocations operate in the target project, which is freshly
  // materialized for a broker launch. Trust it for this run so the initial
  // compiled prompt is not blocked behind Muse's interactive trust picker.
  const args = ['resume', '--trust-workspace', key === true ? '--last' : String(key)]
  if (options.extraArgs) {
    args.push(...options.extraArgs)
  }
  if (options.prompt) {
    throw new Error(
      'muse resume does not accept a prompt positional; omit the prompt when resuming'
    )
  }
  return args
}

function buildInteractiveArgs(options: HarnessRunOptions): string[] {
  // Match the exec and serve routes: the compiler owns this immutable launch
  // argv, so a runner cannot safely supply trust after dispatch.
  const args: string[] = ['--trust-workspace']
  if (options.yolo) {
    args.push('--yolo')
  }
  if (options.extraArgs) {
    args.push(...options.extraArgs)
  }
  if (options.prompt) {
    args.push(options.prompt)
  }
  return args
}

export const museAdapter = new MuseAdapter()
