/**
 * T-08577 service reds for the preparation operations.
 *
 * The existing ASPC service and transport-injected registration seams are used
 * directly. No broker server is started and no native process is launched.
 * T-08594 retired the three Desktop preparation ops from the RPC surface (the
 * compiler functions stay as the in-process library); only
 * prepareProcessInvocation remains here.
 */
import { describe, expect, test } from 'bun:test'
import { createAspcService, registerAspcCompileMethods } from '../src/index.js'

type RecordedHandler = (request: {
  id: string | number | null
  method: string
  params: unknown
}) => Promise<unknown>

function recordingServer(): {
  handlers: Map<string, RecordedHandler>
  register(method: string, handler: RecordedHandler): void
} {
  const handlers = new Map<string, RecordedHandler>()
  return {
    handlers,
    register(method, handler) {
      if (handlers.has(method)) throw new Error(`duplicate method ${method}`)
      handlers.set(method, handler)
    },
  }
}

describe('ASPC preparation service registration (T-08577)', () => {
  test('control: the existing compile plane still excludes start and broker routes', () => {
    const server = recordingServer()
    registerAspcCompileMethods(server)

    expect(server.handlers.has('aspc.compileRuntimePlan')).toBe(true)
    expect(server.handlers.has('aspc.compileAndStart')).toBe(false)
    expect([...server.handlers.keys()].some((name) => name.startsWith('broker.'))).toBe(false)
    expect([...server.handlers.keys()].some((name) => name.startsWith('invocation.'))).toBe(false)
  })

  test('A2: the service registers exactly one preparation route without any start/input route', () => {
    const server = recordingServer()
    registerAspcCompileMethods(server)

    const preparation = [...server.handlers.keys()].filter((method) =>
      method.startsWith('aspc.prepare')
    )
    expect(preparation.sort()).toEqual(['aspc.prepareProcessInvocation'])
    for (const forbidden of [
      'aspc.compileAndStart',
      'invocation.start',
      'invocation.input',
      'invocation.interrupt',
      'broker.hello',
    ]) {
      expect(server.handlers.has(forbidden), forbidden).toBe(false)
    }
  })

  test('A2/H4: hello advertises the one remaining preparation capability', async () => {
    const hello = await createAspcService().hello({
      clientInfo: { name: 't08577-service-red' },
      protocolVersions: ['aspc/0.1'],
    })

    expect(hello.capabilities).toMatchObject({
      prepareProcessInvocation: true,
    })
    expect(hello.capabilities).not.toHaveProperty('resolveDesktopIdentity')
    expect(hello.capabilities).not.toHaveProperty('admitDesktopRegistration')
    expect(hello.capabilities).not.toHaveProperty('prepareDesktopObserver')
  })
})
