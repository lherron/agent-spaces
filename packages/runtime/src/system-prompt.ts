import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import type { RunMode, RunScaffoldPacket } from 'spaces-config'
import { getAspHome } from 'spaces-config'
import { resolveSystemPromptTemplate } from './system-prompt-resolver.js'
import { parseSystemPromptTemplate } from './system-prompt-template.js'
import type { SystemPromptMode } from './system-prompt-template.js'

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
}

export async function materializeSystemPrompt(
  outputPath: string,
  input: MaterializeSystemPromptInput
): Promise<MaterializeResult | undefined> {
  const aspHome = input.aspHome ?? getAspHome()
  const agentsRoot = input.agentsRoot ?? dirname(resolve(input.agentRoot))
  const profile = loadTemplateDiscoveryProfile(input.agentRoot)
  const templateSource = loadSystemPromptTemplate({
    agentRoot: input.agentRoot,
    agentsRoot,
    aspHome,
    profileTemplateRef: profile.template,
  })

  if (!templateSource && !existsSync(join(input.agentRoot, 'SOUL.md'))) {
    return undefined
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

  return writeMaterializedPrompt(outputPath, resolved)
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

function loadSystemPromptTemplate(input: {
  agentRoot: string
  agentsRoot: string
  aspHome: string
  profileTemplateRef?: string | undefined
}) {
  const candidates = [
    input.profileTemplateRef
      ? {
          path: resolve(input.agentRoot, input.profileTemplateRef),
          required: true,
        }
      : undefined,
    {
      path: join(input.agentsRoot, 'system-prompt-template.toml'),
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

    return {
      path: candidate.path,
      template: parseTemplateFile(candidate.path),
    }
  }

  return undefined
}

function parseTemplateFile(filePath: string) {
  try {
    return parseSystemPromptTemplate(readFileSync(filePath, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid system prompt template at ${filePath}: ${message}`)
  }
}

function loadTemplateDiscoveryProfile(agentRoot: string): {
  template?: string | undefined
  additionalBase?: string[] | undefined
} {
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
    return {}
  }

  return {
    template: typeof instructions['template'] === 'string' ? instructions['template'] : undefined,
    additionalBase: parseStringArray(instructions['additionalBase']),
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
