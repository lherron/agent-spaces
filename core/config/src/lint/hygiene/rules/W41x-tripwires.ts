/**
 * W410-W417: grep tripwires (rubric §2 M6/M7). Each hit is a CANDIDATE, not a
 * verdict — all emit `info`. They surface lines a human/judge should read against
 * the mapped criterion; they never fail --strict on their own.
 *
 * Scanned over the primary file only (line-accurate evidence). Supporting-file
 * coverage is deferred to the tier-2 judge. See RULES.md.
 */

import type { LintWarning, WarningSeverity } from '../../types.js'
import type { HygieneContext, HygieneUnit } from '../types.js'
import { HYGIENE_CODES } from '../types.js'
import { scanLines } from './text-scan.js'

interface Tripwire {
  code: string
  pattern: RegExp
  /** Which unit kinds this tripwire applies to. */
  kinds: ReadonlyArray<HygieneUnit['kind']>
  message: (hit: string) => string
}

const TRIPWIRES: Tripwire[] = [
  {
    // BP-01 — optionality on a process step.
    code: HYGIENE_CODES.OPTIONAL_STEP,
    pattern: /\b(optional|if needed|where possible|you may skip)\b/i,
    kinds: ['skill'],
    message: (h) =>
      `Optionality token on a step (BP-01): "${h}". If load-bearing, replace with a predicate for WHEN it applies.`,
  },
  {
    // BP-02/03 — fuzzy / belief gate.
    code: HYGIENE_CODES.FUZZY_GATE,
    pattern:
      /\b(regularly|thoroughly|sensible|shared understanding|as needed|when appropriate|feels? right)\b/i,
    kinds: ['skill', 'prompt'],
    message: (h) =>
      `Fuzzy gate language (BP-02/03): "${h}". Confirm the gate ends on an observable predicate, not judgement.`,
  },
  {
    // BP-25 — appended nuance/exception clause.
    code: HYGIENE_CODES.NUANCE_CLAUSE,
    pattern: /\b(unless|except|does ?n[o']t apply to|does not apply to)\b/i,
    kinds: ['skill', 'prompt'],
    message: (h) =>
      `Appended nuance/exception clause (BP-25): "${h}". Express real exceptions as their own predicate-keyed conditional.`,
  },
  {
    // BP-31 — dated content / session narrative / hard-coded URL.
    code: HYGIENE_CODES.DATED_CONTENT,
    pattern: /(20\d{2}-\d{2}-\d{2}|https?:\/\/|from .*session)/i,
    kinds: ['skill', 'prompt'],
    message: (h) =>
      `Dated content / session narrative / URL (BP-31): "${h}". Rewrite generically; time-sensitive content rots in a runtime file.`,
  },
  {
    // BP-39 — @-include of a markdown file (loads immediately).
    code: HYGIENE_CODES.AT_INCLUDE,
    pattern: /@[A-Za-z0-9_./-]+\.md\b/,
    kinds: ['skill', 'prompt'],
    message: (h) =>
      `@-include of a markdown file (BP-39): "${h}". Cross-ref by name with a REQUIRED marker instead — an @-include can burn 200k+ context.`,
  },
  {
    // MR3/BP-69 — hard model name as live guidance.
    code: HYGIENE_CODES.MODEL_NAME_WELD,
    pattern: /\b(opus|sonnet|haiku|gpt-[0-9]|claude-[0-9])\b/i,
    kinds: ['skill', 'prompt'],
    message: (h) =>
      `Model name as live guidance (MR3/BP-69): "${h}". Key capability conditionals to behavior, not model names; use effort as the cost lever.`,
  },
  {
    // MR5/BP-71 — reasoning-transcript instruction.
    code: HYGIENE_CODES.REASONING_ECHO,
    pattern:
      /\b(out loud|show your (thinking|work|reasoning)|write down your (thinking|reasoning)|transcribe your)\b/i,
    kinds: ['skill', 'prompt'],
    message: (h) =>
      `Reasoning-transcript instruction (MR5/BP-71): "${h}". Rewrite as a decision + one-line grounds, not "show your reasoning".`,
  },
  {
    // MR2/SP4/BP-68 — human-in-the-loop remedy.
    code: HYGIENE_CODES.HUMAN_IN_LOOP,
    pattern:
      /\b(ask (lance|the user|them)|discuss with[^.]*(partner|user)|check in with|your human partner|confirm (with|before))\b/i,
    kinds: ['skill', 'prompt'],
    message: (h) =>
      `Human-in-the-loop remedy (MR2/SP4/BP-68): "${h}". Praesidium agents run unattended — carry the predicate for WHEN to ask and an autonomous branch.`,
  },
]

export function checkTripwires(ctx: HygieneContext): LintWarning[] {
  const warnings: LintWarning[] = []
  for (const unit of ctx.units) {
    for (const tw of TRIPWIRES) {
      if (!tw.kinds.includes(unit.kind)) {
        continue
      }
      for (const hit of scanLines(unit.content, tw.pattern)) {
        const severity: WarningSeverity = 'info'
        warnings.push({
          code: tw.code,
          message: tw.message(hit.text.length > 120 ? `${hit.text.slice(0, 117)}...` : hit.text),
          severity,
          path: `${unit.path}:${hit.line}`,
          details: { unit: unit.key, line: hit.line },
        })
      }
    }
  }
  return warnings
}
