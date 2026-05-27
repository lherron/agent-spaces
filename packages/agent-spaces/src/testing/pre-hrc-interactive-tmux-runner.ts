/**
 * Reusable real-tmux interactive-Claude plumbing (T-01667, cody bar C-02759).
 *
 * Holds the signed Phase-4/5 interactive-tmux flow (formerly the standalone
 * phase5 real-claude-tmux gate, now retired into this lib) so BOTH the matrix
 * `real-claude-tmux` row and the `claude-tmux-ghostmux` operator-attach row drive
 * the SAME path. The signed interactive-tmux acceptance (assertInteractiveTmuxEvents
 * + PreHrcBrokerEventLedger) stays the authority and runs verbatim per
 * broker-applied turn id — this helper does not weaken it.
 *
 * Boundary note: this file lives under packages/agent-spaces/src/testing/**,
 * which the contract-harness boundary checker scans. It therefore must NOT
 * statically import the harness-broker driver/manager internals (the broker
 * driver module path). Those factories are INJECTED by the caller (the matrix
 * runner / phase5 CLI live under scripts/, which the checker does not scan, so
 * they may statically import the real factories and pass them in).
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationId,
  InvocationRuntimeContext,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  BrokerPermissionPolicy,
  RuntimeCompileRequest,
} from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { compileRuntimePlan } from '../compile-runtime-plan.js'
import { buildCorrelationEnvVars } from '../placement-api.js'
import { assertInteractiveTmuxEvents } from './pre-hrc-broker-contract-harness.js'
import { PreHrcBrokerEventLedger } from './pre-hrc-broker-event-ledger.js'
import {
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
  verifyBrokerStartContract,
} from './pre-hrc-broker-helpers.js'

// ---------------------------------------------------------------------------
// Injected harness-broker factory shapes (structural; no harness-broker import)
// ---------------------------------------------------------------------------

export type TmuxExecResult = { stdout: string; stderr: string }
export type TmuxExecFn = (
  argv: string[],
  options?: { env?: Record<string, string | undefined> | undefined } | undefined
) => Promise<TmuxExecResult>
export type HookEnvelopeHandlerFn = (envelope: unknown) => void | Promise<void>
export type HookListenerHandleShape = { socketPath: string; close: () => Promise<void> }
export type HookListenFn = (handler: HookEnvelopeHandlerFn) => Promise<HookListenerHandleShape>

export type InteractiveTmuxManager = {
  start: (
    spec: HarnessInvocationSpec,
    driver: unknown,
    initialInput: undefined,
    dispatchEnv: Record<string, string> | undefined,
    runtime: InvocationRuntimeContext
  ) => Promise<{ invocationId: string }>
  input: (request: {
    invocationId: string
    input: { kind: 'user'; content: Array<{ type: 'text'; text: string }> }
    policy: { whenBusy: 'reject' }
  }) => Promise<{ turnId?: string | undefined }>
  stop: (request: { invocationId: string; reason: string }) => Promise<unknown>
  dispose: (request: { invocationId: string }) => Promise<unknown>
}

export type InteractiveTmuxRunnerDeps = {
  createClaudeCodeTmuxDriver: (config: {
    tmux: { socketPath: string; tmuxBin: string; exec: TmuxExecFn }
    hooks: { listen: HookListenFn; bridgeCommand: string }
  }) => unknown
  createInvocationManager: (config: {
    sequencer: unknown
    onEvent: (event: InvocationEventEnvelope) => void
  }) => InteractiveTmuxManager
  createInvocationEventSequencer: (config: { now: () => Date }) => unknown
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type AnthropicKeySource =
  | 'inherit'
  | { kind: 'consul'; path: string }
  | { kind: 'env'; var: string }

export type InteractiveTmuxRunOptions = {
  repoRoot: string
  scopeRef: string
  agentRoot?: string | undefined
  projectRoot: string
  cwd: string
  aspHome: string
  artifactDir: string
  socketPath: string
  tmuxBin: string
  model: string
  prompts: string[]
  bootWaitMs: number
  turnTimeoutMs: number
  /**
   * Settle pause (ms) after each turn's terminal before delivering the NEXT
   * broker input. Defaults to 0 (unchanged pacing). Real Claude needs a beat to
   * return its TUI to the prompt after Stop; sending the next send-keys during
   * that transition can get the input swallowed and the turn lost. Matrix rows
   * pass a small value to keep multi-turn broker delivery reliable. Does not
   * affect any assertion.
   */
  interTurnSettleMs?: number | undefined
  keepAlive: boolean
  mockClaude: boolean
  anthropicKeySource: AnthropicKeySource
  /** Defaults to deny (the signed phase5 default). The matrix command-turn row
   * passes allow so the real Bash tool can execute the marker command. */
  permissionPolicy?: BrokerPermissionPolicy | undefined
  /** Override artifact basenames (matrix rows write row-scoped artifacts). */
  artifactNames?: { ledgerJson?: string; eventsJsonl?: string; summaryJson?: string } | undefined
  taskId?: string | undefined
  appSessionKey?: string | undefined
  identityNamespace?: string | undefined
  invocationId?: string | undefined
  initialInputId?: string | undefined
  idempotencyKey?: string | undefined
  /**
   * Operator-attach seam (matrix `claude-tmux-ghostmux` row). Invoked AFTER the
   * scripted broker-input turns and BEFORE teardown, while the tmux session is
   * still alive, so an operator can type an additional turn into the live pane
   * (e.g. via ghostmux). The runner then performs its normal clean teardown and
   * runs the SIGNED assertInteractiveTmuxEvents across ALL observed turn ids —
   * scripted AND operator-typed — so the operator turn is held to the full
   * clean-exit bar (cody non-negotiable: deferred teardown is never left
   * unasserted on an operator row). Only invoked when keepAlive is false.
   */
  afterTurns?: ((live: InteractiveTmuxLiveSession) => Promise<void>) | undefined
}

export type InteractiveTmuxLiveSession = {
  socketPath: string
  tmuxBin: string
  attachCommand: string
  surface?: { socketPath: string; sessionName: string; paneId: string } | undefined
  /** Live, mutating reference to the recorded event stream. */
  events: InvocationEventEnvelope[]
}

export type InteractiveTmuxRunResult = {
  schemaVersion: 'phase5-real-claude-tmux-e2e/v1'
  mode: 'real-claude' | 'mock-claude-structural'
  ok: boolean
  keepAlive: boolean
  socketPath: string
  tmuxBin: string
  attachCommand: string
  surface?: { socketPath: string; sessionName: string; paneId: string } | undefined
  tmuxServerEvents: Array<{
    owner: 'harness'
    action: 'start-server' | 'kill-server'
    socketPath: string
  }>
  driverTmuxArgv: string[][]
  turns: Array<{ index: number; turnId: string; prompt: string; terminalTurnObserved: boolean }>
  provenance: {
    realClaudeArgv: string[] | undefined
    launchCommandLine: string | undefined
    hookBridgeCommand: string
    mockClaude: boolean
    syntheticIds: false
  }
  credentialNote: string
  compile: {
    compileId: string | undefined
    planHash: string | undefined
    selectedProfileHash: string | undefined
    startRequestHash: string | undefined
    brokerDriver: string | undefined
    interactionMode: string | undefined
  }
  contractVerification: { ok: boolean; failures: unknown[] }
  assertionFailures: Array<{ code: string; message: string; path?: string | undefined }>
  ledgerEventTypes: string[]
  artifacts: { ledgerJson: string; eventsJsonl: string; summaryJson: string }
}

export type InteractiveTmuxRunOutput = {
  result: InteractiveTmuxRunResult
  events: InvocationEventEnvelope[]
}

// ---------------------------------------------------------------------------
// ASP home registry (mirror the real-codex smoke so the compiler resolves spaces)
// ---------------------------------------------------------------------------

function localRegistryRepo(projectRoot: string): string | undefined {
  const candidates = [
    process.env['ASP_REGISTRY'],
    process.env['ASP_HOME'] !== undefined ? join(process.env['ASP_HOME'], 'repo') : undefined,
    join(resolve(projectRoot, '..'), 'var', 'spaces-repo', 'repo'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates.find((candidate) =>
    existsSync(join(candidate, 'spaces', 'defaults', 'space.toml'))
  )
}

function ensureAspHomeRegistry(options: InteractiveTmuxRunOptions): void {
  const repoPath = join(options.aspHome, 'repo')
  if (existsSync(join(repoPath, 'spaces', 'defaults', 'space.toml'))) return
  if (existsSync(repoPath)) return
  const sourceRepo = localRegistryRepo(options.projectRoot)
  if (sourceRepo === undefined) return
  symlinkSync(sourceRepo, repoPath, 'dir')
}

// ---------------------------------------------------------------------------
// Compile request (interactive claude-code-tmux route)
// ---------------------------------------------------------------------------

function defaultPermissionPolicy(): BrokerPermissionPolicy {
  // Conservative default for the signed real run: deny tool permissions (the
  // pre-HRC path is observability-only; the token prompts need no tools).
  return { mode: 'deny', audit: true }
}

function compileRequest(options: InteractiveTmuxRunOptions): RuntimeCompileRequest {
  const identity = allocatePreHrcRuntimeIdentity({
    namespace: options.identityNamespace ?? 'phase5_claude_tmux',
    invocationId: options.invocationId ?? 'inv_phase5_claude_tmux',
    initialInputId: options.initialInputId ?? 'input_phase5_claude_tmux',
    idempotencyKey: options.idempotencyKey ?? 'phase5-real-claude-tmux',
  })
  const placement = buildPlacementFromScopeRef({
    scopeRef: options.scopeRef,
    agentRoot: options.agentRoot,
    projectRoot: options.projectRoot,
    cwd: options.cwd,
    hostSessionId: identity.hostSessionId,
  })
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement,
    requested: {
      modelProvider: 'anthropic',
      model: options.model,
      harnessFamily: 'claude-code',
      preferredHarnessRuntime: 'claude-code-cli',
      interactionMode: 'interactive',
    },
    materialization: {
      initialPrompt: options.prompts[0] ?? 'phase5 turn',
      attachments: [],
      taskContext: {
        taskId: options.taskId ?? 'T-01663',
        phase: 'real-e2e',
        role: 'curly',
        requiredEvidenceKinds: ['contract-artifacts'],
        hintsText: 'Phase 5 real-target operator-attachable Claude tmux session',
      },
    },
    hrcPolicy: {
      permissionPolicy: options.permissionPolicy ?? defaultPermissionPolicy(),
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
      resourceLimits: {
        startupTimeoutMs: options.turnTimeoutMs,
        turnTimeoutMs: options.turnTimeoutMs,
      },
      observability: { traceId: identity.traceId },
      capabilityPolicy: {
        allowDegrade: false,
        requireBrokerDefaultForCodexHeadless: true,
      },
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
      appId: 'agent-spaces',
      appSessionKey: options.appSessionKey ?? 'phase5-real-claude-tmux',
      scopeRef: options.scopeRef,
      laneRef: 'main',
    },
  }
}

function selectInteractiveProfile(profiles: BrokerExecutionProfile[]): BrokerExecutionProfile {
  const selected = profiles.find(
    (profile) =>
      profile.kind === 'harness-broker' &&
      profile.interactionMode === 'interactive' &&
      profile.brokerDriver === 'claude-code-tmux'
  )
  if (selected === undefined) {
    const candidates = JSON.stringify(
      profiles.map((p) => ({
        kind: p.kind,
        interactionMode: p.interactionMode,
        brokerDriver: p.brokerDriver,
      }))
    )
    throw new Error(
      `Compiler did not emit an interactive claude-code-tmux broker profile. Candidates: ${candidates}`
    )
  }
  return selected
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function consulKvGet(path: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const proc = spawn('consul', ['kv', 'get', path], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    proc.on('error', () => resolvePromise(undefined))
    proc.on('close', (code) => {
      if (code !== 0) {
        resolvePromise(undefined)
        return
      }
      const trimmed = out.replace(/\n$/, '')
      resolvePromise(trimmed.length > 0 ? trimmed : undefined)
    })
  })
}

async function resolveAnthropicKey(
  source: AnthropicKeySource,
  mockClaude: boolean
): Promise<{ key?: string | undefined; note: string }> {
  if (source === 'inherit') {
    return {
      note: 'inherit — no ANTHROPIC_API_KEY injected; claude self-auths (macOS keychain / login)',
    }
  }
  if (source.kind === 'env') {
    const key = process.env[source.var]
    if (key === undefined || key.length === 0) {
      const note = `env:${source.var} not set in runner environment`
      if (mockClaude) return { note: `${note} (ignored in --mock-claude)` }
      throw new Error(`BLOCKED: ${note}. Set ${source.var} before the real run.`)
    }
    return { key, note: `env:${source.var} (length ${key.length})` }
  }
  const key = await consulKvGet(source.path)
  if (key === undefined || key.length === 0) {
    const note = `consul kv get '${source.path}' returned empty/missing`
    if (mockClaude) return { note: `${note} (ignored in --mock-claude)` }
    throw new Error(
      `BLOCKED: ${note}. On this host the Anthropic key is not in Consul KV — either add it at that path, use --anthropic-key-source env:ANTHROPIC_API_KEY, or rely on the default keychain auth (--anthropic-key-source inherit).`
    )
  }
  return { key, note: `consul:${source.path} (length ${key.length})` }
}

// ---------------------------------------------------------------------------
// Real tmux server lifecycle (HARNESS-owned) + driver tmux exec
// ---------------------------------------------------------------------------

function runTmux(
  tmuxBin: string,
  argv: string[],
  env: Record<string, string | undefined>
): Promise<TmuxExecResult> {
  return new Promise((resolvePromise, reject) => {
    const cleanEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) if (v !== undefined) cleanEnv[k] = v
    const proc = spawn(tmuxBin, argv, { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
    })
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `tmux exited with ${code}`))
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

// Real hook callback listener (broker-owned unix socket). Mirrors the default
// driver's listenForHookEnvelopes but tracks close so the signed assertion can
// confirm a clean exit.
function makeHookListener(socketPath: string, onClose: () => void): HookListenFn {
  return async (handler: HookEnvelopeHandlerFn): Promise<HookListenerHandleShape> => {
    const { mkdir, rm } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(socketPath), { recursive: true }).catch(() => undefined)
    await rm(socketPath, { force: true }).catch(() => undefined)

    const server = createServer((conn) => {
      const chunks: Buffer[] = []
      conn.on('data', (chunk: Buffer) => chunks.push(chunk))
      conn.on('end', () => {
        void (async () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8').trim()
            if (body.length > 0) await handler(JSON.parse(body))
            conn.end('ok')
          } catch {
            conn.end('err')
          }
        })()
      })
    })

    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.removeListener('error', reject)
        resolvePromise()
      })
    })

    return {
      socketPath,
      close: () =>
        new Promise<void>((resolvePromise) => {
          onClose()
          server.close(() => resolvePromise())
        }),
    }
  }
}

// Structural mock: drive the REAL hook bridge CLI with a scripted hook sequence.
function postHookViaBridge(options: {
  repoRoot: string
  callbackSocket: string
  invocationId: string
  hookData: unknown
}): Promise<void> {
  const harnessBrokerJs = join(options.repoRoot, 'packages/harness-broker/bin/harness-broker.js')
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      'bun',
      [harnessBrokerJs, 'claude-hook', '--socket', options.callbackSocket],
      {
        env: {
          ...process.env,
          HARNESS_BROKER_INVOCATION_ID: options.invocationId,
          HARNESS_BROKER_HOOK_GENERATION: '1',
          HARNESS_BROKER_CALLBACK_SOCKET: options.callbackSocket,
        },
        stdio: ['pipe', 'ignore', 'pipe'],
      }
    )
    let stderr = ''
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `claude-hook exited with ${code}`))
      else resolvePromise()
    })
    proc.stdin.end(JSON.stringify(options.hookData))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function terminalTurnFor(events: InvocationEventEnvelope[], turnId: string): boolean {
  return events.some(
    (e) =>
      e.turnId === turnId &&
      (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.interrupted')
  )
}

async function waitForTerminalTurn(
  events: InvocationEventEnvelope[],
  turnId: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (terminalTurnFor(events, turnId)) return true
    await delay(250)
  }
  return terminalTurnFor(events, turnId)
}

export function resolveTmuxBin(): string {
  for (const candidate of [
    '/opt/homebrew/bin/tmux',
    '/opt/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return 'tmux'
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function runInteractiveClaudeTmuxSession(
  options: InteractiveTmuxRunOptions,
  deps: InteractiveTmuxRunnerDeps
): Promise<InteractiveTmuxRunOutput> {
  if (options.prompts.length < 2) {
    throw new Error(
      'interactive-tmux requires at least TWO turns to preserve per-turn correlation.'
    )
  }
  const mode: InteractiveTmuxRunResult['mode'] = options.mockClaude
    ? 'mock-claude-structural'
    : 'real-claude'
  mkdirSync(options.aspHome, { recursive: true })
  mkdirSync(options.artifactDir, { recursive: true })
  ensureAspHomeRegistry(options)

  // --- 1. Compile + select + verify the interactive claude-code-tmux profile ---
  const request = compileRequest(options)
  const compileResponse = await compileRuntimePlan(request, { clientAspHome: options.aspHome })
  if (!compileResponse.ok) {
    throw new Error(
      `Compile failed: ${compileResponse.diagnostics.map((d) => `${d.code}:${d.message}`).join('; ')}`
    )
  }
  const plan = compileResponse.plan
  const brokerProfiles = plan.executionProfiles.filter(
    (p): p is BrokerExecutionProfile => p.kind === 'harness-broker'
  )
  const profile = selectInteractiveProfile(brokerProfiles)
  const verification = verifyBrokerStartContract(profile)
  if (!verification.ok) {
    throw new Error(
      `Broker start contract verification failed: ${JSON.stringify(verification.failures)}`
    )
  }

  const startRequest = profile.harnessInvocation.startRequest
  const spec = startRequest.spec as HarnessInvocationSpec
  const invocationId = (spec.invocationId ?? 'inv_phase5_claude_tmux') as InvocationId

  // --- 2. Anthropic credentials (credential source per contract, NOT the spec) ---
  const cred = await resolveAnthropicKey(options.anthropicKeySource, options.mockClaude)
  const serverEnv: Record<string, string | undefined> = { ...process.env }
  if (cred.key !== undefined) serverEnv['ANTHROPIC_API_KEY'] = cred.key

  // --- 3. HARNESS owns the tmux server: start-server on the allocated socket ---
  const tmuxServerEvents: InteractiveTmuxRunResult['tmuxServerEvents'] = []
  const driverTmuxArgv: string[][] = []
  let serverStarted = false
  let serverTornDown = false
  let hookListenerClosed = false
  let driverDisposed = false
  let launchCommandLine: string | undefined
  const events: InvocationEventEnvelope[] = []
  const ledger = new PreHrcBrokerEventLedger()
  const turns: InteractiveTmuxRunResult['turns'] = []

  const hookSocketPath = `${options.socketPath}.hooks`
  const hookBridgeCommand = `bun ${join(options.repoRoot, 'packages/harness-broker/bin/harness-broker.js')} claude-hook`

  const driverExec: TmuxExecFn = async (argv, execOptions) => {
    driverTmuxArgv.push([...argv])
    const tmuxArgs = argv.slice(1)
    const sendIdx = tmuxArgs.indexOf('send-keys')
    if (sendIdx !== -1 && tmuxArgs.includes('-l')) {
      const payload = tmuxArgs[tmuxArgs.length - 1] ?? ''
      if (payload.includes('--settings') && payload.includes('HARNESS_BROKER_INVOCATION_ID=')) {
        launchCommandLine = payload
        if (options.mockClaude) {
          const neutralized = [...argv]
          neutralized[neutralized.length - 1] = ': phase5 mock-claude launch (real argv recorded)'
          return runTmux(options.tmuxBin, neutralized.slice(1), serverEnv)
        }
      }
    }
    return runTmux(options.tmuxBin, tmuxArgs, execOptions?.env ?? serverEnv)
  }

  const names = options.artifactNames ?? {}
  const result: InteractiveTmuxRunResult = {
    schemaVersion: 'phase5-real-claude-tmux-e2e/v1',
    mode,
    ok: false,
    keepAlive: options.keepAlive,
    socketPath: options.socketPath,
    tmuxBin: options.tmuxBin,
    attachCommand: `${options.tmuxBin} -S ${options.socketPath} attach-session`,
    tmuxServerEvents,
    driverTmuxArgv,
    turns,
    provenance: {
      realClaudeArgv: [spec.process.command, ...spec.process.args],
      launchCommandLine: undefined,
      hookBridgeCommand,
      mockClaude: options.mockClaude,
      syntheticIds: false,
    },
    credentialNote: cred.note,
    compile: {
      compileId: plan.compileId,
      planHash: plan.planHash,
      selectedProfileHash: profile.profileHash,
      startRequestHash: profile.harnessInvocation.startRequestHash,
      brokerDriver: profile.brokerDriver,
      interactionMode: profile.interactionMode,
    },
    contractVerification: { ok: verification.ok, failures: verification.failures },
    assertionFailures: [],
    ledgerEventTypes: [],
    artifacts: {
      ledgerJson:
        names.ledgerJson ?? join(options.artifactDir, 'phase5-real-claude-tmux-ledger.json'),
      eventsJsonl:
        names.eventsJsonl ?? join(options.artifactDir, 'phase5-real-claude-tmux-events.jsonl'),
      summaryJson: names.summaryJson ?? join(options.artifactDir, 'phase5-summary.json'),
    },
  }

  if (options.keepAlive) {
    writeFileSync(result.artifacts.eventsJsonl, '')
  }

  try {
    await runTmux(options.tmuxBin, ['-S', options.socketPath, 'start-server'], serverEnv)
    serverStarted = true
    tmuxServerEvents.push({
      owner: 'harness',
      action: 'start-server',
      socketPath: options.socketPath,
    })

    // --- 4. Build the REAL driver + manager (injected factories) and dispatch ---
    const driver = deps.createClaudeCodeTmuxDriver({
      tmux: { socketPath: options.socketPath, tmuxBin: options.tmuxBin, exec: driverExec },
      hooks: {
        listen: makeHookListener(hookSocketPath, () => {
          hookListenerClosed = true
        }),
        bridgeCommand: hookBridgeCommand,
      },
    })

    const manager = deps.createInvocationManager({
      sequencer: deps.createInvocationEventSequencer({ now: () => new Date() }),
      onEvent: (event) => {
        events.push(event)
        ledger.append(event)
        if (options.keepAlive) {
          appendFileSync(result.artifacts.eventsJsonl, `${JSON.stringify(event)}\n`)
        }
      },
    })

    const placementDispatchEnv =
      (request.placement as { dispatchEnv?: Record<string, string> | undefined }).dispatchEnv ?? {}
    const dispatchEnv: Record<string, string> = {
      ...buildCorrelationEnvVars(
        request.placement as unknown as Parameters<typeof buildCorrelationEnvVars>[0]
      ),
      ...placementDispatchEnv,
    }

    const runtime: InvocationRuntimeContext = { tmux: { socketPath: options.socketPath } }
    await manager.start(spec, driver, undefined, dispatchEnv, runtime)
    result.provenance.launchCommandLine = launchCommandLine

    const surfaceEvent = events.find((e) => e.type === 'terminal.surface.reported')
    const sp = surfaceEvent?.payload as
      | { socketPath?: string; sessionName?: string; paneId?: string }
      | undefined
    if (
      sp !== undefined &&
      typeof sp.socketPath === 'string' &&
      typeof sp.sessionName === 'string' &&
      typeof sp.paneId === 'string'
    ) {
      result.surface = { socketPath: sp.socketPath, sessionName: sp.sessionName, paneId: sp.paneId }
      result.attachCommand = `${options.tmuxBin} -S ${sp.socketPath} attach-session -t ${sp.sessionName}`
    }

    if (!options.mockClaude && options.bootWaitMs > 0) await delay(options.bootWaitMs)

    // --- 5. Drive >= 2 turns via terminal-literal input (send-keys) ---
    for (let i = 0; i < options.prompts.length; i += 1) {
      const prompt = options.prompts[i] ?? ''
      const inputResponse = await manager.input({
        invocationId,
        input: { kind: 'user', content: [{ type: 'text', text: prompt }] },
        policy: { whenBusy: 'reject' },
      })
      const turnId = inputResponse.turnId
      if (turnId === undefined) throw new Error(`Turn ${i + 1} did not return a broker turn id`)

      if (options.mockClaude) {
        await postHookViaBridge({
          repoRoot: options.repoRoot,
          callbackSocket: hookSocketPath,
          invocationId,
          hookData: { hook_event_name: 'UserPromptSubmit', prompt },
        })
        if (i === 0) {
          await postHookViaBridge({
            repoRoot: options.repoRoot,
            callbackSocket: hookSocketPath,
            invocationId,
            hookData: {
              hook_event_name: 'PreToolUse',
              tool_use_id: 'toolu_phase5_1',
              tool_name: 'Bash',
              tool_input: { command: 'true' },
            },
          })
          await postHookViaBridge({
            repoRoot: options.repoRoot,
            callbackSocket: hookSocketPath,
            invocationId,
            hookData: {
              hook_event_name: 'PostToolUse',
              tool_use_id: 'toolu_phase5_1',
              tool_name: 'Bash',
              tool_input: { command: 'true' },
              tool_response: { exit_code: 0, stdout: 'ok' },
            },
          })
        }
        await postHookViaBridge({
          repoRoot: options.repoRoot,
          callbackSocket: hookSocketPath,
          invocationId,
          hookData: { hook_event_name: 'Stop' },
        })
      }

      const observed = await waitForTerminalTurn(events, turnId, options.turnTimeoutMs)
      turns.push({ index: i + 1, turnId, prompt, terminalTurnObserved: observed })

      // Let real Claude return its TUI to the prompt before the next send-keys,
      // so a back-to-back broker input is not swallowed in the post-Stop
      // transition (no-op when interTurnSettleMs is 0 / unset).
      const settleMs = options.interTurnSettleMs ?? 0
      if (settleMs > 0 && i < options.prompts.length - 1) await delay(settleMs)
    }

    // --- 5b. Operator-attach seam: drive an extra live-pane turn before teardown ---
    if (!options.keepAlive && options.afterTurns !== undefined) {
      await options.afterTurns({
        socketPath: options.socketPath,
        tmuxBin: options.tmuxBin,
        attachCommand: result.attachCommand,
        surface: result.surface,
        events,
      })
    }

    // --- 6. Teardown (unless keepAlive) ---
    if (!options.keepAlive) {
      await manager.stop({ invocationId, reason: 'phase5 clean exit' }).catch(() => undefined)
      await manager.dispose({ invocationId }).catch(() => undefined)
      driverDisposed = true
      await runTmux(options.tmuxBin, ['-S', options.socketPath, 'kill-server'], serverEnv).catch(
        () => undefined
      )
      serverTornDown = true
      tmuxServerEvents.push({
        owner: 'harness',
        action: 'kill-server',
        socketPath: options.socketPath,
      })
      const { rm } = await import('node:fs/promises')
      await rm(options.socketPath, { force: true }).catch(() => undefined)
    }
  } finally {
    if (serverStarted && !serverTornDown && !options.keepAlive) {
      await runTmux(options.tmuxBin, ['-S', options.socketPath, 'kill-server'], serverEnv).catch(
        () => undefined
      )
      tmuxServerEvents.push({
        owner: 'harness',
        action: 'kill-server',
        socketPath: options.socketPath,
      })
      const { rm } = await import('node:fs/promises')
      await rm(options.socketPath, { force: true }).catch(() => undefined)
    }
  }

  // --- 7. Reuse the SIGNED Phase 4 ledger assertions on the captured ledger ---
  result.ledgerEventTypes = ledger.eventTypes()
  const failures: InteractiveTmuxRunResult['assertionFailures'] = []
  for (const f of ledger.requireMonotonicSeq()) failures.push(f)
  for (const f of ledger.requireNoDuplicates()) failures.push(f)
  for (const f of ledger.requireOnlyNormalizedEventTypes()) failures.push(f)

  if (!options.keepAlive) {
    // Enumerate EVERY observed broker-applied turn id (scripted broker-input
    // turns AND operator-typed turns injected via afterTurns), so the signed
    // interactive-tmux assertion runs verbatim per turn — no operator turn
    // escapes the clean-exit bar.
    const observedTurnIds = [
      ...new Set(
        events
          .filter((e) => e.type === 'turn.started' && typeof e.turnId === 'string')
          .map((e) => e.turnId as string)
      ),
    ]
    const assertedTurnIds =
      observedTurnIds.length > 0 ? observedTurnIds : turns.map((t) => t.turnId)
    const seen = new Set<string>()
    for (const inputTurnId of assertedTurnIds) {
      const perTurn = assertInteractiveTmuxEvents({
        events,
        socketPath: options.socketPath,
        inputTurnId,
        driverDisposed,
        hookListenerClosed,
        queuedInputLeft: false,
        tmuxServerEvents,
        driverTmuxArgv,
      })
      for (const f of perTurn) {
        const key = `${f.code}|${f.message}|${f.path ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        failures.push(f)
      }
    }
  } else {
    for (const turn of turns) {
      const surfaceIndex = events.findIndex((e) => e.type === 'terminal.surface.reported')
      const turnStarted = events.find((e) => e.type === 'turn.started' && e.turnId === turn.turnId)
      const terminalTurns = events.filter(
        (e) =>
          e.turnId === turn.turnId &&
          (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.interrupted')
      )
      if (surfaceIndex === -1) {
        failures.push({
          code: 'interactive_tmux_surface_invalid',
          message: 'terminal.surface.reported missing (keep-alive attach demo).',
        })
      }
      if (turnStarted === undefined) {
        failures.push({
          code: 'interactive_tmux_turn_correlation_invalid',
          message: `turn.started not correlated to broker turn id ${turn.turnId} (keep-alive).`,
        })
      }
      if (terminalTurns.length !== 1) {
        failures.push({
          code: 'broker_terminal_turn_count_invalid',
          message: `expected exactly one terminal turn for ${turn.turnId}, got ${terminalTurns.length} (keep-alive).`,
        })
      }
    }
  }

  result.assertionFailures = failures
  result.ok = failures.length === 0 && turns.every((t) => t.terminalTurnObserved)

  // --- 8. Write artifacts ---
  writeFileSync(result.artifacts.ledgerJson, `${JSON.stringify({ ...result, events }, null, 2)}\n`)
  if (!options.keepAlive) {
    writeFileSync(
      result.artifacts.eventsJsonl,
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
    )
  }
  writeFileSync(result.artifacts.summaryJson, `${JSON.stringify(result, null, 2)}\n`)

  return { result, events }
}
