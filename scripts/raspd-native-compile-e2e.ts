#!/usr/bin/env bun
/**
 * Scratch E2E for R3a Native compile (T-11841, docs/proposals/aspd-rust-front-door.md).
 *
 * raspd compiles claude-code over mutable spaces itself. The compare runner
 * (scripts/aspd-compare/run.ts, fixture and `--cases live`) proves the bytes;
 * this proves the rest of the close conditions on one scratch release, with
 * the release's Bun aspd on a private socket and its raspd in front:
 *
 *  2. Unchanged HRC clients birth from a native compile: a cold
 *     `hrc start -p … --wait completed` of a claude seat completes its turn,
 *     through Bun hrc and through rusthrc, and raspd.log shows the compile
 *     `servedBy: native`.
 *  3. Racing writers on one cold ASP_HOME all succeed and leave it consistent:
 *     raspd native compiles, Bun asp CLI compiles of the same target (same
 *     bundle fingerprint), and Bun compiles that cold-publish a git-pinned
 *     snapshot (asp CLI and Bun aspd via raspd's forward), at once.
 *  4. A request raspd does not compile is forwarded before any write: with
 *     Bun stopped, a codex compile and a registry-space compile through
 *     raspd fail upstream and leave the stage byte-for-byte unchanged, while
 *     a native compile in the same state still writes (the control).
 *  5. Latency, native vs Bun direct, p50/p99 (recorded, not gated).
 *
 * Usage: bun scripts/raspd-native-compile-e2e.ts [--out <dir>] [--commit <sha>]
 *          [--release-artifact <built release dir>] [--raspd-binary <path>]
 *          [--rusthrc <path>] [--rounds <n>] [--iterations <n>] [--no-births]
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
  arg('--out') ?? join(repo, '..', 'var', 'wrkq-artifacts', 'T-11841', 'e2e', stamp)
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
const scratch = mkdtempSync('/tmp/rnc-')
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
  // Run a development raspd through the release's own launcher, so it sees
  // exactly the environment the release gives its payloads.
  chmodSync(join(releaseDir, 'libexec'), 0o755)
  chmodSync(join(releaseDir, 'libexec', 'raspd'), 0o755)
  copyFileSync(devBinary, join(releaseDir, 'libexec', 'raspd'))
}
const release = JSON.parse(readFileSync(join(releaseDir, 'release.json'), 'utf8')) as {
  releaseId: string
  sourceCommit: string
}
const INHERITED_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']
const literalEnv = (extra: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV)
    if (process.env[key] !== undefined) env[key] = process.env[key] as string
  return { ...env, ASP_USAGE_METRICS_VAR_ROOT: join(scratch, 'var'), ...extra }
}

// -- daemons ----------------------------------------------------------------------

type Pair = { name: string; front: string; bun: string; raspdLog: string; children: ChildProcess[] }

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
  return { name, front, bun, raspdLog, children: [raspdChild, bunChild] }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise((done) => child.once('exit', done))
}

async function stopPair(pair: Pair): Promise<void> {
  for (const child of pair.children) await stopChild(child)
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
    s.on('data', (chunk) => {
      buffer += chunk.toString()
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

const asp = await loadAsp()
const caseParams = (stage: ReturnType<typeof seedStage>, id: string) => {
  const entry = buildCases(asp, stage).find((c) => c.id === id) as CallCase
  return entry.params
}

// -- 3. racing writers on one cold ASP_HOME --------------------------------------------

const ASP_CLI = Bun.which('asp')
const raceRounds: unknown[] = []
for (let round = 1; round <= rounds; round++) {
  const stage = seedStage(asp, join(scratch, `race${round}`))
  const claudeConfig = join(stage.base, 'claude-config')
  mkdirSync(claudeConfig, { recursive: true })
  const env = literalEnv({
    ASP_HOME: stage.aspHome,
    ASP_AGENTS_ROOT: stage.agentsRoot,
    CLAUDE_CONFIG_DIR: claudeConfig,
  })
  const pair = await startPair(`race${round}-pair`, env)
  const native = caseParams(stage, 'compile:claude-code:dev')
  const pinned = caseParams(stage, 'compile:claude-code')
  const cli = (agent: string) =>
    new Promise<{ status: number | null; argv0?: string; root?: string; stderr: string }>(
      (done) => {
        const child = spawn(
          ASP_CLI as string,
          [
            'agent',
            `agent:${agent}:project:project`,
            'task',
            'race prompt',
            '--harness',
            'claude',
            '--agent-root',
            join(stage.agentsRoot, agent),
            '--project-root',
            stage.projectRoot,
            '--dry-run',
            '--json',
          ],
          { cwd: stage.projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] }
        )
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (c) => {
          stdout += c.toString()
        })
        child.stderr?.on('data', (c) => {
          stderr += c.toString()
        })
        child.once('exit', (status) => {
          let root: string | undefined
          try {
            const spec = (JSON.parse(stdout) as { spec: { argv: string[] } }).spec
            root = spec.argv[spec.argv.indexOf('--settings') + 1]?.replace(/\/settings\.json$/, '')
          } catch {}
          done({ status, ...(root !== undefined ? { root } : {}), stderr: stderr.slice(-800) })
        })
      }
    )
  const started = performance.now()
  const outcomes = await Promise.all([
    ...[1, 2, 3].map(() =>
      call(pair.front, 'r3e2e/race-native', 'aspc.compileHarnessInvocation', native)
    ),
    ...[1, 2].map(() =>
      call(pair.front, 'r3e2e/race-pinned', 'aspc.compileHarnessInvocation', pinned)
    ),
    ...[1, 2, 3].map(() => cli('pathmark-dev')),
    ...[1, 2].map(() => cli('pathmark')),
  ])
  const elapsedMs = performance.now() - started
  await stopPair(pair)
  const replies = outcomes.slice(0, 5) as Array<Array<Record<string, unknown>>>
  const clis = outcomes.slice(5) as Array<{ status: number | null; root?: string; stderr: string }>
  const roots = new Set<string>()
  for (const r of replies.slice(0, 3)) {
    const plan = result(r)?.['plan'] as
      | { artifacts?: { materializedBundleRoot?: string } }
      | undefined
    if (plan?.artifacts?.materializedBundleRoot) roots.add(plan.artifacts.materializedBundleRoot)
  }
  for (const c of clis.slice(0, 3)) if (c.root) roots.add(c.root)
  const lock = JSON.parse(readFileSync(join(stage.aspHome, 'global-lock.json'), 'utf8')) as {
    spaces: Record<string, { integrity: string; commit: string }>
    targets: Record<string, unknown>
  }
  const pinnedEntry = Object.values(lock.spaces).find((e) => /^[0-9a-f]{40}$/.test(e.commit))
  const snapshot = pinnedEntry
    ? join(stage.aspHome, 'snapshots', pinnedEntry.integrity.replace('sha256:', ''))
    : undefined
  const bundleRoot = [...roots][0]
  const manifest =
    bundleRoot !== undefined && existsSync(join(bundleRoot, '.asp-materialized.json'))
      ? (JSON.parse(readFileSync(join(bundleRoot, '.asp-materialized.json'), 'utf8')) as {
          complete: boolean
          requiredPaths: string[]
        })
      : undefined
  const staging = join(stage.aspHome, 'tmp', '.staging')
  const leftovers = existsSync(staging) ? readdirSync(staging) : []
  const heldLocks = readdirSync(join(stage.aspHome, 'tmp', 'locks')).filter((n) =>
    n.endsWith('.lock.lock')
  )
  const served = raspdRows(pair.raspdLog).filter((r) => r['op'] === 'aspc.compileHarnessInvocation')
  const roundResult = {
    round,
    elapsedMs: Math.round(elapsedMs),
    raspd: replies.map((r) => ({ ok: result(r)?.['ok'], error: r[1]?.['error'] })),
    cli: clis.map((c) => ({ status: c.status, root: c.root, stderr: c.stderr })),
    bundleRoots: [...roots],
    lockTargets: Object.keys(lock.targets),
    snapshot: snapshot && existsSync(join(snapshot, 'space.toml')),
    stagingLeftovers: leftovers,
    heldLocks,
    servedBy: served.map(
      (r) => `${r['client']}:${r['servedBy']}${r['fallback'] ? `:${r['fallback']}` : ''}`
    ),
  }
  raceRounds.push(roundResult)
  check(
    `race round ${round}: 3 native + 2 forwarded raspd compiles and 5 Bun asp CLI compiles all succeed`,
    replies.every((r) => result(r)?.['ok'] === true) && clis.every((c) => c.status === 0),
    roundResult
  )
  check(
    `race round ${round}: one bundle for the shared target, complete with every required path; lock holds both targets; pinned snapshot complete; no staging or held locks left`,
    roots.size === 1 &&
      manifest?.complete === true &&
      manifest.requiredPaths.every((p) => existsSync(join(bundleRoot as string, p))) &&
      'pathmark-dev' in lock.targets &&
      'pathmark' in lock.targets &&
      roundResult.snapshot === true &&
      leftovers.length === 0 &&
      heldLocks.length === 0,
    { roots: [...roots], lockTargets: Object.keys(lock.targets), leftovers, heldLocks }
  )
  check(
    `race round ${round}: raspd served the mutable compiles natively and forwarded the pinned ones`,
    served.filter((r) => r['client'] === 'r3e2e/race-native' && r['servedBy'] === 'native')
      .length === 3 &&
      served.filter(
        (r) => r['client'] === 'r3e2e/race-pinned' && r['fallback'] === 'registry_space'
      ).length === 2,
    roundResult.servedBy
  )
}
record('race.json', {
  aspCli: ASP_CLI,
  aspCliVersion: must([ASP_CLI as string, '--version']).trim(),
  rounds: raceRounds,
})

// -- 4. forwarded before any write ----------------------------------------------------

{
  const stage = seedStage(asp, join(scratch, 'fwd'))
  const claudeConfig = join(stage.base, 'claude-config')
  mkdirSync(claudeConfig, { recursive: true })
  const env = literalEnv({
    ASP_HOME: stage.aspHome,
    ASP_AGENTS_ROOT: stage.agentsRoot,
    CLAUDE_CONFIG_DIR: claudeConfig,
  })
  const pair = await startPair('fwd-pair', env)
  // Bun stopped: anything raspd relays fails upstream, so any write is raspd's.
  await stopChild(pair.children[1] as ChildProcess)
  const forwarded = [
    ['compile:codex-app-server', 'recipe_not_native'],
    ['compile:claude-code', 'registry_space'],
    ['compile:muse-serve', 'recipe_not_native'],
  ] as const
  const results: unknown[] = []
  for (const [id, reason] of forwarded) {
    const before = tree(stage.base)
    const from = readLog(pair.raspdLog).length
    const replies = await call(
      pair.front,
      'r3e2e/forward',
      'aspc.compileHarnessInvocation',
      caseParams(stage, id)
    )
    // The access line is written after the reply; wait for it.
    let row: Record<string, unknown> | undefined
    for (let i = 0; i < 50 && row === undefined; i++) {
      row = raspdRows(pair.raspdLog, from).find((r) => r['op'] === 'aspc.compileHarnessInvocation')
      if (row === undefined) await Bun.sleep(100)
    }
    const changed = treeDiff(before, tree(stage.base))
    results.push({ id, reply: replies[1], changed, row })
    check(
      `forward-before-write: ${id} with Bun stopped is relayed (${reason}), fails upstream, and raspd wrote nothing`,
      changed.length === 0 &&
        replies[1]?.['error'] !== undefined &&
        row?.['servedBy'] === 'bun' &&
        row?.['fallback'] === reason &&
        row?.['relay'] === 'upstream_failed',
      { changed, row, error: replies[1]?.['error'] }
    )
  }
  const before = tree(stage.base)
  const control = await call(
    pair.front,
    'r3e2e/forward',
    'aspc.compileHarnessInvocation',
    caseParams(stage, 'compile:claude-code:dev')
  )
  const changed = treeDiff(before, tree(stage.base))
  check(
    'forward-before-write control: a native compile with Bun stopped succeeds and its writes are visible to the same check',
    result(control)?.['ok'] === true && changed.length > 0,
    { changedCount: changed.length, sample: changed.slice(0, 5) }
  )
  results.push({ id: 'control', ok: result(control)?.['ok'], changedCount: changed.length })
  record('forward-before-write.json', results)
  await stopPair(pair)
}

// -- 5. latency ----------------------------------------------------------------------

{
  const stage = seedStage(asp, join(scratch, 'lat'))
  const claudeConfig = join(stage.base, 'claude-config')
  mkdirSync(claudeConfig, { recursive: true })
  const env = literalEnv({
    ASP_HOME: stage.aspHome,
    ASP_AGENTS_ROOT: stage.agentsRoot,
    CLAUDE_CONFIG_DIR: claudeConfig,
  })
  const pair = await startPair('lat-pair', env)
  const params = caseParams(stage, 'compile:claude-code:dev')
  const time = async (socket: string) => {
    const times: number[] = []
    for (let i = 0; i < iterations; i++) {
      const t = performance.now()
      const replies = await call(socket, 'r3e2e/latency', 'aspc.compileHarnessInvocation', params)
      if (result(replies)?.['ok'] !== true) throw new Error('latency compile failed')
      times.push(performance.now() - t)
    }
    return times
  }
  await time(pair.front) // warm: the first compile composes the bundle
  const nativeTimes = await time(pair.front)
  const bunTimes = await time(pair.bun)
  const summary = {
    case: 'compile:claude-code:dev (bundle hit, hello + compile on a fresh connection)',
    iterations,
    native: { p50: percentile(nativeTimes, 50), p99: percentile(nativeTimes, 99) },
    bunDirect: { p50: percentile(bunTimes, 50), p99: percentile(bunTimes, 99) },
  }
  record('latency.json', summary)
  console.log(`latency ${JSON.stringify(summary)}`)
  await stopPair(pair)
}

// -- 2. births through Bun hrc and rusthrc ------------------------------------------------

const HRC_RUNTIME = resolve(repo, '..', 'hrc-runtime')
const RUSTHRC =
  arg('--rusthrc') ?? join(repo, 'crates', 'target', 'hrc-runtime', 'debug', 'rusthrc')
if (!process.argv.includes('--no-births')) {
  const base = join(scratch, 'births')
  const agentsRoot = join(base, 'agents')
  const aspHome = join(base, 'asp-home')
  const projectRoot = join(base, 'project')
  cpSync(join(process.env['HOME'] as string, 'praesidium', 'var', 'agents'), agentsRoot, {
    recursive: true,
    verbatimSymlinks: true,
  })
  mkdirSync(aspHome, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  // The seat's real Claude login and workspace trust: no CLAUDE_CONFIG_DIR.
  const pair = await startPair(
    'births-pair',
    literalEnv({ ASP_HOME: aspHome, ASP_AGENTS_ROOT: agentsRoot })
  )
  const root = join(base, 'hrc')
  for (const dir of ['run', 'state']) mkdirSync(join(root, dir), { recursive: true })
  const env: Record<string, string> = {
    ...(Object.fromEntries(
      Object.entries(process.env).filter(
        ([k, v]) =>
          v !== undefined &&
          !/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_SANDBOX|HRC_SESSION_REF|HRC_RUNTIME_ID|HRC_RUN_ID|HRC_HOST_SESSION_ID|HRC_EVENT_FORWARD_URL|HRC_EVENT_INGEST_TCP_PORT|HRC_EVENT_FORWARD_SOURCE_REF|WRKQ_DB_PATH|WRKQ_DB_PATH_FILE|WRKQD_NODE_TOKENS|WRKQD_NODE_TOKENS_FILE|WRKQD_UNIX|TMUX|TMUX_PANE)$/.test(
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
    // The production HRC service's broker flags (com.praesidium.hrc-server).
    HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED: '1',
    HRC_HEADLESS_CODEX_BROKER_ENABLED: '1',
    HRC_BROKER_DURABLE_IPC_ENABLED: '1',
    ASP_HOME: aspHome,
    ASP_AGENTS_ROOT: agentsRoot,
  }
  writeFileSync(
    env['HRC_PEER_CONFIG_FILE'] as string,
    JSON.stringify({ nodeId: 'r3a-t11841', peers: {} }),
    {
      mode: 0o600,
    }
  )
  must(['git', 'init', '-q'], { cwd: projectRoot, env })
  must(['git', 'commit', '-q', '--allow-empty', '-m', 'r3a births'], { cwd: projectRoot, env })
  must(['wrkqadm', 'migrate'], { cwd: projectRoot, env })
  must(['wrkq', 'mkdir', '/project', '--kind', 'project', '--json'], { cwd: projectRoot, env })
  must(['wrkq', 'set', '/project', '--root', projectRoot, '--json'], { cwd: projectRoot, env })
  const hrcCli = ['bun', join(HRC_RUNTIME, 'packages', 'hrc-cli', 'src', 'cli.ts')]
  const hrcSocket = join(root, 'run', 'hrc.sock')
  const status = async () => {
    try {
      const response = await fetch('http://hrc/v1/status', { unix: hrcSocket } as RequestInit)
      return response.status
    } catch {
      return 0
    }
  }
  const births: Record<string, unknown> = {}
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
    const scope = `agent:tabularasa:project:project:task:T-11841-${kind}`
    const start = ready
      ? spawnSync(
          hrcCli[0],
          [
            ...hrcCli.slice(1),
            'start',
            scope,
            '--no-viewer',
            '-p',
            'Reply with exactly the word PONG and nothing else.',
            '--wait',
            'completed',
            '--json',
          ],
          { cwd: projectRoot, env, encoding: 'utf8', timeout: 300_000 }
        )
      : undefined
    const list = ready
      ? spawnSync(hrcCli[0], [...hrcCli.slice(1), 'runtime', 'list', '--json'], {
          cwd: projectRoot,
          env,
          encoding: 'utf8',
          timeout: 60_000,
        })
      : undefined
    let runtimes: Array<Record<string, unknown>> = []
    try {
      const parsed = JSON.parse(list?.stdout ?? '[]') as unknown
      runtimes = (
        Array.isArray(parsed) ? parsed : ((parsed as { runtimes?: unknown[] }).runtimes ?? [])
      ) as Array<Record<string, unknown>>
    } catch {}
    for (const runtime of runtimes) {
      const id = runtime['runtimeId']
      if (typeof id === 'string')
        spawnSync(hrcCli[0], [...hrcCli.slice(1), 'runtime', 'terminate', id], {
          cwd: projectRoot,
          env,
          encoding: 'utf8',
          timeout: 60_000,
        })
    }
    await stopChild(server)
    // Broker tmux servers are per runtime; a terminate the server did not
    // carry out must not leave a seat running after the test.
    const btmux = join(root, 'run', 'btmux')
    for (const name of existsSync(btmux) ? readdirSync(btmux) : []) {
      if (name.endsWith('.sock'))
        spawnSync('tmux', ['-S', join(btmux, name), 'kill-server'], { encoding: 'utf8' })
    }
    await Bun.sleep(200)
    const compiles = raspdRows(pair.raspdLog, from).filter(
      (r) => r['op'] === 'aspc.compileHarnessInvocation'
    )
    births[kind] = {
      ready,
      start: start && {
        status: start.status,
        stdout: start.stdout.slice(-3000),
        stderr: start.stderr.slice(-3000),
      },
      runtimes: runtimes.map((r) => ({
        runtimeId: r['runtimeId'],
        scopeRef: r['scopeRef'],
        status: r['status'],
      })),
      compiles: compiles.map((r) => ({
        client: r['client'],
        servedBy: r['servedBy'],
        outcome: r['outcome'],
        fallback: r['fallback'],
      })),
      serverStderrTail: serverErr.slice(-2000),
    }
    check(
      `${kind} hrc: cold start of a claude seat births from a raspd-native compile and completes its turn`,
      ready &&
        start?.status === 0 &&
        /PONG/.test(start.stdout) &&
        compiles.length >= 1 &&
        compiles.every((r) => r['servedBy'] === 'native'),
      births[kind]
    )
  }
  record('births.json', {
    rusthrc: RUSTHRC,
    hrcRuntimeHead: must(['git', '-C', HRC_RUNTIME, 'rev-parse', 'HEAD']).trim(),
    births,
  })
  await stopPair(pair)
}

// Nothing this run started may outlive it (recorded before the sweep).
record(
  'survivors-before-sweep.txt',
  spawnSync('pgrep', ['-fl', scratch], { encoding: 'utf8' }).stdout
)
spawnSync('pkill', ['-f', scratch])
await Bun.sleep(500)
const survivors = spawnSync('pgrep', ['-fl', scratch], { encoding: 'utf8' }).stdout.trim()
check('no process under the scratch root survives the run', survivors === '', survivors)

const failed = checks.filter((c) => !c.ok)
record('report.json', {
  commit,
  releaseId: release.releaseId,
  sourceCommit: release.sourceCommit,
  devBinary: devBinary ?? null,
  scratch,
  checks,
})
console.log(
  `${checks.length - failed.length}/${checks.length} checks pass; report ${join(out, 'report.json')}`
)
process.exit(failed.length === 0 ? 0 : 1)
