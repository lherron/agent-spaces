import { describe, expect, test } from 'bun:test'
import { ASPC_COMPILE_METHODS, registerAspcCompileMethods } from '../src/registration.js'
import { createAspcService } from '../src/service.js'

describe('aspc Desktop ops retirement (T-08594 component 7)', () => {
  test('the three Desktop methods are unregistered; prepareProcessInvocation stays', () => {
    expect(ASPC_COMPILE_METHODS).not.toHaveProperty('resolveDesktopIdentity')
    expect(ASPC_COMPILE_METHODS).not.toHaveProperty('admitDesktopRegistration')
    expect(ASPC_COMPILE_METHODS).not.toHaveProperty('prepareDesktopObserver')
    expect(ASPC_COMPILE_METHODS.prepareProcessInvocation).toBe('aspc.prepareProcessInvocation')

    const registered = new Map<string, unknown>()
    registerAspcCompileMethods({ register: (method, handler) => registered.set(method, handler) })
    expect(registered.has('aspc.resolveDesktopIdentity')).toBe(false)
    expect(registered.has('aspc.admitDesktopRegistration')).toBe(false)
    expect(registered.has('aspc.prepareDesktopObserver')).toBe(false)
    expect(registered.has('aspc.prepareProcessInvocation')).toBe(true)
  })

  test('hello advertises prepareProcessInvocation but none of the Desktop bits', async () => {
    const service = createAspcService()
    const hello = (await service.hello({} as never)) as {
      capabilities: Record<string, unknown>
    }
    expect(hello.capabilities['prepareProcessInvocation']).toBe(true)
    expect(hello.capabilities['resolveDesktopIdentity'] ?? false).toBe(false)
    expect(hello.capabilities['admitDesktopRegistration'] ?? false).toBe(false)
    expect(hello.capabilities['prepareDesktopObserver'] ?? false).toBe(false)
  })
})
