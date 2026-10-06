import { describe, expect, test } from 'bun:test'
import type { HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createArrisResidentDriver } from '../../../src/drivers/arris-resident/driver'
import { context, descriptor, spec } from './fixtures'

function withDriver(driver: Record<string, unknown>): HarnessInvocationSpec {
  return { ...spec(), driver: { ...spec().driver, ...driver } as HarnessInvocationSpec['driver'] }
}

describe('Arris resident start binding', () => {
  test.each([
    {
      name: 'a continuation is refused: a resident cannot resume a previous host incarnation',
      startSpec: { ...spec(), continuation: { provider: 'openai', key: 'thread-old' } },
      code: BrokerErrorCode.DispatchValidationFailed,
      message: 'arris-resident cannot resume a previous host incarnation',
    },
    {
      name: 'another driver kind is unavailable',
      startSpec: withDriver({ kind: 'codex-app-server' }),
      code: BrokerErrorCode.DriverUnavailable,
      message: 'Invalid Arris resident driver spec',
    },
    {
      name: 'a relative descriptor path is refused',
      startSpec: withDriver({ descriptorPath: 'host-descriptor.json' }),
      code: BrokerErrorCode.DispatchValidationFailed,
      message: 'arris-resident descriptorPath must be absolute',
    },
    {
      name: 'an empty host incarnation is refused',
      startSpec: withDriver({ hostIncarnationId: '' }),
      code: BrokerErrorCode.DispatchValidationFailed,
      message: 'arris-resident hostIncarnationId is required',
    },
    {
      name: 'an unknown lifecycle owner is refused',
      startSpec: withDriver({ hostLifecycleOwner: 'someone' }),
      code: BrokerErrorCode.DispatchValidationFailed,
      message: 'arris-resident hostLifecycleOwner is invalid',
    },
    {
      name: 'a non-string launch id is refused',
      startSpec: withDriver({ launchId: 7 }),
      code: BrokerErrorCode.DispatchValidationFailed,
      message: 'arris-resident launchId must be a string or null',
    },
    {
      name: 'a descriptor owned by another lifecycle owner is a binding conflict',
      startSpec: withDriver({ hostLifecycleOwner: 'hrc-managed' }),
      code: BrokerErrorCode.IdentityInstallConflict,
      message: 'Arris host lifecycle owner does not match prepared binding',
    },
    {
      name: 'a descriptor from another launch is a binding conflict',
      startSpec: withDriver({ launchId: 'launch-other' }),
      code: BrokerErrorCode.IdentityInstallConflict,
      message: 'Arris host launch id does not match prepared binding',
    },
  ])('$name', async ({ startSpec, code, message }) => {
    let descriptorReads = 0
    const driver = createArrisResidentDriver({
      pollIntervalMs: 60_000,
      readDescriptor: async () => {
        descriptorReads += 1
        return descriptor()
      },
    })
    await expect(driver.start(startSpec, context([]))).rejects.toMatchObject({ code, message })
    // Spec refusals happen before the descriptor is read; binding conflicts after.
    expect(descriptorReads).toBe(code === BrokerErrorCode.IdentityInstallConflict ? 1 : 0)
    await driver.dispose()
  })

  test('an invalid descriptor is refused with its validation issues', async () => {
    const driver = createArrisResidentDriver({
      pollIntervalMs: 60_000,
      readDescriptor: async () => ({ schema: 'arris.host-descriptor/1' }),
    })
    const failure = driver.start(spec(), context([]))
    await expect(failure).rejects.toMatchObject({
      code: BrokerErrorCode.DispatchValidationFailed,
      message: 'Invalid Arris host descriptor',
    })
    await driver.dispose()
  })
})
