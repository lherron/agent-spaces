/**
 * T-08563 revision 5 behavior reds for the additive ASPC observation wire.
 *
 * Namespace lookup is deliberate: all tests collect at the pre-implementation
 * baseline and fail as assertions rather than missing-export load errors.
 */
import { describe, expect, test } from 'bun:test'
import * as Protocol from '../src/index.js'

const OBSERVATION_METHODS = [
  'aspc.resolveRuntimeDeclaration',
  'aspc.inspectRuntimePlacement',
  'aspc.observeRuntimeCapability',
  'aspc.observeContinuationArtifact',
] as const

const CONTEXT = {
  agentId: 'smokey',
  agentRoot: '/agents/smokey',
  project: { mode: 'root', projectRoot: '/projects/agent-spaces', projectId: 'agent-spaces' },
  cwd: '/projects/agent-spaces',
  runMode: 'task',
  agentSources: { aspHome: '/asp', agentsRoot: '/agents' },
}

const VALID_REQUESTS: Record<(typeof OBSERVATION_METHODS)[number], Record<string, unknown>> = {
  'aspc.resolveRuntimeDeclaration': {
    schemaVersion: 'aspc-resolve-runtime-declaration-request/v1',
    context: CONTEXT,
  },
  'aspc.inspectRuntimePlacement': {
    schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
    context: CONTEXT,
    dispatchEnv: { ASP_RUN_ID: 'run-red' },
  },
  'aspc.observeRuntimeCapability': {
    schemaVersion: 'aspc-observe-runtime-capability-request/v1',
    harness: 'codex',
    context: CONTEXT,
  },
  'aspc.observeContinuationArtifact': {
    schemaVersion: 'aspc-observe-continuation-artifact-request/v1',
    continuation: { provider: 'codex', key: 'thread-red', artifactFormat: 'codex' },
  },
}

describe('T-08563 ASPC observation protocol', () => {
  test('positive control: existing hello still validates at aspc/0.1', () => {
    const command = Protocol.validateAspcCommand({
      jsonrpc: '2.0',
      id: 1,
      method: 'aspc.hello',
      params: {
        clientInfo: { name: 'runtime-observation-red' },
        protocolVersions: ['aspc/0.1'],
      },
    })
    expect(command.method).toBe('aspc.hello')
    expect(Protocol.ASPC_PROTOCOL_VERSION).toBe('aspc/0.1')
  })

  test('admits all four additive JSON-RPC methods', () => {
    expect(Protocol.ASPC_METHODS).toEqual(expect.arrayContaining(OBSERVATION_METHODS))
    for (const method of OBSERVATION_METHODS) {
      const command = Protocol.validateAspcCommand({
        jsonrpc: '2.0',
        id: method,
        method,
        params: VALID_REQUESTS[method],
      })
      expect(command.method).toBe(method)
    }
  })

  test('exports validators requiring the exact request /v1 discriminators', () => {
    const validators = [
      [
        'validateAspcResolveRuntimeDeclarationRequest',
        'aspc-resolve-runtime-declaration-request/v1',
      ],
      ['validateAspcInspectRuntimePlacementRequest', 'aspc-inspect-runtime-placement-request/v1'],
      ['validateAspcObserveRuntimeCapabilityRequest', 'aspc-observe-runtime-capability-request/v1'],
      [
        'validateAspcObserveContinuationArtifactRequest',
        'aspc-observe-continuation-artifact-request/v1',
      ],
    ] as const

    for (const [name, version] of validators) {
      const validator = requiredValidator(name)
      const method = OBSERVATION_METHODS.find(
        (candidate) => VALID_REQUESTS[candidate].schemaVersion === version
      )
      expect(method).toBeDefined()
      const valid = VALID_REQUESTS[method as (typeof OBSERVATION_METHODS)[number]]
      expect(() => validator(valid)).not.toThrow()
      expect(() => validator({ ...valid, schemaVersion: version.replace('/v1', '/v2') })).toThrow()
    }
  })

  test('publishes exact response discriminators and preserves distinct failure domains', () => {
    const expected = {
      ASPC_RESOLVE_RUNTIME_DECLARATION_RESPONSE_VERSION:
        'aspc-resolve-runtime-declaration-response/v1',
      ASPC_INSPECT_RUNTIME_PLACEMENT_RESPONSE_VERSION: 'aspc-inspect-runtime-placement-response/v1',
      ASPC_OBSERVE_RUNTIME_CAPABILITY_RESPONSE_VERSION:
        'aspc-observe-runtime-capability-response/v1',
      ASPC_OBSERVE_CONTINUATION_ARTIFACT_RESPONSE_VERSION:
        'aspc-observe-continuation-artifact-response/v1',
    }
    const exports = Protocol as Record<string, unknown>
    for (const [name, value] of Object.entries(expected)) expect(exports[name]).toBe(value)

    const declarationAbsent = {
      ok: false,
      resolution: { state: 'absent', code: 'agent_not_found' },
    }
    const serviceUnavailable = {
      ok: false,
      failure: { kind: 'unavailable', code: 'source_read_unavailable' },
    }
    expect(declarationAbsent).toHaveProperty('resolution.state', 'absent')
    expect(declarationAbsent).not.toHaveProperty('failure')
    expect(serviceUnavailable).toHaveProperty('failure.kind', 'unavailable')
    expect(serviceUnavailable).not.toHaveProperty('resolution')
  })
})

function requiredValidator(name: string): (value: unknown) => unknown {
  const value = (Protocol as Record<string, unknown>)[name]
  expect(value, `${name} must be exported from spaces-aspc-protocol`).toBeFunction()
  return value as (input: unknown) => unknown
}
