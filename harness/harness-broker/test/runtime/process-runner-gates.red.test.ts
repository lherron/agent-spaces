import { describe, expect, test } from 'bun:test'
import type { HarnessProcessSpec } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { spawnHarnessProcess } from '../../src/runtime/process-runner'

const baseProcessSpec = (overrides: Partial<HarnessProcessSpec>): HarnessProcessSpec => ({
  command: Bun.execPath,
  args: ['--version'],
  cwd: process.cwd(),
  harnessTransport: { kind: 'jsonrpc-stdio' },
  ...overrides,
})

describe('process runner transport gates RED', () => {
  test('keeps the codex app-server invariant by rejecting pty transport on the shared stdio runner', async () => {
    await expect(
      spawnHarnessProcess(baseProcessSpec({ harnessTransport: { kind: 'pty' } }))
    ).rejects.toMatchObject({
      code: BrokerErrorCode.UnsupportedCapability,
      message: 'Unsupported harness transport: pty',
    })
  })
})
