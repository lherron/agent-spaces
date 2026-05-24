import { describe, expect, test } from 'bun:test'
import {
  validateCommand,
  validateEventEnvelope,
  validateInvocationDispatchRequest,
  validateInvocationInput,
  validateInvocationSpec,
  validateInvocationStartRequest,
  validatePermissionRequestParams,
} from '../src/schemas'

const specSection62Example = {
  specVersion: 'harness-broker.invocation/v1',
  harness: {
    frontend: 'codex',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: 'codex',
    args: ['--enable', 'goals', 'app-server'],
    cwd: '/workspace/project',
    lockedEnv: {
      CODEX_HOME: '/workspace/.codex-home',
    },
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: {
      startupTimeoutMs: 20000,
      turnTimeoutMs: 900000,
      stopGraceMs: 5000,
    },
  },
  interaction: {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'none',
  },
  driver: {
    kind: 'codex-app-server',
    model: 'gpt-5.5-codex',
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
    resumeFallback: 'start-fresh',
    permissionPolicy: { mode: 'deny' },
  },
}

const specSection19InvocationStartSpec = {
  specVersion: 'harness-broker.invocation/v1',
  harness: {
    frontend: 'codex',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: 'codex',
    args: ['--enable', 'goals', 'app-server'],
    cwd: '/workspace/project',
    lockedEnv: {
      CODEX_HOME: '/workspace/.codex-home',
    },
    harnessTransport: { kind: 'jsonrpc-stdio' },
  },
  interaction: {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'none',
  },
  driver: {
    kind: 'codex-app-server',
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
    resumeFallback: 'start-fresh',
    permissionPolicy: { mode: 'deny' },
  },
}

const expectInvalidSpec = (value: unknown, expectedIssue: { path: string; code: string }) => {
  expect(() => validateInvocationSpec(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_INVOCATION_SPEC',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

const expectInvalidInput = (value: unknown, expectedIssue: { path: string; code: string }) => {
  expect(() => validateInvocationInput(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_INVOCATION_INPUT',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

const expectInvalidStartRequest = (
  value: unknown,
  expectedIssue: { path: string; code: string }
) => {
  expect(() => validateInvocationStartRequest(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_INVOCATION_START_REQUEST',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

const expectInvalidDispatchRequest = (
  value: unknown,
  expectedIssue: { path: string; code: string }
) => {
  expect(() => validateInvocationDispatchRequest(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_INVOCATION_DISPATCH_REQUEST',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

const expectInvalidEventEnvelope = (
  value: unknown,
  expectedIssue: { path: string; code: string }
) => {
  expect(() => validateEventEnvelope(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_EVENT_ENVELOPE',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

const expectInvalidPermissionRequestParams = (
  value: unknown,
  expectedIssue: { path: string; code: string }
) => {
  expect(() => validatePermissionRequestParams(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_PERMISSION_REQUEST_PARAMS',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

describe('validateInvocationSpec', () => {
  test('accepts the Codex app-server example from spec section 6.2', () => {
    expect(validateInvocationSpec(specSection62Example)).toEqual(specSection62Example)
  })

  test('accepts the invocation.start spec from the minimal end-to-end example', () => {
    expect(validateInvocationSpec(specSection19InvocationStartSpec)).toEqual(
      specSection19InvocationStartSpec
    )
  })

  test('rejects a spec missing process.command with a stable validation code', () => {
    const invalid = structuredClone(specSection62Example)
    Reflect.deleteProperty(invalid.process, 'command')

    expectInvalidSpec(invalid, {
      path: 'process.command',
      code: 'required',
    })
  })

  test('rejects a mismatched harness.driver and driver.kind', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.harness.driver = 'pi-cli'

    expectInvalidSpec(invalid, {
      path: 'harness.driver',
      code: 'invalid_driver',
    })
  })

  test('rejects env keys that cannot be passed to spawn safely', () => {
    const invalidWithEquals = structuredClone(specSection62Example)
    invalidWithEquals.process.lockedEnv['BAD=KEY'] = 'value'
    expectInvalidSpec(invalidWithEquals, {
      path: 'process.lockedEnv.BAD=KEY',
      code: 'invalid_env_key',
    })

    const invalidWithNull = structuredClone(specSection62Example)
    invalidWithNull.process.lockedEnv['BAD\u0000KEY'] = 'value'
    expectInvalidSpec(invalidWithNull, {
      path: 'process.lockedEnv.BAD\u0000KEY',
      code: 'invalid_env_key',
    })
  })

  test('rejects lockedEnv keys from ambient, credential, and reserved classes', () => {
    const ambient = structuredClone(specSection62Example)
    ambient.process.lockedEnv.HOME = '/Users/lherron'
    expectInvalidSpec(ambient, {
      path: 'process.lockedEnv.HOME',
      code: 'ambient_env_key',
    })

    const credential = structuredClone(specSection62Example)
    credential.process.lockedEnv.OPENAI_API_KEY = 'sk-test'
    expectInvalidSpec(credential, {
      path: 'process.lockedEnv.OPENAI_API_KEY',
      code: 'credential_env_key',
    })

    const reserved = structuredClone(specSection62Example)
    reserved.process.lockedEnv.NODE_OPTIONS = '--inspect'
    expectInvalidSpec(reserved, {
      path: 'process.lockedEnv.NODE_OPTIONS',
      code: 'reserved_env_key',
    })
  })

  test('rejects unsupported specVersion literals', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.specVersion = 'harness-broker.invocation/v2'

    expectInvalidSpec(invalid, {
      path: 'specVersion',
      code: 'invalid_literal',
    })
  })

  test('rejects unsupported driver permission default decisions', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.driver.permissionPolicy = {
      mode: 'ask-client',
      defaultDecision: 'prompt',
    }

    expectInvalidSpec(invalid, {
      path: 'driver.permissionPolicy.defaultDecision',
      code: 'invalid_literal',
    })
  })
})

describe('validateInvocationInput', () => {
  test('accepts text and local image content', () => {
    const input = {
      inputId: 'input_1',
      kind: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'local_image', path: '/tmp/image.png' },
      ],
      metadata: { source: 'test' },
    }

    expect(validateInvocationInput(input)).toEqual(input)
  })

  test('rejects missing content with a stable validation code', () => {
    expectInvalidInput(
      {
        kind: 'user',
      },
      {
        path: 'content',
        code: 'required',
      }
    )
  })
})

describe('validateInvocationStartRequest', () => {
  test('accepts a start request with initial input', () => {
    const request = {
      spec: specSection19InvocationStartSpec,
      initialInput: {
        inputId: 'input_1',
        kind: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    }

    expect(validateInvocationStartRequest(request)).toEqual(request)
  })

  test('rejects an invalid nested spec with prefixed issue paths', () => {
    const invalidSpec = structuredClone(specSection19InvocationStartSpec)
    Reflect.deleteProperty(invalidSpec.process, 'command')

    expectInvalidStartRequest(
      {
        spec: invalidSpec,
      },
      {
        path: 'spec.process.command',
        code: 'required',
      }
    )
  })
})

describe('validateInvocationDispatchRequest', () => {
  test('accepts a dispatch envelope with a verbatim start request and dispatchEnv', () => {
    const request = {
      startRequest: {
        spec: specSection19InvocationStartSpec,
        initialInput: {
          inputId: 'input_1',
          kind: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
      dispatchEnv: {
        WRKQ_HANDOFF_ID: 'handoff_1',
      },
    }

    expect(validateInvocationDispatchRequest(request)).toEqual(request)
  })

  test('rejects dispatchEnv that shadows lockedEnv', () => {
    expectInvalidDispatchRequest(
      {
        startRequest: { spec: specSection19InvocationStartSpec },
        dispatchEnv: { CODEX_HOME: '/tmp/other' },
      },
      {
        path: 'dispatchEnv.CODEX_HOME',
        code: 'dispatch_env_shadow',
      }
    )
  })

  test('rejects dispatchEnv from ambient, credential, and reserved classes', () => {
    expectInvalidDispatchRequest(
      {
        startRequest: { spec: specSection19InvocationStartSpec },
        dispatchEnv: { HOME: '/tmp' },
      },
      {
        path: 'dispatchEnv.HOME',
        code: 'ambient_env_key',
      }
    )

    expectInvalidDispatchRequest(
      {
        startRequest: { spec: specSection19InvocationStartSpec },
        dispatchEnv: { GITHUB_TOKEN: 'secret' },
      },
      {
        path: 'dispatchEnv.GITHUB_TOKEN',
        code: 'credential_env_key',
      }
    )

    expectInvalidDispatchRequest(
      {
        startRequest: { spec: specSection19InvocationStartSpec },
        dispatchEnv: { SSH_AUTH_SOCK: '/tmp/socket' },
      },
      {
        path: 'dispatchEnv.SSH_AUTH_SOCK',
        code: 'reserved_env_key',
      }
    )
  })
})

describe('validateCommand', () => {
  test('validates invocation.start as a dispatch envelope', () => {
    const command = {
      jsonrpc: '2.0',
      id: 1,
      method: 'invocation.start',
      params: {
        startRequest: {
          spec: specSection19InvocationStartSpec,
        },
        dispatchEnv: {
          WRKQ_HANDOFF_ID: 'handoff_1',
        },
      },
    }

    expect(validateCommand(command)).toEqual(command)
  })

  test('rejects bare start request params for invocation.start', () => {
    expect(() =>
      validateCommand({
        jsonrpc: '2.0',
        id: 1,
        method: 'invocation.start',
        params: {
          spec: specSection19InvocationStartSpec,
        },
      })
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_COMMAND',
        issues: expect.arrayContaining([
          expect.objectContaining({ path: 'params.startRequest', code: 'required' }),
        ]),
      })
    )
  })

  test('keeps v1 command validation notification-based', () => {
    expect(() =>
      validateCommand({
        jsonrpc: '2.0',
        id: 1,
        method: 'invocation.events',
        params: { invocationId: 'inv_1' },
      })
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_COMMAND',
        issues: expect.arrayContaining([
          expect.objectContaining({ path: 'method', code: 'unknown_method' }),
        ]),
      })
    )
  })
})

describe('validatePermissionRequestParams', () => {
  test('accepts broker-to-client permission request params', () => {
    const params = {
      invocationId: 'inv_1',
      turnId: 'turn_1',
      permissionRequestId: 'perm_1',
      kind: 'command',
      subject: { argv: ['ls'] },
      defaultDecision: 'deny',
      deadlineMs: 1000,
    }

    expect(validatePermissionRequestParams(params)).toEqual(params)
  })

  test('rejects unsupported default decisions', () => {
    expectInvalidPermissionRequestParams(
      {
        invocationId: 'inv_1',
        permissionRequestId: 'perm_1',
        kind: 'command',
        subject: { argv: ['ls'] },
        defaultDecision: 'prompt',
      },
      {
        path: 'defaultDecision',
        code: 'invalid_literal',
      }
    )
  })

  test('requires the subject field even when display subject is absent', () => {
    expectInvalidPermissionRequestParams(
      {
        invocationId: 'inv_1',
        permissionRequestId: 'perm_1',
        kind: 'command',
        defaultDecision: 'deny',
      },
      {
        path: 'subject',
        code: 'required',
      }
    )
  })
})

describe('validateEventEnvelope', () => {
  const envelope = (type: string, payload: unknown) => ({
    invocationId: 'inv_1',
    seq: 1,
    time: '2026-05-24T00:00:00.000Z',
    type,
    payload,
  })

  const eventPayloads: Record<string, unknown> = {
    'invocation.started': {
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace',
    },
    'invocation.ready': { state: 'ready' },
    'invocation.stopping': { reason: 'requested' },
    'invocation.exited': { exitCode: 0, signal: null },
    'invocation.failed': { message: 'failed' },
    'invocation.disposed': { disposed: true },
    'continuation.updated': { provider: 'openai', key: 'thread_1' },
    'input.accepted': { inputId: 'input_1' },
    'input.rejected': { inputId: 'input_1', reason: 'busy' },
    'input.queued': { inputId: 'input_1' },
    'turn.started': { turnId: 'turn_1' },
    'turn.completed': { turnId: 'turn_1', status: 'completed' },
    'turn.failed': { turnId: 'turn_1', message: 'failed' },
    'turn.interrupted': { turnId: 'turn_1', reason: 'requested' },
    'assistant.message.started': { messageId: 'msg_1' },
    'assistant.message.delta': { messageId: 'msg_1', text: 'hello' },
    'assistant.message.completed': {
      messageId: 'msg_1',
      content: [{ type: 'text', text: 'hello' }],
    },
    'tool.call.started': { toolCallId: 'tool_1', name: 'read' },
    'tool.call.delta': { toolCallId: 'tool_1', text: 'chunk' },
    'tool.call.completed': { toolCallId: 'tool_1', name: 'read' },
    'tool.call.failed': { toolCallId: 'tool_1', name: 'read', message: 'failed' },
    'usage.updated': { usage: { inputTokens: 1 } },
    diagnostic: { level: 'info', message: 'notice' },
    'driver.notice': { message: 'notice' },
    'permission.requested': {
      permissionRequestId: 'perm_1',
      kind: 'command',
      subjectDisplay: { argv: ['ls'] },
      defaultDecision: 'deny',
      deadlineMs: 1000,
    },
    'permission.resolved': {
      permissionRequestId: 'perm_1',
      decision: 'deny',
      decidedBy: 'policy',
      message: 'blocked',
    },
  }

  test('accepts every final v1 invocation event type', () => {
    for (const [type, payload] of Object.entries(eventPayloads)) {
      expect(validateEventEnvelope(envelope(type, payload))).toEqual(envelope(type, payload))
    }
  })

  test('rejects unsupported event types', () => {
    expectInvalidEventEnvelope(envelope('invocation.permission.request', {}), {
      path: 'type',
      code: 'invalid_event_type',
    })
  })

  test('validates invocation.ready and invocation.disposed payloads', () => {
    expectInvalidEventEnvelope(envelope('invocation.ready', {}), {
      path: 'payload.state',
      code: 'required',
    })
    expectInvalidEventEnvelope(envelope('invocation.disposed', {}), {
      path: 'payload.disposed',
      code: 'required',
    })
  })

  test('validates permission event payloads', () => {
    expectInvalidEventEnvelope(
      envelope('permission.requested', {
        permissionRequestId: 'perm_1',
        kind: 'command',
        subjectDisplay: { argv: ['ls'] },
        defaultDecision: 'prompt',
      }),
      {
        path: 'payload.defaultDecision',
        code: 'invalid_literal',
      }
    )
    expectInvalidEventEnvelope(
      envelope('permission.resolved', {
        permissionRequestId: 'perm_1',
        decision: 'deny',
        decidedBy: 'client',
      }),
      {
        path: 'payload.decidedBy',
        code: 'invalid_literal',
      }
    )
  })
})
