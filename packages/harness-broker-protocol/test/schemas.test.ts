import { describe, expect, test } from 'bun:test'
import {
  validateInvocationInput,
  validateInvocationSpec,
  validateInvocationStartRequest,
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
    env: {
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
    env: {
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
    invalidWithEquals.process.env['BAD=KEY'] = 'value'
    expectInvalidSpec(invalidWithEquals, {
      path: 'process.env.BAD=KEY',
      code: 'invalid_env_key',
    })

    const invalidWithNull = structuredClone(specSection62Example)
    invalidWithNull.process.env['BAD\u0000KEY'] = 'value'
    expectInvalidSpec(invalidWithNull, {
      path: 'process.env.BAD\u0000KEY',
      code: 'invalid_env_key',
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
