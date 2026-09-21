import { describe, expect, test } from 'bun:test'
import {
  ASPC_METHODS,
  ASPC_PROTOCOL_VERSION,
  AspcCommandValidationError,
  AspcCompileHarnessInvocationRequestValidationError,
  AspcHelloRequestValidationError,
  validateAspcCommand,
  validateAspcCompileHarnessInvocationRequest,
  validateAspcHelloRequest,
} from '../src/index.js'

const compileRequest = {
  schemaVersion: 'agent-runtime-compile-request/v2',
  agent: { id: 'cody' },
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
    harness: 'codex',
    modelProvider: 'openai-codex',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    presentation: false,
  },
  materialization: { initialPrompt: 'hello' },
  hrcPolicy: { disallowedTools: ['AskUserQuestion'] },
  correlation: {
    requestId: 'req_1',
    operationId: 'op_1',
    hostSessionId: 'host_1',
    generation: 1,
    runtimeId: 'runtime_1',
  },
} as const

function captureCompileIssues(value: unknown) {
  try {
    validateAspcCompileHarnessInvocationRequest(value)
  } catch (error) {
    expect(error).toBeInstanceOf(AspcCompileHarnessInvocationRequestValidationError)
    return (error as AspcCompileHarnessInvocationRequestValidationError).issues
  }
  throw new Error('expected compile request validation to fail')
}

describe('ASPC protocol validators', () => {
  test('validates hello and advertises the closed method set', () => {
    const request = {
      clientInfo: { name: 'non-ts-client' },
      protocolVersions: [ASPC_PROTOCOL_VERSION],
    }
    expect(validateAspcHelloRequest(request)).toBe(request)
    expect(ASPC_METHODS).toEqual([
      'aspc.hello',
      'aspc.catalogAgents',
      'aspc.inspectAgent',
      'aspc.catalogAgentInspection',
      'aspc.inspectAgentSelection',
      'aspc.compileHarnessInvocation',
      'aspc.resolveRuntimeDeclaration',
      'aspc.inspectRuntimePlacement',
      'aspc.observeRuntimeCapability',
      'aspc.observeContinuationArtifact',
      'aspc.prepareProcessInvocation',
    ])
    expect(ASPC_METHODS).not.toContain('aspc.compileRuntimePlan' as never)
    expect(ASPC_METHODS).not.toContain('aspc.compileAndStart' as never)
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
    ).toThrow(AspcHelloRequestValidationError)
  })

  test('validates the sole v2 ordinary compile operation and preserves explicit false', () => {
    const request = {
      compileRequest,
      dispatchEnv: { EXTRA_FLAG: '1' },
      runtime: { runtimeId: 'runtime_1' },
      lifecyclePolicy: { runtimeRetention: 'keep-alive' },
    }
    expect(validateAspcCompileHarnessInvocationRequest(request)).toBe(request)
    expect(request.compileRequest.requested.presentation).toBe(false)
    expect(
      validateAspcCommand({
        jsonrpc: '2.0',
        id: '2',
        method: 'aspc.compileHarnessInvocation',
        params: request,
      })
    ).toMatchObject({ method: 'aspc.compileHarnessInvocation' })
  })

  test('rejects the removed compileAndStart method', () => {
    expect(() =>
      validateAspcCommand({
        jsonrpc: '2.0',
        id: '3',
        method: 'aspc.compileAndStart',
        params: { compileRequest },
      })
    ).toThrow(AspcCommandValidationError)
  })

  test('rejects the removed compileRuntimePlan method', () => {
    expect(() =>
      validateAspcCommand({
        jsonrpc: '2.0',
        id: '4',
        method: 'aspc.compileRuntimePlan',
        params: { compileRequest },
      })
    ).toThrow(AspcCommandValidationError)
  })

  test('rejects the v1 compile contract at schemaVersion', () => {
    const issues = captureCompileIssues({
      compileRequest: { ...compileRequest, schemaVersion: 'agent-runtime-compile-request/v1' },
    })
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: 'params.compileRequest.schemaVersion',
        code: 'invalid_literal',
      })
    )
  })

  for (const removed of [
    'harnessFamily',
    'preferredHarnessRuntime',
    'interactionMode',
    'controllerIntent',
    'brokerDriver',
  ] as const) {
    test(`rejects removed requested.${removed}`, () => {
      const issues = captureCompileIssues({
        compileRequest: {
          ...compileRequest,
          requested: { ...compileRequest.requested, [removed]: 'removed' },
        },
      })
      expect(issues).toContainEqual(
        expect.objectContaining({
          path: `params.compileRequest.requested.${removed}`,
          code: 'forbidden_input',
        })
      )
    })
  }

  for (const removed of ['profileSelector', 'profileId', 'profileHash', 'brokerDriver'] as const) {
    test(`rejects removed outer selector ${removed}`, () => {
      const issues = captureCompileIssues({ compileRequest, [removed]: 'removed' })
      expect(issues).toContainEqual(
        expect.objectContaining({ path: `params.${removed}`, code: 'forbidden_input' })
      )
    })
  }

  for (const harness of ['pi', 'pi-sdk', 'claude-code', 'codex-cli', 'muse-cli'] as const) {
    test(`rejects noncanonical harness ${harness}`, () => {
      const issues = captureCompileIssues({
        compileRequest: {
          ...compileRequest,
          requested: { ...compileRequest.requested, harness },
        },
      })
      expect(issues).toContainEqual(
        expect.objectContaining({
          path: 'params.compileRequest.requested.harness',
          code: 'invalid_literal',
        })
      )
    })
  }

  test('rejects unknown compile-request fields instead of shallowly accepting them', () => {
    const issues = captureCompileIssues({
      compileRequest: { ...compileRequest, unexpectedTopLevel: true },
    })
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: 'params.compileRequest.unexpectedTopLevel',
        code: 'forbidden_input',
      })
    )
  })

  test('rejects invalid reasoning effort and non-boolean presentation', () => {
    const issues = captureCompileIssues({
      compileRequest: {
        ...compileRequest,
        requested: {
          ...compileRequest.requested,
          reasoningEffort: 'extreme',
          presentation: 'false',
        },
      },
    })
    expect(issues.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        'params.compileRequest.requested.reasoningEffort',
        'params.compileRequest.requested.presentation',
      ])
    )
  })

  test('rejects non-string dispatch environment values', () => {
    const issues = captureCompileIssues({
      compileRequest,
      dispatchEnv: { GOOD: 'ok', BAD: 1 },
    })
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'params.dispatchEnv.BAD', code: 'invalid_type' })
    )
  })

  test('rejects unknown ASPC methods and lists the public set', () => {
    let caught: AspcCommandValidationError | undefined
    try {
      validateAspcCommand({ jsonrpc: '2.0', id: '5', method: 'broker.hello', params: {} })
    } catch (error) {
      caught = error as AspcCommandValidationError
    }
    expect(caught).toBeInstanceOf(AspcCommandValidationError)
    const issue = caught?.issues.find((entry) => entry.path === 'method')
    for (const method of ASPC_METHODS) expect(issue?.message).toContain(method)
  })
})
