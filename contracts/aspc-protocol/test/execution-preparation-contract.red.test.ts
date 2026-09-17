/**
 * T-08577 protocol reds for the ASPC preparation operations.
 *
 * The protocol module already exists and loads normally. Future exports are
 * reached through its public namespace so today's failures are collected
 * behavioral assertions (`typeof validator === 'function'`, closed validation,
 * and exact method/schema membership), never missing-import failures.
 * T-08594 retired the three Desktop preparation ops from the RPC surface; only
 * prepareProcessInvocation remains.
 */
import { describe, expect, test } from 'bun:test'
import * as protocol from '../src/index.js'

type Validator = (value: unknown) => unknown
type ProtocolNamespace = Record<string, unknown>

const namespace = protocol as unknown as ProtocolNamespace

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

function requireValidator(name: string): Validator {
  const candidate = namespace[name]
  expect(typeof candidate, `${name} must be exported from spaces-aspc-protocol`).toBe('function')
  return candidate as Validator
}

function expectClosedV1Validator(name: string, valid: Record<string, unknown>): void {
  const validate = requireValidator(name)
  expect(validate(valid)).toEqual(valid)
  expect(() => validate({ ...valid, unknownT08577Field: true })).toThrow()
  expect(() => validate({ ...valid, schemaVersion: 'wrong/v0' })).toThrow()
}

function expectCommand(method: string, params: unknown): void {
  expect(
    protocol.validateAspcCommand({
      jsonrpc: '2.0',
      id: `t08577-${method}`,
      method,
      params,
    })
  ).toMatchObject({ method })
}

describe('ASPC execution-preparation contract (T-08577)', () => {
  test('control: the pre-existing command validator remains fail-closed', () => {
    expect(() =>
      protocol.validateAspcCommand({
        jsonrpc: '2.0',
        id: 'control',
        method: 'aspc.notARealMethod',
        params: {},
      })
    ).toThrow(protocol.AspcCommandValidationError)
  })

  test('A2: the canonical method set contains exactly the one remaining preparation method', () => {
    const preparationMethods = protocol.ASPC_METHODS.filter((method) =>
      ['aspc.prepareProcessInvocation'].includes(method)
    )

    expect(preparationMethods).toEqual(['aspc.prepareProcessInvocation'])
  })

  test('A2/retired: the three Desktop methods are gone from the method set and fail closed', () => {
    for (const method of [
      'aspc.resolveDesktopIdentity',
      'aspc.admitDesktopRegistration',
      'aspc.prepareDesktopObserver',
    ]) {
      expect(protocol.ASPC_METHODS.includes(method as never)).toBe(false)
      expect(() =>
        protocol.validateAspcCommand({ jsonrpc: '2.0', id: 'retired', method, params: {} })
      ).toThrow(protocol.AspcCommandValidationError)
    }
    expect(namespace['validateAspcResolveDesktopIdentityRequest']).toBeUndefined()
    expect(namespace['validateAspcAdmitDesktopRegistrationRequest']).toBeUndefined()
    expect(namespace['validateAspcPrepareDesktopObserverRequest']).toBeUndefined()
  })

  test('B3/B8: direct preparation has a closed v1 request and required optional-member correlation object', () => {
    expectClosedV1Validator('validateAspcPrepareProcessInvocationRequest', DIRECT_REQUEST)
    expectCommand('aspc.prepareProcessInvocation', DIRECT_REQUEST)

    const validate = requireValidator('validateAspcPrepareProcessInvocationRequest')
    const { preparationCorrelation: _required, ...withoutCorrelation } = DIRECT_REQUEST
    expect(() => validate(withoutCorrelation)).toThrow()
    expect(
      validate({
        ...DIRECT_REQUEST,
        preparationCorrelation: {
          sessionRef: {
            scopeRef: 'app:caller-supplied',
            laneRef: 'lane:repair',
          },
        },
      })
    ).toBeDefined()
    expect(() =>
      validate({
        ...DIRECT_REQUEST,
        launch: { ...DIRECT_REQUEST.launch, hostSessionId: 'duplicated-wire-home' },
      })
    ).toThrow()
  })

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
