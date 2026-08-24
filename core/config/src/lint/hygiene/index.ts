/**
 * Two-tier agent-hygiene linter.
 *
 * Tier 1: deterministic W4xx rules over hygiene units (skills + agent-root prompt
 * files), each classified by load regime. Advisory by default; `--strict` fails on
 * `error`-severity findings; baseline suppression grandfathers existing findings.
 *
 * Tier 2: `--judge` runs the agent-hygiene rubric as a headless agent turn over one
 * unit and emits the §7 JSON scorecard, embedding tier-1 results.
 *
 * See ./RULES.md for the W4xx ledger.
 */

export type {
  HygieneRegime,
  HygieneUnitKind,
  HygieneUnit,
  SkillFrontmatter,
  AgentRootInfo,
  HygieneContext,
  HygieneRule,
  HygieneCode,
} from './types.js'
export { HYGIENE_CODES } from './types.js'

export {
  parseSkillFrontmatter,
  stripFrontmatter,
  wordCount,
  lineCount,
  promptRegime,
} from './parse.js'

export { scanHygieneTarget } from './scan.js'

export {
  allHygieneRules,
  checkNameMatchesDir,
  checkLengthBudget,
  checkTripwires,
  checkReferenceGraph,
  checkDeadLayer,
  DEFAULT_LENGTH_BUDGET,
  type LengthBudget,
} from './rules/index.js'

export {
  lintHygiene,
  runHygieneTarget,
  hasStrictFailure,
  type HygieneRunOptions,
  type HygieneRunResult,
} from './run.js'

export {
  fingerprint,
  loadBaseline,
  applyBaseline,
  writeBaseline,
  type HygieneBaseline,
  type BaselineEntry,
} from './baseline.js'

export {
  RUBRIC_SCORECARD_SCHEMA,
  DEFAULT_AGENT_HYGIENE_ROOT,
  validateScorecard,
  loadCriteria,
  buildJudgePrompt,
  judgeUnit,
  type Scorecard,
  type JudgePrompt,
  type JudgeRunner,
  type JudgeOptions,
} from './judge.js'
