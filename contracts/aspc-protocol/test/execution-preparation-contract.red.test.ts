/**
 * T-08577 protocol contract for the ASPC preparation operation.
 *
 * T-08594 retired the three Desktop preparation ops from the RPC surface; only
 * prepareProcessInvocation remains. Retired methods are refused as unknown
 * methods (schemas.test.ts), and the registered route is pinned by the exact
 * registered method set (harness/aspc compile-only-registration.test.ts).
 */
import { describe, expect, test } from 'bun:test'
import * as protocol from '../src/index.js'
import { validateAspcCommand, validateAspcPrepareProcessInvocationRequest } from '../src/index.js'

const DIRECT_REQUEST = {
  schemaVersion: 'aspc-prepare-process-invocation-request/v1',
  context: {
    agentId: 'cody',
    agentRoot: '/tmp/t08577/agents/cody',
    project: {
      mode: 'root',
      projectRoot: '/tmp/t08577/project',
      projectId: 'agent-spaces',
    },
    cwd: '/tmp/t08577/project',
    runMode: 'task',
    taskId: 'T-08577',
    agentSources: {
      aspHome: '/tmp/t08577/asp-home',
      agentsRoot: '/tmp/t08577/agents',
    },
  },
  preparationCorrelation: {},
  expected: { provider: 'openai', frontend: 'codex-cli' },
  launch: {
    interactionMode: 'headless',
    ioMode: 'pipes',
    prompt: 'prepare only',
  },
  dispatchEnv: { CALLER_FLAG: 'preserved' },
}

/** The distinct issue paths a rejected request names (one path may carry several issues). */
function issuePathsThrownBy(value: unknown): string[] {
  try {
    validateAspcPrepareProcessInvocationRequest(value)
  } catch (error) {
    const issues = (error as { issues?: Array<{ path: string }> }).issues
    if (!Array.isArray(issues)) throw error
    return [...new Set(issues.map((issue) => issue.path))]
  }
  throw new Error('expected the prepareProcessInvocation request to be rejected')
}

describe('ASPC execution-preparation contract (T-08577)', () => {
  test('B3/B8: direct preparation has a closed v1 request and required optional-member correlation object', () => {
    expect<unknown>(validateAspcPrepareProcessInvocationRequest(DIRECT_REQUEST)).toEqual(
      DIRECT_REQUEST
    )
    expect(
      validateAspcCommand({
        jsonrpc: '2.0',
        id: 't08577-aspc.prepareProcessInvocation',
        method: 'aspc.prepareProcessInvocation',
        params: DIRECT_REQUEST,
      })
    ).toMatchObject({ method: 'aspc.prepareProcessInvocation' })

    expect(issuePathsThrownBy({ ...DIRECT_REQUEST, unknownT08577Field: true })).toEqual([
      'params.unknownT08577Field',
    ])
    expect(issuePathsThrownBy({ ...DIRECT_REQUEST, schemaVersion: 'wrong/v0' })).toEqual([
      'params.schemaVersion',
    ])
    const { preparationCorrelation: _required, ...withoutCorrelation } = DIRECT_REQUEST
    expect(issuePathsThrownBy(withoutCorrelation)).toEqual(['params.preparationCorrelation'])
    expect(
      validateAspcPrepareProcessInvocationRequest({
        ...DIRECT_REQUEST,
        preparationCorrelation: {
          sessionRef: {
            scopeRef: 'app:caller-supplied',
            laneRef: 'lane:repair',
          },
        },
      })
    ).toBeDefined()
    expect(
      issuePathsThrownBy({
        ...DIRECT_REQUEST,
        launch: { ...DIRECT_REQUEST.launch, hostSessionId: 'duplicated-wire-home' },
      })
    ).toEqual(['params.launch.hostSessionId'])
  })
})

describe('published caller behavior (§9)', () => {
  const namespace = protocol as unknown as Record<string, unknown>
  describe('published preparation response discriminator', () => {
    test('B8: the remaining response discriminator is the exact v1 literal', () => {
      expect({
        direct: namespace['ASPC_PREPARE_PROCESS_INVOCATION_RESPONSE_VERSION'],
      }).toEqual({
        direct: 'aspc-prepare-process-invocation-response/v1',
      })
      expect(namespace['ASPC_RESOLVE_DESKTOP_IDENTITY_RESPONSE_VERSION']).toBeUndefined()
      expect(namespace['ASPC_ADMIT_DESKTOP_REGISTRATION_RESPONSE_VERSION']).toBeUndefined()
      expect(namespace['ASPC_PREPARE_DESKTOP_OBSERVER_RESPONSE_VERSION']).toBeUndefined()
    })
  })
})
