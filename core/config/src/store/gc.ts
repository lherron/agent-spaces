import type { Dirent, Stats } from 'node:fs'
import { lstat, readFile, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { LockFile, Sha256Integrity } from '../core/index.js'
import {
  type CacheOptions,
  computePluginCacheKey,
  deleteCache,
  getCacheSize,
  listCacheEntries,
} from './cache.js'
import type { PathResolver } from './paths.js'
import { type SnapshotOptions, deleteSnapshot, getSnapshotSize, listSnapshots } from './snapshot.js'

export const DEFAULT_BUNDLE_VERSION_RETAIN_RECENT = 3
export const DEFAULT_BUNDLE_VERSION_MIN_AGE_MS = 15 * 60 * 1000

const VERSION_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/i
const REFERENCE_FILE_PATTERN = /\.(json|jsonl|ndjson|toml|ya?ml|md|txt|log)$/i
const MAX_REFERENCE_FILE_BYTES = 10 * 1024 * 1024

/**
 * GC result statistics.
 */
export interface GCResult {
  /** Number of snapshots deleted */
  snapshotsDeleted: number
  /** Number of cache entries deleted */
  cacheEntriesDeleted: number
  /** Number of codex-homes bundle .versions entries deleted */
  bundleVersionsDeleted: number
  /** Bytes freed (approximate) */
  bytesFreed: number
}

/**
 * Options for garbage collection.
 */
export interface GCOptions {
  /** Path resolver for storage locations */
  paths: PathResolver
  /** Working directory (for snapshot operations) */
  cwd: string
  /** Dry run - don't actually delete anything */
  dryRun?: boolean | undefined
  /** Number of non-current recent bundle versions to retain per .versions root */
  bundleVersionRetainRecent?: number | undefined
  /** Minimum age before a bundle version is eligible for pruning */
  bundleVersionMinAgeMs?: number | undefined
  /** Additional roots to scan for durable references to versioned bundle paths */
  bundleVersionReferenceRoots?: string[] | undefined
}

export interface BundleVersionPruneResult {
  root: string
  scanned: number
  versionsDeleted: number
  skippedCurrent: number
  skippedRecent: number
  skippedFresh: number
  skippedReferenced: number
  skippedOther: number
  errors: number
  bytesFreed: number
}

export interface BundleVersionPruneOptions {
  /** Path to codex-homes/<scope>/bundles/.versions */
  versionsRoot: string
  /** Fingerprints that must survive because this publish returned them */
  currentFingerprints?: Set<string> | string[] | undefined
  /** Number of non-current recent versions to retain */
  keepRecent?: number | undefined
  /** Minimum age before a version can be deleted */
  minAgeMs?: number | undefined
  /** Current time override for tests */
  nowMs?: number | undefined
  /** Reference roots to scan for durable versioned bundle paths */
  referenceRoots?: string[] | undefined
  /** Dry run - don't delete */
  dryRun?: boolean | undefined
}

/**
 * Compute the set of reachable integrities from lock files.
 */
export function computeReachableIntegrities(lockFiles: LockFile[]): Set<Sha256Integrity> {
  const reachable = new Set<Sha256Integrity>()

  for (const lock of lockFiles) {
    for (const entry of Object.values(lock.spaces)) {
      reachable.add(entry.integrity)
    }
  }

  return reachable
}

/**
 * Compute the set of reachable cache keys from lock files.
 */
export function computeReachableCacheKeys(lockFiles: LockFile[]): Set<string> {
  const reachable = new Set<string>()

  for (const lock of lockFiles) {
    for (const entry of Object.values(lock.spaces)) {
      const cacheKey = computePluginCacheKey(
        entry.integrity,
        entry.plugin.name,
        entry.plugin.version ?? '0.0.0'
      )
      reachable.add(cacheKey)
    }
  }

  return reachable
}

function emptyBundleVersionPruneResult(root: string): BundleVersionPruneResult {
  return {
    root,
    scanned: 0,
    versionsDeleted: 0,
    skippedCurrent: 0,
    skippedRecent: 0,
    skippedFresh: 0,
    skippedReferenced: 0,
    skippedOther: 0,
    errors: 0,
    bytesFreed: 0,
  }
}

async function dirSize(path: string): Promise<number> {
  let total = 0
  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }

  for (const entry of entries) {
    const child = join(path, entry.name)
    try {
      const stats = await lstat(child)
      if (stats.isDirectory()) {
        total += await dirSize(child)
      } else if (stats.isFile()) {
        total += stats.size
      }
    } catch {
      // Size is best-effort for GC reporting.
    }
  }
  return total
}

function isWithinPath(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`))
}

function referenceRootsForVersionsRoot(
  versionsRoot: string,
  roots: string[] | undefined
): string[] {
  if (roots && roots.length > 0) {
    return roots
  }
  const scopeRoot = dirname(dirname(versionsRoot))
  const aspHome = dirname(dirname(scopeRoot))
  return [join(aspHome, 'tmp'), join(aspHome, 'codex-homes')]
}

function collectReferencesFromText(
  text: string,
  versionsRoot: string,
  candidates: Set<string>
): Set<string> {
  const referenced = new Set<string>()
  const marker = `${versionsRoot}/`
  for (const hash of candidates) {
    if (text.includes(`${marker}${hash}/`) || text.includes(`${marker}${hash}"`)) {
      referenced.add(hash)
    }
  }

  const genericPattern = /(?:^|[/\\])\.versions[/\\]([a-f0-9]{64})(?:[/\\]|"|'|$)/gi
  for (const match of text.matchAll(genericPattern)) {
    const hash = match[1]?.toLowerCase()
    if (hash && candidates.has(hash)) {
      referenced.add(hash)
    }
  }
  return referenced
}

async function collectReferencedBundleVersions(options: {
  versionsRoot: string
  candidates: Set<string>
  referenceRoots?: string[] | undefined
}): Promise<Set<string>> {
  const referenced = new Set<string>()
  const roots = referenceRootsForVersionsRoot(options.versionsRoot, options.referenceRoots)

  async function scan(path: string): Promise<void> {
    let stats: Stats
    try {
      stats = await lstat(path)
    } catch {
      return
    }

    if (isWithinPath(path, options.versionsRoot)) {
      return
    }

    if (stats.isDirectory()) {
      let entries: Dirent[]
      try {
        entries = await readdir(path, { withFileTypes: true })
      } catch {
        return
      }
      await Promise.all(entries.map((entry) => scan(join(path, entry.name))))
      return
    }

    if (!stats.isFile() || stats.size > MAX_REFERENCE_FILE_BYTES) {
      return
    }
    if (!REFERENCE_FILE_PATTERN.test(basename(path))) {
      return
    }

    try {
      const text = await readFile(path, 'utf8')
      for (const hash of collectReferencesFromText(
        text,
        options.versionsRoot,
        options.candidates
      )) {
        referenced.add(hash)
      }
    } catch {
      // Reference scanning is conservative best effort; unreadable files do not block GC.
    }
  }

  await Promise.all(roots.map((root) => scan(root)))
  return referenced
}

interface BundleVersionEntry {
  hash: string
  path: string
  mtimeMs: number
}

async function listBundleVersionEntries(versionsRoot: string): Promise<BundleVersionEntry[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(versionsRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const versions: BundleVersionEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !VERSION_FINGERPRINT_PATTERN.test(entry.name)) {
      continue
    }
    const path = join(versionsRoot, entry.name)
    try {
      const stats = await lstat(path)
      if (!stats.isDirectory()) continue
      versions.push({ hash: entry.name.toLowerCase(), path, mtimeMs: stats.mtimeMs })
    } catch {
      // A concurrent publisher/pruner may have moved it. Ignore and continue.
    }
  }
  return versions
}

export async function pruneBundleVersions(
  options: BundleVersionPruneOptions
): Promise<BundleVersionPruneResult> {
  const result = emptyBundleVersionPruneResult(options.versionsRoot)
  const versions = await listBundleVersionEntries(options.versionsRoot)
  result.scanned = versions.length
  if (versions.length === 0) {
    return result
  }

  const current = new Set(
    Array.from(options.currentFingerprints ?? [])
      .map((hash) => hash.toLowerCase())
      .filter((hash) => VERSION_FINGERPRINT_PATTERN.test(hash))
  )
  const sortedNewestFirst = [...versions].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || b.hash.localeCompare(a.hash)
  )

  if (current.size === 0 && sortedNewestFirst[0]) {
    current.add(sortedNewestFirst[0].hash)
  }

  const keepRecent = options.keepRecent ?? DEFAULT_BUNDLE_VERSION_RETAIN_RECENT
  const retainedRecent = new Set<string>()
  for (const version of sortedNewestFirst) {
    if (current.has(version.hash)) continue
    if (retainedRecent.size >= keepRecent) break
    retainedRecent.add(version.hash)
  }

  const candidateHashes = new Set(
    versions
      .map((version) => version.hash)
      .filter((hash) => !current.has(hash) && !retainedRecent.has(hash))
  )
  const referenced = await collectReferencedBundleVersions({
    versionsRoot: options.versionsRoot,
    candidates: candidateHashes,
    referenceRoots: options.referenceRoots,
  })
  const nowMs = options.nowMs ?? Date.now()
  const minAgeMs = options.minAgeMs ?? DEFAULT_BUNDLE_VERSION_MIN_AGE_MS

  for (const version of sortedNewestFirst) {
    if (current.has(version.hash)) {
      result.skippedCurrent += 1
      continue
    }
    if (retainedRecent.has(version.hash)) {
      result.skippedRecent += 1
      continue
    }
    if (referenced.has(version.hash)) {
      result.skippedReferenced += 1
      continue
    }
    if (nowMs - version.mtimeMs < minAgeMs) {
      result.skippedFresh += 1
      continue
    }

    try {
      const size = await dirSize(version.path)
      result.bytesFreed += size
      if (!options.dryRun) {
        await rm(version.path, { recursive: true, force: true })
      }
      result.versionsDeleted += 1
    } catch {
      result.errors += 1
    }
  }

  return result
}

async function listBundleVersionRoots(aspHome: string): Promise<string[]> {
  const codexHomesRoot = join(aspHome, 'codex-homes')
  let entries: Dirent[]
  try {
    entries = await readdir(codexHomesRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const roots: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const root = join(codexHomesRoot, entry.name, 'bundles', '.versions')
    try {
      const stats = await lstat(root)
      if (stats.isDirectory()) roots.push(root)
    } catch {
      // No versioned bundles for this scope.
    }
  }
  return roots
}

/**
 * Run garbage collection on the store and cache.
 */
export async function runGC(lockFiles: LockFile[], options: GCOptions): Promise<GCResult> {
  const result: GCResult = {
    snapshotsDeleted: 0,
    cacheEntriesDeleted: 0,
    bundleVersionsDeleted: 0,
    bytesFreed: 0,
  }

  // Compute reachable sets
  const reachableIntegrities = computeReachableIntegrities(lockFiles)
  const reachableCacheKeys = computeReachableCacheKeys(lockFiles)

  // GC snapshots
  const snapshotOpts: SnapshotOptions = {
    paths: options.paths,
    cwd: options.cwd,
  }

  const snapshots = await listSnapshots(snapshotOpts)
  for (const integrity of snapshots) {
    if (!reachableIntegrities.has(integrity)) {
      // Compute size before deletion
      const size = await getSnapshotSize(integrity, snapshotOpts)
      result.bytesFreed += size

      if (!options.dryRun) {
        await deleteSnapshot(integrity, snapshotOpts)
      }
      result.snapshotsDeleted++
    }
  }

  // GC cache
  const cacheOpts: CacheOptions = { paths: options.paths }
  const cacheEntries = await listCacheEntries(cacheOpts)

  for (const cacheKey of cacheEntries) {
    if (!reachableCacheKeys.has(cacheKey)) {
      // Compute size before deletion
      const size = await getCacheSize(cacheKey, cacheOpts)
      result.bytesFreed += size

      if (!options.dryRun) {
        await deleteCache(cacheKey, cacheOpts)
      }
      result.cacheEntriesDeleted++
    }
  }

  // GC versioned materialized bundles under codex-homes/<scope>/bundles/.versions.
  const bundleVersionRoots = await listBundleVersionRoots(options.paths.aspHome)
  for (const versionsRoot of bundleVersionRoots) {
    const pruned = await pruneBundleVersions({
      versionsRoot,
      keepRecent: options.bundleVersionRetainRecent,
      minAgeMs: options.bundleVersionMinAgeMs,
      referenceRoots: options.bundleVersionReferenceRoots,
      dryRun: options.dryRun,
    })
    result.bundleVersionsDeleted += pruned.versionsDeleted
    result.bytesFreed += pruned.bytesFreed
  }

  return result
}

/**
 * Check what would be garbage collected without actually deleting.
 */
export async function checkGC(lockFiles: LockFile[], options: GCOptions): Promise<GCResult> {
  return runGC(lockFiles, { ...options, dryRun: true })
}
