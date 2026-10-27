/** T-08563 revision 5 behavior for the additive ASPC observation wire. */
import { describe, expect, test } from 'bun:test'
import {
  validateAspcCommand,
  validateAspcInspectRuntimePlacementRequest,
  validateAspcObserveContinuationArtifactRequest,
  validateAspcObserveRuntimeCapabilityRequest,
  validateAspcResolveRuntimeDeclarationRequest,
} from '../src/index.js'

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

const DIRECT_VALIDATORS: Record<(typeof OBSERVATION_METHODS)[number], (value: unknown) => unknown> =
  {
    'aspc.resolveRuntimeDeclaration': validateAspcResolveRuntimeDeclarationRequest,
    'aspc.inspectRuntimePlacement': validateAspcInspectRuntimePlacementRequest,
    'aspc.observeRuntimeCapability': validateAspcObserveRuntimeCapabilityRequest,
    'aspc.observeContinuationArtifact': validateAspcObserveContinuationArtifactRequest,
  }

describe('T-08563 ASPC observation protocol', () => {
  test.each([...OBSERVATION_METHODS])(
    'exports validators requiring the exact request /v1 discriminators: %s',
    (method) => {
      const valid = VALID_REQUESTS[method]
      const validate = DIRECT_VALIDATORS[method]
      expect(() => validate(valid)).not.toThrow()
      expect(
        validateAspcCommand({ jsonrpc: '2.0', id: method, method, params: valid })
      ).toMatchObject({ method })

      const version = valid['schemaVersion'] as string
      expect(version.endsWith('/v1')).toBe(true)
      let issues: Array<{ path: string }> | undefined
      try {
        validate({ ...valid, schemaVersion: version.replace('/v1', '/v2') })
      } catch (error) {
        issues = (error as { issues?: Array<{ path: string }> }).issues
      }
      expect(issues?.map((issue) => issue.path)).toEqual(['params.schemaVersion'])
    }
  )
})
