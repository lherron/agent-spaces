#!/usr/bin/env bun
/**
 * Scratch E2E for the aspd-service sole role (T-13055, slice 4a of T-13018,
 * docs/aspd.md "Roles"). One scratch namespace, unsupervised, walks:
 *
 *  1. direct (old release) -> fronted; `sole-enable` refuses the pre-sole
 *     release before stopping anything, and refuses from direct.
 *  2. fronted (new release) -> sole: no Bun aspd process, no aspd-bun.sock,
 *     `version` reports role sole, an agent-harness compile is refused
 *     `unsupported_harness`, a claude-hrcpty compile succeeds.
 *  3. In sole: stop/start/restart keep sole; front-door-disable refuses;
 *     activating the pre-sole release refuses with the namespace still
 *     serving; activating the same release again keeps sole and starts no Bun.
 *  4. front-door-enable from sole returns to fronted, and the same
 *     agent-harness compile is served by Bun (raspd.log servedBy bun).
 *
 * Supervised sole is not run here (the front-door e2e does not supervise
 * either); launchd paths are read, not exercised.
 *
 * Usage: bun scripts/raspd-sole-role-e2e.ts [--out <dir>] [--commit <sha>]
 *          [--release <built release dir>] [--old-release <pre-sole release dir>]
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { basename, join, resolve } from 'node:path'
import { RASPD_SOLE_CAPABILITY } from './aspd-service/release-compatibility.ts'
import { isolateUsageMetrics } from './lib/usage-metrics-isolation.ts'
import { ROWS, compileRequest, createFixture } from './path-markers-e2e.ts'

isolateUsageMetrics()

const repo = resolve(import.meta.dir, '..')
const TASK = 'T-13055'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function run(command: string[], options: { cwd?: string } = {}) {
  const result = spawnSync(command[0] as string, command.slice(1), {
    cwd: options.cwd ?? repo,
    env: process.env,
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function must(command: string[], options: { cwd?: string } = {}): string {
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
const out = resolve(arg('--out') ?? join(repo, '..', 'var', 'wrkq-artifacts', TASK, 'e2e', stamp))
mkdirSync(out, { recursive: true })
// Unix socket paths are limited to 104 bytes on macOS; the scratch root stays short.
const scratchParent = join(repo, '..', 'var', 'scratch', 'agent-spaces', TASK)
mkdirSync(scratchParent, { recursive: true })
const scratch = mkdtempSync(join(resolve(scratchParent), 'sr-'))
const ns = join(scratch, 'ns')
const publicSocket = join(ns, 'run', 'aspd.sock')
const bunSocket = join(ns, 'run', 'aspd-bun.sock')

type Step = { step: string; ok: boolean; detail?: unknown }
const steps: Step[] = []
const transcript: string[] = []
const log = (line: string) => {
  transcript.push(line)
  console.log(line)
}
const check = (step: string, ok: boolean, detail?: unknown) => {
  steps.push({ step, ok, ...(detail === undefined ? {} : { detail }) })
  log(`${ok ? 'PASS' : 'FAIL'} ${step}`)
}
const record = (name: string, value: unknown) =>
  writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`)

/** One aspd-service verb; a refusal returns its exit and stderr instead of throwing. */
function service(...args: string[]): {
  status: number | null
  json?: Record<string, unknown>
  stderr: string
} {
  log(`$ aspd-service ${args.map((a) => a.replace(scratch, '<scratch>')).join(' ')}`)
  const result = run(['bun', join(repo, 'scripts', 'aspd-service.ts'), ...args])
  if (result.status !== 0) log(`  exit ${result.status}: ${result.stderr.trim()}`)
  return {
    status: result.status,
    stderr: result.stderr.trim(),
    ...(result.status === 0 ? { json: JSON.parse(result.stdout) as Record<string, unknown> } : {}),
  }
}
function serviceOk(name: string, ...args: string[]): Record<string, unknown> {
  const result = service(...args)
  record(`${name}.json`, result.json ?? { status: result.status, stderr: result.stderr })
  if (result.json === undefined) throw new Error(`aspd-service ${args[0]} failed: ${result.stderr}`)
  return result.json
}

// -- releases -------------------------------------------------------------------

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
type Manifest = {
  sourceCommit: string
  capabilities?: string[]
  executables: Record<string, unknown>
}
const manifestOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8')) as Manifest

/** A release id's build stamp, `asp-<commit>-<stamp>-<suffix>`. */
const builtAt = (dir: string) => basename(dir).split('-')[2] ?? ''

/** The newest retained build whose raspd predates sole mode. */
function findOldRelease(): string {
  const root = join(
    process.env['HOME'] as string,
    '.local',
    'state',
    'praesidium',
    'asp-release-builds'
  )
  const candidates = (existsSync(root) ? readdirSync(root) : [])
    .filter((name) => name.startsWith('asp-'))
    .map((name) => join(root, name))
    .filter((dir) => {
      if (!existsSync(join(dir, 'release.json'))) return false
      const m = manifestOf(dir)
      return (
        m.executables['raspd'] !== undefined && !m.capabilities?.includes(RASPD_SOLE_CAPABILITY)
      )
    })
    .sort((a, b) => builtAt(a).localeCompare(builtAt(b)))
  const newest = candidates.at(-1)
  if (newest === undefined)
    throw new Error(`no pre-sole release with raspd under ${root}; pass --old-release`)
  return newest
}
const oldRelease = arg('--old-release') ?? findOldRelease()
const releaseId = basename(builtRelease)
const oldReleaseId = basename(oldRelease)
const manifest = manifestOf(builtRelease)
log(`release ${releaseId} (source ${manifest.sourceCommit}); pre-sole release ${oldReleaseId}`)
log(`scratch ${scratch}`)
check(
  `the new release declares ${RASPD_SOLE_CAPABILITY}; the old one does not`,
  manifest.capabilities?.includes(RASPD_SOLE_CAPABILITY) === true &&
    manifestOf(oldRelease).capabilities?.includes(RASPD_SOLE_CAPABILITY) !== true,
  { new: manifest.capabilities, old: manifestOf(oldRelease).capabilities }
)

serviceOk('init', 'init', ns)
// spawnSync is synchronous, so an exit (a failed step or a throw) still
// retires the scratch daemons; a stop of a stopped namespace is a no-op.
process.on('exit', () => {
  run(['bun', join(repo, 'scripts', 'aspd-service.ts'), 'stop', ns])
})
for (const artifact of [oldRelease, builtRelease]) {
  must([
    'bun',
    join(repo, 'scripts', 'asp-release.ts'),
    'install',
    '--artifact',
    artifact,
    '--release-root',
    join(ns, 'releases'),
  ])
}

// -- fixture --------------------------------------------------------------------

const asp = {
  config: await import('spaces-config'),
  contracts: await import('spaces-runtime-contracts'),
} as unknown as Parameters<typeof createFixture>[0]
const fixture = createFixture(asp, join(scratch, 'fx'))
const configPath = join(ns, 'service', 'config.json')
{
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { env: Record<string, string> }
  config.env = {
    ...config.env,
    ASP_HOME: fixture.aspHome,
    ASP_AGENTS_ROOT: fixture.agentsRoot,
    ASP_USAGE_METRICS_VAR_ROOT: join(scratch, 'metrics'),
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}
const roleInConfig = () => {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    frontDoor?: { sole?: boolean }
  }
  return config.frontDoor === undefined
    ? 'direct'
    : config.frontDoor.sole === true
      ? 'sole'
      : 'fronted'
}

// -- rpc helpers ----------------------------------------------------------------

type Reply = Record<string, unknown>
async function send(
  socketPath: string,
  frame: Record<string, unknown>,
  client: string
): Promise<Reply> {
  return await new Promise((done, reject) => {
    const socket = connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`rpc timeout on ${socketPath}`))
    }, 120_000)
    let buffer = ''
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, client, ...frame })}\n`)
    )
    const decoder = new TextDecoder()
    socket.on('data', (chunk) => {
      buffer += decoder.decode(chunk, { stream: true })
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      clearTimeout(timer)
      socket.end()
      done(JSON.parse(buffer.slice(0, newline)) as Reply)
    })
  })
}
const version = async () =>
  ((await send(publicSocket, { method: 'version', params: {} }, 'sole-e2e/version'))['result'] ??
    {}) as Record<string, unknown>
const frontRole = (v: Record<string, unknown>) =>
  (v['frontDoor'] as { role?: string } | undefined)?.role
const releaseOf = (v: Record<string, unknown>) =>
  (v['release'] as { releaseId?: string } | undefined)?.releaseId

const AGENT_HARNESS = ROWS.find(
  (row) => row.id === 'agent-harness-headless'
) as (typeof ROWS)[number]
// pathmark-dev: the fixture's other agent composes a git-pinned space, which
// sole raspd refuses registry_space_unsupported (T-13018 section 1).
const CLAUDE_HRCPTY = {
  id: 'claude-hrcpty',
  requested: { harness: 'claude-hrcpty', presentation: true },
  agent: 'pathmark-dev',
} as unknown as (typeof ROWS)[number]
const compile = async (row: (typeof ROWS)[number], tag: string, client: string) =>
  (
    await send(
      publicSocket,
      {
        method: 'aspc.compileHarnessInvocation',
        params: {
          compileRequest: compileRequest(asp, fixture, { ...row, id: `${row.id}-${tag}` }),
        },
      },
      client
    )
  )['result'] as { ok?: boolean; diagnostics?: { code?: string }[] } & Record<string, unknown>

/** Bun aspd processes whose command line names this namespace. */
function bunProcesses(): string[] {
  return must(['ps', '-axo', 'pid=,command='])
    .split('\n')
    .filter((line) => line.includes(ns) && /(^|\/)aspd\s+serve\b/.test(line))
    .map((line) => line.trim())
}
const raspdLog = () =>
  (existsSync(join(ns, 'logs', 'raspd.log'))
    ? readFileSync(join(ns, 'logs', 'raspd.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
    : []
  )
    .map((line) => JSON.parse(line) as { event?: string; data?: Record<string, unknown> })
    .filter((line) => line.event === 'rpc.request')
    .map((line) => line.data as Record<string, unknown>)
const raspdPid = () =>
  Number((JSON.parse(readFileSync(join(ns, 'run', 'raspd.json'), 'utf8')) as { pid: number }).pid)

// -- 1. direct -> fronted on the pre-sole release; sole-enable refuses ------------

log('\n## 1. direct -> fronted on the pre-sole release')
serviceOk('activate-old-direct', 'activate', ns, oldReleaseId)
const fromDirect = service('sole-enable', ns)
check(
  'sole-enable from direct refuses (a namespace is fronted first)',
  fromDirect.status !== 0 && /run front-door-enable first/.test(fromDirect.stderr),
  fromDirect.stderr
)
serviceOk('front-door-enable-old', 'front-door-enable', ns)
const oldBunPids = bunProcesses()
const oldRefused = service('sole-enable', ns)
const afterOldRefusal = serviceOk('status-after-old-sole-refusal', 'front-door-status', ns)
check(
  'sole-enable on the pre-sole release refuses before stopping anything',
  oldRefused.status !== 0 &&
    /predates raspd sole mode/.test(oldRefused.stderr) &&
    afterOldRefusal['mode'] === 'fronted' &&
    afterOldRefusal['bunAnswering'] === true &&
    JSON.stringify(bunProcesses()) === JSON.stringify(oldBunPids) &&
    roleInConfig() === 'fronted',
  { stderr: oldRefused.stderr, status: afterOldRefusal }
)

// -- 2. fronted on the new release -> sole ----------------------------------------

log('\n## 2. fronted (new release) -> sole')
const frontedActivation = serviceOk('activate-new-fronted', 'activate', ns, releaseId)
const frontedStatus = serviceOk('status-fronted', 'front-door-status', ns)
check(
  'activate keeps fronted: raspd on aspd.sock in front of Bun, both the new release',
  frontedActivation['role'] === 'fronted' &&
    frontedStatus['mode'] === 'fronted' &&
    frontedStatus['bunAnswering'] === true &&
    (frontedStatus['publicRelease'] as { releaseId?: string })?.releaseId === releaseId,
  frontedStatus
)
const soleEnabled = serviceOk('sole-enable', 'sole-enable', ns)
const soleVersion = await version()
const soleStatus = serviceOk('status-sole', 'status', ns)
check(
  'sole-enable: no Bun aspd process, no aspd-bun.sock, version role sole, status role sole',
  soleEnabled['mode'] === 'sole' &&
    bunProcesses().length === 0 &&
    !existsSync(bunSocket) &&
    !existsSync(join(ns, 'run', 'aspd.json')) &&
    frontRole(soleVersion) === 'sole' &&
    releaseOf(soleVersion) === releaseId &&
    soleStatus['role'] === 'sole' &&
    (soleStatus['frontDoor'] as { mode?: string })['mode'] === 'sole' &&
    roleInConfig() === 'sole',
  {
    bunProcesses: bunProcesses(),
    version: soleVersion['frontDoor'],
    status: soleStatus['frontDoor'],
  }
)
const refusedHarness = await compile(AGENT_HARNESS, 'sole', 'sole-e2e/sole')
check(
  'in sole an agent-harness compile is refused unsupported_harness',
  refusedHarness?.ok === false && refusedHarness.diagnostics?.[0]?.code === 'unsupported_harness',
  refusedHarness?.diagnostics
)
const claudeHrcpty = await compile(CLAUDE_HRCPTY, 'sole', 'sole-e2e/sole')
check(
  'in sole a claude-hrcpty compile succeeds (claude-code-hrcpty driver)',
  claudeHrcpty?.ok === true && JSON.stringify(claudeHrcpty).includes('claude-code-hrcpty'),
  { ok: claudeHrcpty?.ok, diagnostics: claudeHrcpty?.diagnostics }
)
record('compiles-sole.json', { refusedHarness, claudeHrcpty })

// -- 3. every other verb keeps sole -------------------------------------------------

log('\n## 3. verbs keep sole')
serviceOk('stop-sole', 'stop', ns)
const stoppedClean = !existsSync(join(ns, 'run', 'raspd.json')) && bunProcesses().length === 0
serviceOk('start-sole', 'start', ns)
const startedVersion = await version()
const beforeRestart = raspdPid()
serviceOk('restart-sole', 'restart', ns)
const restartedVersion = await version()
check(
  'stop, start and restart in sole run raspd alone, never Bun',
  stoppedClean &&
    frontRole(startedVersion) === 'sole' &&
    frontRole(restartedVersion) === 'sole' &&
    raspdPid() !== beforeRestart &&
    bunProcesses().length === 0 &&
    !existsSync(bunSocket),
  { startedRole: frontRole(startedVersion), restartedRole: frontRole(restartedVersion) }
)
const disableFromSole = service('front-door-disable', ns)
check(
  'front-door-disable from sole refuses and names front-door-enable',
  disableFromSole.status !== 0 &&
    /run front-door-enable first/.test(disableFromSole.stderr) &&
    roleInConfig() === 'sole' &&
    frontRole(await version()) === 'sole',
  disableFromSole.stderr
)
const servingPid = raspdPid()
const oldInSole = service('activate', ns, oldReleaseId)
const afterOldActivate = await version()
const stillServes = await compile(CLAUDE_HRCPTY, 'after-old-refusal', 'sole-e2e/sole')
check(
  'activating the pre-sole release in sole refuses, the namespace still serving',
  oldInSole.status !== 0 &&
    /predates raspd sole mode/.test(oldInSole.stderr) &&
    raspdPid() === servingPid &&
    frontRole(afterOldActivate) === 'sole' &&
    releaseOf(afterOldActivate) === releaseId &&
    stillServes?.ok === true &&
    roleInConfig() === 'sole',
  { stderr: oldInSole.stderr, version: afterOldActivate['frontDoor'] }
)
const reactivated = serviceOk('activate-same-sole', 'activate', ns, releaseId)
const reactivatedVersion = await version()
check(
  'activate of the same release again keeps sole and starts no Bun',
  reactivated['role'] === 'sole' &&
    reactivated['started'] === undefined &&
    frontRole(reactivatedVersion) === 'sole' &&
    releaseOf(reactivatedVersion) === releaseId &&
    bunProcesses().length === 0 &&
    !existsSync(bunSocket) &&
    roleInConfig() === 'sole',
  { role: reactivated['role'], version: reactivatedVersion['frontDoor'] }
)

// -- 4. rollback: front-door-enable from sole ---------------------------------------

log('\n## 4. front-door-enable from sole (rollback)')
const restored = serviceOk('front-door-enable-from-sole', 'front-door-enable', ns)
const restoredVersion = await version()
const restoredStatus = restored['status'] as Record<string, unknown>
check(
  'front-door-enable from sole: Bun back on aspd-bun.sock, raspd restarted with --upstream',
  restored['mode'] === 'fronted' &&
    restoredStatus['bunAnswering'] === true &&
    (restoredStatus['bunRelease'] as { releaseId?: string })?.releaseId === releaseId &&
    bunProcesses().length === 1 &&
    existsSync(bunSocket) &&
    frontRole(restoredVersion) === 'front' &&
    (restoredVersion['frontDoor'] as { upstream?: string })['upstream'] === bunSocket &&
    roleInConfig() === 'fronted',
  { status: restoredStatus, version: restoredVersion['frontDoor'] }
)
const servedByBun = await compile(AGENT_HARNESS, 'restored', 'sole-e2e/restored')
await Bun.sleep(500)
const restoredLines = raspdLog().filter(
  (line) => line['client'] === 'sole-e2e/restored' && line['op'] === 'aspc.compileHarnessInvocation'
)
check(
  'the same agent-harness compile is now served by Bun',
  servedByBun?.diagnostics?.[0]?.code !== 'unsupported_harness' &&
    restoredLines.length === 1 &&
    restoredLines[0]?.['servedBy'] === 'bun',
  { ok: servedByBun?.ok, diagnostics: servedByBun?.diagnostics, log: restoredLines }
)
record('compiles-restored.json', { servedByBun, raspdLog: restoredLines })

// -- teardown -------------------------------------------------------------------------

serviceOk('stop-final', 'stop', ns)
check(
  'stop leaves no daemon of the namespace running',
  bunProcesses().length === 0 && !existsSync(join(ns, 'run', 'raspd.json'))
)
if (existsSync(join(ns, 'logs', 'raspd.log'))) {
  writeFileSync(join(out, 'log-raspd.log'), readFileSync(join(ns, 'logs', 'raspd.log')))
}
const failed = steps.filter((s) => !s.ok)
record('summary.json', {
  at: new Date().toISOString(),
  commit,
  releaseId,
  sourceCommit: manifest.sourceCommit,
  oldReleaseId,
  scratch,
  supervised: false,
  passed: steps.length - failed.length,
  failed: failed.length,
  steps,
})
log(`${steps.length - failed.length}/${steps.length} steps pass; artifacts ${out}`)
writeFileSync(join(out, 'transcript.txt'), `${transcript.join('\n')}\n`)
if (failed.length === 0) {
  // Installed releases are sealed read-only; unseal before removing.
  run(['chmod', '-R', 'u+w', scratch])
  run(['rm', '-rf', scratch])
}
process.exit(failed.length === 0 ? 0 : 1)
