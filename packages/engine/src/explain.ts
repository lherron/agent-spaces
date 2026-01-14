/**
 * Debug/explain output for resolved targets.
 *
 * WHY: Provides human-readable and machine-readable explanations
 * of resolved targets, including load order, dependencies, and warnings.
 * Also shows composed content: hooks, MCP servers, settings, and components.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  LOCK_FILENAME,
  type LockFile,
  type LockSpaceEntry,
  type LockTargetEntry,
  type SpaceKey,
  asSha256Integrity,
  asSpaceId,
  lockFileExists,
  readLockJson,
  readSpaceToml,
} from 'spaces-core'

import { type LintContext, type LintWarning, type SpaceLintData, lint } from 'spaces-lint'

import {
  COMPONENT_DIRS,
  type ComponentDir,
  type McpConfig,
  type McpServerConfig,
} from 'spaces-materializer'

import { PathResolver, getAspHome, snapshotExists } from 'spaces-store'

import type { ResolveOptions } from './resolve.js'

/**
 * Settings defined in a space.
 */
export interface SpaceSettingsInfo {
  /** Permission rules to allow tool use */
  allow?: string[] | undefined
  /** Permission rules to deny tool use */
  deny?: string[] | undefined
  /** Environment variables */
  env?: Record<string, string> | undefined
  /** Model override */
  model?: string | undefined
}

/**
 * Component content found in a space.
 */
export interface SpaceComponentInfo {
  /** Available component directories */
  components: ComponentDir[]
  /** Commands (slash commands) found */
  commands: string[]
  /** Skills found */
  skills: string[]
  /** Agents found */
  agents: string[]
  /** Scripts found */
  scripts: string[]
}

/**
 * Space information for explanation.
 */
export interface SpaceInfo {
  /** Space key */
  key: SpaceKey
  /** Space ID */
  id: string
  /** Commit SHA */
  commit: string
  /** Plugin name */
  pluginName: string
  /** Plugin version (if any) */
  pluginVersion?: string | undefined
  /** Content integrity */
  integrity: string
  /** Path in registry */
  path: string
  /** Dependencies */
  deps: SpaceKey[]
  /** How this version was resolved */
  resolvedFrom?: {
    selector?: string
    tag?: string
    semver?: string
  }
  /** Whether snapshot exists in store */
  inStore: boolean
  /** Hooks defined in this space */
  hooks?: HookInfo[] | undefined
  /** MCP servers defined in this space */
  mcpServers?: Record<string, McpServerConfig> | undefined
  /** Settings defined in this space */
  settings?: SpaceSettingsInfo | undefined
  /** Component content */
  content?: SpaceComponentInfo | undefined
}

/**
 * Composed content across all spaces in a target.
 */
export interface ComposedContent {
  /** All hooks from all spaces (in load order) */
  hooks: Array<{ space: string; hook: HookInfo }>
  /** Composed MCP servers (later spaces override) */
  mcpServers: Record<string, { space: string; config: McpServerConfig }>
  /** Composed settings */
  settings: {
    /** All allow rules (concatenated) */
    allow: Array<{ space: string; rule: string }>
    /** All deny rules (concatenated) */
    deny: Array<{ space: string; rule: string }>
    /** All env vars (later override earlier) */
    env: Record<string, { space: string; value: string }>
    /** Model (last one wins) */
    model?: { space: string; value: string } | undefined
  }
  /** All commands across spaces */
  commands: Array<{ space: string; name: string }>
  /** All skills across spaces */
  skills: Array<{ space: string; name: string }>
  /** All agents across spaces */
  agents: Array<{ space: string; name: string }>
}

/**
 * Target explanation.
 */
export interface TargetExplanation {
  /** Target name */
  name: string
  /** Original compose list */
  compose: string[]
  /** Root space keys */
  roots: SpaceKey[]
  /** Load order (dependencies first) */
  loadOrder: SpaceKey[]
  /** Environment hash */
  envHash: string
  /** Detailed space info in load order */
  spaces: SpaceInfo[]
  /** Composed content from all spaces */
  composed: ComposedContent
  /** Warnings */
  warnings: LintWarning[]
}

/**
 * Full explanation output.
 */
export interface ExplainResult {
  /** Registry URL */
  registryUrl: string
  /** Lock file version */
  lockVersion: number
  /** When lock was generated */
  generatedAt: string
  /** Target explanations */
  targets: Record<string, TargetExplanation>
}

/**
 * Options for explain operation.
 */
export interface ExplainOptions extends ResolveOptions {
  /** Specific targets to explain (default: all) */
  targets?: string[] | undefined
  /** Whether to check store for snapshots (default: true) */
  checkStore?: boolean | undefined
  /** Whether to run lint checks (default: true) */
  runLint?: boolean | undefined
}

// ============================================================================
// Content Reading Helpers
// ============================================================================

/**
 * Check if a path exists and is a directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Simple hook definition format (old format with event/script).
 */
interface SimpleHookDef {
  event: string
  script: string
}

/**
 * Claude hook definition format (matcher/hooks).
 */
interface ClaudeNativeHookDef {
  matcher?: string | undefined
  hooks: Array<{ command?: string | undefined }>
}

type ClaudeHooksByEvent = Record<string, ClaudeNativeHookDef[]>

/**
 * Simplified hook info for display.
 */
export interface HookInfo {
  event: string
  count: number
}

/**
 * Read hooks.json from a directory and extract event names.
 * Handles simple format, Claude array format, and Claude object format.
 */
async function readHooksFromDir(dir: string): Promise<HookInfo[] | undefined> {
  const hooksJsonPath = join(dir, 'hooks', 'hooks.json')
  try {
    const content = await readFile(hooksJsonPath, 'utf-8')
    const config = JSON.parse(content)

    if (!config.hooks) {
      return undefined
    }

    if (Array.isArray(config.hooks)) {
      // Check first element to determine format
      const first = config.hooks[0]
      if (!first) {
        return []
      }

      // Claude array format: [{matcher, hooks: [{command}]}]
      if ('hooks' in first) {
        return (config.hooks as ClaudeNativeHookDef[]).map((h) => ({
          event: h.matcher ?? 'Unknown',
          count: h.hooks?.length ?? 0,
        }))
      }

      // Simple format: [{event, script}]
      if ('event' in first) {
        return (config.hooks as SimpleHookDef[]).map((h) => ({
          event: h.event,
          count: 1,
        }))
      }

      return undefined
    }

    if (typeof config.hooks === 'object') {
      const results: HookInfo[] = []
      for (const [eventName, eventHooks] of Object.entries(config.hooks as ClaudeHooksByEvent)) {
        if (!Array.isArray(eventHooks)) continue
        const count = eventHooks.reduce((sum, hookDef) => {
          return sum + (hookDef.hooks?.length ?? 0)
        }, 0)
        results.push({ event: eventName, count })
      }
      return results
    }

    return undefined
  } catch {
    return undefined
  }
}

/**
 * Read mcp.json from a directory.
 */
async function readMcpFromDir(dir: string): Promise<Record<string, McpServerConfig> | undefined> {
  const mcpJsonPath = join(dir, 'mcp', 'mcp.json')
  try {
    const content = await readFile(mcpJsonPath, 'utf-8')
    const config = JSON.parse(content) as McpConfig
    return config.mcpServers
  } catch {
    return undefined
  }
}

/**
 * Get available component directories in a snapshot.
 */
async function getAvailableComponents(snapshotDir: string): Promise<ComponentDir[]> {
  const available: ComponentDir[] = []
  for (const component of COMPONENT_DIRS) {
    const dir = join(snapshotDir, component)
    if (await isDirectory(dir)) {
      available.push(component)
    }
  }
  return available
}

/**
 * List files in a component directory (returns basenames without extension).
 */
async function listComponentFiles(dir: string, component: string): Promise<string[]> {
  const componentDir = join(dir, component)
  try {
    const entries = await readdir(componentDir, { withFileTypes: true })
    return entries.filter((e) => e.isFile()).map((e) => e.name.replace(/\.[^.]+$/, '')) // Remove extension
  } catch {
    return []
  }
}

/**
 * List skill directories (directories containing SKILL.md).
 */
async function listSkills(dir: string): Promise<string[]> {
  const skillsDir = join(dir, 'skills')
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    const skills: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Check if SKILL.md exists in this directory
        const skillFile = join(skillsDir, entry.name, 'SKILL.md')
        try {
          await stat(skillFile)
          skills.push(entry.name)
        } catch {
          // No SKILL.md, skip
        }
      }
    }
    return skills
  } catch {
    return []
  }
}

/**
 * Read settings from space.toml in a directory.
 */
async function readSettingsFromDir(dir: string): Promise<SpaceSettingsInfo | undefined> {
  try {
    const spaceTomlPath = join(dir, 'space.toml')
    const manifest = await readSpaceToml(spaceTomlPath)
    if (!manifest.settings) return undefined

    const result: SpaceSettingsInfo = {}
    if (manifest.settings.permissions?.allow?.length) {
      result.allow = manifest.settings.permissions.allow
    }
    if (manifest.settings.permissions?.deny?.length) {
      result.deny = manifest.settings.permissions.deny
    }
    if (manifest.settings.env && Object.keys(manifest.settings.env).length > 0) {
      result.env = manifest.settings.env
    }
    if (manifest.settings.model) {
      result.model = manifest.settings.model
    }
    return Object.keys(result).length > 0 ? result : undefined
  } catch {
    return undefined
  }
}

/**
 * Build space info from lock entry.
 */
async function buildSpaceInfo(
  key: SpaceKey,
  entry: LockSpaceEntry,
  options: { paths: PathResolver; cwd: string; registryPath: string },
  checkStore: boolean
): Promise<SpaceInfo> {
  const isDev = entry.commit === 'dev'
  const inStore = isDev ? false : checkStore ? await snapshotExists(entry.integrity, options) : true

  // For @dev refs, read from registry; otherwise read from store snapshot
  const contentDir = isDev
    ? join(options.registryPath, entry.path)
    : options.paths.snapshot(asSha256Integrity(entry.integrity))

  const info: SpaceInfo = {
    key,
    id: entry.id as string,
    commit: entry.commit as string,
    pluginName: entry.plugin.name,
    pluginVersion: entry.plugin.version,
    integrity: entry.integrity as string,
    path: entry.path,
    deps: entry.deps.spaces,
    inStore,
  }

  // Only set resolvedFrom if present (exactOptionalPropertyTypes)
  if (entry.resolvedFrom) {
    info.resolvedFrom = entry.resolvedFrom
  }

  // Read content from directory (store snapshot or registry for @dev)
  const canReadContent = isDev || inStore
  if (canReadContent) {
    const hooks = await readHooksFromDir(contentDir)
    if (hooks?.length) {
      info.hooks = hooks
    }

    const mcpServers = await readMcpFromDir(contentDir)
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      info.mcpServers = mcpServers
    }

    const settings = await readSettingsFromDir(contentDir)
    if (settings) {
      info.settings = settings
    }

    const components = await getAvailableComponents(contentDir)
    const commands = await listComponentFiles(contentDir, 'commands')
    const skills = await listSkills(contentDir)
    const agents = await listComponentFiles(contentDir, 'agents')
    const scripts = await listComponentFiles(contentDir, 'scripts')

    if (
      components.length > 0 ||
      commands.length > 0 ||
      skills.length > 0 ||
      agents.length > 0 ||
      scripts.length > 0
    ) {
      info.content = { components, commands, skills, agents, scripts }
    }
  }

  return info
}

/**
 * Compose content from all spaces in load order.
 */
function composeContent(spaces: SpaceInfo[]): ComposedContent {
  const composed: ComposedContent = {
    hooks: [],
    mcpServers: {},
    settings: {
      allow: [],
      deny: [],
      env: {},
    },
    commands: [],
    skills: [],
    agents: [],
  }

  for (const space of spaces) {
    const spaceId = space.id

    // Collect hooks
    if (space.hooks) {
      for (const hook of space.hooks) {
        composed.hooks.push({ space: spaceId, hook })
      }
    }

    // Collect MCP servers (later override earlier)
    if (space.mcpServers) {
      for (const [name, config] of Object.entries(space.mcpServers)) {
        composed.mcpServers[name] = { space: spaceId, config }
      }
    }

    // Collect settings
    if (space.settings) {
      if (space.settings.allow) {
        for (const rule of space.settings.allow) {
          composed.settings.allow.push({ space: spaceId, rule })
        }
      }
      if (space.settings.deny) {
        for (const rule of space.settings.deny) {
          composed.settings.deny.push({ space: spaceId, rule })
        }
      }
      if (space.settings.env) {
        for (const [key, value] of Object.entries(space.settings.env)) {
          composed.settings.env[key] = { space: spaceId, value }
        }
      }
      if (space.settings.model) {
        composed.settings.model = { space: spaceId, value: space.settings.model }
      }
    }

    // Collect commands, skills, agents
    if (space.content) {
      for (const cmd of space.content.commands) {
        composed.commands.push({ space: spaceId, name: cmd })
      }
      for (const skill of space.content.skills) {
        composed.skills.push({ space: spaceId, name: skill })
      }
      for (const agent of space.content.agents) {
        composed.agents.push({ space: spaceId, name: agent })
      }
    }
  }

  return composed
}

/**
 * Explain a target from lock file.
 */
async function explainTarget(
  name: string,
  target: LockTargetEntry,
  lock: LockFile,
  options: ExplainOptions
): Promise<TargetExplanation> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })
  const registryPath = options.registryPath ?? paths.repo
  const checkStore = options.checkStore !== false
  const buildOpts = { paths, cwd: registryPath, registryPath }

  // Build space info for each space in load order
  const spaces: SpaceInfo[] = []
  for (const key of target.loadOrder) {
    const entry = lock.spaces[key]
    if (!entry) {
      throw new Error(`Space not found in lock: ${key}`)
    }
    const info = await buildSpaceInfo(key, entry, buildOpts, checkStore)
    spaces.push(info)
  }

  // Run lint if requested
  let warnings: LintWarning[] = []
  if (options.runLint !== false) {
    const lintData: SpaceLintData[] = spaces.map((space) => ({
      key: space.key,
      manifest: {
        schema: 1 as const,
        id: asSpaceId(space.id),
        plugin: {
          name: space.pluginName,
          version: space.pluginVersion,
        },
      },
      pluginPath: paths.snapshot(asSha256Integrity(space.integrity)),
    }))

    const lintContext: LintContext = { spaces: lintData }
    warnings = await lint(lintContext)
  }

  // Include warnings from lock if present (convert LockWarning to LintWarning)
  if (target.warnings) {
    for (const lockWarning of target.warnings) {
      warnings.push({
        code: lockWarning.code,
        message: lockWarning.message,
        severity: 'warning',
      })
    }
  }

  // Compose content from all spaces
  const composed = composeContent(spaces)

  return {
    name,
    compose: target.compose as string[],
    roots: target.roots,
    loadOrder: target.loadOrder,
    envHash: target.envHash as string,
    spaces,
    composed,
    warnings,
  }
}

/**
 * Explain targets from a project.
 *
 * This provides detailed information about:
 * - Load order and dependencies
 * - Plugin identities
 * - How versions were resolved
 * - Whether snapshots are in store
 * - Any lint warnings
 */
export async function explain(options: ExplainOptions): Promise<ExplainResult> {
  // Check for lock file
  const lockPath = join(options.projectPath, LOCK_FILENAME)
  if (!(await lockFileExists(lockPath))) {
    throw new Error('No lock file found. Run install first.')
  }

  // Load lock file
  const lock = await readLockJson(lockPath)

  // Determine which targets to explain
  const targetNames = options.targets ?? Object.keys(lock.targets)

  // Build explanations
  const targets: Record<string, TargetExplanation> = {}
  for (const name of targetNames) {
    const target = lock.targets[name]
    if (!target) {
      throw new Error(`Target not found in lock: ${name}`)
    }
    targets[name] = await explainTarget(name, target, lock, options)
  }

  return {
    registryUrl: lock.registry.url,
    lockVersion: lock.lockfileVersion,
    generatedAt: lock.generatedAt,
    targets,
  }
}

// ============================================================================
// Text Formatting Helpers
// ============================================================================

/**
 * Format a single space for text output.
 */
function formatSpaceText(space: SpaceInfo, lines: string[]): void {
  const version = space.pluginVersion ? `@${space.pluginVersion}` : ''
  const storeStatus = space.inStore ? '' : ' [NOT IN STORE]'
  lines.push(`    ${space.pluginName}${version}${storeStatus}`)
  lines.push(`      Key: ${space.key}`)
  lines.push(`      Commit: ${space.commit.slice(0, 12)}`)
  if (space.resolvedFrom?.selector) {
    lines.push(`      Selector: ${space.resolvedFrom.selector}`)
  }
  if (space.deps.length > 0) {
    lines.push(`      Deps: ${space.deps.join(', ')}`)
  }

  // Show content from this space
  if (space.content?.components.length) {
    lines.push(`      Components: ${space.content.components.join(', ')}`)
  }
  if (space.hooks?.length) {
    lines.push(`      Hooks: ${space.hooks.map((h) => h.event).join(', ')}`)
  }
  if (space.mcpServers && Object.keys(space.mcpServers).length > 0) {
    lines.push(`      MCP servers: ${Object.keys(space.mcpServers).join(', ')}`)
  }
  if (space.settings) {
    const parts: string[] = []
    if (space.settings.allow?.length) parts.push(`allow[${space.settings.allow.length}]`)
    if (space.settings.deny?.length) parts.push(`deny[${space.settings.deny.length}]`)
    if (space.settings.env && Object.keys(space.settings.env).length > 0) {
      parts.push(`env[${Object.keys(space.settings.env).length}]`)
    }
    if (space.settings.model) parts.push(`model=${space.settings.model}`)
    if (parts.length > 0) {
      lines.push(`      Settings: ${parts.join(', ')}`)
    }
  }
}

/**
 * Format composed content summary.
 */
function formatComposedText(composed: ComposedContent, lines: string[]): void {
  lines.push('  Composed content:')

  // Commands
  if (composed.commands.length > 0) {
    lines.push(`    Commands (${composed.commands.length}):`)
    for (const cmd of composed.commands) {
      lines.push(`      /${cmd.name} (from ${cmd.space})`)
    }
  }

  // Skills
  if (composed.skills.length > 0) {
    lines.push(`    Skills (${composed.skills.length}):`)
    for (const skill of composed.skills) {
      lines.push(`      ${skill.name} (from ${skill.space})`)
    }
  }

  // Agents
  if (composed.agents.length > 0) {
    lines.push(`    Agents (${composed.agents.length}):`)
    for (const agent of composed.agents) {
      lines.push(`      ${agent.name} (from ${agent.space})`)
    }
  }

  // Hooks
  if (composed.hooks.length > 0) {
    lines.push(`    Hooks (${composed.hooks.length}):`)
    for (const { space, hook } of composed.hooks) {
      const countInfo = hook.count > 1 ? ` (${hook.count} handlers)` : ''
      lines.push(`      ${hook.event}${countInfo} (from ${space})`)
    }
  }

  // MCP Servers
  const mcpEntries = Object.entries(composed.mcpServers)
  if (mcpEntries.length > 0) {
    lines.push(`    MCP servers (${mcpEntries.length}):`)
    for (const [name, { space, config }] of mcpEntries) {
      lines.push(`      ${name}: ${config.command} (from ${space})`)
    }
  }

  // Settings
  const hasSettings =
    composed.settings.allow.length > 0 ||
    composed.settings.deny.length > 0 ||
    Object.keys(composed.settings.env).length > 0 ||
    composed.settings.model

  if (hasSettings) {
    lines.push('    Settings:')

    if (composed.settings.allow.length > 0) {
      lines.push(`      Allow rules (${composed.settings.allow.length}):`)
      for (const { space, rule } of composed.settings.allow) {
        lines.push(`        ${rule} (from ${space})`)
      }
    }

    if (composed.settings.deny.length > 0) {
      lines.push(`      Deny rules (${composed.settings.deny.length}):`)
      for (const { space, rule } of composed.settings.deny) {
        lines.push(`        ${rule} (from ${space})`)
      }
    }

    const envEntries = Object.entries(composed.settings.env)
    if (envEntries.length > 0) {
      lines.push(`      Environment (${envEntries.length}):`)
      for (const [key, { space, value }] of envEntries) {
        // Truncate long values
        const displayValue = value.length > 30 ? `${value.slice(0, 30)}...` : value
        lines.push(`        ${key}=${displayValue} (from ${space})`)
      }
    }

    if (composed.settings.model) {
      lines.push(
        `      Model: ${composed.settings.model.value} (from ${composed.settings.model.space})`
      )
    }
  }
}

/**
 * Format a single target for text output.
 */
function formatTargetText(name: string, target: TargetExplanation, lines: string[]): void {
  lines.push(`Target: ${name}`)
  lines.push(`  Compose: ${target.compose.join(', ')}`)
  lines.push(`  Env hash: ${target.envHash.slice(0, 16)}...`)
  lines.push('')
  lines.push('  Load order:')

  for (const space of target.spaces) {
    formatSpaceText(space, lines)
  }

  // Show composed content
  lines.push('')
  formatComposedText(target.composed, lines)

  if (target.warnings.length > 0) {
    lines.push('')
    lines.push('  Warnings:')
    for (const warning of target.warnings) {
      lines.push(`    [${warning.code}] ${warning.message}`)
    }
  }

  lines.push('')
}

/**
 * Format explanation as human-readable text.
 */
export function formatExplainText(result: ExplainResult): string {
  const lines: string[] = []

  lines.push(`Registry: ${result.registryUrl}`)
  lines.push(`Lock version: ${result.lockVersion}`)
  lines.push(`Generated: ${result.generatedAt}`)
  lines.push('')

  for (const [name, target] of Object.entries(result.targets)) {
    formatTargetText(name, target, lines)
  }

  return lines.join('\n')
}

/**
 * Format explanation as JSON.
 */
export function formatExplainJson(result: ExplainResult): string {
  return JSON.stringify(result, null, 2)
}
