#!/usr/bin/env bun
/**
 * aspd pilot client (T-08539, docs/aspd.md): the stand-in for HRC.
 *
 * Built once into a standalone executable and kept running across activation.
 * Its dependency closure is wire contracts, framing and transport only:
 * `spaces-aspc-protocol` (+ `/unix-client`), `spaces-harness-broker-client`
 * and `spaces-harness-broker-protocol`. It never imports ASP configuration,
 * compiler or execution code, never selects a worker binary by driver name, and
 * never rewrites the persisted dispatch payload.
 *
 * It reads one JSON command per stdin line and writes one JSON result per
 * stdout line. Every durable fact it acts on is written to `--state` first.
 * Effectful requests are never retried by the client.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
  AspcExecutionRelease,
} from 'spaces-aspc-protocol'
import { AspcUnixClient } from 'spaces-aspc-protocol/unix-client'
import { BrokerClient } from 'spaces-harness-broker-client'
import type {
  BrokerHelloResponse,
  InvocationEventEnvelope,
  InvocationId,
} from 'spaces-harness-broker-protocol'
import { SUPPORTED_BROKER_PROTOCOL_VERSIONS } from 'spaces-harness-broker-protocol'

type Command = { id?: string; cmd: string } & Record<string, unknown>
type OkCompile = Extract<AspcCompileHarnessInvocationResponse, { ok: true }>

class Refusal extends Error {
  readonly code: string
  readonly detail: unknown
  constructor(code: string, message: string, detail?: unknown) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

const WORKER_ENV_KEYS = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']

function argValue(flag: string): string {
  const index = process.argv.indexOf(flag)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined) throw new Error(`missing ${flag}`)
  return resolve(value)
}

const stateRoot = argValue('--state')
const clientInstance = `pilot_${process.pid}_${randomBytes(3).toString('hex')}`
mkdirSync(stateRoot, { recursive: true })

function now(): string {
  return new Date().toISOString()
}

function record(kind: string, data: Record<string, unknown>): void {
  appendFileSync(
    join(stateRoot, 'client-log.ndjson'),
    `${JSON.stringify({ at: now(), kind, ...data })}\n`
  )
}

function attemptDir(attempt: string): string {
  if (!/^[a-zA-Z0-9_-]{1,24}$/.test(attempt)) throw new Error(`invalid attempt name: ${attempt}`)
  return join(stateRoot, 'w', attempt)
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

// ---------------------------------------------------------------------------
// aspd connections (persistent, named) — hello on every connection, no retry
// ---------------------------------------------------------------------------

const aspdConnections = new Map<string, AspcUnixClient>()

async function connectAspd(name: string, socketPath: string): Promise<unknown> {
  const client = await AspcUnixClient.connect({
    socketPath,
    clientInfo: { name: 'aspd-pilot-client', version: clientInstance },
  })
  client.onClose((error) => {
    record('aspd.connection.closed', { name, reason: error.message })
    if (aspdConnections.get(name) === client) aspdConnections.delete(name)
  })
  aspdConnections.set(name, client)
  record('aspd.connection.opened', { name, hello: client.hello })
  return { name, hello: client.hello }
}

function compileRequest(
  attempt: string,
  spec: Record<string, unknown>
): AspcCompileHarnessInvocationRequest {
  const suffix = `${attempt}_${randomBytes(4).toString('hex')}`
  const scopeRef = String(spec['scopeRef'])
  const agentRoot = String(spec['agentRoot'])
  const projectRoot = String(spec['projectRoot'])
  const agentName = String(spec['agentName'])
  const requested =
    typeof spec['requested'] === 'object' && spec['requested'] !== null
      ? (spec['requested'] as Record<string, unknown>)
      : {}
  const unsupportedRequestedKeys = Object.keys(requested).filter(
    (key) => !['harness', 'modelProvider', 'model', 'reasoningEffort', 'presentation'].includes(key)
  )
  if (unsupportedRequestedKeys.length > 0) {
    throw new Refusal(
      'unsupported_harness_selection',
      `requested contains unsupported v2 selection keys: ${unsupportedRequestedKeys.join(', ')}`
    )
  }
  const requestedSelection = {
    harness: typeof requested['harness'] === 'string' ? requested['harness'] : 'codex',
    modelProvider:
      typeof requested['modelProvider'] === 'string' ? requested['modelProvider'] : 'openai-codex',
    presentation:
      typeof requested['presentation'] === 'boolean' ? requested['presentation'] : false,
    ...(typeof requested['model'] === 'string'
      ? { model: requested['model'] }
      : typeof spec['model'] === 'string'
        ? { model: spec['model'] }
        : {}),
    ...(typeof requested['reasoningEffort'] === 'string'
      ? { reasoningEffort: requested['reasoningEffort'] }
      : { reasoningEffort: 'low' }),
  }
  const materialization =
    typeof spec['materialization'] === 'object' && spec['materialization'] !== null
      ? (spec['materialization'] as Record<string, unknown>)
      : {}
  const hrcPolicy =
    typeof spec['hrcPolicy'] === 'object' && spec['hrcPolicy'] !== null
      ? (spec['hrcPolicy'] as Record<string, unknown>)
      : {}
  const identity = {
    requestId: `request_${suffix}`,
    operationId: `runtimeOperation_${suffix}`,
    hostSessionId: `hostSession_${suffix}`,
    generation: 1,
    runtimeId: `runtime_${suffix}`,
    invocationId: `inv_${suffix}`,
    runId: `run_${suffix}`,
    traceId: `trace_${suffix}`,
    idempotencyKey: `aspd-pilot-${suffix}`,
  }
  return {
    compileRequest: {
      schemaVersion: 'agent-runtime-compile-request/v2',
      agent: { id: agentName },
      identity,
      placement: {
        agentRoot,
        projectRoot,
        cwd: projectRoot,
        runMode: 'task',
        bundle: { kind: 'agent-project', agentName, projectRoot },
        correlation: {
          sessionRef: { scopeRef, laneRef: 'main' },
          hostSessionId: identity.hostSessionId,
        },
      },
      requested: requestedSelection,
      materialization: { omitPriming: true, ...materialization },
      hrcPolicy: {
        permissionPolicy: { mode: 'deny', audit: true },
        capabilityPolicy: { allowDegrade: false, requireBrokerDefaultForCodexHeadless: true },
        ...hrcPolicy,
      },
      correlation: {
        requestId: identity.requestId,
        operationId: identity.operationId,
        hostSessionId: identity.hostSessionId,
        generation: identity.generation,
        runtimeId: identity.runtimeId,
        runId: identity.runId,
        invocationId: identity.invocationId,
        traceId: identity.traceId,
        appId: 'aspd-pilot',
        appSessionKey: `aspd-pilot-${suffix}`,
        scopeRef,
        laneRef: 'main',
      },
    },
  } as AspcCompileHarnessInvocationRequest
}

/**
 * Prepare over a named persistent connection, or over a fresh connection to
 * `socketPath`. Persists the complete response before returning. Launches
 * nothing.
 */
async function prepare(cmd: Command): Promise<unknown> {
  const attempt = String(cmd['attempt'])
  const dir = attemptDir(attempt)
  if (existsSync(join(dir, 'preparation.json')))
    throw new Error(`attempt ${attempt} already prepared`)
  let client: AspcUnixClient
  let ephemeral = false
  if (typeof cmd['conn'] === 'string') {
    const existing = aspdConnections.get(cmd['conn'])
    if (existing === undefined)
      throw new Refusal('aspd_connection_closed', `connection ${cmd['conn']} is closed`)
    client = existing
  } else {
    client = await AspcUnixClient.connect({
      socketPath: String(cmd['socketPath']),
      clientInfo: { name: 'aspd-pilot-client', version: clientInstance },
    })
    ephemeral = true
  }
  const request = compileRequest(attempt, cmd['spec'] as Record<string, unknown>)
  const submittedAt = now()
  record('aspd.prepare.submitted', { attempt, connectionRelease: client.hello.release })
  try {
    const response = await client.compileHarnessInvocation(request)
    const preparation = {
      schemaVersion: 'aspd-pilot-preparation/v1',
      attempt,
      connectionHello: client.hello,
      submittedAt,
      answeredAt: now(),
      request,
      response,
    }
    writeJson(join(dir, 'preparation.json'), preparation)
    record('aspd.prepare.answered', { attempt, ok: response.ok })
    if (!response.ok) {
      throw new Refusal(
        'preparation_failed',
        'aspc.compileHarnessInvocation returned ok:false',
        response.diagnostics
      )
    }
    return {
      attempt,
      connectionRelease: client.hello.release,
      executionRelease: response.executionRelease,
      invocationId: response.plan.execution.dispatchRequest.startRequest.spec.invocationId,
      driver: response.plan.execution.driver,
      startRequestHash: response.plan.execution.profile.startRequestHash,
      profileHash: response.plan.execution.profile.profileHash,
    }
  } finally {
    if (ephemeral) await client.close()
  }
}

// ---------------------------------------------------------------------------
// Generic hosting from the persisted preparation
// ---------------------------------------------------------------------------

type Preparation = { attempt: string; response: AspcCompileHarnessInvocationResponse }

function loadPreparation(attempt: string): {
  dir: string
  prep: Preparation
  compiled: OkCompile
  release: AspcExecutionRelease
} {
  const dir = attemptDir(attempt)
  const prep = readJson<Preparation>(join(dir, 'preparation.json'))
  if (!prep.response.ok)
    throw new Refusal('preparation_failed', `attempt ${attempt} has no successful preparation`)
  const release = prep.response.executionRelease
  if (release === undefined)
    throw new Refusal('execution_release_missing', 'preparation carries no executionRelease')
  return { dir, prep, compiled: prep.response, release }
}

/** Validate the frozen release binding from bytes on disk only. Launches nothing. */
function validateReleaseBinding(release: AspcExecutionRelease): { executable: string } {
  const manifestPath = join(release.releaseRoot, 'release.json')
  if (!existsSync(manifestPath)) {
    throw new Refusal(
      'release_unavailable',
      `release ${release.releaseId} is not available at ${release.releaseRoot}`
    )
  }
  const manifest = readJson<{ releaseId?: string; sourceCommit?: string }>(manifestPath)
  if (manifest.releaseId !== release.releaseId || manifest.sourceCommit !== release.sourceCommit) {
    throw new Refusal(
      'release_identity_mismatch',
      'release manifest does not match the preparation',
      {
        expected: { releaseId: release.releaseId, sourceCommit: release.sourceCommit },
        found: { releaseId: manifest.releaseId, sourceCommit: manifest.sourceCommit },
      }
    )
  }
  const root = realpathSync(release.releaseRoot)
  const executable = existsSync(release.worker.executable)
    ? realpathSync(release.worker.executable)
    : undefined
  if (executable === undefined || !executable.startsWith(`${root}${sep}`)) {
    throw new Refusal(
      'worker_executable_outside_release',
      'worker executable does not resolve inside the release',
      {
        executable: release.worker.executable,
        releaseRoot: root,
      }
    )
  }
  if (
    !(SUPPORTED_BROKER_PROTOCOL_VERSIONS as readonly string[]).includes(release.worker.protocol)
  ) {
    throw new Refusal(
      'unsupported_worker_protocol',
      `client does not support ${release.worker.protocol}`,
      {
        supported: SUPPORTED_BROKER_PROTOCOL_VERSIONS,
      }
    )
  }
  return { executable }
}

type Bindings = {
  socketPath: string
  eventLedgerPath: string
  attachTokenPath: string
  stderrPath: string
  runtimeId: string
  hostSessionId: string
  generation: number
  invocationId: string
  startRequestHash: string
  selectedProfileHash: string
  pid?: number
}

function childPids(pid: number): number[] {
  const out = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return out.length === 0 ? [] : out.split('\n').map(Number)
}

async function waitForSocket(path: string, pid: number): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!existsSync(path)) {
    try {
      process.kill(pid, 0)
    } catch {
      throw new Refusal('worker_bootstrap_failed', 'worker exited before serving its socket')
    }
    if (Date.now() > deadline)
      throw new Refusal('worker_bootstrap_failed', 'worker socket did not appear')
    await Bun.sleep(50)
  }
}

async function launch(cmd: Command): Promise<unknown> {
  const attempt = String(cmd['attempt'])
  const { dir, compiled, release } = loadPreparation(attempt)
  const { executable } = validateReleaseBinding(release)
  record('hosting.release.validated', { attempt, releaseId: release.releaseId })

  const spec = compiled.plan.execution.dispatchRequest.startRequest.spec
  const correlation = (spec.correlation ?? {}) as Record<string, unknown>
  const token = randomBytes(24).toString('hex')
  const bindings: Bindings = {
    socketPath: join(dir, 'b.sock'),
    eventLedgerPath: join(dir, 'events.ndjson'),
    attachTokenPath: join(dir, 'attach.token'),
    stderrPath: join(dir, 'worker.err'),
    runtimeId: String(correlation['runtimeId']),
    hostSessionId: String(correlation['hostSessionId']),
    generation: compiled.plan.identity.generation,
    invocationId: String(spec.invocationId),
    startRequestHash: compiled.plan.execution.profile.startRequestHash,
    selectedProfileHash: compiled.plan.execution.profile.profileHash,
  }
  writeFileSync(bindings.attachTokenPath, token, { mode: 0o600, flag: 'wx' })
  const argv = [
    ...release.worker.argvPrefix,
    '--socket',
    bindings.socketPath,
    '--event-ledger',
    bindings.eventLedgerPath,
    '--runtime-id',
    bindings.runtimeId,
    '--host-session-id',
    bindings.hostSessionId,
    '--generation',
    String(bindings.generation),
    '--attach-token-file',
    bindings.attachTokenPath,
  ]
  writeJson(join(dir, 'hosting-intent.json'), { executable, argv, bindings, intendedAt: now() })

  const env: Record<string, string> = {}
  for (const key of WORKER_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  const errFd = openSync(bindings.stderrPath, 'a')
  const child = spawn(executable, argv, {
    cwd: dir,
    env,
    detached: true,
    stdio: ['ignore', errFd, errFd],
  })
  closeSync(errFd)
  if (child.pid === undefined) throw new Refusal('worker_bootstrap_failed', 'spawn returned no pid')
  child.unref()
  const pid = child.pid
  writeJson(join(dir, 'bindings.json'), { ...bindings, pid, launchedAt: now() })
  record('hosting.worker.launched', { attempt, pid })
  await waitForSocket(bindings.socketPath, pid)

  const client = await BrokerClient.connectUnix({
    socketPath: bindings.socketPath,
    timeoutMs: 5_000,
  })
  try {
    const hello = await client.hello({
      clientInfo: { name: 'aspd-pilot-client', version: clientInstance },
      protocolVersions: [release.worker.protocol],
    })
    writeJson(join(dir, 'worker-hello.json'), { at: now(), hello })
    const refusal = handshakeRefusal(hello, release)
    if (refusal !== undefined) {
      process.kill(pid, 'SIGTERM')
      record('hosting.worker.refused', { attempt, code: refusal.code })
      throw refusal
    }
    // Bootstrap evidence: the worker is serving and has started nothing.
    const bootstrap = {
      at: now(),
      invocations: (await client.listInvocations({})).invocations,
      workerChildPids: childPids(pid),
    }
    writeJson(join(dir, 'bootstrap-before-start.json'), bootstrap)
    if (bootstrap.invocations.length > 0 || bootstrap.workerChildPids.length > 0) {
      throw new Refusal(
        'bootstrap_started_native',
        'worker had a native invocation before invocation.start',
        bootstrap
      )
    }

    // The persisted dispatch payload, unchanged. Submitted once; never replayed.
    const dispatch = compiled.plan.execution.dispatchRequest
    writeJson(join(dispatchMarker(dir)), { submittedAt: now(), startAttempt: `${attempt}-start-1` })
    let startResponse: unknown
    try {
      const runtime =
        typeof cmd['runtime'] === 'object' && cmd['runtime'] !== null
          ? (cmd['runtime'] as NonNullable<typeof dispatch.runtime>)
          : dispatch.runtime
      const result = await client.startInvocationFromRequest(dispatch.startRequest, {
        dispatchEnv: dispatch.dispatchEnv,
        runtime,
        lifecyclePolicy: dispatch.lifecyclePolicy,
      })
      startResponse = result.response
    } catch (error) {
      writeJson(join(dir, 'start-outcome.json'), {
        outcome: 'uncertain',
        at: now(),
        error: error instanceof Error ? error.message : String(error),
      })
      throw new Refusal('start_outcome_uncertain', 'invocation.start did not return; not retried', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    writeJson(join(dir, 'start-outcome.json'), { outcome: 'started', at: now(), startResponse })
    record('hosting.invocation.started', { attempt })
    return {
      attempt,
      pid,
      socketPath: bindings.socketPath,
      workerRelease: hello.release,
      negotiatedProtocol: hello.protocolVersion,
      bootstrap,
      startResponse,
    }
  } finally {
    await client.close()
  }
}

function dispatchMarker(dir: string): string {
  return join(dir, 'start-submitted.json')
}

function handshakeRefusal(
  hello: BrokerHelloResponse,
  release: AspcExecutionRelease
): Refusal | undefined {
  if (hello.protocolVersion !== release.worker.protocol) {
    return new Refusal('worker_protocol_mismatch', `worker negotiated ${hello.protocolVersion}`)
  }
  if (hello.release === undefined) {
    return new Refusal('worker_release_unidentified', 'worker hello reports no release identity')
  }
  if (
    hello.release.releaseId !== release.releaseId ||
    hello.release.sourceCommit !== release.sourceCommit
  ) {
    return new Refusal(
      'worker_release_mismatch',
      'worker hello release differs from the preparation',
      {
        expected: release.releaseId,
        actual: hello.release,
      }
    )
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Worker control — directly over the worker socket, from on-disk bindings
// ---------------------------------------------------------------------------

async function controller(attempt: string): Promise<{
  client: BrokerClient
  bindings: Bindings
  hello: BrokerHelloResponse
  attach: unknown
}> {
  const dir = attemptDir(attempt)
  const bindings = readJson<Bindings>(join(dir, 'bindings.json'))
  const prep = loadPreparation(attempt)
  const client = await BrokerClient.connectUnix({
    socketPath: bindings.socketPath,
    timeoutMs: 5_000,
  })
  const hello = await client.hello({
    clientInfo: { name: 'aspd-pilot-client', version: clientInstance },
    protocolVersions: [prep.release.worker.protocol],
  })
  const refusal = handshakeRefusal(hello, prep.release)
  if (refusal !== undefined) {
    await client.close()
    throw refusal
  }
  const attach = await client.attach({
    runtimeId: bindings.runtimeId,
    hostSessionId: bindings.hostSessionId,
    generation: bindings.generation,
    invocationId: bindings.invocationId as InvocationId,
    startRequestHash: bindings.startRequestHash,
    selectedProfileHash: bindings.selectedProfileHash,
    controllerInstanceId: clientInstance,
    attachToken: readFileSync(bindings.attachTokenPath, 'utf8').trim(),
  })
  return { client, bindings, hello, attach }
}

function textOf(event: InvocationEventEnvelope): string {
  const payload = event.payload as Record<string, unknown>
  if (event.type === 'assistant.message.completed') {
    return ((payload['content'] as Array<{ text?: string }>) ?? [])
      .map((c) => c.text ?? '')
      .join('')
  }
  if (event.type === 'turn.completed' || event.type === 'turn.failed') {
    return typeof payload['finalOutput'] === 'string' ? payload['finalOutput'] : ''
  }
  return ''
}

async function turn(cmd: Command): Promise<unknown> {
  const attempt = String(cmd['attempt'])
  const marker = String(cmd['marker'])
  const dir = attemptDir(attempt)
  const { client, bindings, hello } = await controller(attempt)
  const invocationId = bindings.invocationId as InvocationId
  try {
    const baseline = await client.eventsSince({ invocationId, afterSeq: 0 })
    let cursor = baseline.currentSeq
    const submittedAt = now()
    const submission = await client.enqueue({
      invocationId,
      origin: { principalRef: 'agent:aspd-pilot', scopeRef: clientInstance },
      body: `Reply with exactly ${marker} and nothing else. Do not run any tools.`,
    })
    record('worker.turn.submitted', { attempt, marker, submission })
    if (submission.admission !== 'admitted') {
      throw new Refusal('submission_rejected', 'worker rejected the turn', submission)
    }
    const collected: InvocationEventEnvelope[] = []
    const deadline = Date.now() + Number(cmd['timeoutMs'] ?? 300_000)
    for (;;) {
      const page = await client.eventsSince({ invocationId, afterSeq: cursor })
      for (const event of page.events) {
        collected.push(event)
        appendFileSync(join(dir, 'turn-events.ndjson'), `${JSON.stringify({ marker, event })}\n`)
      }
      cursor = Math.max(cursor, page.currentSeq)
      const terminal = collected.find(
        (event) =>
          event.type === 'turn.completed' ||
          event.type === 'turn.failed' ||
          event.type === 'turn.interrupted'
      )
      if (terminal !== undefined) {
        const turnId = (terminal.payload as { turnId?: string }).turnId
        const markerObserved = collected.some((event) => textOf(event).includes(marker))
        const summary = {
          attempt,
          marker,
          submittedAt,
          terminalType: terminal.type,
          terminalSeq: terminal.seq,
          turnId,
          markerObserved,
          workerRelease: hello.release,
          eventTypes: collected.map((event) => `${event.seq}:${event.type}`),
        }
        appendFileSync(join(dir, 'turns.ndjson'), `${JSON.stringify(summary)}\n`)
        if (terminal.type !== 'turn.completed' || !markerObserved) {
          throw new Refusal('turn_failed', 'turn did not complete with the marker', summary)
        }
        return summary
      }
      if (Date.now() > deadline)
        throw new Refusal('turn_timeout', `no terminal turn event for ${marker}`)
      await Bun.sleep(500)
    }
  } finally {
    await client.close()
  }
}

async function workerHello(cmd: Command): Promise<unknown> {
  const attempt = String(cmd['attempt'])
  const bindings = readJson<Bindings>(join(attemptDir(attempt), 'bindings.json'))
  const client = await BrokerClient.connectUnix({
    socketPath: bindings.socketPath,
    timeoutMs: 5_000,
  })
  try {
    const hello = await client.hello({
      clientInfo: { name: 'aspd-pilot-client', version: clientInstance },
      protocolVersions: [...SUPPORTED_BROKER_PROTOCOL_VERSIONS],
    })
    const snapshot = await client.snapshot({ invocationId: bindings.invocationId as InvocationId })
    return {
      attempt,
      pid: bindings.pid,
      release: hello.release,
      protocolVersion: hello.protocolVersion,
      state: snapshot.state,
    }
  } finally {
    await client.close()
  }
}

async function stopWorker(cmd: Command): Promise<unknown> {
  const attempt = String(cmd['attempt'])
  const { client, bindings } = await controller(attempt)
  const invocationId = bindings.invocationId as InvocationId
  try {
    const stopped = await client.stop({ invocationId, reason: 'aspd pilot cleanup' })
    await client.dispose({ invocationId })
    return { attempt, stopped }
  } finally {
    await client.close()
    if (bindings.pid !== undefined) {
      try {
        process.kill(bindings.pid, 'SIGTERM')
      } catch {
        // already exited
      }
    }
  }
}

async function dispatch(cmd: Command): Promise<unknown> {
  switch (cmd.cmd) {
    case 'identity':
      return { clientInstance, pid: process.pid, execPath: process.execPath, stateRoot }
    case 'connect':
      return connectAspd(String(cmd['name']), String(cmd['socketPath']))
    case 'prepare':
      return prepare(cmd)
    case 'launch':
      return launch(cmd)
    case 'turn':
      return turn(cmd)
    case 'worker-hello':
      return workerHello(cmd)
    case 'stop-worker':
      return stopWorker(cmd)
    case 'close':
      await aspdConnections.get(String(cmd['name']))?.close()
      return { closed: cmd['name'] }
    default:
      throw new Error(`unknown command: ${cmd.cmd}`)
  }
}

const pending = new Set<Promise<void>>()
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (line.trim().length === 0) return
  const cmd = JSON.parse(line) as Command
  if (cmd.cmd === 'exit') {
    void (async () => {
      // Exit only after every in-flight command has reported.
      while (pending.size > 0) await Promise.allSettled([...pending])
      for (const client of aspdConnections.values()) await client.close()
      process.stdout.write(
        `${JSON.stringify({ id: cmd.id, ok: true, result: { exited: true } })}\n`
      )
      process.exit(0)
    })()
    return
  }
  // `prepare` on a named connection may overlap activation, so commands run
  // concurrently; each result line carries its command id.
  const run = async (): Promise<void> => {
    const startedAt = now()
    try {
      const result = await dispatch(cmd)
      const out = { id: cmd.id, cmd: cmd.cmd, ok: true, startedAt, finishedAt: now(), result }
      record('command.ok', out)
      process.stdout.write(`${JSON.stringify(out)}\n`)
    } catch (error) {
      const out = {
        id: cmd.id,
        cmd: cmd.cmd,
        ok: false,
        startedAt,
        finishedAt: now(),
        error: {
          code:
            error instanceof Refusal ? error.code : ((error as { code?: unknown }).code ?? 'error'),
          message: error instanceof Error ? error.message : String(error),
          detail: error instanceof Refusal ? error.detail : undefined,
        },
      }
      record('command.failed', out)
      process.stdout.write(`${JSON.stringify(out)}\n`)
    }
  }
  const running = run()
  pending.add(running)
  void running.finally(() => pending.delete(running))
})
