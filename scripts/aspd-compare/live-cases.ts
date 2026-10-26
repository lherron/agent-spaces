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

/** Agents whose profile provisions the claude harness. */
function claudeAgents(agentsRoot: string): string[] {
  return readdirSync(agentsRoot)
    .filter((name) => existsSync(join(agentsRoot, name, 'agent-profile.toml')))
    .filter((name) =>
      /^harness\s*=\s*"claude"/m.test(
        readFileSync(join(agentsRoot, name, 'agent-profile.toml'), 'utf8')
      )
    )
    .sort()
}

function request(stage: LiveStage, agent: string, project: string, task: string | undefined) {
  const projectRoot = join(stage.projectsRoot, project)
  const scopeRef =
    task === undefined
      ? `agent:${agent}:project:${project}`
      : `agent:${agent}:project:${project}:task:${task}`
  const suffix = `${agent}_${project}_${task ?? 'primary'}`.replaceAll('-', '_')
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

export function buildLiveCases(stage: LiveStage): CompareCase[] {
  const cases: CompareCase[] = [
    { kind: 'call', id: 'meta:hello', method: 'aspc.hello', params: HELLO_PARAMS },
  ]
  for (const agent of claudeAgents(stage.agentsRoot)) {
    for (const project of PROJECTS) {
      for (const task of ['T-11841', undefined]) {
        const compileRequest = request(stage, agent, project, task)
        const entry: CallCase = {
          kind: 'call',
          id: `live:${agent}@${project}:${task ?? 'primary'}`,
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
  return cases
}
