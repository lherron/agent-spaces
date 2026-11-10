/**
 * Scope-root retirement for `asp gc --scope-roots`.
 *
 * Bundle versions inside a scope root are pruned on every compile, but the
 * roots themselves (`<ASP_HOME>/codex-homes/<scope>/`) never were. A root is
 * retired only when no running process on this node names a path under it, its
 * newest bundle version (or the root itself) is older than the minimum age, and
 * its agent is not a target of the global lock. The next compile for that agent
 * and project recreates a retired root.
 *
 * Liveness is per node: the process table of the node gc runs on.
 */
import { spawnSync } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { lstat, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { LockFile } from '../core/index.js'
import { sanitizeProjectAgentScopeSegment } from './paths.js'

export const DEFAULT_SCOPE_ROOT_MIN_AGE_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000
/** `<projectSlug>_<agentSlug>` public scope roots. */
const PROJECT_AGENT_ROOT = /^[a-z0-9.-][a-z0-9._-]*_[a-z0-9._-]+$/
/** Codex runtime-key roots (drivers/execution run-codex computeCodexRuntimeKey). */
const RUNTIME_KEY_ROOT = /^[0-9a-f]{24}$/

export type ScopeRootReason =
  | 'not-scope-root'
  | 'live'
  | 'age'
  | 'global-lock'
  | 'unidentified'
  | 'retire'

export interface ScopeRootDecision {
  name: string
  path: string
  bytes: number
  retire: boolean
  reason: ScopeRootReason
  detail: string
  error?: string | undefined
}

export interface ScopeRootGCResult {
  decisions: ScopeRootDecision[]
  counts: Record<ScopeRootReason, number>
  bytes: Record<ScopeRootReason, number>
  retiredBytes: number
  keptBytes: number
  errors: number
}

export interface ScopeRootGCOptions {
  aspHome: string
  /** Global lock; its targets name agents whose scope roots are kept. */
  globalLock?: LockFile | undefined
  minAgeDays?: number | undefined
  dryRun?: boolean | undefined
  nowMs?: number | undefined
  /** Process command lines with environments; defaults to this node's `ps`. */
  processTexts?: string[] | undefined
}

/**
 * Command line and environment of every running process this user can see.
 * Throws when ps fails, so a failed scan retires nothing.
 */
export function runningProcessTexts(): string[] {
  // -E appends each process's environment (own processes) after its argv; -ww: no truncation.
  const args = process.platform === 'linux' ? ['axeww', '-o', 'args'] : ['-AEww', '-o', 'command']
  const ps = spawnSync('ps', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (ps.status !== 0 || ps.error) {
    throw new Error(
      `scope-root gc refused: ps failed: ${ps.error?.message ?? ps.stderr ?? ps.status}`
    )
  }
  return ps.stdout.split('\n')
}

/** Scope-root names any process text names a path under, by configured or real path. */
export function scopeRootsInUse(codexHomesPrefixes: string[], texts: string[]): Set<string> {
  const inUse = new Set<string>()
  const prefixes = [...new Set(codexHomesPrefixes.map((dir) => `${dir.replace(/\/+$/, '')}/`))]
  for (const text of texts) {
    for (const prefix of prefixes) {
      let at = text.indexOf(prefix)
      while (at !== -1) {
        const name = text.slice(at + prefix.length).split(/[/\s:"',;=]/, 1)[0] ?? ''
        if (name) inUse.add(name)
        at = text.indexOf(prefix, at + prefix.length)
      }
    }
  }
  return inUse
}

/** Disk usage per direct child of `dir`, in bytes, from one `du` pass. */
function childSizes(dir: string): Map<string, number> {
  const sizes = new Map<string, number>()
  const du = spawnSync('du', ['-k', '-d', '1', dir], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  // du exits non-zero on an unreadable file but still reports the rest; sizes are for reporting.
  for (const line of (du.stdout ?? '').split('\n')) {
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const kb = Number(line.slice(0, tab))
    const path = line.slice(tab + 1)
    if (Number.isFinite(kb) && path.startsWith(`${dir}/`)) {
      sizes.set(path.slice(dir.length + 1), kb * 1024)
    }
  }
  return sizes
}

async function newestMtimeMs(root: string): Promise<number> {
  const versionsRoot = join(root, 'bundles', '.versions')
  let entries: Dirent[] = []
  try {
    entries = await readdir(versionsRoot, { withFileTypes: true })
  } catch {
    // No bundle versions: the root's own mtime decides.
  }
  let newest = Number.NEGATIVE_INFINITY
  for (const entry of entries) {
    try {
      newest = Math.max(newest, (await lstat(join(versionsRoot, entry.name))).mtimeMs)
    } catch {
      // Raced with a prune; the remaining entries decide.
    }
  }
  if (newest === Number.NEGATIVE_INFINITY) {
    newest = (await lstat(root)).mtimeMs
  }
  return newest
}

/** The agent a scope root belongs to, when it can be read. */
async function scopeRootAgentMatch(
  name: string,
  root: string,
  globalAgents: Set<string>
): Promise<{ agent?: string | undefined; inGlobalLock: boolean }> {
  if (RUNTIME_KEY_ROOT.test(name)) {
    try {
      const meta = JSON.parse(await readFile(join(root, 'home', '.asp-runtime.json'), 'utf8')) as {
        targetName?: unknown
      }
      if (typeof meta.targetName !== 'string') return { inGlobalLock: false }
      const agent = sanitizeProjectAgentScopeSegment(meta.targetName)
      return { agent, inGlobalLock: globalAgents.has(agent) }
    } catch {
      return { inGlobalLock: false }
    }
  }
  // `<project>_<agent>`: either slug may contain '_', so match every global agent as a suffix.
  for (const agent of globalAgents) {
    if (name.endsWith(`_${agent}`) && name.length > agent.length + 1) {
      return { agent, inGlobalLock: true }
    }
  }
  return { agent: name.slice(name.lastIndexOf('_') + 1), inGlobalLock: false }
}

function emptyCounts(): Record<ScopeRootReason, number> {
  return { 'not-scope-root': 0, live: 0, age: 0, 'global-lock': 0, unidentified: 0, retire: 0 }
}

/**
 * Decide, and unless dryRun retire, every scope root under
 * `<aspHome>/codex-homes`. Each root gets one decision with its size and the
 * first rule that keeps it, in order: live reference, age, global-lock target,
 * unidentified agent.
 */
export async function retireScopeRoots(options: ScopeRootGCOptions): Promise<ScopeRootGCResult> {
  const codexHomes = join(options.aspHome, 'codex-homes')
  const result: ScopeRootGCResult = {
    decisions: [],
    counts: emptyCounts(),
    bytes: emptyCounts(),
    retiredBytes: 0,
    keptBytes: 0,
    errors: 0,
  }
  let entries: Dirent[]
  try {
    entries = await readdir(codexHomes, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw error
  }

  const minAgeDays = options.minAgeDays ?? DEFAULT_SCOPE_ROOT_MIN_AGE_DAYS
  const nowMs = options.nowMs ?? Date.now()
  const globalAgents = new Set(
    Object.keys(options.globalLock?.targets ?? {}).map(sanitizeProjectAgentScopeSegment)
  )
  // Sizes first (the slow pass), then the process table, so liveness is read
  // as close to the deletes as possible.
  const sizes = childSizes(codexHomes)
  const inUse = scopeRootsInUse(
    [codexHomes, await realpath(codexHomes)],
    options.processTexts ?? runningProcessTexts()
  )

  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
  for (const name of dirs) {
    const path = join(codexHomes, name)
    const bytes = sizes.get(name) ?? 0
    const decide = (reason: ScopeRootReason, detail: string): ScopeRootDecision => ({
      name,
      path,
      bytes,
      retire: reason === 'retire',
      reason,
      detail,
    })
    let decision: ScopeRootDecision
    if (!PROJECT_AGENT_ROOT.test(name) && !RUNTIME_KEY_ROOT.test(name)) {
      decision = decide('not-scope-root', 'name is not <project>_<agent> or a runtime key')
    } else if (inUse.has(name)) {
      decision = decide('live', 'a running process names a path under it')
    } else {
      const newest = await newestMtimeMs(path)
      const ageDays = (nowMs - newest) / DAY_MS
      const newestText = `newest ${new Date(newest).toISOString().slice(0, 10)}, ${Math.floor(ageDays)}d`
      if (ageDays < minAgeDays) {
        decision = decide('age', `${newestText} < ${minAgeDays}d`)
      } else {
        const match = await scopeRootAgentMatch(name, path, globalAgents)
        if (match.inGlobalLock) {
          decision = decide(
            'global-lock',
            `${newestText}; agent ${match.agent} is a global-lock target`
          )
        } else if (!match.agent) {
          decision = decide(
            'unidentified',
            `${newestText}; agent unreadable from home/.asp-runtime.json`
          )
        } else {
          decision = decide(
            'retire',
            `${newestText}; no live reference; agent ${match.agent} not in global lock`
          )
        }
      }
    }

    if (decision.retire && !options.dryRun) {
      // Rename first so no reader sees a half-deleted root, then remove.
      const retiring = join(codexHomes, `.retiring-${name}-${process.pid}-${nowMs}`)
      try {
        await rename(path, retiring)
        await rm(retiring, { recursive: true, force: true })
      } catch (error) {
        decision.error = error instanceof Error ? error.message : String(error)
        result.errors += 1
      }
    }
    result.counts[decision.reason] += 1
    result.bytes[decision.reason] += bytes
    if (decision.retire) result.retiredBytes += bytes
    else result.keptBytes += bytes
    result.decisions.push(decision)
  }
  return result
}
