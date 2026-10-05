/**
 * R-00307 follow-on: a wedged aspd must not hang its client. The hello shares
 * the connect deadline, and `requestTimeoutMs` bounds every later request.
 * Each expiry closes the client socket, which the real listener observes.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Client from '../src/unix-client.js'

const HELLO = {
  protocolVersion: 'aspc/0.1',
  serverInfo: { name: 'fake-aspd' },
  capabilities: {},
}

type Fake = { socketPath: string; closedSockets: () => number; close: () => Promise<void> }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

/** A real unix-socket listener that answers only the methods in `answer`. */
async function fakeAspd(answer: Set<string>): Promise<Fake> {
  const dir = mkdtempSync(join(tmpdir(), 'aspc-dl-'))
  const socketPath = join(dir, 's.sock')
  let closed = 0
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      closed += 1
      sockets.delete(socket)
    })
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk.toString()
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const msg = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        if (!answer.has(msg.method)) continue
        const result = msg.method === 'aspc.hello' ? HELLO : { ok: true }
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  const fake = {
    socketPath,
    closedSockets: () => closed,
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
  cleanups.push(fake.close)
  return fake
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10)
}

const DECLARATION = { schemaVersion: 'aspc-resolve-runtime-declaration-request/v1' } as never

describe('AspcUnixClient deadlines', () => {
  test('connect rejects with a timeout when hello is never answered, and closes the socket', async () => {
    const fake = await fakeAspd(new Set())
    const started = performance.now()
    const error = await Client.AspcUnixClient.connect({
      socketPath: fake.socketPath,
      clientInfo: { name: 'test' },
      timeoutMs: 200,
    }).catch((e: unknown) => e)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(error).toBeInstanceOf(Client.AspcRequestTimeoutError)
    expect((error as Client.AspcRequestTimeoutError).code).toBe('aspc_request_timeout')
    expect((error as Client.AspcRequestTimeoutError).method).toBe('aspc.hello')
    await waitFor(() => fake.closedSockets() === 1)
    expect(fake.closedSockets()).toBe(1)
  })

  test('requestTimeoutMs rejects an unanswered request and closes the socket', async () => {
    const fake = await fakeAspd(new Set(['aspc.hello']))
    const client = await Client.AspcUnixClient.connect({
      socketPath: fake.socketPath,
      clientInfo: { name: 'test' },
      requestTimeoutMs: 200,
    })
    const error = await client.resolveRuntimeDeclaration(DECLARATION).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Client.AspcRequestTimeoutError)
    expect((error as Client.AspcRequestTimeoutError).method).toBe('aspc.resolveRuntimeDeclaration')
    await waitFor(() => fake.closedSockets() === 1)
    expect(fake.closedSockets()).toBe(1)
  })

  test('answered requests are unaffected by the deadlines', async () => {
    const fake = await fakeAspd(new Set(['aspc.hello', 'aspc.resolveRuntimeDeclaration']))
    const client = await Client.AspcUnixClient.connect({
      socketPath: fake.socketPath,
      clientInfo: { name: 'test' },
      timeoutMs: 200,
      requestTimeoutMs: 200,
    })
    expect(client.hello.protocolVersion).toBe('aspc/0.1')
    await Bun.sleep(300)
    expect(await client.resolveRuntimeDeclaration(DECLARATION)).toEqual({ ok: true } as never)
    expect(fake.closedSockets()).toBe(0)
    await client.close()
  })
})
