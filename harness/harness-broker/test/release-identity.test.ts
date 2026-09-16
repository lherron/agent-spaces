/**
 * Worker release identity at handshake (T-08539 W3). The release entrypoint's
 * identity must reach `broker.hello` on BOTH transports; a checkout broker
 * reports none.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrokerClient } from 'spaces-harness-broker-client'
import { SUPPORTED_BROKER_PROTOCOL_VERSIONS } from 'spaces-harness-broker-protocol'

const repoRoot = new URL('../../..', import.meta.url).pathname
const entry = 'harness/harness-broker/test/fixtures/release-entry/broker-with-release.ts'
const RELEASE = {
  releaseId: 'asp-0123456789ab-20260916T120000Z-abcdef',
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  builtAt: '2026-09-16T12:00:00.000Z',
}
const helloRequest = {
  clientInfo: { name: 'release-identity-test' },
  protocolVersions: [...SUPPORTED_BROKER_PROTOCOL_VERSIONS],
}

describe('broker.hello release identity', () => {
  test('stdio transport reports the release identity', async () => {
    const client = await BrokerClient.start({
      command: 'bun',
      args: [entry, 'run', '--transport', 'stdio'],
      cwd: repoRoot,
    })
    try {
      expect((await client.hello(helloRequest)).release).toEqual(RELEASE)
    } finally {
      await client.close()
    }
  })

  test('unix transport reports the release identity', async () => {
    const dir = mkdtempSync(join('/tmp', 'hb-rel-'))
    const socketPath = join(dir, 'b.sock')
    const proc = Bun.spawn({
      cmd: ['bun', entry, 'run', '--transport', 'unix', '--socket', socketPath],
      cwd: repoRoot,
      stdout: 'ignore',
      stderr: 'pipe',
    })
    try {
      const deadline = Date.now() + 5000
      let client: BrokerClient | undefined
      while (client === undefined) {
        try {
          client = await BrokerClient.connectUnix({ socketPath, timeoutMs: 200 })
        } catch (error) {
          if (Date.now() > deadline) throw error
          await Bun.sleep(25)
        }
      }
      try {
        expect((await client.hello(helloRequest)).release).toEqual(RELEASE)
      } finally {
        await client.close()
      }
    } finally {
      proc.kill('SIGTERM')
      await proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a checkout broker reports no release', async () => {
    const client = await BrokerClient.start({
      command: 'bun',
      args: ['harness/harness-broker/bin/harness-broker.js', 'run', '--transport', 'stdio'],
      cwd: repoRoot,
    })
    try {
      expect((await client.hello(helloRequest)).release).toBeUndefined()
    } finally {
      await client.close()
    }
  })
})
