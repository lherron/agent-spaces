import { describe, expect, test } from 'bun:test'
import type {
  BrokerCommand,
  InvocationDispatchRequest,
  PermissionRequestParams,
} from '../src/commands'
import { conservativeDefaultLifecyclePolicyOverlay, lifecyclePolicyHash } from '../src/lifecycle'
import type { BrokerLifecyclePolicyOverlay } from '../src/lifecycle'
import {
  validateCommand,
  validateInvocationDispatchRequest,
  validatePermissionRequestParams,
} from '../src/schemas'
import { inputIdFrom, invocationIdFrom, permissionRequestIdFrom, turnIdFrom } from './ids'
import {
  claudeCodeTmuxSpec,
  expectInvalidCommand,
  expectInvalidDispatchRequest,
  expectInvalidPermissionRequestParams,
  specSection19InvocationStartSpec,
  withValueAt,
} from './schema-test-helpers'

describe('validateInvocationDispatchRequest', () => {
  test('accepts a dispatch envelope with a verbatim start request and dispatchEnv', () => {
    const request: InvocationDispatchRequest = {
      startRequest: {
        spec: specSection19InvocationStartSpec,
        initialInput: {
          inputId: inputIdFrom('input_1'),
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
    const tampered: BrokerLifecyclePolicyOverlay = {
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
    const badOwnership = withValueAt(validTerminalSurface, ['ownership'], 'driver')
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

    const badKind = withValueAt(validTerminalSurface, ['kind'], 'tmux-session')
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
    const surface = withValueAt(validTerminalSurface, ['allowedOps'], {
      inspect: false,
      sendInput: true,
      sendInterrupt: true,
    })
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
    const command: BrokerCommand = {
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
      // `method` is a test.each row value, so the command is untyped wire input;
      // compare the validated result as plain data.
      const command = { jsonrpc: '2.0', id: 1, method, params: validParams }
      const validated: unknown = validateCommand(command)
      expect(validated).toEqual(command)

      expectInvalidCommand(
        { jsonrpc: '2.0', id: 2, method, params: malformedParams },
        expectedIssue
      )
    }
  )

  test('invocation.status accepts an optional bounded liveness probe flag', () => {
    // T-01850: status uses the same cached-by-default inspection surface as
    // snapshot/list, with probeLiveness requesting a bounded active probe.
    const command: BrokerCommand = {
      jsonrpc: '2.0',
      id: 1,
      method: 'invocation.status',
      params: { invocationId: invocationIdFrom('inv_1'), probeLiveness: true },
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
    const params: PermissionRequestParams = {
      invocationId: invocationIdFrom('inv_1'),
      turnId: turnIdFrom('turn_1'),
      permissionRequestId: permissionRequestIdFrom('perm_1'),
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
