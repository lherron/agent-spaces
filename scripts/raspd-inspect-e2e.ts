#!/usr/bin/env bun
/**
 * Scratch E2E for R2b native reads (T-11951, docs/proposals/aspd-rust-front-door.md):
 * aspc.inspectRuntimePlacement and aspc.observeRuntimeCapability in raspd.
 *
 * The compare runner (scripts/aspd-compare/run.ts) proves the bytes and the
 * stage tree per case; this proves the rest on one scratch release, with the
 * release's Bun aspd on a private socket and raspd in front:
 *
 *  1. Race: native inspections and native and Bun compiles of the same agent
 *     on one cold ASP_HOME, at once. A claude inspection materializes the
 *     bundle (agent-inspection.ts compiles), so it races the compile's writes
 *     under the same lock protocol: everything succeeds and the store is left
 *     consistent.
 *  2. Forward before write: with Bun stopped, an inspection raspd does not
 *     answer (agent-harness, a git-pinned space, muse) is relayed, fails
 *     upstream and leaves the stage byte-for-byte unchanged; a native claude
 *     inspection in the same state still writes (the control).
 *  3. Latency, native vs Bun direct, p50/p99 (recorded, not gated), for both
 *     ops, and the per-stage `phases` every native inspection logs.
 *  4. Real callers: a scratch Bun hrc and a scratch rusthrc, each pointed at
 *     the raspd front door, serve `hrc start <scope> --dry-run` (a turn
 *     preview: POST /v1/previews/run compiles, then inspects the placement),
 *     and raspd.log shows the inspection `servedBy: native`.
 *
 * Usage: bun scripts/raspd-inspect-e2e.ts [--out <dir>] [--commit <sha>]
 *          [--release-artifact <built release dir>] [--raspd-binary <path>]
 *          [--rusthrc <path>] [--rounds <n>] [--iterations <n>] [--only callers]
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'

import { type CallCase, HELLO_PARAMS, buildCases, seedStage } from './aspd-compare/cases.ts'
import { buildScratchRelease, installReleaseArtifact, must } from './lib/scratch-release.ts'
import { isolateUsageMetrics } from './lib/usage-metrics-isolation.ts'
import { loadAsp } from './path-markers-e2e.ts'

isolateUsageMetrics()

const repo = resolve(import.meta.dir, '..')
const arg = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z')
const out = resolve(
  arg('--out') ?? join(repo, '..', 'var', 'wrkq-artifacts', 'T-11951', 'e2e', stamp)
)
mkdirSync(out, { recursive: true })
const rounds = Number(arg('--rounds') ?? '3')
const iterations = Number(arg('--iterations') ?? '40')

type Check = { name: string; ok: boolean; detail?: unknown }
const checks: Check[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
}
const record = (name: string, value: unknown) =>
  writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`)

// -- release --------------------------------------------------------------------

// Unix socket paths are limited to 104 bytes on macOS; keep the scratch root short.
const scratch = mkdtempSync('/tmp/r2b-')
const releases = join(scratch, 'var', 'aspd', 'releases')
const artifact = arg('--release-artifact')
const commit = must(['git', 'rev-parse', arg('--commit') ?? 'HEAD']).trim()
const built =
  artifact === undefined
    ? buildScratchRelease(commit, scratch, releases)
    : installReleaseArtifact(resolve(artifact), releases)
const releaseDir = join(releases, built.releaseId)
const devBinary = arg('--raspd-binary')
if (devBinary !== undefined) {
  // A development raspd through the release's own launcher.
  chmodSync(join(releaseDir, 'libexec'), 0o755)
  chmodSync(join(releaseDir, 'libexec', 'raspd'), 0o755)
  copyFileSync(devBinary, join(releaseDir, 'libexec', 'raspd'))
}
const INHERITED_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']
const literalEnv = (extra: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV)
    if (process.env[key] !== undefined) env[key] = process.env[key] as string
  return { ...env, ASP_USAGE_METRICS_VAR_ROOT: join(scratch, 'var'), ...extra }
}

// -- daemons ----------------------------------------------------------------------

type Pair = { front: string; bun: string; raspdLog: string; children: ChildProcess[] }

async function waitForSocket(path: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (existsSync(path)) return
    if (child.exitCode !== null) throw new Error(`${path}: daemon exited ${child.exitCode}`)
    await Bun.sleep(100)
  }
  throw new Error(`${path} never listened`)
}

/** Bun aspd on aspd-bun.sock, raspd on aspd.sock in front: the front-door shape. */
async function startPair(name: string, env: Record<string, string>): Promise<Pair> {
  const ns = join(scratch, name)
  mkdirSync(join(ns, 'run'), { recursive: true })
  const front = join(ns, 'run', 'aspd.sock')
  const bun = join(ns, 'run', 'aspd-bun.sock')
  const raspdLog = join(ns, 'raspd.log')
  const options = { cwd: ns, env, stdio: ['ignore', 'ignore', 'pipe'] as const }
  const bunChild = spawn(
    join(releaseDir, 'aspd'),
    ['serve', '--socket', bun, '--log', join(ns, 'aspd.log')],
    options
  )
  await waitForSocket(bun, bunChild)
  const raspdChild = spawn(
    join(releaseDir, 'raspd'),
    ['serve', '--socket', front, '--upstream', bun, '--log', raspdLog],
    options
  )
  await waitForSocket(front, raspdChild)
  return { front, bun, raspdLog, children: [raspdChild, bunChild] }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise((done) => child.once('exit', done))
}

/** hello, then one call, on a fresh connection (the HRC pattern): parsed replies. */
async function call(socket: string, client: string, method: string, params: unknown) {
  return await new Promise<Array<Record<string, unknown>>>((done, reject) => {
    const s = connect(socket)
    const timer = setTimeout(() => {
      s.destroy()
      reject(new Error(`timeout on ${socket}`))
    }, 180_000)
    let buffer = ''
    const lines: string[] = []
    s.on('error', reject)
    s.on('connect', () => {
      s.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, client, method: 'aspc.hello', params: HELLO_PARAMS })}\n`
      )
      s.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, client, method, params })}\n`)
    })
    const finish = () => {
      clearTimeout(timer)
      s.destroy()
      done(lines.map((l) => JSON.parse(l) as Record<string, unknown>))
    }
    s.on('close', finish)
    const decoder = new TextDecoder()
    s.on('data', (chunk) => {
      buffer += decoder.decode(chunk, { stream: true })
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        lines.push(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
      if (lines.length >= 2) finish()
    })
  })
}

const result = (replies: Array<Record<string, unknown>>) =>
  replies[1]?.['result'] as Record<string, unknown> | undefined
const readLog = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8') : '')
function raspdRows(log: string, from = 0): Array<Record<string, unknown>> {
  return readLog(log)
    .slice(from)
    .split('\n')
    .filter((l) => l.includes('"rpc.request"'))
    .map((l) => (JSON.parse(l) as { data: Record<string, unknown> }).data)
}
/** Wait until `count` access lines match: they are written after the reply. */
async function rowsFor(log: string, match: (r: Record<string, unknown>) => boolean, count: number) {
  let rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < 50; i++) {
    rows = raspdRows(log).filter(match)
    if (rows.length >= count) break
    await Bun.sleep(100)
  }
  return rows
}

/** Every path under `root` with its type, mode, size, mtime and content or target. */
function tree(root: string, out: Map<string, string> = new Map(), rel = ''): Map<string, string> {
  if (!existsSync(join(root, rel))) return out
  for (const name of readdirSync(join(root, rel)).sort()) {
    const path = join(rel, name)
    const stat = lstatSync(join(root, path))
    if (stat.isSymbolicLink()) out.set(path, `link ${readlinkSync(join(root, path))}`)
    else if (stat.isDirectory()) {
      out.set(path, `dir ${stat.mode} ${stat.mtimeMs}`)
      if (name !== '.git') tree(root, out, path)
    } else out.set(path, `file ${stat.mode} ${stat.size} ${stat.mtimeMs}`)
  }
  return out
}
const treeDiff = (a: Map<string, string>, b: Map<string, string>) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k))
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN
}
const summary = (times: number[]) => ({
  p50: Math.round(percentile(times, 50) * 10) / 10,
  p99: Math.round(percentile(times, 99) * 10) / 10,
  n: times.length,
})

const asp = await loadAsp()
const caseParams = (stage: ReturnType<typeof seedStage>, id: string) =>
  (buildCases(asp, stage).find((c) => c.id === id) as CallCase).params
const INSPECT = 'aspc.inspectRuntimePlacement'
const COMPILE = 'aspc.compileHarnessInvocation'
const CAPABILITY = 'aspc.observeRuntimeCapability'

function stageEnv(stage: ReturnType<typeof seedStage>) {
  const claudeConfig = join(stage.base, 'claude-config')
  mkdirSync(claudeConfig, { recursive: true })
  return literalEnv({
    ASP_HOME: stage.aspHome,
    ASP_AGENTS_ROOT: stage.agentsRoot,
    CLAUDE_CONFIG_DIR: claudeConfig,
  })
}

/** Every published claude bundle in one agent's scope, with whether it is complete. */
function bundles(aspHome: string, scope: string) {
  const found: Array<{ root: string; complete: boolean }> = []
  const homes = join(aspHome, 'codex-homes')
  {
    const versions = join(homes, scope, 'bundles', '.versions')
    for (const version of existsSync(versions) ? readdirSync(versions) : []) {
      for (const target of readdirSync(join(versions, version))) {
        const root = join(versions, version, target, 'claude')
        const manifestPath = join(root, '.asp-materialized.json')
        const manifest = existsSync(manifestPath)
          ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as {
              complete: boolean
              requiredPaths: string[]
            })
          : undefined
        found.push({
          root,
          complete:
            manifest?.complete === true &&
            manifest.requiredPaths.every((p) => existsSync(join(root, p))),
        })
      }
    }
  }
  return found
}

const only = arg('--only')

// -- 1. race on one cold ASP_HOME ---------------------------------------------------

const raceRounds: unknown[] = []
for (let round = 1; round <= rounds && only === undefined; round++) {
  const stage = seedStage(asp, join(scratch, `race${round}`))
  const pair = await startPair(`race${round}-pair`, stageEnv(stage))
  const inspect = caseParams(stage, 'inspect:claude:preview')
  const compile = caseParams(stage, 'compile:claude-code:dev')
  const started = performance.now()
  const replies = await Promise.all([
    ...[1, 2, 3].map(() => call(pair.front, 'r2b/race-inspect', INSPECT, inspect)),
    ...[1, 2].map(() => call(pair.front, 'r2b/race-compile', COMPILE, compile)),
    call(pair.bun, 'r2b/race-bun-inspect', INSPECT, inspect),
    call(pair.bun, 'r2b/race-bun-compile', COMPILE, compile),
  ])
  const elapsedMs = performance.now() - started
  const served = await rowsFor(
    pair.raspdLog,
    (r) =>
      String(r['client']).startsWith('r2b/race-') && [INSPECT, COMPILE].includes(String(r['op'])),
    5
  )
  for (const child of pair.children) await stopChild(child)
  const lockPath = join(stage.aspHome, 'global-lock.json')
  let lockTargets: string[] = []
  try {
    lockTargets = Object.keys(
      (JSON.parse(readFileSync(lockPath, 'utf8')) as { targets: Record<string, unknown> }).targets
    )
  } catch {}
  const staging = join(stage.aspHome, 'tmp', '.staging')
  const leftovers = existsSync(staging) ? readdirSync(staging) : []
  const locks = join(stage.aspHome, 'tmp', 'locks')
  const heldLocks = (existsSync(locks) ? readdirSync(locks) : []).filter((n) =>
    n.endsWith('.lock.lock')
  )
  // The seeded prune scope holds marker dirs, not bundles; pathmark-dev's is the raced one.
  const published = bundles(stage.aspHome, 'project_pathmark-dev')
  const roundResult = {
    round,
    elapsedMs: Math.round(elapsedMs),
    ok: replies.map((r) => result(r)?.['ok'] ?? r[1]?.['error']),
    bundles: published,
    lockTargets,
    stagingLeftovers: leftovers,
    heldLocks,
    servedBy: served.map((r) => `${r['client']}:${r['op']}:${r['servedBy']}`),
  }
  raceRounds.push(roundResult)
  check(
    `race round ${round}: 3 native + 1 Bun inspections and 2 native + 1 Bun compiles of pathmark-dev on a cold ASP_HOME all succeed`,
    replies.every((r) => result(r)?.['ok'] === true),
    roundResult.ok
  )
  check(
    `race round ${round}: every published bundle complete with its required paths; lock holds the target; no staging or held locks left`,
    published.length > 0 &&
      published.every((b) => b.complete) &&
      lockTargets.includes('pathmark-dev') &&
      leftovers.length === 0 &&
      heldLocks.length === 0,
    { published, lockTargets, leftovers, heldLocks }
  )
  check(
    `race round ${round}: raspd served its inspections and compiles natively`,
    served.filter((r) => r['servedBy'] === 'native').length === 5,
    roundResult.servedBy
  )
}
if (only === undefined) record('race.json', { rounds: raceRounds })

// -- 2. forwarded before any write ----------------------------------------------------

if (only === undefined) {
  const stage = seedStage(asp, join(scratch, 'fwd'))
  const pair = await startPair('fwd-pair', stageEnv(stage))
  // Bun stopped: anything raspd relays fails upstream, so any write is raspd's.
  await stopChild(pair.children[1] as ChildProcess)
  const forwarded = [
    ['inspect:agent-harness:preview', 'inspect_harness', /^agent-harness$/],
    ['inspect:muse', 'inspect_harness', /^muse$/],
    ['inspect:claude:pinned', 'registry_space', /^compose:space:.+@/],
  ] as const
  const results: unknown[] = []
  for (const [id, reason, detail] of forwarded) {
    const before = tree(stage.base)
    const from = readLog(pair.raspdLog).length
    const replies = await call(pair.front, 'r2b/forward', INSPECT, caseParams(stage, id))
    let row: Record<string, unknown> | undefined
    for (let i = 0; i < 50 && row === undefined; i++) {
      row = raspdRows(pair.raspdLog, from).find((r) => r['op'] === INSPECT)
      if (row === undefined) await Bun.sleep(100)
    }
    const changed = treeDiff(before, tree(stage.base))
    results.push({ id, error: replies[1]?.['error'], changed, row })
    check(
      `forward-before-write: ${id} with Bun stopped is relayed (${reason}, fallbackDetail), fails upstream, and raspd wrote nothing`,
      changed.length === 0 &&
        replies[1]?.['error'] !== undefined &&
        row?.['servedBy'] === 'bun' &&
        row?.['fallback'] === reason &&
        detail.test(String(row?.['fallbackDetail'])) &&
        row?.['relay'] === 'upstream_failed',
      { changed, row }
    )
  }
  const before = tree(stage.base)
  const control = await call(
    pair.front,
    'r2b/forward',
    INSPECT,
    caseParams(stage, 'inspect:claude:preview')
  )
  const changed = treeDiff(before, tree(stage.base))
  check(
    'forward-before-write control: a native claude inspection with Bun stopped succeeds and its writes are visible to the same check',
    result(control)?.['ok'] === true && changed.length > 0,
    { changedCount: changed.length, sample: changed.slice(0, 5) }
  )
  results.push({ id: 'control', ok: result(control)?.['ok'], changedCount: changed.length })
  record('forward-before-write.json', results)
  await stopChild(pair.children[0] as ChildProcess)
}

// -- 3. latency ----------------------------------------------------------------------

if (only === undefined) {
  const stage = seedStage(asp, join(scratch, 'lat'))
  const pair = await startPair('lat-pair', stageEnv(stage))
  const time = async (socket: string, client: string, method: string, params: unknown) => {
    const times: number[] = []
    for (let i = 0; i < iterations; i++) {
      const t = performance.now()
      const replies = await call(socket, client, method, params)
      if (result(replies)?.['ok'] !== true) throw new Error(`${method} latency call failed`)
      times.push(performance.now() - t)
    }
    return times
  }
  const latency: Record<string, unknown> = {}
  for (const [id, method] of [
    ['inspect:claude:preview', INSPECT],
    ['inspect:codex:preview', INSPECT],
    ['capability:claude', CAPABILITY],
    ['capability:codex', CAPABILITY],
  ] as const) {
    const params = caseParams(stage, id)
    await time(pair.front, 'r2b/latency-warm', method, params) // composes the bundle
    const native = await time(pair.front, `r2b/latency-native:${id}`, method, params)
    const bun = await time(pair.bun, `r2b/latency-bun:${id}`, method, params)
    const rows = await rowsFor(
      pair.raspdLog,
      (r) => r['client'] === `r2b/latency-native:${id}` && r['op'] === method,
      iterations
    )
    const phases = rows.map((r) => (r['phases'] ?? {}) as Record<string, number>)
    const names = [...new Set(phases.flatMap((p) => Object.keys(p)))]
    latency[id] = {
      roundTripMs: { native: summary(native), bun: summary(bun) },
      serverMs: summary(rows.map((r) => Number(r['durationMs']))),
      servedNative: rows.filter((r) => r['servedBy'] === 'native').length,
      meanPhasesMs: Object.fromEntries(
        names.map((n) => [
          n,
          Math.round((phases.reduce((sum, p) => sum + (p[n] ?? 0), 0) / phases.length) * 10) / 10,
        ])
      ),
    }
    check(
      `latency ${id}: every native round trip served natively`,
      rows.length === iterations && rows.every((r) => r['servedBy'] === 'native'),
      latency[id]
    )
  }
  record('latency.json', { iterations, latency })
  for (const child of pair.children) await stopChild(child)
}

// -- 4. real callers: a turn preview through Bun hrc and rusthrc ----------------------

const HRC_RUNTIME = resolve(repo, '..', 'hrc-runtime')
const RUSTHRC =
  arg('--rusthrc') ?? join(repo, 'crates', 'target', 'hrc-runtime', 'debug', 'rusthrc')
{
  const base = join(scratch, 'callers')
  const agentsRoot = join(base, 'agents')
  const aspHome = join(base, 'asp-home')
  const projectRoot = join(base, 'project')
  cpSync(join(process.env['HOME'] as string, 'praesidium', 'var', 'agents'), agentsRoot, {
    recursive: true,
    verbatimSymlinks: true,
  })
  mkdirSync(aspHome, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  const pair = await startPair(
    'callers-pair',
    literalEnv({ ASP_HOME: aspHome, ASP_AGENTS_ROOT: agentsRoot })
  )
  const root = join(base, 'hrc')
  for (const dir of ['run', 'state']) mkdirSync(join(root, dir), { recursive: true })
  const env: Record<string, string> = {
    ...(Object.fromEntries(
      Object.entries(process.env).filter(
        ([k, v]) =>
          v !== undefined &&
          !/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_SANDBOX|HRC_[A-Z_]+|WRKQ_DB_PATH|WRKQ_DB_PATH_FILE|WRKQD_NODE_TOKENS|WRKQD_NODE_TOKENS_FILE|WRKQD_UNIX|TMUX|TMUX_PANE)$/.test(
            k
          )
      )
    ) as Record<string, string>),
    HRC_RUNTIME_DIR: join(root, 'run'),
    HRC_STATE_DIR: join(root, 'state'),
    HRC_PROJECT_SEARCH_ROOTS: base,
    ASP_PROJECT_ROOT_OVERRIDE: projectRoot,
    HRC_WRKQ_DB: join(root, 'wrkq.db'),
    WRKQ_DB: join(root, 'wrkq.db'),
    WRKQ_PRINCIPAL_REF: 'agent:clod',
    HRC_WRKQD_TOKEN_FILE: '',
    WRKQD_TOKEN_FILE: '',
    WRKQD_TOKEN: '',
    HRC_PEER_CONFIG_FILE: join(root, 'federation.json'),
    HRC_EVENT_INGEST_SOCKET: join(root, 'run', 'ingest.sock'),
    HRC_ACP_WEBHOOK_URL: '',
    HRC_ASPD_SOCKET: pair.front,
    HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED: '1',
    HRC_HEADLESS_CODEX_BROKER_ENABLED: '1',
    HRC_BROKER_DURABLE_IPC_ENABLED: '1',
    ASP_HOME: aspHome,
    ASP_AGENTS_ROOT: agentsRoot,
  }
  writeFileSync(
    env['HRC_PEER_CONFIG_FILE'] as string,
    JSON.stringify({ nodeId: 'r2b-t11951', peers: {} }),
    { mode: 0o600 }
  )
  must(['git', 'init', '-q'], { cwd: projectRoot, env })
  must(['git', 'commit', '-q', '--allow-empty', '-m', 'r2b callers'], { cwd: projectRoot, env })
  must(['wrkqadm', 'migrate'], { cwd: projectRoot, env })
  must(['wrkq', 'mkdir', '/project', '--kind', 'project', '--json'], { cwd: projectRoot, env })
  must(['wrkq', 'set', '/project', '--root', projectRoot, '--json'], { cwd: projectRoot, env })
  const hrcCli = ['bun', join(HRC_RUNTIME, 'packages', 'hrc-cli', 'src', 'cli.ts')]
  const hrcSocket = join(root, 'run', 'hrc.sock')
  const status = async () => {
    try {
      return (await fetch('http://hrc/v1/status', { unix: hrcSocket } as RequestInit)).status
    } catch {
      return 0
    }
  }
  const callers: Record<string, unknown> = {}
  for (const [kind, argv] of [
    ['bun', [...hrcCli, 'server', 'serve']],
    ['rusthrc', [RUSTHRC, 'server']],
  ] as const) {
    const from = readLog(pair.raspdLog).length
    const server = spawn(argv[0], argv.slice(1), {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let serverErr = ''
    server.stderr?.on('data', (c) => {
      serverErr += c.toString()
    })
    let ready = false
    for (let i = 0; i < 300 && !ready && server.exitCode === null; i++) {
      ready = (await status()) === 200
      if (!ready) await Bun.sleep(100)
    }
    const previews = ['tabularasa', 'cody'].map((agent) => {
      const scope = `agent:${agent}:project:project:task:T-11951-${kind}`
      const run = ready
        ? spawnSync(
            hrcCli[0],
            [...hrcCli.slice(1), 'start', scope, '-p', 'preview prompt', '--dry-run', '--json'],
            { cwd: projectRoot, env, encoding: 'utf8', timeout: 300_000 }
          )
        : undefined
      return {
        agent,
        scope,
        status: run?.status,
        stdout: run?.stdout.slice(-4000),
        stderr: run?.stderr.slice(-2000),
      }
    })
    await stopChild(server)
    await Bun.sleep(200)
    const rows = raspdRows(pair.raspdLog, from).filter((r) =>
      [INSPECT, COMPILE].includes(String(r['op']))
    )
    const inspected = rows.filter((r) => r['op'] === INSPECT)
    callers[kind] = {
      ready,
      previews,
      raspd: rows.map((r) => ({
        op: r['op'],
        client: r['client'],
        servedBy: r['servedBy'],
        outcome: r['outcome'],
        fallback: r['fallback'],
        durationMs: r['durationMs'],
      })),
      serverStderrTail: serverErr.slice(-2000),
    }
    check(
      `${kind} hrc: \`hrc start --dry-run\` turn previews of a claude (tabularasa) and a codex (cody) seat succeed, and raspd served both inspections natively`,
      ready &&
        previews.every((p) => p.status === 0) &&
        inspected.length === 2 &&
        inspected.every((r) => r['servedBy'] === 'native' && r['outcome'] === 'ok'),
      callers[kind]
    )
  }
  record('callers.json', {
    rusthrc: RUSTHRC,
    hrcRuntimeHead: must(['git', '-C', HRC_RUNTIME, 'rev-parse', 'HEAD']).trim(),
    callers,
  })
  for (const child of pair.children) await stopChild(child)
}

record('checks.json', checks)
const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed; evidence in ${out}`)
process.exit(failed.length === 0 ? 0 : 1)
