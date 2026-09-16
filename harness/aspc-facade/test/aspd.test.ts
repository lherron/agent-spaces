/**
 * aspd (T-08539): the existing compile plane on a Unix socket, bound to one
 * release, with admission retired on the listener and on existing connections
 * before in-flight work drains.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { AspcService } from 'spaces-aspc'
import type {
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
  AspcExecutionRelease,
  AspcTransportKind,
} from 'spaces-aspc-protocol'
import { AspcServiceUnavailableError, AspcUnixClient } from 'spaces-aspc-protocol/unix-client'
import { UnixSocketTransport } from 'spaces-harness-broker-client'
import type { AspReleaseIdentity } from 'spaces-harness-broker-protocol'
import {
  type AspdReleaseBinding,
  createReleaseBoundAspcService,
  resolveAspdReleaseBinding,
  startAspdServer,
} from '../src/aspd.js'

const IDENTITY: AspReleaseIdentity = {
  releaseId: 'asp-0123456789ab-20260916T120000Z-abcdef',
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  builtAt: '2026-09-16T12:00:00.000Z',
}

const bases: string[] = []
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true })
})

function tempBase(): string {
  // Short base: sockaddr_un paths are limited to ~104 bytes on darwin.
  const base = mkdtempSync(join('/tmp', 'aspd-'))
  bases.push(base)
  return base
}

function fakeRelease(base: string, manifestOverrides: Record<string, unknown> = {}): string {
  const root = join(base, IDENTITY.releaseId)
  mkdirSync(join(root, 'libexec'), { recursive: true })
  writeFileSync(join(root, 'libexec', 'aspd'), '#!/bin/sh\n', { mode: 0o555 })
  writeFileSync(join(root, 'harness-broker'), '#!/bin/sh\n', { mode: 0o555 })
  writeFileSync(
    join(root, 'release.json'),
    JSON.stringify({
      releaseId: IDENTITY.releaseId,
      sourceCommit: IDENTITY.sourceCommit,
      executables: { 'harness-broker': { launcher: 'harness-broker' } },
      ...manifestOverrides,
    })
  )
  return root
}

const binding: AspdReleaseBinding = {
  identity: IDENTITY,
  releaseRoot: '/releases/asp-x',
  workerExecutable: '/releases/asp-x/harness-broker',
}

function okCompile(brokerProtocol: string): AspcCompileHarnessInvocationResponse {
  return {
    schemaVersion: 'aspc-compile-harness-invocation-response/v1',
    ok: true,
    compileResponse: {} as never,
    plan: {} as never,
    selectedProfile: { brokerProtocol, profileHash: 'p' } as never,
    startRequest: { spec: { invocationId: 'inv_1' } } as never,
    dispatchRequest: {
      startRequest: { spec: { invocationId: 'inv_1' } },
      dispatchEnv: { A: 'b' },
    } as never,
    diagnostics: [],
  }
}

function fakeService(overrides: Partial<AspcService> = {}): AspcService {
  return {
    hello: async () => ({
      facadeInfo: { name: 'aspc-facade', version: '0.0.0' },
      protocolVersion: 'aspc/0.1',
      capabilities: {
        compileRuntimePlan: true,
        catalogAgents: true,
        inspectAgent: true,
        catalogAgentInspection: true,
        inspectAgentSelection: true,
        compileHarnessInvocation: true,
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
    catalogAgents: async () => ({}) as never,
    inspectAgent: async () => ({}) as never,
    catalogAgentInspection: async () => ({}) as never,
    inspectAgentSelection: async () => ({}) as never,
    compileHarnessInvocation: async () => okCompile('harness-broker/0.2'),
    ...overrides,
  }
}

function compileRequest(): AspcCompileHarnessInvocationRequest {
  return {
    compileRequest: {
      schemaVersion: 'agent-runtime-compile-request/v1',
      identity: {},
      placement: {},
      requested: {},
      materialization: {},
      hrcPolicy: {},
      correlation: {},
    },
  } as never
}

describe('release binding', () => {
  test('refuses to serve without a compiled-in release identity', () => {
    expect(() => resolveAspdReleaseBinding(undefined, process.execPath)).toThrow(
      /must run from an immutable ASP release/
    )
  })

  test('binds the release containing the payload and its in-release worker', () => {
    const root = fakeRelease(tempBase())
    const resolved = resolveAspdReleaseBinding(IDENTITY, join(root, 'libexec', 'aspd'))
    expect(resolved.releaseRoot.endsWith(IDENTITY.releaseId)).toBe(true)
    expect(resolved.workerExecutable).toBe(join(resolved.releaseRoot, 'harness-broker'))
  })

  test('refuses a manifest naming another source commit', () => {
    const root = fakeRelease(tempBase(), { sourceCommit: 'f'.repeat(40) })
    expect(() => resolveAspdReleaseBinding(IDENTITY, join(root, 'libexec', 'aspd'))).toThrow(
      /does not match compiled-in identity/
    )
  })

  test('refuses a worker launcher that escapes the release', () => {
    const base = tempBase()
    const root = fakeRelease(base)
    writeFileSync(join(base, 'outside'), '#!/bin/sh\n', { mode: 0o555 })
    chmodSync(root, 0o755)
    rmSync(join(root, 'harness-broker'))
    symlinkSync(join(base, 'outside'), join(root, 'harness-broker'))
    expect(() => resolveAspdReleaseBinding(IDENTITY, join(root, 'libexec', 'aspd'))).toThrow(
      /escapes release/
    )
  })
})

describe('release-bound service (W1/W2)', () => {
  test('hello reports the unix transport and serving release', async () => {
    const hello = await createReleaseBoundAspcService(fakeService(), binding).hello({
      clientInfo: { name: 't' },
      protocolVersions: ['aspc/0.1'],
    })
    expect(hello.protocolVersion).toBe('aspc/0.1')
    const expectedTransports: AspcTransportKind[] = ['unix-jsonrpc-ndjson']
    expect(hello.capabilities.transports).toEqual(expectedTransports)
    expect(hello.capabilities.compileAndStart).toBe(false)
    expect(hello.capabilities.cohostedBroker).toBe(false)
    expect(hello.release).toEqual(IDENTITY)
  })

  test('adds executionRelease with the selected profile protocol and leaves the dispatch untouched', async () => {
    for (const protocol of ['harness-broker/0.2', 'harness-broker/0.3']) {
      const underlying = okCompile(protocol)
      const service = createReleaseBoundAspcService(
        fakeService({ compileHarnessInvocation: async () => underlying }),
        binding
      )
      const response = await service.compileHarnessInvocation(compileRequest())
      if (!response.ok) throw new Error('expected ok')
      const expected: AspcExecutionRelease = {
        ...IDENTITY,
        releaseRoot: binding.releaseRoot,
        worker: {
          protocol,
          executable: binding.workerExecutable,
          argvPrefix: ['run', '--transport', 'unix'],
        },
      }
      expect(response.executionRelease).toEqual(expected)
      const { executionRelease: _added, ...rest } = response
      expect(rest).toEqual(underlying)
    }
  })

  test('failed compiles pass through without a release binding', async () => {
    const failed: AspcCompileHarnessInvocationResponse = {
      schemaVersion: 'aspc-compile-harness-invocation-response/v1',
      ok: false,
      compileResponse: {
        schemaVersion: 'agent-runtime-compile-response/v1',
        ok: false,
        diagnostics: [],
      },
      diagnostics: [],
    }
    const service = createReleaseBoundAspcService(
      fakeService({ compileHarnessInvocation: async () => failed }),
      binding
    )
    expect(await service.compileHarnessInvocation(compileRequest())).toEqual(failed)
  })
})

describe('unix server and retirement', () => {
  test('serves only the compile plane; compileAndStart is not a route', async () => {
    const socketPath = join(tempBase(), 's.sock')
    const server = await startAspdServer({
      socketPath,
      service: createReleaseBoundAspcService(fakeService(), binding),
      log: () => {},
    })
    const transport = await UnixSocketTransport.connect({ socketPath })
    try {
      await expect(
        transport.request('aspc.compileAndStart', compileRequest())
      ).rejects.toMatchObject({
        code: -32601,
      })
      await expect(transport.request('invocation.start', {})).rejects.toMatchObject({
        code: -32601,
      })
    } finally {
      await transport.close()
      await server.retire()
    }
  })

  test('in-flight work finishes on the old release; existing connections admit nothing after cutover', async () => {
    const socketPath = join(tempBase(), 's.sock')
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = createReleaseBoundAspcService(
      fakeService({
        compileHarnessInvocation: async () => {
          calls += 1
          await gate
          return okCompile('harness-broker/0.2')
        },
      }),
      binding
    )
    const server = await startAspdServer({ socketPath, service, log: () => {} })
    const inflightConn = await AspcUnixClient.connect({ socketPath, clientInfo: { name: 't' } })
    const idleConn = await AspcUnixClient.connect({ socketPath, clientInfo: { name: 't' } })
    expect(inflightConn.hello.release).toEqual(IDENTITY)

    const inflight = inflightConn.compileHarnessInvocation(compileRequest())
    while (server.inFlight() === 0) await Bun.sleep(5)

    const retired = server.retire()
    // The listener is gone before in-flight work drains.
    await Bun.sleep(20)
    expect(existsSync(socketPath)).toBe(false)
    await expect(
      AspcUnixClient.connect({ socketPath, clientInfo: { name: 't' } })
    ).rejects.toBeInstanceOf(AspcServiceUnavailableError)

    // A pre-existing connection cannot admit new work into the retiring release.
    const late = idleConn.compileHarnessInvocation(compileRequest())
    const lateOutcome = late.then(
      () => 'answered',
      () => 'closed-unanswered'
    )
    await Bun.sleep(20)
    expect(calls).toBe(1)

    release?.()
    const answered = await inflight
    if (!answered.ok) throw new Error('expected ok')
    expect(answered.executionRelease?.releaseId).toBe(IDENTITY.releaseId)
    await retired
    expect(await lateOutcome).toBe('closed-unanswered')
    expect(calls).toBe(1)
    await inflightConn.close()
    await idleConn.close()
  })

  test('a daemon that exits right after retirement still delivers the in-flight reply', async () => {
    const socketPath = join(tempBase(), 's.sock')
    const child = Bun.spawn({
      cmd: ['bun', join(import.meta.dir, 'fixtures', 'aspd-exit-after-retire.ts'), socketPath],
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const stderr: string[] = []
    const decoder = new TextDecoder()
    void (async () => {
      for await (const chunk of child.stderr) stderr.push(decoder.decode(chunk))
    })()
    const waitForLog = async (needle: string): Promise<void> => {
      const deadline = Date.now() + 10_000
      while (!stderr.join('').includes(needle)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}`)
        await Bun.sleep(10)
      }
    }
    await waitForLog('ready')
    const conn = await AspcUnixClient.connect({ socketPath, clientInfo: { name: 't' } })
    const inflight = conn.compileHarnessInvocation(compileRequest())
    await waitForLog('method=aspc.compileHarnessInvocation')
    child.kill('SIGTERM')
    const answered = await inflight
    expect(answered.diagnostics).toHaveLength(4000)
    expect(await child.exited).toBe(0)
    expect(stderr.join('')).toContain('retire.begin inFlight=1')
    await conn.close()
  })

  test('refuses to take over a socket a live listener still serves', async () => {
    const socketPath = join(tempBase(), 's.sock')
    const first = await startAspdServer({ socketPath, service: fakeService(), log: () => {} })
    await expect(
      startAspdServer({ socketPath, service: fakeService(), log: () => {} })
    ).rejects.toThrow(/already served by a live listener/)
    await first.retire()
  })
})
