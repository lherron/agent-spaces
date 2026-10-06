/**
 * End-to-end tests for the `just verify` supervisor and `just verify-cancel`
 * (T-10388, foundry R-00309). Every test drives real processes against a
 * private lock file, so it never touches the host's shared verify lock.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'verify-run.ts')
const SCOPE_A = 'agent:test-a:project:agent-spaces'
const SCOPE_B = 'agent:test-b:project:agent-spaces'

const dirs: string[] = []
const strays: number[] = []

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sandbox(): { dir: string; lock: string; pidfile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'verify-run-'))
  dirs.push(dir)
  // A missing lock directory must be created (CI, fresh nodes).
  const lock = join(dir, 'run', 'verify.lock')
  return { dir, lock, pidfile: join(dir, 'run', 'verify.pid') }
}

function env(lock: string, scope: string | undefined): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ASP_VERIFY_LOCK: lock,
    ASP_VERIFY_CANCEL_GRACE_MS: '1500',
  }
  base.AGENT_SCOPE_REF = undefined
  base.ASP_SCOPE_REF = undefined
  base.HRC_SESSION_REF = undefined
  if (scope) base.AGENT_SCOPE_REF = scope
  return base
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function lockFree(lock: string): boolean {
  return spawnSync('lockf', ['-k', '-t', '0', lock, 'true']).status === 0
}

async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

interface Run {
  pid: number
  output: () => string
  exited: Promise<number | null>
}

function startRun(command: string[], runEnv: NodeJS.ProcessEnv, prefix: string[] = []): Run {
  const argv = [...prefix, 'bun', SCRIPT, 'run', '--', ...command]
  const [file, ...args] = argv as [string, ...string[]]
  const child = spawn(file, args, { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  if (child.pid === undefined) throw new Error('run failed to start')
  strays.push(child.pid)
  let output = ''
  child.stdout?.on('data', (d: Buffer) => {
    output += d.toString()
  })
  child.stderr?.on('data', (d: Buffer) => {
    output += d.toString()
  })
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
  return { pid: child.pid, output: () => output, exited }
}

function cancel(
  cancelEnv: NodeJS.ProcessEnv,
  ...args: string[]
): { status: number | null; out: string } {
  const result = spawnSync('bun', [SCRIPT, 'cancel', ...args], { env: cancelEnv, encoding: 'utf8' })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

// A step that ignores SIGTERM and spins, plus a grandchild that escapes into
// its own session the way bounded-step's per-package steps do.
function spinnerCommand(pidsFile: string): string[] {
  return [
    'bash',
    '-c',
    `bash -c 'trap "" TERM; while :; do :; done' &
spinner=$!
perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "1000"' &
escaped=$!
echo "$spinner $escaped" > ${pidsFile}
wait`,
  ]
}

describe('verify supervisor and verify-cancel', () => {
  test('cancel kills the whole run, including escaped groups, and releases the lock', async () => {
    const { dir, lock, pidfile } = sandbox()
    const pidsFile = join(dir, 'pids')
    const run = startRun(spinnerCommand(pidsFile), env(lock, SCOPE_A))
    await until(() => existsSync(pidfile) && existsSync(pidsFile), 10_000, 'pidfile and spinner')

    const record = JSON.parse(readFileSync(pidfile, 'utf8'))
    expect(record.pid).toBe(run.pid)
    expect(record.scope).toBe(SCOPE_A)
    expect(typeof record.pgid).toBe('number')
    expect(record.cwd).toBeString()
    expect(lockFree(lock)).toBe(false)
    const [spinner, escaped] = readFileSync(pidsFile, 'utf8').trim().split(' ').map(Number) as [
      number,
      number,
    ]
    strays.push(spinner, escaped, record.pgid)

    const result = cancel(env(lock, SCOPE_A))
    expect(result.out).toContain(SCOPE_A)
    expect(result.status).toBe(0)

    await run.exited
    for (const pid of [run.pid, record.pgid, spinner, escaped]) expect(alive(pid)).toBe(false)
    expect(existsSync(pidfile)).toBe(false)
    expect(lockFree(lock)).toBe(true)
  }, 30_000)

  test('a run finishing normally removes its pidfile and passes its exit code through', async () => {
    const { lock, pidfile } = sandbox()
    const run = startRun(['bash', '-c', 'exit 3'], env(lock, SCOPE_A))
    expect(await run.exited).toBe(3)
    expect(existsSync(pidfile)).toBe(false)
    expect(lockFree(lock)).toBe(true)
  }, 15_000)

  test('the legacy outer lockf wrapper on the same lock does not deadlock', async () => {
    const { dir, lock, pidfile } = sandbox()
    spawnSync('mkdir', ['-p', join(dir, 'run')])
    const run = startRun(['bash', '-c', 'echo inner-ran'], env(lock, SCOPE_A), [
      'lockf',
      '-k',
      lock,
    ])
    const code = await Promise.race([run.exited, Bun.sleep(10_000).then(() => 'deadlock')])
    expect(code).toBe(0)
    expect(run.output()).toContain('inner-ran')
    expect(run.output()).toContain('outer lockf')
    expect(existsSync(pidfile)).toBe(false)
  }, 15_000)

  test('an unrelated holder of the lock makes the run wait instead of running concurrently', async () => {
    const { dir, lock } = sandbox()
    spawnSync('mkdir', ['-p', join(dir, 'run')])
    const holder = spawn('lockf', ['-k', lock, 'sleep', '30'], { stdio: 'ignore' })
    if (holder.pid === undefined) throw new Error('holder failed to start')
    strays.push(holder.pid)
    await until(() => !lockFree(lock), 5_000, 'holder to take the lock')

    const marker = join(dir, 'ran')
    const run = startRun(['bash', '-c', `touch ${marker}`], env(lock, SCOPE_A))
    await Bun.sleep(1_500)
    expect(existsSync(marker)).toBe(false)
    expect(run.output()).toContain('waiting')

    process.kill(holder.pid, 'SIGKILL')
    expect(await run.exited).toBe(0)
    expect(existsSync(marker)).toBe(true)
  }, 20_000)

  test('a run owned by another scope needs --force, which names the owner', async () => {
    const { lock, pidfile } = sandbox()
    const run = startRun(['sleep', '1000'], env(lock, SCOPE_A))
    await until(() => existsSync(pidfile), 10_000, 'pidfile')
    const record = JSON.parse(readFileSync(pidfile, 'utf8'))
    strays.push(record.pgid)

    const refused = cancel(env(lock, SCOPE_B))
    expect(refused.status).not.toBe(0)
    expect(refused.out).toContain(SCOPE_A)
    expect(refused.out).toContain('--force')
    expect(alive(run.pid)).toBe(true)
    expect(alive(record.pgid)).toBe(true)

    const forced = cancel(env(lock, SCOPE_B), '--force')
    expect(forced.status).toBe(0)
    await run.exited
    expect(alive(record.pgid)).toBe(false)
    expect(existsSync(pidfile)).toBe(false)
  }, 30_000)

  test('a stale pidfile naming a dead pid is reported and removed', async () => {
    const { dir, lock, pidfile } = sandbox()
    spawnSync('mkdir', ['-p', join(dir, 'run')])
    const dead = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(
      pidfile,
      JSON.stringify({ pid: Number(dead), pgid: Number(dead), scope: SCOPE_A, startedAt: 'x' })
    )
    const result = cancel(env(lock, SCOPE_A))
    expect(result.status).toBe(0)
    expect(result.out).toContain('stale')
    expect(existsSync(pidfile)).toBe(false)
  })

  test('a pidfile whose pid was reused by another process kills nothing', async () => {
    const { dir, lock, pidfile } = sandbox()
    spawnSync('mkdir', ['-p', join(dir, 'run')])
    const bystander = spawn('sleep', ['1000'], { stdio: 'ignore', detached: true })
    if (bystander.pid === undefined) throw new Error('bystander failed to start')
    strays.push(bystander.pid)
    writeFileSync(
      pidfile,
      JSON.stringify({ pid: bystander.pid, pgid: bystander.pid, scope: SCOPE_A, startedAt: 'x' })
    )
    const result = cancel(env(lock, SCOPE_A))
    expect(result.status).toBe(0)
    expect(result.out).toContain('stale')
    expect(alive(bystander.pid)).toBe(true)
    expect(existsSync(pidfile)).toBe(false)
  })

  test('cancel with no run in progress says so', () => {
    const { lock } = sandbox()
    const result = cancel(env(lock, SCOPE_A))
    expect(result.status).toBe(0)
    expect(result.out).toContain('no verify is running')
  })
})
