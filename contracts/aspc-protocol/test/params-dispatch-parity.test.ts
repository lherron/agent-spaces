/**
 * Every `aspc.*` method is validated by one params validator, reached two ways:
 * the per-method `validateAspc*Request` export and `validateAspcCommand`'s
 * dispatch table. Both must report the same issues for the same params.
 */
import { describe, expect, test } from 'bun:test'
import type { ValidationIssue } from 'spaces-harness-broker-protocol'
import * as Protocol from '../src/index.js'

const MALFORMED_CONTEXT = {
  agentId: 'smokey',
  project: { mode: 'root', projectId: 3, extra: 1 },
  cwd: 7,
  runMode: 'nope',
  agentSources: { aspHome: 1, stray: true },
  provisionDirectives: { a: 'x', b: {} },
  hidden: true,
}

const MALFORMED_SELECTION = {
  harness: 'pi',
  model: 2,
  reasoningEffort: 'max',
  presentation: 'no',
  viewer: 'x',
}

const CASES: Array<{
  method: Protocol.AspcMethod
  validate: (v: unknown) => unknown
  params: unknown
}> = [
  {
    method: 'aspc.hello',
    validate: Protocol.validateAspcHelloRequest,
    params: { clientInfo: { name: 1 }, protocolVersions: ['x'], capabilities: { a: 'b' } },
  },
  {
    method: 'aspc.compileHarnessInvocation',
    validate: Protocol.validateAspcCompileHarnessInvocationRequest,
    params: {
      compileRequest: {
        schemaVersion: 'agent-runtime-compile-request/v2',
        agent: { id: 'cody' },
        requested: MALFORMED_SELECTION,
        selectionContext: {
          summonDirectives: { ...MALFORMED_SELECTION, model_provider: 1, reasoning_effort: 'max' },
        },
      },
      compileContext: { nowIso: 1, toolchainManifest: 'x' },
      dispatchEnv: { A: 1 },
    },
  },
  {
    method: 'aspc.catalogAgents',
    validate: Protocol.validateAspcCatalogAgentsRequest,
    params: { evaluationContext: 'x', q: 1 },
  },
  {
    method: 'aspc.inspectAgent',
    validate: Protocol.validateAspcInspectAgentRequest,
    params: { request: 1 },
  },
  {
    method: 'aspc.catalogAgentInspection',
    validate: Protocol.validateAspcCatalogAgentInspectionRequest,
    params: { projectId: '-bad', x: 1 },
  },
  {
    method: 'aspc.inspectAgentSelection',
    validate: Protocol.validateAspcInspectAgentSelectionRequest,
    params: { agentId: '', request: { identifiers: { agentId: 'a', presentation: 'x' } } },
  },
  {
    method: 'aspc.resolveRuntimeDeclaration',
    validate: Protocol.validateAspcResolveRuntimeDeclarationRequest,
    params: { schemaVersion: 'x', context: MALFORMED_CONTEXT, extra: 1 },
  },
  {
    method: 'aspc.inspectRuntimePlacement',
    validate: Protocol.validateAspcInspectRuntimePlacementRequest,
    params: {
      schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
      context: MALFORMED_CONTEXT,
      dispatchEnv: { A: 2 },
      preparationCorrelation: { runId: 2, generation: 'g', sessionRef: { scopeRef: 1, x: 1 } },
      preparationTaskContext: { taskId: 1, requiredEvidenceKinds: [1], extra: 1 },
      junk: 1,
    },
  },
  {
    method: 'aspc.observeRuntimeCapability',
    validate: Protocol.validateAspcObserveRuntimeCapabilityRequest,
    params: {
      schemaVersion: 'aspc-observe-runtime-capability-request/v1',
      context: MALFORMED_CONTEXT,
      harness: 1,
      more: 1,
    },
  },
  {
    method: 'aspc.observeContinuationArtifact',
    validate: Protocol.validateAspcObserveContinuationArtifactRequest,
    params: {
      schemaVersion: 'v',
      continuation: { provider: 1, artifactFormat: 'zz' },
      historicalExecution: {
        frozenStartRequest: { keyBinding: 'k', brokerDriver: 'zz', planHash: 1 },
        recordedPlacement: { bundle: 1, compileId: 3 },
        other: 1,
      },
    },
  },
  {
    method: 'aspc.prepareProcessInvocation',
    validate: Protocol.validateAspcPrepareProcessInvocationRequest,
    params: {
      schemaVersion: 'aspc-prepare-process-invocation-request/v1',
      context: MALFORMED_CONTEXT,
      preparationCorrelation: 'x',
      expected: { provider: 'meta', frontend: 1 },
      launch: { interactionMode: 'q', ioMode: 'r', hostSessionId: 'h' },
      taskContext: { taskId: 'T-1', phase: 3, role: 'r', requiredEvidenceKinds: [], hintsText: '' },
    },
  },
]

function issuesOf(run: () => unknown): ValidationIssue[] {
  try {
    run()
  } catch (error) {
    if (error instanceof Protocol.AspcValidationError) return error.issues
    throw error
  }
  throw new Error('expected a validation error')
}

describe('ASPC params validation parity', () => {
  test('the cases cover every ASPC method', () => {
    expect(CASES.map((item) => item.method).sort()).toEqual([...Protocol.ASPC_METHODS].sort())
  })

  for (const { method, validate, params } of CASES) {
    test(`${method}: direct validator and command dispatch report the same issues`, () => {
      const direct = issuesOf(() => validate(params))
      const command = issuesOf(() =>
        Protocol.validateAspcCommand({ jsonrpc: '2.0', id: 1, method, params })
      )
      expect(direct.length).toBeGreaterThan(0)
      expect(command).toEqual(direct)
    })
  }
})
