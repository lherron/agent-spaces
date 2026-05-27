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
import { delimiter, join, resolve } from 'node:path'
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
const DEFAULT_CODEX_CLI_MODEL = 'gpt-5.5'
export const DEFAULT_CODEX_ENABLED_FEATURES = ['goals'] as const
const MIN_CODEX_VERSION = '0.124.0'
const CODEX_PATH_ENV = 'ASP_CODEX_PATH'
const CODEX_SKIP_COMMON_PATHS_ENV = 'ASP_CODEX_SKIP_COMMON_PATHS'
const CODEX_HOME_DIRNAME = 'codex.home'
const CODEX_CONFIG_FILE = 'config.toml'
const CODEX_HOOKS_FILE = 'hooks.json'
const CODEX_AGENTS_FILE = 'AGENTS.md'
const CODEX_PROMPTS_DIR = 'prompts'
const CODEX_SKILLS_DIR = 'skills'

const SPACE_INSTRUCTIONS_FILE = 'instructions.md'
const SPACE_CODEX_CONFIG_FILE = 'codex.config.json'
const DEFAULT_TUI_STATUS_LINE = ['model-with-reasoning', 'context-remaining', 'current-dir']
const CODEX_HOOK_EVENT_KEY_LABELS: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
}
const CODEX_HOOK_EVENTS_WITH_MATCHERS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
])
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

function ensureHooksFeature(config: Record<string, unknown>): Record<string, unknown> {
  const features =
    config['features'] &&
    typeof config['features'] === 'object' &&
    !Array.isArray(config['features'])
      ? { ...(config['features'] as Record<string, unknown>) }
      : {}

  features['hooks'] = true
  return {
    ...config,
    features,
  }
}

/** Shared HRC capture command: invokes the launch hook CLI when HRC wires one in. */
const HRC_CODEX_HOOK_COMMAND =
  'if [ -n "${HRC_LAUNCH_HOOK_CLI:-}" ]; then bun "$HRC_LAUNCH_HOOK_CLI"; fi'

/**
 * Lifecycle events the interactive (codex-cli-tmux) broker driver needs to
 * normalize a turn. The headless codex-app-server path only needs `Stop` (turn
 * completion), which stays the default so existing materialization is unchanged.
 */
export const CODEX_INTERACTIVE_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
] as const

function buildCodexHookGroup(eventName: string): Record<string, unknown> {
  const statusMessage =
    eventName === 'Stop' ? 'capturing Codex turn' : `capturing Codex ${eventName}`
  const handler = { type: 'command', command: HRC_CODEX_HOOK_COMMAND, statusMessage }
  // Matcher-bearing events take a group-level matcher; "" = match all tools.
  return CODEX_HOOK_EVENTS_WITH_MATCHERS.has(eventName)
    ? { matcher: '', hooks: [handler] }
    : { hooks: [handler] }
}

/**
 * Build the HRC codex hooks.json. Defaults to `Stop`-only (headless turn capture,
 * unchanged behavior); pass the full lifecycle event list to capture every event
 * the interactive broker driver normalizes.
 */
export function buildHrcCodexHooksConfig(
  events: readonly string[] = ['Stop']
): Record<string, unknown> {
  const hooks: Record<string, unknown> = {}
  for (const eventName of events) {
    hooks[eventName] = [buildCodexHookGroup(eventName)]
  }
  return { hooks }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson)
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const entry = value[key]
      if (entry !== undefined) {
        sorted[key] = canonicalJson(entry)
      }
    }
    return sorted
  }
  return value
}

function versionForCodexTomlValue(value: Record<string, unknown>): string {
  const serialized = JSON.stringify(canonicalJson(value))
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
}

function normalizedCodexHookHash(
  eventLabel: string,
  matcher: string | undefined,
  handler: Record<string, unknown>
): string {
  const identity: Record<string, unknown> = {
    event_name: eventLabel,
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [handler],
  }
  return versionForCodexTomlValue(identity)
}

function normalizedTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 600
  }
  return Math.max(1, Math.trunc(value))
}

export function buildCodexHookTrustState(
  hooksPath: string,
  hooksConfig: Record<string, unknown>
): Record<string, { trusted_hash: string }> {
  const root = isRecord(hooksConfig['hooks']) ? hooksConfig['hooks'] : {}
  const trustedState: Record<string, { trusted_hash: string }> = {}
  const keySource = resolve(hooksPath)

  for (const [eventName, eventLabel] of Object.entries(CODEX_HOOK_EVENT_KEY_LABELS)) {
    const groups = root[eventName]
    if (!Array.isArray(groups)) continue

    for (const [groupIndex, groupValue] of groups.entries()) {
      if (!isRecord(groupValue)) continue
      const matcher =
        CODEX_HOOK_EVENTS_WITH_MATCHERS.has(eventName) && typeof groupValue['matcher'] === 'string'
          ? groupValue['matcher']
          : undefined
      const handlers = groupValue['hooks']
      if (!Array.isArray(handlers)) continue

      for (const [handlerIndex, handlerValue] of handlers.entries()) {
        if (!isRecord(handlerValue)) continue
        if (handlerValue['type'] !== 'command') continue
        if (handlerValue['async'] === true) continue
        const command = handlerValue['command']
        if (typeof command !== 'string' || command.trim() === '') continue

        const normalizedHandler: Record<string, unknown> = {
          type: 'command',
          command,
          timeout: normalizedTimeout(handlerValue['timeout']),
          async: false,
          ...(typeof handlerValue['statusMessage'] === 'string'
            ? { statusMessage: handlerValue['statusMessage'] }
            : {}),
        }
        const key = `${keySource}:${eventLabel}:${groupIndex}:${handlerIndex}`
        trustedState[key] = {
          trusted_hash: normalizedCodexHookHash(eventLabel, matcher, normalizedHandler),
        }
      }
    }
  }

  return trustedState
}

export function addCodexHookTrustState(
  config: Record<string, unknown>,
  hooksPath: string,
  hooksConfig: Record<string, unknown>,
  options: { replaceHooksPaths?: string[] } = {}
): Record<string, unknown> {
  const trustState = buildCodexHookTrustState(hooksPath, hooksConfig)
  if (Object.keys(trustState).length === 0) {
    return config
  }

  const hooks = isRecord(config['hooks']) ? { ...config['hooks'] } : {}
  const state = isRecord(hooks['state']) ? { ...hooks['state'] } : {}
  const keySource = resolve(hooksPath)
  for (const staleHooksPath of options.replaceHooksPaths ?? []) {
    const staleKeySource = resolve(staleHooksPath)
    for (const key of Object.keys(trustState)) {
      const suffix = key.slice(keySource.length)
      delete state[`${staleKeySource}${suffix}`]
    }
  }

  for (const [key, value] of Object.entries(trustState)) {
    const existing = isRecord(state[key]) ? state[key] : {}
    state[key] = { ...existing, ...value }
  }

  return {
    ...config,
    hooks: {
      ...hooks,
      state,
    },
  }
}

export function trustCodexHooksInConfigToml(
  configToml: string,
  hooksPath: string,
  hooksJson: string,
  options: { replaceHooksPaths?: string[] } = {}
): string {
  const hooksConfig = JSON.parse(hooksJson) as Record<string, unknown>
  const parsed = TOML.parse(configToml) as Record<string, unknown>
  const updated = addCodexHookTrustState(parsed, hooksPath, hooksConfig, options)
  if (updated === parsed) {
    return configToml
  }
  return `${TOML.stringify(updated as TOML.JsonMap)}\n`
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
    model: DEFAULT_CODEX_CLI_MODEL,
    sandbox_mode: DEFAULT_SANDBOX_MODE,
    approval_policy: DEFAULT_APPROVAL_POLICY,
    project_doc_fallback_filenames: ['AGENTS.md', 'AGENT.md'],
    tui: {
      status_line: DEFAULT_TUI_STATUS_LINE,
    },
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

  return ensureHooksFeature(mergeCodexConfig(base, overrides))
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

const PRAESIDIUM_BEGIN_MARKER = '<!-- BEGIN praesidium-context -->'
const PRAESIDIUM_END_MARKER = '<!-- END praesidium-context -->'

/**
 * Write praesidium-materialized system prompt + reminder content into a runtime
 * codex home's AGENTS.md so codex picks it up via its native user_instructions
 * load path. Replaces any existing praesidium-context block on each call so
 * repeated runs don't accumulate stale content.
 *
 * Codex's base_instructions are not touched — this only adds to the
 * AGENTS.md that becomes config.user_instructions inside codex.
 */
export async function applyPraesidiumContextToCodexHome(
  codexHome: string,
  context: { systemPrompt?: string | undefined; reminderContent?: string | undefined }
): Promise<boolean> {
  const systemPrompt = context.systemPrompt?.trim() ?? ''
  const reminderContent = context.reminderContent?.trim() ?? ''
  if (!systemPrompt && !reminderContent) {
    return false
  }

  const agentsPath = join(codexHome, CODEX_AGENTS_FILE)
  let existing = ''
  try {
    existing = await readFile(agentsPath, 'utf-8')
  } catch {
    // No existing AGENTS.md (e.g. ad-hoc bundle); start fresh.
    existing = ''
  }

  // Strip any prior praesidium block so we always emit fresh content.
  const stripped = stripPraesidiumBlock(existing).trimEnd()

  const sections: string[] = []
  if (systemPrompt) {
    sections.push(systemPrompt)
  }
  if (reminderContent) {
    sections.push(reminderContent)
  }

  const block = [PRAESIDIUM_BEGIN_MARKER, sections.join('\n\n'), PRAESIDIUM_END_MARKER].join('\n')
  const next = stripped.length > 0 ? `${stripped}\n\n${block}\n` : `${block}\n`
  await writeFile(agentsPath, next)
  return true
}

function stripPraesidiumBlock(content: string): string {
  const beginIdx = content.indexOf(PRAESIDIUM_BEGIN_MARKER)
  if (beginIdx === -1) {
    return content
  }
  const endIdx = content.indexOf(PRAESIDIUM_END_MARKER, beginIdx)
  if (endIdx === -1) {
    return content
  }
  return content.slice(0, beginIdx) + content.slice(endIdx + PRAESIDIUM_END_MARKER.length)
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

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function pathCandidatesForCommand(command: string): string[] {
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, command))
}

function nvmCodexCandidates(): string[] {
  const versionsDir = join(homedir(), '.nvm', 'versions', 'node')
  try {
    return readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(versionsDir, entry.name, 'bin', 'codex'))
  } catch {
    return []
  }
}

function codexCommandCandidates(): string[] {
  const commonCandidates =
    process.env[CODEX_SKIP_COMMON_PATHS_ENV] === '1'
      ? []
      : [
          ...nvmCodexCandidates(),
          join(homedir(), '.bun', 'bin', 'codex'),
          join(homedir(), '.local', 'bin', 'codex'),
          '/opt/homebrew/bin/codex',
          '/usr/local/bin/codex',
        ]

  return dedupeStrings([
    process.env[CODEX_PATH_ENV] ?? '',
    ...pathCandidatesForCommand('codex'),
    ...commonCandidates,
  ])
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
    try {
      for (const candidate of codexCommandCandidates()) {
        if (!existsSync(candidate)) {
          continue
        }

        let versionResult: Awaited<ReturnType<typeof runCommand>>
        try {
          versionResult = await runCommand([candidate, '--version'])
        } catch (error) {
          errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }

        if (versionResult.exitCode !== 0) {
          errors.push(
            `${candidate}: ${
              versionResult.stderr.trim() || versionResult.stdout.trim() || 'codex --version failed'
            }`
          )
          continue
        }

        const versionOutput = versionResult.stdout.trim() || versionResult.stderr.trim()
        const match = versionOutput.match(/(\d+\.\d+\.\d+)/)
        const version = match?.[1] ?? (versionOutput || 'unknown')
        if (!match || !isVersionAtLeast(version, MIN_CODEX_VERSION)) {
          errors.push(`${candidate}: codex ${version} is below minimum ${MIN_CODEX_VERSION}`)
          continue
        }

        let helpResult: Awaited<ReturnType<typeof runCommand>>
        try {
          helpResult = await runCommand([candidate, 'app-server', '--help'])
        } catch (error) {
          errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        if (helpResult.exitCode !== 0) {
          errors.push(
            `${candidate}: ${
              helpResult.stderr.trim() ||
              helpResult.stdout.trim() ||
              'codex app-server --help failed'
            }`
          )
          continue
        }

        return {
          available: true,
          version,
          path: candidate,
          capabilities: ['appServer'],
        }
      }

      throw new Error(
        errors.length > 0
          ? errors.join('; ')
          : `codex not found on PATH, ${CODEX_PATH_ENV}, or common user install paths`
      )
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
    const args: string[] = []
    const isExecMode = options.interactive === false
    const isResumeMode = !!options.continuationKey
    const approvalPolicy = options.yolo ? 'never' : options.approvalPolicy
    const sandboxMode = options.yolo ? 'danger-full-access' : options.sandboxMode
    const appendDefaultFeatureFlags = () => {
      for (const feature of options.featureFlags ?? DEFAULT_CODEX_ENABLED_FEATURES) {
        args.push('--enable', feature)
      }
    }

    if (isExecMode) {
      if (options.profile) {
        args.push('-c', `profile="${options.profile}"`)
      }
      appendDefaultFeatureFlags()
      args.push('app-server')
      if (options.extraArgs) {
        args.push(...options.extraArgs)
      }
      return args
    }

    // Resume mode: interactive `codex resume [session-id]`.
    if (isResumeMode) {
      args.push('resume')
      appendDefaultFeatureFlags()
      if (typeof options.continuationKey === 'string') {
        args.push(options.continuationKey)
      }
      if (options.prompt) {
        args.push(options.prompt)
      }
    } else if (options.prompt) {
      appendDefaultFeatureFlags()
      args.push(options.prompt)
    } else {
      appendDefaultFeatureFlags()
    }

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
