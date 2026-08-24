import { afterEach, describe, expect, test } from 'bun:test'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listenForHookEnvelopes } from '../../src/drivers/tmux-shared'

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('shared tmux hook listener', () => {
  test('close destroys held connections, settles promptly, and removes the socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmux-hook-listener-close-'))
    tempRoots.push(root)
    const socketPath = join(root, 'hook.sock')
    const listener = await listenForHookEnvelopes(socketPath, (_envelope) => undefined)
    const client = connect(socketPath)
    await once(client, 'connect')

    const closePromise = listener.close()
    try {
      const result = await Promise.race([
        closePromise.then(() => 'closed'),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
      ])
      expect(result).toBe('closed')
      await expect(access(socketPath)).rejects.toThrow()
    } finally {
      client.destroy()
      await closePromise
    }
  })
})
