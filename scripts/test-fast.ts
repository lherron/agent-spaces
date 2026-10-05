import { readdir } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

import { runBoundedStep, stepTimeoutMs } from './lib/bounded-step.ts'
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
// Large packages run as several bun processes so one suite does not own the critical path.
const FAST_SUITE_SHARDS: Readonly<Record<string, number>> = {
  'spaces-harness-broker': 4,
}
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
  timedOut: boolean
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

function shardSuite(id: string, paths: string[], shardCount: number): FastSuite[] {
  const count = Math.min(shardCount, paths.length)
  if (count <= 1) return paths.length > 0 ? [{ id, paths }] : []
  const shards = Array.from({ length: count }, () => [] as string[])
  paths.forEach((path, index) => shards[index % count]?.push(path))
  return shards.map((shardPaths, index) => ({
    id: `${id}#${index + 1}/${count}`,
    paths: shardPaths,
  }))
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
    suites.push(...shardSuite(packageName, paths, FAST_SUITE_SHARDS[packageName] ?? 1))
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

  // Longest-first scheduling: start the heaviest suites before the short tail.
  suites.sort((left, right) => right.paths.length - left.paths.length)
  return { suites, mode: selection.full ? 'full' : 'affected' }
}

// Per-test timeouts cannot stop a suite that spins outside a test's control
// (T-10366), so each suite also runs under a supervisor wall-clock bound.
const suiteTimeoutMs = stepTimeoutMs()

async function runSuite(suite: FastSuite, env: NodeJS.ProcessEnv): Promise<SuiteResult> {
  const started = performance.now()
  const { exitCode, timedOut, output } = await runBoundedStep({
    label: suite.id,
    command: ['bun', 'test', `--timeout=${FAST_TEST_TIMEOUT_MS}`, ...suite.paths],
    cwd: root,
    env,
    timeoutMs: suiteTimeoutMs,
    logPrefix: '[test:fast]',
    capture: true,
  })
  return {
    id: suite.id,
    exitCode,
    timedOut,
    durationMs: performance.now() - started,
    output,
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
    `[test:fast] ${result.id} ${result.timedOut ? 'timed out' : result.exitCode === 0 ? 'passed' : 'failed'} ${(result.durationMs / 1000).toFixed(2)}s`
  )
}
const failures = results.filter((result) => result.exitCode !== 0)
console.log(`[test:fast] completed in ${((performance.now() - started) / 1000).toFixed(2)}s`)
if (failures.length > 0) {
  console.error(`[test:fast] failed suites: ${failures.map(({ id }) => id).join(', ')}`)
  process.exit(1)
}
