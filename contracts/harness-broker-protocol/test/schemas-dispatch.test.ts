import { describe, expect, test } from 'bun:test'
import type { PermissionRequestParams } from '../src/commands'
import type { BrokerCommand } from '../src/commands'
import { conservativeDefaultLifecyclePolicyOverlay, lifecyclePolicyHash } from '../src/lifecycle'
import type { BrokerLifecyclePolicyOverlay } from '../src/lifecycle'
import { validatePermissionRequestParams } from '../src/schemas'
import { validateCommand } from '../src/schemas'
import { invocationIdFrom, permissionRequestIdFrom, turnIdFrom } from './ids'
import { inputIdFrom } from './ids'

import {
  claudeCodeTmuxSpec,
  dispatchCommand,
  expectInvalidCommand,
  expectInvalidDispatchRequest,
  expectValidCommand,
  specSection19InvocationStartSpec,
  withValueAt,
  withoutKeyAt,
} from './schema-test-helpers'

// Dispatch envelopes ride in `invocation.start` params and are validated by
// `validateCommand`, the registry the broker runs before each JSON-RPC handler;
// issue paths below are relative to `params.`.
describe('invocation.start dispatch envelope validation', () => {
  test('accepts an explicit conservative lifecycle overlay with a deterministic hash', () => {
    const lifecyclePolicy = conservativeDefaultLifecyclePolicyOverlay('policy_default')

    expectValidCommand(
      dispatchCommand({ startRequest: { spec: specSection19InvocationStartSpec }, lifecyclePolicy })
    )
    expect(lifecyclePolicy.policyHash).toBe(lifecyclePolicyHash(lifecyclePolicy))
  })

  test('rejects lifecycle policy hash mismatches', () => {
    const badHash = {
      ...conservativeDefaultLifecyclePolicyOverlay('policy_bad_hash'),
      policyHash: 'not-the-canonical-hash',
    }

    // Same digest string, but material changed -> hash no longer canonical, so
    // the hash covers the policy material, not just its own field.
    const accepted = conservativeDefaultLifecyclePolicyOverlay('policy_inlined_hash')
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

    for (const lifecyclePolicy of [badHash, tampered]) {
      expectInvalidDispatchRequest(
        { startRequest: { spec: specSection19InvocationStartSpec }, lifecyclePolicy },
        { path: 'lifecyclePolicy.policyHash', code: 'lifecycle_policy_hash_mismatch' }
      )
    }
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

    expectValidCommand(dispatchCommand(request))
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
    expectValidCommand(dispatchCommand(request))
  })

  test.each([
    {
      case: 'paneId missing %',
      surface: withValueAt(validTerminalSurface, ['paneId'], 'pane-12'),
      path: 'paneId',
      code: 'invalid_tmux_id',
    },
    {
      case: 'paneId absent',
      surface: withoutKeyAt(validTerminalSurface, ['paneId']),
      path: 'paneId',
      code: 'required',
    },
    {
      case: 'sessionId missing $',
      surface: withValueAt(validTerminalSurface, ['sessionId'], 'session-3'),
      path: 'sessionId',
      code: 'invalid_tmux_id',
    },
    {
      case: 'windowId missing @',
      surface: withValueAt(validTerminalSurface, ['windowId'], 'win-7'),
      path: 'windowId',
      code: 'invalid_tmux_id',
    },
    {
      case: 'ownership not hrc',
      surface: withValueAt(validTerminalSurface, ['ownership'], 'driver'),
      path: 'ownership',
      code: 'invalid_literal',
    },
    {
      case: 'kind not tmux-pane',
      surface: withValueAt(validTerminalSurface, ['kind'], 'tmux-session'),
      path: 'kind',
      code: 'invalid_literal',
    },
    {
      case: 'allowedOps.inspect false',
      surface: withValueAt(validTerminalSurface, ['allowedOps'], {
        inspect: false,
        sendInput: true,
        sendInterrupt: true,
      }),
      path: 'allowedOps.inspect',
      code: 'invalid_literal',
    },
  ])(
    'a malformed runtime terminalSurface is refused with the offending field and code: $case',
    ({ surface, path, code }) => {
      expectInvalidDispatchRequest(
        { startRequest: { spec: claudeCodeTmuxSpec }, runtime: { terminalSurface: surface } },
        { path: `runtime.terminalSurface.${path}`, code }
      )
    }
  )

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
          initialInput: {
            inputId: inputIdFrom('input_1'),
            kind: 'user',
            content: [{ type: 'text', text: 'hello' }],
          },
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
      'invocation.status',
      { invocationId: 'inv_1', probeLiveness: true },
      { invocationId: 'inv_1', probeLiveness: 'yes' },
      { path: 'params.probeLiveness', code: 'invalid_type' },
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
})

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

describe('published caller behavior (§9)', () => {
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
})

describe('hrcpty terminal lease', () => {
  const spec = {
    ...claudeCodeTmuxSpec,
    harness: { ...claudeCodeTmuxSpec.harness, driver: 'claude-code-hrcpty' },
    driver: { kind: 'claude-code-hrcpty', terminalHost: 'hrcpty' },
  }
  const surface = {
    kind: 'hrcpty',
    socketPath: '/tmp/hrcpty.sock',
    ownership: 'hrc',
    allowedOps: {
      inspect: true,
      sendInput: true,
      sendInterrupt: true,
      capture: true,
      resize: false,
      spawn: true,
    },
  }
  test('accepts an hrcpty socket lease without tmux coordinates', () => {
    expectValidCommand(
      dispatchCommand({ startRequest: { spec }, runtime: { terminalSurface: surface } })
    )
  })
  test('requires a supervisor lease and spawn capability', () => {
    expectInvalidDispatchRequest(
      { startRequest: { spec } },
      { path: 'runtime.terminalSurface', code: 'required' }
    )
    expectInvalidDispatchRequest(
      { startRequest: { spec }, runtime: { tmux: { socketPath: '/tmp/tmux.sock' } } },
      { path: 'runtime.terminalSurface', code: 'required' }
    )
    expectInvalidDispatchRequest(
      {
        startRequest: { spec },
        runtime: {
          terminalSurface: { ...surface, allowedOps: { ...surface.allowedOps, spawn: false } },
        },
      },
      { path: 'runtime.terminalSurface.allowedOps.spawn', code: 'invalid_literal' }
    )
  })
  test('rejects a tmux lease on the supervisor driver', () => {
    expectInvalidDispatchRequest(
      {
        startRequest: { spec },
        runtime: {
          terminalSurface: {
            ...surface,
            kind: 'tmux-pane',
            sessionId: '$1',
            windowId: '@1',
            paneId: '%1',
          },
        },
      },
      { path: 'runtime.terminalSurface.kind', code: 'invalid_literal' }
    )
  })
})
