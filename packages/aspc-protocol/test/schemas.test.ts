import { describe, expect, test } from 'bun:test'
import {
  ASPC_PROTOCOL_VERSION,
  validateAspcCommand,
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
})
