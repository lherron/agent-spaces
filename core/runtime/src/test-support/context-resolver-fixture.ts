/**
 * Shared fixture for the context-resolver behavior tests: real temp agent,
 * agents and project roots (cwd moves into the project root so `when.exists`
 * sees a real working directory), plus resolver/template builders.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ContextResolverContext,
  type ResolvedContext,
  type ResolvedContextDetailed,
  resolveContextTemplateDetailed,
} from '../context-resolver.js'
import type { ContextTemplate } from '../context-template.js'

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
  const tempRoot = await mkdtemp(join(originalCwd, '.tmp-context-resolver-'))
  const roots = {
    tempRoot,
    agentRoot: join(tempRoot, 'agent'),
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
