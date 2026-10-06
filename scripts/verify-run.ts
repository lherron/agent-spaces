/**
 * `just verify` supervisor and `just verify-cancel` (T-10388, foundry R-00309).
 *
 *   bun scripts/verify-run.ts run -- <command...>
 *   bun scripts/verify-run.ts cancel [--force]
 *
 * `run` takes the shared verify lock (the file seats have always wrapped with
 * `lockf -k <lock> just verify`), records the holder in a JSON pidfile next to
 * it, and runs the command as the leader of its own process group. The
 * pidfile goes away on every exit path; the lock goes with the process.
 * Under the legacy `lockf -k <lock> just verify` wrapper the lock is already
 * held by an ancestor, so `run` proceeds without taking it again.
 *
 * `cancel` stops the recorded run by pid and process group only. It never
 * matches processes by command line: it checks that the recorded pid is still
 * this supervisor (start time and command) before signalling, then sends
 * SIGTERM to the run's process group and to every group its descendants
 * opened (bounded-step puts each test step in its own), escalates to SIGKILL
 * after a grace period, and confirms nothing survives. A run that belongs to
 * another scope needs --force.
 *
 * ASP_VERIFY_LOCK overrides the lock path (the pidfile sits beside it, .pid)
 * and ASP_VERIFY_CANCEL_GRACE_MS the SIGTERM grace period.
 */

import { dlopen } from 'bun:ffi'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

const DEFAULT_LOCK = `${homedir()}/praesidium/var/run/agent-spaces-verify.lock`
const DEFAULT_GRACE_MS = 10_000
const LOCK_POLL_MS = 2_000
const LOG = '[verify]'

interface PidRecord {
  pid: number
  pgid: number
  /** `ps -o lstart=` of the supervisor; guards against pid reuse. */
  processStart?: string
  startedAt: string
  cwd?: string
  head?: string | null
  scope?: string | null
  sessionRef?: string | null
  command?: string[]
}

const lockPath = process.env.ASP_VERIFY_LOCK || DEFAULT_LOCK
const pidPath = `${lockPath.replace(/\.lock$/, '')}.pid`

function callerScope(): string | null {
  return process.env.AGENT_SCOPE_REF || process.env.ASP_SCOPE_REF || null
}

function ps(fields: string, pid: number): string | null {
  const columns = fields.split(',').flatMap((field) => ['-o', `${field}=`])
  const result = spawnSync('ps', [...columns, '-p', String(pid)], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

// --- lock -------------------------------------------------------------------

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

type Flock = (fd: number, op: number) => number

function loadFlock(): Flock | null {
  const lib = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'
  try {
    const { symbols } = dlopen(lib, { flock: { args: ['i32', 'i32'], returns: 'i32' } })
    return (fd, op) => symbols.flock(fd, op) as number
  } catch {
    return null
  }
}

/** True when an ancestor of this process is `lockf` holding this lock file. */
function ancestorHoldsLock(): boolean {
  let pid = process.ppid
  while (pid > 1) {
    const line = ps('ppid,comm', pid)
    if (!line) return false
    const [ppid, ...comm] = line.split(/\s+/)
    if (comm.join(' ').split('/').pop() === 'lockf') {
      const args = ps('command', pid) ?? ''
      if (args.split(/\s+/).includes(lockPath)) return true
    }
    pid = Number(ppid)
  }
  return false
}

function describeHolder(record: PidRecord | null): string {
  if (!record) return 'an unrecorded holder'
  const age = Math.round((Date.now() - Date.parse(record.startedAt)) / 1000)
  return `${record.scope ?? 'no scope'} (pid ${record.pid}, ${record.cwd ?? '?'} @ ${(record.head ?? '?').slice(0, 12)}, ${Number.isFinite(age) ? `${age}s` : 'unknown age'})`
}

/** Takes the lock, waiting for its holder; returns the fd to release, or null. */
async function acquireLock(): Promise<number | null> {
  mkdirSync(dirname(lockPath), { recursive: true })
  const flock = loadFlock()
  if (!flock) {
    console.error(`${LOG} flock(2) unavailable on this platform; running without the verify lock`)
    return null
  }
  const fd = openSync(lockPath, 'a')
  if (flock(fd, LOCK_EX | LOCK_NB) === 0) return fd
  if (ancestorHoldsLock()) {
    closeSync(fd)
    console.error(
      `${LOG} an outer lockf already holds ${lockPath}; running under it. The wrapper is no longer needed: run \`just verify\`.`
    )
    return null
  }
  console.error(
    `${LOG} waiting for the verify lock held by ${describeHolder(readRecord())}; stop it with \`just verify-cancel\``
  )
  while (flock(fd, LOCK_EX | LOCK_NB) !== 0) await Bun.sleep(LOCK_POLL_MS)
  return fd
}

// --- pidfile ----------------------------------------------------------------

function readRecord(): PidRecord | null {
  try {
    const record = JSON.parse(readFileSync(pidPath, 'utf8')) as PidRecord
    return Number.isInteger(record.pid) && Number.isInteger(record.pgid) ? record : null
  } catch {
    return null
  }
}

function writeRecord(record: PidRecord): void {
  const tmp = `${pidPath}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(tmp, pidPath)
}

/** Removes the pidfile only while it still names `pid`. */
function removeRecord(pid: number): void {
  if (readRecord()?.pid === pid) rmSync(pidPath, { force: true })
}

// --- process groups ---------------------------------------------------------

interface ProcRow {
  pid: number
  ppid: number
  pgid: number
}

function processTable(): ProcRow[] {
  // Zombies are already dead; they only wait for their parent to reap them.
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' })
  return result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length === 4 && !cols[3]?.startsWith('Z'))
    .map(([pid, ppid, pgid]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid) }))
}

/**
 * Adds to `groups` the group of every process descended from `root` or from a
 * member of a tracked group (orphans reparent to launchd but keep their
 * group), except `exclude` — the supervisor's own group, which it shares with
 * its caller. Returns the live members of tracked groups.
 */
function trackGroups(root: number, groups: Set<number>, exclude: number): ProcRow[] {
  const table = processTable()
  const children = new Map<number, ProcRow[]>()
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  const queue = [root, ...table.filter((r) => groups.has(r.pgid)).map((r) => r.pid)]
  const seen = new Set<number>()
  while (queue.length > 0) {
    const pid = queue.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const child of children.get(pid) ?? []) {
      if (child.pgid !== exclude && child.pgid > 1) groups.add(child.pgid)
      queue.push(child.pid)
    }
  }
  return table.filter((r) => groups.has(r.pgid))
}

function signalGroups(groups: Set<number>, signal: NodeJS.Signals): void {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, signal)
    } catch {
      // The group already exited.
    }
  }
}

/** A zombie counts as gone: it has exited and only awaits its parent's reap. */
function alive(pid: number): boolean {
  const stat = ps('stat', pid)
  return stat !== null && stat !== '' && !stat.startsWith('Z')
}

// --- run --------------------------------------------------------------------

async function run(command: string[]): Promise<number> {
  const [file, ...args] = command
  if (file === undefined) {
    console.error('usage: bun scripts/verify-run.ts run -- <command...>')
    return 2
  }
  const lockFd = await acquireLock()
  const ownGroup = Number(ps('pgid', process.pid))
  const child: ChildProcess = spawn(file, args, { stdio: 'inherit', detached: true })
  if (child.pid === undefined) {
    console.error(`${LOG} failed to start ${file}`)
    return 1
  }
  const pgid = child.pid
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  writeRecord({
    pid: process.pid,
    pgid,
    processStart: ps('lstart', process.pid) ?? undefined,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    head: head.status === 0 ? head.stdout.trim() : null,
    scope: callerScope(),
    sessionRef: process.env.HRC_SESSION_REF || null,
    command,
  })

  // The run leads its own group, so a terminal Ctrl-C or a SIGTERM aimed at
  // this supervisor is forwarded to it and every group it opened.
  let signalled: NodeJS.Signals | null = null
  const groups = new Set([pgid])
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      const escalate = signalled !== null
      signalled = signal
      trackGroups(process.pid, groups, ownGroup)
      signalGroups(groups, escalate ? 'SIGKILL' : signal)
    })
  }

  const code = await new Promise<number>((resolve) => {
    child.on('error', (error) => {
      console.error(`${LOG} failed to start ${file}: ${error.message}`)
      resolve(1)
    })
    child.on('close', (exitCode, signal) =>
      resolve(typeof exitCode === 'number' ? exitCode : 128 + (signal === 'SIGKILL' ? 9 : 15))
    )
  })
  removeRecord(process.pid)
  if (lockFd !== null) {
    loadFlock()?.(lockFd, LOCK_UN)
    closeSync(lockFd)
  }
  if (signalled) return code === 0 ? 130 : code
  return code
}

// --- cancel -----------------------------------------------------------------

/** Why `record` no longer describes a live supervisor, or null when it does. */
function staleReason(record: PidRecord): string | null {
  if (!alive(record.pid)) return `pid ${record.pid} is not running`
  const command = ps('command', record.pid) ?? ''
  if (!command.includes('verify-run'))
    return `pid ${record.pid} is now \`${command}\`, not a verify`
  if (!record.processStart || ps('lstart', record.pid) !== record.processStart) {
    return `pid ${record.pid} started at a different time than the recorded verify`
  }
  return null
}

async function waitGone(
  record: PidRecord,
  groups: Set<number>,
  exclude: number,
  ms: number
): Promise<ProcRow[]> {
  const deadline = Date.now() + ms
  for (;;) {
    const members = trackGroups(record.pid, groups, exclude)
    const survivors = alive(record.pid)
      ? [...members, { pid: record.pid, ppid: 0, pgid: exclude }]
      : members
    if (survivors.length === 0 || Date.now() >= deadline) return survivors
    await Bun.sleep(100)
  }
}

async function cancel(force: boolean): Promise<number> {
  const record = readRecord()
  if (!record) {
    console.log(`${LOG} no verify is running (no pidfile at ${pidPath})`)
    return 0
  }
  const stale = staleReason(record)
  if (stale) {
    console.log(`${LOG} stale pidfile ${pidPath}: ${stale}; removed it and signalled nothing`)
    rmSync(pidPath, { force: true })
    return 0
  }
  console.log(`${LOG} verify run: ${describeHolder(record)}, process group ${record.pgid}`)
  const caller = callerScope()
  if ((record.scope ?? null) !== caller && !force) {
    console.error(
      `${LOG} this run belongs to ${record.scope ?? 'a caller with no scope'}, not ${caller ?? 'you (no scope)'}; pass --force to cancel it anyway`
    )
    return 2
  }

  const exclude = Number(ps('pgid', record.pid))
  const groups = new Set([record.pgid])
  trackGroups(record.pid, groups, exclude)
  const graceMs = Number(process.env.ASP_VERIFY_CANCEL_GRACE_MS) || DEFAULT_GRACE_MS
  console.log(`${LOG} SIGTERM to process groups ${[...groups].join(' ')}`)
  signalGroups(groups, 'SIGTERM')
  let survivors = await waitGone(record, groups, exclude, graceMs)

  if (survivors.length > 0) {
    console.log(`${LOG} ${survivors.length} processes outlived ${graceMs}ms; SIGKILL`)
    signalGroups(groups, 'SIGKILL')
    if (alive(record.pid) && staleReason(record) === null) process.kill(record.pid, 'SIGKILL')
    survivors = await waitGone(record, groups, exclude, 3_000)
  }
  removeRecord(record.pid)
  if (survivors.length > 0) {
    console.error(`${LOG} still running after SIGKILL: ${survivors.map((r) => r.pid).join(' ')}`)
    return 1
  }
  console.log(`${LOG} cancelled; nothing in the run survives and the verify lock is free`)
  return 0
}

// --- main -------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2)
if (mode === 'run') {
  process.exit(await run(rest[0] === '--' ? rest.slice(1) : rest))
} else if (mode === 'cancel') {
  const unknown = rest.filter((arg) => arg !== '--force')
  if (unknown.length > 0) {
    console.error(`usage: just verify-cancel [--force] (unknown: ${unknown.join(' ')})`)
    process.exit(2)
  }
  process.exit(await cancel(rest.includes('--force')))
} else {
  console.error('usage: bun scripts/verify-run.ts run -- <command...> | cancel [--force]')
  process.exit(2)
}
