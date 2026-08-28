import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { ChangeClassification, ClassifiedChangeScope, HookName } from './hook-change-scope.ts'

export const HOOK_TIMING_SCHEMA_VERSION = 1
export const HOOK_RUN_ID_ENV = 'AGENT_SPACES_HOOK_RUN_ID'
export const HOOK_TIMINGS_PATH_ENV = 'AGENT_SPACES_HOOK_TIMINGS_PATH'
export const HOOK_CHANGE_KIND_ENV = 'AGENT_SPACES_HOOK_CHANGE_KIND'
export const HOOK_CHANGE_FILE_COUNT_ENV = 'AGENT_SPACES_HOOK_CHANGE_FILE_COUNT'

const changeClassifications = new Set<ChangeClassification>([
  'code',
  'documentation',
  'deletion_only',
  'none',
  'ambiguous',
])

interface BaseTimingRecord {
  schemaVersion: typeof HOOK_TIMING_SCHEMA_VERSION
  recordedAt: string
  runId: string
  hook: HookName
  startedAt: string
  durationMs: number
  result: 'passed' | 'failed' | 'skipped'
  exitCode: number | null
  change: {
    kind: ChangeClassification
    fileCount: number
  }
}

export interface HookTimingRecord extends BaseTimingRecord {
  recordType: 'hook'
  finishedAt: string
  head?: string | undefined
  branch?: string | undefined
  platform: NodeJS.Platform
  arch: string
  bunVersion: string
  lefthookVersion?: string | undefined
}

export interface HookStepTimingRecord extends BaseTimingRecord {
  recordType: 'step'
  step: string
}

export type TimingRecord = HookTimingRecord | HookStepTimingRecord

export function roundDurationMs(value: number): number {
  return Math.round(value * 100) / 100
}

export function changeScopeFromEnvironment(): ClassifiedChangeScope {
  const kind = process.env[HOOK_CHANGE_KIND_ENV] as ChangeClassification | undefined
  const fileCount = Number.parseInt(process.env[HOOK_CHANGE_FILE_COUNT_ENV] ?? '', 10)
  return {
    kind: kind && changeClassifications.has(kind) ? kind : 'ambiguous',
    fileCount: Number.isSafeInteger(fileCount) && fileCount >= 0 ? fileCount : 0,
  }
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) return undefined
  const output = result.stdout.toString().trim()
  return output === '' ? undefined : output
}

export function gitIdentity(cwd = process.cwd()): {
  head?: string | undefined
  branch?: string | undefined
} {
  return {
    head: gitOutput(cwd, ['rev-parse', 'HEAD']),
    branch: gitOutput(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  }
}

export function resolveHookTimingsPath(cwd = process.cwd()): string {
  const override = process.env[HOOK_TIMINGS_PATH_ENV]
  if (override) return isAbsolute(override) ? override : resolve(cwd, override)

  const result = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(`unable to resolve Git common directory${detail ? `: ${detail}` : ''}`)
  }
  const commonDir = result.stdout.toString().trim()
  const absoluteCommonDir = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir)
  return join(absoluteCommonDir, 'praesidium', 'hook-timings.jsonl')
}

export async function appendTimingRecord(
  record: TimingRecord,
  options: { cwd?: string; path?: string } = {}
): Promise<boolean> {
  try {
    const path = options.path ?? resolveHookTimingsPath(options.cwd)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
    return true
  } catch (error) {
    console.error(`[hook-timing] unable to record timing: ${error}`)
    return false
  }
}

export async function readTimingRecords(path: string): Promise<{
  records: TimingRecord[]
  malformedLines: number
}> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return { records: [], malformedLines: 0 }
    throw error
  }

  const records: TimingRecord[] = []
  let malformedLines = 0
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value = JSON.parse(line) as Partial<TimingRecord>
      if (
        value.schemaVersion !== HOOK_TIMING_SCHEMA_VERSION ||
        (value.recordType !== 'hook' && value.recordType !== 'step') ||
        typeof value.runId !== 'string' ||
        typeof value.durationMs !== 'number'
      ) {
        malformedLines += 1
        continue
      }
      records.push(value as TimingRecord)
    } catch {
      malformedLines += 1
    }
  }
  return { records, malformedLines }
}
