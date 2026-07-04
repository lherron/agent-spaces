/**
 * Tier 2 — `--judge` mode. A headless agent runs the agent-hygiene rubric as a
 * system prompt over one unit and emits the rubric §7 JSON scorecard. Tier-1
 * mechanical results are embedded so the judge does not re-derive them.
 *
 * This module is the pure, testable core: the JSON schema, the prompt assembly, and
 * a structural validator. The actual agent turn is executed by an injected runner
 * (the CLI provides one that shells out to the installed agent-loop SDK) so the core
 * has no cross-repo dependency and unit-tests without spawning an agent.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LintWarning } from '../types.js'
import type { HygieneUnit } from './types.js'

/** Default location of the agent-hygiene criteria sources. */
export const DEFAULT_AGENT_HYGIENE_ROOT = join(
  process.env['HOME'] ?? '',
  'praesidium/archagent/agent-hygiene'
)

/**
 * JSON Schema for the rubric §7b scorecard. Passed to the agent so output is forced
 * valid, and re-checked by validateScorecard.
 */
export const RUBRIC_SCORECARD_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['unit', 'classification', 'score_pct', 'grade', 'critical_gate', 'criteria'],
  properties: {
    unit: { type: 'string' },
    path: { type: 'string' },
    classification: {
      type: 'object',
      required: ['invocation_mode', 'load_frequency'],
      properties: {
        archetypes: { type: 'array', items: { type: 'string' } },
        invocation_mode: { type: 'string' },
        load_frequency: { type: 'string' },
        classes_present: { type: 'array', items: { type: 'string' } },
      },
    },
    score_pct: { type: 'number' },
    grade: { type: 'string' },
    critical_gate: {
      type: 'object',
      required: ['passed'],
      properties: {
        passed: { type: 'boolean' },
        capped_by: { type: 'array', items: { type: 'string' } },
      },
    },
    mechanical: { type: 'object' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'weight', 'verdict', 'score'],
        properties: {
          id: { type: 'string' },
          bp: { type: 'string' },
          name: { type: 'string' },
          applicable: { type: 'boolean' },
          weight: { type: 'number' },
          verdict: { type: 'string', enum: ['pass', 'partial', 'fail', 'n-a'] },
          score: { type: 'number' },
          evidence: { type: 'string' },
          remediation: { type: 'string' },
        },
      },
    },
    advisory: { type: 'array' },
    not_assessable: { type: 'array' },
    remediation: { type: 'array' },
    blockers: { type: 'array' },
  },
} as const

export interface Scorecard {
  unit: string
  path?: string
  classification: { invocation_mode: string; load_frequency: string; [k: string]: unknown }
  score_pct: number
  grade: string
  critical_gate: { passed: boolean; capped_by?: string[] }
  criteria: Array<{
    id: string
    weight: number
    verdict: string
    score: number
    [k: string]: unknown
  }>
  [k: string]: unknown
}

/** Structural validation against RUBRIC_SCORECARD_SCHEMA. Returns human-readable errors. */
export function validateScorecard(obj: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (typeof obj !== 'object' || obj === null) {
    return { valid: false, errors: ['scorecard is not an object'] }
  }
  const o = obj as Record<string, unknown>
  for (const key of RUBRIC_SCORECARD_SCHEMA.required) {
    if (!(key in o)) {
      errors.push(`missing required key: ${key}`)
    }
  }
  if ('score_pct' in o && typeof o['score_pct'] !== 'number') {
    errors.push('score_pct must be a number')
  }
  const gate = o['critical_gate']
  if (
    gate !== undefined &&
    (typeof gate !== 'object' ||
      gate === null ||
      typeof (gate as Record<string, unknown>)['passed'] !== 'boolean')
  ) {
    errors.push('critical_gate.passed must be a boolean')
  }
  const cls = o['classification']
  if (cls !== undefined) {
    if (typeof cls !== 'object' || cls === null) {
      errors.push('classification must be an object')
    } else {
      const c = cls as Record<string, unknown>
      if (typeof c['invocation_mode'] !== 'string') {
        errors.push('classification.invocation_mode must be a string')
      }
      if (typeof c['load_frequency'] !== 'string') {
        errors.push('classification.load_frequency must be a string')
      }
    }
  }
  const criteria = o['criteria']
  if (!Array.isArray(criteria)) {
    errors.push('criteria must be an array')
  } else {
    criteria.forEach((c, i) => {
      if (typeof c !== 'object' || c === null) {
        errors.push(`criteria[${i}] is not an object`)
        return
      }
      const cc = c as Record<string, unknown>
      for (const k of ['id', 'verdict']) {
        if (typeof cc[k] !== 'string') {
          errors.push(`criteria[${i}].${k} must be a string`)
        }
      }
      for (const k of ['weight', 'score']) {
        if (typeof cc[k] !== 'number') {
          errors.push(`criteria[${i}].${k} must be a number`)
        }
      }
    })
  }
  return { valid: errors.length === 0, errors }
}

/** Read the criteria source files for a unit kind (skill vs prompt). */
export async function loadCriteria(unitKind: HygieneUnit['kind'], root: string): Promise<string> {
  const files =
    unitKind === 'skill'
      ? ['reference/SKILL-RUBRIC.md']
      : ['PROMPT-HYGIENE-CORE.md', 'profiles/system-prompts.md']
  const parts: string[] = []
  for (const f of files) {
    const text = await readFile(join(root, f), 'utf-8')
    parts.push(`===== ${f} =====\n${text}`)
  }
  return parts.join('\n\n')
}

export interface JudgePrompt {
  system: string
  user: string
}

/** Assemble the judge system + user prompt for one unit, embedding tier-1 results. */
export function buildJudgePrompt(
  unit: HygieneUnit,
  tier1: LintWarning[],
  criteriaText: string
): JudgePrompt {
  const system = [
    'You are a rigorous agent-hygiene assessor. Run the assessment instrument below EXACTLY as written',
    '(classification -> mechanical facts -> weighted criteria -> scorecard) over the single unit provided.',
    'Score every applicable criterion 1.0 / 0.5 / 0.0, and emit the §7 JSON scorecard and NOTHING else.',
    'Reply with ONLY the JSON object matching the schema — no prose, no markdown fences.',
    '',
    '===== ASSESSMENT INSTRUMENT =====',
    criteriaText,
  ].join('\n')

  const tier1Json = JSON.stringify(
    tier1.map((w) => ({ code: w.code, severity: w.severity, message: w.message, path: w.path })),
    null,
    2
  )

  const user = [
    `Assess this ${unit.kind}: ${unit.key}`,
    `Path: ${unit.path}`,
    `Load regime (tier-1 classification): ${unit.regime}`,
    '',
    'Tier-1 mechanical findings already computed deterministically — treat these as ground truth,',
    'do NOT re-derive them; use them to inform the mechanical section and relevant criteria:',
    '```json',
    tier1Json,
    '```',
    '',
    '===== UNIT CONTENT =====',
    unit.content,
    '',
    'Emit ONLY the §7 JSON scorecard for this unit.',
  ].join('\n')

  return { system, user }
}

/** A runner executes the assembled prompt and returns the parsed JSON scorecard. */
export type JudgeRunner = (prompt: JudgePrompt, unit: HygieneUnit) => Promise<unknown>

export interface JudgeOptions {
  agentHygieneRoot?: string | undefined
  runner: JudgeRunner
}

/** Run the tier-2 judge over one unit. Throws if the emitted scorecard fails validation. */
export async function judgeUnit(
  unit: HygieneUnit,
  tier1: LintWarning[],
  options: JudgeOptions
): Promise<Scorecard> {
  const root = options.agentHygieneRoot ?? DEFAULT_AGENT_HYGIENE_ROOT
  const criteria = await loadCriteria(unit.kind, root)
  const prompt = buildJudgePrompt(unit, tier1, criteria)
  const raw = await options.runner(prompt, unit)
  const { valid, errors } = validateScorecard(raw)
  if (!valid) {
    throw new Error(`judge scorecard failed schema validation:\n  - ${errors.join('\n  - ')}`)
  }
  return raw as Scorecard
}
