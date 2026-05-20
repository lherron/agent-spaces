import { describe, expect, test } from 'bun:test'
import type { BrokerHelloResponse } from 'spaces-harness-broker-protocol'
import { expectResult, parseFrames, request } from './helpers'

describe('harness-broker CLI', () => {
  test('run --transport stdio responds to broker.hello over stdin', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', 'packages/harness-broker/bin/harness-broker.js', 'run', '--transport', 'stdio'],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: new URL('../../..', import.meta.url).pathname,
    })

    proc.stdin.write(
      request('hello-1', 'broker.hello', {
        clientInfo: { name: 'cli-smoke' },
        protocolVersions: ['harness-broker/0.1'],
      })
    )
    proc.stdin.end()

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')

    const [frame] = parseFrames(stdout)
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
})
