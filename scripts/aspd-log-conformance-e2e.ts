#!/usr/bin/env bun
/**
 * Scratch E2E for aspd logging conformance (T-11829).
 *
 * Builds a real release from a clean clone of --commit, runs it through the
 * launch script aspd-service generates for launchd (stderr reopened with `>>`,
 * request log via `--log`), and drives it: discovery, refusals, a malformed
 * frame, one compile per fixture row, and a concurrent compile burst until a
 * request crosses the 2 s `request.slow` threshold. Mid-drive, the collective
 * rotator (agent-control-plane/scripts/rotate-praesidium-logs.sh) copytruncates
 * both files while a hello loop keeps aspd writing. Then SIGTERM.
 *
 * Proves: every line of aspd.log, aspd.err.log and both rotated archives is one
 * L2 object; the rpc.request L3 line keeps its exact shape; aspd.log after the
 * copytruncate restarts at offset 0 with no NUL gap (and a non-O_APPEND
 * control writer does leave one, so the check can fail); aspd's stderr fd is
 * O_APPEND (lsof `AP`); the asp CLI's dry-run compile writes no
 * `[asp-timing]` text to stderr.
 *
 * Usage: bun scripts/aspd-log-conformance-e2e.ts [--out <dir>] [--commit <sha>]
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { renderLaunchdScript } from './aspd-service/launchd.ts'
import { isolateUsageMetrics } from './lib/usage-metrics-isolation.ts'
import { ROWS, compileRequest, createFixture } from './path-markers-e2e.ts'

// Usage metrics from this script and its children stay out of the real day files (T-11824).
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
    timeout: 300_000,
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

const out = resolve(arg('--out') ?? join(repo, '..', 'var', 'wrkq-artifacts', 'T-11829', 'e2e'))
const commit = must(['git', 'rev-parse', arg('--commit') ?? 'HEAD']).trim()
// Unix socket paths are limited to 104 bytes on macOS; keep the scratch root short.
const scratch = mkdtempSync('/tmp/aspl-')
const ns = join(scratch, 'ns')
const logDir = join(scratch, 'logs')
const requestLog = join(logDir, 'aspd.log')
const supervisorLog = join(logDir, 'aspd.err.log')
const socketPath = join(ns, 'run', 'aspd.sock')
const ROTATOR = resolve(repo, '..', 'agent-control-plane', 'scripts', 'rotate-praesidium-logs.sh')
mkdirSync(out, { recursive: true })
mkdirSync(join(ns, 'run'), { recursive: true })
mkdirSync(logDir, { recursive: true })

const checks: { name: string; ok: boolean; detail?: unknown }[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
}

// -- release --------------------------------------------------------------------

const src = join(scratch, 'src')
must(['git', 'clone', '-q', repo, src])
must(['git', 'checkout', '-q', commit], { cwd: src })
must(['bun', 'install', '--frozen-lockfile'], { cwd: src })
const release = JSON.parse(
  must(['bun', 'scripts/asp-release.ts', 'build', '--output-root', join(scratch, 'builds')], {
    cwd: src,
  })
) as { releaseId: string; releasePath: string }
must(
  [
    'bun',
    'scripts/asp-release.ts',
    'install',
    '--artifact',
    release.releasePath,
    '--release-root',
    join(ns, 'releases'),
  ],
  { cwd: src }
)
const releasePath = join(ns, 'releases', release.releaseId)

// -- fixture + launch -----------------------------------------------------------

const asp = {
  config: await import('spaces-config'),
  contracts: await import('spaces-runtime-contracts'),
} as unknown as Parameters<typeof createFixture>[0]
const fixture = createFixture(asp, join(scratch, 'fx'))
const daemonEnv: Record<string, string> = {
  HOME: process.env['HOME'] as string,
  PATH: process.env['PATH'] as string,
  ASP_HOME: fixture.aspHome,
  ASP_AGENTS_ROOT: fixture.agentsRoot,
  ASP_USAGE_METRICS_VAR_ROOT: join(scratch, 'metrics-var'),
}
const launchScript = join(ns, 'launch.sh')
writeFileSync(
  launchScript,
  renderLaunchdScript({
    ns,
    socketPath,
    releaseId: release.releaseId,
    releasePath,
    env: daemonEnv,
    logPath: supervisorLog,
    requestLogPath: requestLog,
  }),
  { mode: 0o700 }
)
// launchd's own StandardOutPath/StandardErrorPath; the script reopens them with >>.
const daemon = spawn('/bin/sh', [launchScript], { stdio: 'ignore', detached: true })
const exited = new Promise<number | null>((done) => daemon.once('exit', (code) => done(code)))

// -- rpc ------------------------------------------------------------------------

type Frame = Record<string, unknown> | { raw: string }
const CLIENT = 'aspd-log-e2e/1'

async function send(frames: Frame[]): Promise<Record<string, unknown>[]> {
  return await new Promise((resolveFrames, reject) => {
    const socket = connect(socketPath)
    const timer = setTimeout(() => reject(new Error('rpc timeout')), 120_000)
    const got: Record<string, unknown>[] = []
    let buffer = ''
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('connect', () => {
      frames.forEach((frame, index) =>
        socket.write(
          'raw' in frame
            ? `${frame.raw}\n`
            : `${JSON.stringify({ jsonrpc: '2.0', id: index + 1, client: CLIENT, ...frame })}\n`
        )
      )
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      got.push(...lines.map((line) => JSON.parse(line) as Record<string, unknown>))
      if (got.length >= frames.length) {
        clearTimeout(timer)
        socket.end()
        socket.once('close', () => resolveFrames(got))
      }
    })
  })
}

const HELLO = {
  method: 'aspc.hello',
  params: { clientInfo: { name: 'aspd-log-e2e', version: '1' }, protocolVersions: ['aspc/0.1'] },
}

const deadline = Date.now() + 60_000
for (;;) {
  try {
    await send([HELLO])
    break
  } catch (error) {
    if (Date.now() > deadline) throw new Error(`aspd never answered: ${String(error)}`)
    await Bun.sleep(100)
  }
}
const pid = Number(JSON.parse(readFileSync(join(ns, 'run', 'aspd.json'), 'utf8')).pid)
const lsof = run(['lsof', '-w', '+fg', '-a', '-p', String(pid), '-d', '1,2'])
writeFileSync(join(out, 'lsof-aspd-stdio.txt'), lsof.stdout)
check(
  "aspd's stdout/stderr hold aspd.err.log with O_APPEND (lsof AP)",
  ['1w', '2w'].every((fd) =>
    lsof.stdout
      .split('\n')
      .some(
        (line) => line.includes(` ${fd} `) && /\bAP\b/.test(line) && line.endsWith(supervisorLog)
      )
  ),
  lsof.stdout
)

const compileFrame = (row: (typeof ROWS)[number], tag: string) => ({
  method: 'aspc.compileHarnessInvocation',
  params: {
    compileRequest: compileRequest(asp, fixture, { ...row, id: `${row.id}-${tag}` }),
    aspHome: fixture.aspHome,
  },
})
// Rows whose harness binaries this node may not carry still log their refusal.
const compileRows = ROWS.filter((row) => row.requested.harness !== 'codex')

let helloLoop = true
const helloCount = { sent: 0 }
const background = (async () => {
  while (helloLoop) {
    await send([HELLO])
    helloCount.sent += 1
    await Bun.sleep(20)
  }
})()

// Discovery, refusals and a malformed frame.
await send([HELLO, { method: 'health', params: {} }, { method: 'surface', params: {} }])
await send([{ method: 'version', params: {} }])
await send([{ method: 'aspc.retiredOperation', params: {} }])
await send([{ method: 'aspc.resolveRuntimeDeclaration', params: { bogus: true } }])
await send([{ raw: '{not-json' }])
for (const row of compileRows) await send([compileFrame(row, 'seq')])

const logText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
const sawSlow = () => logText(requestLog).includes('"event":"request.slow"')

// Startup failure paths, writing the same supervisor file as launchd would:
// a second launch script whose daemon finds the socket already served, and a
// refused invocation of the release binary.
const ns2 = join(scratch, 'ns2')
mkdirSync(join(ns2, 'run'), { recursive: true })
const conflictScript = join(ns2, 'launch.sh')
writeFileSync(
  conflictScript,
  renderLaunchdScript({
    ns: ns2,
    socketPath,
    releaseId: release.releaseId,
    releasePath,
    env: daemonEnv,
    logPath: supervisorLog,
    requestLogPath: requestLog,
  }),
  { mode: 0o700 }
)
const conflict = run(['/bin/sh', conflictScript])
check('a second daemon on a served socket exits 1', conflict.status === 1, conflict)
const errFd = openSync(supervisorLog, 'a')
const refused = spawnSync(join(releasePath, 'aspd'), ['serve', '--socket', 'relative.sock'], {
  stdio: ['ignore', errFd, errFd],
  env: daemonEnv,
})
closeSync(errFd)
check('a refused invocation exits 1', refused.status === 1)

// Copytruncate both files with the collective rotator while aspd keeps writing.
await Bun.sleep(400)
const sizeBefore = statSync(requestLog).size
const rotation = run(
  [
    ROTATOR,
    '--max-bytes',
    '1',
    '--lock-file',
    join(scratch, 'rotation.lock'),
    requestLog,
    supervisorLog,
  ],
  { env: { ...process.env, PRAESIDIUM_LOG_ROTATION_ROOT: logDir } }
)
writeFileSync(
  join(out, 'rotation.txt'),
  `${rotation.stdout}${rotation.stderr}[exit ${rotation.status}]\n`
)
check('collective rotator copytruncated both files', rotation.status === 0, rotation.stderr)

// Concurrent compile bursts until one request is still in flight after 2 s.
let burst = 8
for (let round = 0; round < 6 && !sawSlow(); round++) {
  await Promise.all(
    Array.from({ length: burst }, (_, index) =>
      send([compileFrame(compileRows[index % compileRows.length] as never, `b${round}-${index}`)])
    )
  )
  await Bun.sleep(400)
  burst *= 2
}
helloLoop = false
await background
await Bun.sleep(400)

// -- CLI host --------------------------------------------------------------------

const cli = run(
  [
    'bun',
    join(src, 'apps', 'cli', 'bin', 'asp.js'),
    'agent',
    'pathmark@project:T-11829',
    'task',
    'aspd log e2e prompt',
    '--agent-root',
    join(fixture.agentsRoot, 'pathmark'),
    '--project-root',
    fixture.projectRoot,
    '--harness',
    'claude',
    '--dry-run',
  ],
  {
    cwd: fixture.projectRoot,
    env: { ...process.env, ASP_HOME: fixture.aspHome, ASP_AGENTS_ROOT: fixture.agentsRoot },
  }
)
writeFileSync(join(out, 'cli-dry-run.stderr.txt'), cli.stderr)
check('asp CLI dry-run compile exits 0', cli.status === 0, cli.stderr.slice(-400))
check('asp CLI writes no [asp-timing] text to stderr', !cli.stderr.includes('[asp-timing]'))

// -- retire ----------------------------------------------------------------------

process.kill(pid, 'SIGTERM')
check('aspd retired cleanly on SIGTERM', (await exited) === 0)

// -- checks ----------------------------------------------------------------------

const archives = readdirSync(logDir).filter((name) => name.endsWith('.gz'))
const archiveOf = (base: string) => archives.find((name) => name.startsWith(`${base}.`))
const files: Record<string, string> = {
  'aspd.log': logText(requestLog),
  'aspd.err.log': logText(supervisorLog),
}
for (const base of ['aspd.log', 'aspd.err.log']) {
  const archive = archiveOf(base)
  if (archive !== undefined) {
    files[`${base} (rotated)`] = gunzipSync(readFileSync(join(logDir, archive))).toString('utf8')
  }
}
check('both files have a rotated archive', archives.length === 2, archives)

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
function l2Failure(line: string): string | undefined {
  let value: Record<string, unknown>
  try {
    value = JSON.parse(line)
  } catch {
    return 'not JSON'
  }
  if (typeof value['ts'] !== 'string' || !ISO.test(value['ts'])) return 'ts'
  if (!LEVELS.has(value['level'] as string)) return 'level'
  if (typeof value['component'] !== 'string') return 'component'
  if (typeof value['event'] !== 'string') return 'event'
  const data = value['data']
  if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) {
    return 'data'
  }
  const extra = Object.keys(value).filter(
    (key) => !['ts', 'level', 'component', 'event', 'data'].includes(key)
  )
  return extra.length > 0 ? `extra keys ${extra.join(',')}` : undefined
}
const events: Record<string, unknown>[] = []
for (const [name, text] of Object.entries(files)) {
  const lines = text.split('\n').filter((line) => line !== '')
  const bad = lines
    .map((line, index) => ({ index, line: line.slice(0, 200), why: l2Failure(line) }))
    .filter((entry) => entry.why !== undefined)
  check(
    `every line of ${name} is L2 (${lines.length} lines)`,
    lines.length > 0 && bad.length === 0,
    bad.slice(0, 5)
  )
  for (const line of lines) if (!l2Failure(line)) events.push({ file: name, ...JSON.parse(line) })
}
const byEvent = (event: string, file?: string) =>
  events.filter((line) => line['event'] === event && (file === undefined || line['file'] === file))
const dataOf = (line: Record<string, unknown>) => line['data'] as Record<string, unknown>

const slow = byEvent('request.slow')
check(
  'a slow compile logged request.slow (warn, elapsedMs >= 2000, correlation)',
  slow.length > 0 &&
    slow.every(
      (line) =>
        line['level'] === 'warn' &&
        (dataOf(line)['elapsedMs'] as number) >= 2000 &&
        typeof dataOf(line)['runtimeId'] === 'string'
    ),
  slow.slice(0, 2)
)
const compiles = byEvent('request.answered').filter(
  (line) => dataOf(line)['method'] === 'aspc.compileHarnessInvocation'
)
check(
  'compile request.answered keeps conn/id/durationMs/replyBytes/phases in data',
  compiles.length > 0 &&
    compiles.every((line) => {
      const data = dataOf(line)
      return (
        typeof data['conn'] === 'number' &&
        typeof data['id'] === 'string' &&
        typeof data['durationMs'] === 'number' &&
        typeof data['replyBytes'] === 'number' &&
        typeof data['phases'] === 'object'
      )
    }),
  compiles.slice(0, 1)
)
check(
  'a slow answered line is warn',
  compiles.some(
    (line) => (dataOf(line)['durationMs'] as number) >= 2000 && line['level'] === 'warn'
  )
)
check('request.admitted logged for compiles', byEvent('request.admitted').length >= compiles.length)
check(
  'lifecycle in aspd.err.log: aspd.serving then aspd.exit',
  events.some(
    (line) => line['event'] === 'aspd.serving' && String(line['file']).startsWith('aspd.err.log')
  ) && byEvent('aspd.exit', 'aspd.err.log').length === 1
)
check(
  'retire.begin and retire.drained in aspd.log',
  byEvent('retire.begin', 'aspd.log').length === 1 &&
    byEvent('retire.drained', 'aspd.log').length === 1
)
const inErr = (event: string) =>
  events.filter(
    (line) => line['event'] === event && String(line['file']).startsWith('aspd.err.log')
  )
check(
  'startup failure is an L2 aspd.fatal line in aspd.err.log',
  inErr('aspd.fatal').some((line) =>
    String(dataOf(line)['error']).includes('already served by a live listener')
  ),
  inErr('aspd.fatal')
)
check(
  'refused invocation is an L2 aspd.usage line in aspd.err.log',
  inErr('aspd.usage').length === 1
)
check(
  'aspd.err.log carries only aspd lifecycle events',
  events
    .filter((line) => String(line['file']).startsWith('aspd.err.log'))
    .every((line) => line['component'] === 'aspd')
)
const RPC_REQUEST =
  /^\{"ts":"[^"]+","level":"(info|warn|error)","component":"rpc","event":"rpc\.request","data":\{"listener":"aspd","op":"[^"]+","client":"[^"]+","durationMs":[\d.]+,"outcome":"[^"]+"(,"code":"[^"]+","message":".*")?\}\}$/
const rpcLines = Object.values(files)
  .flatMap((text) => text.split('\n'))
  .filter((line) => line.includes('"event":"rpc.request"'))
check(
  'rpc.request L3 lines keep their exact shape',
  rpcLines.length > 0 && rpcLines.every((line) => RPC_REQUEST.test(line)),
  rpcLines.filter((line) => !RPC_REQUEST.test(line)).slice(0, 3)
)
check(
  'unknown op and malformed frame each have an rpc.request line',
  rpcLines.some((line) => line.includes('"op":"aspc.retiredOperation"')) &&
    rpcLines.some((line) => line.includes('"outcome":"-32700"'))
)
check(
  'no raw [asp-timing] or prefixed [aspd] text anywhere',
  Object.values(files).every((text) => !text.includes('[asp-timing]') && !text.includes('[aspd]'))
)

// Sparse-file proof. A writer without O_APPEND keeps its offset across the
// truncate, so its next write leaves a NUL-filled gap from byte 0.
const gapOf = (buffer: Buffer) => buffer.indexOf(0)
const live = readFileSync(requestLog)
check(
  'aspd.log after copytruncate starts at offset 0 with a whole L2 line and has no NUL gap',
  live.length > 0 && live[0] === 0x7b && gapOf(live) === -1,
  { sizeBeforeRotation: sizeBefore, sizeAfterDrive: live.length, firstNul: gapOf(live) }
)
const control = join(scratch, 'control.log')
const fd = openSync(control, 'w')
writeSync(fd, `${'{"ts":"x"}\n'.repeat(100)}`)
truncateSync(control, 0)
writeSync(fd, '{"ts":"y"}\n')
closeSync(fd)
const controlBytes = readFileSync(control)
check(
  'negative control: a non-O_APPEND writer leaves a NUL gap the check detects',
  gapOf(controlBytes) === 0,
  {
    size: controlBytes.length,
  }
)

for (const name of [...readdirSync(logDir)]) copyFileSync(join(logDir, name), join(out, name))
copyFileSync(launchScript, join(out, 'launch.sh'))
const summary = {
  commit,
  release: release.releaseId,
  scratch,
  hellosDuringRotation: helloCount.sent,
  lineCounts: Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, text.split('\n').filter(Boolean).length])
  ),
  events: Object.fromEntries(
    [...new Set(events.map((line) => `${line['component']}/${line['event']}`))]
      .sort()
      .map((key) => [
        key,
        events.filter((line) => `${line['component']}/${line['event']}` === key).length,
      ])
  ),
  checks,
}
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}`)
console.log(`artifacts: ${out}`)
process.exit(checks.every((entry) => entry.ok) ? 0 : 1)
