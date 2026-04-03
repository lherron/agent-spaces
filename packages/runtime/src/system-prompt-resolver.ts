import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveRootRelativeRef } from 'spaces-config'
import type {
  ExecSectionDef,
  FileSectionDef,
  SystemPromptMode,
  SystemPromptSection,
  SystemPromptTemplate,
} from './system-prompt-template.js'

const execFileAsync = promisify(execFile)
const DEFAULT_EXEC_TIMEOUT_MS = 5000
const SECTION_SEPARATOR = '\n\n---\n\n'

export interface ResolverContext {
  agentRoot: string
  agentsRoot: string
  projectRoot?: string | undefined
  runMode: string
  scaffoldPackets?:
    | Array<{
        slot: string
        content?: string | undefined
        ref?: string | undefined
      }>
    | undefined
  agentProfile?:
    | {
        instructions?:
          | {
              additionalBase?: string[] | undefined
            }
          | undefined
      }
    | undefined
}

export interface ResolvedSystemPrompt {
  content: string
  mode: SystemPromptMode
}

export async function resolveSystemPromptTemplate(
  template: SystemPromptTemplate,
  context: ResolverContext
): Promise<ResolvedSystemPrompt | undefined> {
  const sections: string[] = []

  for (const section of template.sections) {
    if (!matchesWhenPredicate(section, context)) {
      continue
    }

    const content = await resolveSection(section, context)
    if (content === undefined || content.length === 0) {
      continue
    }

    sections.push(content)
  }

  if (sections.length === 0) {
    return undefined
  }

  return {
    content: sections.join(SECTION_SEPARATOR),
    mode: template.mode,
  }
}

function matchesWhenPredicate(section: SystemPromptSection, context: ResolverContext): boolean {
  return section.when?.runMode === undefined || section.when.runMode === context.runMode
}

async function resolveSection(
  section: SystemPromptSection,
  context: ResolverContext
): Promise<string | undefined> {
  switch (section.type) {
    case 'file':
      return resolveFileSection(section, context)
    case 'inline':
      return section.content.length > 0 ? section.content : undefined
    case 'exec':
      return resolveExecSection(section, context)
    case 'slot':
      switch (section.name) {
        case 'additional-base':
          return resolveAdditionalBaseSlot(context)
        case 'scaffold':
          return resolveScaffoldSlot(context)
      }
  }
}

async function resolveFileSection(
  section: FileSectionDef,
  context: ResolverContext
): Promise<string | undefined> {
  const filePath = resolveTemplateRef(section.path, context)
  const content = await readOptionalFile(filePath)

  if (content === undefined || content.length === 0) {
    if (section.required) {
      throw new Error(
        `Required system prompt file section "${section.name}" is missing: ${filePath}`
      )
    }
    return undefined
  }

  return content
}

async function resolveExecSection(
  section: ExecSectionDef,
  context: ResolverContext
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

async function resolveAdditionalBaseSlot(context: ResolverContext): Promise<string | undefined> {
  const refs = context.agentProfile?.instructions?.additionalBase
  if (!refs || refs.length === 0) {
    return undefined
  }

  const contents = await Promise.all(
    refs.map(async (ref) => {
      const filePath = resolveTemplateRef(ref, context)
      return readOptionalFile(filePath)
    })
  )

  return joinResolvedContent(contents)
}

async function resolveScaffoldSlot(context: ResolverContext): Promise<string | undefined> {
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

function resolveTemplateRef(ref: string, context: ResolverContext): string {
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

  return resolved.join('\n\n')
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
