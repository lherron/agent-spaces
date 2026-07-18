import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as protocol from '../src'
import { conservativeDefaultLifecyclePolicyOverlay, lifecyclePolicyHash } from '../src/lifecycle'
import {
  validateCommand,
  validateEventEnvelope,
  validateInvocationDispatchRequest,
  validateInvocationInput,
  validateInvocationSpec,
  validateInvocationStartRequest,
  validatePermissionRequestParams,
} from '../src/schemas'

const expectInvalidCommand = (value: unknown, expectedIssue: { path: string; code: string }) => {
  expect(() => validateCommand(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_COMMAND',
      issues: expect.arrayContaining([expect.objectContaining(expectedIssue)]),
    })
  )
}

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

const claudeCodeTmuxSpec = {
  specVersion: 'harness-broker.invocation/v1',
  harness: {
    frontend: 'claude-code',
    provider: 'anthropic',
    driver: 'claude-code-tmux',
  },
  process: {
    command: 'claude',
    args: ['--model', 'sonnet'],
    cwd: '/workspace/project',
    harnessTransport: { kind: 'pty' },
  },
  interaction: {
    mode: 'interactive',
    turnConcurrency: 'single',
    inputQueue: 'fifo',
  },
  driver: {
    kind: 'claude-code-tmux',
    terminalHost: 'tmux',
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

const expectInvalidInputPath = (value: unknown, path: string) => {
  expect(() => validateInvocationInput(value)).toThrow(
    expect.objectContaining({
      code: 'INVALID_INVOCATION_INPUT',
      issues: expect.arrayContaining([expect.objectContaining({ path })]),
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

  test('accepts process.pathPrepend as an array of strings', () => {
    const valid = structuredClone(specSection62Example) as typeof specSection62Example & {
      process: { pathPrepend?: string[] }
    }
    valid.process.pathPrepend = ['/agent/tools/bin', '/opt/bin']
    expect(validateInvocationSpec(valid)).toEqual(valid)
  })

  test('rejects process.pathPrepend that is not an array', () => {
    const invalid = structuredClone(specSection62Example) as typeof specSection62Example & {
      process: { pathPrepend?: unknown }
    }
    invalid.process.pathPrepend = '/agent/tools/bin'
    expectInvalidSpec(invalid, {
      path: 'process.pathPrepend',
      code: 'invalid_type',
    })
  })

  test('rejects process.pathPrepend entries that are not strings', () => {
    const invalid = structuredClone(specSection62Example) as typeof specSection62Example & {
      process: { pathPrepend?: unknown[] }
    }
    invalid.process.pathPrepend = ['/agent/tools/bin', 42]
    expectInvalidSpec(invalid, {
      path: 'process.pathPrepend.1',
      code: 'invalid_type',
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

  test('reports required (not invalid_literal) for missing harnessTransport.kind', () => {
    const invalid = structuredClone(specSection62Example)
    Reflect.deleteProperty(invalid.process.harnessTransport, 'kind')

    expectInvalidSpec(invalid, {
      path: 'process.harnessTransport.kind',
      code: 'required',
    })
  })

  test('reports invalid_literal for unsupported harnessTransport.kind', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.process.harnessTransport.kind = 'websocket'

    expectInvalidSpec(invalid, {
      path: 'process.harnessTransport.kind',
      code: 'invalid_literal',
    })
  })

  test('reports required (not invalid_literal) for missing interaction.mode', () => {
    const invalid = structuredClone(specSection62Example)
    Reflect.deleteProperty(invalid.interaction, 'mode')

    expectInvalidSpec(invalid, {
      path: 'interaction.mode',
      code: 'required',
    })
  })

  test('reports invalid_literal for unsupported interaction.mode', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.interaction.mode = 'batch'

    expectInvalidSpec(invalid, {
      path: 'interaction.mode',
      code: 'invalid_literal',
    })
  })

  test('reports invalid_literal for unsupported interaction.inputQueue', () => {
    const invalid = structuredClone(specSection62Example)
    invalid.interaction.inputQueue = 'lifo'

    expectInvalidSpec(invalid, {
      path: 'interaction.inputQueue',
      code: 'invalid_literal',
    })
  })

  test('accepts spec with optional interaction.inputQueue omitted', () => {
    const valid = structuredClone(specSection62Example)
    Reflect.deleteProperty(valid.interaction, 'inputQueue')

    expect(() => validateInvocationSpec(valid)).not.toThrow()
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

  test('accepts per-turn response formats for text and JSON Schema object roots', () => {
    const jsonSchemaInput = {
      inputId: 'input_structured_response',
      kind: 'user',
      content: [{ type: 'text', text: 'return a status object' }],
      responseFormat: {
        kind: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['ok', 'blocked'] },
            count: { type: 'number', minimum: 0 },
            nullable: { type: ['string', 'null'] },
          },
          required: ['status'],
        },
      },
    }
    const textInput = {
      ...jsonSchemaInput,
      inputId: 'input_text_response',
      responseFormat: { kind: 'text' },
    }

    expect(validateInvocationInput(jsonSchemaInput)).toEqual(jsonSchemaInput)
    expect(validateInvocationInput(textInput)).toEqual(textInput)
  })

  test.each([
    ['text format carrying schema', { kind: 'text', schema: { type: 'object' } }, 'schema'],
    ['json_schema missing schema', { kind: 'json_schema' }, 'schema'],
    ['json_schema null root', { kind: 'json_schema', schema: null }, 'schema'],
    ['json_schema array root', { kind: 'json_schema', schema: [] }, 'schema'],
    ['json_schema primitive root', { kind: 'json_schema', schema: true }, 'schema'],
    ['unknown response format kind', { kind: 'xml_schema', schema: {} }, 'kind'],
    [
      'nested undefined schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: undefined } } },
      'schema.properties.value',
    ],
    [
      'nested function schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: () => true } } },
      'schema.properties.value',
    ],
    [
      'nested symbol schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: Symbol('x') } } },
      'schema.properties.value',
    ],
    [
      'nested bigint schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: 1n } } },
      'schema.properties.value',
    ],
    [
      'nested non-finite schema number',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: Number.NaN } } },
      'schema.properties.value',
    ],
    [
      'nested Date schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: new Date(0) } } },
      'schema.properties.value',
    ],
    [
      'nested Map schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: new Map() } } },
      'schema.properties.value',
    ],
    [
      'nested Set schema value',
      { kind: 'json_schema', schema: { type: 'object', properties: { value: new Set() } } },
      'schema.properties.value',
    ],
    [
      'nested class instance schema value',
      {
        kind: 'json_schema',
        schema: { type: 'object', properties: { value: new (class SchemaValue {})() } },
      },
      'schema.properties.value',
    ],
  ])('rejects malformed responseFormat: %s', (_name, responseFormat, pathSuffix) => {
    expectInvalidInputPath(
      {
        kind: 'user',
        content: [{ type: 'text', text: 'return a status object' }],
        responseFormat,
      },
      `responseFormat.${pathSuffix}`
    )
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

  test('rejects stale runtime overlays on start requests', () => {
    expectInvalidStartRequest(
      {
        spec: specSection19InvocationStartSpec,
        runtime: { tmux: { socketPath: '/tmp/stale-start-request.sock' } },
      },
      {
        path: 'runtime',
        code: 'stale_runtime_overlay',
      }
    )
  })

  test('rejects lifecycle overlays on start requests', () => {
    expectInvalidStartRequest(
      {
        spec: specSection19InvocationStartSpec,
        lifecyclePolicy: conservativeDefaultLifecyclePolicyOverlay('policy_start_request_stale'),
      },
      {
        path: 'lifecyclePolicy',
        code: 'stale_lifecycle_overlay',
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

  test('accepts an explicit conservative lifecycle overlay with a deterministic hash', () => {
    const lifecyclePolicy = conservativeDefaultLifecyclePolicyOverlay('policy_default')
    const request = {
      startRequest: { spec: specSection19InvocationStartSpec },
      lifecyclePolicy,
    }

    expect(validateInvocationDispatchRequest(request)).toEqual(request)
    expect(lifecyclePolicy.policyHash).toBe(lifecyclePolicyHash(lifecyclePolicy))
  })

  test('rejects lifecycle policy hash mismatches', () => {
    const lifecyclePolicy = {
      ...conservativeDefaultLifecyclePolicyOverlay('policy_bad_hash'),
      policyHash: 'not-the-canonical-hash',
    }

    expectInvalidDispatchRequest(
      {
        startRequest: { spec: specSection19InvocationStartSpec },
        lifecyclePolicy,
      },
      {
        path: 'lifecyclePolicy.policyHash',
        code: 'lifecycle_policy_hash_mismatch',
      }
    )
  })

  test('validates the lifecycle policyHash against the canonical lifecyclePolicyHash (inlined hasher)', () => {
    // Locks the de-abstracted validator: validateLifecyclePolicyOverlay now
    // hashes directly via lifecyclePolicyHash (no injectable seam). A correctly
    // normalized overlay must pass; flipping a single material field must trip
    // the canonical-hash mismatch with the unchanged digest.
    const accepted = conservativeDefaultLifecyclePolicyOverlay('policy_inlined_hash')
    const acceptRequest = {
      startRequest: { spec: specSection19InvocationStartSpec },
      lifecyclePolicy: accepted,
    }
    expect(validateInvocationDispatchRequest(acceptRequest)).toEqual(acceptRequest)
    expect(accepted.policyHash).toBe(lifecyclePolicyHash(accepted))

    // Same digest string, but material changed -> hash no longer canonical.
    const tampered = {
      ...accepted,
      turnRetry: {
        mode: 'safe-retry',
        maxAttempts: 1,
        retryOn: ['harness-crashed'],
        requires: {
          noToolCallObserved: true,
          noPermissionRequestPending: true,
          noAssistantFinalObserved: true,
          noExternalMutationObserved: true,
          continuationKnown: true,
          driverCanProvePriorTurnIncomplete: true,
        },
        identity: { inputId: 'same', logicalTurnId: 'same', turnAttempt: 'increment' },
        semantics: 'at-least-once',
        onUnsafe: 'fail-turn',
      },
    }
    expect(tampered.policyHash).not.toBe(lifecyclePolicyHash(tampered))
    expectInvalidDispatchRequest(
      {
        startRequest: { spec: specSection19InvocationStartSpec },
        lifecyclePolicy: tampered,
      },
      {
        path: 'lifecyclePolicy.policyHash',
        code: 'lifecycle_policy_hash_mismatch',
      }
    )
  })

  test('rejects lifecycle overlays patched into HarnessInvocationSpec', () => {
    const spec = {
      ...specSection19InvocationStartSpec,
      lifecyclePolicy: conservativeDefaultLifecyclePolicyOverlay('policy_spec_stale'),
    }

    expectInvalidDispatchRequest(
      {
        startRequest: { spec },
      },
      {
        path: 'startRequest.spec.lifecyclePolicy',
        code: 'stale_lifecycle_overlay',
      }
    )
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

  test('requires a runtime terminal surface or legacy tmux socket for claude-code-tmux dispatch requests', () => {
    expectInvalidDispatchRequest(
      {
        startRequest: { spec: claudeCodeTmuxSpec },
      },
      {
        path: 'runtime.terminalSurface',
        code: 'required',
      }
    )
  })

  test('accepts a legacy runtime.tmux.socketPath for claude-code-tmux dispatch (boundary shim)', () => {
    const request = {
      startRequest: {
        spec: claudeCodeTmuxSpec,
      },
      runtime: {
        tmux: {
          socketPath: '/tmp/preallocated/hrc-owned-tmux.sock',
        },
      },
    }

    expect(validateInvocationDispatchRequest(request)).toEqual(request)
  })

  const validTerminalSurface = {
    kind: 'tmux-pane' as const,
    ownership: 'hrc' as const,
    socketPath: '/tmp/preallocated/hrc-owned-tmux.sock',
    sessionId: '$3',
    windowId: '@7',
    paneId: '%12',
    sessionName: 'asp-claude',
    windowName: 'main',
    allowedOps: {
      inspect: true as const,
      sendInput: true as const,
      sendInterrupt: true as const,
      capture: true,
      resize: false,
    },
  }

  test('accepts a runtime terminalSurface pane lease for claude-code-tmux dispatch', () => {
    const request = {
      startRequest: { spec: claudeCodeTmuxSpec },
      runtime: { terminalSurface: validTerminalSurface },
    }
    expect(validateInvocationDispatchRequest(request)).toEqual(request)
  })

  test('accepts both legacy tmux.socketPath AND terminalSurface together (terminalSurface wins downstream)', () => {
    const request = {
      startRequest: { spec: claudeCodeTmuxSpec },
      runtime: {
        tmux: { socketPath: '/tmp/preallocated/hrc-owned-tmux.sock' },
        terminalSurface: validTerminalSurface,
      },
    }
    expect(validateInvocationDispatchRequest(request)).toEqual(request)
  })

  test('rejects terminalSurface with a malformed paneId', () => {
    const surface = structuredClone(validTerminalSurface) as typeof validTerminalSurface & {
      paneId: string
    }
    surface.paneId = 'pane-12' // missing leading %, not a tmux pane id
    expectInvalidDispatchRequest(
      {
        startRequest: { spec: claudeCodeTmuxSpec },
        runtime: { terminalSurface: surface },
      },
      {
        path: 'runtime.terminalSurface.paneId',
        code: 'invalid_tmux_id',
      }
    )
  })

  test('rejects terminalSurface missing paneId', () => {
    const surface = structuredClone(validTerminalSurface) as Partial<typeof validTerminalSurface>
    Reflect.deleteProperty(surface, 'paneId')
    expectInvalidDispatchRequest(
      {
        startRequest: { spec: claudeCodeTmuxSpec },
        runtime: { terminalSurface: surface },
      },
      {
        path: 'runtime.terminalSurface.paneId',
        code: 'required',
      }
    )
  })

  test('rejects terminalSurface with malformed sessionId / windowId', () => {
    const badSession = structuredClone(validTerminalSurface)
    badSession.sessionId = 'session-3'
    expectInvalidDispatchRequest(
      {
        startRequest: { spec: claudeCodeTmuxSpec },
        runtime: { terminalSurface: badSession },
      },
      {
        path: 'runtime.terminalSurface.sessionId',
        code: 'invalid_tmux_id',
      }
    )

    const badWindow = structuredClone(validTerminalSurface)
    badWindow.windowId = 'win-7'
    expectInvalidDispatchRequest(
      {
        startRequest: { spec: claudeCodeTmuxSpec },
        runtime: { terminalSurface: badWindow },
      },
      {
        path: 'runtime.terminalSurface.windowId',
        code: 'invalid_tmux_id',
      }
    )
  })

  test('rejects terminalSurface with wrong ownership or kind', () => {
    const badOwnership = structuredClone(validTerminalSurface) as typeof validTerminalSurface & {
      ownership: string
    }
    badOwnership.ownership = 'driver'
    expectInvalidDispatchRequest(
      {
        startRequest: { spec: claudeCodeTmuxSpec },
        runtime: { terminalSurface: badOwnership },
      },
      {
        path: 'runtime.terminalSurface.ownership',
        code: 'invalid_literal',
      }
    )

    const badKind = structuredClone(validTerminalSurface) as typeof validTerminalSurface & {
      kind: string
    }
    badKind.kind = 'tmux-session'
    expectInvalidDispatchRequest(
      {
        startRequest: { spec: claudeCodeTmuxSpec },
        runtime: { terminalSurface: badKind },
      },
      {
        path: 'runtime.terminalSurface.kind',
        code: 'invalid_literal',
      }
    )
  })

  test('rejects terminalSurface allowedOps without inspect/sendInput/sendInterrupt = true', () => {
    const surface = structuredClone(validTerminalSurface) as typeof validTerminalSurface & {
      allowedOps: Record<string, unknown>
    }
    surface.allowedOps = {
      inspect: false,
      sendInput: true,
      sendInterrupt: true,
    }
    expectInvalidDispatchRequest(
      {
        startRequest: { spec: claudeCodeTmuxSpec },
        runtime: { terminalSurface: surface },
      },
      {
        path: 'runtime.terminalSurface.allowedOps.inspect',
        code: 'invalid_literal',
      }
    )
  })

  test('rejects stale runtime overlays nested inside dispatch startRequest', () => {
    expectInvalidDispatchRequest(
      {
        startRequest: {
          spec: claudeCodeTmuxSpec,
          runtime: {
            tmux: {
              socketPath: '/tmp/stale-start-request.sock',
            },
          },
        },
      },
      {
        path: 'startRequest.runtime',
        code: 'stale_runtime_overlay',
      }
    )
  })

  test('rejects stale lifecycle overlays nested inside dispatch startRequest', () => {
    expectInvalidDispatchRequest(
      {
        startRequest: {
          spec: specSection19InvocationStartSpec,
          lifecyclePolicy: conservativeDefaultLifecyclePolicyOverlay('policy_nested_stale'),
        },
      },
      {
        path: 'startRequest.lifecyclePolicy',
        code: 'stale_lifecycle_overlay',
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
    expectInvalidCommand(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'invocation.events',
        params: { invocationId: 'inv_1' },
      },
      { path: 'method', code: 'unknown_method' }
    )
  })

  test.each([
    [
      'broker.attach',
      {
        runtimeId: 'runtime_1',
        hostSessionId: 'host_session_1',
        generation: 2,
        invocationId: 'inv_1',
        startRequestHash: 'start_hash_1',
        selectedProfileHash: 'profile_hash_1',
        controllerInstanceId: 'hrc_server_1',
        attachToken: 'secret-token',
        lastProjectedSeq: 12,
        clientCapabilities: { permissionRequests: true, eventAcks: true },
      },
      {
        runtimeId: 'runtime_1',
        hostSessionId: 'host_session_1',
        generation: 2,
        invocationId: 'inv_1',
        startRequestHash: 'start_hash_1',
        selectedProfileHash: 'profile_hash_1',
        controllerInstanceId: 'hrc_server_1',
      },
      { path: 'params.attachToken', code: 'required' },
    ],
    [
      'invocation.eventsSince',
      {
        invocationId: 'inv_1',
        afterSeq: 12,
        live: true,
        // T-01850/T-01845 §10 corrected target: event filters are accepted,
        // but responses keep currentSeq/retentionFloorSeq and do not add limit.
        types: ['invocation.ready', 'turn.completed'],
      },
      { invocationId: 'inv_1', afterSeq: 12, types: ['not.a.real.event'] },
      { path: 'params.types.0', code: 'invalid_event_type' },
    ],
    [
      'invocation.ackEvents',
      { invocationId: 'inv_1', throughSeq: 12, controllerInstanceId: 'hrc_server_1' },
      { invocationId: 'inv_1', throughSeq: 12 },
      { path: 'params.controllerInstanceId', code: 'required' },
    ],
    [
      'invocation.snapshot',
      { invocationId: 'inv_1', probeLiveness: true },
      { invocationId: 'inv_1', probeLiveness: 'yes' },
      { path: 'params.probeLiveness', code: 'invalid_type' },
    ],
    [
      'broker.listInvocations',
      { includeDisposed: true, probeLiveness: true },
      { includeDisposed: 'yes', probeLiveness: true },
      { path: 'params.includeDisposed', code: 'invalid_type' },
    ],
    [
      'invocation.permission.respond',
      {
        invocationId: 'inv_1',
        permissionRequestId: 'perm_1',
        decision: 'allow',
        controllerInstanceId: 'hrc_server_1',
      },
      { invocationId: 'inv_1', permissionRequestId: 'perm_1', decision: 'prompt' },
      { path: 'params.decision', code: 'invalid_literal' },
    ],
  ])(
    'validates v2 method %s params and rejects malformed params',
    (method, validParams, malformedParams, expectedIssue) => {
      // T-01791 Phase A: HRC restart durability depends on these v2 IPC commands
      // being accepted by schema validation before broker/client behavior exists.
      const command = { jsonrpc: '2.0', id: 1, method, params: validParams }
      expect(validateCommand(command)).toEqual(command)

      expectInvalidCommand(
        { jsonrpc: '2.0', id: 2, method, params: malformedParams },
        expectedIssue
      )
    }
  )

  test('invocation.status accepts an optional bounded liveness probe flag', () => {
    // T-01850: status uses the same cached-by-default inspection surface as
    // snapshot/list, with probeLiveness requesting a bounded active probe.
    const command = {
      jsonrpc: '2.0',
      id: 1,
      method: 'invocation.status',
      params: { invocationId: 'inv_1', probeLiveness: true },
    }
    expect(validateCommand(command)).toEqual(command)

    expectInvalidCommand(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'invocation.status',
        params: { invocationId: 'inv_1', probeLiveness: 'yes' },
      },
      { path: 'params.probeLiveness', code: 'invalid_type' }
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
  const providerTranscriptConstants = protocol as Record<string, unknown>
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
    'tool.call.failed': {
      toolCallId: 'tool_1',
      name: 'read',
      message: 'failed',
      code: 'codex_failed',
    },
    'usage.updated': { usage: { inputTokens: 1 } },
    diagnostic: { level: 'info', message: 'notice' },
    'driver.notice': { message: 'notice' },
    'terminal.surface.reported': {
      kind: 'tmux-session',
      socketPath: '/tmp/tmux-501/default',
      sessionName: 'asp-claude',
      paneId: '%1',
    },
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

  test('accepts terminal.surface.reported with kind:tmux-pane and full tmux ids', () => {
    const env = envelope('terminal.surface.reported', {
      kind: 'tmux-pane',
      socketPath: '/tmp/tmux-501/default',
      sessionId: '$3',
      windowId: '@7',
      paneId: '%12',
      sessionName: 'asp-claude',
      windowName: 'main',
    })
    expect(validateEventEnvelope(env)).toEqual(env)
  })

  test('accepts provider transcript reported with protocol-owned constants', () => {
    expect(providerTranscriptConstants['PROVIDER_TRANSCRIPT_REPORTED_EVENT_TYPE']).toBe(
      'provider.transcript.reported'
    )
    expect(providerTranscriptConstants['PROVIDER_TRANSCRIPT_ARTIFACT_KIND']).toBe(
      'provider-transcript-jsonl'
    )
    expect(providerTranscriptConstants['PROVIDER_TRANSCRIPT_STORAGE']).toBe('file-path')
    expect(providerTranscriptConstants['PROVIDER_TRANSCRIPT_MEDIA_TYPE']).toBe(
      'application/x-ndjson'
    )
    expect(providerTranscriptConstants['PROVIDER_TRANSCRIPT_SCHEMA']).toBe(
      'harness-broker.provider-transcript.codex-jsonrpc-notification-jsonl/v1'
    )

    const env = envelope(
      providerTranscriptConstants['PROVIDER_TRANSCRIPT_REPORTED_EVENT_TYPE'] as string,
      {
        kind: providerTranscriptConstants['PROVIDER_TRANSCRIPT_ARTIFACT_KIND'],
        artifactPath: '/tmp/provider-transcript.jsonl',
        provider: 'codex',
        harnessGeneration: 1,
      }
    )
    expect(validateEventEnvelope(env)).toEqual(env)
  })

  test('rejects provider transcript reported without an absolute string artifactPath', () => {
    const basePayload = {
      kind: 'provider-transcript-jsonl',
      artifactPath: '/tmp/provider-transcript.jsonl',
      provider: 'codex',
    }
    const eventType = 'provider.transcript.reported'

    // missing artifactPath -> required (build the payload WITHOUT the field;
    // spreading basePayload would keep a valid artifactPath and never trigger `required`)
    const payloadMissingArtifactPath = {
      kind: basePayload.kind,
      provider: basePayload.provider,
    }
    expectInvalidEventEnvelope(envelope(eventType, payloadMissingArtifactPath), {
      path: 'payload.artifactPath',
      code: 'required',
    })

    // present but invalid artifactPath -> invalid_type / invalid_path
    for (const { artifactPath, code } of [
      { artifactPath: 42, code: 'invalid_type' },
      { artifactPath: 'relative/provider-transcript.jsonl', code: 'invalid_path' },
    ]) {
      expectInvalidEventEnvelope(envelope(eventType, { ...basePayload, artifactPath }), {
        path: 'payload.artifactPath',
        code,
      })
    }
  })

  test('rejects terminal.surface.reported tmux-pane with malformed paneId', () => {
    expectInvalidEventEnvelope(
      envelope('terminal.surface.reported', {
        kind: 'tmux-pane',
        socketPath: '/tmp/tmux-501/default',
        sessionId: '$3',
        windowId: '@7',
        paneId: 'pane-12',
      }),
      {
        path: 'payload.paneId',
        code: 'invalid_tmux_id',
      }
    )
  })

  test('rejects terminal.surface.reported tmux-pane missing windowId', () => {
    expectInvalidEventEnvelope(
      envelope('terminal.surface.reported', {
        kind: 'tmux-pane',
        socketPath: '/tmp/tmux-501/default',
        sessionId: '$3',
        paneId: '%12',
      }),
      {
        path: 'payload.windowId',
        code: 'required',
      }
    )
  })

  test('requires terminal.surface.reported kind:tmux-pane when driver is claude-code-tmux', () => {
    const env = {
      invocationId: 'inv_1',
      seq: 1,
      time: '2026-05-28T00:00:00.000Z',
      type: 'terminal.surface.reported',
      payload: {
        kind: 'tmux-session',
        socketPath: '/tmp/tmux-501/default',
        sessionName: 'asp-claude',
        paneId: '%12',
      },
      driver: { kind: 'claude-code-tmux' },
    }
    expectInvalidEventEnvelope(env, {
      path: 'payload.kind',
      code: 'invalid_literal',
    })
  })

  test('requires terminal.surface.reported kind:tmux-pane when driver is codex-cli-tmux', () => {
    const env = {
      invocationId: 'inv_1',
      seq: 1,
      time: '2026-05-28T00:00:00.000Z',
      type: 'terminal.surface.reported',
      payload: {
        kind: 'tmux-session',
        socketPath: '/tmp/tmux-501/default',
        sessionName: 'asp-codex',
      },
      driver: { kind: 'codex-cli-tmux' },
    }
    expectInvalidEventEnvelope(env, {
      path: 'payload.kind',
      code: 'invalid_literal',
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

  // Terminal-outcome contract (T-06550): the tool.call.* payloads are the
  // normative carrier. tool.call.failed REQUIRES both message and an
  // always-populated machine-readable code; tool.call.started/completed require
  // toolCallId + name.
  test('tool.call.failed requires message AND an always-populated code', () => {
    expectInvalidEventEnvelope(
      envelope('tool.call.failed', { toolCallId: 'tool_1', name: 'read', code: 'x' }),
      { path: 'payload.message', code: 'required' }
    )
    expectInvalidEventEnvelope(
      envelope('tool.call.failed', { toolCallId: 'tool_1', name: 'read', message: 'boom' }),
      { path: 'payload.code', code: 'required' }
    )
    const valid = envelope('tool.call.failed', {
      toolCallId: 'tool_1',
      name: 'read',
      message: 'boom',
      code: 'codex_mcp_error',
    })
    expect(validateEventEnvelope(valid)).toEqual(valid)
  })

  test('tool.call.started and tool.call.completed require toolCallId and name', () => {
    expectInvalidEventEnvelope(envelope('tool.call.started', { name: 'read' }), {
      path: 'payload.toolCallId',
      code: 'required',
    })
    expectInvalidEventEnvelope(envelope('tool.call.completed', { toolCallId: 'tool_1' }), {
      path: 'payload.name',
      code: 'required',
    })
  })

  test('validates lifecycle event payloads and generation fences', () => {
    const policy = conservativeDefaultLifecyclePolicyOverlay('policy_event')
    expect(
      validateEventEnvelope({
        invocationId: 'inv_1',
        seq: 1,
        time: '2026-05-24T00:00:00.000Z',
        type: 'lifecycle.policy.accepted',
        payload: {
          policyId: policy.policyId,
          policyHash: policy.policyHash,
          retentionMode: 'keep-alive',
          harnessRecoveryMode: 'none',
          turnRetryMode: 'none',
        },
      })
    ).toMatchObject({ type: 'lifecycle.policy.accepted' })

    expect(
      validateEventEnvelope({
        invocationId: 'inv_1',
        seq: 2,
        time: '2026-05-24T00:00:00.000Z',
        type: 'permission.cancelled',
        harnessGeneration: 1,
        turnAttempt: 1,
        payload: {
          permissionRequestId: 'perm_1',
          reason: 'harness-generation-ended',
          harnessGeneration: 1,
          turnAttempt: 1,
        },
      })
    ).toMatchObject({ type: 'permission.cancelled', harnessGeneration: 1, turnAttempt: 1 })

    expectInvalidEventEnvelope(
      {
        invocationId: 'inv_1',
        seq: 3,
        time: '2026-05-24T00:00:00.000Z',
        type: 'harness.started',
        harnessGeneration: 0,
        payload: {
          generation: 1,
          mode: 'initial',
          mechanism: 'direct-child',
        },
      },
      {
        path: 'harnessGeneration',
        code: 'invalid_positive_integer',
      }
    )
  })
})

describe('package boundaries', () => {
  test('protocol source does not import spaces-runtime-contracts', () => {
    const sourceRoot = join(import.meta.dir, '..', 'src')
    for (const file of [
      'capabilities.ts',
      'commands.ts',
      'events.ts',
      'index.ts',
      'lifecycle.ts',
      'schemas.ts',
    ]) {
      expect(readFileSync(join(sourceRoot, file), 'utf8')).not.toContain('spaces-runtime-contracts')
    }
  })
})
