/**
 * CodexAdapter - Harness adapter for OpenAI Codex CLI
 *
 * Implements the HarnessAdapter interface for Codex, supporting:
 * - Space materialization into codex-friendly artifacts (skills, prompts, MCP, instructions)
 * - Target composition into a deterministic codex.home template
 * - CLI argument building for interactive/non-interactive runs
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import {
  constants,
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import TOML from '@iarna/toml'
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
  LockWarning,
  MaterializeSpaceInput,
  MaterializeSpaceOptions,
  MaterializeSpaceResult,
  ProjectManifest,
} from 'spaces-config'
import {
  type McpConfig,
  composeMcpFromSpaces,
  copyDir,
  getEffectiveCodexOptions,
  linkOrCopy,
} from 'spaces-config'
import { errorMessage } from '../errors.js'
import { CODEX_AGENTS_FILE, buildAgentsMarkdown } from './codex-agents.js'
import { DEFAULT_CODEX_CLI_MODEL, buildCodexConfig } from './codex-config.js'
import {
  CODEX_PATH_ENV,
  type CommandResult,
  codexCommandCandidates,
  isVersionAtLeast,
  runCommand,
} from './codex-discovery.js'
import { addCodexHookTrustState, buildHrcCodexHooksConfig } from './codex-hooks.js'

export { DEFAULT_CODEX_CLI_MODEL } from './codex-config.js'
export {
  CODEX_INTERACTIVE_HOOK_EVENTS,
  addCodexHookTrustState,
  buildCodexHookTrustState,
  buildHrcCodexHooksConfig,
  trustCodexHooksInConfigToml,
} from './codex-hooks.js'
export { applyPraesidiumContextToCodexHome } from './codex-agents.js'

const INSTRUCTIONS_FILES = ['AGENTS.md', 'AGENT.md'] as const
export const DEFAULT_CODEX_ENABLED_FEATURES = ['goals'] as const
const MIN_CODEX_VERSION = '0.124.0'
const CODEX_HOME_DIRNAME = 'codex.home'
const CODEX_CONFIG_FILE = 'config.toml'
const CODEX_HOOKS_FILE = 'hooks.json'
const CODEX_PROMPTS_DIR = 'prompts'
const CODEX_SKILLS_DIR = 'skills'

const SPACE_INSTRUCTIONS_FILE = 'instructions.md'
const SPACE_CODEX_CONFIG_FILE = 'codex.config.json'
/** A populated mcp.json serializes to more than `{}` (2 bytes). */
const MIN_MCP_CONFIG_BYTES = 2
type CodexOptionsWithStatusLine = ComposeTargetInput['codexOptions'] & {
  status_line?: string[] | undefined
}

export interface CodexAppServerLaunchDescriptor {
  prompt?: string | undefined
  resumeThreadId?: string | undefined
  model?: string | undefined
  modelReasoningEffort?: string | undefined
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | undefined
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
  profile?: string | undefined
  imageAttachments?: string[] | undefined
  featureFlags?: string[] | undefined
  extraArgs?: string[] | undefined
}

export function buildCodexAppServerLaunchDescriptor(
  options: HarnessRunOptions
): CodexAppServerLaunchDescriptor {
  const sandboxMode = options.yolo ? 'danger-full-access' : options.sandboxMode
  return {
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    ...(typeof options.continuationKey === 'string'
      ? { resumeThreadId: options.continuationKey }
      : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.modelReasoningEffort !== undefined
      ? { modelReasoningEffort: options.modelReasoningEffort }
      : {}),
    approvalPolicy: 'never',
    ...(sandboxMode !== undefined ? { sandboxMode } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.imageAttachments !== undefined
      ? { imageAttachments: options.imageAttachments }
      : {}),
    featureFlags: [...(options.featureFlags ?? DEFAULT_CODEX_ENABLED_FEATURES)],
    ...(options.extraArgs !== undefined ? { extraArgs: options.extraArgs } : {}),
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory()
  } catch {
    return false
  }
}

function isDirectorySync(path: string): boolean {
  try {
    const stats = statSync(path)
    return stats.isDirectory()
  } catch {
    return false
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  const content = `${JSON.stringify(data, null, 2)}\n`
  await writeFile(path, content)
}

async function readInstructionsFromSpace(
  snapshotPath: string
): Promise<{ source: string; content: string } | null> {
  for (const filename of INSTRUCTIONS_FILES) {
    const path = join(snapshotPath, filename)
    if (await fileExists(path)) {
      const content = await readFile(path, 'utf-8')
      return { source: filename, content }
    }
  }
  return null
}

async function readCodexConfigOverrides(
  artifactPath: string
): Promise<Record<string, unknown> | null> {
  const configPath = join(artifactPath, SPACE_CODEX_CONFIG_FILE)
  if (!(await fileExists(configPath))) {
    return null
  }
  const content = await readFile(configPath, 'utf-8')
  const parsed = JSON.parse(content) as Record<string, unknown>
  return parsed
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Probe a single codex binary candidate: verify it runs, meets the minimum
 * version, and exposes `app-server`. Returns the detection on success or a
 * human-readable failure reason (never throws) so the caller can attribute a
 * "not detected" result to the actual cause.
 */
async function probeCodexCandidate(
  candidate: string
): Promise<{ detection: HarnessDetection } | { error: string }> {
  let versionResult: CommandResult
  try {
    versionResult = await runCommand([candidate, '--version'])
  } catch (error) {
    return { error: errorMessage(error) }
  }
  if (versionResult.exitCode !== 0) {
    return {
      error: versionResult.stderr.trim() || versionResult.stdout.trim() || 'codex --version failed',
    }
  }

  const versionOutput = versionResult.stdout.trim() || versionResult.stderr.trim()
  const match = versionOutput.match(/(\d+\.\d+\.\d+)/)
  const version = match?.[1] ?? (versionOutput || 'unknown')
  if (!match || !isVersionAtLeast(version, MIN_CODEX_VERSION)) {
    return { error: `codex ${version} is below minimum ${MIN_CODEX_VERSION}` }
  }

  let helpResult: CommandResult
  try {
    helpResult = await runCommand([candidate, 'app-server', '--help'])
  } catch (error) {
    return { error: errorMessage(error) }
  }
  if (helpResult.exitCode !== 0) {
    return {
      error:
        helpResult.stderr.trim() || helpResult.stdout.trim() || 'codex app-server --help failed',
    }
  }

  return {
    detection: {
      available: true,
      version,
      path: candidate,
      capabilities: ['appServer'],
    },
  }
}

function appendDefaultFeatureFlags(args: string[], options: HarnessRunOptions): void {
  for (const feature of options.featureFlags ?? DEFAULT_CODEX_ENABLED_FEATURES) {
    args.push('--enable', feature)
  }
}

/** Non-interactive (headless) launch: `codex app-server` over JSON-RPC. */
function buildExecArgs(options: HarnessRunOptions): string[] {
  const args: string[] = []
  if (options.profile) {
    args.push('-c', `profile="${options.profile}"`)
  }
  appendDefaultFeatureFlags(args, options)
  args.push('app-server')
  if (options.extraArgs) {
    args.push(...options.extraArgs)
  }
  return args
}

/** Flags shared by every interactive (TUI) launch mode. */
function appendInteractiveCommonFlags(args: string[], options: HarnessRunOptions): void {
  const approvalPolicy = options.yolo ? 'never' : options.approvalPolicy
  const sandboxMode = options.yolo ? 'danger-full-access' : options.sandboxMode

  if (options.model) {
    args.push('--model', options.model)
  }
  if (options.modelReasoningEffort) {
    args.push('-c', `model_reasoning_effort="${options.modelReasoningEffort}"`)
  }
  if (approvalPolicy) {
    args.push('--ask-for-approval', approvalPolicy)
  }
  if (sandboxMode) {
    args.push('--sandbox', sandboxMode)
  }
  // codex-cli >=0.135.0 gates hook execution behind a persisted hook-trust
  // store; the broker materializes & vets the Stop hook itself (the sole
  // trigger for the codex-cli-tmux transcript reader), so the pre-seeded
  // `trusted_hash` no longer satisfies codex and the hook is silently
  // skipped — yielding zero events on cold start (T-01798). The broker is
  // the trusted hook source, exactly the documented use of the bypass flag.
  // Interactive-only: the headless path runs `codex app-server` over
  // JSON-RPC and gets events natively, never via TUI hooks.
  args.push('--dangerously-bypass-hook-trust')
  if (options.profile) {
    args.push('--profile', options.profile)
  }

  if (options.imageAttachments && options.imageAttachments.length > 0) {
    for (const imagePath of options.imageAttachments) {
      args.push('-i', imagePath)
    }
  }

  if (options.extraArgs) {
    args.push(...options.extraArgs)
  }
}

/** Interactive resume: `codex resume [session-id] [prompt]`. */
function buildResumeArgs(options: HarnessRunOptions): string[] {
  const args: string[] = []
  args.push('resume')
  appendDefaultFeatureFlags(args, options)
  if (typeof options.continuationKey === 'string') {
    args.push(options.continuationKey)
  }
  if (options.prompt) {
    args.push(options.prompt)
  }
  appendInteractiveCommonFlags(args, options)
  return args
}

/** Fresh interactive launch: `codex [prompt]`. */
function buildInteractiveArgs(options: HarnessRunOptions): string[] {
  const args: string[] = []
  appendDefaultFeatureFlags(args, options)
  if (options.prompt) {
    args.push(options.prompt)
  }
  appendInteractiveCommonFlags(args, options)
  return args
}

export class CodexAdapter implements HarnessAdapter {
  readonly id = 'codex' as const
  readonly name = 'OpenAI Codex'

  readonly models: HarnessModelInfo[] = [
    { id: DEFAULT_CODEX_CLI_MODEL, name: 'GPT-5.5', default: true },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    { id: 'gpt-5.3', name: 'GPT-5.3' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
    { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.2', name: 'GPT-5.2' },
  ]

  async detect(): Promise<HarnessDetection> {
    const errors: string[] = []
    for (const candidate of codexCommandCandidates()) {
      if (!existsSync(candidate)) {
        continue
      }

      const probe = await probeCodexCandidate(candidate)
      if ('detection' in probe) {
        return probe.detection
      }
      // Surface the real reason this otherwise-present binary failed instead of
      // silently reporting "not detected" (e.g. permission denied, crash,
      // below-minimum version).
      errors.push(`${candidate}: ${probe.error}`)
    }

    return {
      available: false,
      error:
        errors.length > 0
          ? errors.join('; ')
          : `codex not found on PATH, ${CODEX_PATH_ENV}, or common user install paths`,
    }
  }

  validateSpace(input: MaterializeSpaceInput): HarnessValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    const codexConfig = input.manifest.codex
    const skillsEnabled = codexConfig?.skills?.enabled !== false

    if (skillsEnabled) {
      const skillsDir = join(input.snapshotPath, CODEX_SKILLS_DIR)
      if (isDirectorySync(skillsDir)) {
        // Check that each skill directory has SKILL.md
        const entries = readdirSync(skillsDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const skillPath = join(skillsDir, entry.name, 'SKILL.md')
          if (!existsSync(skillPath)) {
            warnings.push(`Skill "${entry.name}" missing SKILL.md`)
          }
        }
      }
    }

    const mcpPath = join(input.snapshotPath, 'mcp', 'mcp.json')
    if (existsSync(mcpPath)) {
      try {
        const raw = readFileSync(mcpPath, 'utf-8')
        const parsed = JSON.parse(raw) as McpConfig
        if (!parsed || typeof parsed !== 'object' || !parsed.mcpServers) {
          warnings.push('mcp.json is missing mcpServers')
        } else {
          for (const [name, server] of Object.entries(parsed.mcpServers)) {
            if (!server.command) {
              warnings.push(`MCP server "${name}" missing command`)
            }
            if (server.type !== 'stdio') {
              warnings.push(`MCP server "${name}" has unsupported type "${server.type}"`)
            }
          }
        }
      } catch (error) {
        warnings.push(`Failed to parse mcp.json: ${errorMessage(error)}`)
      }
    }

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
    const useHardlinks = options.useHardlinks !== false

    try {
      if (options.force) {
        await rm(cacheDir, { recursive: true, force: true })
      }
      await mkdir(cacheDir, { recursive: true })

      const codexConfig = input.manifest.codex
      const skillsEnabled = codexConfig?.skills?.enabled !== false
      const promptsEnabled = codexConfig?.prompts?.enabled !== false

      if (skillsEnabled) {
        const srcSkillsDir = join(input.snapshotPath, CODEX_SKILLS_DIR)
        if (await isDirectory(srcSkillsDir)) {
          const destSkillsDir = join(cacheDir, CODEX_SKILLS_DIR)
          await copyDir(srcSkillsDir, destSkillsDir, { useHardlinks })
          const entries = await readdir(destSkillsDir)
          for (const entry of entries) {
            files.push(`${CODEX_SKILLS_DIR}/${entry}`)
          }
        }
      }

      if (promptsEnabled) {
        const srcCommandsDir = join(input.snapshotPath, 'commands')
        if (await isDirectory(srcCommandsDir)) {
          const destPromptsDir = join(cacheDir, CODEX_PROMPTS_DIR)
          await mkdir(destPromptsDir, { recursive: true })
          const entries = await readdir(srcCommandsDir, { withFileTypes: true })
          for (const entry of entries) {
            if (!entry.isFile()) continue
            if (!entry.name.endsWith('.md')) continue
            const srcPath = join(srcCommandsDir, entry.name)
            const destPath = join(destPromptsDir, entry.name)
            if (useHardlinks) {
              await linkOrCopy(srcPath, destPath)
            } else {
              await writeFile(destPath, await readFile(srcPath))
            }
            files.push(`${CODEX_PROMPTS_DIR}/${entry.name}`)
          }
        }
      }

      const mcpSrc = join(input.snapshotPath, 'mcp', 'mcp.json')
      if (await fileExists(mcpSrc)) {
        const mcpDestDir = join(cacheDir, 'mcp')
        await mkdir(mcpDestDir, { recursive: true })
        const mcpDest = join(mcpDestDir, 'mcp.json')
        if (useHardlinks) {
          await linkOrCopy(mcpSrc, mcpDest)
        } else {
          await writeFile(mcpDest, await readFile(mcpSrc))
        }
        files.push('mcp/mcp.json')
      }

      const instructions = await readInstructionsFromSpace(input.snapshotPath)
      if (instructions) {
        const destPath = join(cacheDir, SPACE_INSTRUCTIONS_FILE)
        if (useHardlinks) {
          await linkOrCopy(join(input.snapshotPath, instructions.source), destPath)
        } else {
          await writeFile(destPath, instructions.content)
        }
        files.push(SPACE_INSTRUCTIONS_FILE)
      }

      if (codexConfig?.config && Object.keys(codexConfig.config).length > 0) {
        const destPath = join(cacheDir, SPACE_CODEX_CONFIG_FILE)
        await writeJson(destPath, codexConfig.config)
        files.push(SPACE_CODEX_CONFIG_FILE)
      }

      return {
        artifactPath: cacheDir,
        files,
        warnings,
      }
    } catch (error) {
      await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
      throw error
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

    const codexHome = join(outputDir, CODEX_HOME_DIRNAME)
    const skillsDir = join(codexHome, CODEX_SKILLS_DIR)
    const promptsDir = join(codexHome, CODEX_PROMPTS_DIR)

    await mkdir(codexHome, { recursive: true })
    await mkdir(skillsDir, { recursive: true })
    await mkdir(promptsDir, { recursive: true })

    const instructionsBlocks: Array<{ spaceId: string; version: string; content: string }> = []
    const instructionsHashes: Array<{ spaceId: string; version: string; hash: string }> = []
    const codexOverrides: Array<Record<string, unknown>> = []
    const mergedSkills = new Set<string>()
    const mergedPrompts = new Set<string>()

    for (const artifact of input.artifacts) {
      const srcSkillsDir = join(artifact.artifactPath, CODEX_SKILLS_DIR)
      if (await isDirectory(srcSkillsDir)) {
        const entries = await readdir(srcSkillsDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const srcPath = join(srcSkillsDir, entry.name)
          const destPath = join(skillsDir, entry.name)
          await rm(destPath, { recursive: true, force: true })
          await copyDir(srcPath, destPath, { useHardlinks: true })
          mergedSkills.add(entry.name)
        }
      }

      const srcPromptsDir = join(artifact.artifactPath, CODEX_PROMPTS_DIR)
      if (await isDirectory(srcPromptsDir)) {
        const entries = await readdir(srcPromptsDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile()) continue
          if (!entry.name.endsWith('.md')) continue
          const srcPath = join(srcPromptsDir, entry.name)
          const destPath = join(promptsDir, entry.name)
          await rm(destPath, { force: true })
          await linkOrCopy(srcPath, destPath)
          mergedPrompts.add(entry.name)
        }
      }

      const instructionsPath = join(artifact.artifactPath, SPACE_INSTRUCTIONS_FILE)
      if (await fileExists(instructionsPath)) {
        const content = await readFile(instructionsPath, 'utf-8')
        const version = artifact.pluginVersion ?? 'unknown'
        instructionsBlocks.push({ spaceId: artifact.spaceId, version, content })
        instructionsHashes.push({ spaceId: artifact.spaceId, version, hash: hashContent(content) })
      }

      const overrides = await readCodexConfigOverrides(artifact.artifactPath)
      if (overrides) {
        codexOverrides.push(overrides)
      }
    }

    if (input.codexOptions) {
      const codexOptions = input.codexOptions as CodexOptionsWithStatusLine
      const targetOverrides: Record<string, unknown> = {}
      if (codexOptions.model) {
        targetOverrides['model'] = codexOptions.model
      }
      if (codexOptions.model_reasoning_effort) {
        targetOverrides['model_reasoning_effort'] = codexOptions.model_reasoning_effort
      }
      if (codexOptions.status_line) {
        targetOverrides['tui.status_line'] = codexOptions.status_line
      }
      if (codexOptions.approval_policy) {
        targetOverrides['approval_policy'] = codexOptions.approval_policy
      }
      if (codexOptions.sandbox_mode) {
        targetOverrides['sandbox_mode'] = codexOptions.sandbox_mode
      }
      if (codexOptions.profile) {
        targetOverrides['profile'] = codexOptions.profile
      }
      if (Object.keys(targetOverrides).length > 0) {
        codexOverrides.push(targetOverrides)
      }
    }

    const agentsPath = join(codexHome, CODEX_AGENTS_FILE)
    await writeFile(agentsPath, buildAgentsMarkdown(instructionsBlocks))

    const mcpOutputPath = join(codexHome, 'mcp.json')
    const spacesForMcp = input.artifacts.map((artifact) => ({
      spaceId: artifact.spaceId,
      dir: artifact.artifactPath,
    }))
    const { config: mcpConfig, warnings: mcpWarnings } = await composeMcpFromSpaces(
      spacesForMcp,
      mcpOutputPath
    )
    for (const warning of mcpWarnings) {
      warnings.push({ code: 'W_MCP', message: warning })
    }

    const hooksPath = join(codexHome, CODEX_HOOKS_FILE)
    const hooksConfig = buildHrcCodexHooksConfig()
    const config = addCodexHookTrustState(
      buildCodexConfig(mcpConfig, codexOverrides),
      hooksPath,
      hooksConfig
    )
    const configPath = join(codexHome, CODEX_CONFIG_FILE)
    const configToml = TOML.stringify(config as TOML.JsonMap)
    await writeFile(configPath, `${configToml}\n`)

    await writeJson(hooksPath, hooksConfig)

    // Symlink auth.json from user's ~/.codex if it exists so OAuth credentials are available
    const userCodexHome = join(homedir(), '.codex')
    const userAuthPath = join(userCodexHome, 'auth.json')
    const destAuthPath = join(codexHome, 'auth.json')
    try {
      await rm(destAuthPath, { force: true })
      if (existsSync(userAuthPath)) {
        await symlink(userAuthPath, destAuthPath)
      }
    } catch {
      // Ignore symlink failures (e.g., Windows without privileges)
    }

    const manifestPath = join(codexHome, 'manifest.json')
    await writeJson(manifestPath, {
      schemaVersion: 1,
      harnessId: 'codex',
      targetName: input.targetName,
      generatedAt: new Date().toISOString(),
      spaces: input.artifacts.map((artifact) => ({
        spaceId: artifact.spaceId,
        spaceKey: artifact.spaceKey,
        version: artifact.pluginVersion ?? 'unknown',
      })),
      skills: Array.from(mergedSkills).sort(),
      prompts: Array.from(mergedPrompts).sort(),
      mcpServers: Object.keys(mcpConfig.mcpServers).sort(),
      instructions: instructionsHashes,
    })

    const hasMcp = Object.keys(mcpConfig.mcpServers).length > 0
    const bundle: ComposedTargetBundle = {
      harnessId: this.id,
      targetName: input.targetName,
      rootDir: outputDir,
      pluginDirs: [codexHome],
      mcpConfigPath: hasMcp ? mcpOutputPath : undefined,
      codex: {
        homeTemplatePath: codexHome,
        configPath,
        agentsPath,
        skillsDir,
        promptsDir,
      },
    }

    return {
      bundle,
      warnings,
    }
  }

  buildRunArgs(_bundle: ComposedTargetBundle, options: HarnessRunOptions): string[] {
    if (options.interactive === false) {
      return buildExecArgs(options)
    }
    if (options.continuationKey) {
      return buildResumeArgs(options)
    }
    return buildInteractiveArgs(options)
  }

  getTargetOutputPath(aspModulesDir: string, targetName: string): string {
    return join(aspModulesDir, targetName, this.id)
  }

  async loadTargetBundle(outputDir: string, targetName: string): Promise<ComposedTargetBundle> {
    const codexHome = join(outputDir, CODEX_HOME_DIRNAME)
    const configPath = join(codexHome, CODEX_CONFIG_FILE)
    const agentsPath = join(codexHome, CODEX_AGENTS_FILE)
    const skillsDir = join(codexHome, CODEX_SKILLS_DIR)
    const promptsDir = join(codexHome, CODEX_PROMPTS_DIR)
    const mcpPath = join(codexHome, 'mcp.json')

    const homeStats = await stat(codexHome)
    if (!homeStats.isDirectory()) {
      throw new Error(`Codex home directory not found: ${codexHome}`)
    }

    const configStats = await stat(configPath)
    if (!configStats.isFile()) {
      throw new Error(`Codex config.toml not found: ${configPath}`)
    }

    const agentsStats = await stat(agentsPath)
    if (!agentsStats.isFile()) {
      throw new Error(`Codex AGENTS.md not found: ${agentsPath}`)
    }

    let mcpConfigPath: string | undefined
    try {
      const mcpStats = await stat(mcpPath)
      if (mcpStats.size > MIN_MCP_CONFIG_BYTES) {
        mcpConfigPath = mcpPath
      }
    } catch {
      // MCP config is optional
    }

    return {
      harnessId: 'codex',
      targetName,
      rootDir: outputDir,
      pluginDirs: [codexHome],
      mcpConfigPath,
      codex: {
        homeTemplatePath: codexHome,
        configPath,
        agentsPath,
        skillsDir,
        promptsDir,
      },
    }
  }

  getRunEnv(bundle: ComposedTargetBundle, options: HarnessRunOptions): Record<string, string> {
    return { CODEX_HOME: options.codexHomeDir ?? bundle.codex?.homeTemplatePath ?? bundle.rootDir }
  }

  getDefaultRunOptions(manifest: ProjectManifest, targetName: string): Partial<HarnessRunOptions> {
    const codexOptions = getEffectiveCodexOptions(manifest, targetName)
    const target = manifest.targets[targetName]

    const defaults: Partial<HarnessRunOptions> = {
      model: codexOptions.model,
      modelReasoningEffort: codexOptions.model_reasoning_effort,
      approvalPolicy: codexOptions.approval_policy,
      sandboxMode: codexOptions.sandbox_mode,
      profile: codexOptions.profile,
      prompt: target?.priming_prompt,
    }

    if (target?.yolo) {
      defaults.approvalPolicy = 'never'
      defaults.sandboxMode = 'danger-full-access'
    }

    return defaults
  }
}

export const codexAdapter = new CodexAdapter()
