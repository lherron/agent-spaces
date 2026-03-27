import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface FixtureRoots {
  fixturesRoot: string
  agentRoot: string
  projectRoot: string
}

export interface TempFixtureRoots {
  tempDir: string
  agentRoot: string
  projectRoot: string
  cleanup: () => void
}

const FIXTURES_ROOT = fileURLToPath(new URL('../__fixtures__/v2', import.meta.url))
const AGENT_ROOT = join(FIXTURES_ROOT, 'agent-root')
const PROJECT_ROOT = join(FIXTURES_ROOT, 'project-root')

export function resolveFixtureRoots(): FixtureRoots {
  return {
    fixturesRoot: FIXTURES_ROOT,
    agentRoot: AGENT_ROOT,
    projectRoot: PROJECT_ROOT,
  }
}

export function resolveAgentRoot(): string {
  return AGENT_ROOT
}

export function resolveProjectRoot(): string {
  return PROJECT_ROOT
}

export function assertPathContained(root: string, candidate: string): string {
  const resolvedRoot = realpathSync(root)
  const resolvedCandidate = realpathSync(candidate)
  const relativePath = relative(resolvedRoot, resolvedCandidate)

  if (relativePath === '') {
    return resolvedCandidate
  }

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Path "${candidate}" escapes the root "${root}"`)
  }

  return resolvedCandidate
}

export function resolveLocalSpacePath(
  scope: 'agent' | 'project',
  spaceId: string,
  options: { agentRoot?: string | undefined; projectRoot?: string | undefined } = {}
): string {
  const root =
    scope === 'agent'
      ? (options.agentRoot ?? resolveAgentRoot())
      : (options.projectRoot ?? resolveProjectRoot())
  return assertPathContained(root, join(root, 'spaces', spaceId))
}

export function createTempFixtureRoots(): TempFixtureRoots {
  const tempDir = mkdtempSync(join(tmpdir(), 'agent-spaces-v2-'))
  const agentRoot = join(tempDir, 'agent-root')
  const projectRoot = join(tempDir, 'project-root')

  cpSync(resolveAgentRoot(), agentRoot, { recursive: true })
  cpSync(resolveProjectRoot(), projectRoot, { recursive: true })

  return {
    tempDir,
    agentRoot,
    projectRoot,
    cleanup: () => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  }
}
