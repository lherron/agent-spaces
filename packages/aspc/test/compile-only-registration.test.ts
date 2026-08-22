/**
 * T-07318 RED (AC-3, AC-4): the compile-only facade is transport-injected.
 *
 * `spaces-aspc` no longer builds its own JSON-RPC transport (that lived in
 * `spaces-harness-broker`); it exposes a registration entrypoint that binds the
 * ASPC compile plane onto a caller-supplied server object. It must register
 * exactly the five compile methods — no `aspc.compileAndStart`, no `broker.*`,
 * no `invocation.*` — and report its capabilities honestly.
 *
 * The cohosted direction of every capability flag asserted here is pinned in
 * packages/aspc-facade/test/facade.test.ts (AC-8).
 */
import { describe, expect, test } from 'bun:test'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import type { AspcHelloResponse } from 'spaces-aspc-protocol'
import { registerAspcCompileMethods } from '../src/index.js'

type RecordedHandler = (request: {
  id: string | number
  method: string
  params: unknown
}) => Promise<unknown>

const COMPILE_METHODS = [
  'aspc.catalogAgents',
  'aspc.compileHarnessInvocation',
  'aspc.compileRuntimePlan',
  'aspc.hello',
  'aspc.inspectAgent',
]

const EXCLUDED_METHODS = [
  'aspc.compileAndStart',
  'broker.hello',
  'broker.health',
  'invocation.start',
  'invocation.input',
  'invocation.interrupt',
  'invocation.stop',
  'invocation.status',
  'invocation.dispose',
]

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
  test('AC-3: registers exactly the five compile methods on the injected server', () => {
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

  test('AC-4: aspc.hello reports compile-only capabilities honestly', async () => {
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
    expect(response.capabilities.compileAndStart).toBe(false)
    expect(response.capabilities.cohostedBroker).toBe(false)
    expect(response.capabilities.transports).toEqual(['stdio-jsonrpc-ndjson'])
    expect(Object.hasOwn(response, 'brokerProtocol')).toBe(false)

    expect(response.capabilities.compileRuntimePlan).toBe(true)
    expect(response.capabilities.catalogAgents).toBe(true)
    expect(response.capabilities.inspectAgent).toBe(true)
    expect(response.capabilities.compileHarnessInvocation).toBe(true)
  })
})
