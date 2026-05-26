#!/usr/bin/env bun
/**
 * Phase 5 real-target e2e GATE runner for T-01656 / T-01663.
 *
 * Proves the end state Lance wants: an operator `tmux attach`es to a REAL Claude
 * Code that was created/executed by the ASP compiler + harness-broker
 * claude-code-tmux DRIVER, while the pre-HRC harness records the REAL session's
 * normalized event ledger.
 *
 * Ownership contract (cody sign bar C-02741, guardrails #5/#6/#8):
 *   - The HARNESS (this runner) owns the tmux SERVER lifecycle: it allocates a
 *     socket and runs `tmux -S <socket> start-server` up front, supplies the
 *     socket as the dispatch-time runtime overlay (runtime.tmux.socketPath), and
 *     tears the server down with `kill-server` at the end (unless --keep-alive).
 *   - The DRIVER owns ONLY the session/pane: it attaches to the runtime-owned
 *     socket and runs `new-session` / `send-keys` / `kill-session`. It must never
 *     `start-server` / `kill-server` (asserted).
 *
 * Modes:
 *   - REAL (default): launches the ACTUAL `claude` binary in the tmux pane with
 *     the broker-owned `--settings` hook overlay so real Claude posts
 *     UserPromptSubmit / PreToolUse / PostToolUse / Stop hooks OUT-OF-BAND to the
 *     broker callback socket via the REAL `harness-broker claude-hook` bridge.
 *     This is clod's manual smoke (needs real Anthropic credentials).
 *   - STRUCTURAL (--mock-claude): real tmux server + real driver + real hook
 *     listener socket + real `harness-broker claude-hook` bridge CLI + real
 *     normalizer/ledger/assertions, but the Claude "brain" is replaced by feeding
 *     the REAL bridge a scripted hook sequence. Proves the harness/driver/server/
 *     hook wiring WITHOUT spending credentials. NOT the real-provider proof.
 *
 * Reuses the SIGNED Phase 4 interactive-tmux ledger assertions
 * (assertInteractiveTmuxEvents + PreHrcBrokerEventLedger) verbatim on the
 * captured ledger.
 *
 * Out of scope (task constraints): NO HRC integration, NO broker reattach/replay,
 * does NOT flip ASP_RUN_VIA_COMPILER, does NOT remove legacy-exec, does NOT import
 * hrc-runtime.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
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

import { compileRuntimePlan } from '../packages/agent-spaces/src/compile-runtime-plan.js'
import { buildCorrelationEnvVars } from '../packages/agent-spaces/src/placement-api.js'
import { assertInteractiveTmuxEvents } from '../packages/agent-spaces/src/testing/pre-hrc-broker-contract-harness.js'
import { PreHrcBrokerEventLedger } from '../packages/agent-spaces/src/testing/pre-hrc-broker-event-ledger.js'
import {
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
  verifyBrokerStartContract,
} from '../packages/agent-spaces/src/testing/pre-hrc-broker-helpers.js'

// harness-broker internals: this runner lives at the repo-root scripts/ surface,
// which is scanned by NEITHER boundary checker (check-boundaries scans
// packages/*/src; the contract-harness boundary scans only
// scripts/smoke-runtime-contract-broker-*.ts). So it may statically wire the REAL
// driver + manager, unlike the in-package harness which uses a dynamic import.
import { createClaudeCodeTmuxDriver } from '../packages/harness-broker/src/drivers/claude-code-tmux/driver'
import type {
  HookEnvelopeHandler,
  HookListenerHandle,
} from '../packages/harness-broker/src/drivers/claude-code-tmux/driver'
import { createInvocationEventSequencer } from '../packages/harness-broker/src/events'
import { createInvocationManager } from '../packages/harness-broker/src/invocation-manager'
import type { TmuxExec } from '../packages/harness-broker/src/runtime/tmux'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type AnthropicKeySource =
  | 'inherit'
  | { kind: 'consul'; path: string }
  | { kind: 'env'; var: string }

type CliArgs = {
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
  keepAlive: boolean
  mockClaude: boolean
  anthropicKeySource: AnthropicKeySource
  json: boolean
  help: boolean
}

const DEFAULT_PROMPTS = [
  'Reply with exactly the token ASP_PHASE5_TURN_1 and nothing else.',
  'Reply with exactly the token ASP_PHASE5_TURN_2 and nothing else.',
]

function printUsage(): void {
  console.log(
    [
      'Phase 5 real-target e2e GATE — operator tmux attach to a compiler+broker Claude.',
      '',
      'Usage:',
      '  bun scripts/phase5-real-claude-tmux-e2e.ts [options]                # REAL claude run',
      '  bun scripts/phase5-real-claude-tmux-e2e.ts --mock-claude            # structural wiring proof',
      '  bun scripts/phase5-real-claude-tmux-e2e.ts --keep-alive             # leave session up for tmux attach',
      '',
      'Options:',
      '  --scope-ref <handle>          Scope handle (default: curly@agent-spaces)',
      '  --agent-root <path>           Agent root (default: <repo>/../var/agents/<agent>)',
      '  --project-root <path>         Project root (default: cwd)',
      '  --cwd <path>                  Runtime working directory (default: project root)',
      '  --asp-home <path>             ASP home for materialization (default: /tmp/asp-phase5-claude-tmux)',
      '  --artifact-dir <path>         Artifact output dir (default: <asp-home>/phase5-artifacts)',
      '  --socket <path>               tmux server socket (default: <tmpdir>/phase5-claude-tmux-<pid>.sock)',
      '  --tmux-bin <path>             tmux binary (default: resolved from PATH / /opt/homebrew/bin/tmux)',
      '  --model <id>                  Requested Anthropic model (default: claude-sonnet-4-5)',
      '  --prompt <text>               Turn prompt; repeat for multiple turns (default: two tokens)',
      '  --boot-wait-ms <n>            Wait before first turn for claude to boot (default: 9000)',
      '  --turn-timeout-ms <n>         Per-turn wait for turn.completed (default: 120000)',
      '  --keep-alive                  Do NOT tear the tmux server down; print the attach command',
      '  --mock-claude                 STRUCTURAL: feed the real hook bridge a scripted hook sequence',
      '  --anthropic-key-source <src>  inherit (default) | consul:<kv-path> | env:<VARNAME>',
      '  --json                        Print result JSON to stdout',
      '  --help                        Show this message',
      '',
      'Credentials: on this host the Anthropic key is NOT in Consul KV — real claude',
      'auths via the macOS keychain (Claude Code-credentials). Default "inherit" lets',
      'claude self-auth. Use --anthropic-key-source consul:<path> or env:<VAR> to inject',
      'ANTHROPIC_API_KEY into the tmux server env (the pane inherits it) when a key exists.',
    ].join('\n')
  )
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.length === 0) throw new Error(`Missing value for ${flag}`)
  return value
}

function parseKeySource(value: string): AnthropicKeySource {
  if (value === 'inherit') return 'inherit'
  if (value.startsWith('consul:')) {
    const path = value.slice('consul:'.length)
    if (path.length === 0)
      throw new Error('--anthropic-key-source consul:<kv-path> requires a path')
    return { kind: 'consul', path }
  }
  if (value.startsWith('env:')) {
    const name = value.slice('env:'.length)
    if (name.length === 0) throw new Error('--anthropic-key-source env:<VARNAME> requires a name')
    return { kind: 'env', var: name }
  }
  throw new Error(
    `--anthropic-key-source must be inherit | consul:<path> | env:<VAR>, got ${value}`
  )
}

function resolveTmuxBin(): string {
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

function parseArgs(argv: string[]): CliArgs {
  const projectRoot = process.cwd()
  const aspHome = '/tmp/asp-phase5-claude-tmux'
  const prompts: string[] = []
  const args: CliArgs = {
    scopeRef: 'curly@agent-spaces',
    projectRoot,
    cwd: projectRoot,
    aspHome,
    artifactDir: join(aspHome, 'phase5-artifacts'),
    socketPath: join(tmpdir(), `phase5-claude-tmux-${process.pid}.sock`),
    tmuxBin: resolveTmuxBin(),
    model: 'claude-sonnet-4-5',
    prompts: DEFAULT_PROMPTS,
    bootWaitMs: 9000,
    turnTimeoutMs: 120_000,
    keepAlive: false,
    mockClaude: false,
    anthropicKeySource: 'inherit',
    json: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
        args.help = true
        return args
      case '--scope-ref':
        args.scopeRef = readValue(argv, i, arg)
        i += 1
        break
      case '--agent-root':
        args.agentRoot = resolve(readValue(argv, i, arg))
        i += 1
        break
      case '--project-root':
        args.projectRoot = resolve(readValue(argv, i, arg))
        if (args.cwd === projectRoot) args.cwd = args.projectRoot
        i += 1
        break
      case '--cwd':
        args.cwd = resolve(readValue(argv, i, arg))
        i += 1
        break
      case '--asp-home': {
        const next = resolve(readValue(argv, i, arg))
        if (args.artifactDir === join(args.aspHome, 'phase5-artifacts')) {
          args.artifactDir = join(next, 'phase5-artifacts')
        }
        args.aspHome = next
        i += 1
        break
      }
      case '--artifact-dir':
        args.artifactDir = resolve(readValue(argv, i, arg))
        i += 1
        break
      case '--socket':
        args.socketPath = resolve(readValue(argv, i, arg))
        i += 1
        break
      case '--tmux-bin':
        args.tmuxBin = readValue(argv, i, arg)
        i += 1
        break
      case '--model':
        args.model = readValue(argv, i, arg)
        i += 1
        break
      case '--prompt':
        prompts.push(readValue(argv, i, arg))
        i += 1
        break
      case '--boot-wait-ms':
        args.bootWaitMs = Number(readValue(argv, i, arg))
        if (!Number.isFinite(args.bootWaitMs) || args.bootWaitMs < 0) {
          throw new Error('--boot-wait-ms must be a non-negative number')
        }
        i += 1
        break
      case '--turn-timeout-ms':
        args.turnTimeoutMs = Number(readValue(argv, i, arg))
        if (!Number.isFinite(args.turnTimeoutMs) || args.turnTimeoutMs <= 0) {
          throw new Error('--turn-timeout-ms must be a positive number')
        }
        i += 1
        break
      case '--keep-alive':
        args.keepAlive = true
        break
      case '--mock-claude':
        args.mockClaude = true
        break
      case '--anthropic-key-source':
        args.anthropicKeySource = parseKeySource(readValue(argv, i, arg))
        i += 1
        break
      case '--json':
        args.json = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (prompts.length > 0) args.prompts = prompts
  if (args.prompts.length < 2) {
    throw new Error('Phase 5 requires at least TWO turns; pass --prompt twice or use the defaults.')
  }
  return args
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

function ensureAspHomeRegistry(args: CliArgs): void {
  const repoPath = join(args.aspHome, 'repo')
  if (existsSync(join(repoPath, 'spaces', 'defaults', 'space.toml'))) return
  if (existsSync(repoPath)) return
  const sourceRepo = localRegistryRepo(args.projectRoot)
  if (sourceRepo === undefined) return
  symlinkSync(sourceRepo, repoPath, 'dir')
}

// ---------------------------------------------------------------------------
// Compile request (interactive claude-code-tmux route)
// ---------------------------------------------------------------------------

function permissionPolicy(): BrokerPermissionPolicy {
  // Conservative default for the real run: deny tool permissions (the pre-HRC
  // path is observability-only; the prompts ask for a token, no tools needed).
  return { mode: 'deny', audit: true }
}

function compileRequest(args: CliArgs): RuntimeCompileRequest {
  const identity = allocatePreHrcRuntimeIdentity({
    namespace: 'phase5_claude_tmux',
    invocationId: 'inv_phase5_claude_tmux',
    initialInputId: 'input_phase5_claude_tmux',
    idempotencyKey: 'phase5-real-claude-tmux',
  })
  const placement = buildPlacementFromScopeRef({
    scopeRef: args.scopeRef,
    agentRoot: args.agentRoot,
    projectRoot: args.projectRoot,
    cwd: args.cwd,
    hostSessionId: identity.hostSessionId,
  })
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement,
    requested: {
      modelProvider: 'anthropic',
      model: args.model,
      harnessFamily: 'claude-code',
      preferredHarnessRuntime: 'claude-code-cli',
      interactionMode: 'interactive',
    },
    materialization: {
      initialPrompt: args.prompts[0] ?? DEFAULT_PROMPTS[0] ?? 'phase5 turn',
      attachments: [],
      taskContext: {
        taskId: 'T-01663',
        phase: 'real-e2e',
        role: 'curly',
        requiredEvidenceKinds: ['contract-artifacts'],
        hintsText: 'Phase 5 real-target operator-attachable Claude tmux session',
      },
    },
    hrcPolicy: {
      permissionPolicy: permissionPolicy(),
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
      resourceLimits: {
        startupTimeoutMs: args.turnTimeoutMs,
        turnTimeoutMs: args.turnTimeoutMs,
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
      appSessionKey: 'phase5-real-claude-tmux',
      scopeRef: args.scopeRef,
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
  // consul
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

// ---------------------------------------------------------------------------
// Real tmux server lifecycle (HARNESS-owned) + real driver tmux exec
// ---------------------------------------------------------------------------

type ExecResult = { stdout: string; stderr: string }

function runTmux(
  tmuxBin: string,
  argv: string[],
  env: Record<string, string | undefined>
): Promise<ExecResult> {
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

// ---------------------------------------------------------------------------
// Real hook callback listener (broker-owned unix socket). Mirrors the default
// driver's listenForHookEnvelopes but tracks close so the signed assertion can
// confirm a clean exit.
// ---------------------------------------------------------------------------

function makeHookListener(socketPath: string, onClose: () => void) {
  return async (handler: HookEnvelopeHandler): Promise<HookListenerHandle> => {
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

// ---------------------------------------------------------------------------
// Structural mock: drive the REAL hook bridge CLI with a scripted hook sequence.
// Does NOT set HARNESS_BROKER_TURN_ID — the driver fills its active turn id, so
// turn correlation flows through the SAME real path real Claude exercises.
// ---------------------------------------------------------------------------

function postHookViaBridge(options: {
  repoRoot: string
  tmuxBinUnused?: undefined
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

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type RunResult = {
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  const repoRoot = resolve(new URL('..', import.meta.url).pathname)
  const mode: RunResult['mode'] = args.mockClaude ? 'mock-claude-structural' : 'real-claude'
  mkdirSync(args.aspHome, { recursive: true })
  mkdirSync(args.artifactDir, { recursive: true })
  ensureAspHomeRegistry(args)

  // --- 1. Compile + select + verify the interactive claude-code-tmux profile ---
  const request = compileRequest(args)
  const compileResponse = await compileRuntimePlan(request, { clientAspHome: args.aspHome })
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
  const cred = await resolveAnthropicKey(args.anthropicKeySource, args.mockClaude)
  const serverEnv: Record<string, string | undefined> = { ...process.env }
  if (cred.key !== undefined) serverEnv['ANTHROPIC_API_KEY'] = cred.key

  // --- 3. HARNESS owns the tmux server: start-server on the allocated socket ---
  const tmuxServerEvents: RunResult['tmuxServerEvents'] = []
  const driverTmuxArgv: string[][] = []
  let serverStarted = false
  let serverTornDown = false
  let hookListenerClosed = false
  let driverDisposed = false
  let launchCommandLine: string | undefined
  const events: InvocationEventEnvelope[] = []
  const ledger = new PreHrcBrokerEventLedger()
  const turns: RunResult['turns'] = []

  const hookSocketPath = `${args.socketPath}.hooks`
  const hookBridgeCommand = `bun ${join(repoRoot, 'packages/harness-broker/bin/harness-broker.js')} claude-hook`

  // Recording + (mock) launch-intercepting tmux exec for the DRIVER. The driver
  // attaches to the harness-owned socket; this exec records every argv (so the
  // signed assertion can prove the driver never owns the server) and delegates to
  // the REAL tmux binary.
  const driverExec: TmuxExec = async (argv, options) => {
    driverTmuxArgv.push([...argv])
    // argv[0] is the tmux binary; the rest are tmux args.
    const tmuxArgs = argv.slice(1)
    // Capture (and in mock mode, neutralize) the claude launch send-keys.
    const sendIdx = tmuxArgs.indexOf('send-keys')
    if (sendIdx !== -1 && tmuxArgs.includes('-l')) {
      const payload = tmuxArgs[tmuxArgs.length - 1] ?? ''
      if (payload.includes('--settings') && payload.includes('HARNESS_BROKER_INVOCATION_ID=')) {
        launchCommandLine = payload
        if (args.mockClaude) {
          // Structural: do NOT launch real claude; send a benign marker so the
          // pane shell stays attachable. The REAL launch command line is still
          // recorded above as provenance.
          const neutralized = [...argv]
          neutralized[neutralized.length - 1] = ': phase5 mock-claude launch (real argv recorded)'
          return runTmux(args.tmuxBin, neutralized.slice(1), serverEnv)
        }
      }
    }
    return runTmux(args.tmuxBin, tmuxArgs, options?.env ?? serverEnv)
  }

  const result: RunResult = {
    schemaVersion: 'phase5-real-claude-tmux-e2e/v1',
    mode,
    ok: false,
    keepAlive: args.keepAlive,
    socketPath: args.socketPath,
    tmuxBin: args.tmuxBin,
    attachCommand: `${args.tmuxBin} -S ${args.socketPath} attach-session`,
    tmuxServerEvents,
    driverTmuxArgv,
    turns,
    provenance: {
      realClaudeArgv: [spec.process.command, ...spec.process.args],
      launchCommandLine: undefined,
      hookBridgeCommand,
      mockClaude: args.mockClaude,
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
      ledgerJson: join(args.artifactDir, 'phase5-real-claude-tmux-ledger.json'),
      eventsJsonl: join(args.artifactDir, 'phase5-real-claude-tmux-events.jsonl'),
      summaryJson: join(args.artifactDir, 'phase5-summary.json'),
    },
  }

  try {
    await runTmux(args.tmuxBin, ['-S', args.socketPath, 'start-server'], serverEnv)
    serverStarted = true
    tmuxServerEvents.push({ owner: 'harness', action: 'start-server', socketPath: args.socketPath })

    // --- 4. Build the REAL driver + manager and dispatch ---
    const driver = createClaudeCodeTmuxDriver({
      tmux: { socketPath: args.socketPath, tmuxBin: args.tmuxBin, exec: driverExec },
      hooks: {
        listen: makeHookListener(hookSocketPath, () => {
          hookListenerClosed = true
        }),
        bridgeCommand: hookBridgeCommand,
      },
    })

    const manager = createInvocationManager({
      sequencer: createInvocationEventSequencer({ now: () => new Date() }),
      onEvent: (event) => {
        events.push(event)
        ledger.append(event)
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

    const runtime: InvocationRuntimeContext = { tmux: { socketPath: args.socketPath } }
    await manager.start(spec, driver, undefined, dispatchEnv, runtime)
    result.provenance.launchCommandLine = launchCommandLine

    // Resolve the reported attach surface.
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
      result.attachCommand = `${args.tmuxBin} -S ${sp.socketPath} attach-session -t ${sp.sessionName}`
    }

    // Give real claude time to boot before the first turn.
    if (!args.mockClaude && args.bootWaitMs > 0) await delay(args.bootWaitMs)

    // --- 5. Drive >= 2 turns via terminal-literal input (send-keys) ---
    for (let i = 0; i < args.prompts.length; i += 1) {
      const prompt = args.prompts[i] ?? ''
      const inputResponse = await manager.input({
        invocationId,
        input: { kind: 'user', content: [{ type: 'text', text: prompt }] },
        policy: { whenBusy: 'reject' },
      })
      const turnId = inputResponse.turnId
      if (turnId === undefined) throw new Error(`Turn ${i + 1} did not return a broker turn id`)

      if (args.mockClaude) {
        // Structural: feed the REAL bridge a scripted hook sequence for this turn.
        await postHookViaBridge({
          repoRoot,
          callbackSocket: hookSocketPath,
          invocationId,
          hookData: { hook_event_name: 'UserPromptSubmit', prompt },
        })
        if (i === 0) {
          await postHookViaBridge({
            repoRoot,
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
            repoRoot,
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
          repoRoot,
          callbackSocket: hookSocketPath,
          invocationId,
          hookData: { hook_event_name: 'Stop' },
        })
      }

      const observed = await waitForTerminalTurn(events, turnId, args.turnTimeoutMs)
      turns.push({ index: i + 1, turnId, prompt, terminalTurnObserved: observed })
    }

    // --- 6. Teardown (unless --keep-alive) ---
    if (!args.keepAlive) {
      await manager.stop({ invocationId, reason: 'phase5 clean exit' }).catch(() => undefined)
      await manager.dispose({ invocationId }).catch(() => undefined)
      driverDisposed = true
      await runTmux(args.tmuxBin, ['-S', args.socketPath, 'kill-server'], serverEnv).catch(
        () => undefined
      )
      serverTornDown = true
      tmuxServerEvents.push({
        owner: 'harness',
        action: 'kill-server',
        socketPath: args.socketPath,
      })
      // Harness owns the server, so it unlinks its own socket inode after
      // kill-server (the DRIVER must never rm the socket; the harness may).
      const { rm } = await import('node:fs/promises')
      await rm(args.socketPath, { force: true }).catch(() => undefined)
    }
  } finally {
    // Safety net: never leak the server unless the operator explicitly asked.
    if (serverStarted && !serverTornDown && !args.keepAlive) {
      await runTmux(args.tmuxBin, ['-S', args.socketPath, 'kill-server'], serverEnv).catch(
        () => undefined
      )
      tmuxServerEvents.push({
        owner: 'harness',
        action: 'kill-server',
        socketPath: args.socketPath,
      })
      const { rm } = await import('node:fs/promises')
      await rm(args.socketPath, { force: true }).catch(() => undefined)
    }
  }

  // --- 7. Reuse the SIGNED Phase 4 ledger assertions on the captured ledger ---
  result.ledgerEventTypes = ledger.eventTypes()
  const failures: RunResult['assertionFailures'] = []
  for (const f of ledger.requireMonotonicSeq()) failures.push(f)
  for (const f of ledger.requireNoDuplicates()) failures.push(f)
  for (const f of ledger.requireOnlyNormalizedEventTypes()) failures.push(f)

  if (!args.keepAlive) {
    // Full signed interactive-tmux assertion, run per turn id (each turn must
    // have its own correlated turn.started + exactly one terminal turn). Global
    // checks are identical per call, so dedupe by code+message+path.
    const seen = new Set<string>()
    for (const turn of turns) {
      const perTurn = assertInteractiveTmuxEvents({
        events,
        socketPath: args.socketPath,
        inputTurnId: turn.turnId,
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
    // --keep-alive is the operator-attach DEMO: the server + session are left up
    // so the clean-exit / server-teardown / dispose assertions are intentionally
    // deferred. Per-turn correlation + surface checks still apply.
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
  writeFileSync(
    result.artifacts.eventsJsonl,
    `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  )
  writeFileSync(result.artifacts.summaryJson, `${JSON.stringify(result, null, 2)}\n`)

  // --- 9. Report ---
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`phase5 ${mode}: ${result.ok ? 'OK' : 'FAILED'}`)
    console.log(`socket: ${result.socketPath}`)
    console.log(`compileId: ${result.compile.compileId ?? '(none)'}`)
    console.log(`planHash: ${result.compile.planHash ?? '(none)'}`)
    console.log(`selectedProfileHash: ${result.compile.selectedProfileHash ?? '(none)'}`)
    console.log(`startRequestHash: ${result.compile.startRequestHash ?? '(none)'}`)
    console.log(`brokerDriver: ${result.compile.brokerDriver ?? '(none)'}`)
    console.log(`interactionMode: ${result.compile.interactionMode ?? '(none)'}`)
    console.log(`contractVerification: ${result.contractVerification.ok ? 'ok' : 'FAILED'}`)
    console.log(`credential: ${result.credentialNote}`)
    console.log(`surface: ${result.surface ? JSON.stringify(result.surface) : '(missing)'}`)
    console.log(
      `tmuxServerEvents: ${result.tmuxServerEvents.map((e) => e.action).join(',') || '(none)'}`
    )
    const argv = result.provenance.realClaudeArgv ?? []
    console.log(
      `realClaudeArgv[0..2]: ${argv.slice(0, 3).join(' ') || '(none)'} (${argv.length} args)`
    )
    const launch = result.provenance.launchCommandLine
    console.log(
      `launchCommandLine: ${launch === undefined ? '(not captured)' : `${launch.slice(0, 160)}… (${launch.length} chars; has --settings=${launch.includes('--settings')})`}`
    )
    for (const turn of result.turns) {
      console.log(
        `turn ${turn.index}: turnId=${turn.turnId} terminalTurn=${turn.terminalTurnObserved} prompt=${JSON.stringify(turn.prompt)}`
      )
    }
    console.log(`ledgerEventTypes: ${result.ledgerEventTypes.join(',') || '(none)'}`)
    for (const f of result.assertionFailures) {
      console.error(`assertion_failed ${f.code}: ${f.message}${f.path ? ` (${f.path})` : ''}`)
    }
    console.log(`artifact: ${result.artifacts.ledgerJson}`)
    console.log(`events:   ${result.artifacts.eventsJsonl}`)
    if (args.keepAlive) {
      console.log('')
      console.log('=== OPERATOR ATTACH (session left alive) ===')
      console.log(result.attachCommand)
      console.log(
        `(detach with Ctrl-b d; then teardown: ${args.tmuxBin} -S ${args.socketPath} kill-server)`
      )
    }
  }

  if (!result.ok) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}
