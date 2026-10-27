import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { ASPC_COMPILE_METHODS, createAspcService } from 'spaces-aspc'
import { AspcUnixClient } from 'spaces-aspc-protocol/unix-client'
import { startAspdServer } from '../src/aspd.js'

interface RpcReply {
  result?: {
    interfaceVersion?: string
    buildVersion?: string
    capabilities?: Record<string, boolean>
    schemaVersion?: string
    ops?: Array<{ op: string; summary: string }>
  }
  error?: {
    code: number
    message: string
    data?: { reason: string; advice: string; issues?: unknown[] }
  }
}

// Failure modes: malformed/unknown requests bypass method wrappers, client
// attribution disappears after hello, diagnostic results log as successes,
// discovery drifts from registration, or instrumentation changes wire errors.
test('aspd discovery and L3 request lines cross the real socket boundary', async () => {
  const root = mkdtempSync('/tmp/asp-api-')
  const socketPath = `${root}/s.sock`
  const lines: string[] = []
  const server = await startAspdServer({
    socketPath,
    service: createAspcService(),
    log: (line) => lines.push(line),
  })
  const call = (body: string): Promise<RpcReply> =>
    new Promise((resolve, reject) => {
      const socket = connect(socketPath)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('10s timeout'))
      }, 10_000)
      let buffer = ''
      socket.on('connect', () => socket.write(body))
      socket.on('error', reject)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        if (!buffer.includes('\n')) return
        clearTimeout(timer)
        socket.destroy()
        resolve(JSON.parse(buffer.split('\n')[0]!))
      })
    })
  const rpc = (method: string, params: unknown = {}, client?: string) =>
    call(
      `${JSON.stringify({ jsonrpc: '2.0', id: method, method, params, ...(client ? { client } : {}) })}\n`
    )
  try {
    expect((await rpc('health')).result).toMatchObject({ ok: true, degraded: [] })
    const version = (await rpc('version')).result!
    expect(version.interfaceVersion).toBe('aspc/0.1')
    expect(typeof version.buildVersion).toBe('string')
    expect(version.capabilities).toMatchObject({ health: true, version: true, surface: true })
    const surface = (await rpc('surface')).result!
    expect(surface.schemaVersion).toBe('aspd-surface/v1')
    expect(surface.ops!.map((item: { op: string }) => item.op).sort()).toEqual(
      [...Object.values(ASPC_COMPILE_METHODS), 'health', 'version', 'surface'].sort()
    )
    expect(surface.ops!.every((item: { summary: string }) => item.summary.length > 0)).toBe(true)
    expect((await rpc('aspc.unknown', {}, 'api-test/1')).error).toMatchObject({
      code: -32601,
      data: {
        reason: 'op_unknown',
        advice: 'Call surface with params: {} to list valid operations.',
      },
    })
    // aspd serves only the compile plane: neither the retired cohosted compile-and-start
    // nor the broker's invocation.start is a route.
    for (const method of ['aspc.compileAndStart', 'invocation.start']) {
      expect((await rpc(method)).error).toMatchObject({
        code: -32601,
        data: { reason: 'op_unknown' },
      })
    }
    expect((await call('{bad-json}\n')).error).toMatchObject({
      code: -32700,
      data: { reason: 'parse_error' },
    })
    expect((await rpc('aspc.catalogAgentInspection', { typo: true })).error).toMatchObject({
      code: -32602,
      data: { reason: 'invalid_params', issues: expect.any(Array) },
    })
    expect((await rpc('health', { typo: true })).error!.message).toContain('typo')
    const client = await AspcUnixClient.connect({
      socketPath,
      clientInfo: { name: 'api-test', version: '1' },
      requestTimeoutMs: 10_000,
    })
    await client.catalogAgentInspection({ typo: true } as never).catch(() => undefined)
    await client.close()
    await Bun.sleep(30)
    const requests = lines
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === 'rpc.request')
    expect(requests).toHaveLength(11)
    expect(
      requests.filter(
        (line) =>
          line.data.op === 'aspc.catalogAgentInspection' && line.data.client === 'api-test/1'
      )
    ).toHaveLength(1)
    expect(requests.find((line) => line.data.op === 'aspc.hello')?.data.client).toBe('api-test/1')
    expect(requests.find((line) => line.data.op === 'aspc.unknown')).toMatchObject({
      component: 'rpc',
      level: 'warn',
      data: { listener: 'aspd', client: 'api-test/1', outcome: '-32601' },
    })
    expect(requests.find((line) => line.data.op === 'unmatched')?.data.outcome).toBe('-32700')
    expect(requests.find((line) => line.data.op === 'health')?.data.client).toBe('unknown')
    for (const line of requests) {
      expect(line.data.durationMs).toBeGreaterThanOrEqual(0)
      expect(line.data).not.toHaveProperty('params')
      expect(line.data).not.toHaveProperty('result')
    }
  } finally {
    await server.retire()
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)

// Failure modes: unbounded partial frames, early refusal followed by a second
// parse error for its tail, bytes counted as characters, empty frames ignored,
// or a refused frame poisoning the next request on the same connection.
test('aspd bounds frames, refuses empty frames, and recovers on the same socket', async () => {
  const root = mkdtempSync('/tmp/asp-bound-')
  const lines: string[] = []
  const socketPath = `${root}/s.sock`
  const server = await startAspdServer({
    socketPath,
    service: createAspcService(),
    log: (line) => lines.push(line),
  })
  const socket = connect(socketPath)
  const replies: RpcReply[] = []
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n')
      replies.push(JSON.parse(buffer.slice(0, end)))
      buffer = buffer.slice(end + 1)
    }
  })
  const next = async (): Promise<RpcReply> => {
    const until = Date.now() + 10_000
    while (replies.length === 0 && Date.now() < until) await Bun.sleep(5)
    expect(replies.length).toBeGreaterThan(0)
    return replies.shift()!
  }
  const frame = (padding = '') =>
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'hello',
      method: 'aspc.hello',
      client: 'frame-test/1',
      params: {
        clientInfo: { name: 'frame-test', version: '1' },
        protocolVersions: ['aspc/0.1'],
        padding,
      },
    })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(`${frame('x'.repeat(2 * 1024 * 1024))}\n`)
    expect((await next()).result).toBeDefined()
    // Exactly the byte limit is accepted, including multibyte text.
    const limit = 16 * 1024 * 1024
    const remainingBytes = limit - Buffer.byteLength(frame())
    const boundary = frame(
      'é'.repeat(Math.floor(remainingBytes / 2)) + 'x'.repeat(remainingBytes % 2)
    )
    expect(Buffer.byteLength(boundary)).toBe(limit)
    socket.write(`${boundary}\n`)
    expect((await next()).result).toBeDefined()
    // Cross the bound before the delimiter: refuse now, retain no oversized tail.
    socket.write(frame('x'.repeat(limit)))
    expect((await next()).error).toMatchObject({
      code: -32700,
      data: { reason: 'frame_too_large' },
    })
    socket.write(`discarded tail\n${frame()}\n`)
    expect((await next()).result).toBeDefined()
    const started = performance.now()
    socket.write('\n\r\n')
    for (let i = 0; i < 2; i++)
      expect((await next()).error).toMatchObject({ code: -32700, data: { reason: 'empty_frame' } })
    expect(performance.now() - started).toBeLessThan(1000)
    socket.write(`${frame()}\n`)
    expect((await next()).result).toBeDefined()
    await Bun.sleep(30)
    expect(replies).toHaveLength(0)
    const requests = lines
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === 'rpc.request')
    expect(requests).toHaveLength(7)
    expect(requests.filter((line) => line.data.outcome === '-32700')).toHaveLength(3)
    expect(requests.filter((line) => line.data.client === 'frame-test/1')).toHaveLength(4)
    expect(requests.filter((line) => line.data.client === 'unknown')).toHaveLength(3)
  } finally {
    socket.destroy()
    await server.retire()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
