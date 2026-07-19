import { describe, expect, test } from 'bun:test'
import * as AgentSpaces from 'agent-spaces'
import * as AspcProtocol from 'spaces-aspc-protocol'
import type {
  AgentInspectionEvaluationContext,
  AgentInspectionRequest,
} from 'spaces-runtime-contracts'

type InspectAgentForContext = (
  input: { request: unknown; evaluationContext: unknown },
  options?: { compileRuntimePlan?: (() => Promise<never>) | undefined }
) => Promise<unknown>

type ValidateAspcInspectAgentRequest = (value: unknown) => unknown

describe('T-06330 inspection boundary', () => {
  test('rejects raw paths, env maps, and credential-shaped inputs at both operation and wire entries', async () => {
    const agentSpacesExports = AgentSpaces as Record<string, unknown>
    const protocolExports = AspcProtocol as Record<string, unknown>
    const inspectAgentForContext = agentSpacesExports['inspectAgentForContext']
    const validateAspcInspectAgentRequest = protocolExports['validateAspcInspectAgentRequest']
    expect(inspectAgentForContext, 'agent-spaces operation entry must be exported').toBeFunction()
    expect(
      validateAspcInspectAgentRequest,
      'ASPC inspect request validator must be exported'
    ).toBeFunction()

    const request = {
      ...inspectionRequest(),
      cwd: '/caller/raw/path',
      environment: { SHOULD_NOT_CROSS: 'wire' },
      apiToken: 'credential-value',
    }
    let operationCompileCalls = 0
    const operationError = await captureError(() =>
      (inspectAgentForContext as InspectAgentForContext)(
        { request, evaluationContext: evaluationContext() },
        {
          compileRuntimePlan: async () => {
            operationCompileCalls += 1
            throw new Error('boundary validation must run before compilation')
          },
        }
      )
    )
    expect(operationCompileCalls).toBe(0)
    expect(issuePaths(operationError)).toEqual(
      expect.arrayContaining(['cwd', 'environment', 'apiToken'])
    )

    const wireError = captureSyncError(() =>
      (validateAspcInspectAgentRequest as ValidateAspcInspectAgentRequest)({ request })
    )
    expect(issuePaths(wireError)).toEqual(
      expect.arrayContaining([
        'params.request.cwd',
        'params.request.environment',
        'params.request.apiToken',
      ])
    )
  })
})

function inspectionRequest(): AgentInspectionRequest {
  return {
    schemaVersion: 'agent-inspection-request/v1',
    identifiers: identity(),
    declaredOverrides: {},
  }
}

function evaluationContext(): AgentInspectionEvaluationContext {
  return {
    schemaVersion: 'agent-inspection-evaluation-context/v1',
    identifiers: identity(),
    paths: {
      agentRoot: '/explicit/agents/room-tester',
      agentsRoot: '/explicit/agents',
      projectRoot: '/explicit/project',
      cwd: '/explicit/project',
    },
    nowIso: '2026-07-18T12:34:56.000Z',
    environment: {},
    predicateInputs: { cwd: '/explicit/project', environment: {} },
    execInputs: { cwd: '/explicit/agents/room-tester', environment: {} },
    serviceProbeInputs: { responses: [] },
    scaffoldPackets: [],
    agentProfile: {},
    declaredOverrides: {},
    compileContext: {
      nowIso: '2026-07-18T12:34:56.000Z',
      idSalt: 'inspection-boundary-t06330',
      toolchainManifest: { schemaVersion: 'compile-toolchain/v1' },
    },
  }
}

function identity() {
  return {
    agentId: 'room-tester',
    projectId: 'agent-spaces',
    mode: 'task',
    scope: 'room-tester@agent-spaces:T-06330',
    taskId: 'T-06330',
    lane: 'main',
    harness: 'codex',
    frontend: 'taskboard',
    interaction: 'headless',
  }
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }
  throw new Error('expected action to reject')
}

function captureSyncError(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('expected action to throw')
}

function issuePaths(error: unknown): string[] {
  if (typeof error !== 'object' || error === null) return []
  const issues = (error as { issues?: unknown }).issues
  if (!Array.isArray(issues)) return []
  return issues.flatMap((issue) => {
    if (typeof issue !== 'object' || issue === null) return []
    const path = (issue as { path?: unknown }).path
    return typeof path === 'string' ? [path] : []
  })
}
