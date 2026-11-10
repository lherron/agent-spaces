import { join } from 'node:path'
import type { Ctx, ProbeCase } from '../ctx.ts'
const ident = (_c: Ctx) => ({
  agentId: 'pathmark-dev',
  agentName: 'pathmark-dev',
  projectId: 'project',
  mode: 'task',
  scope: 'pathmark-dev@project:T-13008',
  taskId: 'T-13008',
  lane: 'main',
  harness: 'claude',
  presentation: true,
})
const evalCtx = (c: Ctx) => ({
  schemaVersion: 'agent-inspection-evaluation-context/v2',
  identifiers: ident(c),
  paths: {
    agentRoot: join(c.stage.agentsRoot, 'pathmark-dev'),
    agentsRoot: c.stage.agentsRoot,
    projectRoot: c.stage.projectRoot,
    cwd: c.stage.projectRoot,
  },
  nowIso: '2026-11-09T00:00:00.000Z',
  environment: {},
  predicateInputs: { cwd: c.stage.projectRoot, environment: {} },
  execInputs: { cwd: c.stage.projectRoot, environment: {} },
  serviceProbeInputs: { responses: [] },
  scaffoldPackets: [],
  agentProfile: {},
  declaredOverrides: {},
  compileContext: {
    nowIso: '2026-11-09T00:00:00.000Z',
    idSalt: 't13008',
    toolchainManifest: {
      schemaVersion: 'compile-toolchain/v1',
      tools: [{ name: 'agent-spaces', version: 'test' }],
    },
  },
})
const ctxDecl = (c: Ctx) => ({
  agentId: 'pathmark-dev',
  agentRoot: join(c.stage.agentsRoot, 'pathmark-dev'),
  cwd: c.stage.projectRoot,
  runMode: 'task',
  project: { mode: 'root', projectRoot: c.stage.projectRoot, projectId: 'project' },
})
const cases: ProbeCase[] = [
  {
    reason: '(unserved)',
    id: 'unserved--catalogAgents',
    method: 'aspc.catalogAgents',
    condition: 'catalog the scratch agents root',
    params: (c) => ({ evaluationContext: evalCtx(c) }),
  },
  {
    reason: '(unserved)',
    id: 'unserved--catalogAgents-bad',
    method: 'aspc.catalogAgents',
    condition: 'catalogAgents with {} (the avs -32602 shape)',
    params: () => ({}),
  },
  {
    reason: '(unserved)',
    id: 'unserved--inspectAgent',
    method: 'aspc.inspectAgent',
    condition: 'inspect pathmark-dev (claude)',
    params: (c) => ({
      request: {
        schemaVersion: 'agent-inspection-request/v2',
        identifiers: ident(c),
        declaredOverrides: {},
      },
      evaluationContext: evalCtx(c),
    }),
  },
  {
    reason: '(unserved)',
    id: 'unserved--catalogAgentInspection',
    method: 'aspc.catalogAgentInspection',
    condition: 'identifier-only catalog, no project',
    params: () => ({}),
  },
  {
    reason: '(unserved)',
    id: 'unserved--catalogAgentInspection-project',
    method: 'aspc.catalogAgentInspection',
    condition: 'identifier-only catalog for projectId project',
    params: () => ({ projectId: 'project' }),
  },
  {
    reason: '(unserved)',
    id: 'unserved--inspectAgentSelection',
    method: 'aspc.inspectAgentSelection',
    condition: 'inspect pathmark-dev by selection',
    params: (c) => ({
      agentId: 'pathmark-dev',
      request: {
        schemaVersion: 'agent-inspection-request/v2',
        identifiers: ident(c),
        declaredOverrides: {},
      },
    }),
  },
  {
    reason: '(unserved)',
    id: 'unserved--prepareProcessInvocation',
    method: 'aspc.prepareProcessInvocation',
    condition: 'direct claude-code process for pathmark-dev',
    params: (c) => ({
      schemaVersion: 'aspc-prepare-process-invocation-request/v1',
      context: ctxDecl(c),
      preparationCorrelation: {
        hostSessionId: 'host_t13008',
        generation: 1,
        sessionRef: {
          scopeRef: 'agent:pathmark-dev:project:project:task:T-13008',
          laneRef: 'main',
        },
      },
      expected: { provider: 'anthropic', frontend: 'claude-code' },
      launch: { interactionMode: 'headless', ioMode: 'pipes', prompt: 'hi' },
    }),
  },
  {
    reason: '(unserved)',
    id: 'unserved--prepareProcessInvocation-hrcpty',
    method: 'aspc.prepareProcessInvocation',
    condition:
      'direct claude-code process for pathmark-claude-hrcpty (profile harness claude-hrcpty)',
    params: (c) => ({
      schemaVersion: 'aspc-prepare-process-invocation-request/v1',
      context: {
        ...ctxDecl(c),
        agentId: 'pathmark-claude-hrcpty',
        agentRoot: join(c.stage.agentsRoot, 'pathmark-claude-hrcpty'),
      },
      preparationCorrelation: {
        hostSessionId: 'host_t13008',
        generation: 1,
        sessionRef: {
          scopeRef: 'agent:pathmark-claude-hrcpty:project:project:task:T-13008',
          laneRef: 'main',
        },
      },
      expected: { provider: 'anthropic', frontend: 'claude-code' },
      launch: { interactionMode: 'headless', ioMode: 'pipes', prompt: 'hi' },
    }),
  },
]
export default cases
