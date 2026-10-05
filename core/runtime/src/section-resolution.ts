/**
 * Resolve one context-template section's raw content by type (file, inline,
 * exec, slot, service-probe), classifying it as content, empty, or failed with
 * a bounded reason and per-contribution inspection records. Exec and service
 * probes honor the recorded-replay ledger.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  AgentInspectionDisposition,
  AgentInspectionFailureSource,
} from 'spaces-runtime-contracts'
import type { ContextResolverContext, ResolvedContextContribution } from './context-resolver.js'
import type { ContextSection, ExecSectionDef, FileSectionDef } from './context-template.js'
import { DynamicReplayError, type DynamicReplayLedger } from './dynamic-replay.js'
import { readFileOrUndefined } from './file-reader.js'
import { resolveServiceProbeSection } from './service-probe-resolver.js'
import { resolveTemplateRef } from './template-ref.js'
import { interpolateVariables } from './template-vars.js'
import { isRecord } from './type-guards.js'
import { matchesWhenPredicate } from './when-predicate.js'

const execFileAsync = promisify(execFile)
const DEFAULT_EXEC_TIMEOUT_MS = 5000
const SLOT_SEPARATOR = '\n\n'
const COMMAND_SEPARATOR = '\n'
const EXEC_MAX_BUFFER_BYTES = 1024 * 1024
const FAILURE_REASON_MAX_CHARS = 8192

export type SectionResolution =
  | { kind: 'content'; content: string; contributionRecords: ResolvedContextContribution[] }
  | { kind: 'empty'; contributionRecords: ResolvedContextContribution[] }
  | {
      kind: 'failed'
      source: AgentInspectionFailureSource
      reason: string
      contributionRecords: ResolvedContextContribution[]
    }

export async function resolveSection(
  section: ContextSection,
  context: ContextResolverContext,
  replay: DynamicReplayLedger
): Promise<SectionResolution> {
  switch (section.type) {
    case 'file':
      return resolveFileSection(section, context)
    case 'inline': {
      const content =
        section.parts === undefined
          ? interpolateVariables(section.content, context)
          : section.parts
              .filter((part) => matchesWhenPredicate(part, context))
              .map((part) => interpolateVariables(part.content, context))
              .join('\n')
      return asSectionResolution(content.length > 0 ? content : undefined)
    }
    case 'exec':
      return resolveExecSection(section, context, replay)
    case 'slot':
      return resolveSlotSection(section, context, replay)
    case 'service-probe':
      try {
        return asSectionResolution(await resolveServiceProbeSection(section, context, replay))
      } catch (error) {
        if (error instanceof DynamicReplayError) throw error
        return {
          kind: 'failed',
          source: { kind: 'service-probe', services: section.services.map(({ name }) => name) },
          reason: boundedReason(`Service probe execution failed: ${errorMessage(error)}`),
          contributionRecords: [],
        }
      }
  }
}

async function resolveFileSection(
  section: FileSectionDef,
  context: ContextResolverContext
): Promise<SectionResolution> {
  let filePath: string
  let content: string | undefined
  try {
    filePath = resolveTemplateRef(section.path, context)
    content = await readFileOrUndefined(filePath)
  } catch (error) {
    if (section.required) {
      throw error
    }
    return {
      kind: 'failed',
      source: { kind: 'file', ref: section.path },
      reason: boundedReason(`Unreadable context file ${section.path}: ${errorMessage(error)}`),
      contributionRecords: [],
    }
  }

  if (content === undefined || content.length === 0) {
    if (section.required) {
      throw new Error(
        `Required context template file section "${section.name}" is missing: ${filePath}`
      )
    }
    return asSectionResolution(undefined)
  }

  const interpolated = interpolateVariables(content, context)
  return asSectionResolution(interpolated.length > 0 ? interpolated : undefined)
}

async function resolveExecSection(
  section: ExecSectionDef,
  context: ContextResolverContext,
  replay: DynamicReplayLedger
): Promise<SectionResolution> {
  const replayed = replay.consumeExec(section.name, section.command)
  if (replayed !== undefined) {
    if (replayed.exitStatus !== 0) {
      return {
        kind: 'failed',
        source: { kind: 'exec', command: section.command },
        reason: formatExecFailure({
          code: replayed.exitStatus,
          signal: 'none',
          killed: false,
          stderr: replayed.stderr,
        }),
        contributionRecords: [],
      }
    }
    const content = replayed.stdout.trim()
    return asSectionResolution(content.length > 0 ? content : undefined)
  }
  const timeout = section.timeout ?? DEFAULT_EXEC_TIMEOUT_MS
  const cwd = context.execCwd ?? context.agentRoot ?? context.agentsRoot

  try {
    const { stdout } = await execFileAsync('bash', ['-c', section.command], {
      cwd,
      ...(context.execEnv !== undefined ? { env: context.execEnv } : {}),
      timeout,
      encoding: 'utf8',
      maxBuffer: EXEC_MAX_BUFFER_BYTES,
      windowsHide: true,
    })
    const content = stdout.trim()
    return asSectionResolution(content.length > 0 ? content : undefined)
  } catch (error) {
    if (error instanceof DynamicReplayError) throw error
    return {
      kind: 'failed',
      source: { kind: 'exec', command: section.command },
      reason: formatExecFailure(error),
      contributionRecords: [],
    }
  }
}

async function resolveSlotSection(
  section: Extract<ContextSection, { type: 'slot' }>,
  context: ContextResolverContext,
  replay: DynamicReplayLedger
): Promise<SectionResolution> {
  // The parser requires `source` for every slot section (context-template.ts
  // parseSection: parseRequiredString(input['source'])), so a sourceless slot is
  // unreachable by construction; the optional type is retained only for shape parity.
  if (section.source === undefined) {
    return failedSlotResolution(
      section.name,
      `Slot section ${section.name} has no resolvable source`
    )
  }

  const sourceValue = resolveSourcePath(context.agentProfile, section.source)
  if (sourceValue === undefined) {
    return asSectionResolution(undefined)
  }

  const entries = normalizeStringEntries(sourceValue)
  if (entries === undefined) {
    return failedSlotResolution(
      section.source,
      `Slot source ${section.source} must resolve to a string or string array`
    )
  }
  if (entries.length === 0) {
    return asSectionResolution(undefined)
  }

  if (section.source.endsWith('Exec')) {
    return resolveCommandSlot(entries, context, replay, section.source)
  }

  return resolveFileRefSlot(entries, context, section.source)
}

async function resolveFileRefSlot(
  refs: string[],
  context: ContextResolverContext,
  slotSource: string
): Promise<SectionResolution> {
  const contents: Array<string | undefined> = []
  const contributionRecords: ResolvedContextContribution[] = []

  for (const [order, ref] of refs.entries()) {
    try {
      const filePath = resolveTemplateRef(ref, context)
      const content = await readFileOrUndefined(filePath)
      const resolved = content === undefined ? undefined : interpolateVariables(content, context)
      contents.push(resolved)
      contributionRecords.push(
        slotContributionRecord(
          slotSource,
          ref,
          order,
          'resolve-slot-file',
          resolved === undefined || resolved.length === 0
            ? { kind: 'skipped', reason: 'empty' }
            : { kind: 'effective' }
        )
      )
    } catch (error) {
      contents.push(undefined)
      contributionRecords.push(
        slotContributionRecord(slotSource, ref, order, 'resolve-slot-file', {
          kind: 'failed',
          source: { kind: 'file', ref },
          reason: boundedReason(`Unreadable slot file ${ref}: ${errorMessage(error)}`),
        })
      )
    }
  }

  return slotAggregateResolution(
    slotSource,
    joinNonEmpty(contents, SLOT_SEPARATOR),
    contributionRecords
  )
}

async function resolveCommandSlot(
  commands: string[],
  context: ContextResolverContext,
  replay: DynamicReplayLedger,
  slotSource: string
): Promise<SectionResolution> {
  const contents: Array<string | undefined> = []
  const contributionRecords: ResolvedContextContribution[] = []

  for (const [order, command] of commands.entries()) {
    const resolution = await resolveExecSection(
      {
        name: command,
        type: 'exec',
        command,
      },
      context,
      replay
    )
    contents.push(sectionResolutionContent(resolution))
    contributionRecords.push(
      slotContributionRecord(
        slotSource,
        command,
        order,
        'resolve-slot-exec',
        resolution.kind === 'content'
          ? { kind: 'effective' }
          : resolution.kind === 'empty'
            ? { kind: 'skipped', reason: 'empty' }
            : { kind: 'failed', source: resolution.source, reason: resolution.reason }
      )
    )
  }

  return slotAggregateResolution(
    slotSource,
    joinNonEmpty(contents, COMMAND_SEPARATOR),
    contributionRecords
  )
}

function asSectionResolution(
  content: string | undefined,
  contributionRecords: ResolvedContextContribution[] = []
): SectionResolution {
  return content === undefined || content.length === 0
    ? { kind: 'empty', contributionRecords }
    : { kind: 'content', content, contributionRecords }
}

function sectionResolutionContent(resolution: SectionResolution): string | undefined {
  return resolution.kind === 'content' ? resolution.content : undefined
}

function failedSlotResolution(source: string, reason: string): SectionResolution {
  return {
    kind: 'failed',
    source: { kind: 'slot', source },
    reason: boundedReason(reason),
    contributionRecords: [],
  }
}

function slotAggregateResolution(
  slotSource: string,
  content: string | undefined,
  contributionRecords: ResolvedContextContribution[]
): SectionResolution {
  if (content !== undefined) {
    return asSectionResolution(content, contributionRecords)
  }
  const failures = contributionRecords.filter(({ disposition }) => disposition.kind === 'failed')
  if (failures.length > 0) {
    return {
      kind: 'failed',
      source: { kind: 'slot', source: slotSource },
      reason: boundedReason(
        `Slot source ${slotSource} failed to resolve ${failures.length} contribution(s): ${failures
          .map(({ disposition }) => (disposition.kind === 'failed' ? disposition.reason : ''))
          .join('; ')}`
      ),
      contributionRecords,
    }
  }
  return asSectionResolution(undefined, contributionRecords)
}

function slotContributionRecord(
  slotSource: string,
  sourceRef: string,
  order: number,
  operation: ResolvedContextContribution['operation'],
  disposition: AgentInspectionDisposition
): ResolvedContextContribution {
  const partId = `slot-contribution:${slotSource}/${order}`
  return {
    partId,
    source: sourceRef,
    disposition,
    provenance: {
      contributions: [{ kind: 'template', sourceId: partId, sourceRef }],
    },
    stage: 'context-resolution',
    operation,
    order,
  }
}

function formatExecFailure(error: unknown): string {
  const details = isRecord(error) ? error : {}
  const exitCode = details['code'] ?? 'unknown'
  const signal = details['signal'] ?? 'none'
  const timeout = details['killed'] === true
  const stderr = textValue(details['stderr']) || errorMessage(error)
  return boundedReason(
    `Exec failed; exit code: ${String(exitCode)}; signal: ${String(signal)}; timeout: ${String(timeout)}; stderr: ${stderr}`
  )
}

function boundedReason(reason: string): string {
  return reason.slice(0, FAILURE_REASON_MAX_CHARS)
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    return value.length > 0 ? [value] : []
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return undefined
  }

  const entries = value.filter((entry): entry is string => entry.length > 0)
  return [...entries]
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
