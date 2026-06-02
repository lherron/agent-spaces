import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import { type RunMode, type RunScaffoldPacket, getAspHome } from 'spaces-config'
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
import { writeMaterializedContext, writeMaterializedPrompt } from './materialize-io.js'

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
}

export interface MaterializeResult {
  path: string
  content: string
  mode: SystemPromptMode
  reminderContent?: string | undefined
  maxChars?: number | undefined
  promptSectionSizes?: string[] | undefined
  reminderSectionSizes?: string[] | undefined
  totalContextChars?: number | undefined
  nearMaxChars?: boolean | undefined
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
}

export interface DiscoveredContextTemplate {
  agentsRoot: string
  profile: TemplateDiscoveryProfile
  templateSource?: DiscoveredTemplateSource | undefined
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
}

export function discoverContextTemplate(
  input: DiscoverContextTemplateInput
): DiscoveredContextTemplate {
  const aspHome = input.aspHome ?? getAspHome()
  const agentsRoot = input.agentsRoot ?? dirname(resolve(input.agentRoot))
  const profile = loadTemplateDiscoveryProfile(input.agentRoot)
  const templateSource = loadSystemPromptTemplate({
    agentRoot: input.agentRoot,
    agentsRoot,
    aspHome,
    profileTemplateRef: profile.template,
  })

  return {
    agentsRoot,
    profile,
    templateSource,
  }
}

export const discoverSystemPromptTemplate = discoverContextTemplate

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
  })
  const { agentsRoot, profile, templateSource } = discovered

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
    projectRoot: input.projectRoot,
    projectId: input.projectId,
    taskId: input.taskId,
    lane: input.lane,
    runMode: input.runMode,
    scaffoldPackets: input.scaffoldPackets,
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
  }
}

function loadSystemPromptTemplate(input: {
  agentRoot: string
  agentsRoot: string
  aspHome: string
  profileTemplateRef?: string | undefined
}): DiscoveredTemplateSource | undefined {
  const candidates = [
    input.profileTemplateRef
      ? {
          path: resolve(input.agentRoot, input.profileTemplateRef),
          required: true,
        }
      : undefined,
    {
      path: join(input.agentsRoot, 'context-template.toml'),
      required: false,
    },
    {
      path: join(input.aspHome, 'context-template.toml'),
      required: false,
    },
  ]

  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }

    if (!existsSync(candidate.path)) {
      if (candidate.required) {
        throw new Error(`Configured system prompt template not found: ${candidate.path}`)
      }
      continue
    }

    return parseTemplateFile(candidate.path)
  }

  return undefined
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

function parseStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input) || input.some((value) => typeof value !== 'string')) {
    return undefined
  }

  return [...input]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
