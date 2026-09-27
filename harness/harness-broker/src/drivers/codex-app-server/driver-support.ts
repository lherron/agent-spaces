import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CodexAppServerDriverSpec,
  HarnessInvocationSpec,
  RawProviderRecord,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { type DriverContext, withDeliveryEvidence, withSteerRequiresOwnTurn } from '../driver'
import { buildHookSocketPath, shellQuote } from '../tmux-shared'
import { type CodexTuiLauncher, buildCodexTuiHookReceiverArgv } from './codex-tui-wrapper'
import type {
  PendingSteer,
  ThreadResponse,
  ThreadTurnsListResponse,
  TurnFailure,
  TurnStartResponse,
  TurnSteerResponse,
} from './driver-state'
import {
  CodexRpcError,
  CodexUnixWebSocketRpcClient,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type RpcHandlers,
} from './rpc-client'

export async function waitForSteerResponseOrTargetTerminal(
  request: Promise<TurnSteerResponse>,
  confirmation: PendingSteer['confirmation'],
  threadId: string,
  turnId: TurnId
): Promise<TurnSteerResponse> {
  const requestOutcome = request.then(
    (response) => ({ kind: 'response' as const, response }),
    (error: unknown) => ({ kind: 'error' as const, error })
  )
  const targetTerminal = confirmation.then((result) =>
    result === 'target-terminal'
      ? { kind: 'target-terminal' as const }
      : new Promise<never>(() => undefined)
  )
  const firstOutcome = await Promise.race([requestOutcome, targetTerminal])
  if (firstOutcome.kind === 'target-terminal') {
    throw withSteerRequiresOwnTurn(
      withDeliveryEvidence(
        new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          'Codex steer target terminalized without native landing evidence; starting an own turn',
          { threadId, attemptedTurnId: turnId }
        ),
        'possibly_written'
      )
    )
  }
  if (firstOutcome.kind === 'error') throw firstOutcome.error
  return firstOutcome.response
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function codexTuiSocketDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'current-user'
  // Resolve /tmp before handing it to Codex: on macOS `/tmp` is a symlink and
  // app-server intentionally refuses a symlink as the parent of its UDS.
  const dir = join(realpathSync('/tmp'), `spaces-harness-broker-${uid}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  return dir
}

/**
 * Resolve the read-only observer/broker socket the renderer connects to for the
 * durable event surface. HRC supplies it via the
 * `HARNESS_BROKER_OBSERVER_SOCKET` dispatch/process env (the concrete read
 * endpoint seam); absent that, derive a conventional path beside the leased
 * tmux socket so the launch command always carries a concrete endpoint.
 */
export function resolveRendererObserverSocket(
  driverCtx: DriverContext,
  surface: { socketPath: string }
): string {
  const fromDispatch = driverCtx.dispatchEnv?.['HARNESS_BROKER_OBSERVER_SOCKET']
  if (typeof fromDispatch === 'string' && fromDispatch.length > 0) return fromDispatch
  const fromEnv = process.env['HARNESS_BROKER_OBSERVER_SOCKET']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const dir = surface.socketPath.includes('/')
    ? surface.socketPath.slice(0, surface.socketPath.lastIndexOf('/'))
    : '.'
  return `${dir}/${driverCtx.invocationId}.observer.sock`
}

export function isCodexTuiSpec(driver: CodexAppServerDriverSpec): boolean {
  return driver.presentation === 'codex-tui'
}

export function emitTerminalSurface(
  ctx: DriverContext,
  surface: {
    socketPath: string
    sessionId: string
    windowId: string
    paneId: string
    sessionName?: string | undefined
    windowName?: string | undefined
  }
): void {
  ctx.emit(
    'terminal.surface.reported',
    {
      kind: 'tmux-pane',
      socketPath: surface.socketPath,
      sessionId: surface.sessionId,
      windowId: surface.windowId,
      paneId: surface.paneId,
      ...(surface.sessionName !== undefined ? { sessionName: surface.sessionName } : {}),
      ...(surface.windowName !== undefined ? { windowName: surface.windowName } : {}),
    },
    { driver: { kind: 'codex-app-server', rawType: 'tmux.surface' } }
  )
}

export async function connectCodexTuiRpc(
  socketPath: string,
  handlers: RpcHandlers
): Promise<CodexUnixWebSocketRpcClient> {
  const deadline = Date.now() + 30_000
  let lastError: Error | undefined
  while (Date.now() <= deadline) {
    const client = new CodexUnixWebSocketRpcClient(socketPath, handlers)
    try {
      await client.ready()
      return client
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      client.close()
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError ?? new Error('Timed out connecting to Codex websocket')
}

export async function readCodexTuiPid(socketPath: string | undefined): Promise<number | undefined> {
  if (socketPath === undefined) return undefined
  try {
    const value = Number.parseInt((await readFile(`${socketPath}.pid`, 'utf8')).trim(), 10)
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

export async function writeCodexTuiHookBridgeWrapper(
  callbackSocket: string,
  launcher: CodexTuiLauncher | undefined
): Promise<string> {
  const wrapperPath = `${callbackSocket}.codex-hook.ts`
  const shellCommand = buildCodexTuiHookReceiverArgv(launcher, callbackSocket)
    .map(shellQuote)
    .join(' ')
  await writeFile(
    wrapperPath,
    [
      '#!/usr/bin/env bun',
      "import { spawn } from 'node:child_process'",
      `const child = spawn('/bin/sh', ['-lc', ${JSON.stringify(`exec ${shellCommand}`)}], { stdio: 'inherit', env: process.env })`,
      "child.on('error', () => process.exit(0))",
      "child.on('exit', (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code ?? 0))",
      '',
    ].join('\n'),
    'utf8'
  )
  return wrapperPath
}

export function normalizeUserMessageText(item: Record<string, unknown>): string {
  const direct = frameString(item['text']) ?? frameString(item['content'])
  if (direct !== undefined) return direct
  const content = item['content']
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) => {
      const record = asFrameRecord(part)
      const text = frameString(record['text'])
      return text === undefined ? [] : [text]
    })
    .join('\n')
}

export function queueSubmissionId(value: unknown): string | undefined {
  const record = asFrameRecord(value)
  return (
    frameString(record['queuedSubmissionId']) ??
    frameString(record['id']) ??
    frameString(asFrameRecord(record['queuedSubmission'])['id']) ??
    frameString(asFrameRecord(record['submission'])['id'])
  )
}

export function queuedEntryRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asFrameRecord)
  const record = asFrameRecord(value)
  for (const key of ['data', 'items', 'queue', 'submissions']) {
    const entries = record[key]
    if (Array.isArray(entries)) return entries.map(asFrameRecord)
  }
  return []
}

export function findUntrustedHooks(value: unknown): Array<{ key: string; trustedHash: string }> {
  const found: Array<{ key: string; trustedHash: string }> = []
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry)
      return
    }
    const record = asFrameRecord(candidate)
    if (Object.keys(record).length === 0) return
    const key = frameString(record['key']) ?? frameString(record['hookKey'])
    const trustedHash =
      frameString(record['trustedHash']) ??
      frameString(record['trusted_hash']) ??
      frameString(record['hash'])
    if (record['trusted'] === false && key !== undefined && trustedHash !== undefined) {
      found.push({ key, trustedHash })
    }
    for (const nested of Object.values(record)) visit(nested)
  }
  visit(value)
  return found
}

export function turnCompletedNotificationId(notification: JsonRpcNotification): TurnId | undefined {
  const params = asFrameRecord(notification.params)
  return (frameString(params['turnId']) ?? frameString(asFrameRecord(params['turn'])['id'])) as
    | TurnId
    | undefined
}

export function classifyRpcFailure(error: Error): TurnFailure {
  const protocolFailure =
    error.message.startsWith('Failed to parse JSON-RPC message:') ||
    error.message.startsWith('Unexpected JSON-RPC response id:')
  const code = protocolFailure ? 'codex_rpc_protocol_error' : 'codex_rpc_transport_error'
  const causeCode = (error as Error & { code?: unknown }).code
  return {
    message: error.message.trim().length > 0 ? error.message : 'Codex app-server RPC failed',
    code,
    data: {
      code,
      fatal: true,
      errorName: error.name,
      ...(typeof causeCode === 'string' || typeof causeCode === 'number' ? { causeCode } : {}),
    },
    retryable: false,
    reason: 'transport-error',
  }
}

/**
 * Absolute path of the broker-owned provider-transcript export.
 *
 * The directory is taken from a broker-owned artifact root on `dispatchEnv`
 * (`HARNESS_BROKER_ARTIFACT_DIR`, supplied by HRC in production) when present;
 * otherwise it falls back to a deterministic, per-user broker-owned subtree
 * under the system temp root. The user fence matters on same-host multi-user
 * estates: one account must never inherit another account's unwritable temp
 * directory. The path is always ABSOLUTE and per-invocation.
 */
export function providerTranscriptPath(ctx: DriverContext): string {
  const fromDispatch = ctx.dispatchEnv?.['HARNESS_BROKER_ARTIFACT_DIR']
  const dir =
    typeof fromDispatch === 'string' && fromDispatch.length > 0
      ? fromDispatch
      : DEFAULT_PROVIDER_TRANSCRIPT_DIR
  mkdirSync(dir, { recursive: true })
  return join(dir, `${ctx.invocationId}.provider-transcript.jsonl`)
}

/**
 * Materialize the verifier-compatible JSONL export from committed rows.
 *
 * Opened `'w'` and written whole: the export is DERIVED, so rewriting it from
 * the journal is what keeps the §7.1 invariant true by construction — it can
 * never hold a row the journal does not. Durability of the evidence itself is
 * the journal's job (it fsyncs every record before the normalizer sees it);
 * this fsync only makes the export readable to whoever follows the
 * `provider.transcript.reported` pointer.
 */
export function writeProviderTranscriptExport(path: string, rows: string[]): void {
  const fd = openSync(path, 'w', 0o600)
  try {
    writeSync(fd, rows.map((row) => `${row}\n`).join(''))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Re-encoded frame for a notification that arrived without its verbatim line
 * (only the in-process test harness, which calls `onNotification` directly).
 * The wire path always carries the provider's own bytes.
 */
export function canonicalFrame(notification: JsonRpcNotification): Record<string, unknown> {
  return notification.params !== undefined
    ? {
        jsonrpc: '2.0',
        method: notification.method,
        params: notification.params,
      }
    : { jsonrpc: '2.0', method: notification.method }
}

/** The same re-encode for a server->client REQUEST, which also carries an id. */
export function canonicalRequestFrame(request: JsonRpcRequest): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: request.id,
    method: request.method,
    ...(request.params !== undefined ? { params: request.params } : {}),
  }
}

/**
 * Decode the COMMITTED record's bytes back into a notification. This is the
 * copy the normalizer reads — never the in-memory object the transport parsed —
 * so live normalization and replay are the same computation over the same
 * bytes. Returns undefined for a record that is not a JSON-RPC notification,
 * which the caller turns into a blocked-unknown rather than a silent drop.
 */
export function decodeCommittedNotification(
  record: RawProviderRecord
): JsonRpcNotification | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(record.rawBytes).toString('utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const frame = parsed as Record<string, unknown>
  if (typeof frame['method'] !== 'string') return undefined
  return {
    jsonrpc: '2.0',
    method: frame['method'],
    ...(frame['params'] !== undefined ? { params: frame['params'] } : {}),
  }
}

/**
 * The notification's OWN id, when it carries one (§7.1 `nativeId`). The item id
 * wins over the turn id where both are present: it is the finer identity, and
 * the turn is already reachable through the event envelope's `turnId`.
 */
export function nativeIdOf(notification: JsonRpcNotification): string | undefined {
  const params = asFrameRecord(notification.params)
  const item = asFrameRecord(params['item'])
  return (
    frameString(item['id']) ??
    frameString(params['itemId']) ??
    frameString(params['id']) ??
    frameString(params['turnId']) ??
    frameString(asFrameRecord(params['turn'])['id'])
  )
}

export function asFrameRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function frameString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Deterministic broker-owned fallback root for provider transcripts. The root
 * is stable per OS user (vs `mkdtemp`) so artifacts remain discoverable while
 * sibling accounts cannot collide on ownership/permissions. HRC normally
 * overrides it with a runtime-owned artifact root via
 * `HARNESS_BROKER_ARTIFACT_DIR`.
 */
export function defaultProviderTranscriptDir(
  tempRoot = tmpdir(),
  uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null
): string {
  return join(
    tempRoot,
    `spaces-harness-broker-provider-transcripts-${uid === null ? 'current-user' : `uid-${uid}`}`
  )
}

const DEFAULT_PROVIDER_TRANSCRIPT_DIR = defaultProviderTranscriptDir()

export function buildRendererControlSocketPath(
  driverCtx: DriverContext,
  surface: { socketPath: string },
  runtimeId: string | undefined
): string {
  const dir = surface.socketPath.includes('/')
    ? surface.socketPath.slice(0, surface.socketPath.lastIndexOf('/'))
    : '.'
  return buildHookSocketPath(dir, 'codex-app-server-renderer-control', {
    invocationId: driverCtx.invocationId,
    runtimeId,
  })
}

type DiagnosticEmitter = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: unknown
) => void

/**
 * Tolerantly validate the Codex `initialize` handshake response.
 *
 * - A clearly-unsupported `protocolVersion` (a string that does not carry the
 *   `codex-app-server/` namespace) is a hard failure: throw HarnessError so the
 *   broker fails the invocation predictably rather than driving an incompatible
 *   server.
 * - A present-but-non-string `protocolVersion`, or a non-object response, is
 *   suspicious but non-critical — emit a `warn` diagnostic and continue.
 * - A missing `protocolVersion` is loose-but-common (do not overfit to the fake
 *   server) — emit a `debug` diagnostic and continue.
 */
export function validateInitializeHandshake(
  result: unknown,
  emitDiagnostic: DiagnosticEmitter
): void {
  if (result === null || typeof result !== 'object') {
    emitDiagnostic('warn', 'Codex initialize response was not an object', {
      received: typeof result,
    })
    return
  }

  const protocolVersion = (result as Record<string, unknown>)['protocolVersion']
  if (typeof protocolVersion === 'string') {
    if (!protocolVersion.startsWith('codex-app-server/')) {
      throw new BrokerError(
        BrokerErrorCode.HarnessError,
        `Unsupported Codex app-server protocol version: ${protocolVersion}`,
        { protocolVersion }
      )
    }
    return
  }

  if (protocolVersion !== undefined) {
    emitDiagnostic('warn', 'Codex initialize protocolVersion was not a string', {
      received: typeof protocolVersion,
    })
    return
  }

  emitDiagnostic('debug', 'Codex initialize response omitted protocolVersion')
}

/**
 * Build `thread/start` params from the driver spec. Every driver-spec field is
 * either forwarded to the native call or deliberately handled elsewhere:
 *  - model / approvalPolicy / sandboxMode: forwarded here.
 *  - modelReasoningEffort: forwarded as a thread-scope `config` override here
 *    AND applied per-turn in buildTurnStartParams(effort).
 *  - defaultImageAttachments: applied per-turn in buildTurnStartParams.
 *  - resumeThreadId / resumeFallback / permissionPolicy: consumed by the driver
 *    resume + permission paths, not by thread/start.
 */
export function buildThreadStartParams(
  spec: HarnessInvocationSpec,
  driver: CodexAppServerDriverSpec
): Record<string, unknown> {
  return {
    model: driver.model ?? null,
    modelProvider: null,
    cwd: spec.process.cwd,
    approvalPolicy: driver.approvalPolicy ?? 'never',
    sandbox: driver.sandboxMode ?? null,
    config:
      driver.modelReasoningEffort !== undefined
        ? { model_reasoning_effort: driver.modelReasoningEffort }
        : null,
    baseInstructions: null,
    developerInstructions: null,
    experimentalRawEvents: false,
  }
}

export function extractThreadId(response: ThreadResponse | undefined): string {
  const threadId = response?.threadId ?? response?.thread?.id
  if (!threadId) {
    throw new BrokerError(
      BrokerErrorCode.HarnessError,
      'Codex thread id missing after app-server thread start'
    )
  }
  return threadId
}

export function turnStartResponseId(response: TurnStartResponse | undefined): TurnId | undefined {
  const turnId = response?.turn?.id
  return typeof turnId === 'string' && turnId.length > 0 ? (turnId as TurnId) : undefined
}

/**
 * Prefer the provider's one active turn. A malformed or ambiguous read never
 * becomes a pre-write rejection: retain the locally observed turn as the
 * best-effort steer target, or let the caller start an own turn when none is
 * available.
 */
interface ActiveTurnResolution {
  turnId?: TurnId | undefined
  authoritative: boolean
  issue?: string | undefined
  data?: Record<string, unknown> | undefined
}

export function currentActiveTurnFromTurnsList(
  response: ThreadTurnsListResponse | undefined,
  expectedThreadId: string,
  observedTurnId: TurnId | undefined
): ActiveTurnResolution {
  if (!Array.isArray(response?.data)) {
    return {
      turnId: observedTurnId,
      authoritative: false,
      issue: 'Codex thread/turns/list returned a malformed page; attempting best-effort steer',
      data: {
        threadId: expectedThreadId,
        observedTurnId: observedTurnId ?? null,
      },
    }
  }
  const activeTurnIds = response.data.flatMap((turn) =>
    turn.status === 'inProgress' && typeof turn.id === 'string' && turn.id.length > 0
      ? [turn.id as TurnId]
      : []
  )
  if (activeTurnIds.length === 0) {
    return { authoritative: true }
  }
  if (activeTurnIds.length === 1) {
    return { turnId: activeTurnIds[0], authoritative: true }
  }
  const bestEffortTurnId =
    observedTurnId !== undefined && activeTurnIds.includes(observedTurnId)
      ? observedTurnId
      : activeTurnIds.at(-1)
  return {
    turnId: bestEffortTurnId,
    authoritative: false,
    issue: 'Codex thread/turns/list returned multiple active turns; attempting best-effort steer',
    data: {
      threadId: expectedThreadId,
      activeTurnIds,
      selectedTurnId: bestEffortTurnId ?? null,
    },
  }
}

export function turnStartedNotificationId(notification: JsonRpcNotification): TurnId | undefined {
  if (notification.params === null || typeof notification.params !== 'object') return undefined
  const params = notification.params as Record<string, unknown>
  const direct = params['turnId']
  if (typeof direct === 'string' && direct.length > 0) return direct as TurnId
  const turn = params['turn']
  if (turn === null || typeof turn !== 'object') return undefined
  const nested = (turn as Record<string, unknown>)['id']
  return typeof nested === 'string' && nested.length > 0 ? (nested as TurnId) : undefined
}

export function isMissingThreadError(error: unknown): boolean {
  if (!(error instanceof CodexRpcError)) {
    return false
  }
  const code = extractErrorCode(error)
  return code === 'thread_missing' || /not found|no rollout found/i.test(error.message)
}

/**
 * Codex documents `expectedTurnId` as an active-turn precondition: a mismatch
 * rejects before it accepts the user input. Restrict the retry exception to
 * that typed failure and its explicit precondition wording; transport errors,
 * response mismatches, and all other provider failures remain uncertain.
 */
export function isDefiniteTurnMismatchError(error: unknown): error is CodexRpcError {
  if (!(error instanceof CodexRpcError) || extractErrorCode(error) !== 'turn_mismatch') {
    return false
  }
  return /expected(?:TurnId| active turn).*?(?:match|found)|active turn.*?expected/i.test(
    error.message
  )
}

export function extractErrorCode(error: CodexRpcError): string | undefined {
  if (typeof error.data === 'string') return error.data
  if (error.data !== null && typeof error.data === 'object') {
    const data = error.data as Record<string, unknown>
    return typeof data['code'] === 'string' ? data['code'] : undefined
  }
  return undefined
}
