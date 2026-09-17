/**
 * T-08577 protocol reds for the four additive ASPC preparation operations.
 *
 * The protocol module already exists and loads normally. Future exports are
 * reached through its public namespace so today's failures are collected
 * behavioral assertions (`typeof validator === 'function'`, closed validation,
 * and exact method/schema membership), never missing-import failures.
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

const IDENTITY_REQUEST = {
  schemaVersion: 'aspc-resolve-desktop-identity-request/v1',
  nativeThreadId: '018f0f3e-7d65-7c19-a2bd-5a43c86c72ab',
  reported: {
    codexHome: '/tmp/t08577/codex-home',
    sqliteHome: '/tmp/t08577/sqlite-home',
    rolloutPath:
      '/tmp/t08577/codex-home/sessions/2026/09/17/rollout-018f0f3e-7d65-7c19-a2bd-5a43c86c72ab.jsonl',
  },
  fallbackHomeDir: '/tmp/t08577/fallback',
}

const IDENTITY = {
  nativeThreadId: IDENTITY_REQUEST.nativeThreadId,
  homeIdentity: '/tmp/t08577/codex-home',
  sqliteHome: '/tmp/t08577/sqlite-home',
  registrationKey: 'a'.repeat(64),
  homeBasis: 'reported-home',
}

const ADMISSION_REQUEST = {
  schemaVersion: 'aspc-admit-desktop-registration-request/v1',
  identity: IDENTITY,
  rolloutPath: IDENTITY_REQUEST.reported.rolloutPath,
  reportedWorkspaceCwd: '/tmp/t08577/project',
}

const OBSERVER_REQUEST = {
  schemaVersion: 'aspc-prepare-desktop-observer-request/v1',
  registration: {
    registrationKey: IDENTITY.registrationKey,
    agentId: 'stella',
    projectId: 'agent-spaces',
    projectRoot: '/tmp/t08577/project',
    scopeRef: 'agent:stella:project:agent-spaces',
    laneRef: 'main',
    hostSessionId: 'hsid-t08577',
    generation: 7,
    nativeThreadId: IDENTITY.nativeThreadId,
    homeIdentity: IDENTITY.homeIdentity,
    sqliteHome: IDENTITY.sqliteHome,
    rolloutPath: IDENTITY_REQUEST.reported.rolloutPath,
    reportedBundleExecutable: '/tmp/t08577/ChatGPT.app/Contents/Resources/codex',
  },
  hostingIdentity: {
    runtimeId: 'runtime-t08577',
    runId: 'run-t08577',
    hostSessionId: 'hsid-t08577',
    generation: 7,
  },
  identity: {
    requestId: 'request-t08577',
    operationId: 'operation-t08577',
    invocationId: 'invocation-t08577',
  },
  recoveryBoundary: {
    committedProjections: [],
    appliedThroughSeq: 0,
    empty: true,
  },
  nativeAttemptStorePath: '/tmp/t08577/state/native-attempts.db',
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

  test('A2: the canonical method set contains exactly the four additive preparation methods', () => {
    const preparationMethods = protocol.ASPC_METHODS.filter((method) =>
      [
        'aspc.prepareProcessInvocation',
        'aspc.resolveDesktopIdentity',
        'aspc.admitDesktopRegistration',
        'aspc.prepareDesktopObserver',
      ].includes(method)
    )

    expect(preparationMethods).toEqual([
      'aspc.prepareProcessInvocation',
      'aspc.resolveDesktopIdentity',
      'aspc.admitDesktopRegistration',
      'aspc.prepareDesktopObserver',
    ])
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

  test('D1/D2: Desktop identity has a closed v1 request validator', () => {
    expectClosedV1Validator('validateAspcResolveDesktopIdentityRequest', IDENTITY_REQUEST)
    expectCommand('aspc.resolveDesktopIdentity', IDENTITY_REQUEST)
  })

  test('D4/D5: Desktop admission has a closed v1 request validator', () => {
    expectClosedV1Validator('validateAspcAdmitDesktopRegistrationRequest', ADMISSION_REQUEST)
    expectCommand('aspc.admitDesktopRegistration', ADMISSION_REQUEST)
  })

  test('E3/E4: Desktop observer has a closed v1 request and accepts no initial input', () => {
    expectClosedV1Validator('validateAspcPrepareDesktopObserverRequest', OBSERVER_REQUEST)
    expectCommand('aspc.prepareDesktopObserver', OBSERVER_REQUEST)

    const validate = requireValidator('validateAspcPrepareDesktopObserverRequest')
    expect(() =>
      validate({ ...OBSERVER_REQUEST, initialInput: { text: 'must never apply' } })
    ).toThrow()
  })

  test('B8: all response discriminators are distinct exact v1 literals', () => {
    expect({
      direct: namespace['ASPC_PREPARE_PROCESS_INVOCATION_RESPONSE_VERSION'],
      identity: namespace['ASPC_RESOLVE_DESKTOP_IDENTITY_RESPONSE_VERSION'],
      admission: namespace['ASPC_ADMIT_DESKTOP_REGISTRATION_RESPONSE_VERSION'],
      observer: namespace['ASPC_PREPARE_DESKTOP_OBSERVER_RESPONSE_VERSION'],
    }).toEqual({
      direct: 'aspc-prepare-process-invocation-response/v1',
      identity: 'aspc-resolve-desktop-identity-response/v1',
      admission: 'aspc-admit-desktop-registration-response/v1',
      observer: 'aspc-prepare-desktop-observer-response/v1',
    })
  })
})
