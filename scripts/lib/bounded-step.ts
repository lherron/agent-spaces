/**
 * Run one test step under a supervisor wall-clock bound.
 *
 * A hung suite must fail loudly with its name instead of holding a gate
 * indefinitely (T-10366: a spaces-config run spun at 100% CPU for 30 minutes).
 * The bound is a supervisor kill, never a retry. Each step leads its own
 * process group, so on expiry the whole group is sent SIGTERM, then SIGKILL,
 * and the step reports TIMED_OUT_EXIT_CODE.
 *
 * ASP_TEST_PACKAGE_TIMEOUT_MS overrides the bound for every runner that uses
 * this module (scripts/test-packages.ts, scripts/test-fast.ts).
 */

import { type ChildProcess, spawn } from 'node:child_process'

export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000
export const TIMED_OUT_EXIT_CODE = 124
const KILL_GRACE_MS = 5_000
const STEP_TIMEOUT_ENV = 'ASP_TEST_PACKAGE_TIMEOUT_MS'

export interface BoundedStep {
  label: string
  command: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  /** Log prefix for the timeout notice, e.g. `[test]`. */
  logPrefix: string
  /** Capture stdout/stderr instead of inheriting them. */
  capture?: boolean
}

export interface BoundedStepResult {
  exitCode: number
  timedOut: boolean
  /** Captured stdout then stderr; empty unless `capture` was set. */
  output: string
}

/** The per-step bound, from ASP_TEST_PACKAGE_TIMEOUT_MS or the default. */
export function stepTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STEP_TIMEOUT_ENV]
  if (raw === undefined || raw === '') return DEFAULT_STEP_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${STEP_TIMEOUT_ENV} must be a positive integer, got ${raw}`)
  }
  return parsed
}

const activeSteps = new Set<ChildProcess>()

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    // The child leads its own process group, so this reaches the step's
    // `bun test` and anything it spawned.
    process.kill(-child.pid, signal)
  } catch {
    // The group already exited.
  }
}

// Steps run in their own process groups, so a terminal Ctrl-C no longer
// reaches them directly; forward it.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const child of activeSteps) killGroup(child, signal)
    process.exit(130)
  })
}

export async function runBoundedStep(step: BoundedStep): Promise<BoundedStepResult> {
  const [command, ...args] = step.command
  if (command === undefined) throw new Error(`${step.label}: empty command`)
  const child = spawn(command, args, {
    cwd: step.cwd,
    env: step.env,
    stdio: step.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    detached: true,
  })
  activeSteps.add(child)

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (data: Buffer) => {
    stdout += data.toString()
  })
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString()
  })

  let timedOut = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const bound = setTimeout(() => {
    timedOut = true
    console.error(
      `${step.logPrefix} ${step.label} exceeded its ${step.timeoutMs / 1000}s wall-clock bound; killing its process group`
    )
    killGroup(child, 'SIGTERM')
    killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS)
  }, step.timeoutMs)

  // 'close' waits for the step's pipes too; a descendant that keeps them open
  // is still covered by the bound, which kills the whole group.
  const exitCode = await new Promise<number>((resolve) => {
    child.on('error', (error) => {
      stderr += `${step.logPrefix} ${step.label} failed to start: ${error.message}\n`
      resolve(1)
    })
    child.on('close', (code) => resolve(typeof code === 'number' ? code : 1))
  })
  clearTimeout(bound)
  if (killTimer) clearTimeout(killTimer)
  // The group leader can exit on SIGTERM while a spinning descendant ignores
  // it, so a timed-out step's group is always force-killed.
  if (timedOut) killGroup(child, 'SIGKILL')
  activeSteps.delete(child)

  if (!step.capture && stderr) process.stderr.write(stderr)
  return {
    exitCode: timedOut ? TIMED_OUT_EXIT_CODE : exitCode,
    timedOut,
    output: `${stdout}${stderr}`,
  }
}
