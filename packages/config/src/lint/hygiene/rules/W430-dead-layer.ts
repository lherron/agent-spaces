/**
 * W430 (XL0): agent-root instruction file in no load path — a dead layer.
 *
 * WHY (CROSS-LAYER.md XL0, task comment C-06838): a dead layer is worse than
 * duplication — it rots invisibly while its owner believes it is in force. The
 * pilot found clod's virtu e2e SOP lived only in AGENTS.md / CLAUDE.md, neither of
 * which is in any load path since the bundle-home migration (context templates
 * compose SOUL.md + AGENT_MOTD.md + agent-profile additionalBase, never AGENTS.md).
 *
 * Static detection: an agent-root instruction file (harness-convention names) that
 * no context template / profile references, and that is not an alias of a live file.
 * critical(4) → severity `error` (fails --strict).
 */

import { readlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { LintWarning } from '../../types.js'
import type { HygieneContext } from '../types.js'
import { HYGIENE_CODES } from '../types.js'

/**
 * Harness-convention instruction files agents assume load. Under the bundle-home
 * model these are only live if a context template explicitly references them.
 */
const INSTRUCTION_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules'])

export function checkDeadLayer(ctx: HygieneContext): LintWarning[] {
  const warnings: LintWarning[] = []
  const rootsByAgent = new Map(ctx.agentRoots.map((r) => [r.agentId, r]))

  for (const unit of ctx.units) {
    if (unit.kind !== 'prompt') {
      continue
    }
    const name = basename(unit.path)
    if (!INSTRUCTION_FILES.has(name)) {
      continue
    }
    const info = unit.agentId ? rootsByAgent.get(unit.agentId) : undefined
    if (info === undefined) {
      continue
    }
    if (info.referencedFiles.has(name)) {
      continue
    }

    // A symlink to a live file is still dead as an instruction surface, but note the
    // alias so the evidence is complete (byte-identical twins in the pilot).
    let aliasNote = ''
    try {
      const target = readlinkSync(unit.path)
      aliasNote = ` (symlink -> ${basename(target)})`
    } catch {
      aliasNote = ''
    }

    warnings.push({
      code: HYGIENE_CODES.DEAD_LAYER,
      message: `Dead layer: '${name}'${aliasNote} at the agent root is referenced by no context template or profile, so it reaches no session. Fold unique content into a live home (usually a skill) and delete, or make the load explicit if it is meant to be live.`,
      severity: 'error',
      path: unit.path,
      details: { unit: unit.key, file: name, agentId: unit.agentId, root: join(info.root) },
    })
  }

  return warnings
}
