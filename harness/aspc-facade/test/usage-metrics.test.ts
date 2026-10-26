import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { createAspcService } from 'spaces-aspc'
import { createUsageMetrics } from 'spaces-config/usage-metrics'
import { aspdVarRoot, startAspdServer } from '../src/aspd.js'

// Failure modes: metrics change a reply byte, a refused or unknown op goes
// uncounted, counts are sampled instead of exact, a connection's request count
// is lost, a broken metrics dir reaches a caller, or a metrics warning leaves
// the L2 frame (log-format reads aspd's logs).

const SCRIPT = [
  // One connection carrying several requests, then one-request connections.
  [
    {
      method: 'aspc.hello',
      params: { clientInfo: { name: 'm', version: '1' }, protocolVersions: ['aspc/0.1'] },
      client: 'metrics-test/1',
    },
    { method: 'health', params: {}, client: 'metrics-test/1' },
    { method: 'surface', params: {}, client: 'metrics-test/1' },
  ],
  [{ method: 'aspc.retired', params: {}, client: 'metrics-test/1' }],
  [{ method: 'health', params: { typo: true }, client: 'metrics-test/1' }],
  [{ method: 'health', params: {} }],
  [{ raw: '{bad-json}' }],
] as const

/** Every reply frame, per connection, exactly as received. */
async function drive(socketPath: string): Promise<string[][]> {
  const out: string[][] = []
  for (const requests of SCRIPT) {
    out.push(
      await new Promise<string[]>((resolve, reject) => {
        const socket = connect(socketPath)
        const timer = setTimeout(() => reject(new Error('timeout')), 10_000)
        const frames: string[] = []
        let buffer = ''
        socket.on('error', reject)
        socket.on('connect', () => {
          for (const [index, request] of requests.entries()) {
            socket.write(
              'raw' in request
                ? `${request.raw}\n`
                : `${JSON.stringify({ jsonrpc: '2.0', id: index + 1, ...request })}\n`
            )
          }
        })
        socket.on('data', (chunk) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          frames.push(...lines)
          if (frames.length === requests.length) {
            clearTimeout(timer)
            socket.end()
            socket.once('close', () => resolve(frames))
          }
        })
      })
    )
  }
  return out
}

async function serve(
  root: string,
  metricsDir: string | undefined
): Promise<{ replies: string[][]; lines: string[]; dropped: number }> {
  const socketPath = join(root, `${metricsDir ? 'm' : 'n'}.sock`)
  const lines: string[] = []
  const log = (line: string) => lines.push(line)
  const metrics = metricsDir
    ? createUsageMetrics({
        component: 'aspd',
        product: 'aspd/test',
        dir: metricsDir,
        warn: (event, data) =>
          log(
            JSON.stringify({
              ts: new Date().toISOString(),
              level: 'warn',
              component: 'metrics',
              event,
              data,
            })
          ),
      })
    : undefined
  const server = await startAspdServer({ socketPath, service: createAspcService(), log, metrics })
  try {
    const replies = await drive(socketPath)
    await Bun.sleep(30)
    await metrics?.flush()
    return { replies, lines, dropped: metrics?.dropped() ?? 0 }
  } finally {
    await server.retire()
  }
}

const rpcLines = (lines: string[]) =>
  lines
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((line) => line.event === 'rpc.request')
    .map(({ ts: _ts, data: { durationMs: _d, ...data }, ...rest }) => ({ ...rest, data }))

test('aspd request and connection metrics are exact, additive and reply-neutral', async () => {
  const root = mkdtempSync('/tmp/asp-metrics-')
  try {
    const metricsDir = join(root, 'metrics')
    const plain = await serve(root, undefined)
    const metered = await serve(root, metricsDir)

    // Replies and L3 lines are byte-identical with and without metrics.
    expect(metered.replies).toEqual(plain.replies)
    expect(rpcLines(metered.lines)).toEqual(rpcLines(plain.lines))

    const [file] = readdirSync(metricsDir)
    expect(file).toMatch(/^aspd-\d{4}-\d{2}-\d{2}\.ndjson$/)
    const rows = readFileSync(join(metricsDir, file as string), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const requests = rows.filter((row) => row.kind === 'request')
    const byKey = (op: string, outcome: string, client = 'metrics-test/1') =>
      requests.filter((row) => row.op === op && row.outcome === outcome && row.client === client)
    expect(byKey('aspc.hello', 'ok')).toMatchObject([{ count: 1, product: 'aspd/test' }])
    expect(byKey('health', 'ok')[0]?.count).toBe(1)
    expect(byKey('health', 'ok', 'unknown')[0]?.count).toBe(1)
    expect(byKey('health', '-32602')[0]?.count).toBe(1)
    expect(byKey('aspc.retired', '-32601')[0]?.count).toBe(1)
    expect(byKey('unmatched', '-32700', 'unknown')[0]?.count).toBe(1)
    expect(requests.reduce((sum, row) => sum + row.count, 0)).toBe(7)
    for (const row of requests) {
      expect(row).toMatchObject({ v: 1, component: 'aspd' })
      expect(row.msSum).toBeGreaterThanOrEqual(0)
      expect(row.replyBytesSum).toBeGreaterThan(0)
      expect(Object.keys(row)).not.toContain('params')
    }
    const connections = rows.filter((row) => row.kind === 'connection')
    expect(connections.reduce((sum, row) => sum + row.count, 0)).toBe(5)
    expect(connections.find((row) => row.client === 'metrics-test/1')).toMatchObject({
      count: 3,
      requestsSum: 5,
      requestsMax: 3,
    })
    expect(connections.find((row) => row.client === 'unknown')).toMatchObject({
      count: 2,
      requestsSum: 2,
      requestsMax: 1,
    })

    // An unwritable metrics dir changes nothing a caller sees.
    const brokenDir = join(root, 'broken')
    mkdirSync(brokenDir)
    chmodSync(brokenDir, 0o500)
    const broken = await serve(root, brokenDir)
    chmodSync(brokenDir, 0o755)
    expect(broken.replies).toEqual(plain.replies)
    expect(rpcLines(broken.lines)).toEqual(rpcLines(plain.lines))
    expect(broken.dropped).toBeGreaterThan(0)
    expect(readdirSync(brokenDir)).toEqual([])
    const warnings = broken.lines
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .filter((line) => line.component === 'metrics')
    expect(warnings).toMatchObject([{ level: 'warn', event: 'metrics.write_failed' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test('aspd derives the var root from its namespaced release', () => {
  expect(aspdVarRoot('/Users/x/praesidium/var/aspd/releases/asp-abc')).toBe(
    '/Users/x/praesidium/var'
  )
  expect(aspdVarRoot('/tmp/build/asp-abc')).toBeUndefined()
})
