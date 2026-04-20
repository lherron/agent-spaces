import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import { type RunMode, type RunScaffoldPacket, getAspHome } from 'spaces-config'
import { resolveContextTemplate } from './context-resolver.js'
import { type ContextTemplate, parseContextTemplate } from './context-template.js'
import { resolveSystemPromptTemplate } from './system-prompt-resolver.js'
import {
  type SystemPromptMode,
  type SystemPromptTemplate,
  parseSystemPromptTemplate,
} from './system-prompt-template.js'

export interface MaterializeSystemPromptInput {
  agentRoot: string
  agentsRoot?: string | undefined
  aspHome?: string | undefined
  projectRoot?: string | undefined
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

export type DiscoveredTemplateSource =
  | {
      kind: 'context'
      path: string
      template: ContextTemplate
    }
  | {
      kind: 'system-prompt'
      path: string
      template: SystemPromptTemplate
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

const SECTION_SEPARATOR = '\n\n---\n\n'

export async function materializeSystemPrompt(
  outputPath: string,
  input: MaterializeSystemPromptInput
): Promise<MaterializeResult | undefined> {
  const discovered = discoverContextTemplate({
    agentRoot: input.agentRoot,
    agentsRoot: input.agentsRoot,
    aspHome: input.aspHome,
  })
  const { agentsRoot, profile, templateSource } = discovered

  if (!templateSource && !existsSync(join(input.agentRoot, 'SOUL.md'))) {
    return undefined
  }

  if (templateSource?.kind === 'context') {
    const resolved = await resolveContextTemplate(templateSource.template, {
      agentRoot: input.agentRoot,
      agentsRoot,
      projectRoot: input.projectRoot,
      runMode: input.runMode,
      scaffoldPackets: input.scaffoldPackets,
      agentProfile: profile.rawProfile,
    })

    return writeMaterializedContext(outputPath, {
      content: appendTaskContextSection(resolved.prompt?.content ?? ''),
      mode: resolved.prompt?.mode ?? templateSource.template.mode,
      reminderContent: resolved.reminder,
      maxChars: templateSource.template.maxChars,
    })
  }

  const template =
    templateSource?.template ??
    parseSystemPromptTemplate(
      buildDefaultTemplateToml(profile.additionalBase, input.scaffoldPackets)
    )
  const resolved = await resolveSystemPromptTemplate(template, {
    agentRoot: input.agentRoot,
    agentsRoot,
    projectRoot: input.projectRoot,
    runMode: input.runMode,
    scaffoldPackets: input.scaffoldPackets,
    ...(profile.additionalBase
      ? {
          agentProfile: {
            instructions: {
              additionalBase: profile.additionalBase,
            },
          },
        }
      : {}),
  })

  if (!resolved) {
    if (templateSource || !existsSync(join(input.agentRoot, 'SOUL.md'))) {
      return undefined
    }

    return writeMaterializedPrompt(outputPath, {
      content: '',
      mode: 'replace',
    })
  }

  return writeMaterializedPrompt(outputPath, {
    ...resolved,
    content: appendTaskContextSection(resolved.content),
  })
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
      path: join(input.agentsRoot, 'system-prompt-template.toml'),
      required: false,
    },
    {
      path: join(input.aspHome, 'context-template.toml'),
      required: false,
    },
    {
      path: join(input.aspHome, 'system-prompt-template.toml'),
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
    const parsed = parseToml(fileContent)
    const templateType =
      isRecord(parsed) &&
      (parsed['schema_version'] === 2 || 'prompt' in parsed || 'reminder' in parsed)
        ? 'context'
        : 'system-prompt'

    if (templateType === 'context') {
      return {
        kind: 'context',
        path: filePath,
        template: parseContextTemplate(fileContent),
      } satisfies DiscoveredTemplateSource
    }

    return {
      kind: 'system-prompt',
      path: filePath,
      template: parseSystemPromptTemplate(fileContent),
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
    fileSectionToml('soul', 'agent-root:///SOUL.md'),
    ...(additionalBase ?? []).map((ref, index) => fileSectionToml(`additional-base-${index}`, ref)),
    [
      '[[section]]',
      'name = "heartbeat"',
      'type = "file"',
      `path = ${quoteTomlString('agent-root:///HEARTBEAT.md')}`,
      'when = { runMode = "heartbeat" }',
    ].join('\n'),
    ...buildScaffoldSectionsToml(scaffoldPackets),
  ]

  return ['schema_version = 1', 'mode = "replace"', '', ...sections].join('\n\n')
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
          '[[section]]',
          `name = ${quoteTomlString(`scaffold-inline-${index}`)}`,
          'type = "inline"',
          `content = ${quoteTomlString(packet.content)}`,
        ].join('\n')
      )
    }

    if (packet.ref) {
      sections.push(fileSectionToml(`scaffold-ref-${index}`, packet.ref))
    }

    return sections
  })
}

function fileSectionToml(name: string, path: string): string {
  return [
    '[[section]]',
    `name = ${quoteTomlString(name)}`,
    'type = "file"',
    `path = ${quoteTomlString(path)}`,
  ].join('\n')
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value)
}

function appendTaskContextSection(content: string): string {
  const section = buildTaskContextSection(process.env)
  if (section === undefined) {
    return content
  }

  if (content.trim().length === 0) {
    return section
  }

  return `${content}${SECTION_SEPARATOR}${section}`
}

function buildTaskContextSection(env: NodeJS.ProcessEnv): string | undefined {
  const taskId = readTaskEnv(env, 'HRC_TASK_ID')
  const phase = readTaskEnv(env, 'HRC_TASK_PHASE')
  const role = readTaskEnv(env, 'HRC_TASK_ROLE')
  const requiredEvidence = readTaskEnv(env, 'HRC_TASK_REQUIRED_EVIDENCE')
  const hints = readTaskEnv(env, 'HRC_TASK_HINTS')

  if (
    taskId === undefined &&
    phase === undefined &&
    role === undefined &&
    requiredEvidence === undefined &&
    hints === undefined
  ) {
    return undefined
  }

  const lines = ['## Current task context']

  if (taskId !== undefined) {
    lines.push(`- Task ID: ${taskId}`)
  }

  if (phase !== undefined) {
    lines.push(`- Phase: ${phase}`)
  }

  if (role !== undefined) {
    lines.push(`- Role: ${role}`)
  }

  if (requiredEvidence !== undefined) {
    lines.push(`- Required evidence: ${requiredEvidence.length > 0 ? requiredEvidence : '(none)'}`)
  }

  if (hints !== undefined) {
    lines.push('', '### Hints', hints)
  }

  return lines.join('\n')
}

function readTaskEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : ''
}
