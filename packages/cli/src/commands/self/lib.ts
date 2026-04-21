/**
 * Shared helpers for `asp self` commands.
 *
 * WHY: the `self` family reads a live agent's runtime state from environment
 * variables (HRC_LAUNCH_FILE, ASP_PLUGIN_ROOT, AGENTCHAT_ID, etc.) and
 * classifies the paths that went into composing the agent. Centralizing that
 * resolution here keeps each subcommand small and gives both clod and cody a
 * stable API surface.
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { parse as parseToml } from '@iarna/toml'

import { getAgentsRoot, getAspHome, resolveRootRelativeRef } from 'spaces-config'
import {
  type ContextResolverContext,
  type ContextTemplate,
  type DiscoveredContextTemplate,
  discoverContextTemplate,
  resolveContextTemplateDetailed,
} from 'spaces-runtime'

/**
 * Lenient subset of the HRC launch artifact. The real type lives in
 * `hrc-core` but we avoid that dep to keep the CLI lean; we read this
 * read-only so missing fields are tolerated.
 */
export interface LaunchArtifactLite {
  launchId?: string
  hostSessionId?: string
  generation?: number
  runtimeId?: string
  runId?: string
  harness?: string
  provider?: string
  argv?: string[]
  env?: Record<string, string>
  cwd?: string
  callbackSocketPath?: string
  spoolDir?: string
  correlationEnv?: Record<string, string>
  interactionMode?: string
  ioMode?: string
  lifecycleAction?: string
}

export interface PromptFragment {
  content: string
  mode: 'append' | 'replace'
}

export interface SelfContext {
  /** Agent slug (e.g. "clod"). */
  agentName: string | null
  projectId: string | null
  sessionRef: string | null
  scopeRef: string | null
  laneRef: string | null
  hostSessionId: string | null
  runtimeId: string | null
  runId: string | null
  launchId: string | null
  generation: number | null

  cwd: string
  agentsRoot: string
  agentRoot: string | null
  aspHome: string
  bundleRoot: string | null
  launchFilePath: string | null

  launch: LaunchArtifactLite | null
  launchReadError: string | null

  harness: string | null
  provider: string | null

  systemPrompt: PromptFragment | null
  primingPrompt: string | null
}

export interface ResolveSelfContextOptions {
  /** Override HRC_LAUNCH_FILE. */
  launchFile?: string
  /** Override inferred agent slug. */
  target?: string
  /** Override ASP_HOME. */
  aspHome?: string
  /** Override agents root. */
  agentsRoot?: string
  /** Environment source (defaults to process.env). */
  env?: NodeJS.ProcessEnv
  /** Override cwd. */
  cwd?: string
}

export interface ResolveSelfTemplateContextOptions {
  runMode?: string | undefined
}

export interface SelfTemplateContext {
  discovered: DiscoveredContextTemplate
  template: ContextTemplate | null
  resolverContext: ContextResolverContext
  runMode: string
}

export type TemplateSourceKind =
  | 'agent-local'
  | 'shared-agents-root'
  | 'asp-home'
  | 'custom'
  | 'built-in'
  | 'none'

export interface TemplateSourceInfo {
  kind: TemplateSourceKind
  path: string | null
}

export type TemplateSection = ContextTemplate['promptSections'][number]

export interface SectionReport {
  zone: 'prompt' | 'reminder'
  name: string
  source: string
  chars: number
  bytes: number
  included: boolean
  when?: string | undefined
  error?: string | undefined
}

/**
 * Pull the system prompt out of argv. Claude uses `--append-system-prompt`;
 * other harnesses use `--system-prompt`. Mirrors hrc-server's exec.ts.
 */
export function extractSystemPrompt(argv: readonly string[]): PromptFragment | null {
  const appendIdx = argv.indexOf('--append-system-prompt')
  if (appendIdx !== -1 && argv[appendIdx + 1] !== undefined) {
    return { content: argv[appendIdx + 1] as string, mode: 'append' }
  }
  const replaceIdx = argv.indexOf('--system-prompt')
  if (replaceIdx !== -1 && argv[replaceIdx + 1] !== undefined) {
    return { content: argv[replaceIdx + 1] as string, mode: 'replace' }
  }
  return null
}

/**
 * Pull the priming prompt. Convention is the value after the `--` separator.
 */
export function extractPrimingPrompt(argv: readonly string[]): string | null {
  const dashIdx = argv.indexOf('--')
  if (dashIdx === -1) return null
  const value = argv[dashIdx + 1]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Infer the agent target name from ASP_PLUGIN_ROOT.
 *
 * Bundle layout: `<asp-home>/projects/<proj>/targets/<target>/<harness>/`.
 * The directory two levels up from the bundle root is the target slug.
 */
export function inferTargetFromBundleRoot(bundleRoot: string | undefined): string | null {
  if (!bundleRoot) return null
  const harnessDir = bundleRoot
  const targetDir = dirname(harnessDir)
  if (dirname(targetDir) === targetDir) return null
  const targetName = targetDir.split('/').pop()
  return targetName && targetName.length > 0 ? targetName : null
}

function parseIntOrNull(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAgentProfile(agentRoot: string | null): Record<string, unknown> | null {
  if (!agentRoot) {
    return null
  }

  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return null
  }

  const parsed = parseToml(readFileSync(profilePath, 'utf8'))
  if (!isRecord(parsed)) {
    throw new Error(`Agent profile must parse to a TOML table: ${profilePath}`)
  }

  return parsed
}

/**
 * Read a launch artifact with lenient parsing. Unlike hrc-server's
 * `readLaunchArtifact`, this tolerates missing fields so introspection of
 * older or partial artifacts still works.
 */
export function readLaunchArtifactLite(path: string): {
  artifact: LaunchArtifactLite | null
  error: string | null
} {
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { artifact: null, error: `launch artifact is not an object: ${path}` }
    }
    return { artifact: parsed as LaunchArtifactLite, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { artifact: null, error: message }
  }
}

/**
 * Resolve the full self-introspection context from environment and options.
 *
 * This is the primary entry point for every `asp self` subcommand. It returns
 * everything that can be derived without running any agent-spaces resolution
 * logic — pure read of env + launch artifact + bundle filesystem layout.
 */
export function resolveSelfContext(options: ResolveSelfContextOptions = {}): SelfContext {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const aspHome = options.aspHome ?? getAspHome()
  const agentsRoot = options.agentsRoot ?? getAgentsRoot() ?? aspHome

  const launchFilePath = options.launchFile ?? env['HRC_LAUNCH_FILE'] ?? null
  const bundleRoot = env['ASP_PLUGIN_ROOT'] ?? null
  const primingPromptEnv = env['ASP_PRIMING_PROMPT'] ?? null

  const { artifact: launch, error: launchReadError } =
    launchFilePath && existsSync(launchFilePath)
      ? readLaunchArtifactLite(launchFilePath)
      : {
          artifact: null,
          error: launchFilePath ? `launch file not found: ${launchFilePath}` : null,
        }

  const agentName =
    options.target ?? env['AGENTCHAT_ID'] ?? inferTargetFromBundleRoot(bundleRoot ?? undefined)

  const agentRoot = agentName ? join(agentsRoot, agentName) : null

  const argv = launch?.argv ?? []
  const systemPrompt = extractSystemPrompt(argv)
  const primingFromArgv = extractPrimingPrompt(argv)
  const primingPrompt = primingFromArgv ?? primingPromptEnv

  return {
    agentName: agentName ?? null,
    projectId: env['ASP_PROJECT'] ?? null,
    sessionRef: env['HRC_SESSION_REF'] ?? null,
    scopeRef: env['AGENT_SCOPE_REF'] ?? null,
    laneRef: env['AGENT_LANE_REF'] ?? null,
    hostSessionId: env['HRC_HOST_SESSION_ID'] ?? env['AGENT_HOST_SESSION_ID'] ?? null,
    runtimeId: env['HRC_RUNTIME_ID'] ?? launch?.runtimeId ?? null,
    runId: env['HRC_RUN_ID'] ?? launch?.runId ?? null,
    launchId: env['HRC_LAUNCH_ID'] ?? launch?.launchId ?? null,
    generation: parseIntOrNull(env['HRC_GENERATION']) ?? launch?.generation ?? null,

    cwd,
    agentsRoot,
    agentRoot,
    aspHome,
    bundleRoot,
    launchFilePath,

    launch,
    launchReadError,

    harness: launch?.harness ?? null,
    provider: launch?.provider ?? null,

    systemPrompt,
    primingPrompt,
  }
}

export function resolveSelfTemplateContext(
  ctx: SelfContext,
  options: ResolveSelfTemplateContextOptions = {}
): SelfTemplateContext {
  const syntheticAgentRoot = ctx.agentRoot ?? ctx.agentsRoot
  const discovered = discoverContextTemplate({
    agentRoot: syntheticAgentRoot,
    agentsRoot: ctx.agentsRoot,
    aspHome: ctx.aspHome,
  })

  const runMode = options.runMode ?? 'query'
  const resolverContext: ContextResolverContext = {
    agentRoot: syntheticAgentRoot,
    agentName: ctx.agentName ?? basename(syntheticAgentRoot),
    agentsRoot: discovered.agentsRoot,
    projectRoot: ctx.cwd,
    runMode,
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
  }

  if (discovered.profile.rawProfile) {
    resolverContext.agentProfile = discovered.profile.rawProfile
  } else {
    const profile = readAgentProfile(ctx.agentRoot)
    if (profile) {
      resolverContext.agentProfile = profile
    }
  }

  return {
    discovered,
    template: discovered.templateSource?.template ?? null,
    resolverContext,
    runMode,
  }
}

export function classifyTemplateSource(
  ctx: Pick<SelfContext, 'agentRoot' | 'agentsRoot' | 'aspHome'>,
  templatePath: string | null
): TemplateSourceInfo {
  if (!templatePath) {
    return { kind: 'built-in', path: null }
  }

  if (ctx.agentRoot && templatePath === join(ctx.agentRoot, 'context-template.toml')) {
    return { kind: 'agent-local', path: templatePath }
  }

  if (templatePath === join(ctx.agentsRoot, 'context-template.toml')) {
    return { kind: 'shared-agents-root', path: templatePath }
  }

  if (templatePath === join(ctx.aspHome, 'context-template.toml')) {
    return { kind: 'asp-home', path: templatePath }
  }

  return { kind: 'custom', path: templatePath }
}

export function describeTemplateSectionSource(
  section: TemplateSection,
  resolverContext: Pick<ContextResolverContext, 'agentRoot' | 'agentsRoot' | 'projectRoot'>
): string {
  switch (section.type) {
    case 'inline':
      return 'inline content'
    case 'exec':
      return `exec: ${section.command}`
    case 'slot':
      return `slot: ${section.source}`
    case 'file': {
      try {
        const resolved =
          section.path.startsWith('agent-root:///') || section.path.startsWith('project-root:///')
            ? resolveRootRelativeRef(section.path, {
                agentRoot: resolverContext.agentRoot,
                projectRoot: resolverContext.projectRoot,
              })
            : join(resolverContext.agentsRoot, section.path)
        return `${section.path} -> ${resolved}`
      } catch {
        return `file: ${section.path}`
      }
    }
  }
}

function formatWhenPredicate(section: TemplateSection): string | undefined {
  if (!section.when) {
    return undefined
  }

  const parts: string[] = []
  if (section.when.runMode) {
    parts.push(`runMode=${section.when.runMode}`)
  }
  if (section.when.exists) {
    parts.push(`exists=${section.when.exists}`)
  }

  return parts.length > 0 ? parts.join(', ') : undefined
}

export async function analyzeTemplateSections(input: {
  template: ContextTemplate
  resolverContext: ContextResolverContext
  zone: 'prompt' | 'reminder'
}): Promise<SectionReport[]> {
  const sections =
    input.zone === 'prompt' ? input.template.promptSections : input.template.reminderSections

  return Promise.all(
    sections.map(async (section) => {
      const singleTemplate: ContextTemplate = {
        schemaVersion: input.template.schemaVersion,
        mode: input.template.mode,
        promptSections: input.zone === 'prompt' ? [section] : [],
        reminderSections: input.zone === 'reminder' ? [section] : [],
      }

      const base: SectionReport = {
        zone: input.zone,
        name: section.name,
        source: describeTemplateSectionSource(section, input.resolverContext),
        chars: 0,
        bytes: 0,
        included: false,
        ...(formatWhenPredicate(section) ? { when: formatWhenPredicate(section) } : {}),
      }

      try {
        const resolved = await resolveContextTemplateDetailed(
          singleTemplate,
          input.resolverContext,
          {
            includePrompt: input.zone === 'prompt',
            includeReminder: input.zone === 'reminder',
          }
        )
        const content = input.zone === 'prompt' ? resolved.prompt?.content : resolved.reminder

        return {
          ...base,
          chars: charCount(content),
          bytes: byteCount(content),
          included: typeof content === 'string' && content.length > 0,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          ...base,
          error: message,
        }
      }
    })
  )
}

/**
 * Classification of a candidate path in the agent's runtime layout.
 *
 *   editable         — durable source file the agent may modify to change
 *                      future launches (SOUL.md, agent-profile.toml, ...).
 *   shared-editable  — editable but affects other agents too (AGENT_MOTD.md,
 *                      shared context-template.toml). Warn before editing.
 *   derived          — materialized output from a build step; editing is
 *                      pointless (bundle plugins, system-prompt.md).
 *   ephemeral        — runtime artifact that will be regenerated next launch
 *                      (launch file, spool dir).
 */
export type PathKind = 'editable' | 'shared-editable' | 'derived' | 'ephemeral'

export interface PathEntry {
  name: string
  path: string
  exists: boolean
  kind: PathKind
  description: string
}

/**
 * Enumerate every interesting path in the agent's runtime layout, classified
 * by whether editing it is meaningful.
 */
export function enumeratePaths(ctx: SelfContext): PathEntry[] {
  const entries: PathEntry[] = []

  const add = (name: string, path: string | null, kind: PathKind, description: string): void => {
    if (!path) return
    entries.push({ name, path, exists: existsSync(path), kind, description })
  }

  // Editable: agent-local sources
  if (ctx.agentRoot) {
    add('soul', join(ctx.agentRoot, 'SOUL.md'), 'editable', 'Agent identity — system prompt')
    add(
      'profile',
      join(ctx.agentRoot, 'agent-profile.toml'),
      'editable',
      'Runtime config — model, spaces, priming, harness defaults'
    )
    add(
      'context-template',
      join(ctx.agentRoot, 'context-template.toml'),
      'editable',
      'Agent-local override for prompt/reminder assembly'
    )
    add(
      'heartbeat',
      join(ctx.agentRoot, 'HEARTBEAT.md'),
      'editable',
      'Instructions appended when runMode=heartbeat'
    )
    add('skills-dir', join(ctx.agentRoot, 'skills'), 'editable', 'Agent-authored skill files')
  }

  // Shared-editable: affects all agents
  add(
    'shared-motd',
    join(ctx.agentsRoot, 'AGENT_MOTD.md'),
    'shared-editable',
    'Platform preamble prepended to every agent — affects all agents'
  )
  add(
    'shared-template',
    join(ctx.agentsRoot, 'context-template.toml'),
    'shared-editable',
    'Default prompt/reminder assembly template — affects agents without a local override'
  )
  add(
    'shared-conventions',
    join(ctx.agentsRoot, 'conventions.md'),
    'shared-editable',
    'Shared coding standards (referenced, not auto-injected)'
  )

  // Derived: bundle materialized outputs
  if (ctx.bundleRoot) {
    add('bundle-root', ctx.bundleRoot, 'derived', 'Materialized harness bundle root')
    add(
      'bundle-system-prompt',
      join(ctx.bundleRoot, 'system-prompt.md'),
      'derived',
      'Final assembled system prompt (replace mode only)'
    )
    add(
      'bundle-reminder',
      join(ctx.bundleRoot, 'session-reminder.md'),
      'derived',
      'Rendered session reminder sections'
    )
    add(
      'bundle-settings',
      join(ctx.bundleRoot, 'settings.json'),
      'derived',
      'Merged harness settings'
    )
    add('bundle-mcp', join(ctx.bundleRoot, 'mcp.json'), 'derived', 'Merged MCP server config')
    add(
      'bundle-statusline',
      join(ctx.bundleRoot, 'statusline.sh'),
      'derived',
      'Harness status line script'
    )
    add('bundle-plugins', join(ctx.bundleRoot, 'plugins'), 'derived', 'Ordered plugin bundles')
  }

  // Ephemeral: HRC runtime state
  add('launch-file', ctx.launchFilePath, 'ephemeral', 'JSON artifact of this launch (argv, env)')
  if (ctx.launch?.spoolDir) {
    add('spool-dir', ctx.launch.spoolDir, 'ephemeral', 'Callback spool for offline HRC events')
  }

  return entries
}

/**
 * Character count of a string; null-safe.
 */
export function charCount(value: string | null | undefined): number {
  return typeof value === 'string' ? value.length : 0
}

/**
 * Byte count (UTF-8) of a string; null-safe.
 */
export function byteCount(value: string | null | undefined): number {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf-8') : 0
}
