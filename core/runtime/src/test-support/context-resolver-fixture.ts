/**
 * Shared fixture for the context-resolver behavior tests: real temp agent,
 * agents and project roots (cwd moves into the project root so `when.exists`
 * sees a real working directory), plus resolver/template builders. Roots live
 * under os.tmpdir(), never inside the checkout.
 *
 * `inspectTemplate` / `materializeTemplate` drive the file contract: the
 * template is written to `<agentsRoot>/context-template.toml` (and an optional
 * `<agentRoot>/agent-profile.toml`) and resolved through the same
 * inspectAgentSystemPrompt / materializeSystemPrompt entry points the
 * compiler uses. The agent directory is named `smokey`, so `{{agent_name}}`
 * renders as `smokey`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ContextResolverContext,
  type ResolvedContext,
  type ResolvedContextDetailed,
  resolveContextTemplateDetailed,
} from '../context-resolver.js'
import type { ContextTemplate } from '../context-template.js'
import {
  type AgentSystemPromptInspection,
  type MaterializeSystemPromptInput,
  inspectAgentSystemPrompt,
  materializeSystemPrompt,
} from '../system-prompt.js'

/** The separator the resolver joins included sections of one zone with. */
export const SECTION_SEPARATOR = '\n\n---\n\n'

export interface ResolverRoots {
  tempRoot: string
  agentRoot: string
  agentsRoot: string
  projectRoot: string
  originalCwd: string
}

export async function createResolverRoots(): Promise<ResolverRoots> {
  const originalCwd = process.cwd()
  const tempRoot = await mkdtemp(join(tmpdir(), 'context-resolver-'))
  const roots = {
    tempRoot,
    agentRoot: join(tempRoot, 'smokey'),
    agentsRoot: join(tempRoot, 'agents'),
    projectRoot: join(tempRoot, 'project'),
    originalCwd,
  }
  await mkdir(roots.agentRoot, { recursive: true })
  await mkdir(roots.agentsRoot, { recursive: true })
  await mkdir(roots.projectRoot, { recursive: true })
  process.chdir(roots.projectRoot)
  return roots
}

export async function removeResolverRoots(roots: ResolverRoots): Promise<void> {
  process.chdir(roots.originalCwd)
  await rm(roots.tempRoot, { recursive: true, force: true })
}

/** A task-mode resolver context for smokey@agent-spaces rooted at `roots`. */
export function resolverContext(
  roots: ResolverRoots,
  overrides?: Partial<ContextResolverContext>
): ContextResolverContext {
  return {
    agentRoot: roots.agentRoot,
    agentsRoot: roots.agentsRoot,
    projectRoot: roots.projectRoot,
    projectId: 'agent-spaces',
    agentName: 'smokey',
    runMode: 'task',
    ...overrides,
  }
}

export function resolveDetailed(
  roots: ResolverRoots,
  template: ContextTemplate,
  overrides?: Partial<ContextResolverContext>
): Promise<ResolvedContextDetailed> {
  return resolveContextTemplateDetailed(template, resolverContext(roots, overrides))
}

/** Resolve and keep only the two rendered zones. */
export async function resolveZones(
  roots: ResolverRoots,
  template: ContextTemplate,
  overrides?: Partial<ContextResolverContext>
): Promise<ResolvedContext> {
  const { prompt, reminder } = await resolveDetailed(roots, template, overrides)
  return { prompt, reminder }
}

/** A replace-mode v2 template with no sections, overridden by `overrides`. */
export function templateWith(overrides: Partial<ContextTemplate>): ContextTemplate {
  return {
    schemaVersion: 2,
    mode: 'replace',
    promptSections: [],
    reminderSections: [],
    ...overrides,
  } as ContextTemplate
}

/** Inputs for the template-file helpers. */
export interface TemplateFileOptions extends Partial<MaterializeSystemPromptInput> {
  /** Written to `<agentRoot>/agent-profile.toml` when set. */
  profileToml?: string | undefined
}

async function writeTemplateFiles(
  roots: ResolverRoots,
  templateToml: string,
  options: TemplateFileOptions
): Promise<MaterializeSystemPromptInput> {
  const { profileToml, ...overrides } = options
  await writeFile(join(roots.agentsRoot, 'context-template.toml'), templateToml)
  if (profileToml !== undefined) {
    await writeFile(join(roots.agentRoot, 'agent-profile.toml'), profileToml)
  }
  return {
    agentRoot: roots.agentRoot,
    agentsRoot: roots.agentsRoot,
    aspHome: join(roots.tempRoot, 'asp-home'),
    projectRoot: roots.projectRoot,
    projectId: 'agent-spaces',
    runMode: 'task',
    ...overrides,
  }
}

/** Write `templateToml` as the agents-root context template and inspect it. */
export async function inspectTemplate(
  roots: ResolverRoots,
  templateToml: string,
  options: TemplateFileOptions = {}
): Promise<AgentSystemPromptInspection> {
  const inspection = await inspectAgentSystemPrompt(
    await writeTemplateFiles(roots, templateToml, options)
  )
  if (inspection === undefined) {
    throw new Error('inspectAgentSystemPrompt found no context template')
  }
  return inspection
}

/** The two files materialization writes for a context template. */
export interface MaterializedFiles {
  systemPrompt: string
  sessionReminder: string
}

/** Write `templateToml` as the agents-root context template and materialize it. */
export async function materializeTemplate(
  roots: ResolverRoots,
  templateToml: string,
  options: TemplateFileOptions = {}
): Promise<MaterializedFiles> {
  const outputRoot = join(roots.tempRoot, 'out')
  const result = await materializeSystemPrompt(
    outputRoot,
    await writeTemplateFiles(roots, templateToml, options)
  )
  if (result === undefined) {
    throw new Error('materializeSystemPrompt found no context template')
  }
  return {
    systemPrompt: await readFile(join(outputRoot, 'system-prompt.md'), 'utf8'),
    sessionReminder: await readFile(join(outputRoot, 'session-reminder.md'), 'utf8'),
  }
}
