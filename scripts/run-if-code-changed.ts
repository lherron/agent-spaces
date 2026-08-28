import {
  classifyChangeScope,
  failSafeChangeScope,
  inspectChangeScope,
  shouldSkipCodeValidation,
} from './lib/hook-change-scope.ts'
import type { ChangeScope, HookName } from './lib/hook-change-scope.ts'
import {
  HOOK_RUN_ID_ENV,
  HOOK_TIMING_SCHEMA_VERSION,
  appendTimingRecord,
  roundDurationMs,
} from './lib/hook-timing.ts'

async function main(): Promise<number> {
  const startedAt = new Date().toISOString()
  const start = performance.now()
  const separator = process.argv.indexOf('--', 2)
  const hook = process.argv[2]
  const step = process.argv[3]
  if ((hook !== 'pre-commit' && hook !== 'pre-push') || !step || separator !== 4) {
    console.error(
      'usage: run-if-code-changed.ts <pre-commit|pre-push> <step> -- <command> [args...]'
    )
    return 2
  }
  const command = process.argv.slice(separator + 1)
  if (command.length === 0) {
    console.error('run-if-code-changed.ts requires a command after --')
    return 2
  }

  const prePushInput = hook === 'pre-push' ? await Bun.stdin.text() : undefined
  let scope: ChangeScope
  try {
    scope = inspectChangeScope(hook, { prePushInput })
  } catch (error) {
    scope = failSafeChangeScope(error)
  }
  const change = classifyChangeScope(scope)
  let exitCode = 0
  let result: 'passed' | 'failed' | 'skipped' = 'passed'

  if (shouldSkipCodeValidation(scope)) {
    result = 'skipped'
    if (scope.deletionOnlyPush) {
      console.log('[hook-scope] skipping validation for a deletion-only push')
    } else {
      console.log(
        `[hook-scope] skipping code validation for ${scope.paths.length} documentation file(s)`
      )
    }
  } else {
    try {
      const proc = Bun.spawnSync(command, {
        cwd: process.cwd(),
        env: process.env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      })
      exitCode = proc.exitCode
      result = exitCode === 0 ? 'passed' : 'failed'
    } catch (error) {
      result = 'failed'
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
          result,
          exitCode,
          change,
        })
      }
      throw error
    }
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
      result,
      exitCode,
      change,
    })
  }
  return exitCode
}

process.exit(await main())
