/**
 * The aspd compare case set (T-11833): the seeded scratch stage and every
 * request the runner drives against each subject.
 *
 * Request shapes mirror what Rust HRC sends (hrc-runtime
 * crates/hrc-native/src/server/{aspc,compile,runtime_views,broker}.rs): hello
 * before every call, both resolveRuntimeDeclaration context shapes,
 * observeContinuationArtifact with and without
 * historicalExecution.recordedPlacement, and `{ compileRequest }` compiles with
 * `hrcPolicy: {}`, a dispatchEnv and optional selectionContext.summonDirectives.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  type Asp,
  type Fixture,
  ROWS,
  type Row,
  compileRequest,
  createFixture,
  writeAgent,
} from '../path-markers-e2e.ts'

export const HELLO_PARAMS = {
  clientInfo: { name: 'hrc-server' },
  protocolVersions: ['aspc/0.1'],
}

/** One JSON-RPC request after hello on its own connection (the rusthrc pattern). */
export type CallCase = {
  kind: 'call'
  id: string
  method: string
  params: unknown
  /** The compile request, so the runner can re-derive the plan's hashes. */
  compileRequest?: unknown
}

/** Literal frames on one connection, every reply line captured. */
export type RawCase = { kind: 'raw'; id: string; frames: string[] }

export type CompareCase = CallCase | RawCase

export type Stage = Fixture & {
  brokenProjectRoot: string
  claudeHome: string
  codexHomeDev: string
}

const CODEX_FOUND = 'cmp-codex-thread-present'
const CLAUDE_FOUND = 'cmp-claude-session-present'

/** Seed the stage at its fixed absolute path (the runner snapshots it as the seed). */
export function seedStage(asp: Asp, base: string): Stage {
  const fixture = createFixture(asp, base)
  // agent_profile_invalid: a profile that is not TOML.
  writeAgent(fixture.agentsRoot, 'pm-broken', [])
  writeFileSync(join(fixture.agentsRoot, 'pm-broken', 'agent-profile.toml'), 'version = [\n')
  // project_targets_invalid: a project whose asp-targets.toml is not TOML.
  const brokenProjectRoot = join(base, 'project-broken')
  mkdirSync(brokenProjectRoot, { recursive: true })
  writeFileSync(join(brokenProjectRoot, 'asp-targets.toml'), 'schema = [\n')
  // A codex rollout under the recorded-placement codex home of pathmark-dev.
  const codexHomeDev = join(fixture.aspHome, 'codex-homes', 'project_pathmark-dev')
  const sessions = join(codexHomeDev, 'sessions', '2026', '10', '26')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, `rollout-2026-10-26T00-00-00-${CODEX_FOUND}.jsonl`), '{}\n')
  // A claude session under a frozen CLAUDE_CONFIG_DIR, keyed by the project cwd.
  const claudeHome = join(base, 'claude-home')
  const encodedCwd = fixture.projectRoot.replace(/[^a-zA-Z0-9]/g, '-')
  mkdirSync(join(claudeHome, 'projects', encodedCwd), { recursive: true })
  writeFileSync(join(claudeHome, 'projects', encodedCwd, `${CLAUDE_FOUND}.jsonl`), '{}\n')
  return { ...fixture, brokenProjectRoot, claudeHome, codexHomeDev }
}

const call = (id: string, method: string, params: unknown): CallCase => ({
  kind: 'call',
  id,
  method,
  params,
})

const frame = (id: number, method: string, params: unknown, extra: object = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params, ...extra })

/** Frame-level cases through the codec (T-11728 rules, and T-11835's list). */
function rawCases(): RawCase[] {
  const hello = frame(1, 'aspc.hello', HELLO_PARAMS)
  return [
    { kind: 'raw', id: 'raw:not-json', frames: ['{not-json'] },
    { kind: 'raw', id: 'raw:empty-line', frames: ['', hello] },
    { kind: 'raw', id: 'raw:cr-only', frames: ['\r', hello] },
    { kind: 'raw', id: 'raw:non-object', frames: ['[1,2,3]'] },
    {
      kind: 'raw',
      id: 'raw:wrong-jsonrpc',
      frames: [JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'health', params: {} })],
    },
    { kind: 'raw', id: 'raw:unknown-method', frames: [frame(1, 'aspc.retiredOperation', {})] },
    { kind: 'raw', id: 'raw:hello-bad-params', frames: [frame(1, 'aspc.hello', { bogus: true })] },
    { kind: 'raw', id: 'raw:health-bad-params', frames: [frame(1, 'health', { typo: true })] },
    {
      kind: 'raw',
      id: 'raw:oversized-then-valid',
      frames: [
        frame(1, 'health', { pad: 'x'.repeat(16 * 1024 * 1024 + 1) }),
        frame(2, 'aspc.hello', HELLO_PARAMS),
      ],
    },
    {
      kind: 'raw',
      id: 'raw:pipelined',
      frames: [hello, frame(2, 'health', {}), frame(3, 'surface', {})],
    },
  ]
}

const RESOLVE = 'aspc-resolve-runtime-declaration-request/v1'
const OBSERVE = 'aspc-observe-continuation-artifact-request/v1'

function resolveCases(stage: Stage): CallCase[] {
  const agentRoot = join(stage.agentsRoot, 'pathmark')
  const resolve = (id: string, context: Record<string, unknown>) =>
    call(id, 'aspc.resolveRuntimeDeclaration', { schemaVersion: RESOLVE, context })
  // Intent shape (aspc.rs runtime-intent declaration): agentRoot always given.
  const intent = (overrides: Record<string, unknown> = {}) => ({
    agentId: 'pathmark',
    agentRoot,
    cwd: stage.projectRoot,
    runMode: 'task',
    project: { mode: 'none' },
    ...overrides,
  })
  // Placement shape (aspc.rs scope placement): infer-from-cwd unless a root is known.
  const placement = (overrides: Record<string, unknown> = {}) => ({
    agentId: 'pathmark',
    cwd: stage.projectRoot,
    runMode: 'task',
    project: { mode: 'infer-from-cwd' },
    ...overrides,
  })
  const root = { mode: 'root', projectRoot: stage.projectRoot, projectId: 'project' }
  return [
    resolve('resolve:intent:projectless', intent()),
    resolve('resolve:intent:project-root', intent({ project: root })),
    resolve(
      'resolve:intent:agent-sources',
      intent({ agentSources: { agentsRoot: stage.agentsRoot, aspHome: stage.aspHome } })
    ),
    resolve(
      'resolve:intent:provision-directives',
      intent({ project: root, provisionDirectives: { harness: 'codex' } })
    ),
    resolve(
      'resolve:intent:agent_profile_invalid',
      intent({ agentId: 'pm-broken', agentRoot: join(stage.agentsRoot, 'pm-broken') })
    ),
    resolve(
      'resolve:intent:project_targets_invalid',
      intent({
        project: { mode: 'root', projectRoot: stage.brokenProjectRoot, projectId: 'broken' },
        cwd: stage.brokenProjectRoot,
      })
    ),
    resolve('resolve:placement:infer-from-cwd', placement()),
    resolve('resolve:placement:project-root-task', placement({ project: root, taskId: 'T-11833' })),
    resolve('resolve:placement:agent-root', placement({ project: root, agentRoot })),
    resolve('resolve:placement:agent_not_found', placement({ agentId: 'pm-nobody' })),
    resolve('resolve:placement:agent_profile_invalid', placement({ agentId: 'pm-broken' })),
  ]
}

function observeCases(stage: Stage): CallCase[] {
  const observe = (id: string, params: Record<string, unknown>) =>
    call(id, 'aspc.observeContinuationArtifact', { schemaVersion: OBSERVE, ...params })
  // runtime_views.rs: recordedPlacement is the session's last applied placement.
  const recorded = (agent: string) => {
    const placement = {
      agentRoot: join(stage.agentsRoot, agent),
      projectRoot: stage.projectRoot,
      cwd: stage.projectRoot,
      runMode: 'task',
      bundle: { kind: 'agent-project', agentName: agent, projectRoot: stage.projectRoot },
    }
    return { historicalExecution: { recordedPlacement: { placement, bundle: placement.bundle } } }
  }
  const codex = (key: string) => ({ continuation: { provider: 'openai', key } })
  const codexCli = (key: string) => ({ continuation: { provider: 'codex', key } })
  const claude = (key: string) => ({ continuation: { provider: 'anthropic', key } })
  // Bun HRC also sends frozen start evidence; claude needs it to find a home.
  const frozenClaude = (key: string) => ({
    ...claude(key),
    historicalExecution: {
      frozenStartRequest: {
        keyBinding: 'runtime-continuation',
        placement: { cwd: stage.projectRoot },
        startRequest: {
          spec: {
            driver: { kind: 'claude-code-tmux' },
            process: { lockedEnv: { CLAUDE_CONFIG_DIR: stage.claudeHome } },
          },
        },
      },
    },
  })
  return [
    observe('observe:codex:present:recorded', {
      ...codexCli(CODEX_FOUND),
      ...recorded('pathmark-dev'),
    }),
    observe('observe:codex:missing:recorded', {
      ...codexCli('cmp-codex-absent'),
      ...recorded('pathmark-dev'),
    }),
    observe('observe:codex:present:no-recorded', codexCli(CODEX_FOUND)),
    observe('observe:codex:missing:no-recorded', codexCli('cmp-codex-absent')),
    observe('observe:openai:present:recorded', {
      ...codex(CODEX_FOUND),
      ...recorded('pathmark-dev'),
    }),
    observe('observe:claude:present:recorded', {
      ...claude(CLAUDE_FOUND),
      ...recorded('pathmark'),
    }),
    observe('observe:claude:missing:recorded', {
      ...claude('cmp-claude-absent'),
      ...recorded('pathmark'),
    }),
    observe('observe:claude:present:no-recorded', claude(CLAUDE_FOUND)),
    observe('observe:claude:present:frozen-home', frozenClaude(CLAUDE_FOUND)),
    observe('observe:claude:missing:frozen-home', frozenClaude('cmp-claude-absent')),
  ]
}

/**
 * compile.rs `request()`: identity/correlation from the allocated ids, the
 * intent placement plus correlation and dispatchEnv, `hrcPolicy: {}`, and
 * summonDirectives only when non-empty. rusthrc sends no continuation; the
 * resume row adds Bun HRC's `continuation` so that recipe is compared too.
 */
function rusthrcCompileRequest(
  asp: Asp,
  stage: Stage,
  row: Row,
  summonDirectives?: Record<string, string>
): Record<string, unknown> {
  const base = compileRequest(asp, stage, row) as unknown as Record<string, unknown>
  const { idempotencyKey: _key, ...identity } = base['identity'] as Record<string, unknown>
  const placement = base['placement'] as Record<string, unknown>
  const scopeRef = (base['correlation'] as Record<string, unknown>)['scopeRef'] as string
  const sessionRef = `${scopeRef}/lane:main`
  const correlationKeys = ['hostSessionId', 'generation', 'runtimeId', 'invocationId'] as const
  const pick = (keys: readonly string[]) =>
    Object.fromEntries(keys.filter((key) => key in identity).map((key) => [key, identity[key]]))
  const request: Record<string, unknown> = {
    schemaVersion: 'agent-runtime-compile-request/v2',
    agent: base['agent'],
    identity,
    placement: {
      agentRoot: placement['agentRoot'],
      cwd: placement['cwd'],
      runMode: placement['runMode'],
      bundle: placement['bundle'],
      dryRun: false,
      projectRoot: placement['projectRoot'],
      correlation: {
        sessionRef: { scopeRef, laneRef: 'main' },
        ...pick([...correlationKeys, 'initialInputId', 'runId']),
      },
      dispatchEnv: {
        AGENT_SCOPE_REF: scopeRef,
        AGENT_LANE_REF: 'main',
        AGENT_SESSION_REF: sessionRef,
        HRC_SESSION_REF: sessionRef,
        AGENT_ID: (base['agent'] as { id: string }).id,
        AGENT_HOST_SESSION_ID: identity['hostSessionId'],
        AGENT_GENERATION: String(identity['generation']),
        AGENT_TASK: 'T-11825',
      },
    },
    requested: base['requested'],
    materialization: {
      initialPrompt: (base['materialization'] as Record<string, unknown>)['initialPrompt'],
      taskContext: (base['materialization'] as Record<string, unknown>)['taskContext'],
    },
    hrcPolicy: {},
    correlation: {
      scopeRef,
      ...pick(['requestId', 'operationId', ...correlationKeys, 'traceId', 'runId']),
      inputId: identity['initialInputId'],
    },
  }
  if (base['continuation'] !== undefined) request['continuation'] = base['continuation']
  if (summonDirectives !== undefined) request['selectionContext'] = { summonDirectives }
  return request
}

function compileCases(asp: Asp, stage: Stage): CallCase[] {
  const compile = (id: string, row: Row, summon?: Record<string, string>): CallCase => {
    const request = rusthrcCompileRequest(asp, stage, row, summon)
    return {
      ...call(id, 'aspc.compileHarnessInvocation', { compileRequest: request }),
      compileRequest: request,
    }
  }
  const byId = (id: string) => ROWS.find((row) => row.id === id) as Row
  return [
    ...ROWS.map((row) => compile(`compile:${row.id}`, row)),
    compile('compile:claude-code:summon-model', byId('claude-code'), { model: 'sonnet' }),
    compile('compile:codex-tui:summon-effort', byId('codex-tui'), { reasoning_effort: 'high' }),
  ]
}

export function buildCases(asp: Asp, stage: Stage): CompareCase[] {
  return [
    call('meta:hello', 'aspc.hello', HELLO_PARAMS),
    call('meta:health', 'health', {}),
    call('meta:version', 'version', {}),
    call('meta:surface', 'surface', {}),
    ...rawCases(),
    ...resolveCases(stage),
    ...observeCases(stage),
    ...compileCases(asp, stage),
  ]
}
