/** T-08563 rev 5 real Unix JSON-RPC routing reds for standalone aspd. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type AspcService, createAspcService } from 'spaces-aspc'
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
      hostedDrivers: ['claude-code-tmux', 'codex-app-server', 'muse-cli-tmux', 'muse-serve'],
    },
  },
  claudeStatuslineSource: {
    path: '/releases/asp-runtime-observation-red/libexec/claude-statusline.cjs',
    sha256: 'runtime-observation-test',
    required: true as const,
  },
}
let base = ''
let server: AspdServer | undefined
let transport: UnixSocketTransport | undefined

beforeEach(async () => {
  base = await mkdtemp('/tmp/aspd-observation-red-')
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
  test('aspd hello over the socket reports the serving release and the unix transport', async () => {
    const hello = await request('aspc.hello', {
      clientInfo: { name: 'aspd-runtime-observation-red' },
      protocolVersions: ['aspc/0.1'],
    })
    expect(hello.protocolVersion).toBe('aspc/0.1')
    expect(hello.release).toEqual(IDENTITY)
    // The underlying service claims stdio and a cohosted broker; aspd overrides both.
    expect(hello.capabilities.transports).toEqual(['unix-jsonrpc-ndjson'])
    expect(hello.capabilities.cohostedBroker).toBe(false)
    expect(hello.capabilities).not.toHaveProperty('compileAndStart')
  })

  test('routes an actual producer response rather than only an injected observation double', async () => {
    const actualRoot = join(base, 'actual')
    const actualAgents = join(actualRoot, 'agents')
    const actualAgent = join(actualAgents, 'smokey')
    await mkdir(actualAgent, { recursive: true })
    await writeFile(
      join(actualAgent, 'agent-profile.toml'),
      'version = 4\n[identity]\nrole = "actual-producer"\n[provisioning]\nharness = "claude"\n'
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
        provisioning: {
          scalars: { harness: 'claude' },
          declaredHarness: 'claude',
          effectiveHarness: 'claude',
        },
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
})

async function request(method: string, params: unknown): Promise<any> {
  expect(transport).toBeDefined()
  return transport?.request(method, params)
}

// Only hello is exercised through the fake; the single cast at the call site admits it.
type AbridgedAspcService = { [K in keyof AspcService]?: (...args: never[]) => Promise<unknown> }

function fakeObservationService(): AbridgedAspcService {
  return {
    hello: async () => ({
      facadeInfo: { name: 'aspc-facade', version: 'red' },
      protocolVersion: 'aspc/0.1',
      capabilities: {
        catalogAgents: true,
        inspectAgent: true,
        catalogAgentInspection: true,
        inspectAgentSelection: true,
        compileHarnessInvocation: true,
        resolveRuntimeDeclaration: true,
        inspectRuntimePlacement: true,
        observeRuntimeCapability: true,
        observeContinuationArtifact: true,
        cohostedBroker: true,
        transports: ['stdio-jsonrpc-ndjson'],
      },
    }),
  }
}
