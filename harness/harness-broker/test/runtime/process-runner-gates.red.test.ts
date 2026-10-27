import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createCodexAppServerDriver } from '../../src/drivers/codex-app-server/driver'
import { invocationIdFrom } from '../ids'

describe('process runner transport gates', () => {
  test('a codex app-server spec with pty transport is refused at start with UnsupportedCapability', async () => {
    // The codex app-server invariant: its shared stdio runner never runs a pty.
    const broker = createBroker({ drivers: [createCodexAppServerDriver()] })
    await expect(
      broker.start({
        spec: {
          specVersion: 'harness-broker.invocation/v1',
          invocationId: invocationIdFrom('inv_codex_pty_refused'),
          harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
          process: {
            command: process.execPath,
            args: [join(import.meta.dir, '../fixtures/fake-codex/tool-calls.ts')],
            cwd: process.cwd(),
            harnessTransport: { kind: 'pty' },
            limits: { startupTimeoutMs: 5000, turnTimeoutMs: 5000, stopGraceMs: 500 },
          },
          interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'none' },
          driver: {
            kind: 'codex-app-server',
            resumeFallback: 'start-fresh',
            permissionPolicy: { mode: 'deny' },
          },
        },
      })
    ).rejects.toMatchObject({
      code: BrokerErrorCode.UnsupportedCapability,
      message: 'Unsupported harness transport: pty',
    })
  })
})
