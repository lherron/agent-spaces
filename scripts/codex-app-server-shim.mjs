#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const SHIM_VERSION = 1
const BROKER_PROTOCOL_VERSION = 'harness-broker/0.2'
const DEFAULT_REAL_CODEX = '/Applications/Codex.app/Contents/Resources/codex'
const REDACTED = '[REDACTED]'
const SENSITIVE_KEY_NAMES = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'authtoken',
  'cookie',
  'csrftoken',
  'idtoken',
  'password',
  'refreshtoken',
  'secret',
  'sessiontoken',
])
const args = process.argv.slice(2)
const realCodexPath = process.env.CODEX_REAL_CLI_PATH || DEFAULT_REAL_CODEX

const appServerInvocation = args[0] === 'app-server'

if (!appServerInvocation) {
  const child = spawn(realCodexPath, args, {
    env: process.env,
    stdio: 'inherit',
  })
  forwardSignals(child)
  child.on('exit', (code, signal) => {
    process.exit(exitCodeFor(code, signal))
  })
} else {
  runObservedAppServer()
}

function runObservedAppServer() {
  const state = createState()
  let child

  try {
    writeInvocationState(state, { status: 'starting' })
    emitBrokerEvent(state, 'invocation.started', {
      pid: process.pid,
      command: realCodexPath,
      args,
      cwd: process.cwd(),
    })
    child = spawn(realCodexPath, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    emitBrokerEvent(state, 'invocation.failed', {
      message: errorMessage(error),
      code: 'spawn_error',
      retryable: false,
    })
    throw error
  }

  const server = startObserverSocket(state)
  forwardSignals(child)

  emitBrokerEvent(state, 'harness.started', {
    generation: 1,
    mode: 'initial',
    mechanism: 'direct-child',
    pid: child.pid ?? undefined,
  })
  emitBrokerEvent(state, 'invocation.ready', { state: 'ready' })
  writeInvocationState(state, {
    status: 'ready',
    childPid: child.pid ?? null,
  })

  proxyWithTap({
    source: process.stdin,
    target: child.stdin,
    state,
    direction: 'client_to_app_server',
  })
  proxyWithTap({
    source: child.stdout,
    target: process.stdout,
    state,
    direction: 'app_server_to_client',
  })
  proxyWithTap({
    source: child.stderr,
    target: process.stderr,
    state,
    direction: 'app_server_stderr',
  })

  child.on('error', (error) => {
    emitBrokerEvent(state, 'invocation.failed', {
      message: errorMessage(error),
      code: 'child_error',
      retryable: false,
    })
  })

  child.on('exit', (code, signal) => {
    const exitCode = exitCodeFor(code, signal)
    emitBrokerEvent(state, 'harness.exited', {
      generation: 1,
      exitCode,
      signal,
      reason: 'process-exit',
    })
    emitBrokerEvent(state, 'invocation.exited', {
      exitCode,
      signal,
      reason: 'process-exit',
    })
    writeInvocationState(state, {
      status: 'exited',
      code,
      signal,
      exitCode,
      exitedAt: new Date().toISOString(),
    })
    closeObserverSocket(state, server)
    process.exitCode = exitCode
    setTimeout(() => process.exit(exitCode), 10)
  })
}

function createState() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const stateDir =
    process.env.CODEX_APP_SERVER_SHIM_DIR || path.join(codexHome, 'codex-app-server-shim')
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(stateDir, 0o700)
  } catch {
    // Best effort only; creation mode already requests private permissions.
  }

  const socketPath =
    process.env.CODEX_APP_SERVER_SHIM_SOCKET ||
    path.join(stateDir, `app-server-${process.pid}.sock`)
  try {
    fs.unlinkSync(socketPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }

  const startedAt = new Date().toISOString()
  const invocationId =
    process.env.CODEX_APP_SERVER_SHIM_INVOCATION_ID || `codex-app-server-shim-${process.pid}`
  const invocationKind = classifyAppServerInvocation(args)
  return {
    clients: new Set(),
    childPid: undefined,
    exitCode: undefined,
    invocationId,
    invocationKind,
    latestPath: path.join(stateDir, 'latest.json'),
    latestPromoted: invocationKind.promoteToLatest,
    logPath: path.join(stateDir, 'events.ndjson'),
    ring: [],
    ringLimit: Number(process.env.CODEX_APP_SERVER_SHIM_RING_LIMIT || 500),
    seq: 0,
    signal: undefined,
    socketPath,
    startedAt,
    lastActivityAt: startedAt,
    status: 'starting',
    stateDir,
    statePath: path.join(stateDir, `app-server-${process.pid}.json`),
  }
}

function startObserverSocket(state) {
  const server = net.createServer((socket) => {
    state.clients.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        handleJsonRpcFrame(state, socket, rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
        newlineIndex = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => state.clients.delete(socket))
    socket.on('error', () => state.clients.delete(socket))
  })

  server.on('error', (error) => {
    emitBrokerEvent(state, 'diagnostic', {
      level: 'error',
      message: `observer socket error: ${errorMessage(error)}`,
      source: 'broker',
      data: { socketPath: state.socketPath },
    })
  })
  server.listen(state.socketPath)
  return server
}

function closeObserverSocket(state, server) {
  for (const client of state.clients) {
    client.end()
  }
  server.close(() => {
    try {
      fs.unlinkSync(state.socketPath)
    } catch {
      // The socket may already be gone after process teardown.
    }
  })
}

function handleJsonRpcFrame(state, socket, rawLine) {
  const trimmed = rawLine.trim()
  if (trimmed.length === 0) {
    return
  }
  let message
  try {
    message = JSON.parse(trimmed)
  } catch (error) {
    writeJsonRpcError(socket, null, -32700, 'Parse error', errorMessage(error))
    return
  }
  if (message == null || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    writeJsonRpcError(socket, message?.id ?? null, -32600, 'Invalid Request')
    return
  }
  if (!('id' in message)) {
    return
  }
  const id = message.id
  try {
    const result = handleJsonRpcRequest(state, message.method, message.params)
    writeSocket(socket, { jsonrpc: '2.0', id, result })
  } catch (error) {
    writeJsonRpcError(socket, id, -32601, errorMessage(error))
  }
}

function handleJsonRpcRequest(state, method, params) {
  switch (method) {
    case 'broker.hello':
      return brokerHello(params)
    case 'broker.health':
      return {
        status: 'ok',
        activeInvocations: isTerminalState(state.status) ? 0 : 1,
        drivers: [driverSummary()],
      }
    case 'broker.listInvocations':
      return { invocations: [invocationSummary(state)] }
    case 'invocation.status':
      return invocationStatus(state, params)
    case 'invocation.snapshot':
      return invocationSnapshot(state, params)
    case 'invocation.eventsSince':
      return invocationEventsSince(state, params)
    default:
      throw new Error(`Unsupported method: ${String(method)}`)
  }
}

function brokerHello(params) {
  const protocolVersions = Array.isArray(params?.protocolVersions) ? params.protocolVersions : []
  if (!protocolVersions.includes(BROKER_PROTOCOL_VERSION)) {
    throw new Error('No supported protocol version in request')
  }
  return {
    brokerInfo: {
      name: 'harness-broker',
      version: `codex-app-server-shim/${SHIM_VERSION}`,
    },
    protocolVersion: BROKER_PROTOCOL_VERSION,
    capabilities: {
      multiInvocation: false,
      transports: ['unix-jsonrpc-ndjson'],
      eventNotifications: true,
      brokerToClientRequests: false,
      inspection: {
        listInvocations: true,
        timestamps: true,
        lifecycleView: true,
        liveness: 'cached',
        eventTypeFilter: true,
      },
    },
    drivers: [driverSummary()],
  }
}

function driverSummary() {
  return {
    kind: 'codex-app-server',
    version: `shim/${SHIM_VERSION}`,
    available: true,
  }
}

function invocationEventsSince(state, params) {
  assertInvocationId(state, params)
  const afterSeq = Number(params?.afterSeq ?? 0)
  const types = Array.isArray(params?.types) ? new Set(params.types) : null
  const events = state.ring.filter(
    (event) => event.seq > afterSeq && (types == null || types.has(event.type))
  )
  return {
    events,
    currentSeq: state.seq,
    retentionFloorSeq: 0,
    liveStreamAttached: false,
  }
}

function invocationStatus(state, params) {
  assertInvocationId(state, params)
  return invocationSummary(state)
}

function invocationSnapshot(state, params) {
  assertInvocationId(state, params)
  return {
    ...invocationSummary(state),
    capabilities: invocationCapabilities(),
    pendingInputIds: [],
    inputDispositions: {},
    pendingPermissionRequests: [],
    process: {
      brokerPid: process.pid,
      childPid: state.childPid,
      exitCode: state.exitCode,
      signal: state.signal,
    },
    currentSeq: state.seq,
    retentionFloorSeq: 0,
  }
}

function assertInvocationId(state, params) {
  if (params?.invocationId !== state.invocationId) {
    throw new Error(`Unknown invocationId: ${String(params?.invocationId)}`)
  }
}

function invocationSummary(state) {
  const alive = !isTerminalState(state.status)
  return {
    invocationId: state.invocationId,
    state: state.status,
    driver: 'codex-app-server',
    startedAt: state.startedAt,
    lastActivityAt: state.lastActivityAt,
    currentSeq: state.seq,
    lifecycle: {
      retention: {
        mode: 'unmanaged',
      },
      harnessRecovery: {
        mode: 'none',
        currentGeneration: 1,
      },
      turnRetry: {
        mode: 'none',
      },
      terminalReason: isTerminalState(state.status) ? state.status : undefined,
    },
    liveness: {
      mode: 'cached',
      checkedAt: new Date().toISOString(),
      driver: {
        state: alive ? 'healthy' : 'exited',
      },
      process: {
        brokerPid: process.pid,
        childPid: state.childPid,
        alive,
        exitCode: state.exitCode,
        signal: state.signal,
      },
    },
  }
}

function invocationCapabilities() {
  return {
    input: {
      user: false,
      steer: false,
      appendContext: false,
      localImages: false,
      fileRefs: false,
      queue: false,
    },
    turns: {
      concurrency: 'single',
      interrupt: 'unsupported',
    },
    continuation: {
      supported: false,
    },
    events: {
      assistantDeltas: false,
      toolCalls: false,
      usage: false,
      diagnostics: true,
      replay: true,
      ack: false,
    },
    control: {
      stop: false,
      dispose: false,
      status: true,
      attach: false,
      snapshot: true,
      eventsSince: true,
      eventTypeFilter: true,
      liveness: 'cached',
    },
    lifecycle: {
      runtimeRetention: ['unmanaged'],
      harnessRecovery: ['none'],
      turnRetry: ['none'],
      generationFencing: false,
      permissionCancellation: false,
    },
  }
}

function writeJsonRpcError(socket, id, code, message, data = undefined) {
  const error = { code, message }
  if (data !== undefined) {
    error.data = data
  }
  writeSocket(socket, { jsonrpc: '2.0', id, error })
}

function proxyWithTap({ source, target, state, direction }) {
  const tap = createLineTap(state, direction)
  source.on('data', (chunk) => {
    tap(chunk)
    if (!target.destroyed && !target.write(chunk)) {
      source.pause()
    }
  })
  target.on('drain', () => source.resume())
  source.on('end', () => {
    if (!target.destroyed && typeof target.end === 'function') {
      target.end()
    }
  })
  source.on('error', (error) => {
    emitBrokerEvent(state, 'diagnostic', {
      level: 'error',
      message: `stream error: ${errorMessage(error)}`,
      source: 'driver',
      data: { direction },
    })
  })
}

function createLineTap(state, direction) {
  let pending = ''
  return (chunk) => {
    pending += chunk.toString('utf8')
    let newlineIndex = pending.indexOf('\n')
    while (newlineIndex !== -1) {
      const rawLine = pending.slice(0, newlineIndex)
      pending = pending.slice(newlineIndex + 1)
      captureLine(state, direction, rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
      newlineIndex = pending.indexOf('\n')
    }
  }
}

function captureLine(state, direction, raw) {
  if (raw.length === 0) {
    return
  }
  let parsed
  let parsedOk = false
  try {
    parsed = JSON.parse(raw)
    parsedOk = true
  } catch {
    // Stderr and diagnostics are often plain text.
  }
  const safeJson = parsedOk ? redactSensitiveValue(parsed) : null
  const safeRaw = parsedOk ? JSON.stringify(safeJson) : redactFreeformSecrets(raw)
  emitBrokerEvent(state, 'diagnostic', {
    level: direction === 'app_server_stderr' ? 'warn' : 'debug',
    message: `${direction}: ${truncate(safeRaw, 220)}`,
    source: 'driver',
    data: {
      direction,
      raw: safeRaw,
      json: safeJson,
    },
  })
}

function redactSensitiveValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item))
  }
  if (value == null || typeof value !== 'object') {
    return value
  }

  const redacted = {}
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED : redactSensitiveValue(child)
  }
  return redacted
}

function isSensitiveKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (SENSITIVE_KEY_NAMES.has(normalized)) {
    return true
  }
  if (
    normalized.endsWith('apikey') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('password')
  ) {
    return true
  }
  return (
    normalized.endsWith('token') && /^(auth|access|refresh|id|session|csrf|bearer)/.test(normalized)
  )
}

function redactFreeformSecrets(value) {
  return value
    .replace(
      /(["']?(?:authToken|accessToken|refreshToken|idToken|apiKey|authorization|password|secret|cookie)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi,
      `$1${REDACTED}`
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
}

function emitBrokerEvent(state, type, payload) {
  const event = {
    invocationId: state.invocationId,
    seq: ++state.seq,
    time: new Date().toISOString(),
    type,
    payload,
    driver: {
      kind: 'codex-app-server',
      rawType: type === 'diagnostic' ? String(payload?.data?.direction ?? 'diagnostic') : undefined,
    },
  }
  state.lastActivityAt = event.time
  if (type === 'invocation.exited') {
    state.status = 'exited'
    state.exitCode = payload?.exitCode
    state.signal = payload?.signal
  } else if (type === 'invocation.failed') {
    state.status = 'failed'
  } else if (type === 'invocation.ready') {
    state.status = 'ready'
  }

  if (state.ring.length >= state.ringLimit) {
    state.ring.shift()
  }
  state.ring.push(event)
  logLine(state, event)
  for (const client of state.clients) {
    writeSocket(client, { jsonrpc: '2.0', method: 'invocation.event', params: event })
  }
  return event
}

function writeSocket(socket, event) {
  try {
    socket.write(`${JSON.stringify(event)}\n`)
  } catch {
    socket.destroy()
  }
}

function logLine(state, event) {
  try {
    fs.appendFileSync(state.logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
  } catch {
    // Logging must never interfere with app-server stdio.
  }
}

function writeInvocationState(state, patch) {
  Object.assign(state, patch)
  const document = {
    version: SHIM_VERSION,
    pid: process.pid,
    realCodexPath,
    argv: args,
    invocationId: state.invocationId,
    invocationKind: state.invocationKind.kind,
    latestPromoted: state.latestPromoted,
    socketPath: state.socketPath,
    statePath: state.statePath,
    startedAt: state.startedAt,
    ...patch,
  }
  const text = `${JSON.stringify(document, null, 2)}\n`
  fs.writeFileSync(state.statePath, text, { mode: 0o600 })
  writeLatestInvocationState(state, document, text)
}

function writeLatestInvocationState(state, document, text) {
  if (!state.latestPromoted || latestHasNewerPromotedInvocation(state, document)) {
    return
  }
  fs.writeFileSync(state.latestPath, text, { mode: 0o600 })
}

function latestHasNewerPromotedInvocation(state, document) {
  let existing
  try {
    existing = JSON.parse(fs.readFileSync(state.latestPath, 'utf8'))
  } catch {
    return false
  }
  if (existing?.invocationId === state.invocationId) {
    return false
  }
  if (!isPromotedLatestDocument(existing)) {
    return false
  }

  const existingStartedAt = Date.parse(String(existing?.startedAt ?? ''))
  const nextStartedAt = Date.parse(String(document.startedAt ?? state.startedAt))
  return (
    Number.isFinite(existingStartedAt) &&
    Number.isFinite(nextStartedAt) &&
    existingStartedAt > nextStartedAt
  )
}

function isPromotedLatestDocument(document) {
  if (document?.latestPromoted === true) {
    return true
  }
  if (!Array.isArray(document?.argv)) {
    return false
  }
  return classifyAppServerInvocation(document.argv).promoteToLatest
}

function classifyAppServerInvocation(argv) {
  const listen = readOptionValue(argv, '--listen')
  if (listen !== undefined) {
    return {
      kind: 'explicit-listener',
      promoteToLatest: false,
      listen,
    }
  }
  return {
    kind: 'desktop-per-project',
    promoteToLatest: true,
  }
}

function readOptionValue(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === name) {
      return argv[index + 1] ?? ''
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1)
    }
  }
  return undefined
}

function isTerminalState(state) {
  return state === 'exited' || state === 'failed' || state === 'disposed'
}

function forwardSignals(child) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (!child.killed) {
        child.kill(signal)
      }
    })
  }
}

function exitCodeFor(code, signal) {
  if (typeof code === 'number') {
    return code
  }
  if (signal === 'SIGINT') {
    return 130
  }
  if (signal === 'SIGTERM') {
    return 143
  }
  return 1
}

function errorMessage(error) {
  return error && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : String(error)
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`
}
