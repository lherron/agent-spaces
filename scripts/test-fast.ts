import { readdir } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

import {
  FAST_WORKSPACE_SUITE_NAMES,
  HOOK_CHANGED_PATHS_ENV,
  HOOK_CHANGE_AMBIGUOUS_ENV,
  cleanFastTestEnvironment,
  isTestFile,
  selectAffectedPackageNames,
} from './lib/hook-optimization.ts'
import { testGitGuardEnvironment } from './lib/test-git-guard.ts'
import { discoverWorkspacePackages } from './lib/workspace-graph.ts'

const FAST_TEST_TIMEOUT_MS = 60_000
const root = join(import.meta.dir, '..')
const requestedConcurrency = Number.parseInt(
  process.env['ASP_TEST_CONCURRENCY'] ?? String(Math.min(4, availableParallelism())),
  10
)
const concurrency =
  Number.isFinite(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 1

interface FastSuite {
  id: string
  paths: string[]
}

interface SuiteResult {
  id: string
  exitCode: number
  durationMs: number
  output: string
}

async function collectTestFiles(directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (['dist', 'node_modules'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectTestFiles(path)))
    else if (entry.isFile() && isTestFile(path)) files.push(path)
  }
  return files.sort()
}

function hookChangedPaths(): { paths?: string[]; ambiguous: boolean } {
  const encoded = process.env[HOOK_CHANGED_PATHS_ENV]
  if (!encoded) return { ambiguous: true }
  try {
    const parsed = JSON.parse(encoded)
    if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== 'string')) {
      return { ambiguous: true }
    }
    return {
      paths: parsed,
      ambiguous: process.env[HOOK_CHANGE_AMBIGUOUS_ENV] === '1',
    }
  } catch {
    return { ambiguous: true }
  }
}

async function makeSuites(): Promise<{ suites: FastSuite[]; mode: 'affected' | 'full' }> {
  const packages = await discoverWorkspacePackages(root)
  const byName = new Map(packages.map((workspace) => [workspace.name, workspace]))
  const changed = hookChangedPaths()
  const selection = selectAffectedPackageNames(packages, changed.paths, changed.ambiguous)
  const suites: FastSuite[] = []

  for (const packageName of FAST_WORKSPACE_SUITE_NAMES) {
    if (!selection.packageNames.has(packageName)) continue
    const workspace = byName.get(packageName)
    if (!workspace) throw new Error(`Missing fast-test workspace ${packageName}`)
    const paths =
      packageName === '@lherron/agent-spaces' ? [] : await collectTestFiles(workspace.relativePath)
    if (paths.length > 0) {
      suites.push({
        id: packageName,
        paths,
      })
    }
  }

  if (selection.full || selection.packageNames.has('@lherron/agent-spaces')) {
    suites.push({
      id: 'agent-spaces-cli-fast',
      paths: [
        'apps/cli/src/index.test.ts',
        'apps/cli/src/commands/agent/__tests__/build-bundle-ref-agent-project.test.ts',
      ],
    })
  }
  if (selection.includeScripts) {
    suites.push({
      id: 'hook-optimization-scripts',
      paths: [
        'scripts/aspc-facade-roster.test.ts',
        'scripts/check-test-no-git-clone.test.ts',
        'scripts/hook-optimization.test.ts',
        'scripts/hook-timing.test.ts',
        'scripts/lefthook-boundaries.test.ts',
      ],
    })
  }

  return { suites, mode: selection.full ? 'full' : 'affected' }
}

const activeChildren = new Set<ReturnType<typeof Bun.spawn>>()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const child of activeChildren) child.kill(signal)
  })
}

async function runSuite(suite: FastSuite, env: NodeJS.ProcessEnv): Promise<SuiteResult> {
  const started = performance.now()
  const child = Bun.spawn(['bun', 'test', `--timeout=${FAST_TEST_TIMEOUT_MS}`, ...suite.paths], {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  activeChildren.add(child)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  activeChildren.delete(child)
  return {
    id: suite.id,
    exitCode,
    durationMs: performance.now() - started,
    output: `${stdout}${stderr}`,
  }
}

const { suites, mode } = await makeSuites()
const env = testGitGuardEnvironment(cleanFastTestEnvironment(process.env))
const results: SuiteResult[] = []
let nextIndex = 0
const started = performance.now()

console.log(`[test:fast] mode=${mode} suites=${suites.length} concurrency=${concurrency}`)
await Promise.all(
  Array.from({ length: Math.min(concurrency, suites.length) }, async () => {
    while (nextIndex < suites.length) {
      const suite = suites[nextIndex]
      nextIndex += 1
      if (!suite) return
      results.push(await runSuite(suite, env))
    }
  })
)

for (const result of results.sort((left, right) => left.id.localeCompare(right.id))) {
  process.stdout.write(result.output)
  console.log(
    `[test:fast] ${result.id} ${result.exitCode === 0 ? 'passed' : 'failed'} ${(result.durationMs / 1000).toFixed(2)}s`
  )
}
const failures = results.filter((result) => result.exitCode !== 0)
console.log(`[test:fast] completed in ${((performance.now() - started) / 1000).toFixed(2)}s`)
if (failures.length > 0) {
  console.error(`[test:fast] failed suites: ${failures.map(({ id }) => id).join(', ')}`)
  process.exit(1)
}
