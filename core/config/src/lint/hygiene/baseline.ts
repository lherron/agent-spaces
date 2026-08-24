/**
 * Baseline suppression for hygiene warnings (grandfathering pattern, mirroring
 * .suppression-baseline.json).
 *
 * WHY: Turning W4xx on across existing agents would explode day one. A reviewed
 * baseline records the current findings' fingerprints so only NEW findings surface;
 * `--update-baseline` regenerates it (intentional grandfather/reset only).
 *
 * A fingerprint is sha256(code \0 relPath \0 message). Paths are stored relative to
 * a baseline root so the file is portable across checkouts. Line-anchored tripwire
 * paths (…:NN) are normalized to the file so a finding is not un-suppressed by a
 * one-line shift.
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import type { LintWarning } from '../types.js'

export interface BaselineEntry {
  path: string
  code: string
  hash: string
}

export interface HygieneBaseline {
  _meta?: unknown
  suppressions: BaselineEntry[]
}

const BASELINE_META = {
  schemaVersion: 1,
  generatedBy: 'asp lint --hygiene --update-baseline',
  warning:
    'new hygiene findings surface automatically; baseline update is for intentional grandfather/reset only and must be reviewed',
}

/** Strip a trailing `:NN` line anchor from a warning path. */
function normalizePath(path: string | undefined): string {
  if (!path) {
    return ''
  }
  return path.replace(/:\d+$/, '')
}

/** Path relative to baselineRoot when possible, else the (normalized) absolute path. */
function relPath(path: string, baselineRoot: string | undefined): string {
  const norm = normalizePath(path)
  if (baselineRoot && isAbsolute(norm)) {
    const rel = relative(baselineRoot, norm)
    if (!rel.startsWith('..')) {
      return rel
    }
  }
  return norm
}

/** Stable fingerprint for a warning. */
export function fingerprint(w: LintWarning, baselineRoot: string | undefined): string {
  const h = createHash('sha256')
  h.update(`${w.code}\0${relPath(w.path ?? '', baselineRoot)}\0${w.message}`)
  return h.digest('hex')
}

/** Load a baseline file; returns an empty baseline if missing/invalid. */
export async function loadBaseline(path: string): Promise<HygieneBaseline> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<HygieneBaseline>
    const suppressions = Array.isArray(parsed.suppressions) ? parsed.suppressions : []
    return { suppressions: suppressions as BaselineEntry[] }
  } catch {
    return { suppressions: [] }
  }
}

/**
 * Partition warnings into `kept` (not in the baseline) and `suppressed` (grandfathered).
 */
export function applyBaseline(
  warnings: LintWarning[],
  baseline: HygieneBaseline,
  baselineRoot: string | undefined
): { kept: LintWarning[]; suppressed: LintWarning[] } {
  const suppressedHashes = new Set(baseline.suppressions.map((s) => s.hash))
  const kept: LintWarning[] = []
  const suppressed: LintWarning[] = []
  for (const w of warnings) {
    if (suppressedHashes.has(fingerprint(w, baselineRoot))) {
      suppressed.push(w)
    } else {
      kept.push(w)
    }
  }
  return { kept, suppressed }
}

/** Write a baseline capturing every current warning's fingerprint. */
export async function writeBaseline(
  path: string,
  warnings: LintWarning[],
  baselineRoot: string | undefined
): Promise<number> {
  const seen = new Set<string>()
  const suppressions: BaselineEntry[] = []
  for (const w of warnings) {
    const hash = fingerprint(w, baselineRoot)
    if (seen.has(hash)) {
      continue
    }
    seen.add(hash)
    suppressions.push({ path: relPath(w.path ?? '', baselineRoot), code: w.code, hash })
  }
  suppressions.sort(
    (a, b) =>
      a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.hash.localeCompare(b.hash)
  )
  const body = { _meta: BASELINE_META, suppressions }
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`)
  return suppressions.length
}
