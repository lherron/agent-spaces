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

function identity(label: 'a' | 'b'): AspReleaseIdentity {
  return {
    releaseId: `asp-${label.repeat(12)}-20260917T000000Z-t08577`,
    sourceCommit: label.repeat(40),
    builtAt: `2026-09-17T0${label === 'a' ? '1' : '2'}:00:00.000Z`,
  }
}

function binding(label: 'a' | 'b'): AspdReleaseBinding {
  const releaseIdentity = identity(label)
  const releaseRoot = `/immutable/releases/${releaseIdentity.releaseId}`
  const executable = `${releaseRoot}/harness-broker`
  const hostedDrivers = ['claude-code-tmux', 'codex-app-server', 'pi-tui-tmux']
  return {
    identity: releaseIdentity,
    releaseRoot,
    workers: {
      'codex-app-server': { executable, hostedDrivers },
      'claude-code-tmux': { executable, hostedDrivers },
      'pi-tui-tmux': { executable, hostedDrivers },
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
        compileAndStart: false,
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

function method(service: object, name: string): DynamicMethod {
  const candidate = (service as UnknownRecord)[name]
  expect(typeof candidate, `${name} must exist on the release-bound service`).toBe('function')
  return candidate as DynamicMethod
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
        release: { releaseId: selected.identity.releaseId },
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

  test('H3: direct preparation binds the serving release without fabricating a worker', async () => {
    const selected = binding('a')
    const bound = createReleaseBoundAspcService(fakeService(), selected)
    const response = (await method(bound, 'prepareProcessInvocation').call(
      bound,
      directRequest()
    )) as UnknownRecord

    expect(response['release']).toEqual({
      ...selected.identity,
      releaseRoot: selected.releaseRoot,
    })
    expect(Object.hasOwn(response['release'] as object, 'worker')).toBe(false)
    const { release: _added, ...rest } = response
    expect(rest).toEqual(DIRECT_SUCCESS)
  })

  test('B8/E3: every non-success arm is inhabitable and passes through without invented release evidence', async () => {
    const directFailures: UnknownRecord[] = [
      {
        schemaVersion: 'aspc-prepare-process-invocation-response/v1',
        ok: false,
        agentSources: {
          aspHome: '/asp-home',
          agentsRoot: '/agents',
          provenance: 'caller',
        },
        searchedAgentRoots: ['/agents'],
        source: {
          agentProfile: { state: 'absent', code: 'not_declared' },
          projectTargets: { state: 'absent', code: 'not_declared' },
          selectedTarget: { state: 'absent', code: 'not_declared' },
          priming: { state: 'absent', code: 'not_declared' },
        },
        resolution: {
          state: 'absent',
          code: 'agent_not_found',
          message: 'agent absent',
          diagnostics: [],
        },
      },
      {
        schemaVersion: 'aspc-prepare-process-invocation-response/v1',
        ok: false,
        failure: {
          kind: 'incompatible',
          code: 'configured_context_mismatch',
          message: 'caller source mismatch',
        },
      },
      {
        schemaVersion: 'aspc-prepare-process-invocation-response/v1',
        ok: false,
        failure: { kind: 'unavailable', code: 'preparation_failed', message: 'no result' },
      },
    ]
    let directIndex = 0
    const bound = createReleaseBoundAspcService(
      fakeService({
        prepareProcessInvocation: async () => directFailures[directIndex++] as UnknownRecord,
      }),
      binding('a')
    )

    for (const directFailure of directFailures) {
      expect(await method(bound, 'prepareProcessInvocation').call(bound, directRequest())).toBe(
        directFailure
      )
    }
  })

  test('H2/H3: a response admitted on A remains bound to A after B is selected', async () => {
    const releaseA = binding('a')
    const releaseB = binding('b')
    const service = fakeService()
    const boundA = createReleaseBoundAspcService(service, releaseA)
    const directA = (await method(boundA, 'prepareProcessInvocation').call(
      boundA,
      directRequest()
    )) as UnknownRecord
    const boundB = createReleaseBoundAspcService(service, releaseB)
    const directB = (await method(boundB, 'prepareProcessInvocation').call(
      boundB,
      directRequest()
    )) as UnknownRecord

    expect(directA['release']).toBeDefined()
    expect(directB['release']).toBeDefined()
    expect((directA['release'] as UnknownRecord | undefined)?.['releaseId']).toBe(
      releaseA.identity.releaseId
    )
    expect((directB['release'] as UnknownRecord | undefined)?.['releaseId']).toBe(
      releaseB.identity.releaseId
    )
    expect((directA['release'] as UnknownRecord | undefined)?.['releaseId']).not.toBe(
      (directB['release'] as UnknownRecord | undefined)?.['releaseId']
    )
  })
})

describe('old-release capability gate (T-08577 H4)', () => {
  test('an absent capability refuses client-side without sending the raw method', async () => {
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
