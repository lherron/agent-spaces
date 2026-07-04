/**
 * Types for the two-tier agent-hygiene linter (tier 1 = deterministic W4xx rules).
 *
 * WHY: The existing space-lint layer (LintContext/SpaceLintData) is oriented around
 * materialized *spaces* (a pluginPath). The hygiene linter is oriented around
 * *units* — a skill or an agent-root prompt file — each carrying a load regime
 * (resident/boot/on-demand) that scales every criterion's severity. This is a
 * distinct context type so the two layers do not fight over shape.
 *
 * Criteria are ported from ~/praesidium/archagent/agent-hygiene (PROMPT-HYGIENE-CORE,
 * profiles/, CROSS-LAYER XL0, reference/SKILL-RUBRIC [MECHANICAL] checks). See
 * ./RULES.md for the W4xx ledger (code -> criterion -> severity -> rationale).
 */

import type { LintWarning } from '../types.js'

/** How often the unit's body is in context. Scales every criterion's severity. */
export type HygieneRegime = 'resident' | 'boot' | 'on-demand'

/** A hygiene unit is either a skill (SKILL.md + supporting files) or a prompt file. */
export type HygieneUnitKind = 'skill' | 'prompt'

/** Parsed skill frontmatter (only the fields the mechanical checks consume). */
export interface SkillFrontmatter {
  name?: string | undefined
  description?: string | undefined
  disableModelInvocation?: boolean | undefined
  argumentHint?: string | undefined
}

/** One lintable unit. */
export interface HygieneUnit {
  kind: HygieneUnitKind
  /** Stable, human-readable key, e.g. "clod/skill:latent-harness" or "clod/prompt:SOUL.md". */
  key: string
  /** Absolute path to the primary file (SKILL.md for a skill, the .md for a prompt). */
  path: string
  /** Absolute path to the directory that owns the unit (skill dir; agent root for a prompt). */
  dir: string
  /** Load regime of the unit body. */
  regime: HygieneRegime
  /** Raw content of the primary file. */
  content: string
  /** Owning agent id when resolvable (undefined for shared/top-level prompt files). */
  agentId?: string | undefined
  /** Skills only: parsed frontmatter. */
  frontmatter?: SkillFrontmatter | undefined
}

/** Per-agent-root facts needed by the dead-layer (XL0) rule. */
export interface AgentRootInfo {
  agentId: string
  /** Absolute path to the agent root directory. */
  root: string
  /**
   * Basenames of files any live load path references (context-template.toml
   * [[prompt]]/[[reminder]] `path=` values, agent-profile.toml additionalBase,
   * plus the always-live shared/identity set). Used to classify agent-root
   * instruction files as live or dead.
   */
  referencedFiles: Set<string>
}

/** Context handed to every hygiene rule. */
export interface HygieneContext {
  units: HygieneUnit[]
  agentRoots: AgentRootInfo[]
}

/** A hygiene rule: pure over the context, returns warnings. */
export type HygieneRule = (ctx: HygieneContext) => LintWarning[] | Promise<LintWarning[]>

/**
 * W4xx hygiene warning codes. Reserved range W400-W499 (see lint/types.ts WARNING_CODES
 * for the W1xx-W3xx allocations already in use).
 */
export const HYGIENE_CODES = {
  /** U1/BP-64 — skill name must equal its dir basename and be kebab-case. */
  NAME_DIRNAME: 'W400',
  /** U11/BP-17 — model-invoked description over the ~500-char resident ceiling. */
  DESCRIPTION_BUDGET: 'W401',
  /** U11/BP-17/CF-3 — resident body over word budget, or any body over the 500-line backstop. */
  BODY_BUDGET: 'W402',
  /** BP-01 — optionality token on a process step (candidate). */
  OPTIONAL_STEP: 'W410',
  /** BP-02/03 — fuzzy/belief gate language (candidate). */
  FUZZY_GATE: 'W411',
  /** BP-25 — appended nuance/exception clause (candidate). */
  NUANCE_CLAUSE: 'W412',
  /** BP-31 — dated content / session narrative / hard-coded URL (candidate). */
  DATED_CONTENT: 'W413',
  /** BP-39 — @-include of a markdown file (loads immediately; can burn context). */
  AT_INCLUDE: 'W414',
  /** MR3/BP-69 — hard model name as live guidance (candidate). */
  MODEL_NAME_WELD: 'W415',
  /** MR5/BP-71 — reasoning-transcript instruction (candidate). */
  REASONING_ECHO: 'W416',
  /** MR2/SP4/BP-68 — human-in-the-loop remedy with no autonomous branch (candidate). */
  HUMAN_IN_LOOP: 'W417',
  /** U21/BP-58 — bundled file no pointer reaches, or dev/test/log artifact in the runtime dir. */
  ORPHANED_FILE: 'W420',
  /** U13/BP-11 — markdown link to a file that does not exist. */
  BROKEN_POINTER: 'W421',
  /** U14/BP-12 — reference file >100 lines with no top-of-file Contents list. */
  REFERENCE_NESTING: 'W422',
  /** XL0 — agent-root instruction file in no load path (dead layer). */
  DEAD_LAYER: 'W430',
} as const

export type HygieneCode = (typeof HYGIENE_CODES)[keyof typeof HYGIENE_CODES]
