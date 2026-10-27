/**
 * T-08577 release-binding reds for execution preparation.
 *
 * These tests use the existing release-bound service wrapper. Identity and
 * admission are passing controls that must remain byte-transparent. Direct
 * process success gains only the serving preparation release; Desktop observer
 * success gains the frozen execution release/worker binding. Failure arms pass
 * through untouched, and an old hello without a capability must prevent a raw
 * method request.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { type AspcService, createAspcService } from 'spaces-aspc'
import { AspcUnixClient } from 'spaces-aspc-protocol/unix-client'
import type { AspReleaseIdentity } from 'spaces-harness-broker-protocol'
import * as aspdModule from '../src/aspd.js'
import {
  type AspdReleaseBinding,
  createReleaseBoundAspcService,
  startAspdServer,
} from '../src/aspd.js'
import { createRuntimeCompiler } from '../src/runtime-compiler.js'

type UnknownRecord = Record<string, unknown>
type UnknownService = AspcService & UnknownRecord
type DynamicMethod = (request: UnknownRecord) => unknown | Promise<unknown>

const roots: string[] = []
const originalAspHome = process.env['ASP_HOME']
const originalCodexPath = process.env['ASP_CODEX_PATH']
const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalAspHome === undefined) process.env['ASP_HOME'] = undefined
  else process.env['ASP_HOME'] = originalAspHome
  if (originalCodexPath === undefined) process.env['ASP_CODEX_PATH'] = undefined
  else process.env['ASP_CODEX_PATH'] = originalCodexPath
  if (originalSkipCommon === undefined) process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
  else process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommon
})

function tempRoot(): string {
  const value = mkdtempSync('/tmp/t8577-release-')
  roots.push(value)
  return value
}

function identity(label: 'a'): AspReleaseIdentity {
  return {
    releaseId: `asp-${label.repeat(12)}-20260917T000000Z-t08577`,
    sourceCommit: label.repeat(40),
    builtAt: '2026-09-17T01:00:00.000Z',
  }
}

function binding(label: 'a'): AspdReleaseBinding {
  const releaseIdentity = identity(label)
  const releaseRoot = `/immutable/releases/${releaseIdentity.releaseId}`
  const executable = `${releaseRoot}/harness-broker`
  const hostedDrivers = ['claude-code-tmux', 'codex-app-server', 'muse-cli-tmux', 'muse-serve']
  return {
    identity: releaseIdentity,
    releaseRoot,
    workers: {
      'codex-app-server': { executable, hostedDrivers },
      'claude-code-tmux': { executable, hostedDrivers },
      'muse-cli-tmux': { executable, hostedDrivers },
      'muse-serve': { executable, hostedDrivers },
    },
    claudeStatuslineSource: {
      path: `${releaseRoot}/assets/claude-statusline.sh`,
      sha256: label.repeat(64),
      required: true,
    },
  }
}

const DIRECT_SUCCESS: UnknownRecord = {
  schemaVersion: 'aspc-prepare-process-invocation-response/v1',
  ok: true,
  declaration: { provider: 'openai', frontend: 'codex-cli' },
  spec: {
    provider: 'openai',
    frontend: 'codex-cli',
    argv: ['/external/codex', 'app-server'],
    cwd: '/project',
    env: {},
    interactionMode: 'headless',
    ioMode: 'pipes',
    prompts: { system: null, priming: null },
  },
  resolvedBundle: { bundleIdentity: 'bundle-t08577' },
  effectiveEnvironmentHash: 'env-t08577',
  warnings: [],
  diagnostics: [],
}

function fakeService(
  input: {
    capabilities?: UnknownRecord
    prepareProcessInvocation?: DynamicMethod
  } = {}
): UnknownService {
  return {
    hello: async () => ({
      facadeInfo: { name: 'aspc-facade', version: '0.1.1' },
      protocolVersion: 'aspc/0.1',
      capabilities: {
        catalogAgents: true,
        inspectAgent: true,
        catalogAgentInspection: true,
        inspectAgentSelection: true,
        compileHarnessInvocation: true,
        cohostedBroker: false,
        transports: ['stdio-jsonrpc-ndjson'],
        ...input.capabilities,
      },
    }),
    catalogAgents: async () => ({}) as never,
    inspectAgent: async () => ({}) as never,
    catalogAgentInspection: async () => ({}) as never,
    inspectAgentSelection: async () => ({}) as never,
    compileHarnessInvocation: async () => ({
      schemaVersion: 'aspc-compile-harness-invocation-response/v2',
      ok: false,
      diagnostics: [],
    }),
    prepareProcessInvocation: input.prepareProcessInvocation ?? (async () => DIRECT_SUCCESS),
  } as unknown as UnknownService
}

function directRequest(): UnknownRecord {
  return {
    schemaVersion: 'aspc-prepare-process-invocation-request/v1',
    context: {
      agentId: 'cody',
      project: { mode: 'root', projectRoot: '/project', projectId: 'agent-spaces' },
      cwd: '/project',
      runMode: 'task',
    },
    preparationCorrelation: {},
    expected: { provider: 'openai', frontend: 'codex-cli' },
    launch: { interactionMode: 'headless', ioMode: 'pipes' },
  }
}

function realDirectFixture(): {
  socketPath: string
  request: UnknownRecord
  conflictingAgentsRoot: string
  canonicalSources: UnknownRecord
} {
  const root = tempRoot()
  const realAspHome = join(root, 'real-asp-home')
  const realAgentsRoot = join(realAspHome, 'agents')
  const realAgentRoot = join(realAgentsRoot, 'cody')
  const linkedAspHome = join(root, 'linked-asp-home')
  const linkedAgentsRoot = join(root, 'linked-agents')
  const projectRoot = join(root, 'project')
  const daemonDefault = join(root, 'conflicting-daemon-default')
  const conflictingAgentsRoot = join(root, 'conflicting-agents')
  mkdirSync(realAgentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(daemonDefault, { recursive: true })
  mkdirSync(conflictingAgentsRoot, { recursive: true })
  writeFileSync(
    join(realAspHome, 'config.toml'),
    `agents-root = ${JSON.stringify(realAgentsRoot)}\n`
  )
  symlinkSync(realAspHome, linkedAspHome)
  symlinkSync(realAgentsRoot, linkedAgentsRoot)
  writeFileSync(
    join(realAgentRoot, 'agent-profile.toml'),
    `version = 4
priming = "Prepared by {{handle}}."

[spaces]
base = []

[provisioning]
harness = "codex"

[provisioning.codex]
model = "gpt-5.3-codex"
`,
    'utf8'
  )
  writeFileSync(join(realAgentRoot, 'SOUL.md'), '# Production service prompt\n')
  const codex = join(root, 'codex')
  writeFileSync(
    codex,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 999.0.0"; exit 0; fi\nif [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then echo app-server; exit 0; fi\nexit 97\n',
    'utf8'
  )
  chmodSync(codex, 0o755)
  process.env['ASP_HOME'] = daemonDefault
  process.env['ASP_CODEX_PATH'] = codex
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  return {
    socketPath: join(root, 'aspd.sock'),
    conflictingAgentsRoot,
    canonicalSources: {
      aspHome: realpathSync.native(realAspHome),
      agentsRoot: realpathSync.native(realAgentsRoot),
      provenance: 'caller-agent-root',
    },
    request: {
      schemaVersion: 'aspc-prepare-process-invocation-request/v1',
      context: {
        agentId: 'cody',
        agentRoot: realAgentRoot,
        project: { mode: 'root', projectRoot, projectId: 'agent-spaces' },
        cwd: projectRoot,
        runMode: 'task',
        agentSources: { aspHome: linkedAspHome, agentsRoot: linkedAgentsRoot },
      },
      preparationCorrelation: {},
      expected: { provider: 'openai', frontend: 'codex-cli' },
      launch: { interactionMode: 'headless', ioMode: 'pipes' },
    },
  }
}

describe('release-bound preparation service (T-08577)', () => {
  test('production composition root prepares through Unix with canonical caller sources', async () => {
    const fixture = realDirectFixture()
    const selected = binding('a')
    const candidate = (aspdModule as UnknownRecord)['createAspdService']
    const service =
      typeof candidate === 'function'
        ? (candidate as (value: AspdReleaseBinding) => AspcService)(selected)
        : createReleaseBoundAspcService(
            createAspcService({
              compiler: createRuntimeCompiler({
                claudeStatuslineSource: selected.claudeStatuslineSource,
              }),
            }),
            selected
          )
    const server = await startAspdServer({ socketPath: fixture.socketPath, service, log: () => {} })
    const client = await AspcUnixClient.connect({
      socketPath: fixture.socketPath,
      clientInfo: { name: 't08574-production-composition' },
    })
    try {
      const response = await client.prepareProcessInvocation(fixture.request as never)
      expect(response).toMatchObject({
        schemaVersion: 'aspc-prepare-process-invocation-response/v1',
        ok: true,
        declaration: { agentSources: fixture.canonicalSources },
      })
      // A direct preparation binds the serving release and fabricates no worker.
      expect((response as unknown as UnknownRecord)['release']).toEqual({
        ...selected.identity,
        releaseRoot: selected.releaseRoot,
      })
      const context = fixture.request['context'] as UnknownRecord
      const conflicting = await client.prepareProcessInvocation({
        ...fixture.request,
        context: {
          ...context,
          agentSources: {
            ...((context['agentSources'] as UnknownRecord | undefined) ?? {}),
            agentsRoot: fixture.conflictingAgentsRoot,
          },
        },
      } as never)
      expect(conflicting).toMatchObject({
        schemaVersion: 'aspc-prepare-process-invocation-response/v1',
        ok: false,
        failure: { kind: 'incompatible', code: 'configured_context_mismatch' },
      })
      expect(Object.hasOwn(conflicting, 'spec')).toBe(false)
    } finally {
      await client.close()
      await server.retire()
    }
  })

  test('a failed preparation crosses the socket unchanged, with no release evidence', async () => {
    const failure: UnknownRecord = {
      schemaVersion: 'aspc-prepare-process-invocation-response/v1',
      ok: false,
      failure: { kind: 'unavailable', code: 'preparation_failed', message: 'no result' },
    }
    const socketPath = join(tempRoot(), 'failed.sock')
    const server = await startAspdServer({
      socketPath,
      service: createReleaseBoundAspcService(
        fakeService({
          capabilities: { prepareProcessInvocation: true },
          prepareProcessInvocation: async () => failure,
        }),
        binding('a')
      ),
      log: () => {},
    })
    const client = await AspcUnixClient.connect({
      socketPath,
      clientInfo: { name: 't08577-failed-preparation' },
    })
    try {
      expect(await client.prepareProcessInvocation(directRequest() as never)).toEqual(
        failure as never
      )
    } finally {
      await client.close()
      await server.retire()
    }
  })
})

describe('old-release capability gate (T-08577 H4)', () => {
  test('a client of an old aspd refuses prepareProcessInvocation without sending it when the capability is absent', async () => {
    const socketPath = join(tempRoot(), 'old.sock')
    let rawCalls = 0
    const oldService = fakeService({
      prepareProcessInvocation: async () => {
        rawCalls += 1
        return DIRECT_SUCCESS
      },
    })
    const server = await startAspdServer({ socketPath, service: oldService, log: () => {} })
    const client = await AspcUnixClient.connect({
      socketPath,
      clientInfo: { name: 't08577-old-release' },
    })
    try {
      const prepare = (client as unknown as UnknownRecord)['prepareProcessInvocation']
      expect(typeof prepare, 'AspcUnixClient must expose the capability-gated method').toBe(
        'function'
      )
      let caught: unknown
      try {
        await (prepare as DynamicMethod).call(client, directRequest())
      } catch (error) {
        caught = error
      }
      expect(caught).toBeDefined()
      expect(
        `${(caught as { name?: unknown }).name} ${(caught as { code?: unknown }).code} ${
          (caught as { message?: unknown }).message
        }`
      ).toMatch(/missing.?capability/i)
      expect(rawCalls).toBe(0)
    } finally {
      await client.close()
      await server.retire()
    }
  })
})
