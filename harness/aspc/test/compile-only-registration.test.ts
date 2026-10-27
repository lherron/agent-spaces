/**
 * T-07314 RED (AC-3, AC-4): the compile-only facade is transport-injected.
 *
 * `spaces-aspc` no longer builds its own JSON-RPC transport (that lived in
 * `spaces-harness-broker`); it exposes a registration entrypoint that binds the
 * ASPC compile plane onto a caller-supplied server object. It must register
 * exactly the eleven read/compile methods — no `aspc.compileAndStart`, no
 * `broker.*`, no `invocation.*` — and report its capabilities honestly.
 *
 * The cohosted direction of every capability flag asserted here is pinned in
 * harness/aspc-facade/test/facade.test.ts (AC-8).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import type { AspcHelloResponse } from 'spaces-aspc-protocol'
import type { RuntimeCompileRequest } from 'spaces-runtime-contracts'
import { createAspcService, registerAspcCompileMethods } from '../src/index.js'
import type { AspcCompiler } from '../src/service.js'

type RecordedHandler = (request: {
  id: string | number
  method: string
  params: unknown
}) => Promise<unknown>

const COMPILE_METHODS = [
  'aspc.catalogAgentInspection',
  'aspc.catalogAgents',
  'aspc.compileHarnessInvocation',
  'aspc.hello',
  'aspc.inspectAgent',
  'aspc.inspectAgentSelection',
  'aspc.inspectRuntimePlacement',
  'aspc.observeContinuationArtifact',
  'aspc.observeRuntimeCapability',
  'aspc.prepareProcessInvocation',
  'aspc.resolveRuntimeDeclaration',
]

const EXCLUDED_METHODS = [
  'aspc.compileAndStart',
  'aspc.compileRuntimePlan',
  'broker.hello',
  'broker.health',
  'invocation.start',
  'invocation.input',
  'invocation.interrupt',
  'invocation.stop',
  'invocation.status',
  'invocation.dispose',
]

function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('missing package version')
  return manifest.version
}

function recordingServer(): {
  register(method: string, handler: RecordedHandler): void
  handlers: Map<string, RecordedHandler>
} {
  const handlers = new Map<string, RecordedHandler>()
  return {
    register(method: string, handler: RecordedHandler): void {
      if (handlers.has(method)) throw new Error(`duplicate registration: ${method}`)
      handlers.set(method, handler)
    },
    handlers,
  }
}

describe('compile-only ASPC registration', () => {
  test('AC-3: registers exactly the eleven read/compile methods on the injected server', () => {
    const server = recordingServer()
    registerAspcCompileMethods(server)

    expect([...server.handlers.keys()].sort()).toEqual(COMPILE_METHODS)
    for (const method of COMPILE_METHODS) {
      expect(server.handlers.has(method)).toBe(true)
    }
    for (const method of EXCLUDED_METHODS) {
      expect(server.handlers.has(method)).toBe(false)
    }
  })

  test('aspc.hello advertises the exact compile-only capability set', async () => {
    const server = recordingServer()
    registerAspcCompileMethods(server)

    const hello = server.handlers.get('aspc.hello')
    expect(hello).toBeDefined()
    const response = (await hello?.({
      id: 1,
      method: 'aspc.hello',
      params: {
        clientInfo: { name: 'compile-only-registration-test' },
        protocolVersions: [ASPC_PROTOCOL_VERSION],
      },
    })) as AspcHelloResponse

    expect(response.protocolVersion).toBe(ASPC_PROTOCOL_VERSION)
    expect(response.facadeInfo.version).toBe(packageVersion())
    expect(Object.hasOwn(response, 'brokerProtocol')).toBe(false)
    // Exact equality: no start plane (compileAndStart/compileRuntimePlan), no retired
    // Desktop bits (resolveDesktopIdentity/admitDesktopRegistration/prepareDesktopObserver),
    // and every compile/observation/preparation flag (incl. the taskContext/correlation
    // preparation capabilities) advertised true.
    expect(response.capabilities).toEqual({
      catalogAgents: true,
      inspectAgent: true,
      catalogAgentInspection: true,
      inspectAgentSelection: true,
      compileHarnessInvocation: true,
      resolveRuntimeDeclaration: true,
      inspectRuntimePlacement: true,
      inspectRuntimePlacementPreparationCorrelation: true,
      inspectRuntimePlacementPreparationTaskContext: true,
      observeRuntimeCapability: true,
      observeContinuationArtifact: true,
      prepareProcessInvocation: true,
      prepareProcessInvocationTaskContext: true,
      cohostedBroker: false,
      transports: ['stdio-jsonrpc-ndjson'],
    })
  })

  test('closed summon directives pass the wire validators and reach the compiler with presentation false intact', async () => {
    const received: RuntimeCompileRequest[] = []
    const compiler: AspcCompiler = async (request) => {
      received.push(request)
      return { schemaVersion: 'agent-runtime-compile-response/v2', ok: false, diagnostics: [] }
    }
    const server = recordingServer()
    registerAspcCompileMethods(server, { service: createAspcService({ compiler }) })

    const summonDirectives = {
      harness: 'muse',
      model_provider: 'mistral',
      model: 'devstral-2',
      reasoning_effort: 'high',
      presentation: false,
    } as const
    await server.handlers.get('aspc.compileHarnessInvocation')?.({
      id: 'summon',
      method: 'aspc.compileHarnessInvocation',
      params: {
        compileRequest: {
          schemaVersion: 'agent-runtime-compile-request/v2',
          agent: { id: 'cody' },
          identity: { requestId: 'req_1', operationId: 'op_1' },
          placement: {
            agentRoot: '/tmp/agent',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'agent',
          },
          requested: { harness: 'codex', presentation: true },
          materialization: {},
          hrcPolicy: {},
          correlation: { requestId: 'req_1', operationId: 'op_1' },
          selectionContext: { summonDirectives },
        },
      },
    })

    expect(received).toHaveLength(1)
    expect(received[0]?.selectionContext?.summonDirectives).toEqual(summonDirectives)
    // The directive's false is its own fact, separate from requested.presentation.
    expect(received[0]?.selectionContext?.summonDirectives?.presentation).toBe(false)
    expect(received[0]?.requested.presentation).toBe(true)
  })
})
