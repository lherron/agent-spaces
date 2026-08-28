import { HOOK_RUN_ID_ENV } from './hook-timing.ts'
import type { WorkspacePackage } from './workspace-graph.ts'
import { reverseDependencyClosure, workspaceForPath } from './workspace-graph.ts'

export const HOOK_CHANGED_PATHS_ENV = 'ASP_HOOK_CHANGED_PATHS_JSON'
export const HOOK_CHANGE_AMBIGUOUS_ENV = 'ASP_HOOK_CHANGE_AMBIGUOUS'

export const FAST_WORKSPACE_SUITE_NAMES = [
  '@lherron/agent-spaces',
  'agent-harness',
  'agent-harness-runtime',
  'agent-scope',
  'agent-spaces',
  'cli-kit',
  'spaces-aspc',
  'spaces-aspc-facade',
  'spaces-aspc-protocol',
  'spaces-config',
  'spaces-execution',
  'spaces-harness-broker',
  'spaces-harness-broker-client',
  'spaces-harness-broker-pi-sdk',
  'spaces-harness-broker-protocol',
  'spaces-harness-claude',
  'spaces-harness-codex',
  'spaces-harness-pi',
  'spaces-harness-pi-sdk',
  'spaces-runtime',
  'spaces-runtime-contracts',
  'spaces-turn-runner',
] as const

export const ALWAYS_ON_PACKAGE_NAMES = new Set([
  'agent-scope',
  'spaces-aspc-protocol',
  'spaces-harness-broker-client',
  'spaces-harness-broker-protocol',
  'spaces-runtime-contracts',
])

export function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)
}

export function isPublicSurfaceRelevant(path: string): boolean {
  return (
    path === '.public-surface-baseline.json' ||
    path === 'scripts/check-public-surface.ts' ||
    path === 'scripts/check-public-surface.test.ts' ||
    /^(?:apps|compiler|contracts|core|drivers|harness)\/[^/]+\/package\.json$/u.test(path) ||
    /^(?:apps|compiler|contracts|core|drivers|harness)\/[^/]+\/src\/.*\.[cm]?[jt]sx?$/u.test(path)
  )
}

export interface FastTestSelection {
  full: boolean
  packageNames: Set<string>
  includeScripts: boolean
}

export function cleanFastTestEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...source }
  clean.GIT_DIR = undefined
  clean.GIT_WORK_TREE = undefined
  clean[HOOK_RUN_ID_ENV] = undefined
  return clean
}

function fullSelection(): FastTestSelection {
  return {
    full: true,
    packageNames: new Set(FAST_WORKSPACE_SUITE_NAMES),
    includeScripts: true,
  }
}

export function selectAffectedPackageNames(
  packages: WorkspacePackage[],
  paths: string[] | undefined,
  ambiguous: boolean
): FastTestSelection {
  if (ambiguous || !paths) return fullSelection()

  const packageNames = new Set(ALWAYS_ON_PACKAGE_NAMES)
  let includeScripts = false
  for (const path of paths) {
    const workspace = workspaceForPath(packages, path)
    if (workspace) {
      if (isTestFile(path) || path.includes('/__tests__/')) packageNames.add(workspace.name)
      else {
        for (const name of reverseDependencyClosure(packages, [workspace.name])) {
          packageNames.add(name)
        }
      }
      continue
    }
    if (path.startsWith('scripts/')) {
      includeScripts = true
      if (
        path === 'scripts/test-fast.ts' ||
        path === 'scripts/run-if-code-changed.ts' ||
        path === 'scripts/lib/workspace-graph.ts' ||
        path === 'scripts/lib/hook-optimization.ts' ||
        path === 'scripts/lib/test-git-guard.ts' ||
        path === 'scripts/run-tests-no-git-clone.ts'
      ) {
        return fullSelection()
      }
      continue
    }
    if (!/\.(?:md|markdown|html|htm|txt)$/iu.test(path)) return fullSelection()
  }

  return { full: false, packageNames, includeScripts }
}
