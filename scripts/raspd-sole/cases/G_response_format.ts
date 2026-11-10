/**
 * Cases T-13091 adds: a per-turn JSON response format HRC sends as
 * materialization.responseFormat (hrc-runtime compile.rs), compiled cold on
 * each native recipe. Bun carries it onto the start request's
 * initialInput.responseFormat when the initial input has content, never
 * synthesizes an input for a format alone (broker-invocation.ts
 * buildInitialInput), and the claude terminal routes have no initial input
 * at all. Malformed formats are whatever Bun does with them.
 */
import type { Ctx, ProbeCase } from '../ctx.ts'

const C = 'aspc.compileHarnessInvocation'

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
}
const FORMAT = { kind: 'json_schema', schema: SCHEMA }

/** Base compile case `from` with materialization.responseFormat = `format`. */
function withFormat(c: Ctx, from: string, format: unknown, edit: (m: any) => void = () => {}) {
  const p = c.base(from)
  p.compileRequest.materialization.responseFormat = format
  edit(p.compileRequest.materialization)
  return p
}

const formatCase = (
  id: string,
  from: string,
  condition: string,
  format: unknown = FORMAT,
  edit?: (m: any) => void
): ProbeCase => ({
  reason: 'materialization_shape',
  id: `response_format--${id}`,
  method: C,
  condition,
  params: (c) => withFormat(c, from, format, edit),
})

/** No initial input: no caller prompt and priming omitted. */
const noContent = (m: any) => {
  delete m.initialPrompt
  m.omitPriming = true
}

const cases: ProbeCase[] = [
  formatCase(
    'claude-hrcpty',
    'compile:claude-hrcpty:dev',
    'claude-hrcpty compile with a json_schema responseFormat and an initial prompt'
  ),
  formatCase(
    'claude-code',
    'compile:claude-code:dev',
    'claude-code (tmux) compile with a json_schema responseFormat and an initial prompt'
  ),
  formatCase(
    'codex-hrcpty',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty (presented) compile with a json_schema responseFormat and an initial prompt'
  ),
  formatCase(
    'codex-hrcpty-headless',
    'compile:codex-hrcpty-headless:dev',
    'codex-hrcpty headless selection with a json_schema responseFormat and an initial prompt'
  ),
  formatCase(
    'codex-app-server',
    'compile:codex-app-server',
    'headless codex (codex-app-server) with a json_schema responseFormat and an initial prompt'
  ),
  formatCase(
    'codex-tui',
    'compile:codex-tui:reuse',
    'codex-tui (codex-app-server, presented) with a json_schema responseFormat and an initial prompt'
  ),
  formatCase(
    'codex-hrcpty-no-content',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty with a json_schema responseFormat, no initial prompt and priming omitted',
    FORMAT,
    noContent
  ),
  formatCase(
    'codex-app-server-no-content',
    'compile:codex-app-server',
    'headless codex with a json_schema responseFormat, no initial prompt and priming omitted',
    FORMAT,
    noContent
  ),
  formatCase(
    'codex-hrcpty-text',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty with a text responseFormat',
    { kind: 'text' }
  ),
  formatCase(
    'malformed-not-object',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty whose responseFormat is a string',
    'json'
  ),
  formatCase(
    'malformed-no-schema',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty whose json_schema responseFormat has no schema',
    { kind: 'json_schema' }
  ),
  formatCase(
    'malformed-array-schema',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty whose json_schema responseFormat schema is an array',
    { kind: 'json_schema', schema: [] }
  ),
  formatCase(
    'malformed-kind',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty whose responseFormat kind is unsupported',
    { kind: 'xml', schema: SCHEMA }
  ),
  formatCase(
    'malformed-text-schema',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty whose text responseFormat carries a schema',
    { kind: 'text', schema: SCHEMA }
  ),
  formatCase(
    'malformed-null',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty whose responseFormat is null',
    null
  ),
  formatCase(
    'malformed-no-content',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty with a malformed responseFormat and no initial input',
    { kind: 'json_schema' },
    noContent
  ),
  formatCase(
    'malformed-claude-hrcpty',
    'compile:claude-hrcpty:dev',
    'claude-hrcpty whose json_schema responseFormat has no schema',
    { kind: 'json_schema' }
  ),
]

/**
 * The T-13091 audit: placement keys the TypeScript compiler reads that
 * T-13048 stopped relaying. placement.lockedEnv folds into the plan's
 * lockedEnv (compose-agent-env.ts); scaffoldPackets reach the system prompt
 * through the placement spread (preparation-execution-context.ts promptInput);
 * placement.env is carried onto the broker request and read by nothing.
 */
const placementCase = (
  id: string,
  from: string,
  condition: string,
  edit: (pl: any) => void
): ProbeCase => ({
  reason: 'placement_shape',
  id: `dropped_key--${id}`,
  method: C,
  condition,
  params: (c) => {
    const p = c.base(from)
    edit(p.compileRequest.placement)
    return p
  },
})

cases.push(
  placementCase(
    'placement-lockedEnv',
    'compile:claude-hrcpty:dev',
    'claude-hrcpty compile whose placement carries lockedEnv',
    (pl) => (pl.lockedEnv = { PROBE_LOCKED: 'locked-value', ASP_HOME: '/nowhere' })
  ),
  placementCase(
    'placement-lockedEnv-codex',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty compile whose placement carries lockedEnv',
    (pl) => (pl.lockedEnv = { PROBE_LOCKED: 'locked-value' })
  ),
  placementCase(
    'placement-env',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty compile whose placement carries env',
    (pl) => (pl.env = { PROBE_ENV: 'env-value' })
  ),
  placementCase(
    'placement-scaffoldPackets',
    'compile:claude-hrcpty:dev',
    'claude-hrcpty compile whose placement carries an inline scaffold packet',
    (pl) => (pl.scaffoldPackets = [{ slot: 'scaffold', content: 'Scaffold inline probe' }])
  ),
  placementCase(
    'placement-scaffoldPackets-ref',
    'compile:claude-hrcpty:dev',
    'claude-hrcpty compile whose placement carries a scaffold packet by agent-root ref',
    (pl) => (pl.scaffoldPackets = [{ slot: 'scaffold', ref: 'agent-root:///SOUL.md' }])
  ),
  placementCase(
    'placement-scaffoldPackets-codex',
    'compile:codex-hrcpty:dev',
    'codex-hrcpty compile whose placement carries an inline scaffold packet',
    (pl) => (pl.scaffoldPackets = [{ slot: 'scaffold', content: 'Scaffold inline probe' }])
  ),
  placementCase(
    'placement-lockedEnv-path',
    'compile:claude-hrcpty:dev',
    'claude-hrcpty compile whose placement lockedEnv carries PATH',
    (pl) => (pl.lockedEnv = { PATH: '/probe/bin' })
  ),
  placementCase(
    'placement-agentsRoot',
    'compile:claude-hrcpty:dev',
    'claude-hrcpty compile whose placement carries agentsRoot (system-prompt input spread)',
    (pl) => (pl.agentsRoot = '/private/tmp/raspd-sole-native/no-such-agents-root')
  ),
  placementCase(
    'placement-lane',
    'compile:claude-hrcpty:dev',
    'claude-hrcpty compile whose placement carries lane (system-prompt input spread)',
    (pl) => (pl.lane = 'probe-lane')
  ),
  placementCase(
    'placement-taskContext',
    'compile:claude-hrcpty:dev',
    'claude-hrcpty compile whose placement carries taskContext (system-prompt input spread)',
    (pl) =>
      (pl.taskContext = {
        taskId: 'T-11825',
        phase: 'probe-phase',
        role: 'implementer',
        requiredEvidenceKinds: [],
        hintsText: 'probe hints',
      })
  )
)
export default cases
