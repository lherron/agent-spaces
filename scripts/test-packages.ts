/**
 * Run each named workspace package's `test` script, then the scripts/ suite,
 * in order under the test Git guard, with a wall-clock bound on each step.
 *
 * A hung suite must fail loudly with its package name instead of holding the
 * shared verify lock indefinitely (T-10366: a spaces-config run spun at 100%
 * CPU for 30 minutes). The bound is a supervisor kill, never a retry: a step
 * that exceeds it is reported, its whole process group is killed, and the run
 * fails.
 *
 * Usage: bun scripts/test-packages.ts <package-name>...
 * ASP_TEST_PACKAGE_TIMEOUT_MS overrides the per-step bound.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'

import { testGitGuardEnvironment } from './lib/test-git-guard.ts'

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000
const KILL_GRACE_MS = 5_000
const TIMED_OUT_EXIT_CODE = 124

interface Step {
  label: string
  command: string[]
}

function stepTimeoutMs(): number {
  const raw = process.env['ASP_TEST_PACKAGE_TIMEOUT_MS']
  if (raw === undefined || raw === '') return DEFAULT_STEP_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`[test] ASP_TEST_PACKAGE_TIMEOUT_MS must be a positive integer, got ${raw}`)
    process.exit(2)
  }
  return parsed
}

const packages = process.argv.slice(2)
if (packages.length === 0) {
  console.error('usage: bun scripts/test-packages.ts <package-name>...')
  process.exit(2)
}

const steps: Step[] = [
  ...packages.map((name) => ({ label: name, command: ['bun', 'run', '--filter', name, 'test'] })),
  { label: 'scripts', command: ['bun', 'test', 'scripts/'] },
]
const timeoutMs = stepTimeoutMs()
const env = testGitGuardEnvironment()
const root = join(import.meta.dir, '..')

let active: ChildProcess | undefined

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    // The child leads its own process group, so this reaches `bun run`, the
    // `bun test` it starts, and anything those spawned.
    process.kill(-child.pid, signal)
  } catch {
    // The group already exited.
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (active) killGroup(active, signal)
    process.exit(130)
  })
}

async function runStep(step: Step): Promise<number> {
  const child = spawn(step.command[0] as string, step.command.slice(1), {
    cwd: root,
    env,
    stdio: 'inherit',
    detached: true,
  })
  active = child

  let timedOut = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const bound = setTimeout(() => {
    timedOut = true
    console.error(
      `[test] ${step.label} exceeded its ${timeoutMs / 1000}s wall-clock bound; killing its process group`
    )
    killGroup(child, 'SIGTERM')
    killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS)
  }, timeoutMs)

  const exitCode = await new Promise<number>((resolve) => {
    child.on('error', (error) => {
      console.error(`[test] ${step.label} failed to start: ${error.message}`)
      resolve(1)
    })
    child.on('exit', (code) => resolve(typeof code === 'number' ? code : 1))
  })
  clearTimeout(bound)
  if (killTimer) clearTimeout(killTimer)
  // The group leader can exit on SIGTERM while a spinning descendant ignores
  // it, so a timed-out step's group is always force-killed.
  if (timedOut) killGroup(child, 'SIGKILL')
  active = undefined

  return timedOut ? TIMED_OUT_EXIT_CODE : exitCode
}

for (const step of steps) {
  const started = performance.now()
  const exitCode = await runStep(step)
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  if (exitCode === TIMED_OUT_EXIT_CODE) {
    console.error(`[test] FAILED ${step.label}: timed out after ${seconds}s`)
    process.exit(exitCode)
  }
  if (exitCode !== 0) {
    console.error(`[test] FAILED ${step.label}: exit ${exitCode} after ${seconds}s`)
    process.exit(exitCode)
  }
  console.log(`[test] ${step.label} passed in ${seconds}s`)
}
