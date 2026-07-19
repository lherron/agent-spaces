import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import {
  type RunMode,
  type RunScaffoldPacket,
  getAgentRootSearchPathForProject,
  getAspHome,
} from 'spaces-config'
import type {
  AgentInspectionDisposition,
  AgentInspectionProvenance,
} from 'spaces-runtime-contracts'
import {
  type ResolvedContextDiagnostics,
  type ResolvedContextSection,
  resolveContextTemplateDetailed,
} from './context-resolver.js'
import {
  type ContextSection,
  type ContextTemplate,
  parseContextTemplate,
} from './context-template.js'
import type { SystemPromptMode } from './context-template.js'
import {
  type MaterializeResult,
  writeMaterializedContext,
  writeMaterializedPrompt,
} from './materialize-io.js'
import { isRecord } from './type-guards.js'

export interface MaterializeSystemPromptInput {
  agentRoot: string
  agentsRoot?: string | undefined
  aspHome?: string | undefined
  projectRoot?: string | undefined
  projectId?: string | undefined
  agentId?: string | undefined
  taskId?: string | undefined
  lane?: string | undefined
  runMode: RunMode
  scaffoldPackets?: RunScaffoldPacket[] | undefined
  env?: Record<string, string | undefined> | undefined
  agentRootSearchPath?: string[] | undefined
}

export interface TemplateDiscoveryProfile {
  template?: string | undefined
  additionalBase?: string[] | undefined
  rawProfile?: Record<string, unknown> | undefined
}

export type DiscoveredTemplateSource = {
  kind: 'context'
  path: string
  template: ContextTemplate
}

export interface DiscoverContextTemplateInput {
  agentRoot: string
  agentsRoot?: string | undefined
  aspHome?: string | undefined
  projectRoot?: string | undefined
  agentRootSearchPath?: string[] | undefined
}

export interface DiscoveredContextTemplate {
  agentsRoot: string
  agentRootSearchPath: string[]
  profile: TemplateDiscoveryProfile
  templateSource?: DiscoveredTemplateSource | undefined
  provenanceRecords: AgentCompilationProvenanceRecord[]
}

export interface AgentCompilationProvenanceRecord {
  partId: string
  sourceRef: string
  disposition: AgentInspectionDisposition
  provenance: AgentInspectionProvenance
  stage: 'template-discovery' | 'search-root-resolution'
  operation: 'select-template' | 'deduplicate-search-root'
  order: number
}

export interface InspectAgentSystemPromptInput extends MaterializeSystemPromptInput {}

export interface InspectedContextTemplateSource {
  kind: 'context' | 'built-in'
  path?: string | undefined
  mode: SystemPromptMode
  maxChars?: number | undefined
}

export interface InspectedPromptZone {
  content?: string | undefined
  totalChars: number
  sections: ResolvedContextSection[]
}

export interface InspectedSystemPromptZone extends InspectedPromptZone {
  content: string
  mode: SystemPromptMode
}

export interface AgentSystemPromptInspection {
  agentRoot: string
  agentsRoot: string
  agentName: string
  runMode: RunMode
  projectRoot?: string | undefined
  projectId?: string | undefined
  template: InspectedContextTemplateSource
  prompt: InspectedSystemPromptZone
  reminder: InspectedPromptZone
  diagnostics: ResolvedContextDiagnostics
  provenanceRecords: AgentCompilationProvenanceRecord[]
}

export function discoverContextTemplate(
  input: DiscoverContextTemplateInput
): DiscoveredContextTemplate {
  const aspHome = input.aspHome ?? getAspHome()
  const agentsRoot = input.agentsRoot ?? dirname(resolve(input.agentRoot))
  const searchRoots = resolveSharedAgentRootSearchPath({
    agentRoot: input.agentRoot,
    agentsRoot,
    projectRoot: input.projectRoot,
    agentsRootWasProvided: input.agentsRoot !== undefined,
    agentRootSearchPath: input.agentRootSearchPath,
  })
  const agentRootSearchPath = searchRoots.roots
  const profile = loadTemplateDiscoveryProfile(input.agentRoot)
  const templateDiscovery = loadSystemPromptTemplate({
    agentRoot: input.agentRoot,
    agentsRoot,
    agentRootSearchPath,
    aspHome,
    profileTemplateRef: profile.template,
  })

  return {
    agentsRoot,
    agentRootSearchPath,
    profile,
    templateSource: templateDiscovery.source,
    provenanceRecords: [...searchRoots.records, ...templateDiscovery.records],
  }
}

export async function materializeSystemPrompt(
  outputPath: string,
  input: MaterializeSystemPromptInput
): Promise<MaterializeResult | undefined> {
  const inspected = await inspectAgentSystemPrompt(input)
  if (inspected === undefined) {
    return undefined
  }

  const diagnostics =
    inspected.template.kind === 'context'
      ? {
          promptSectionSizes: inspected.diagnostics.prompt.sectionSizes,
          reminderSectionSizes: inspected.diagnostics.reminder.sectionSizes,
          totalContextChars: inspected.diagnostics.totalChars,
          nearMaxChars: inspected.diagnostics.nearMaxChars,
        }
      : {}

  if (inspected.template.kind === 'built-in') {
    return {
      ...writeMaterializedPrompt(outputPath, {
        content: inspected.prompt.content,
        mode: inspected.prompt.mode,
      }),
      ...diagnostics,
    }
  }

  return {
    ...writeMaterializedContext(outputPath, {
      content: inspected.prompt.content,
      mode: inspected.prompt.mode,
      reminderContent: inspected.reminder.content,
      maxChars: inspected.template.maxChars,
    }),
    ...diagnostics,
  }
}

export async function inspectAgentSystemPrompt(
  input: InspectAgentSystemPromptInput
): Promise<AgentSystemPromptInspection | undefined> {
  const discovered = discoverContextTemplate({
    agentRoot: input.agentRoot,
    agentsRoot: input.agentsRoot,
    aspHome: input.aspHome,
    projectRoot: input.projectRoot,
    agentRootSearchPath: input.agentRootSearchPath,
  })
  const { agentsRoot, agentRootSearchPath, profile, templateSource } = discovered

  if (!templateSource && !existsSync(join(input.agentRoot, 'SOUL.md'))) {
    return undefined
  }

  const template =
    templateSource?.template ?? buildDefaultTemplate(profile.additionalBase, input.scaffoldPackets)
  const resolved = await resolveContextTemplateDetailed(template, {
    agentRoot: input.agentRoot,
    agentName: basename(input.agentRoot),
    agentId: input.agentId ?? basename(input.agentRoot),
    agentsRoot,
    agentRootSearchPath,
    projectRoot: input.projectRoot,
    projectId: input.projectId,
    taskId: input.taskId,
    lane: input.lane,
    runMode: input.runMode,
    scaffoldPackets: input.scaffoldPackets,
    env: input.env,
    ...(templateSource
      ? { agentProfile: profile.rawProfile }
      : profile.additionalBase
        ? {
            agentProfile: {
              instructions: {
                additionalBase: profile.additionalBase,
              },
            },
          }
        : {}),
  })

  const promptContent = resolved.prompt?.content ?? ''
  const promptSections = resolved.promptSections

  return {
    agentRoot: input.agentRoot,
    agentsRoot,
    agentName: basename(input.agentRoot),
    runMode: input.runMode,
    ...(input.projectRoot !== undefined ? { projectRoot: input.projectRoot } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    template: {
      kind: templateSource?.kind ?? 'built-in',
      ...(templateSource?.path !== undefined ? { path: templateSource.path } : {}),
      mode: template.mode,
      ...(template.maxChars !== undefined ? { maxChars: template.maxChars } : {}),
    },
    prompt: {
      content: promptContent,
      mode: resolved.prompt?.mode ?? template.mode,
      totalChars: promptContent.length,
      sections: promptSections,
    },
    reminder: {
      ...(resolved.reminder !== undefined ? { content: resolved.reminder } : {}),
      totalChars: resolved.reminder?.length ?? 0,
      sections: resolved.reminderSections,
    },
    diagnostics: resolved.diagnostics,
    provenanceRecords: discovered.provenanceRecords,
  }
}

function loadSystemPromptTemplate(input: {
  agentRoot: string
  agentsRoot: string
  agentRootSearchPath: string[]
  aspHome: string
  profileTemplateRef?: string | undefined
}): { source: DiscoveredTemplateSource | undefined; records: AgentCompilationProvenanceRecord[] } {
  const searchPathTemplateRef = input.profileTemplateRef ?? 'context-template.toml'
  const searchPathCandidates =
    input.profileTemplateRef && isAbsolute(input.profileTemplateRef)
      ? []
      : input.agentRootSearchPath.map((root) => ({
          path: join(root, searchPathTemplateRef),
          required: false,
        }))
  const candidates = [
    ...buildProfileTemplateCandidates(input),
    !input.profileTemplateRef
      ? {
          path: join(input.agentRoot, 'context-template.toml'),
          required: false,
        }
      : undefined,
    ...searchPathCandidates,
    {
      path: join(input.aspHome, 'context-template.toml'),
      required: false,
    },
  ]

  const existingCandidates = candidates.filter(
    (candidate): candidate is { path: string; required: boolean } =>
      candidate !== undefined && existsSync(candidate.path)
  )
  const winner = existingCandidates[0]
  if (winner !== undefined) {
    const winnerPartId = 'template-candidate:0'
    return {
      source: parseTemplateFile(winner.path),
      records: existingCandidates.map((candidate, order) =>
        provenanceRecord({
          partId: `template-candidate:${order}`,
          sourceRef: candidate.path,
          disposition:
            order === 0 ? { kind: 'effective' } : { kind: 'overridden', byPartId: winnerPartId },
          stage: 'template-discovery',
          operation: 'select-template',
          order,
          contributionKind: 'template',
        })
      ),
    }
  }

  if (input.profileTemplateRef) {
    const searched = candidates
      .filter((candidate): candidate is { path: string; required: boolean } => Boolean(candidate))
      .map((candidate) => candidate.path)
      .join(', ')
    throw new Error(`Configured system prompt template not found. Searched: ${searched}`)
  }

  return { source: undefined, records: [] }
}

function buildProfileTemplateCandidates(input: {
  agentRoot: string
  profileTemplateRef?: string | undefined
}): Array<{ path: string; required: boolean } | undefined> {
  if (!input.profileTemplateRef) {
    return []
  }

  return [
    {
      path: isAbsolute(input.profileTemplateRef)
        ? input.profileTemplateRef
        : resolve(input.agentRoot, input.profileTemplateRef),
      required: false,
    },
  ]
}

function parseTemplateFile(filePath: string) {
  const fileContent = readFileSync(filePath, 'utf8')

  try {
    return {
      kind: 'context',
      path: filePath,
      template: parseContextTemplate(fileContent),
    } satisfies DiscoveredTemplateSource
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid system prompt template at ${filePath}: ${message}`)
  }
}

function loadTemplateDiscoveryProfile(agentRoot: string): TemplateDiscoveryProfile {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return {}
  }

  const parsed = parseToml(readFileSync(profilePath, 'utf8'))
  if (!isRecord(parsed)) {
    throw new Error(`Agent profile must parse to a TOML table: ${profilePath}`)
  }

  const instructions = parsed['instructions']
  if (!isRecord(instructions)) {
    return { rawProfile: parsed }
  }

  return {
    template: typeof instructions['template'] === 'string' ? instructions['template'] : undefined,
    additionalBase: parseStringArray(instructions['additionalBase']),
    rawProfile: parsed,
  }
}

function resolveSharedAgentRootSearchPath(input: {
  agentRoot: string
  agentsRoot: string
  projectRoot?: string | undefined
  agentsRootWasProvided?: boolean | undefined
  agentRootSearchPath?: string[] | undefined
}): { roots: string[]; records: AgentCompilationProvenanceRecord[] } {
  const roots = resolveInitialSharedAgentRoots(input)
  return dedupeRoots([...roots, input.agentsRoot, dirname(resolve(input.agentRoot))])
}

function resolveInitialSharedAgentRoots(input: {
  agentsRoot: string
  projectRoot?: string | undefined
  agentsRootWasProvided?: boolean | undefined
  agentRootSearchPath?: string[] | undefined
}): string[] {
  if (input.agentRootSearchPath?.length) {
    return input.agentRootSearchPath
  }

  if (input.projectRoot && !input.agentsRootWasProvided) {
    const searchPath = getAgentRootSearchPathForProject(input.projectRoot)
    const hasProjectOverlay = searchPath.entries.some((entry) => entry.kind === 'project')
    if (hasProjectOverlay) {
      return searchPath.roots
    }
  }

  return getAgentRootSearchPathForProject(input.projectRoot, {
    env: { ASP_AGENTS_ROOT: input.agentsRoot },
  }).roots
}

function dedupeRoots(roots: string[]): {
  roots: string[]
  records: AgentCompilationProvenanceRecord[]
} {
  const seen = new Map<string, string>()
  const result: string[] = []
  const records: AgentCompilationProvenanceRecord[] = []
  for (const [order, root] of roots.entries()) {
    const resolved = resolve(root)
    const canonicalPartId = seen.get(resolved)
    if (canonicalPartId !== undefined) {
      records.push(
        provenanceRecord({
          partId: `search-root:${order}`,
          sourceRef: root,
          disposition: { kind: 'deduplicated', canonicalPartId },
          stage: 'search-root-resolution',
          operation: 'deduplicate-search-root',
          order,
          contributionKind: 'compiler',
        })
      )
      continue
    }
    const partId = `search-root:${order}`
    seen.set(resolved, partId)
    result.push(root)
  }
  return { roots: result, records }
}

function provenanceRecord(input: {
  partId: string
  sourceRef: string
  disposition: AgentInspectionDisposition
  stage: AgentCompilationProvenanceRecord['stage']
  operation: AgentCompilationProvenanceRecord['operation']
  order: number
  contributionKind: 'template' | 'compiler'
}): AgentCompilationProvenanceRecord {
  return {
    partId: input.partId,
    sourceRef: input.sourceRef,
    disposition: input.disposition,
    provenance: {
      contributions: [
        {
          kind: input.contributionKind,
          sourceId: input.partId,
          sourceRef: input.sourceRef,
        },
      ],
    },
    stage: input.stage,
    operation: input.operation,
    order: input.order,
  }
}

function parseStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input) || input.some((value) => typeof value !== 'string')) {
    return undefined
  }

  return [...input]
}

/**
 * Build the built-in default context template directly as a `ContextTemplate`
 * object. (Previously this synthesized TOML text that was immediately re-parsed
 * by `parseContextTemplate`; constructing the object avoids that fragile
 * round-trip and the manual TOML quoting it required.)
 */
function buildDefaultTemplate(
  additionalBase: string[] | undefined,
  scaffoldPackets: RunScaffoldPacket[] | undefined
): ContextTemplate {
  const promptSections: ContextSection[] = [
    { name: 'soul', type: 'file', path: 'agent-root:///SOUL.md' },
    ...(additionalBase ?? []).map(
      (ref, index): ContextSection => ({
        name: `additional-base-${index}`,
        type: 'file',
        path: ref,
      })
    ),
    {
      name: 'heartbeat',
      type: 'file',
      path: 'agent-root:///HEARTBEAT.md',
      when: { runMode: 'heartbeat' },
    },
    ...buildScaffoldSections(scaffoldPackets),
  ]

  return {
    schemaVersion: 2,
    mode: 'replace',
    promptSections,
    reminderSections: [],
  }
}

function buildScaffoldSections(scaffoldPackets: RunScaffoldPacket[] | undefined): ContextSection[] {
  if (!scaffoldPackets) {
    return []
  }

  return scaffoldPackets.flatMap((packet, index): ContextSection[] => {
    const sections: ContextSection[] = []

    if (packet.content) {
      sections.push({
        name: `scaffold-inline-${index}`,
        type: 'inline',
        content: packet.content,
      })
    }

    if (packet.ref) {
      sections.push({ name: `scaffold-ref-${index}`, type: 'file', path: packet.ref })
    }

    return sections
  })
}
