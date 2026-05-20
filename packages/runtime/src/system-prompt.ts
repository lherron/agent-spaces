import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import { type RunMode, type RunScaffoldPacket, getAspHome } from 'spaces-config'
import {
  type ResolvedContextDiagnostics,
  type ResolvedContextSection,
  resolveContextTemplateDetailed,
} from './context-resolver.js'
import { type ContextTemplate, parseContextTemplate } from './context-template.js'
import type { SystemPromptMode } from './context-template.js'

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

  if (inspected.template.kind === 'built-in') {
    return writeMaterializedPrompt(outputPath, {
      content: inspected.prompt.content,
      mode: inspected.prompt.mode,
    })
  }

  return writeMaterializedContext(outputPath, {
    content: inspected.prompt.content,
    mode: inspected.prompt.mode,
    reminderContent: inspected.reminder.content,
    maxChars: inspected.template.maxChars,
  })
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
    templateSource?.template ??
    parseContextTemplate(buildDefaultTemplateToml(profile.additionalBase, input.scaffoldPackets))
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

function writeMaterializedPrompt(
  outputPath: string,
  prompt: { content: string; mode: SystemPromptMode }
): MaterializeResult {
  const promptPath = join(outputPath, 'system-prompt.md')
  mkdirSync(outputPath, { recursive: true })
  writeFileSync(promptPath, prompt.content, 'utf8')

  return {
    path: promptPath,
    content: prompt.content,
    mode: prompt.mode,
  }
}

function writeMaterializedContext(
  outputPath: string,
  prompt: {
    content: string
    mode: SystemPromptMode
    reminderContent: string | undefined
    maxChars?: number | undefined
  }
): MaterializeResult {
  const promptPath = join(outputPath, 'system-prompt.md')
  const reminderPath = join(outputPath, 'session-reminder.md')
  mkdirSync(outputPath, { recursive: true })
  writeFileSync(promptPath, prompt.content, 'utf8')
  writeFileSync(reminderPath, prompt.reminderContent ?? '', 'utf8')

  return {
    path: promptPath,
    content: prompt.content,
    mode: prompt.mode,
    reminderContent: prompt.reminderContent,
    ...(prompt.maxChars !== undefined ? { maxChars: prompt.maxChars } : {}),
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

function buildDefaultTemplateToml(
  additionalBase: string[] | undefined,
  scaffoldPackets: RunScaffoldPacket[] | undefined
): string {
  const sections = [
    fileSectionToml('prompt', 'soul', 'agent-root:///SOUL.md'),
    ...(additionalBase ?? []).map((ref, index) =>
      fileSectionToml('prompt', `additional-base-${index}`, ref)
    ),
    [
      '[[prompt]]',
      'name = "heartbeat"',
      'type = "file"',
      `path = ${quoteTomlString('agent-root:///HEARTBEAT.md')}`,
      'when = { runMode = "heartbeat" }',
    ].join('\n'),
    ...buildScaffoldSectionsToml(scaffoldPackets),
  ]

  return ['schema_version = 2', 'mode = "replace"', '', ...sections].join('\n\n')
}

function buildScaffoldSectionsToml(scaffoldPackets: RunScaffoldPacket[] | undefined): string[] {
  if (!scaffoldPackets) {
    return []
  }

  return scaffoldPackets.flatMap((packet, index) => {
    const sections: string[] = []

    if (packet.content !== undefined) {
      sections.push(
        [
          '[[prompt]]',
          `name = ${quoteTomlString(`scaffold-inline-${index}`)}`,
          'type = "inline"',
          `content = ${quoteTomlString(packet.content)}`,
        ].join('\n')
      )
    }

    if (packet.ref) {
      sections.push(fileSectionToml('prompt', `scaffold-ref-${index}`, packet.ref))
    }

    return sections
  })
}

function fileSectionToml(tableName: 'prompt' | 'reminder', name: string, path: string): string {
  return [
    `[[${tableName}]]`,
    `name = ${quoteTomlString(name)}`,
    'type = "file"',
    `path = ${quoteTomlString(path)}`,
  ].join('\n')
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value)
}
