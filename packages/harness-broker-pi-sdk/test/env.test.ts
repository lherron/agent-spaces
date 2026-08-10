import { expect, test } from 'bun:test'
import type { DriverContext } from 'spaces-harness-broker'
import type { HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import { composePiSdkEnvironment } from '../src/driver'

test('environment composition does not mutate broker process.env', () => {
  const priorApiKey = process.env.OPENAI_API_KEY
  const priorMarker = process.env.PI_SDK_ENV_TEST_MARKER
  process.env.OPENAI_API_KEY = 'test-secret'
  process.env.PI_SDK_ENV_TEST_MARKER = 'must-not-leak'
  const before = { ...process.env }
  try {
    const env = composePiSdkEnvironment(spec(), {
      dispatchEnv: Object.freeze({ ASP_RUN_ID: 'run-1' }) as DriverContext['dispatchEnv'],
    })
    expect(env.OPENAI_API_KEY).toBe('test-secret')
    expect(env.LOCKED_FLAG).toBe('locked')
    expect(env.ASP_RUN_ID).toBe('run-1')
    expect(env.PI_SDK_ENV_TEST_MARKER).toBeUndefined()
    expect(process.env).toEqual(before)
  } finally {
    if (priorApiKey === undefined) process.env.OPENAI_API_KEY = undefined
    else process.env.OPENAI_API_KEY = priorApiKey
    if (priorMarker === undefined) process.env.PI_SDK_ENV_TEST_MARKER = undefined
    else process.env.PI_SDK_ENV_TEST_MARKER = priorMarker
  }
})

function spec(): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    harness: { frontend: 'pi', provider: 'openai', driver: 'pi-sdk' },
    driver: { kind: 'pi-sdk', permissionPolicy: { mode: 'deny' } },
    sdk: { runtime: 'pi-sdk', provider: 'openai', modelId: 'gpt-4.1-nano' },
    process: {
      command: 'in-process',
      args: [],
      cwd: '/tmp',
      lockedEnv: { LOCKED_FLAG: 'locked' },
      harnessTransport: { kind: 'in-process' },
    },
  }
}
