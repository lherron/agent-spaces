import { describe, expect, test } from 'bun:test'
import {
  ASPC_METHODS,
  ASPC_PROTOCOL_VERSION,
  AspcCommandValidationError,
  AspcHelloRequestValidationError,
  validateAspcCommand,
  validateAspcCompileAndStartRequest,
  validateAspcCompileHarnessInvocationRequest,
  validateAspcCompileRuntimePlanRequest,
  validateAspcHelloRequest,
} from '../src/index.js'

const compileRequest = {
  schemaVersion: 'agent-runtime-compile-request/v1',
  identity: {
    requestId: 'req_1',
    operationId: 'op_1',
    hostSessionId: 'host_1',
    generation: 1,
    runtimeId: 'runtime_1',
  },
  placement: {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'agent',
  },
  requested: {
    modelProvider: 'openai',
    harnessFamily: 'codex',
    preferredHarnessRuntime: 'codex-cli',
    interactionMode: 'headless',
  },
  materialization: {
    initialPrompt: 'hello',
  },
  hrcPolicy: {},
  correlation: {
    requestId: 'req_1',
    operationId: 'op_1',
    hostSessionId: 'host_1',
    generation: 1,
    runtimeId: 'runtime_1',
  },
}

describe('ASPC protocol validators', () => {
  test('validates aspc.hello', () => {
    const request = {
      clientInfo: { name: 'non-ts-client' },
      protocolVersions: [ASPC_PROTOCOL_VERSION],
    }
    expect(validateAspcHelloRequest(request)).toEqual(request)
    expect(
      validateAspcCommand({
        jsonrpc: '2.0',
        id: '1',
        method: 'aspc.hello',
        params: request,
      })
    ).toMatchObject({ method: 'aspc.hello' })
  })

  test('rejects hello without aspc/0.1 support', () => {
    expect(() =>
      validateAspcHelloRequest({
        clientInfo: { name: 'old-client' },
        protocolVersions: ['aspc/0.0'],
      })
    ).toThrow('Invalid ASPC hello request')
  })

  test('validates compileRuntimePlan params', () => {
    const request = { compileRequest, aspHome: '/tmp/asp-home' }
    expect(validateAspcCompileRuntimePlanRequest(request)).toEqual(request)
    expect(
      validateAspcCommand({
        jsonrpc: '2.0',
        id: '2',
        method: 'aspc.compileRuntimePlan',
        params: request,
      })
    ).toMatchObject({ method: 'aspc.compileRuntimePlan' })
  })

  test('accepts compile requests carrying hrcPolicy.disallowedTools', () => {
    const request = {
      compileRequest: {
        ...compileRequest,
        hrcPolicy: { disallowedTools: ['AskUserQuestion'] },
      },
      aspHome: '/tmp/asp-home',
    }

    expect(validateAspcCompileRuntimePlanRequest(request)).toEqual(request)
  })

  test('validates compileHarnessInvocation params with dispatch extras', () => {
    const request = {
      compileRequest,
      profileSelector: { brokerDriver: 'codex-app-server' },
      dispatchEnv: { EXTRA_FLAG: '1' },
    }
    expect(validateAspcCompileHarnessInvocationRequest(request)).toEqual(request)
    expect(
      validateAspcCommand({
        jsonrpc: '2.0',
        id: '3',
        method: 'aspc.compileHarnessInvocation',
        params: request,
      })
    ).toMatchObject({ method: 'aspc.compileHarnessInvocation' })
  })

  test('validates compileAndStart params (request helper + command)', () => {
    const request = {
      compileRequest,
      profileSelector: { brokerDriver: 'codex-app-server' },
      dispatchEnv: { EXTRA_FLAG: '1' },
    }
    expect(validateAspcCompileAndStartRequest(request)).toEqual(request)
    expect(
      validateAspcCommand({
        jsonrpc: '2.0',
        id: '5',
        method: 'aspc.compileAndStart',
        params: request,
      })
    ).toMatchObject({ method: 'aspc.compileAndStart' })
  })

  test('rejects compileAndStart params with a non-object compileRequest', () => {
    expect(() => validateAspcCompileAndStartRequest({ compileRequest: 'nope' })).toThrow(
      'Invalid ASPC compileHarnessInvocation request'
    )
  })

  test('rejects unknown ASPC methods', () => {
    expect(() =>
      validateAspcCommand({
        jsonrpc: '2.0',
        id: '4',
        method: 'broker.hello',
        params: {},
      })
    ).toThrow('Invalid ASPC command')
  })

  test('unsupported method error lists the valid methods', () => {
    let caught: AspcCommandValidationError | undefined
    try {
      validateAspcCommand({
        jsonrpc: '2.0',
        id: '4',
        method: 'broker.hello',
        params: {},
      })
    } catch (error) {
      caught = error as AspcCommandValidationError
    }
    expect(caught).toBeInstanceOf(AspcCommandValidationError)
    const methodIssue = caught?.issues.find((entry) => entry.path === 'method')
    expect(methodIssue?.message).toContain('broker.hello')
    for (const method of ASPC_METHODS) {
      expect(methodIssue?.message).toContain(method)
    }
  })

  test('non-string protocolVersions element reports an indexed path', () => {
    let caught: AspcHelloRequestValidationError | undefined
    try {
      validateAspcHelloRequest({
        clientInfo: { name: 'client' },
        protocolVersions: [ASPC_PROTOCOL_VERSION, 42],
      })
    } catch (error) {
      caught = error as AspcHelloRequestValidationError
    }
    expect(caught).toBeInstanceOf(AspcHelloRequestValidationError)
    const itemIssue = caught?.issues.find((entry) => entry.path === 'params.protocolVersions.1')
    expect(itemIssue?.message).toBe('params.protocolVersions.1 must be a string')
    // The array is malformed, so the "unsupported protocol" issue must NOT also
    // fire for the same field (A3: gated on the array being well-formed).
    expect(caught?.issues.some((entry) => entry.code === 'unsupported_protocol')).toBe(false)
  })
})
