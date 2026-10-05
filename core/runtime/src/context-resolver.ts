import type {
  AgentInspectionDisposition,
  AgentInspectionProvenance,
  HrcTaskContext,
} from 'spaces-runtime-contracts'
import type {
  ContextSection,
  ContextSectionType,
  ContextTemplate,
  SectionWrap,
  SystemPromptMode,
  WhenPredicate,
} from './context-template.js'
import {
  DynamicReplayLedger,
  type RecordedExecResult,
  type RecordedServiceProbeResponse,
} from './dynamic-replay.js'
import { resolveSection } from './section-resolution.js'
import { resolveTemplateRef } from './template-ref.js'
import { interpolateVariables } from './template-vars.js'
import { matchesWhenPredicate } from './when-predicate.js'

const SECTION_SEPARATOR = '\n\n---\n\n'
const TRUNCATION_MARKER = '[truncated]'

export interface ContextResolverContext {
  agentRoot: string
  agentsRoot: string
  agentRootSearchPath?: string[] | undefined
  projectRoot?: string | undefined
  projectId?: string | undefined
  agentId?: string | undefined
  agentName?: string | undefined
  taskId?: string | undefined
  /**
   * Producer-structured task context (T-09860). Supplies typed task prompt
   * facts only; it never changes `taskId` or any identity-derived variable.
   */
  taskContext?: HrcTaskContext | undefined
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
  /** Inspection-only pinned base directory for predicate path checks. */
  predicateCwd?: string | undefined
  /** Inspection-only pinned environment for predicate checks. */
  predicateEnv?: Record<string, string | undefined> | undefined
  /** Inspection-only pinned working directory for exec sections. */
  execCwd?: string | undefined
  /** Inspection-only pinned environment for exec sections. */
  execEnv?: Record<string, string | undefined> | undefined
  /** Recorded exec outcomes; presence disables live command execution. */
  execResults?: RecordedExecResult[] | undefined
  /** Inspection-only recorded service outcomes; presence disables live probes. */
  serviceProbeResponses?: RecordedServiceProbeResponse[] | undefined
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
  partId: string
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
  disposition: AgentInspectionDisposition
  provenance: AgentInspectionProvenance
  stage: 'context-resolution'
  operation: string
  order: number
  contributionRecords: ResolvedContextContribution[]
}

export interface ResolvedContextContribution {
  partId: string
  source: string
  disposition: AgentInspectionDisposition
  provenance: AgentInspectionProvenance
  stage: 'context-resolution'
  operation: 'resolve-slot-file' | 'resolve-slot-exec'
  order: number
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
  /**
   * Present only when a task-scoped section (one gated by `when.taskField`)
   * was included (T-09860). `prompt` / `reminder` are each zone joined WITHOUT
   * task-scoped sections — byte-identical to what the zone renders with no
   * task facts — and `content` is the included task-scoped sections joined.
   * Harnesses whose prompt lands in a home shared across tasks use this to
   * deliver task-scoped content per invocation instead.
   */
  taskScoped?: ResolvedTaskScopedSplit | undefined
}

export interface ResolvedTaskScopedSplit {
  content: string
  prompt: string | undefined
  reminder: string | undefined
}

interface ResolvedZone {
  content: string | undefined
  /** The zone joined without task-scoped sections. */
  invariantContent: string | undefined
  /** Included task-scoped section contents, in order. */
  taskScopedContents: string[]
  sectionSizes: string[]
  totalChars: number
  sections: ResolvedContextSection[]
}

const MAX_CHARS_WARNING_RATIO = 0.9

export async function resolveContextTemplateDetailed(
  template: ContextTemplate,
  context: ContextResolverContext,
  options: ResolveContextTemplateOptions = {}
): Promise<ResolvedContextDetailed> {
  const replay = new DynamicReplayLedger(context.execResults, context.serviceProbeResponses)
  const includePrompt = options.includePrompt ?? true
  const includeReminder = options.includeReminder ?? true
  const prompt = includePrompt
    ? await resolveZone(template.promptSections, context, replay, 'prompt')
    : emptyZone()
  const reminder = includeReminder
    ? await resolveZone(template.reminderSections, context, replay, 'reminder')
    : emptyZone()

  replay.assertFullyConsumed()

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
    ...taskScopedSplit(prompt, reminder),
  }
}

function taskScopedSplit(
  prompt: ResolvedZone,
  reminder: ResolvedZone
): { taskScoped?: ResolvedTaskScopedSplit } {
  const contents = [...prompt.taskScopedContents, ...reminder.taskScopedContents]
  if (contents.length === 0) return {}
  return {
    taskScoped: {
      content: contents.join(SECTION_SEPARATOR),
      prompt: prompt.invariantContent,
      reminder: reminder.invariantContent,
    },
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
  replay: DynamicReplayLedger,
  zoneName: ResolvedContextZoneName,
  order: number
): Promise<ResolvedSectionOutcome> {
  const base = sectionReportBase(section, context, zoneName, order)

  if (!matchesWhenPredicate(section, context)) {
    return {
      included: false,
      report: {
        ...base,
        skippedReason: 'when',
        disposition: { kind: 'skipped', reason: 'predicate' },
      },
    }
  }

  const resolution = await resolveSection(section, context, replay)
  if (resolution.kind === 'failed') {
    return {
      included: false,
      report: {
        ...base,
        contributionRecords: resolution.contributionRecords,
        disposition: {
          kind: 'failed',
          source: resolution.source,
          reason: resolution.reason,
        },
      },
    }
  }
  if (resolution.kind === 'empty') {
    return {
      included: false,
      report: {
        ...base,
        contributionRecords: resolution.contributionRecords,
        skippedReason: 'empty',
        disposition: { kind: 'skipped', reason: 'empty' },
      },
    }
  }
  const content = resolution.content

  const wrapResult = applyWrap(content, section.wrap, context)
  const wasTruncated =
    section.maxChars !== undefined && wrapResult.content.length > section.maxChars
  const truncated = truncateSectionContent(wrapResult.content, section.maxChars)
  if (truncated.length === 0) {
    return {
      included: false,
      report: {
        ...base,
        contributionRecords: resolution.contributionRecords,
        skippedReason: 'empty',
        disposition: { kind: 'skipped', reason: 'empty' },
      },
    }
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
      disposition: { kind: 'effective' },
      contributionRecords: resolution.contributionRecords,
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
  replay: DynamicReplayLedger,
  zoneName: ResolvedContextZoneName
): Promise<ResolvedZone> {
  const resolvedSections: string[] = []
  const invariantSections: string[] = []
  const taskScopedContents: string[] = []
  const sectionSizes: string[] = []
  const inspectedSections: ResolvedContextSection[] = []

  for (const [order, section] of sections.entries()) {
    const outcome = await resolveZoneSection(section, context, replay, zoneName, order)
    inspectedSections.push(outcome.report)
    if (!outcome.included) {
      continue
    }

    resolvedSections.push(outcome.content)
    if (section.when?.taskField !== undefined) {
      taskScopedContents.push(outcome.content)
    } else {
      invariantSections.push(outcome.content)
    }
    sectionSizes.push(`${zoneName}.${section.name}=${outcome.content.length}`)
  }

  const invariantContent =
    invariantSections.length > 0 ? invariantSections.join(SECTION_SEPARATOR) : undefined
  if (resolvedSections.length === 0) {
    return {
      content: undefined,
      invariantContent,
      taskScopedContents,
      sectionSizes,
      totalChars: 0,
      sections: inspectedSections,
    }
  }

  const content = resolvedSections.join(SECTION_SEPARATOR)
  return {
    content,
    invariantContent,
    taskScopedContents,
    sectionSizes,
    totalChars: content.length,
    sections: inspectedSections,
  }
}

function emptyZone(): ResolvedZone {
  return {
    content: undefined,
    invariantContent: undefined,
    taskScopedContents: [],
    sectionSizes: [],
    totalChars: 0,
    sections: [],
  }
}

function sectionReportBase(
  section: ContextSection,
  context: ContextResolverContext,
  zone: ResolvedContextZoneName,
  order: number
): ResolvedContextSection {
  const partId = `context-section:${zone}/${order}/${section.name}`
  const source = describeSectionSource(section, context)
  return {
    partId,
    zone,
    name: section.name,
    type: section.type,
    source,
    included: false,
    chars: 0,
    bytes: 0,
    truncated: false,
    wrapped: false,
    disposition: { kind: 'skipped', reason: 'empty' },
    provenance: {
      contributions: [{ kind: 'template', sourceId: partId, sourceRef: source }],
    },
    stage: 'context-resolution',
    operation: `resolve-${section.type}`,
    order,
    contributionRecords: [],
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
