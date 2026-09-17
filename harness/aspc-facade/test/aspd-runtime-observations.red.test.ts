/** T-08563 rev 5 real Unix JSON-RPC routing reds for standalone aspd. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AspcInspectionAuthorityError, type AspcService, createAspcService } from 'spaces-aspc'
import { UnixSocketTransport } from 'spaces-harness-broker-client'
import type { AspReleaseIdentity } from 'spaces-harness-broker-protocol'
import { type AspdServer, createReleaseBoundAspcService, startAspdServer } from '../src/aspd.js'

const IDENTITY: AspReleaseIdentity = {
  releaseId: 'asp-runtime-observation-red',
  sourceCommit: '90dd75083a32a78f07c8dc2358175db799e94475',
  builtAt: '2026-09-17T04:00:00.000Z',
}
const RELEASE_BINDING = {
  identity: IDENTITY,
  releaseRoot: '/releases/asp-runtime-observation-red',
  workers: {
    'codex-app-server': {
      executable: '/releases/asp-runtime-observation-red/harness-broker',
      hostedDrivers: ['claude-code-tmux', 'codex-app-server', 'pi-tui-tmux'],
    },
  },
  claudeStatuslineSource: {
    path: '/releases/asp-runtime-observation-red/libexec/claude-statusline.cjs',
    sha256: 'runtime-observation-test',
    required: true as const,
  },
}
const CONTEXT = {
  agentId: 'smokey',
  agentRoot: '/agents/smokey',
  project: { mode: 'none' },
  cwd: '/projects/agent-spaces',
  runMode: 'task',
}
const AUTHORITY_ERRORS = [
  ['AGENT_INSPECTION_PRODUCER_UNAVAILABLE', 503],
  ['AGENT_INSPECTION_PROJECT_NOT_FOUND', 404],
  ['AGENT_INSPECTION_AGENT_NOT_FOUND', 404],
  ['INVALID_AGENT_INSPECTION_SELECTION', 400],
  ['AGENT_INSPECTION_PRODUCER_FAILURE', 502],
] as const

let base = ''
let server: AspdServer | undefined
let transport: UnixSocketTransport | undefined
let calls: string[] = []

beforeEach(async () => {
  base = await mkdtemp('/tmp/aspd-observation-red-')
  calls = []
  const service = createReleaseBoundAspcService(
    fakeObservationService() as AspcService,
    RELEASE_BINDING
  )
  server = await startAspdServer({ socketPath: join(base, 'a.sock'), service, log: () => {} })
  transport = await UnixSocketTransport.connect({ socketPath: join(base, 'a.sock') })
})

afterEach(async () => {
  await transport?.close()
  await server?.retire()
  await rm(base, { recursive: true, force: true })
  transport = undefined
  server = undefined
})

describe('T-08563 standalone aspd runtime observations', () => {
  test('positive control: hello is served by the release-bound Unix daemon', async () => {
    const hello = await request('aspc.hello', {
      clientInfo: { name: 'aspd-runtime-observation-red' },
      protocolVersions: ['aspc/0.1'],
    })
    expect(hello.protocolVersion).toBe('aspc/0.1')
    expect(hello.release).toEqual(IDENTITY)
    expect(hello.capabilities.transports).toEqual(['unix-jsonrpc-ndjson'])
  })

  test('serves resolveRuntimeDeclaration and preserves declaration absence', async () => {
    const response = await request('aspc.resolveRuntimeDeclaration', {
      schemaVersion: 'aspc-resolve-runtime-declaration-request/v1',
      context: { ...CONTEXT, agentId: 'absent' },
    })
    expect(response).toMatchObject({
      schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
      ok: false,
      resolution: { state: 'absent', code: 'agent_not_found' },
    })
    expect(response).not.toHaveProperty('failure')
    expect(calls).toContain('resolveRuntimeDeclaration')
  })

  test('serves inspectRuntimePlacement without collapsing prompt failure', async () => {
    const response = await request('aspc.inspectRuntimePlacement', {
      schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
      context: CONTEXT,
    })
    expect(response).toMatchObject({
      schemaVersion: 'aspc-inspect-runtime-placement-response/v1',
      ok: true,
      prompt: { state: 'invalid', code: 'prompt_resolution_failed' },
      inspection: { completeness: { kind: 'partial' } },
    })
    expect(calls).toContain('inspectRuntimePlacement')
  })

  test('serves observeRuntimeCapability as a read-only fact response', async () => {
    const response = await request('aspc.observeRuntimeCapability', {
      schemaVersion: 'aspc-observe-runtime-capability-request/v1',
      harness: 'codex',
      context: CONTEXT,
    })
    expect(response).toMatchObject({
      schemaVersion: 'aspc-observe-runtime-capability-response/v1',
      ok: true,
      nativeRuntime: { state: 'unknown', code: 'detection_failed' },
      preparation: { state: 'unknown', code: 'preparation_unknown' },
    })
    expect(calls).toContain('observeRuntimeCapability')
  })

  test('serves observeContinuationArtifact without materialization or preparation', async () => {
    const response = await request('aspc.observeContinuationArtifact', {
      schemaVersion: 'aspc-observe-continuation-artifact-request/v1',
      continuation: { provider: 'openai', key: 'ambiguous' },
    })
    expect(response).toMatchObject({
      schemaVersion: 'aspc-observe-continuation-artifact-response/v1',
      ok: true,
      artifactFormat: 'unknown',
      artifact: { state: 'unknown', code: 'artifact_format_ambiguous' },
      basis: 'none',
    })
    expect(calls).toContain('observeContinuationArtifact')
  })

  test('hello advertises all four observations on the same release identity', async () => {
    const hello = await request('aspc.hello', {
      clientInfo: { name: 'capability-red' },
      protocolVersions: ['aspc/0.1'],
    })
    expect(hello.capabilities).toMatchObject({
      resolveRuntimeDeclaration: true,
      inspectRuntimePlacement: true,
      observeRuntimeCapability: true,
      observeContinuationArtifact: true,
    })
    expect(hello.release.releaseId).toBe(IDENTITY.releaseId)
  })

  test('routes an actual producer response rather than only an injected observation double', async () => {
    const actualRoot = join(base, 'actual')
    const actualAgents = join(actualRoot, 'agents')
    const actualAgent = join(actualAgents, 'smokey')
    await mkdir(actualAgent, { recursive: true })
    await writeFile(
      join(actualAgent, 'agent-profile.toml'),
      'version = 3\n[identity]\nrole = "actual-producer"\n[provisioning]\nharness = "claude"\n'
    )
    const actualService = createReleaseBoundAspcService(
      createAspcService({
        agentsRoot: actualAgents,
        environment: { ASP_AGENTS_ROOT: actualAgents, HOME: actualRoot },
      }),
      RELEASE_BINDING
    )
    const actualServer = await startAspdServer({
      socketPath: join(base, 'actual.sock'),
      service: actualService,
      log: () => {},
    })
    const actualTransport = await UnixSocketTransport.connect({
      socketPath: join(base, 'actual.sock'),
    })
    try {
      const response = await actualTransport.request('aspc.resolveRuntimeDeclaration', {
        schemaVersion: 'aspc-resolve-runtime-declaration-request/v1',
        context: {
          agentId: 'smokey',
          project: { mode: 'none' },
          cwd: actualRoot,
          runMode: 'task',
          agentSources: { agentsRoot: actualAgents },
        },
      })
      expect(response).toMatchObject({
        ok: true,
        identity: { role: 'actual-producer' },
        provisioning: { effectiveHarness: 'claude', provider: 'anthropic' },
        agentSources: { provenance: 'caller' },
      })
    } finally {
      await actualTransport.close()
      await actualServer.retire()
    }
  })

  test('preserves identifier-authority code/status through the real Unix router', async () => {
    const actualRoot = join(base, 'authority')
    const actualAgents = join(actualRoot, 'agents')
    await mkdir(actualAgents, { recursive: true })
    const actualService = createReleaseBoundAspcService(
      createAspcService({
        agentsRoot: actualAgents,
        environment: { ASP_AGENTS_ROOT: actualAgents, HOME: actualRoot },
      }),
      RELEASE_BINDING
    )
    const actualServer = await startAspdServer({
      socketPath: join(base, 'authority.sock'),
      service: actualService,
      log: () => {},
    })
    const actualTransport = await UnixSocketTransport.connect({
      socketPath: join(base, 'authority.sock'),
    })
    try {
      const neutral = (await actualTransport.request('aspc.catalogAgentInspection', {})) as {
        projectId: string | null
        agents: unknown[]
      }
      expect(neutral).toMatchObject({ projectId: null, agents: [] })

      try {
        await actualTransport.request('aspc.catalogAgentInspection', {
          projectId: 'agent-spaces',
        })
        throw new Error('expected project-scoped catalog refusal')
      } catch (error) {
        expect(error).toMatchObject({
          code: -32603,
          data: {
            code: 'AGENT_INSPECTION_PRODUCER_UNAVAILABLE',
            status: 503,
          },
        })
      }
    } finally {
      await actualTransport.close()
      await actualServer.retire()
    }
  })

  test('preserves the complete supported identifier-authority error family', async () => {
    for (const [code, status] of AUTHORITY_ERRORS) {
      try {
        await request('aspc.catalogAgentInspection', { projectId: code })
        throw new Error(`expected ${code} refusal`)
      } catch (error) {
        expect(error).toMatchObject({ code: -32603, data: { code, status } })
      }
    }
    expect(await request('aspc.catalogAgentInspection', {})).toEqual({
      projectId: null,
      agents: [],
      contexts: {},
    })
  })
})

async function request(method: string, params: unknown): Promise<any> {
  expect(transport).toBeDefined()
  return transport?.request(method, params)
}

function fakeObservationService(): Record<string, unknown> {
  return {
    hello: async () => ({
      facadeInfo: { name: 'aspc-facade', version: 'red' },
      protocolVersion: 'aspc/0.1',
      capabilities: {
        compileRuntimePlan: true,
        catalogAgents: true,
        inspectAgent: true,
        catalogAgentInspection: true,
        inspectAgentSelection: true,
        compileHarnessInvocation: true,
        resolveRuntimeDeclaration: true,
        inspectRuntimePlacement: true,
        observeRuntimeCapability: true,
        observeContinuationArtifact: true,
        compileAndStart: false,
        cohostedBroker: false,
        transports: ['stdio-jsonrpc-ndjson'],
      },
    }),
    compileRuntimePlan: async () => ({
      schemaVersion: 'agent-runtime-compile-response/v1',
      ok: false,
      diagnostics: [],
    }),
    catalogAgents: async () => ({}),
    inspectAgent: async () => ({}),
    catalogAgentInspection: async (req: { projectId?: string }) => {
      const authority = AUTHORITY_ERRORS.find(([code]) => code === req.projectId)
      if (authority) {
        throw new AspcInspectionAuthorityError(authority[0], authority[1], authority[0])
      }
      return { projectId: null, agents: [], contexts: {} }
    },
    inspectAgentSelection: async () => ({}),
    compileHarnessInvocation: async () => ({
      schemaVersion: 'aspc-compile-harness-invocation-response/v1',
      ok: false,
      compileResponse: {
        schemaVersion: 'agent-runtime-compile-response/v1',
        ok: false,
        diagnostics: [],
      },
      diagnostics: [],
    }),
    resolveRuntimeDeclaration: async () => {
      calls.push('resolveRuntimeDeclaration')
      return {
        schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
        ok: false,
        agentSources: { provenance: 'daemon-default' },
        searchedAgentRoots: ['/agents'],
        source: { agentProfile: { state: 'absent', code: 'not_declared' } },
        resolution: {
          state: 'absent',
          code: 'agent_not_found',
          message: 'not installed',
          diagnostics: [],
        },
      }
    },
    inspectRuntimePlacement: async () => {
      calls.push('inspectRuntimePlacement')
      return {
        schemaVersion: 'aspc-inspect-runtime-placement-response/v1',
        ok: true,
        declaration: {},
        inspection: {
          schemaVersion: 'agent-inspection/v1',
          completeness: { kind: 'partial', missingPartIds: ['prompt:template:resolution'] },
        },
        prompt: {
          state: 'invalid',
          code: 'prompt_resolution_failed',
          message: 'fixture failure',
          diagnostics: [],
        },
        effectiveEnvironmentHash: 'env-red',
      }
    },
    observeRuntimeCapability: async () => {
      calls.push('observeRuntimeCapability')
      return {
        schemaVersion: 'aspc-observe-runtime-capability-response/v1',
        ok: true,
        harness: { requested: 'codex' },
        registration: { state: 'present', code: 'registered' },
        nativeRuntime: { state: 'unknown', code: 'detection_failed' },
        credentials: { state: 'present', code: 'credentials_present' },
        preparation: { state: 'unknown', code: 'preparation_unknown' },
        diagnostics: [{ code: 'probe_failed', probe: 'version', message: 'fixture' }],
      }
    },
    observeContinuationArtifact: async () => {
      calls.push('observeContinuationArtifact')
      return {
        schemaVersion: 'aspc-observe-continuation-artifact-response/v1',
        ok: true,
        requested: { provider: 'openai', key: 'ambiguous' },
        artifactFormat: 'unknown',
        artifact: { state: 'unknown', code: 'artifact_format_ambiguous' },
        basis: 'none',
        diagnostics: [],
      }
    },
  }
}
