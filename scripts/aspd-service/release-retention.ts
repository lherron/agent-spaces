/**
 * Release retention at activation. Each install adds a ~270 MB read-only
 * release dir under `<ns>/releases`; without a bound they fill the disk (mini
 * reached 15 GiB free with 22 releases, R-00600).
 *
 * Kept: the active release, the rollback (`previousReleaseId`), the newest
 * {@link RETAINED_RECENT_RELEASES} by release timestamp, and every release a
 * running process still runs from. Long-lived seats keep their broker and hook
 * binaries from the release they started on, so a newer activation does not
 * make an older release unused.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const RETAINED_RECENT_RELEASES = 3

const RELEASE_ID = /^asp-[0-9a-f]{12}-(\d{8}T\d{6}Z)-[0-9a-f]{6}$/

export type ReleasePruneResult = {
  kept: string[]
  removed: string[]
  inUse: string[]
  failed: { releaseId: string; error: string }[]
}

/** Release ids named in any running process's command line, as `<releases>/<id>`. */
export function releasesInUse(releasesDir: string, commands = runningCommands()): Set<string> {
  const inUse = new Set<string>()
  // A process may name the releases dir by its configured path or its realpath.
  const prefixes = [...new Set([releasesDir, realpathSync(releasesDir)])].map(
    (dir) => `${dir.replace(/\/+$/, '')}/`
  )
  for (const command of commands) {
    for (const prefix of prefixes) {
      let at = command.indexOf(prefix)
      while (at !== -1) {
        const id = command.slice(at + prefix.length).split(/[/\s]/, 1)[0] ?? ''
        if (RELEASE_ID.test(id)) inUse.add(id)
        at = command.indexOf(prefix, at + prefix.length)
      }
    }
  }
  return inUse
}

function runningCommands(): string[] {
  const ps = spawnSync('ps', ['-Ao', 'command'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (ps.status !== 0) throw new Error(`ps failed: ${ps.stderr || ps.status}`)
  return ps.stdout.split('\n')
}

/** Release dirs are installed read-only; unlinking their entries needs write on each dir. */
function makeWritable(dir: string): void {
  chmodSync(dir, 0o755)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) makeWritable(join(dir, entry.name))
  }
}

export function pruneReleases(
  releasesDir: string,
  selection: { activeReleaseId: string; previousReleaseId?: string | null | undefined },
  options: { commands?: string[]; keepRecent?: number } = {}
): ReleasePruneResult {
  const releases = readdirSync(releasesDir)
    .filter((name) => RELEASE_ID.test(name) && statSync(join(releasesDir, name)).isDirectory())
    .sort((a, b) => (RELEASE_ID.exec(b)?.[1] ?? '').localeCompare(RELEASE_ID.exec(a)?.[1] ?? ''))
  // Fail closed: if the process scan fails, nothing is removed.
  const inUse = releasesInUse(releasesDir, options.commands)
  const keep = new Set([
    selection.activeReleaseId,
    ...(selection.previousReleaseId ? [selection.previousReleaseId] : []),
    ...releases.slice(0, options.keepRecent ?? RETAINED_RECENT_RELEASES),
    ...inUse,
  ])
  const result: ReleasePruneResult = { kept: [], removed: [], inUse: [...inUse], failed: [] }
  for (const releaseId of releases) {
    if (keep.has(releaseId)) {
      result.kept.push(releaseId)
      continue
    }
    try {
      const path = join(releasesDir, releaseId)
      makeWritable(path)
      rmSync(path, { recursive: true, force: true })
      result.removed.push(releaseId)
    } catch (error) {
      result.failed.push({
        releaseId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}
