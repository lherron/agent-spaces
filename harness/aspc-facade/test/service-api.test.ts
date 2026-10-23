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
  error?: { code: number; message: string }
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
    expect((await rpc('aspc.unknown', {}, 'api-test/1')).error!.code).toBe(-32601)
    expect((await call('{bad-json}\n')).error!.code).toBe(-32700)
    expect((await rpc('aspc.catalogAgentInspection', { typo: true })).error).toMatchObject({
      code: -32602,
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
    expect(requests).toHaveLength(9)
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
