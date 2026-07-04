/**
 * Compose-time hygiene gate — cache-admission check.
 *
 * WHY: A freshly materialized plugin tree is about to be admitted to the reusable
 * cache. This gate lints that tree with the tier-1 W4xx hygiene rules and blocks
 * the cache write when the tree carries an `error`-severity finding that survives
 * the space's local baseline (unless force-compose is explicitly enabled). It is a
 * CACHE-ADMISSION gate, not a boot-time content policy: it runs only on fresh
 * reusable-cache writes (immutable registry spaces + `asp build`), never on mutable
 * dev/project/agent staging, which is never admitted to reusable cache.
 *
 * See T-05574 (daedalus ruling 2026-07-04, hrcchat #12061). Seam wiring lives in
 * `materialize.ts` (asp build) and `orchestration/install.ts` (immutable registry
 * branch); this module is the single shared evaluation both seams call.
 *
 * Predicate (Cond 2): a finding blocks iff `severity === 'error'` AFTER the local
 * baseline is applied — keyed on severity, NOT a hard-coded W-code list.
 *
 * Baseline (Cond 3): `.hygiene-baseline.json` at the SPACE SOURCE tree root
 * (author-controlled, travels with the space). Fingerprints are made portable by
 * anchoring `baselineRoot` at the materialized/space root, so the space-root-
 * relative paths (`skills/<name>/SKILL.md`) match between the source tree the
 * baseline was authored against and the materialized tree the gate lints. Absent
 * baseline ⇒ no suppression; unrelated parent trees are never searched.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { HygieneGateFinding } from '../core/index.js'
import { runHygieneTarget } from '../lint/hygiene/index.js'
import type { LintWarning } from '../lint/index.js'

/** Basename of the local baseline file at a space source tree root. */
export const HYGIENE_BASELINE_FILENAME = '.hygiene-baseline.json'

/** Named force-compose escape hatch env var (off by default). */
export const FORCE_COMPOSE_ENV = 'ASP_FORCE_COMPOSE_HYGIENE'

/** The severity that blocks a cache write. */
const ERROR_SEVERITY = 'error'

export interface HygieneGateInput {
  /**
   * Absolute path to the freshly materialized plugin/staging tree being admitted
   * to cache. Its `skills/` subtree is what the gate lints; `baselineRoot` anchors
   * here so finding paths are space-root-relative.
   */
  pluginPath: string
  /**
   * Absolute path to the SPACE SOURCE tree root (the snapshot/source dir that was
   * materialized). `${sourceRoot}/.hygiene-baseline.json` is the local baseline.
   */
  sourceRoot: string
  /** Space key for diagnostic attribution. */
  spaceKey: string
}

export interface HygieneGateResult {
  /** Error-severity, non-baselined findings — the BLOCKING set (empty ⇒ pass). */
  blocking: HygieneGateFinding[]
  /** All non-suppressed findings (advisory + blocking), deterministic order. */
  findings: HygieneGateFinding[]
  /** Findings suppressed by the local baseline. */
  suppressed: HygieneGateFinding[]
}

/** Is the named force-compose escape hatch enabled? Off unless "1"/"true". */
export function forceComposeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[FORCE_COMPOSE_ENV]
  return v === '1' || v === 'true'
}

function toFinding(w: LintWarning, spaceKey: string, pluginPath: string): HygieneGateFinding {
  return {
    spaceKey,
    pluginPath,
    code: w.code,
    severity: w.severity,
    ...(w.path !== undefined ? { path: w.path } : {}),
    message: w.message,
  }
}

/**
 * Evaluate the hygiene gate over a freshly materialized plugin tree. Pure and
 * read-only: runs the tier-1 hygiene lint over the tree's `skills/`, applies the
 * space's local baseline, and partitions findings by the `severity === 'error'`
 * predicate. Returns empty sets when the tree has no `skills/` dir (nothing to
 * lint). The CALLER decides what to do with `blocking` (throw to block the cache
 * write, or — under force-compose — surface a warning and proceed).
 */
export async function evaluateHygieneGate(input: HygieneGateInput): Promise<HygieneGateResult> {
  const skillsDir = join(input.pluginPath, 'skills')
  if (!existsSync(skillsDir)) {
    return { blocking: [], findings: [], suppressed: [] }
  }

  // baselineRoot = pluginPath (the materialized space root) ⇒ finding paths become
  // space-root-relative ("skills/<name>/SKILL.md"), matching a baseline authored
  // at the source root with baselineRoot = sourceRoot.
  const { warnings, suppressed } = await runHygieneTarget(skillsDir, {
    baselinePath: join(input.sourceRoot, HYGIENE_BASELINE_FILENAME),
    baselineRoot: input.pluginPath,
  })

  const findings = warnings.map((w) => toFinding(w, input.spaceKey, input.pluginPath))
  return {
    blocking: findings.filter((f) => f.severity === ERROR_SEVERITY),
    findings,
    suppressed: suppressed.map((w) => toFinding(w, input.spaceKey, input.pluginPath)),
  }
}
