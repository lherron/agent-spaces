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

test('oauth environment composition starves credential variables', () => {
  const priorOpenAiKey = process.env.OPENAI_API_KEY
  const priorAnthropicToken = process.env.ANTHROPIC_AUTH_TOKEN
  process.env.OPENAI_API_KEY = 'openai-secret'
  process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-secret'
  const before = { ...process.env }
  try {
    const env = composePiSdkEnvironment(spec('oauth'), {
      dispatchEnv: Object.freeze({
        HARNESS_PI_AUTH_STORE: '/managed/auth.json',
      }) as DriverContext['dispatchEnv'],
    })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.HARNESS_PI_AUTH_STORE).toBe('/managed/auth.json')
    expect(process.env).toEqual(before)
  } finally {
    if (priorOpenAiKey === undefined) process.env.OPENAI_API_KEY = undefined
    else process.env.OPENAI_API_KEY = priorOpenAiKey
    if (priorAnthropicToken === undefined) process.env.ANTHROPIC_AUTH_TOKEN = undefined
    else process.env.ANTHROPIC_AUTH_TOKEN = priorAnthropicToken
  }
})

function spec(authMode: 'api-key' | 'oauth' = 'api-key'): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    harness: { frontend: 'pi', provider: 'openai', driver: 'pi-sdk' },
    driver: { kind: 'pi-sdk', permissionPolicy: { mode: 'deny' } },
    sdk: { runtime: 'pi-sdk', provider: 'openai', modelId: 'gpt-4.1-nano', authMode },
    process: {
      command: 'in-process',
      args: [],
      cwd: '/tmp',
      lockedEnv: { LOCKED_FLAG: 'locked' },
      harnessTransport: { kind: 'in-process' },
    },
  }
}
