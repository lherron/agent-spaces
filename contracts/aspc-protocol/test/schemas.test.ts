import { describe, expect, test } from 'bun:test'
import type { RuntimeCompileRequest } from 'spaces-runtime-contracts'
import {
  ASPC_METHODS,
  AspcCommandValidationError,
  AspcCompileHarnessInvocationRequestValidationError,
  AspcHelloRequestValidationError,
  validateAspcCommand,
  validateAspcCompileHarnessInvocationRequest,
  validateAspcHelloRequest,
} from '../src/index.js'
import { hostSessionIdFrom, operationIdFrom, requestIdFrom, runtimeIdFrom } from './ids'

const compileRequest: RuntimeCompileRequest = {
  schemaVersion: 'agent-runtime-compile-request/v2',
  agent: { id: 'cody' },
  identity: {
    requestId: requestIdFrom('req_1'),
    operationId: operationIdFrom('op_1'),
    hostSessionId: hostSessionIdFrom('host_1'),
    generation: 1,
    runtimeId: runtimeIdFrom('runtime_1'),
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
    requestId: requestIdFrom('req_1'),
    operationId: operationIdFrom('op_1'),
    hostSessionId: hostSessionIdFrom('host_1'),
    generation: 1,
    runtimeId: runtimeIdFrom('runtime_1'),
  },
}

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
  test('rejects hello without aspc/0.1 support', () => {
    expect(() =>
      validateAspcHelloRequest({
        clientInfo: { name: 'old-client' },
        protocolVersions: ['aspc/0.0'],
      })
    ).toThrow(AspcHelloRequestValidationError)
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

  // One row per object level; every unknown key (including removed legacy keys such as
  // outer profile selectors, requested.brokerDriver and summon `viewer`) takes the same
  // rejectUnknownParams branch at that level.
  test.each([
    ['params', { compileRequest, profileSelector: 'removed' }, 'params.profileSelector'],
    [
      'compileRequest',
      { compileRequest: { ...compileRequest, unexpectedTopLevel: true } },
      'params.compileRequest.unexpectedTopLevel',
    ],
    [
      'requested',
      {
        compileRequest: {
          ...compileRequest,
          requested: { ...compileRequest.requested, brokerDriver: 'removed' },
        },
      },
      'params.compileRequest.requested.brokerDriver',
    ],
    [
      'summonDirectives',
      {
        compileRequest: {
          ...compileRequest,
          selectionContext: { summonDirectives: { viewer: 'tmux' } },
        },
      },
      'params.compileRequest.selectionContext.summonDirectives.viewer',
    ],
    [
      'summonDirectives brokerDriver',
      {
        compileRequest: {
          ...compileRequest,
          selectionContext: { summonDirectives: { brokerDriver: 'muse-cli-tmux' } },
        },
      },
      'params.compileRequest.selectionContext.summonDirectives.brokerDriver',
    ],
  ] as const)(
    'an unknown key at any compile-request level is refused as forbidden_input at its path: %s',
    (_level, params, expectedPath) => {
      expect(captureCompileIssues(params)).toContainEqual(
        expect.objectContaining({ path: expectedPath, code: 'forbidden_input' })
      )
    }
  )

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
    // Removed (compileAndStart, compileRuntimePlan) and retired Desktop methods are
    // refused exactly like a foreign method name.
    for (const method of [
      'broker.hello',
      'aspc.compileAndStart',
      'aspc.compileRuntimePlan',
      'aspc.resolveDesktopIdentity',
    ]) {
      let caught: AspcCommandValidationError | undefined
      try {
        validateAspcCommand({ jsonrpc: '2.0', id: '5', method, params: { compileRequest } })
      } catch (error) {
        caught = error as AspcCommandValidationError
      }
      expect(caught, method).toBeInstanceOf(AspcCommandValidationError)
      const issue = caught?.issues.find((entry) => entry.path === 'method')
      expect(issue, method).toBeDefined()
      for (const listed of ASPC_METHODS) expect(issue?.message).toContain(listed)
    }
  })
})
