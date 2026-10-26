#!/usr/bin/env bun
/**
 * Scratch E2E for R1 Front door (T-11835, docs/proposals/aspd-rust-front-door.md).
 *
 * Builds a real release (raspd beside the Bun binaries) from a clean clone of
 * --commit, or reuses --release, installs it into an isolated aspd namespace,
 * and fronts it with `aspd-service front-door-enable`. Then:
 *
 *  1. Unchanged clients work through raspd: the TS `AspcUnixClient` (HRC's),
 *     rusthrc's `AspSession` (hrc-runtime's own preparation E2E with
 *     HRC_ASPD_SOCKET on raspd) and `avs aspc`. The native methods are
 *     served natively, everything else by Bun (raspd.log `servedBy`).
 *  2. Reconciliation per op over a closed, drained window: relayed <= Bun total
 *     <= relayed + upstream_failed. Once with no upstream failures (equality),
 *     once with Bun stopped mid-run (upstream_failed > 0, bounds hold). Each
 *     process writes only its own files.
 *  3. Rollback (`front-door-disable`) puts Bun back on the public socket and
 *     the same clients keep working.
 *  4. `version` names raspd's own source commit; a plain proxy in front of Bun
 *     fails that check.
 *  5. Native hello/health never stall behind in-flight forwarded compiles, nor
 *     behind an upstream that never answers.
 * The kernel document is read once (release and per-op counts). cardo's wire
 * suite (condition 6) runs separately against the kernel socket.
 *
 * Usage: bun scripts/raspd-front-door-e2e.ts [--out <dir>] [--commit <sha>]
 *          [--release <built release dir>] [--rusthrc <binary>]
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { type Server, type Socket, connect, createServer } from 'node:net'
import { basename, join, resolve } from 'node:path'
import { AspcUnixClient } from 'spaces-aspc-protocol/unix-client'
import { isolateUsageMetrics } from './lib/usage-metrics-isolation.ts'
import { ROWS, compileRequest, createFixture } from './path-markers-e2e.ts'

isolateUsageMetrics()

const repo = resolve(import.meta.dir, '..')

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function run(command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command[0] as string, command.slice(1), {
    cwd: options.cwd ?? repo,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function must(command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = run(command, options)
  if (result.status !== 0) {
    throw new Error(
      `${command.join(' ')} exited ${result.status}\n${result.stderr}${result.stdout}`
    )
  }
  return result.stdout
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z')
const out = resolve(
  arg('--out') ?? join(repo, '..', 'var', 'wrkq-artifacts', 'T-11835', 'e2e', stamp)
)
mkdirSync(out, { recursive: true })
// Unix socket paths are limited to 104 bytes on macOS; keep the scratch root short.
const scratch = mkdtempSync('/tmp/rfd-')
const ns = join(scratch, 'ns')
const publicSocket = join(ns, 'run', 'aspd.sock')
const bunSocket = join(ns, 'run', 'aspd-bun.sock')
const kernelSocket = join(ns, 'run', 'raspd-kernel.sock')
const service = (...args: string[]) =>
  JSON.parse(must(['bun', join(repo, 'scripts', 'aspd-service.ts'), ...args])) as Record<
    string,
    unknown
  >
const AVS = join(repo, 'spaces', 'verify-agent-spaces', 'skills', 'verify-agent-spaces', 'avs')
const RUSTHRC =
  arg('--rusthrc') ?? join(repo, 'crates', 'target', 'hrc-runtime', 'debug', 'rusthrc')
const HRC_RUNTIME = resolve(repo, '..', 'hrc-runtime')

type Check = { name: string; ok: boolean; detail?: unknown }
const checks: Check[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
}
const record = (name: string, value: unknown) =>
  writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`)

// -- release --------------------------------------------------------------------

let builtRelease = arg('--release')
let commit = arg('--commit') ?? 'HEAD'
if (builtRelease === undefined) {
  commit = must(['git', 'rev-parse', commit]).trim()
  const src = join(scratch, 'src')
  must(['git', 'clone', '-q', repo, src])
  must(['git', 'checkout', '-q', commit], { cwd: src })
  must(['bun', 'install', '--frozen-lockfile'], { cwd: src })
  const built = JSON.parse(
    must(['bun', 'scripts/asp-release.ts', 'build', '--output-root', join(scratch, 'builds')], {
      cwd: src,
    })
  ) as { releasePath: string }
  builtRelease = built.releasePath
}
const releaseId = basename(builtRelease)
service('init', ns)
must([
  'bun',
  join(repo, 'scripts', 'asp-release.ts'),
  'install',
  '--artifact',
  builtRelease,
  '--release-root',
  join(ns, 'releases'),
])
const releasePath = join(ns, 'releases', releaseId)
const manifest = JSON.parse(readFileSync(join(releasePath, 'release.json'), 'utf8')) as {
  sourceCommit: string
  executables: Record<string, { runtimeClosure: string }>
}
check(
  'the release carries raspd as a cargo-native executable',
  manifest.executables['raspd']?.runtimeClosure === 'cargo-native',
  manifest.executables['raspd']
)

// -- fixture and namespace config -----------------------------------------------

const asp = {
  config: await import('spaces-config'),
  contracts: await import('spaces-runtime-contracts'),
} as unknown as Parameters<typeof createFixture>[0]
const fixture = createFixture(asp, join(scratch, 'fx'))
const configPath = join(ns, 'service', 'config.json')
const setMetricsRoot = (root: string) => {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { env: Record<string, string> }
  config.env = {
    ...config.env,
    ASP_HOME: fixture.aspHome,
    ASP_AGENTS_ROOT: fixture.agentsRoot,
    ASP_USAGE_METRICS_VAR_ROOT: root,
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}
const window1 = join(scratch, 'metrics-w1')
setMetricsRoot(window1)
service('activate', ns, releaseId)
const enabled = service('front-door-enable', ns)
record('front-door-enable.json', enabled)
const enabledStatus = enabled['status'] as Record<string, unknown>
check(
  'front-door-enable: raspd on aspd.sock, Bun on aspd-bun.sock, same release',
  enabledStatus['mode'] === 'fronted' &&
    (enabledStatus['publicFrontDoor'] as { name?: string } | null)?.name === 'raspd' &&
    enabledStatus['bunAnswering'] === true &&
    (enabledStatus['publicRelease'] as { releaseId?: string })?.releaseId === releaseId &&
    (enabledStatus['bunRelease'] as { releaseId?: string })?.releaseId === releaseId,
  enabledStatus
)

// -- rpc helpers ----------------------------------------------------------------

type Reply = Record<string, unknown>
const CLIENT = 'raspd-e2e/1'

/** Send frames on one connection; resolve with every reply in arrival order. */
async function send(
  socketPath: string,
  frames: Record<string, unknown>[],
  timeoutMs = 120_000
): Promise<Reply[]> {
  return await new Promise((done, reject) => {
    const socket = connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`rpc timeout on ${socketPath}`))
    }, timeoutMs)
    const got: Reply[] = []
    let buffer = ''
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('connect', () => {
      frames.forEach((frame, index) =>
        socket.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: index + 1, client: CLIENT, ...frame })}\n`
        )
      )
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      got.push(...lines.map((line) => JSON.parse(line) as Reply))
      if (got.length >= frames.length) {
        clearTimeout(timer)
        socket.end()
        socket.once('close', () => done(got))
      }
    })
  })
}

const HELLO = {
  method: 'aspc.hello',
  params: { clientInfo: { name: 'raspd-e2e', version: '1' }, protocolVersions: ['aspc/0.1'] },
}
const compileFrame = (row: (typeof ROWS)[number], tag: string) => ({
  method: 'aspc.compileHarnessInvocation',
  params: { compileRequest: compileRequest(asp, fixture, { ...row, id: `${row.id}-${tag}` }) },
})
// Rows whose harness binaries this node may not carry still answer (ok:false).
const compileRows = ROWS.filter((row) => row.requested.harness !== 'codex')
const declarationParams = {
  schemaVersion: 'aspc-resolve-runtime-declaration-request/v1',
  context: {
    agentId: 'pathmark',
    agentRoot: join(fixture.agentsRoot, 'pathmark'),
    project: { mode: 'root', projectRoot: fixture.projectRoot },
    cwd: fixture.projectRoot,
    runMode: 'task',
  },
}

const readLines = (path: string): Record<string, unknown>[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []

// -- 1. unchanged clients through raspd -----------------------------------------

const tsClient = await AspcUnixClient.connect({
  socketPath: publicSocket,
  clientInfo: { name: 'hrc-server', version: 'raspd-e2e' },
  timeoutMs: 120_000,
})
const tsDeclaration = await tsClient.resolveRuntimeDeclaration(declarationParams as never)
const tsCompiles = []
for (const row of compileRows) {
  tsCompiles.push(
    await tsClient.compileHarnessInvocation({
      compileRequest: compileRequest(asp, fixture, { ...row, id: `${row.id}-ts` }),
    } as never)
  )
}
await tsClient.close()
record('client-ts.json', {
  hello: tsClient.hello,
  declaration: tsDeclaration,
  compiles: tsCompiles,
})
check(
  'TS AspcUnixClient: hello admits, resolve and every compile row answer through raspd',
  tsClient.hello.release?.releaseId === releaseId &&
    typeof tsDeclaration === 'object' &&
    tsCompiles.length === compileRows.length &&
    tsCompiles.some((c) => (c as { ok?: boolean }).ok === true),
  { okCompiles: tsCompiles.filter((c) => (c as { ok?: boolean }).ok === true).length }
)

const avsRuns: Record<string, unknown> = {}
for (const [method, params] of [
  ['aspc.hello', undefined],
  ['health', '{}'],
  ['surface', '{}'],
  ['version', '{}'],
  ['aspc.resolveRuntimeDeclaration', JSON.stringify(declarationParams)],
] as const) {
  const result = run([AVS, 'aspc', publicSocket, method, ...(params === undefined ? [] : [params])])
  avsRuns[method] = {
    status: result.status,
    stdout: result.stdout.slice(0, 4000),
    stderr: result.stderr,
  }
}
record('client-avs.json', avsRuns)
check(
  'avs aspc: hello, health, surface, version and a resolve all answer through raspd',
  Object.values(avsRuns).every((r) => (r as { status: number }).status === 0) &&
    String((avsRuns['version'] as { stdout: string }).stdout).includes('"frontDoor"'),
  Object.fromEntries(Object.entries(avsRuns).map(([k, v]) => [k, (v as { status: number }).status]))
)

if (existsSync(RUSTHRC)) {
  const rusthrcOut = join(out, 'rusthrc-preparation')
  const prep = run(
    [
      'python3',
      join(HRC_RUNTIME, 'crates', 'hrc-native', 'e2e', 'preparation.py'),
      '--binary',
      RUSTHRC,
      '--aspd-socket',
      publicSocket,
      '--artifacts',
      rusthrcOut,
    ],
    { cwd: HRC_RUNTIME }
  )
  writeFileSync(join(out, 'rusthrc-preparation.log'), `${prep.stdout}\n${prep.stderr}`)
  check(
    "rusthrc AspSession (hrc-runtime preparation E2E, HRC_ASPD_SOCKET=raspd's aspd.sock) passes",
    prep.status === 0,
    {
      binary: RUSTHRC,
      hrcRuntimeHead: must(['git', '-C', HRC_RUNTIME, 'rev-parse', 'HEAD']).trim(),
      exit: prep.status,
      tail: `${prep.stdout}${prep.stderr}`.slice(-1500),
    }
  )
} else {
  check('rusthrc AspSession through raspd', false, `no rusthrc binary at ${RUSTHRC}`)
}

// -- 5. native methods never stall behind forwarded work ---------------------------

const timed = async (frame: Record<string, unknown>) => {
  const started = performance.now()
  await send(publicSocket, [frame], 30_000)
  return performance.now() - started
}
const burstStarted = performance.now()
const burst = compileRows.flatMap((row, i) =>
  [0, 1].map((n) => {
    const t0 = performance.now()
    return send(publicSocket, [compileFrame(row, `burst${i}-${n}`)]).then(
      () => performance.now() - t0
    )
  })
)
// One connection carrying a compile and then natives behind it on the same socket.
const sameConnection = (async () => {
  const replies: { id: unknown; at: number }[] = []
  await new Promise<void>((done, reject) => {
    const socket = connect(publicSocket)
    let buffer = ''
    const t0 = performance.now()
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 'compile', client: CLIENT, ...compileFrame(compileRows[0] as never, 'same') })}\n`
      )
      for (let i = 0; i < 5; i++) {
        socket.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: `health-${i}`, client: CLIENT, method: 'health', params: {} })}\n`
        )
        socket.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: `hello-${i}`, client: CLIENT, ...HELLO })}\n`
        )
      }
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        replies.push({ id: (JSON.parse(line) as Reply)['id'], at: performance.now() - t0 })
      }
      if (replies.length >= 11) {
        socket.end()
        done()
      }
    })
  })
  return replies
})()
const nativeLatencies: number[] = []
while (performance.now() - burstStarted < 1_500) {
  nativeLatencies.push(await timed({ method: 'health', params: {} }))
  nativeLatencies.push(await timed(HELLO))
}
const compileLatencies = await Promise.all(burst)
const sameReplies = await sameConnection
const compileAt = sameReplies.find((r) => r.id === 'compile')?.at ?? 0
const nativesAt = sameReplies.filter((r) => r.id !== 'compile').map((r) => r.at)
record('concurrency.json', { nativeLatencies, compileLatencies, sameReplies })
const maxNative = Math.max(...nativeLatencies)
check(
  'natives answer promptly on new connections while forwarded compiles are in flight',
  maxNative < 200 && Math.max(...compileLatencies) > maxNative,
  {
    maxNativeMs: maxNative,
    natives: nativeLatencies.length,
    maxCompileMs: Math.max(...compileLatencies),
  }
)
check(
  'on one connection, natives behind an in-flight compile answer before it',
  nativesAt.length === 10 && Math.max(...nativesAt) < compileAt,
  { compileAtMs: compileAt, lastNativeAtMs: Math.max(...nativesAt) }
)

// A raspd fronting an upstream that accepts and never answers.
const blackHoleDir = join(scratch, 'bh')
mkdirSync(blackHoleDir, { recursive: true })
const held: Socket[] = []
const blackHole: Server = createServer((socket) => {
  held.push(socket)
  socket.on('data', () => {})
})
await new Promise<void>((done) => blackHole.listen(join(blackHoleDir, 'never.sock'), done))
const bhSocket = join(blackHoleDir, 'aspd.sock')
const bhRaspd = spawn(
  join(releasePath, 'raspd'),
  [
    'serve',
    '--socket',
    bhSocket,
    '--upstream',
    join(blackHoleDir, 'never.sock'),
    '--log',
    join(blackHoleDir, 'raspd.log'),
  ],
  {
    env: {
      HOME: process.env['HOME'] as string,
      PATH: process.env['PATH'] as string,
      ASP_USAGE_METRICS_VAR_ROOT: join(blackHoleDir, 'metrics'),
    },
    stdio: 'ignore',
  }
)
for (let i = 0; i < 100 && !existsSync(bhSocket); i++) await Bun.sleep(50)
const stalled = await new Promise<{ id: unknown; at: number }[]>((done, reject) => {
  const socket = connect(bhSocket)
  const replies: { id: unknown; at: number }[] = []
  let buffer = ''
  const t0 = performance.now()
  socket.on('error', reject)
  socket.on('connect', () => {
    socket.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 'never', method: 'aspc.compileHarnessInvocation', params: {} })}\n`
    )
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'hello', ...HELLO })}\n`)
    socket.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 'health', method: 'health', params: {} })}\n`
    )
  })
  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines)
      replies.push({ id: (JSON.parse(line) as Reply)['id'], at: performance.now() - t0 })
    if (replies.length >= 2) {
      setTimeout(() => {
        socket.destroy()
        done(replies)
      }, 300)
    }
  })
})
bhRaspd.kill('SIGTERM')
for (const socket of held) socket.destroy()
blackHole.close()
record('concurrency-stalled-upstream.json', stalled)
check(
  'natives answer while a forwarded request on the same connection is never answered',
  stalled.length === 2 && stalled.every((r) => r.id !== 'never' && r.at < 200),
  stalled
)

// -- 4. version names raspd itself; a plain proxy fails that check -------------------

const versionCheck = (reply: Reply) => {
  const result = reply['result'] as Record<string, unknown> | undefined
  const front = result?.['frontDoor'] as { name?: unknown; sourceCommit?: unknown } | undefined
  return front?.name === 'raspd' && front.sourceCommit === manifest.sourceCommit
}
const [publicVersion] = await send(publicSocket, [{ method: 'version', params: {} }])
const [bunVersion] = await send(bunSocket, [{ method: 'version', params: {} }])
const proxySocket = join(scratch, 'proxy.sock')
const proxy = createServer((client) => {
  const upstream = connect(bunSocket)
  client.pipe(upstream)
  upstream.pipe(client)
  client.on('error', () => upstream.destroy())
  upstream.on('error', () => client.destroy())
})
await new Promise<void>((done) => proxy.listen(proxySocket, done))
const [proxyVersion] = await send(proxySocket, [{ method: 'version', params: {} }])
proxy.close()
record('version.json', { publicVersion, bunVersion, proxyVersion })
check(
  "version on raspd names raspd's own source commit",
  versionCheck(publicVersion as Reply),
  (publicVersion as Reply)['result']
)
check(
  'the same check fails for Bun direct and for a plain proxy in front of Bun',
  !versionCheck(bunVersion as Reply) && !versionCheck(proxyVersion as Reply)
)

// -- kernel document --------------------------------------------------------------

const kernel = async (op: string, args: Record<string, unknown>) =>
  await new Promise<Reply>((done, reject) => {
    const socket = connect(kernelSocket)
    let buffer = ''
    socket.on('error', reject)
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'k', op, args })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline !== -1) {
        socket.end()
        done(JSON.parse(buffer.slice(0, newline)) as Reply)
      }
    })
  })
await Bun.sleep(1_500)
const inspected = (await kernel('document.inspect', { document_id: 'aspd' }))['result'] as {
  bootstrapping: boolean
  nodes: { type: string; payload: Record<string, unknown> }[]
}
record('kernel-document.json', inspected)
const serviceNode = inspected.nodes.find((n) => n.type === 'aspd.service')
const opNodes = inspected.nodes.filter((n) => n.type === 'aspd.op')
const compileNode = opNodes.find((n) => n.payload['op'] === 'aspc.compileHarnessInvocation')
check(
  'kernel document shows the serving release and native vs forwarded counts',
  inspected.bootstrapping === false &&
    serviceNode?.payload['releaseId'] === releaseId &&
    (opNodes.find((n) => n.payload['op'] === 'health')?.payload['native'] as number) > 0 &&
    (compileNode?.payload['relayed'] as number) > 0 &&
    inspected.nodes.some((n) => n.type === 'aspd.compile'),
  { service: serviceNode?.payload, ops: opNodes.map((n) => n.payload) }
)

// -- served-by split (raspd.log) ----------------------------------------------------

const NATIVE = new Set(['aspc.hello', 'health', 'version', 'surface', 'unmatched'])
const logDir = join(ns, 'logs')
const raspdRequests = () =>
  readLines(join(logDir, 'raspd.log')).filter((l) => l['event'] === 'rpc.request')

// -- 2. reconciliation ------------------------------------------------------------

type Counts = Map<string, { relayed: number; failed: number; native: number; bun: number }>
function windowCounts(root: string): { counts: Counts; files: Record<string, string[]> } {
  const dir = join(root, 'state', 'agent-spaces', 'metrics')
  const counts: Counts = new Map()
  const files: Record<string, string[]> = {}
  const slot = (op: string) => {
    let s = counts.get(op)
    if (s === undefined) {
      s = { relayed: 0, failed: 0, native: 0, bun: 0 }
      counts.set(op, s)
    }
    return s
  }
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const rows = readLines(join(dir, name))
    files[name] = [...new Set(rows.map((r) => `${r['component']}:${r['host']}`))]
    for (const row of rows) {
      if (row['kind'] !== 'request') continue
      const n = row['count'] as number
      const s = slot(row['op'] as string)
      if (row['component'] === 'raspd') {
        if (row['servedBy'] === 'native') s.native += n
        else if (row['relay'] === 'relayed') s.relayed += n
        else if (row['relay'] === 'upstream_failed') s.failed += n
      } else if (row['component'] === 'aspd') {
        s.bun += n
      }
    }
  }
  return { counts, files }
}
function reconcile(name: string, root: string, expectFailures: boolean) {
  const { counts, files } = windowCounts(root)
  const perOp = Object.fromEntries(counts)
  const forwarded = [...counts].filter(([op]) => !NATIVE.has(op))
  const bounded = forwarded.every(([, s]) => s.relayed <= s.bun && s.bun <= s.relayed + s.failed)
  const equal = forwarded.every(([, s]) => s.failed > 0 || s.relayed === s.bun)
  const failures = forwarded.reduce((sum, [, s]) => sum + s.failed, 0)
  // A row's `host` names the process that wrote it: raspd's files hold only
  // raspd rows, and no other file (Bun's aspd and paths days) holds one.
  const disjoint = Object.entries(files).every(([file, writers]) =>
    file.startsWith('raspd-')
      ? writers.every((w) => w === 'raspd:raspd')
      : writers.every((w) => !w.endsWith(':raspd'))
  )
  record(`reconcile-${name}.json`, { perOp, files, bounded, equal, failures })
  check(
    `${name}: per op, relayed <= Bun total <= relayed + upstream_failed`,
    bounded && forwarded.length > 0,
    perOp
  )
  if (expectFailures) {
    check(`${name}: Bun stopped mid-run, raspd recorded upstream_failed`, failures > 0, {
      failures,
    })
  } else {
    check(
      `${name}: no upstream failures, so relayed == Bun total for every op`,
      failures === 0 && equal,
      perOp
    )
  }
  check(
    `${name}: no metrics file is written by both processes`,
    disjoint &&
      Object.keys(files).some((f) => f.startsWith('raspd-')) &&
      Object.keys(files).some((f) => f.startsWith('aspd-')),
    files
  )
}

// R2 (T-11838): the two reads are native too, unless raspd relayed one with a
// fallback reason; R3a (T-11841): so is compileHarnessInvocation.
const NATIVE_READS = new Set([
  'aspc.resolveRuntimeDeclaration',
  'aspc.observeContinuationArtifact',
  'aspc.compileHarnessInvocation',
])
const window1Log = raspdRequests()
const misrouted = window1Log.filter((l) => {
  const data = l['data'] as Record<string, unknown>
  const op = data['op'] as string
  const native = NATIVE.has(op) || (NATIVE_READS.has(op) && data['fallback'] === undefined)
  return native !== (data['servedBy'] === 'native')
})
record(
  'served-by.json',
  window1Log.map((l) => l['data'])
)
check(
  'raspd.log: hello/health/version/surface and the R2 reads native, every other op served by Bun',
  misrouted.length === 0 && window1Log.length > 0,
  { lines: window1Log.length, misrouted: misrouted.slice(0, 5) }
)
service('stop', ns)
reconcile('window-1-drained', window1, false)

// Window 2: Bun stops while forwarded load is running.
const window2 = join(scratch, 'metrics-w2')
setMetricsRoot(window2)
service('start', ns)
const bunPid = Number(JSON.parse(readFileSync(join(ns, 'run', 'aspd.json'), 'utf8')).pid)
let loading = true
const outcomes = { relayed: 0, refused: 0 }
const loaders = [0, 1, 2, 3].map(async () => {
  while (loading) {
    try {
      const [reply] = await send(publicSocket, [
        { method: 'aspc.resolveRuntimeDeclaration', params: declarationParams },
        { method: 'aspc.observeContinuationArtifact', params: {} },
      ])
      const data = ((reply as Reply)['error'] as { data?: { reason?: string } } | undefined)?.data
      if (data?.reason === 'upstream_unavailable') outcomes.refused += 1
      else outcomes.relayed += 1
    } catch {
      await Bun.sleep(10)
    }
  }
})
await Bun.sleep(1_000)
process.kill(bunPid, 'SIGTERM')
for (let i = 0; i < 200; i++) {
  try {
    process.kill(bunPid, 0)
    await Bun.sleep(50)
  } catch {
    break
  }
}
await Bun.sleep(1_000)
const [degraded] = await send(publicSocket, [{ method: 'health', params: {} }])
loading = false
await Promise.all(loaders)
record('window-2-load.json', { outcomes, healthWhileBunDown: degraded })
check(
  'with Bun down, raspd still answers natively and refuses forwarded ops by name',
  outcomes.refused > 0 &&
    JSON.stringify(((degraded as Reply)['result'] as Record<string, unknown>)?.['degraded']) ===
      '["upstream_unavailable"]',
  { outcomes, health: (degraded as Reply)['result'] }
)
service('stop', ns)
reconcile('window-2-bun-stopped', window2, true)

// -- 3. rollback ---------------------------------------------------------------------

setMetricsRoot(join(scratch, 'metrics-w3'))
service('start', ns)
const disabled = service('front-door-disable', ns)
record('front-door-disable.json', disabled)
const rollbackClient = await AspcUnixClient.connect({
  socketPath: publicSocket,
  clientInfo: { name: 'hrc-server', version: 'raspd-e2e' },
  timeoutMs: 60_000,
})
const rollbackDeclaration = await rollbackClient.resolveRuntimeDeclaration(
  declarationParams as never
)
const rollbackCompile = await rollbackClient.compileHarnessInvocation({
  compileRequest: compileRequest(asp, fixture, { ...(compileRows[0] as never), id: 'rollback' }),
} as never)
await rollbackClient.close()
const [rollbackVersion] = await send(publicSocket, [{ method: 'version', params: {} }])
const avsRollback = run([AVS, 'aspc', publicSocket, 'aspc.hello'])
record('rollback.json', { rollbackDeclaration, rollbackCompile, rollbackVersion, avs: avsRollback })
check(
  'rollback: Bun serves aspd.sock again, raspd is gone, clients keep working',
  (disabled['status'] as Record<string, unknown>)['mode'] === 'direct' &&
    !existsSync(bunSocket) &&
    ((rollbackVersion as Reply)['result'] as Record<string, unknown>)['frontDoor'] === undefined &&
    (rollbackCompile as { ok?: boolean }).ok !== undefined &&
    avsRollback.status === 0 &&
    !existsSync(join(ns, 'run', 'raspd.json')),
  { status: disabled['status'], avs: avsRollback.status }
)
service('stop', ns)

// -- artifacts --------------------------------------------------------------------

for (const name of readdirSync(logDir)) {
  if (name.startsWith('raspd'))
    writeFileSync(join(out, `log-${name}`), readFileSync(join(logDir, name)))
}
const failed = checks.filter((c) => !c.ok)
record('summary.json', {
  at: new Date().toISOString(),
  commit,
  releaseId,
  sourceCommit: manifest.sourceCommit,
  scratch,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
})
console.log(`${checks.length - failed.length}/${checks.length} checks pass; artifacts ${out}`)
if (failed.length === 0) {
  // Installed releases are sealed read-only; unseal before removing.
  run(['chmod', '-R', 'u+w', scratch])
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed.length === 0 ? 0 : 1)
