/**
 * The aspd compare case set (T-11833): the seeded scratch stage and every
 * request the runner drives against each subject.
 *
 * Request shapes mirror what Rust HRC sends (hrc-runtime
 * crates/hrc-native/src/server/{aspc,compile,runtime_views,broker}.rs): hello
 * before every call, both resolveRuntimeDeclaration context shapes,
 * observeContinuationArtifact with and without
 * historicalExecution.recordedPlacement, observeRuntimeCapability and
 * inspectRuntimePlacement as the summon gate and turn preview send them, and
 * `{ compileRequest }` compiles with
 * `hrcPolicy: {}`, a dispatchEnv and optional selectionContext.summonDirectives.
 */
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  type Asp,
  type Fixture,
  ROWS,
  type Row,
  compileRequest,
  createFixture,
  writeAgent,
  writeSpace,
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
const PRUNE_AGENT = 'pathmark-prune'
const CLAUDE_FOUND = 'cmp-claude-session-present'
const PROJECT_SPACE_AGENT = 'pathmark-project-space'
const PARTICIPANT_AGENT = 'pathmark-participant'
/** The codex agent whose space and template exercise every codex compose branch (T-11932). */
const CODEX_AGENT = 'pathmark-codex'
/** A file only the project root holds; the codex template gates a reminder on it. */
const PROJECT_GATE = 'pm-project-gate'

/**
 * A mutable space with everything the Codex adapter materializes: skills,
 * commands (prompts), MCP, AGENTS.md instructions, `[codex.config]` overrides
 * and a codex-targeted pre_tool_use hook; and an agent composing it whose
 * context template has a reminder, an exec reminder and a task-scoped section.
 */
function seedCodexAgent(agentsRoot: string): void {
  const space = join(agentsRoot, 'spaces', 'pm-codex')
  mkdirSync(join(space, 'skills', 'pm-codex-skill'), { recursive: true })
  mkdirSync(join(space, 'commands'), { recursive: true })
  mkdirSync(join(space, 'mcp'), { recursive: true })
  mkdirSync(join(space, 'hooks'), { recursive: true })
  writeFileSync(
    join(space, 'space.toml'),
    'schema = 1\nid = "pm-codex"\nversion = "1.2.0"\n\n[plugin]\nname = "pm-codex"\n\n[codex.config]\nmodel_verbosity = "low"\nproject_doc_max_bytes = 65536\n'
  )
  writeFileSync(
    join(space, 'skills', 'pm-codex-skill', 'SKILL.md'),
    '---\nname: pm-codex-skill\ndescription: codex fixture skill.\n---\n\nLoaded.\n'
  )
  writeFileSync(join(space, 'commands', 'pm-hello.md'), 'Say hello.\n')
  writeFileSync(join(space, 'commands', 'notes.txt'), 'not a prompt\n')
  writeFileSync(
    join(space, 'mcp', 'mcp.json'),
    `${JSON.stringify({ mcpServers: { 'pm-echo': { type: 'stdio', command: 'echo', args: ['pm'], env: { PM: '1' } } } }, null, 2)}\n`
  )
  writeFileSync(join(space, 'AGENTS.md'), '# pm-codex\n\nCodex fixture instructions.\n\n')
  writeFileSync(
    join(space, 'hooks', 'hooks.toml'),
    '[[hook]]\nevent = "pre_tool_use"\nscript = "guard.sh"\nharness = "codex"\ntools = ["Bash", "Edit"]\n\n[[hook]]\nevent = "pre_tool_use"\nscript = "claude-guard.sh"\nharness = "claude"\n'
  )
  writeFileSync(join(space, 'hooks', 'guard.sh'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(space, 'hooks', 'guard.sh'), 0o755)
  writeAgent(agentsRoot, CODEX_AGENT, ['space:pm-dev@dev', 'space:pm-codex@dev'])
  const agentRoot = join(agentsRoot, CODEX_AGENT)
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `version = 4\npriming = "pathmark priming for {{agentId}}"\n\n[provisioning]\nreasoning_effort = "medium"\nsandbox = "workspace-write"\n\n[spaces]\nbase = ${JSON.stringify(['space:pm-dev@dev', 'space:pm-codex@dev'])}\n\n[instructions]\ntemplate = "context-template.toml"\n`
  )
  writeFileSync(
    join(agentRoot, 'context-template.toml'),
    [
      'schema_version = 2',
      'mode = "append"',
      '',
      '[[prompt]]',
      'name = "soul"',
      'type = "file"',
      'path = "agent-root:///SOUL.md"',
      'required = true',
      '',
      '[[prompt]]',
      'name = "task"',
      'type = "inline"',
      'when = { taskField = "id" }',
      'content = "Task {{task.id}}"',
      '',
      '[[reminder]]',
      'name = "scope"',
      'type = "inline"',
      'content = "Reminder for {{agentId}}"',
      '',
      // T-12023: exec runs in the project root (else agentRoot) on both sides.
      '[[reminder]]',
      'name = "exec-cwd"',
      'type = "exec"',
      `command = "printf 'cwd=%s' \\"$(pwd -P)\\""`,
      '',
      // T-12027: when.exists checks the placement folder, not the daemon's cwd.
      '[[reminder]]',
      'name = "project-gated"',
      'type = "inline"',
      `when = { exists = "${PROJECT_GATE}" }`,
      'content = "project-gated reminder"',
      '',
    ].join('\n')
  )
}

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
  seedCodexAgent(fixture.agentsRoot)
  writeFileSync(join(fixture.projectRoot, PROJECT_GATE), '')
  // T-11951: an agent composing a project space, which the inspection
  // compile resolves from its placement.projectRoot (it carried none before
  // the fix), the project space itself, and a participant-only agent.
  writeSpace(fixture.projectRoot, 'pm-project')
  writeAgent(fixture.agentsRoot, PROJECT_SPACE_AGENT, [])
  writeFileSync(
    join(fixture.agentsRoot, PROJECT_SPACE_AGENT, 'agent-profile.toml'),
    'version = 4\n\n[spaces]\nbase = ["space:project:pm-project"]\n'
  )
  writeAgent(fixture.agentsRoot, PARTICIPANT_AGENT, ['space:pm-dev@dev'])
  writeFileSync(
    join(fixture.agentsRoot, PARTICIPANT_AGENT, 'agent-profile.toml'),
    'version = 4\n\n[placement]\nlaunch = "participant-only"\n\n[spaces]\nbase = ["space:pm-dev@dev"]\n'
  )
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
  // Bundle-version pruning (T-11841): an agent only compile:claude-code:prune
  // compiles, whose bundle scope holds five day-old versions; the last one is
  // referenced from ASP_HOME/tmp, so it survives past the three kept recent.
  writeAgent(fixture.agentsRoot, PRUNE_AGENT, ['space:pm-dev@dev'])
  const versions = join(
    fixture.aspHome,
    'codex-homes',
    `project_${PRUNE_AGENT}`,
    'bundles',
    '.versions'
  )
  const dayOld = new Date('2026-10-25T00:00:00.000Z')
  for (const digit of ['1', '2', '3', '4', '5']) {
    const version = join(versions, digit.repeat(64))
    mkdirSync(version, { recursive: true })
    writeFileSync(join(version, 'marker'), digit)
    utimesSync(version, dayOld, dayOld)
  }
  mkdirSync(join(fixture.aspHome, 'tmp'), { recursive: true })
  writeFileSync(
    join(fixture.aspHome, 'tmp', 'prune-reference.txt'),
    `${join(versions, '1'.repeat(64))}/x\n`
  )
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
const INSPECT = 'aspc-inspect-runtime-placement-request/v1'
const CAPABILITY = 'aspc-observe-runtime-capability-request/v1'

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
 * aspc.inspectRuntimePlacement (T-11951) in the shape both HRCs' turn preview
 * sends (declaration-handlers.ts previewInspectionContext, preview.rs
 * inspection_context): agentRoot, a root project with the scope's projectId,
 * the scope's taskId, provision directives, and the preview compile's
 * placement correlation and dispatchEnv. They run on a cold ASP_HOME, ahead
 * of the compiles: an inspection whose effective harness is claude or codex
 * materializes the bundle (agent-inspection.ts compiles), agent-harness
 * writes nothing; the stage tree after each case shows which.
 */
function inspectCases(stage: Stage): CallCase[] {
  const inspect = (id: string, params: Record<string, unknown>) =>
    call(id, 'aspc.inspectRuntimePlacement', { schemaVersion: INSPECT, ...params })
  const context = (agent: string, overrides: Record<string, unknown> = {}) => ({
    agentId: agent,
    agentRoot: join(stage.agentsRoot, agent),
    project: { mode: 'root', projectRoot: stage.projectRoot, projectId: 'project' },
    cwd: stage.projectRoot,
    runMode: 'task',
    taskId: 'T-11951',
    ...overrides,
  })
  const preview = (agent: string, harness?: string, overrides: Record<string, unknown> = {}) => {
    const scopeRef = `agent:${agent}:project:project:task:T-11951`
    return {
      context: context(agent, harness === undefined ? {} : { provisionDirectives: { harness } }),
      preparationCorrelation: {
        sessionRef: { scopeRef, laneRef: 'main' },
        hostSessionId: 'hsid-inspect',
        generation: 1,
        runtimeId: 'rt-inspect',
        invocationId: 'inv-inspect',
        initialInputId: 'input-inspect',
        runId: 'run-inspect',
      },
      dispatchEnv: { AGENT_SCOPE_REF: scopeRef, AGENT_LANE_REF: 'main', AGENT_TASK: 'T-11951' },
      ...overrides,
    }
  }
  const claude = { provisionDirectives: { harness: 'claude' } }
  return [
    // First, on the cold store: the project space materializes with the
    // bundle (inspection_failed before the T-11951 fix: no projectRoot).
    inspect('inspect:claude:project-space', preview(PROJECT_SPACE_AGENT, 'claude')),
    inspect('inspect:claude:participant-only', preview(PARTICIPANT_AGENT, 'claude')),
    inspect('inspect:agent-harness:preview', preview('pathmark-dev')),
    inspect('inspect:claude:preview', preview('pathmark-dev', 'claude')),
    inspect('inspect:claude:preview:warm', preview('pathmark-dev', 'claude')),
    inspect('inspect:codex:preview', preview('pathmark-dev', 'codex')),
    inspect('inspect:codex:full', preview(CODEX_AGENT, 'codex')),
    inspect(
      'inspect:claude:task-context',
      preview('pathmark-dev', 'claude', {
        preparationTaskContext: {
          taskId: 'T-11951',
          phase: null,
          role: 'implementer',
          requiredEvidenceKinds: ['test'],
          hintsText: 'Read the spec first.',
        },
      })
    ),
    inspect('inspect:claude:project-none', {
      context: context('pathmark-dev', { ...claude, project: { mode: 'none' } }),
    }),
    inspect('inspect:claude:infer-from-cwd', {
      context: {
        agentId: 'pathmark-dev',
        project: { mode: 'infer-from-cwd' },
        cwd: stage.projectRoot,
        runMode: 'task',
        ...claude,
      },
    }),
    inspect('inspect:codex:full:primary', {
      ...preview(CODEX_AGENT, 'codex'),
      context: context(CODEX_AGENT, {
        provisionDirectives: { harness: 'codex' },
        taskId: undefined,
      }),
      preparationCorrelation: {
        sessionRef: { scopeRef: `agent:${CODEX_AGENT}:project:project`, laneRef: 'main' },
        hostSessionId: 'hsid-inspect-primary',
      },
    }),
    inspect(
      'inspect:configured_context_mismatch',
      preview('pathmark-dev', 'claude', {
        preparationCorrelation: {
          sessionRef: { scopeRef: 'agent:someone-else:project:project', laneRef: 'main' },
        },
      })
    ),
    // A git-pinned space: forwarded before any write (T-11825).
    inspect('inspect:claude:pinned', preview('pathmark', 'claude')),
    inspect('inspect:muse', preview('pathmark-dev', 'muse')),
    inspect('inspect:agent_not_found', preview('pm-nobody', 'claude')),
    inspect('inspect:agent_profile_invalid', preview('pm-broken', 'claude')),
    inspect('inspect:unsupported_schema', {
      ...preview('pathmark-dev', 'claude'),
      schemaVersion: 'aspc-inspect-runtime-placement-request/v0',
    }),
    inspect('inspect:invalid-params', { ...preview('pathmark-dev', 'claude'), stray: true }),
  ]
}

/**
 * aspc.observeRuntimeCapability (T-11951) as both HRCs' federation summon gate
 * sends it (summon-capability.ts, gate.rs): the harness and a task context,
 * with a root project or infer-from-cwd.
 */
function capabilityCases(stage: Stage): CallCase[] {
  const observe = (id: string, harness: unknown, overrides: Record<string, unknown> = {}) =>
    call(id, 'aspc.observeRuntimeCapability', {
      schemaVersion: CAPABILITY,
      harness,
      context: {
        agentId: 'pathmark-dev',
        project: { mode: 'root', projectRoot: stage.projectRoot, projectId: 'project' },
        cwd: stage.projectRoot,
        runMode: 'task',
      },
      ...overrides,
    })
  return [
    observe('capability:claude', 'claude'),
    observe('capability:codex', 'codex'),
    observe('capability:agent-harness', 'agent-harness'),
    observe('capability:muse', 'muse'),
    observe('capability:codex:infer-from-cwd', 'codex', {
      context: {
        agentId: 'pathmark-dev',
        project: { mode: 'infer-from-cwd' },
        cwd: stage.projectRoot,
        runMode: 'task',
      },
    }),
    observe('capability:unsupported_harness', 'pi'),
    observe('capability:unsupported_schema', 'claude', {
      schemaVersion: 'aspc-observe-runtime-capability-request/v0',
    }),
    observe('capability:invalid-params', 42),
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
  // The params a birth sends: compile.rs `Compiled::prepare` (and Bun HRC's
  // aspd-headless-start) add the placement's dispatchEnv and HRC's ASP_HOME.
  const birth = (id: string, row: Row): CallCase => {
    const request = rusthrcCompileRequest(asp, stage, row)
    const placement = request['placement'] as Record<string, unknown>
    return {
      ...call(id, 'aspc.compileHarnessInvocation', {
        compileRequest: request,
        dispatchEnv: placement['dispatchEnv'],
        aspHome: stage.aspHome,
      }),
      compileRequest: request,
    }
  }
  const byId = (id: string) => ROWS.find((row) => row.id === id) as Row
  // R3a (T-11841): claude-code over mutable spaces only, the live shape raspd
  // compiles natively. `pathmark` composes a git-pinned space, so its claude
  // rows above stay Bun's (forwarded before any write).
  const dev = (row: Row): Row => ({ ...row, id: `${row.id}-dev`, agent: 'pathmark-dev' })
  // R3b (T-11932): codex-app-server, headless and presented, fresh and resume
  // (Bun HRC's openai continuation), rusthrc and birth shapes, home rewrite
  // and reuse, on pathmark-dev and on the full-branch codex agent.
  const codexResume = (entry: CallCase): CallCase => {
    const request = entry.compileRequest as Record<string, unknown>
    const continuation = {
      hrc: { provider: 'openai', key: 'pathmark-thread', continuationId: 'cont_pathmark' },
      source: 'hrc',
    }
    request['continuation'] = continuation
    return entry
  }
  const codexRow = (id: string, presentation: boolean, agent: string): Row => ({
    id,
    requested: { harness: 'codex', presentation },
    agent,
  })
  const codexCases = [
    compile('compile:codex-tui:reuse', byId('codex-tui')),
    codexResume(
      compile('compile:codex-tui-resume', codexRow('codex-tui-resume', true, 'pathmark-dev'))
    ),
    codexResume(
      compile(
        'compile:codex-app-server-resume',
        codexRow('codex-app-server-resume', false, 'pathmark-dev')
      )
    ),
    birth('compile:codex-tui:birth', byId('codex-tui')),
    birth('compile:codex-app-server:birth', byId('codex-app-server')),
    compile('compile:codex-tui:full', codexRow('codex-tui-full', true, CODEX_AGENT)),
    compile('compile:codex-app-server:full', codexRow('codex-app-server-full', false, CODEX_AGENT)),
    birth('compile:codex-tui:full:birth', codexRow('codex-tui-full', true, CODEX_AGENT)),
    codexResume(
      birth(
        'compile:codex-tui-resume:full:birth',
        codexRow('codex-tui-resume-full', true, CODEX_AGENT)
      )
    ),
    compile('compile:codex-tui:full:summon-model', codexRow('codex-tui-full', true, CODEX_AGENT), {
      model: 'gpt-6.1-sol',
    }),
    // A git-pinned space: forwarded before any write; Bun throws on it (T-11825).
    compile('compile:codex-tui:pinned', codexRow('codex-tui-pinned', true, 'pathmark')),
  ]
  return [
    ...ROWS.map((row) => compile(`compile:${row.id}`, row)),
    compile('compile:claude-code:summon-model', byId('claude-code'), { model: 'sonnet' }),
    compile('compile:codex-tui:summon-effort', byId('codex-tui'), { reasoning_effort: 'high' }),
    compile('compile:claude-code:dev', dev(byId('claude-code'))),
    compile('compile:claude-code-resume:dev', dev(byId('claude-code-resume'))),
    compile('compile:claude-code:dev:summon-model', dev(byId('claude-code')), { model: 'sonnet' }),
    birth('compile:claude-code:dev:birth', dev(byId('claude-code'))),
    birth('compile:claude-code-resume:dev:birth', dev(byId('claude-code-resume'))),
    ...codexCases,
    compile('compile:claude-code:prune', {
      ...byId('claude-code'),
      id: 'claude-code-prune',
      agent: PRUNE_AGENT,
    }),
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
    ...capabilityCases(stage),
    ...inspectCases(stage),
    ...compileCases(asp, stage),
  ]
}
