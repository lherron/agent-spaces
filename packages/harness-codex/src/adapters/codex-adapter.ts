/**
 * CodexAdapter - Harness adapter for OpenAI Codex CLI
 *
 * Implements the HarnessAdapter interface for Codex, supporting:
 * - Space materialization into codex-friendly artifacts (skills, prompts, MCP, instructions)
 * - Target composition into a deterministic codex.home template
 * - CLI argument building for interactive/non-interactive runs
 */

import { spawn } from 'node:child_process'
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

const INSTRUCTIONS_FILES = ['AGENTS.md', 'AGENT.md'] as const
const DEFAULT_SANDBOX_MODE = 'workspace-write'
const DEFAULT_APPROVAL_POLICY = 'on-request'
const MIN_CODEX_VERSION = '0.1.0'
const CODEX_HOME_DIRNAME = 'codex.home'
const CODEX_CONFIG_FILE = 'config.toml'
const CODEX_AGENTS_FILE = 'AGENTS.md'
const CODEX_PROMPTS_DIR = 'prompts'
const CODEX_SKILLS_DIR = 'skills'

const SPACE_INSTRUCTIONS_FILE = 'instructions.md'
const SPACE_CODEX_CONFIG_FILE = 'codex.config.json'

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

function applyDottedKey(target: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const parts = dottedKey.split('.').filter(Boolean)
  if (parts.length === 0) {
    return
  }

  let cursor: Record<string, unknown> = target
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string
    const existing = cursor[part]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      cursor[part] = {}
    }
    cursor = cursor[part] as Record<string, unknown>
  }

  cursor[parts[parts.length - 1] as string] = value
}

function mergeCodexConfig(
  base: Record<string, unknown>,
  overrides: Array<Record<string, unknown>>
): Record<string, unknown> {
  const merged = { ...base }
  for (const override of overrides) {
    for (const [key, value] of Object.entries(override)) {
      applyDottedKey(merged, key, value)
    }
  }
  return merged
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

function buildCodexConfig(
  mcpConfig: McpConfig,
  overrides: Array<Record<string, unknown>>
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    sandbox_mode: DEFAULT_SANDBOX_MODE,
    approval_policy: DEFAULT_APPROVAL_POLICY,
    project_doc_fallback_filenames: ['AGENTS.md', 'AGENT.md'],
  }

  if (Object.keys(mcpConfig.mcpServers).length > 0) {
    const mcpServers: Record<string, unknown> = {}
    for (const [name, server] of Object.entries(mcpConfig.mcpServers)) {
      const entry: Record<string, unknown> = {
        command: server.command,
        enabled: true,
      }
      if (server.args && server.args.length > 0) {
        entry['args'] = server.args
      }
      if (server.env && Object.keys(server.env).length > 0) {
        entry['env'] = server.env
      }
      mcpServers[name] = entry
    }
    base['mcp_servers'] = mcpServers
  }

  return mergeCodexConfig(base, overrides)
}

function buildAgentsMarkdown(
  blocks: Array<{ spaceId: string; version: string; content: string }>
): string {
  const lines: string[] = ['<!-- Generated by agent-spaces. -->']

  for (const block of blocks) {
    lines.push('')
    lines.push(`<!-- BEGIN space: ${block.spaceId}@${block.version} -->`)
    lines.push(block.content.trimEnd())
    lines.push(`<!-- END space: ${block.spaceId}@${block.version} -->`)
  }

  lines.push('')
  return lines.join('\n')
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isVersionAtLeast(version: string, minVersion: string): boolean {
  const parsed = parseSemver(version)
  const min = parseSemver(minVersion)
  if (!parsed || !min) return false
  for (let i = 0; i < 3; i++) {
    const p = parsed[i]
    const m = min[i]
    if (p === undefined || m === undefined) return false
    if (p > m) return true
    if (p < m) return false
  }
  return true
}

interface BunSpawnOptions {
  stdout: 'pipe' | 'inherit' | 'ignore'
  stderr: 'pipe' | 'inherit' | 'ignore'
}

interface BunProcess {
  exited: Promise<number>
  stdout: ReadableStream
  stderr: ReadableStream
}

async function runCommand(args: string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const bun = (
    globalThis as { Bun?: { spawn: (args: string[], opts: BunSpawnOptions) => BunProcess } }
  ).Bun
  if (bun) {
    const proc = bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return { exitCode, stdout, stderr }
  }

  return await new Promise((resolve, reject) => {
    const proc = spawn(args[0] ?? '', args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr })
    })
  })
}

export class CodexAdapter implements HarnessAdapter {
  readonly id = 'codex' as const
  readonly name = 'OpenAI Codex'

  readonly models: HarnessModelInfo[] = [
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', default: true },
    { id: 'gpt-5.3', name: 'GPT-5.3' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
    { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.2', name: 'GPT-5.2' },
  ]

  async detect(): Promise<HarnessDetection> {
    try {
      const versionResult = await runCommand(['codex', '--version'])

      if (versionResult.exitCode !== 0) {
        throw new Error(
          versionResult.stderr.trim() || versionResult.stdout.trim() || 'codex --version failed'
        )
      }

      const versionOutput = versionResult.stdout.trim() || versionResult.stderr.trim()
      const match = versionOutput.match(/(\d+\.\d+\.\d+)/)
      const version = match?.[1] ?? (versionOutput || 'unknown')
      if (match && !isVersionAtLeast(version, MIN_CODEX_VERSION)) {
        throw new Error(`codex ${version} is below minimum ${MIN_CODEX_VERSION}`)
      }

      const helpResult = await runCommand(['codex', 'app-server', '--help'])
      if (helpResult.exitCode !== 0) {
        throw new Error(
          helpResult.stderr.trim() || helpResult.stdout.trim() || 'codex app-server --help failed'
        )
      }

      return {
        available: true,
        version,
        path: 'codex',
        capabilities: ['appServer'],
      }
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      }
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
        warnings.push(
          `Failed to parse mcp.json: ${error instanceof Error ? error.message : String(error)}`
        )
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
      const targetOverrides: Record<string, unknown> = {}
      if (input.codexOptions.model) {
        targetOverrides['model'] = input.codexOptions.model
      }
      if (input.codexOptions.approval_policy) {
        targetOverrides['approval_policy'] = input.codexOptions.approval_policy
      }
      if (input.codexOptions.sandbox_mode) {
        targetOverrides['sandbox_mode'] = input.codexOptions.sandbox_mode
      }
      if (input.codexOptions.profile) {
        targetOverrides['profile'] = input.codexOptions.profile
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

    const config = buildCodexConfig(mcpConfig, codexOverrides)
    const configPath = join(codexHome, CODEX_CONFIG_FILE)
    const configToml = TOML.stringify(config as TOML.JsonMap)
    await writeFile(configPath, `${configToml}\n`)

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
    const args: string[] = []
    const isExecMode = options.interactive === false
    const isResumeMode = !!options.resume
    const approvalPolicy = options.yolo ? 'never' : options.approvalPolicy
    const sandboxMode = options.yolo ? 'danger-full-access' : options.sandboxMode

    // Resume mode: codex resume [--last | session-id]
    if (isResumeMode) {
      args.push('resume')
      if (typeof options.resume === 'string') {
        // If a specific session ID is provided, use it
        // Codex resume takes session ID as positional arg or uses --last
        args.push(options.resume)
      }
      // If resume is just `true`, codex resume will open the picker
    } else if (isExecMode) {
      args.push('exec')
      if (options.prompt) {
        args.push(options.prompt)
      }
    } else if (options.prompt) {
      args.push(options.prompt)
    }

    if (options.model) {
      args.push('--model', options.model)
    }
    if (approvalPolicy) {
      // exec mode uses -c config override, interactive mode uses --ask-for-approval
      if (isExecMode) {
        args.push('-c', `approval_policy="${approvalPolicy}"`)
      } else {
        args.push('--ask-for-approval', approvalPolicy)
      }
    }
    if (sandboxMode) {
      args.push('--sandbox', sandboxMode)
    }
    if (options.profile) {
      args.push('--profile', options.profile)
    }

    if (options.extraArgs) {
      args.push(...options.extraArgs)
    }

    return args
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
      if (mcpStats.size > 2) {
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

  getRunEnv(bundle: ComposedTargetBundle, _options: HarnessRunOptions): Record<string, string> {
    return { CODEX_HOME: bundle.codex?.homeTemplatePath ?? bundle.rootDir }
  }

  getDefaultRunOptions(manifest: ProjectManifest, targetName: string): Partial<HarnessRunOptions> {
    const codexOptions = getEffectiveCodexOptions(manifest, targetName)
    const target = manifest.targets[targetName]

    const defaults: Partial<HarnessRunOptions> = {
      model: codexOptions.model,
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
