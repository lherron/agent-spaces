import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveRootRelativeRef } from 'spaces-config'
import type {
  ContextSection,
  ContextSectionType,
  ContextTemplate,
  ExecSectionDef,
  FileSectionDef,
  SectionWrap,
  SystemPromptMode,
  WhenPredicate,
} from './context-template.js'
import { readFileOrUndefined } from './file-reader.js'
import { resolveServiceProbeSection } from './service-probe-resolver.js'
import { interpolateVariables } from './template-vars.js'
import { isRecord } from './type-guards.js'

const execFileAsync = promisify(execFile)
const DEFAULT_EXEC_TIMEOUT_MS = 5000
const SECTION_SEPARATOR = '\n\n---\n\n'
const SLOT_SEPARATOR = '\n\n'
const COMMAND_SEPARATOR = '\n'
const TRUNCATION_MARKER = '[truncated]'
const EXEC_MAX_BUFFER_BYTES = 1024 * 1024

export interface ContextResolverContext {
  agentRoot: string
  agentsRoot: string
  projectRoot?: string | undefined
  projectId?: string | undefined
  agentId?: string | undefined
  agentName?: string | undefined
  taskId?: string | undefined
  lane?: string | undefined
  runMode: string
  scaffoldPackets?:
    | Array<{
        slot: string
        content?: string | undefined
        ref?: string | undefined
      }>
    | undefined
  agentProfile?: Record<string, unknown> | undefined
  now?: Date | undefined
  env?: Record<string, string | undefined> | undefined
  /**
   * Base directory `when.exists` predicates resolve relative paths against.
   * Defaults to `process.cwd()`; inject it to make `when.exists` deterministic
   * instead of dependent on the caller's ambient working directory.
   */
  cwd?: string | undefined
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

export type ResolvedContextZoneName = 'prompt' | 'reminder'

export interface ResolvedContextSection {
  zone: ResolvedContextZoneName
  name: string
  type: ContextSectionType
  source: string
  included: boolean
  chars: number
  bytes: number
  truncated: boolean
  wrapped?: boolean | undefined
  when?: WhenPredicate | undefined
  maxChars?: number | undefined
  content?: string | undefined
  skippedReason?: 'when' | 'empty' | undefined
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
  promptSections: ResolvedContextSection[]
  reminderSections: ResolvedContextSection[]
}

interface ResolvedZone {
  content: string | undefined
  sectionSizes: string[]
  totalChars: number
  sections: ResolvedContextSection[]
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
    promptSections: prompt.sections,
    reminderSections: reminder.sections,
  }
}

type ResolvedSectionOutcome =
  | { included: false; report: ResolvedContextSection }
  | { included: true; report: ResolvedContextSection; content: string }

/**
 * Resolve a single section to either a "skipped" outcome (with the reason
 * recorded on its inspection report) or an "included" outcome carrying the
 * final, wrapped-and-truncated content. Pure with respect to zone aggregation —
 * the caller owns joining and size accounting.
 */
async function resolveZoneSection(
  section: ContextSection,
  context: ContextResolverContext,
  zoneName: ResolvedContextZoneName
): Promise<ResolvedSectionOutcome> {
  const base = sectionReportBase(section, context, zoneName)

  if (!matchesWhenPredicate(section, context)) {
    return { included: false, report: { ...base, skippedReason: 'when' } }
  }

  const content = await resolveSection(section, context)
  if (content === undefined || content.length === 0) {
    return { included: false, report: { ...base, skippedReason: 'empty' } }
  }

  const wrapResult = applyWrap(content, section.wrap, context)
  const wasTruncated =
    section.maxChars !== undefined && wrapResult.content.length > section.maxChars
  const truncated = truncateSectionContent(wrapResult.content, section.maxChars)
  if (truncated.length === 0) {
    return { included: false, report: { ...base, skippedReason: 'empty' } }
  }

  return {
    included: true,
    content: truncated,
    report: {
      ...base,
      included: true,
      chars: truncated.length,
      bytes: byteCount(truncated),
      truncated: wasTruncated,
      wrapped: wrapResult.wrapped,
      content: truncated,
    },
  }
}

/**
 * Resolve every section in a zone (prompt or reminder), accumulating included
 * content, per-section size labels, and full inspection reports. Returns a zone
 * with `content: undefined` when no section produced content.
 */
async function resolveZone(
  sections: ContextTemplate['promptSections'],
  context: ContextResolverContext,
  zoneName: ResolvedContextZoneName
): Promise<ResolvedZone> {
  const resolvedSections: string[] = []
  const sectionSizes: string[] = []
  const inspectedSections: ResolvedContextSection[] = []

  for (const section of sections) {
    const outcome = await resolveZoneSection(section, context, zoneName)
    inspectedSections.push(outcome.report)
    if (!outcome.included) {
      continue
    }

    resolvedSections.push(outcome.content)
    sectionSizes.push(`${zoneName}.${section.name}=${outcome.content.length}`)
  }

  if (resolvedSections.length === 0) {
    return {
      content: undefined,
      sectionSizes,
      totalChars: 0,
      sections: inspectedSections,
    }
  }

  const content = resolvedSections.join(SECTION_SEPARATOR)
  return {
    content,
    sectionSizes,
    totalChars: content.length,
    sections: inspectedSections,
  }
}

function emptyZone(): ResolvedZone {
  return {
    content: undefined,
    sectionSizes: [],
    totalChars: 0,
    sections: [],
  }
}

function sectionReportBase(
  section: ContextSection,
  context: ContextResolverContext,
  zone: ResolvedContextZoneName
): ResolvedContextSection {
  return {
    zone,
    name: section.name,
    type: section.type,
    source: describeSectionSource(section, context),
    included: false,
    chars: 0,
    bytes: 0,
    truncated: false,
    wrapped: false,
    ...(section.when !== undefined ? { when: section.when } : {}),
    ...(section.maxChars !== undefined ? { maxChars: section.maxChars } : {}),
  }
}

function describeSectionSource(section: ContextSection, context: ContextResolverContext): string {
  switch (section.type) {
    case 'inline':
      return 'inline content'
    case 'exec':
      return `exec: ${section.command}`
    case 'slot':
      return section.source === undefined ? `slot: ${section.name}` : `slot: ${section.source}`
    case 'service-probe':
      return `service-probe: ${section.services.map((s) => s.name).join(', ')}`
    case 'file': {
      try {
        return `${section.path} -> ${resolveTemplateRef(section.path, context)}`
      } catch {
        return `file: ${section.path}`
      }
    }
  }
}

/**
 * Evaluate a section's optional `when` predicate. A section is included only if
 * ALL declared conditions hold (runMode match, path existence, and env
 * set/equals/not-equals checks). A section without a predicate always matches.
 */
function matchesWhenPredicate(section: ContextSection, context: ContextResolverContext): boolean {
  const when = section.when
  if (when === undefined) {
    return true
  }

  if (when.runMode !== undefined && when.runMode !== context.runMode) {
    return false
  }

  if (when.exists !== undefined && !existsSync(join(context.cwd ?? process.cwd(), when.exists))) {
    return false
  }

  const env = context.env ?? process.env

  if (when.envSet !== undefined) {
    const value = env[when.envSet]
    if (typeof value !== 'string' || value.trim().length === 0) {
      return false
    }
  }

  if (when.envEquals !== undefined) {
    const value = env[when.envEquals.name]
    if (value !== when.envEquals.value) {
      return false
    }
  }

  if (when.envNotEquals !== undefined) {
    const value = env[when.envNotEquals.name]
    if (value === when.envNotEquals.value) {
      return false
    }
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
    case 'service-probe':
      return resolveServiceProbeSection(section, context)
  }
}

async function resolveFileSection(
  section: FileSectionDef,
  context: ContextResolverContext
): Promise<string | undefined> {
  const filePath = resolveTemplateRef(section.path, context)
  const content = await readFileOrUndefined(filePath)

  if (content === undefined || content.length === 0) {
    if (section.required) {
      throw new Error(
        `Required context template file section "${section.name}" is missing: ${filePath}`
      )
    }
    return undefined
  }

  return interpolateVariables(content, context)
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
      maxBuffer: EXEC_MAX_BUFFER_BYTES,
      windowsHide: true,
    })
    const content = stdout.trim()
    return content.length > 0 ? content : undefined
  } catch {
    // Intentional: an exec section that fails (non-zero exit, timeout, missing
    // command) contributes no content rather than aborting prompt assembly.
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
      contents.push(interpolateVariables(packet.content, context))
    }

    if (packet.ref) {
      const filePath = resolveTemplateRef(packet.ref, context)
      const content = await readFileOrUndefined(filePath)
      contents.push(content === undefined ? undefined : interpolateVariables(content, context))
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
    const content = await readFileOrUndefined(filePath)
    contents.push(content === undefined ? undefined : interpolateVariables(content, context))
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

/**
 * Expand `{{name}}` references in arbitrary text using the same variable map
 * the system-prompt resolver uses. Public surface — re-exported from the
 * package root and intended for priming prompts and other launch-time strings.
 *
 * Variable rules:
 * - `{{env.FOO}}` resolves to `context.env?.[FOO] ?? process.env.FOO`.
 *   Unset or non-string env values render as the empty string. The value is
 *   not trimmed (`{{env.FOO}}` with `FOO=" "` renders the space verbatim).
 * - Built-in variables (`agent_name`, `project_id`, `task_id`, `lane`,
 *   `scope_ref`, `handle`, ...) render from the resolver context.
 * - Any other `{{name}}` token (unknown non-env variable) is left verbatim
 *   in the output, so authors can pass through literal mustache-like text.
 */
export function expandTemplate(content: string, context: ContextResolverContext): string {
  return interpolateVariables(content, context)
}

function applyWrap(
  content: string,
  wrap: SectionWrap | undefined,
  context: ContextResolverContext
): { content: string; wrapped: boolean } {
  if (wrap === undefined) {
    return { content, wrapped: false }
  }

  const prefix = interpolateVariables(wrap.prefix ?? '', context)
  const suffix = interpolateVariables(wrap.suffix ?? '', context)
  if (prefix.length === 0 && suffix.length === 0) {
    return { content, wrapped: false }
  }

  return {
    content: `${prefix}${content}${suffix}`,
    wrapped: true,
  }
}

function truncateSectionContent(content: string, maxChars?: number | undefined): string {
  if (maxChars === undefined || content.length <= maxChars) {
    return content
  }

  if (maxChars <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, maxChars)
  }

  if (maxChars === TRUNCATION_MARKER.length + 1) {
    return TRUNCATION_MARKER
  }

  const keepChars = maxChars - TRUNCATION_MARKER.length
  const keptContent =
    content[keepChars] === '\n' ? content.slice(0, keepChars + 1) : content.slice(0, keepChars)

  return `${keptContent}${TRUNCATION_MARKER}`
}

function byteCount(value: string): number {
  return new TextEncoder().encode(value).length
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

  // Interpolate template variables in file paths (e.g. {{agentRoot}}/memory/MEMORY.md)
  const interpolated = interpolateVariables(ref, context)
  if (interpolated !== ref && isAbsolute(interpolated)) {
    return interpolated
  }

  return join(context.agentsRoot, interpolated)
}

function joinNonEmpty(contents: Array<string | undefined>, separator: string): string | undefined {
  const resolved = contents.filter((content): content is string =>
    Boolean(content && content.length > 0)
  )
  if (resolved.length === 0) {
    return undefined
  }

  return resolved.join(separator)
}

function joinResolvedContent(contents: Array<string | undefined>): string | undefined {
  return joinNonEmpty(contents, SLOT_SEPARATOR)
}

function joinCommandContent(contents: Array<string | undefined>): string | undefined {
  return joinNonEmpty(contents, COMMAND_SEPARATOR)
}
