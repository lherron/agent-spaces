#!/usr/bin/env bun
/**
 * aspd pilot acceptance scenario (T-08539, docs/aspd.md "Acceptance plan").
 *
 * Orchestration only. Every preparation, hosting and worker-control action is
 * performed by ONE long-lived process of the built pilot client artifact; every
 * service action goes through the `just aspd-*` lifecycle recipes. This script
 * imports no ASP implementation and records every step to
 * `<evidence>/scenario.ndjson`.
 *
 * Usage:
 *   bun scripts/aspd-pilot/scenario.ts --ns <abs> --client <abs aspd-pilot-client> \
 *     --evidence <abs> --release-a <id> --release-b <id> \
 *     --agent-root <abs> --project-root <abs> [--model gpt-5.5]
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? fallback : process.argv[index + 1]
  if (value === undefined) throw new Error(`missing --${name}`)
  return value
}

const ns = resolve(flag('ns'))
const clientBinary = resolve(flag('client'))
const evidence = resolve(flag('evidence'))
const releaseA = flag('release-a')
const releaseB = flag('release-b')
const spec = {
  scopeRef: 'agent:aspd-pilot:project:aspd-pilot',
  agentName: basename(resolve(flag('agent-root'))),
  agentRoot: resolve(flag('agent-root')),
  projectRoot: resolve(flag('project-root')),
  model: flag('model', 'gpt-5.5'),
}
const socketPath = join(ns, 'run', 'aspd.sock')
const clientState = join(evidence, 'c')
const runTag = Date.now().toString(36).toUpperCase()
mkdirSync(evidence, { recursive: true })

const failures: string[] = []

function log(step: string, data: Record<string, unknown>): void {
  const line = { at: new Date().toISOString(), step, ...data }
  appendFileSync(join(evidence, 'scenario.ndjson'), `${JSON.stringify(line)}\n`)
  process.stdout.write(`${line.at} ${step} ${JSON.stringify(data).slice(0, 400)}\n`)
}

function check(step: string, condition: boolean, detail: unknown): void {
  log(`check:${step}`, { pass: condition, detail })
  if (!condition) failures.push(step)
}

function just(...args: string[]): Record<string, unknown> {
  const result = spawnSync('just', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  const parsed = result.stdout.trim().length > 0 ? JSON.parse(result.stdout) : {}
  log(`just ${args[0]}`, {
    args,
    exitCode: result.status,
    stderr: result.stderr.trim().slice(-600),
    result: parsed,
  })
  if (result.status !== 0) throw new Error(`just ${args.join(' ')} failed: ${result.stderr}`)
  return parsed
}

function justAsync(...args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('just', args, { cwd: REPO_ROOT })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('exit', (code) => {
      const parsed = stdout.trim().length > 0 ? JSON.parse(stdout) : {}
      log(`just ${args[0]}`, {
        args,
        exitCode: code,
        stderr: stderr.trim().slice(-600),
        result: parsed,
      })
      if (code === 0) resolvePromise(parsed)
      else reject(new Error(`just ${args.join(' ')} failed: ${stderr}`))
    })
  })
}

// ---------------------------------------------------------------------------
// The fixed pilot client process
// ---------------------------------------------------------------------------

type ClientResult = {
  id: string
  cmd: string
  ok: boolean
  result?: Record<string, unknown>
  error?: { code: string; message: string; detail?: unknown }
  startedAt?: string
  finishedAt?: string
}

function startClient(state: string) {
  const child = spawn(clientBinary, ['--state', state], { stdio: ['pipe', 'pipe', 'pipe'] })
  const waiters = new Map<string, (result: ClientResult) => void>()
  let next = 0
  createInterface({ input: child.stdout }).on('line', (line) => {
    const result = JSON.parse(line) as ClientResult
    waiters.get(result.id)?.(result)
    waiters.delete(result.id)
  })
  child.stderr.on('data', (chunk) => appendFileSync(join(evidence, 'client-stderr.log'), chunk))
  return {
    pid: child.pid,
    send(cmd: string, params: Record<string, unknown> = {}): Promise<ClientResult> {
      const id = `${cmd}-${next++}`
      const done = new Promise<ClientResult>((resolvePromise) => waiters.set(id, resolvePromise))
      child.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`)
      return done.then((result) => {
        log(`client ${cmd}`, { params, result })
        return result
      })
    },
    exited: new Promise<number | null>((resolvePromise) => child.on('exit', resolvePromise)),
  }
}

function aspdPid(): number | undefined {
  const path = join(ns, 'run', 'aspd.json')
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid
    : undefined
}

function childPids(pid: number | undefined): number[] {
  if (pid === undefined) return []
  const out = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return out.length === 0 ? [] : out.split('\n').map(Number)
}

function codexAppServerPids(): number[] {
  const out = spawnSync('pgrep', ['-f', 'codex.*app-server'], { encoding: 'utf8' }).stdout.trim()
  return out.length === 0 ? [] : out.split('\n').map(Number)
}

function releaseOf(
  result: ClientResult,
  key: 'executionRelease' | 'workerRelease' | 'connectionRelease'
): string | undefined {
  const value = result.result?.[key] as { releaseId?: string } | undefined
  return value?.releaseId
}

async function turn(
  client: ReturnType<typeof startClient>,
  attempt: string,
  label: string,
  expectRelease: string
) {
  const marker = `ASPD_PILOT_${label}_${runTag}`
  const result = await client.send('turn', { attempt, marker })
  check(
    `turn ${label}`,
    result.ok &&
      result.result?.['markerObserved'] === true &&
      releaseOf(result, 'workerRelease') === expectRelease,
    {
      marker,
      ok: result.ok,
      error: result.error,
      workerRelease: releaseOf(result, 'workerRelease'),
      turnId: result.result?.['turnId'],
    }
  )
}

async function main(): Promise<void> {
  log('scenario.start', { ns, clientBinary, evidence, releaseA, releaseB, spec, runTag })
  just('inspect-asp-release', join(ns, 'releases', releaseA))
  just('inspect-asp-release', join(ns, 'releases', releaseB))
  const client = startClient(clientState)
  const identity = await client.send('identity')
  log('client.identity', { pid: client.pid, identity: identity.result })

  // 1. A active.
  just('aspd-activate', ns, releaseA)
  check(
    'A serving after activation',
    (just('aspd-status', ns)['runningEqualsSelected'] as boolean) === true,
    {}
  )

  // 2. Saved never-started A preparation; preparation starts nothing native.
  const codexBefore = codexAppServerPids()
  const saved = await client.send('prepare', { attempt: 'saved', socketPath, spec })
  check(
    'saved preparation served by A',
    saved.ok && releaseOf(saved, 'executionRelease') === releaseA,
    saved.result
  )
  check('preparation started no native process', childPids(aspdPid()).length === 0, {
    aspdChildren: childPids(aspdPid()),
    // Informational: other seats on this host may run codex concurrently.
    codexAppServerPidsBefore: codexBefore,
    codexAppServerPidsAfter: codexAppServerPids(),
  })
  const withheld = await client.send('prepare', { attempt: 'withheld', socketPath, spec })
  check(
    'second saved A preparation',
    withheld.ok && releaseOf(withheld, 'executionRelease') === releaseA,
    {}
  )

  // 3. A worker, real turn.
  const a1 = await client.send('prepare', { attempt: 'a1', socketPath, spec })
  check('a1 prepared by A', releaseOf(a1, 'executionRelease') === releaseA, {})
  const a1Launch = await client.send('launch', { attempt: 'a1' })
  check(
    'a1 worker is A and started nothing before invocation.start',
    a1Launch.ok && releaseOf(a1Launch, 'workerRelease') === releaseA,
    a1Launch.result?.['bootstrap']
  )
  await turn(client, 'a1', 'A1', releaseA)

  // 4. Activation of B with an in-flight A preparation and an idle pre-activation connection.
  const inflightConn = await client.send('connect', { name: 'inflight', socketPath })
  const idleConn = await client.send('connect', { name: 'idle', socketPath })
  check(
    'pre-activation connections hello as A',
    helloRelease(inflightConn) === releaseA && helloRelease(idleConn) === releaseA,
    { inflight: helloRelease(inflightConn), idle: helloRelease(idleConn) }
  )
  const aLog = currentAspdLog()
  const logBefore = readFileSync(aLog, 'utf8')
  const inflight = client.send('prepare', { attempt: 'b0', conn: 'inflight', spec })
  await waitFor(
    () =>
      countOf(readFileSync(aLog, 'utf8'), 'request.admitted') >
      countOf(logBefore, 'request.admitted'),
    10_000
  )
  const activation = justAsync('aspd-activate', ns, releaseB)
  await waitFor(() => readFileSync(aLog, 'utf8').includes('retire.begin'), 20_000)
  const late = client.send('prepare', { attempt: 'late', conn: 'idle', spec })
  const [inflightResult, lateResult, activationResult] = await Promise.all([
    inflight,
    late,
    activation,
  ])
  const retireLine =
    readFileSync(aLog, 'utf8')
      .split('\n')
      .find((line) => line.includes('retire.begin')) ?? ''
  check('retirement began with the A request in flight', /inFlight=[1-9]/.test(retireLine), {
    retireLine,
  })
  check(
    'in-flight request admitted before cutover finished as A',
    inflightResult.ok && releaseOf(inflightResult, 'executionRelease') === releaseA,
    {
      retireLine,
      answeredAt: inflightResult.finishedAt,
      activationCompletedAt: activationResult['completedAt'],
    }
  )
  check(
    'activation completed after the in-flight A request answered',
    String(activationResult['completedAt']) > String(inflightResult.finishedAt),
    {}
  )
  check(
    'pre-activation connection admitted no work after cutover',
    lateResult.error?.code === 'aspc_connection_closed' &&
      !existsSync(join(clientState, 'w', 'late', 'preparation.json')) &&
      readFileSync(aLog, 'utf8').includes('request.refused-retiring'),
    {
      error: lateResult.error,
      refusedInALog: readFileSync(aLog, 'utf8').includes('request.refused-retiring'),
    }
  )
  const lateAgain = await client.send('prepare', { attempt: 'late2', conn: 'idle', spec })
  check('closed pre-activation connection cannot be reused', !lateAgain.ok, lateAgain.error)

  // 5. Unchanged client reconnects: B serves new preparation; real B turn.
  const post = await client.send('connect', { name: 'post', socketPath })
  check(
    'reconnect hello is B',
    (post.result?.['hello'] as { release?: { releaseId?: string } })?.release?.releaseId ===
      releaseB,
    post.result?.['hello']
  )
  const b1 = await client.send('prepare', { attempt: 'b1', conn: 'post', spec })
  check('b1 prepared by B', b1.ok && releaseOf(b1, 'executionRelease') === releaseB, b1.result)
  const b1Launch = await client.send('launch', { attempt: 'b1' })
  check(
    'b1 worker is B',
    b1Launch.ok && releaseOf(b1Launch, 'workerRelease') === releaseB,
    b1Launch.result?.['bootstrap']
  )
  await turn(client, 'b1', 'B1', releaseB)

  // 6. Warm A worker while B is active.
  await turn(client, 'a1', 'A2', releaseA)

  // 7. Saved A preparation from disk while B is active.
  const savedLaunch = await client.send('launch', { attempt: 'saved' })
  check(
    'saved A preparation launches an A worker while B is active',
    savedLaunch.ok && releaseOf(savedLaunch, 'workerRelease') === releaseA,
    savedLaunch.result?.['bootstrap']
  )
  await turn(client, 'saved', 'S1', releaseA)

  // 8. aspd outage: preparation unavailable, workers controllable.
  just('aspd-stop', ns)
  const down = await client.send('prepare', { attempt: 'down', socketPath, spec })
  check(
    'preparation during outage reports unavailability',
    !down.ok && down.error?.code === 'aspc_service_unavailable',
    down.error
  )
  await turn(client, 'a1', 'A3', releaseA)
  await turn(client, 'b1', 'B2', releaseB)
  await turn(client, 'saved', 'S2', releaseA)
  just('aspd-start', ns)
  check(
    'restart serves the selected release',
    just('aspd-status', ns)['runningEqualsSelected'] === true,
    {}
  )
  just('aspd-restart', ns)
  await turn(client, 'b1', 'B3', releaseB)

  // 9. Rollback to A: new preparations are A, B worker still controlled.
  just('aspd-activate', ns, releaseA)
  const r1 = await client.send('prepare', { attempt: 'r1', socketPath, spec })
  check('rollback preparation is A', r1.ok && releaseOf(r1, 'executionRelease') === releaseA, {})
  await turn(client, 'b1', 'B4', releaseB)

  // 10. Refusals before launch from real persisted preparations.
  for (const [attempt, mutate, code] of [
    [
      't-mismatch',
      (r: Record<string, unknown>) => ({ ...r, sourceCommit: 'f'.repeat(40) }),
      'release_identity_mismatch',
    ],
    [
      't-proto',
      (r: Record<string, unknown>) => ({
        ...r,
        worker: { ...(r['worker'] as object), protocol: 'harness-broker/9.9' },
      }),
      'unsupported_worker_protocol',
    ],
    [
      't-outside',
      (r: Record<string, unknown>) => ({
        ...r,
        worker: {
          ...(r['worker'] as object),
          executable: join(ns, 'releases', releaseB, 'harness-broker'),
        },
      }),
      'worker_executable_outside_release',
    ],
  ] as const) {
    tamperedCopy('withheld', attempt, mutate)
    const refused = await client.send('launch', { attempt })
    check(
      `refused ${code}`,
      !refused.ok &&
        refused.error?.code === code &&
        !existsSync(join(clientState, 'w', attempt, 'bindings.json')),
      refused.error
    )
  }
  const releaseAPath = join(ns, 'releases', releaseA)
  const withheldPath = `${releaseAPath}.withheld`
  renameSync(releaseAPath, withheldPath)
  try {
    const unavailable = await client.send('launch', { attempt: 'withheld' })
    check(
      'withheld retained release refused before launch',
      !unavailable.ok &&
        unavailable.error?.code === 'release_unavailable' &&
        !existsSync(join(clientState, 'w', 'withheld', 'bindings.json')),
      unavailable.error
    )
  } finally {
    renameSync(withheldPath, releaseAPath)
  }
  just('inspect-asp-release', releaseAPath)

  // 11. Client memory loss: a NEW client process drives existing workers from disk only.
  await client.send('exit')
  await client.exited
  const fresh = startClient(clientState)
  await fresh.send('identity')
  await turn(fresh, 'a1', 'A4', releaseA)
  await turn(fresh, 'b1', 'B5', releaseB)
  await turn(fresh, 'saved', 'S3', releaseA)
  for (const attempt of ['a1', 'b1', 'saved'])
    log('worker.final', { attempt, hello: (await fresh.send('worker-hello', { attempt })).result })
  for (const attempt of ['a1', 'b1', 'saved']) await fresh.send('stop-worker', { attempt })
  await fresh.send('exit')
  await fresh.exited
  just('aspd-status', ns)

  cpSync(join(ns, 'logs'), join(evidence, 'aspd-logs'), { recursive: true })
  cpSync(join(ns, 'service'), join(evidence, 'service'), { recursive: true })
  log('scenario.end', { failures })
  if (failures.length > 0) process.exit(1)
}

function currentAspdLog(): string {
  return (JSON.parse(readFileSync(join(ns, 'run', 'aspd.json'), 'utf8')) as { logPath: string })
    .logPath
}

function helloRelease(result: ClientResult): string | undefined {
  return (result.result?.['hello'] as { release?: { releaseId?: string } } | undefined)?.release
    ?.releaseId
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(10)
  }
}

function tamperedCopy(
  from: string,
  to: string,
  mutate: (release: Record<string, unknown>) => Record<string, unknown>
): void {
  const prep = JSON.parse(readFileSync(join(clientState, 'w', from, 'preparation.json'), 'utf8'))
  prep.attempt = to
  prep.response.executionRelease = mutate(prep.response.executionRelease)
  mkdirSync(join(clientState, 'w', to), { recursive: true })
  writeFileSync(
    join(clientState, 'w', to, 'preparation.json'),
    `${JSON.stringify(prep, null, 2)}\n`
  )
}

main().catch((error) => {
  log('scenario.error', {
    message: error instanceof Error ? (error.stack ?? error.message) : String(error),
    failures,
  })
  process.exit(2)
})
