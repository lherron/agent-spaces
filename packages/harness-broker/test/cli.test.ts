import { describe, expect, test } from 'bun:test'
import type { BrokerHelloResponse } from 'spaces-harness-broker-protocol'
import { expectError, expectResult, noopSpec, parseFrames, request } from './helpers'

const runBrokerStdio = () =>
  Bun.spawn({
    cmd: ['bun', 'packages/harness-broker/bin/harness-broker.js', 'run', '--transport', 'stdio'],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: new URL('../../..', import.meta.url).pathname,
  })

async function exchange(input: string) {
  const proc = runBrokerStdio()
  proc.stdin.write(input)
  proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  expect(exitCode).toBe(0)
  expect(stderr).toBe('')

  return parseFrames(stdout)
}

describe('harness-broker CLI', () => {
  test('run --transport stdio responds to broker.hello over stdin', async () => {
    const [frame] = await exchange(
      request('hello-1', 'broker.hello', {
        clientInfo: { name: 'cli-smoke' },
        protocolVersions: ['harness-broker/0.1'],
      })
    )

    const response = expectResult<BrokerHelloResponse>(frame, 'hello-1')
    expect(response.result).toMatchObject({
      brokerInfo: { name: 'harness-broker' },
      protocolVersion: 'harness-broker/0.1',
      capabilities: {
        multiInvocation: false,
        transports: ['stdio-jsonrpc-ndjson'],
        eventNotifications: true,
      },
    })
  })

  test.each([
    ['broker.hello', {}],
    ['broker.health', { probeDrivers: 'yes' }],
    ['invocation.start', {}],
    [
      'invocation.start',
      {
        spec: noopSpec({
          harness: { frontend: 'noop', provider: 'test', driver: 'noop-driver' },
          driver: { kind: 'codex-app-server' },
        }),
      },
    ],
    [
      'invocation.input',
      {
        invocationId: 'missing',
        input: { kind: 'bogus', content: [{ type: 'text', text: 'hello' }] },
      },
    ],
    ['invocation.interrupt', { scope: 'turn' }],
    ['invocation.stop', { reason: 'test' }],
    ['invocation.status', {}],
    ['invocation.dispose', {}],
  ])('run --transport stdio validates %s params before dispatch', async (method, params) => {
    const [frame] = await exchange(request(`invalid-${method}`, method, params))
    const response = expectError(frame, `invalid-${method}`, -32602)

    expect(response.error.message).toBe('Invalid params')
    const issues = (response.error.data as { issues?: unknown }).issues
    expect(Array.isArray(issues)).toBe(true)
    expect((issues as unknown[]).length).toBeGreaterThan(0)
  })

  test('run --transport stdio preserves malformed JSON recovery before validation errors', async () => {
    const frames = await exchange(
      `{not json}\n${request('invalid-after-parse', 'invocation.status', {})}`
    )

    expectError(frames[0], null, -32700)
    const response = expectError(frames[1], 'invalid-after-parse', -32602)
    expect(Array.isArray((response.error.data as { issues?: unknown }).issues)).toBe(true)
  })
})
