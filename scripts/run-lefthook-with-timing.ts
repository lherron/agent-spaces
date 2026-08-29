import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  classifyChangeScope,
  failSafeChangeScope,
  inspectChangeScope,
} from './lib/hook-change-scope.ts'
import type { ChangeScope, HookName } from './lib/hook-change-scope.ts'
import {
  HOOK_CHANGE_FILE_COUNT_ENV,
  HOOK_CHANGE_KIND_ENV,
  HOOK_RUN_ID_ENV,
  HOOK_TIMINGS_PATH_ENV,
  HOOK_TIMING_SCHEMA_VERSION,
  appendTimingRecord,
  gitIdentity,
  resolveHookTimingsPath,
  roundDurationMs,
} from './lib/hook-timing.ts'

const repoRoot = resolve(import.meta.dir, '..')

/**
 * First `node_modules/<segments>` at or above `repoRoot`, else the repo-local path.
 *
 * This repo installs standalone in CI and on the fleet, where the repo-local path
 * is correct and the walk stops immediately. Under the praesidium dev workspace,
 * agent-spaces installs as one workspace with hrc-runtime and agent-control-plane
 * and bun hoists to the shared root, leaving no repo-local node_modules — and this
 * wrapper IS the git hook, so an unresolvable path there fails every commit.
 */
function resolveHoisted(...segments: string[]): string {
  for (let directory = repoRoot; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', ...segments)
    if (existsSync(candidate)) return candidate
    if (dirname(directory) === directory) return join(repoRoot, 'node_modules', ...segments)
  }
}

const lefthookBinary = resolveHoisted(
  '.bin',
  process.platform === 'win32' ? 'lefthook.cmd' : 'lefthook'
)

async function lefthookVersion(): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(resolveHoisted('lefthook', 'package.json'), 'utf8')
    ) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

function spawnLefthook(args: string[], input?: string): number {
  const result = spawnSync(lefthookBinary, args, {
    cwd: process.cwd(),
    env: process.env,
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const hook = args[0] === 'run' ? args[1] : undefined
  if (hook !== 'pre-commit' && hook !== 'pre-push') return spawnLefthook(args)

  const typedHook = hook as HookName
  const startedAt = new Date().toISOString()
  const start = performance.now()
  const runId = crypto.randomUUID()
  const prePushInput = typedHook === 'pre-push' ? await Bun.stdin.text() : undefined
  let scope: ChangeScope
  try {
    scope = inspectChangeScope(typedHook, { cwd: process.cwd(), prePushInput })
  } catch (error) {
    scope = failSafeChangeScope(error)
  }
  const change = classifyChangeScope(scope)
  let timingPath: string | undefined
  try {
    timingPath = resolveHookTimingsPath(process.cwd())
  } catch (error) {
    console.error(`[hook-timing] unable to resolve timing path: ${error}`)
  }

  const previousRunId = process.env[HOOK_RUN_ID_ENV]
  const previousChangeKind = process.env[HOOK_CHANGE_KIND_ENV]
  const previousChangeFileCount = process.env[HOOK_CHANGE_FILE_COUNT_ENV]
  const previousTimingPath = process.env[HOOK_TIMINGS_PATH_ENV]
  process.env[HOOK_RUN_ID_ENV] = runId
  process.env[HOOK_CHANGE_KIND_ENV] = change.kind
  process.env[HOOK_CHANGE_FILE_COUNT_ENV] = String(change.fileCount)
  if (timingPath) process.env[HOOK_TIMINGS_PATH_ENV] = timingPath
  let exitCode = 1
  let spawnError: unknown
  try {
    exitCode = spawnLefthook(args, prePushInput)
  } catch (error) {
    spawnError = error
  } finally {
    if (previousRunId === undefined) delete process.env[HOOK_RUN_ID_ENV]
    else process.env[HOOK_RUN_ID_ENV] = previousRunId
    if (previousChangeKind === undefined) delete process.env[HOOK_CHANGE_KIND_ENV]
    else process.env[HOOK_CHANGE_KIND_ENV] = previousChangeKind
    if (previousChangeFileCount === undefined) delete process.env[HOOK_CHANGE_FILE_COUNT_ENV]
    else process.env[HOOK_CHANGE_FILE_COUNT_ENV] = previousChangeFileCount
    if (previousTimingPath === undefined) delete process.env[HOOK_TIMINGS_PATH_ENV]
    else process.env[HOOK_TIMINGS_PATH_ENV] = previousTimingPath
  }

  const finishedAt = new Date().toISOString()
  const skipped = exitCode === 0 && (change.kind === 'deletion_only' || change.kind === 'none')
  await appendTimingRecord(
    {
      schemaVersion: HOOK_TIMING_SCHEMA_VERSION,
      recordType: 'hook',
      recordedAt: finishedAt,
      runId,
      hook: typedHook,
      startedAt,
      finishedAt,
      durationMs: roundDurationMs(performance.now() - start),
      result: exitCode !== 0 ? 'failed' : skipped ? 'skipped' : 'passed',
      exitCode,
      change,
      ...gitIdentity(process.cwd()),
      platform: process.platform,
      arch: process.arch,
      bunVersion: Bun.version,
      lefthookVersion: await lefthookVersion(),
    },
    { path: timingPath }
  )
  if (spawnError) throw spawnError
  return exitCode
}

process.exit(await main())
