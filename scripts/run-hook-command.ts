import type { HookName } from './lib/hook-change-scope.ts'
import {
  HOOK_RUN_ID_ENV,
  HOOK_TIMING_SCHEMA_VERSION,
  appendTimingRecord,
  changeScopeFromEnvironment,
  roundDurationMs,
} from './lib/hook-timing.ts'

async function main(): Promise<number> {
  const startedAt = new Date().toISOString()
  const start = performance.now()
  const separator = process.argv.indexOf('--', 2)
  const hook = process.argv[2]
  const step = process.argv[3]
  if (
    (hook !== 'pre-commit' && hook !== 'pre-push') ||
    !step ||
    separator !== 4 ||
    process.argv.length === 5
  ) {
    console.error('usage: run-hook-command.ts <pre-commit|pre-push> <step> -- <command> [args...]')
    return 2
  }

  const command = process.argv.slice(separator + 1)
  let exitCode = 1
  let spawnError: unknown
  try {
    const result = Bun.spawnSync(command, {
      cwd: process.cwd(),
      env: process.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    exitCode = result.exitCode
  } catch (error) {
    spawnError = error
  }
  const runId = process.env[HOOK_RUN_ID_ENV]
  if (runId) {
    await appendTimingRecord({
      schemaVersion: HOOK_TIMING_SCHEMA_VERSION,
      recordType: 'step',
      recordedAt: new Date().toISOString(),
      runId,
      hook: hook as HookName,
      step,
      startedAt,
      durationMs: roundDurationMs(performance.now() - start),
      result: exitCode === 0 ? 'passed' : 'failed',
      exitCode,
      change: changeScopeFromEnvironment(),
    })
  }
  if (spawnError) throw spawnError
  return exitCode
}

process.exit(await main())
