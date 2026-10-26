/**
 * The live-corpus compile cases for the aspd compare runner (T-11841, R3a):
 * `run.ts --cases live`. The fixture set (cases.ts) proves the mechanics on a
 * tiny hermetic stage; this one compiles the node's real agents against real
 * project roots, so every live branch (context templates with exec and
 * service-probe sections, hooks.toml, symlinked skills, MCP, agent-local
 * plugins, project targets, remote control) is compared.
 *
 * The stage holds a copy of the canonical agents root (compiles mkdir under an
 * agent's var/, and the copy keeps that out of the real tree), a scratch
 * ASP_HOME seeded with the node's default-targets.toml, and a scratch
 * CLAUDE_CONFIG_DIR for workspace trust. Each project's compile inputs
 * (asp-targets.toml, spaces/, a project-local agents/) are snapshotted into
 * the stage, so live edits by other seats cannot land between the passes. Params are a birth's `{ compileRequest, dispatchEnv, aspHome }`
 * (hrc-runtime crates/hrc-native/src/server/compile.rs), with and without a
 * task scope.
 *
 * By default the corpus is every claude agent x every snapshotted project.
 * `LiveSelection` narrows it to named agents (any harness, so codex agents
 * too: T-11882), named projects and a task id, and can add a resume row per
 * cell carrying Bun HRC's `continuation` (the fixture's claude-code-resume
 * shape, with the agent's harness provider).
 *
 * Each cell (agent x project x task scope) also carries the two R2b reads
 * (T-11951), ahead of its compiles: aspc.inspectRuntimePlacement in the turn
 * preview's shape (the cell's correlation and dispatchEnv) and
 * aspc.observeRuntimeCapability for the agent's harness in the summon gate's
 * shape. An inspection of a claude or codex agent materializes its bundle, so
 * the first cell of each agent writes cold.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { CallCase, CompareCase } from './cases.ts'
import { HELLO_PARAMS } from './cases.ts'

const PRAESIDIUM = join(homedir(), 'praesidium')
const CANONICAL_AGENTS = join(PRAESIDIUM, 'var', 'agents')
const NODE_ASP_HOME = join(PRAESIDIUM, 'var', 'spaces-repo')
const PROJECTS = ['agent-spaces', 'hrc-runtime', 'archagent', 'wrkq']

export type LiveStage = {
  base: string
  agentsRoot: string
  aspHome: string
  claudeConfigDir: string
  projectsRoot: string
}

export function seedLiveStage(base: string): LiveStage {
  rmSync(base, { recursive: true, force: true })
  const agentsRoot = join(base, 'agents')
  const aspHome = join(base, 'asp-home')
  const claudeConfigDir = join(base, 'claude-config')
  cpSync(CANONICAL_AGENTS, agentsRoot, { recursive: true, verbatimSymlinks: true })
  mkdirSync(aspHome, { recursive: true })
  mkdirSync(claudeConfigDir, { recursive: true })
  const defaults = join(NODE_ASP_HOME, 'default-targets.toml')
  if (existsSync(defaults)) cpSync(defaults, join(aspHome, 'default-targets.toml'))
  // A project's compile inputs, snapshotted: other seats edit the live
  // checkouts, and a space that changes between the two subjects' passes
  // would read as a difference between them.
  const projectsRoot = join(base, 'projects')
  for (const project of PROJECTS) {
    const source = join(PRAESIDIUM, project)
    const target = join(projectsRoot, project)
    mkdirSync(target, { recursive: true })
    for (const entry of ['asp-targets.toml', 'spaces', 'agents', 'justfile']) {
      if (existsSync(join(source, entry))) {
        cpSync(join(source, entry), join(target, entry), {
          recursive: true,
          verbatimSymlinks: true,
        })
      }
    }
  }
  return { base, agentsRoot, aspHome, claudeConfigDir, projectsRoot }
}

export type LiveSelection = {
  /** Agents to compile, any harness; default every claude agent. */
  agents?: string[] | undefined
  /** Projects to compile in; default every snapshotted project. */
  projects?: string[] | undefined
  /** The task seat's task id; default T-11841. */
  task?: string | undefined
  /** Add a continuation-carrying resume row per cell. */
  resume?: boolean | undefined
}

/** The harness an agent's profile provisions, if it names one. */
function profileHarness(agentsRoot: string, agent: string): string | undefined {
  const profile = join(agentsRoot, agent, 'agent-profile.toml')
  if (!existsSync(profile)) return undefined
  return readFileSync(profile, 'utf8').match(/^harness\s*=\s*"([^"]+)"/m)?.[1]
}

/** Agents whose profile provisions the claude harness. */
function claudeAgents(agentsRoot: string): string[] {
  return readdirSync(agentsRoot)
    .filter((name) => profileHarness(agentsRoot, name) === 'claude')
    .sort()
}

/** Bun HRC's continuation for a resume; the provider follows the harness (compile-broker-plan.ts). */
function continuation(harness: string | undefined, key: string) {
  const provider = harness === 'codex' ? 'openai' : 'anthropic'
  return { hrc: { provider, key, continuationId: `cont_${key}` }, source: 'hrc' }
}

function request(
  stage: LiveStage,
  agent: string,
  project: string,
  task: string | undefined,
  resume: boolean
) {
  const projectRoot = join(stage.projectsRoot, project)
  const scopeRef =
    task === undefined
      ? `agent:${agent}:project:${project}`
      : `agent:${agent}:project:${project}:task:${task}`
  const suffix = `${agent}_${project}_${task ?? 'primary'}${resume ? '_resume' : ''}`.replaceAll(
    '-',
    '_'
  )
  const identity = {
    hostSessionId: `host_${suffix}`,
    generation: 1,
    requestId: `req_${suffix}`,
    operationId: `op_${suffix}`,
    runtimeId: `rt_${suffix}`,
    invocationId: `inv_${suffix}`,
    traceId: `trace_${suffix}`,
    initialInputId: `input_${suffix}`,
    runId: `run_${suffix}`,
  }
  const sessionRef = `${scopeRef}/lane:main`
  return {
    schemaVersion: 'agent-runtime-compile-request/v2',
    agent: { id: agent },
    identity,
    placement: {
      agentRoot: join(stage.agentsRoot, agent),
      projectRoot,
      cwd: projectRoot,
      runMode: 'task',
      bundle: { kind: 'agent-project', agentName: agent, projectRoot },
      dryRun: false,
      correlation: {
        sessionRef: { scopeRef, laneRef: 'main' },
        hostSessionId: identity.hostSessionId,
        generation: 1,
        runtimeId: identity.runtimeId,
        invocationId: identity.invocationId,
        initialInputId: identity.initialInputId,
        runId: identity.runId,
      },
      dispatchEnv: {
        AGENT_SCOPE_REF: scopeRef,
        AGENT_LANE_REF: 'main',
        AGENT_SESSION_REF: sessionRef,
        HRC_SESSION_REF: sessionRef,
        AGENT_ID: agent,
        AGENT_HOST_SESSION_ID: identity.hostSessionId,
        AGENT_GENERATION: '1',
        ...(task !== undefined ? { AGENT_TASK: task } : {}),
      },
    },
    requested: {},
    materialization: {
      initialPrompt: 'live corpus prompt',
      ...(task !== undefined ? { taskContext: { taskId: task, requiredEvidenceKinds: [] } } : {}),
    },
    ...(resume
      ? { continuation: continuation(profileHarness(stage.agentsRoot, agent), `live-${suffix}`) }
      : {}),
    hrcPolicy: {},
    correlation: {
      scopeRef,
      requestId: identity.requestId,
      operationId: identity.operationId,
      hostSessionId: identity.hostSessionId,
      generation: 1,
      runtimeId: identity.runtimeId,
      invocationId: identity.invocationId,
      traceId: identity.traceId,
      runId: identity.runId,
      inputId: identity.initialInputId,
    },
  }
}

/** The turn preview's inspectRuntimePlacement params for one cell (declaration-handlers.ts, preview.rs). */
function inspectParams(stage: LiveStage, agent: string, project: string, task: string | undefined) {
  const compile = request(stage, agent, project, task, false)
  const projectRoot = compile.placement.projectRoot
  return {
    schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
    context: {
      agentId: agent,
      agentRoot: compile.placement.agentRoot,
      project: { mode: 'root', projectRoot, projectId: project },
      cwd: projectRoot,
      runMode: 'task',
      ...(task !== undefined ? { taskId: task } : {}),
    },
    preparationCorrelation: compile.placement.correlation,
    dispatchEnv: compile.placement.dispatchEnv,
  }
}

/** The summon gate's observeRuntimeCapability params (summon-capability.ts, gate.rs). */
function capabilityParams(stage: LiveStage, agent: string, project: string) {
  const projectRoot = join(stage.projectsRoot, project)
  return {
    schemaVersion: 'aspc-observe-runtime-capability-request/v1',
    harness: profileHarness(stage.agentsRoot, agent),
    context: {
      agentId: agent,
      project: { mode: 'root', projectRoot, projectId: project },
      cwd: projectRoot,
      runMode: 'task',
    },
  }
}

export function buildLiveCases(stage: LiveStage, selection: LiveSelection = {}): CompareCase[] {
  const agents = selection.agents ?? claudeAgents(stage.agentsRoot)
  for (const agent of agents) {
    if (profileHarness(stage.agentsRoot, agent) === undefined)
      throw new Error(`live agent ${agent} has no agent-profile.toml harness under the stage`)
  }
  const projects = selection.projects ?? PROJECTS
  for (const project of projects) {
    if (!PROJECTS.includes(project)) throw new Error(`live project ${project} is not snapshotted`)
  }
  const cases: CompareCase[] = [
    { kind: 'call', id: 'meta:hello', method: 'aspc.hello', params: HELLO_PARAMS },
  ]
  const shapes = selection.resume === true ? [false, true] : [false]
  for (const agent of agents) {
    for (const project of projects) {
      for (const task of [selection.task ?? 'T-11841', undefined]) {
        const cell = `${agent}@${project}:${task ?? 'primary'}`
        cases.push(
          {
            kind: 'call',
            id: `live-inspect:${cell}`,
            method: 'aspc.inspectRuntimePlacement',
            params: inspectParams(stage, agent, project, task),
          },
          {
            kind: 'call',
            id: `live-capability:${cell}`,
            method: 'aspc.observeRuntimeCapability',
            params: capabilityParams(stage, agent, project),
          }
        )
        for (const resume of shapes) {
          const compileRequest = request(stage, agent, project, task, resume)
          const entry: CallCase = {
            kind: 'call',
            id: `live:${agent}@${project}:${task ?? 'primary'}${resume ? ':resume' : ''}`,
            method: 'aspc.compileHarnessInvocation',
            // A birth's params (rusthrc compile.rs `Compiled::prepare`).
            params: {
              compileRequest,
              dispatchEnv: compileRequest.placement.dispatchEnv,
              aspHome: stage.aspHome,
            },
            compileRequest,
          }
          cases.push(entry)
        }
      }
    }
  }
  return cases
}
