import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveRootRelativeRef } from 'spaces-config'
import type {
  ContextSection,
  ContextTemplate,
  ExecSectionDef,
  FileSectionDef,
  SystemPromptMode,
} from './context-template.js'

const execFileAsync = promisify(execFile)
const DEFAULT_EXEC_TIMEOUT_MS = 5000
const SECTION_SEPARATOR = '\n\n---\n\n'
const SLOT_SEPARATOR = '\n\n'
const TRUNCATION_SUFFIX = '\n[truncated]'

export interface ContextResolverContext {
  agentRoot: string
  agentsRoot: string
  projectRoot?: string | undefined
  projectId?: string | undefined
  agentName?: string | undefined
  runMode: string
  scaffoldPackets?:
    | Array<{
        slot: string
        content?: string | undefined
        ref?: string | undefined
      }>
    | undefined
  agentProfile?: Record<string, unknown> | undefined
}

export interface ResolvedContext {
  prompt:
    | {
        content: string
        mode: SystemPromptMode
      }
    | undefined
  reminder: string | undefined
}

export interface ResolvedZoneDiagnostics {
  sectionSizes: string[]
  totalChars: number
}

export interface ResolvedContextDiagnostics {
  prompt: ResolvedZoneDiagnostics
  reminder: ResolvedZoneDiagnostics
  totalChars: number
  maxChars?: number | undefined
  nearMaxChars: boolean
}

export interface ResolveContextTemplateOptions {
  includePrompt?: boolean | undefined
  includeReminder?: boolean | undefined
}

export interface ResolvedContextDetailed extends ResolvedContext {
  diagnostics: ResolvedContextDiagnostics
}

interface ResolvedZone {
  content: string | undefined
  sectionSizes: string[]
  totalChars: number
}

const MAX_CHARS_WARNING_RATIO = 0.9

export async function resolveContextTemplate(
  template: ContextTemplate,
  context: ContextResolverContext
): Promise<ResolvedContext> {
  const resolved = await resolveContextTemplateDetailed(template, context)

  return {
    prompt: resolved.prompt,
    reminder: resolved.reminder,
  }
}

export async function resolveContextTemplateDetailed(
  template: ContextTemplate,
  context: ContextResolverContext,
  options: ResolveContextTemplateOptions = {}
): Promise<ResolvedContextDetailed> {
  const includePrompt = options.includePrompt ?? true
  const includeReminder = options.includeReminder ?? true
  const prompt = includePrompt
    ? await resolveZone(template.promptSections, context, 'prompt')
    : emptyZone()
  const reminder = includeReminder
    ? await resolveZone(template.reminderSections, context, 'reminder')
    : emptyZone()

  const totalChars = enforceGlobalMaxChars(template, [prompt, reminder])

  return {
    prompt:
      prompt.content === undefined
        ? undefined
        : {
            content: prompt.content,
            mode: template.mode,
          },
    reminder: reminder.content,
    diagnostics: {
      prompt: {
        sectionSizes: prompt.sectionSizes,
        totalChars: prompt.totalChars,
      },
      reminder: {
        sectionSizes: reminder.sectionSizes,
        totalChars: reminder.totalChars,
      },
      totalChars,
      ...(template.maxChars !== undefined ? { maxChars: template.maxChars } : {}),
      nearMaxChars:
        template.maxChars !== undefined &&
        template.maxChars > 0 &&
        totalChars / template.maxChars >= MAX_CHARS_WARNING_RATIO,
    },
  }
}

async function resolveZone(
  sections: ContextTemplate['promptSections'],
  context: ContextResolverContext,
  zoneName: 'prompt' | 'reminder'
): Promise<ResolvedZone> {
  const resolvedSections: string[] = []
  const sectionSizes: string[] = []

  for (const section of sections) {
    if (!matchesWhenPredicate(section, context)) {
      continue
    }

    const content = await resolveSection(section, context)
    if (content === undefined || content.length === 0) {
      continue
    }

    const truncated = truncateSectionContent(content, section.maxChars)
    if (truncated.length === 0) {
      continue
    }

    resolvedSections.push(truncated)
    sectionSizes.push(`${zoneName}.${section.name}=${truncated.length}`)
  }

  if (resolvedSections.length === 0) {
    return {
      content: undefined,
      sectionSizes,
      totalChars: 0,
    }
  }

  const content = resolvedSections.join(SECTION_SEPARATOR)
  return {
    content,
    sectionSizes,
    totalChars: content.length,
  }
}

function emptyZone(): ResolvedZone {
  return {
    content: undefined,
    sectionSizes: [],
    totalChars: 0,
  }
}

function matchesWhenPredicate(section: ContextSection, context: ContextResolverContext): boolean {
  if (section.when?.runMode !== undefined && section.when.runMode !== context.runMode) {
    return false
  }

  if (section.when?.exists !== undefined) {
    return existsSync(join(process.cwd(), section.when.exists))
  }

  return true
}

async function resolveSection(
  section: ContextSection,
  context: ContextResolverContext
): Promise<string | undefined> {
  switch (section.type) {
    case 'file':
      return resolveFileSection(section, context)
    case 'inline': {
      const content = interpolateVariables(section.content, context)
      return content.length > 0 ? content : undefined
    }
    case 'exec':
      return resolveExecSection(section, context)
    case 'slot':
      return resolveSlotSection(section, context)
  }
}

async function resolveFileSection(
  section: FileSectionDef,
  context: ContextResolverContext
): Promise<string | undefined> {
  const filePath = resolveTemplateRef(section.path, context)
  const content = await readOptionalFile(filePath)

  if (content === undefined || content.length === 0) {
    if (section.required) {
      throw new Error(
        `Required context template file section "${section.name}" is missing: ${filePath}`
      )
    }
    return undefined
  }

  return content
}

async function resolveExecSection(
  section: ExecSectionDef,
  context: ContextResolverContext
): Promise<string | undefined> {
  const timeout = section.timeout ?? DEFAULT_EXEC_TIMEOUT_MS
  const cwd = context.agentRoot || context.agentsRoot

  try {
    const { stdout } = await execFileAsync('bash', ['-c', section.command], {
      cwd,
      timeout,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    const content = stdout.trim()
    return content.length > 0 ? content : undefined
  } catch {
    return undefined
  }
}

async function resolveSlotSection(
  section: Extract<ContextSection, { type: 'slot' }>,
  context: ContextResolverContext
): Promise<string | undefined> {
  if (section.source === undefined) {
    switch (section.name) {
      case 'additional-base':
        return resolveAdditionalBaseSlot(context)
      case 'scaffold':
        return resolveScaffoldSlot(context)
      default:
        return undefined
    }
  }

  if (section.source === 'scaffold') {
    return resolveScaffoldSlot(context)
  }

  const sourceValue = resolveSourcePath(context.agentProfile, section.source)
  if (sourceValue === undefined) {
    return undefined
  }

  const entries = normalizeStringEntries(sourceValue)
  if (entries === undefined || entries.length === 0) {
    return undefined
  }

  if (section.source.endsWith('Exec')) {
    return resolveCommandSlot(entries, context)
  }

  return resolveFileRefSlot(entries, context)
}

async function resolveAdditionalBaseSlot(
  context: ContextResolverContext
): Promise<string | undefined> {
  const refs = normalizeStringEntries(
    resolveSourcePath(context.agentProfile, 'instructions.additionalBase')
  )
  if (!refs || refs.length === 0) {
    return undefined
  }

  return resolveFileRefSlot(refs, context)
}

async function resolveScaffoldSlot(context: ContextResolverContext): Promise<string | undefined> {
  const packets = context.scaffoldPackets
  if (!packets || packets.length === 0) {
    return undefined
  }

  const contents: Array<string | undefined> = []
  for (const packet of packets) {
    if (packet.content && packet.content.length > 0) {
      contents.push(packet.content)
    }

    if (packet.ref) {
      const filePath = resolveTemplateRef(packet.ref, context)
      contents.push(await readOptionalFile(filePath))
    }
  }

  return joinResolvedContent(contents)
}

async function resolveFileRefSlot(
  refs: string[],
  context: ContextResolverContext
): Promise<string | undefined> {
  const contents: Array<string | undefined> = []

  for (const ref of refs) {
    const filePath = resolveTemplateRef(ref, context)
    contents.push(await readOptionalFile(filePath))
  }

  return joinResolvedContent(contents)
}

async function resolveCommandSlot(
  commands: string[],
  context: ContextResolverContext
): Promise<string | undefined> {
  const contents: Array<string | undefined> = []

  for (const command of commands) {
    contents.push(
      await resolveExecSection(
        {
          name: command,
          type: 'exec',
          command,
        },
        context
      )
    )
  }

  return joinCommandContent(contents)
}

function resolveSourcePath(root: Record<string, unknown> | undefined, source: string): unknown {
  if (!root) {
    return undefined
  }

  const segments = source.split('.').filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    return undefined
  }

  let current: unknown = root
  for (const segment of segments) {
    if (!isRecord(current) || !(segment in current)) {
      return undefined
    }
    current = current[segment]
  }

  return current
}

function normalizeStringEntries(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : undefined
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return undefined
  }

  const entries = value.filter((entry): entry is string => entry.length > 0)
  return entries.length > 0 ? [...entries] : undefined
}

function interpolateVariables(content: string, context: ContextResolverContext): string {
  const agentName = context.agentName ?? getAgentNameFromProfile(context.agentProfile) ?? ''
  const variables: Record<string, string> = {
    agent_name: agentName,
    agent_root: context.agentRoot,
    agents_root: context.agentsRoot,
    project_root: context.projectRoot ?? '',
    project_id: context.projectId ?? '',
    run_mode: context.runMode,
  }

  return content.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, variableName: string) =>
    variableName in variables ? (variables[variableName] ?? '') : match
  )
}

function getAgentNameFromProfile(profile: Record<string, unknown> | undefined): string | undefined {
  const agent = resolveSourcePath(profile, 'agent.name')
  return typeof agent === 'string' ? agent : undefined
}

function truncateSectionContent(content: string, maxChars?: number | undefined): string {
  if (maxChars === undefined || content.length <= maxChars) {
    return content
  }

  if (maxChars <= TRUNCATION_SUFFIX.length) {
    return TRUNCATION_SUFFIX.slice(0, maxChars)
  }

  return `${content.slice(0, maxChars - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`
}

function enforceGlobalMaxChars(template: ContextTemplate, zones: ResolvedZone[]): number {
  const totalChars = zones.reduce((sum, zone) => sum + zone.totalChars, 0)
  if (template.maxChars === undefined) {
    return totalChars
  }

  if (totalChars <= template.maxChars) {
    return totalChars
  }

  const sectionSizes = zones.flatMap((zone) => zone.sectionSizes)
  const details = sectionSizes.length > 0 ? ` Section sizes: ${sectionSizes.join(', ')}.` : ''

  throw new Error(
    `Resolved context template exceeds max_chars ${template.maxChars} (got ${totalChars}).${details}`
  )
}

function resolveTemplateRef(ref: string, context: ContextResolverContext): string {
  if (ref.startsWith('agent-root:///') || ref.startsWith('project-root:///')) {
    return resolveRootRelativeRef(ref, {
      agentRoot: context.agentRoot,
      projectRoot: context.projectRoot,
    })
  }

  return join(context.agentsRoot, ref)
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined
    }
    throw error
  }
}

function joinResolvedContent(contents: Array<string | undefined>): string | undefined {
  const resolved = contents.filter((content): content is string =>
    Boolean(content && content.length > 0)
  )
  if (resolved.length === 0) {
    return undefined
  }

  return resolved.join(SLOT_SEPARATOR)
}

function joinCommandContent(contents: Array<string | undefined>): string | undefined {
  const resolved = contents.filter((content): content is string =>
    Boolean(content && content.length > 0)
  )
  if (resolved.length === 0) {
    return undefined
  }

  return resolved.join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
