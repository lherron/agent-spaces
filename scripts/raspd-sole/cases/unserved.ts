import { mkdirSync, writeFileSync } from 'node:fs'
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
export const evalCtx = (c: Ctx) => ({
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
  serviceProbeInputs: { responses: [] as { name: string; endpoint: string; up: boolean }[] },
  scaffoldPackets: [] as { slot: string; content?: string; ref?: string }[],
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
    condition: 'catalog 71 scratch agents without compiling',
    setup: (c) => {
      for (let i = 0; i < 62; i++) {
        const root = join(
          c.stage.agentsRoot,
          ['alpha', 'Alpha-extra', '_alpha', 'éclair'][i] ?? `catalog-${String(i).padStart(2, '0')}`
        )
        mkdirSync(root, { recursive: true })
        writeFileSync(
          join(root, 'agent-profile.toml'),
          `version = 4\n[identity]\ndisplay = "Catalog ${i}"\nrole = "primary"\n`
        )
      }
    },
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
for (const [id, mutate] of [
  [
    'bad-request',
    (p: any) => {
      p.request = {}
    },
  ],
  [
    'bad-context',
    (p: any) => {
      p.evaluationContext.paths.cwd = ''
    },
  ],
  [
    'unknown-param',
    (p: any) => {
      p.extra = true
    },
  ],
  [
    'unknown-override',
    (p: any) => {
      p.request.declaredOverrides.cwd = '/tmp'
    },
  ],
  [
    'identity-mismatch',
    (p: any) => {
      p.request.identifiers.agentId = 'other'
    },
  ],
  [
    'overrides',
    (p: any) => {
      p.request.declaredOverrides = { modelId: 'sonnet', reasoningEffort: 'high' }
    },
  ],
] as const) {
  cases.push({
    reason: 'unserved',
    id: `unserved--inspectAgent-${id}`,
    method: 'aspc.inspectAgent',
    condition: `caller inspection ${id}`,
    params: (c) => {
      const p = structuredClone(
        cases.find((x) => x.id === 'unserved--inspectAgent')!.params(c)
      ) as any
      mutate(p)
      return p
    },
  })
}
cases.push({
  reason: 'unserved',
  id: 'unserved--inspectAgent-canonical',
  method: 'aspc.inspectAgent',
  condition: 'caller inspection with a canonical scope',
  params: (c) => {
    const evaluationContext = evalCtx(c)
    evaluationContext.identifiers.scope = 'agent:pathmark-dev:project:project:task:T-13008'
    return {
      request: {
        schemaVersion: 'agent-inspection-request/v2',
        identifiers: structuredClone(evaluationContext.identifiers),
        declaredOverrides: {},
      },
      evaluationContext,
    }
  },
})
for (const variant of ['overrides', 'codex', 'scaffold', 'pinned', 'roots'] as const) {
  cases.push({
    reason: 'unserved',
    id: `unserved--inspectAgent-canonical-${variant}`,
    method: 'aspc.inspectAgent',
    condition: `caller-owned canonical inspection context (${variant})`,
    setup:
      variant === 'pinned'
        ? (c) => {
            c.agent('caller-context', 'version = 4\n[spaces]\nbase = ["space:pm-dev@dev"]\n', {
              'context-template.toml': `schema_version = 2
mode = "replace"
[[prompt]]
name = "fixed"
type = "inline"
content = "{{env.T13054}}"
[[prompt]]
name = "predicate"
type = "inline"
content = "predicate matched"
[prompt.when]
envEquals = { name = "T13054", value = "predicate" }
[[prompt]]
name = "exec"
type = "exec"
command = "echo $T13054; pwd"
[[prompt]]
name = "service"
type = "service-probe"
[[prompt.services]]
name = "pinned"
endpoint = "tcp://127.0.0.1:1"
`,
            })
          }
        : undefined,
    params: (c) => {
      const evaluationContext = evalCtx(c)
      const id = evaluationContext.identifiers
      id.scope = 'agent:pathmark-dev:project:project:task:T-13008'
      if (variant === 'codex') id.harness = 'codex-hrcpty'
      if (variant === 'roots') {
        const root = join(c.stage.base, 'caller-agents')
        mkdirSync(root, { recursive: true })
        writeFileSync(
          join(root, 'context-template.toml'),
          'schema_version = 2\nmode = "replace"\n[[prompt]]\nname = "caller"\ntype = "inline"\ncontent = "caller roots win"\n'
        )
        evaluationContext.paths.agentsRoot = root
      }
      if (variant === 'scaffold')
        evaluationContext.scaffoldPackets = [{ slot: 'context', content: 'caller scaffold' }]
      if (variant === 'pinned') {
        id.agentId = id.agentName = 'caller-context'
        id.scope = 'agent:caller-context:project:project:task:T-13008'
        evaluationContext.paths.agentRoot = join(c.stage.agentsRoot, 'caller-context')
        evaluationContext.environment = { T13054: 'template' }
        evaluationContext.predicateInputs.environment = { T13054: 'predicate' }
        evaluationContext.execInputs = { cwd: c.stage.projectRoot, environment: { T13054: 'exec' } }
        evaluationContext.serviceProbeInputs.responses = [
          { name: 'pinned', endpoint: 'tcp://127.0.0.1:1', up: true },
        ]
      }
      return {
        request: {
          schemaVersion: 'agent-inspection-request/v2',
          identifiers: structuredClone(id),
          declaredOverrides:
            variant === 'overrides' ? { modelId: 'sonnet', reasoningEffort: 'high' } : {},
        },
        evaluationContext,
      }
    },
  })
}
export default cases
