/**
 * Run each named workspace package's `test` script, then the scripts/ suite,
 * in order under the test Git guard, with a wall-clock bound on each step
 * (scripts/lib/bounded-step.ts), so a hung suite fails naming its package
 * instead of holding the shared verify lock (T-10366).
 *
 * Usage: bun scripts/test-packages.ts <package-name>...
 * ASP_TEST_PACKAGE_TIMEOUT_MS overrides the per-step bound.
 */

import { join } from 'node:path'

import { runBoundedStep, stepTimeoutMs } from './lib/bounded-step.ts'
import { testGitGuardEnvironment } from './lib/test-git-guard.ts'

const packages = process.argv.slice(2)
if (packages.length === 0) {
  console.error('usage: bun scripts/test-packages.ts <package-name>...')
  process.exit(2)
}

const steps = [
  ...packages.map((name) => ({ label: name, command: ['bun', 'run', '--filter', name, 'test'] })),
  { label: 'scripts', command: ['bun', 'test', 'scripts/'] },
]
const timeoutMs = stepTimeoutMs()
const env = testGitGuardEnvironment()
const root = join(import.meta.dir, '..')

for (const step of steps) {
  const started = performance.now()
  const { exitCode, timedOut } = await runBoundedStep({
    ...step,
    cwd: root,
    env,
    timeoutMs,
    logPrefix: '[test]',
  })
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  if (timedOut) {
    console.error(`[test] FAILED ${step.label}: timed out after ${seconds}s`)
    process.exit(exitCode)
  }
  if (exitCode !== 0) {
    console.error(`[test] FAILED ${step.label}: exit ${exitCode} after ${seconds}s`)
    process.exit(exitCode)
  }
  console.log(`[test] ${step.label} passed in ${seconds}s`)
}
