import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getAspHome } from './paths.js'

export const DEFAULT_LAUNCH_OVERLAY_MAX_AGE_MS = 15 * 60 * 1000
export const DEFAULT_STAGING_MAX_AGE_MS = 60 * 60 * 1000

export interface TempSweepStats {
  root: string
  scanned: number
  removed: number
  skippedFresh: number
  skippedLive: number
  skippedOther: number
  errors: number
}

export interface AspTempSweepResult {
  launchOverlays: TempSweepStats
  staging: TempSweepStats
}

export interface SweepAspTempArtifactsOptions {
  aspHome?: string | undefined
  nowMs?: number | undefined
  launchOverlayMaxAgeMs?: number | undefined
  stagingMaxAgeMs?: number | undefined
}

export interface RuntimeSystemPromptArtifact {
  systemPromptPath: string
  contentHash: string
}

export interface WriteRuntimeSystemPromptArtifactInput {
  aspHome?: string | undefined
  artifactRoot?: string | undefined
  content: string
}

function emptyStats(root: string): TempSweepStats {
  return {
    root,
    scanned: 0,
    removed: 0,
    skippedFresh: 0,
    skippedLive: 0,
    skippedOther: 0,
    errors: 0,
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function pidFromStagingDirName(name: string): number | undefined {
  const match = name.match(/-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  if (!match?.[1]) return undefined
  const pid = Number(match[1])
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

async function sweepChildDirs(options: {
  root: string
  nowMs: number
  maxAgeMs: number
  skipLivePidNames?: boolean | undefined
}): Promise<TempSweepStats> {
  const stats = emptyStats(options.root)
  let entries: Dirent[]
  try {
    entries = await readdir(options.root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stats.errors += 1
    return stats
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      stats.skippedOther += 1
      continue
    }
    stats.scanned += 1
    const child = join(options.root, entry.name)
    try {
      const info = await lstat(child)
      if (!info.isDirectory()) {
        stats.skippedOther += 1
        continue
      }
      const ageMs = options.nowMs - info.mtimeMs
      if (ageMs < options.maxAgeMs) {
        stats.skippedFresh += 1
        continue
      }
      if (options.skipLivePidNames === true) {
        const pid = pidFromStagingDirName(entry.name)
        if (pid !== undefined && isProcessAlive(pid)) {
          stats.skippedLive += 1
          continue
        }
      }
      await rm(child, { recursive: true, force: true })
      stats.removed += 1
    } catch {
      stats.errors += 1
    }
  }

  return stats
}

export async function sweepAspTempArtifacts(
  options: SweepAspTempArtifactsOptions = {}
): Promise<AspTempSweepResult> {
  const aspHome = options.aspHome ?? getAspHome()
  const nowMs = options.nowMs ?? Date.now()
  const launchRoot = join(aspHome, 'tmp', 'launch-overlays')
  const stagingRoot = join(aspHome, 'tmp', '.staging')
  const [launchOverlays, staging] = await Promise.all([
    sweepChildDirs({
      root: launchRoot,
      nowMs,
      maxAgeMs: options.launchOverlayMaxAgeMs ?? DEFAULT_LAUNCH_OVERLAY_MAX_AGE_MS,
    }),
    sweepChildDirs({
      root: stagingRoot,
      nowMs,
      maxAgeMs: options.stagingMaxAgeMs ?? DEFAULT_STAGING_MAX_AGE_MS,
      skipLivePidNames: true,
    }),
  ])
  return { launchOverlays, staging }
}

export async function writeRuntimeSystemPromptArtifact(
  input: WriteRuntimeSystemPromptArtifactInput
): Promise<RuntimeSystemPromptArtifact> {
  const aspHome = input.aspHome ?? getAspHome()
  const artifactRoot = input.artifactRoot ?? join(aspHome, 'runtime-artifacts')
  const contentHash = createHash('sha256').update(input.content).digest('hex')
  const artifactDir = join(artifactRoot, 'system-prompts', contentHash.slice(0, 2), contentHash)
  const systemPromptPath = join(artifactDir, 'system-prompt.md')
  await mkdir(artifactDir, { recursive: true })
  await writeFile(systemPromptPath, input.content, 'utf8')
  const now = new Date()
  await utimes(systemPromptPath, now, now).catch(() => {})
  return { systemPromptPath, contentHash }
}
