#!/usr/bin/env bun
/**
 * Pre-HRC broker MATRIX e2e runner (T-01667, Lance directive 2026-05-26).
 *
 * ONE parameterized runner that iterates ALL implemented harness configurations,
 * drives the SAME canonical command turn through each, and validates the SAME
 * normalized broker event vocabulary fired — reusing existing coverage instead
 * of duplicating per-harness scripts.
 *
 * Rows (each gated on availability; SKIPs cleanly when binary/auth/Ghostty absent):
 *   (a) fake-codex            codex-app-server headless, deterministic fixture (CI-safe)
 *   (b) real-codex            codex-app-server headless, REAL `codex`
 *   (c) real-claude-tmux      claude-code-tmux interactive-tmux, REAL `claude`
 *   (d) claude-tmux-ghostmux  claude-code-tmux + REAL ghostmux operator-attach
 *
 * Cross-harness floor on EVERY row (cody bar C-02759 item 2):
 *   - compile/select/verify start contract (hashes + route invariants),
 *   - ledger integrity (monotonic seq / no dup / normalized vocab only; legacy
 *     invocation.permission.request is a HARD fail unless --allow-legacy-permission-event),
 *   - startup: invocation.started + invocation.ready,
 *   - assertSharedCommandTurn on the command turn (SEMANTIC, harness-agnostic).
 *
 * Per-row extras:
 *   - codex rows      -> continuation.updated; real-codex additionally runs the
 *                        app-server/env evidence checks.
 *   - claude-tmux row -> assertInteractiveTmuxEvents VERBATIM per turn (inside the
 *                        shared interactive runner lib) + >=2 broker-applied turns
 *                        (turn1 = Bash marker command turn, turn2 = plain token turn).
 *   - ghostmux row    -> operator-typed turn.started/.completed + tool.call.* +
 *                        pane/token visual beyond the scripted baseline, with the
 *                        FULL signed clean-exit assertion run across the operator
 *                        turn before PASS.
 *
 * This SUBSUMES and REPLACES the former bespoke scripts (smoke:broker-contract:* /
 * smoke:phase5:*), which were retired once cody re-signed the matrix. The signed
 * interactive-tmux flow now lives in the pre-hrc-interactive-tmux-runner +
 * pre-hrc-ghostmux-operator libs; this matrix is the single permanent e2e surface.
 *
 * Scripts/ surface is NOT scanned by the contract-harness boundary checker, so
 * this runner may statically import the harness-broker factories and inject them
 * into the boundary-clean interactive-tmux runner lib.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { BrokerPermissionPolicy, RuntimeCompileRequest } from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY, project } from 'spaces-runtime-contracts'

import { createClaudeCodeTmuxDriver } from '../packages/harness-broker/src/drivers/claude-code-tmux/driver'
import { createInvocationEventSequencer } from '../packages/harness-broker/src/events'
import { createInvocationManager } from '../packages/harness-broker/src/invocation-manager'

import { assertSharedCommandTurn } from '../packages/agent-spaces/src/testing/pre-hrc-broker-contract-assertions.js'
import type { SharedCommandTurnMarkerSource } from '../packages/agent-spaces/src/testing/pre-hrc-broker-contract-assertions.js'
import { runPreHrcBrokerContractHarness } from '../packages/agent-spaces/src/testing/pre-hrc-broker-contract-harness.js'
import type { ContractHarnessFailure } from '../packages/agent-spaces/src/testing/pre-hrc-broker-contract-types.js'
import { PreHrcBrokerEventLedger } from '../packages/agent-spaces/src/testing/pre-hrc-broker-event-ledger.js'
import {
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
} from '../packages/agent-spaces/src/testing/pre-hrc-broker-helpers.js'
import {
  capturePane,
  driveOperatorTurn,
  ghostmux,
  ghostmuxAvailable,
  pollUntil,
  waitForClaudePrompt,
} from '../packages/agent-spaces/src/testing/pre-hrc-ghostmux-operator.js'
import type { InteractiveTmuxRunnerDeps } from '../packages/agent-spaces/src/testing/pre-hrc-interactive-tmux-runner.js'
import { runInteractiveClaudeTmuxSession } from '../packages/agent-spaces/src/testing/pre-hrc-interactive-tmux-runner.js'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type RowName = 'fake-codex' | 'real-codex' | 'real-claude-tmux' | 'claude-tmux-ghostmux'
const ALL_ROWS: RowName[] = ['fake-codex', 'real-codex', 'real-claude-tmux', 'claude-tmux-ghostmux']

type CliArgs = {
  config?: RowName | undefined
  allowLegacyPermissionEvent: boolean
  keepArtifacts: boolean
  json: boolean
  bootWaitMs: number
  turnTimeoutMs: number
  help: boolean
}

function printUsage(): void {
  console.log(
    [
      'Pre-HRC broker MATRIX e2e runner.',
      '',
      'Usage:',
      '  bun scripts/pre-hrc-broker-matrix-e2e.ts [options]',
      '',
      'Options:',
      `  --config <name>                  Run a single row: ${ALL_ROWS.join(' | ')}`,
      '  --allow-legacy-permission-event  TEMPORARY: tolerate the legacy invocation.permission.request event',
      '  --boot-wait-ms <n>               Claude boot wait before the first tmux turn (default: 9000)',
      '  --turn-timeout-ms <n>            Per-turn terminal wait (default: 120000)',
      '  --keep-artifacts                 Do not delete temp fixtures/ASP homes on exit',
      '  --json                           Emit the full matrix report as JSON',
      '  --help                           Show this message',
    ].join('\n')
  )
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.length === 0) throw new Error(`Missing value for ${flag}`)
  return value
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    allowLegacyPermissionEvent: false,
    keepArtifacts: false,
    json: false,
    bootWaitMs: 9000,
    turnTimeoutMs: 120_000,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true
        return args
      case '--config': {
        const value = readValue(argv, i, arg)
        if (!ALL_ROWS.includes(value as RowName)) {
          throw new Error(`--config must be one of: ${ALL_ROWS.join(', ')}`)
        }
        args.config = value as RowName
        i += 1
        break
      }
      case '--allow-legacy-permission-event':
        args.allowLegacyPermissionEvent = true
        break
      case '--boot-wait-ms':
        args.bootWaitMs = Number(readValue(argv, i, arg))
        i += 1
        break
      case '--turn-timeout-ms':
        args.turnTimeoutMs = Number(readValue(argv, i, arg))
        i += 1
        break
      case '--keep-artifacts':
        args.keepArtifacts = true
        break
      case '--json':
        args.json = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type Failure = { code: string; message: string; path?: string | undefined }
type RowStatus = 'OK' | 'FAIL' | 'SKIP'

type RowResult = {
  name: RowName
  status: RowStatus
  reason?: string | undefined
  marker: string
  prompt?: string | undefined
  commandTurnId?: string | undefined
  observedTurnIds: string[]
  compile: {
    compileId?: string | undefined
    planHash?: string | undefined
    selectedProfileHash?: string | undefined
    startRequestHash?: string | undefined
  }
  floorFailures: Failure[]
  contractFailures: Failure[]
  extraFailures: Failure[]
  notes: Record<string, unknown>
}

type RowContext = {
  repoRoot: string
  marker: string
  allowLegacyPermissionEvent: boolean
  keepArtifacts: boolean
  bootWaitMs: number
  turnTimeoutMs: number
  tmuxBin: string
}

type HarnessConfig = {
  name: RowName
  description: string
  probe: (ctx: RowContext) => Promise<{ available: boolean; reason: string }>
  run: (ctx: RowContext) => Promise<RowResult>
}

function toFailure(f: ContractHarnessFailure): Failure {
  return { code: f.code, message: f.message, path: f.path }
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

function resolveClaudeBin(): string | undefined {
  for (const candidate of [
    process.env['ASP_CLAUDE_PATH'],
    join(process.env['HOME'] ?? '', '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return undefined
}

function resolveRealCodexBin(): string | undefined {
  for (const candidate of [
    process.env['ASP_CODEX_PATH'],
    join(process.env['HOME'] ?? '', '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
  ]) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Shared cross-harness floor
// ---------------------------------------------------------------------------

function deriveCommandTurnId(events: InvocationEventEnvelope[]): string | undefined {
  const tool = events.find(
    (e) => e.type === 'tool.call.started' && typeof e.turnId === 'string' && e.turnId.length > 0
  )
  if (typeof tool?.turnId === 'string') return tool.turnId
  const started = events.find(
    (e) => e.type === 'turn.started' && typeof e.turnId === 'string' && e.turnId.length > 0
  )
  return typeof started?.turnId === 'string' ? started.turnId : undefined
}

/**
 * Locate the turn whose matched Bash tool command carried `marker` in its
 * normalized tool.call.started payload.input.command (or stringified input).
 * Used to robustly identify the operator-typed turn by its UNIQUE marker,
 * independent of real-claude turn-id attribution.
 */
function findTurnWithToolCommandMarker(
  events: InvocationEventEnvelope[],
  marker: string
): string | undefined {
  for (const event of events) {
    if (event.type !== 'tool.call.started') continue
    if (typeof event.turnId !== 'string' || event.turnId.length === 0) continue
    const payload = asRecord(event.payload)
    const input = asRecord(payload?.['input'])
    const command = input?.['command']
    const haystack = typeof command === 'string' ? command : JSON.stringify(input ?? {})
    if (haystack.includes(marker)) return event.turnId
  }
  return undefined
}

function observedTurnIds(events: InvocationEventEnvelope[]): string[] {
  return [
    ...new Set(
      events
        .filter((e) => e.type === 'turn.started' && typeof e.turnId === 'string')
        .map((e) => e.turnId as string)
    ),
  ]
}

/** Ledger integrity + startup-event floor, applied uniformly to every row. */
function assertLedgerFloor(
  events: InvocationEventEnvelope[],
  allowLegacyPermissionEvent: boolean
): Failure[] {
  const ledger = new PreHrcBrokerEventLedger()
  for (const event of events) ledger.append(event)
  const failures: ContractHarnessFailure[] = [
    ...ledger.requireMonotonicSeq(),
    ...ledger.requireNoDuplicates(),
    ...ledger.requireOnlyNormalizedEventTypes({ allowLegacyPermissionEvent }),
  ]
  const types = new Set(events.map((e) => e.type))
  for (const required of ['invocation.started', 'invocation.ready'] as const) {
    if (!types.has(required)) {
      failures.push({
        code: 'broker_event_baseline_missing',
        message: `Broker event stream did not include required startup event: ${required}.`,
        path: 'brokerEvents',
      })
    }
  }
  return failures.map(toFailure)
}

/** Full shared floor for a row: ledger integrity + the semantic command turn. */
function runSharedFloor(
  events: InvocationEventEnvelope[],
  marker: string,
  commandTurnId: string | undefined,
  allowLegacyPermissionEvent: boolean,
  markerSources?: readonly SharedCommandTurnMarkerSource[]
): Failure[] {
  const failures = assertLedgerFloor(events, allowLegacyPermissionEvent)
  if (commandTurnId === undefined) {
    failures.push({
      code: 'shared_command_turn_missing',
      message: 'Could not derive a command turn id from the broker event stream.',
    })
    return failures
  }
  failures.push(
    ...assertSharedCommandTurn(events, {
      turnId: commandTurnId,
      expectedMarker: marker,
      ...(markerSources !== undefined ? { markerSources } : {}),
    }).map(toFailure)
  )
  return failures
}

// claude-code-tmux surfaces NO assistant text (hook-derived turns only), so the
// shared command-turn marker is sourced from the Bash tool command/output.
// tool-output is preferred FIRST (strongest evidence: the marker actually
// appeared in the executed command's output, proving execution) ahead of
// tool-command, then assistant (cody re-sign cosmetic). Order is OR for pass/fail
// and only affects which source markerSatisfiedBy reports.
const CLAUDE_MARKER_SOURCES: readonly SharedCommandTurnMarkerSource[] = [
  'tool-output',
  'tool-command',
  'assistant',
]

/** Best-effort record of WHICH marker source satisfied the command turn (cody re-sign note). */
function markerSatisfiedBy(
  events: InvocationEventEnvelope[],
  turnId: string | undefined,
  marker: string,
  sources: readonly SharedCommandTurnMarkerSource[]
): SharedCommandTurnMarkerSource | 'none' {
  if (turnId === undefined) return 'none'
  for (const source of sources) {
    if (
      assertSharedCommandTurn(events, { turnId, expectedMarker: marker, markerSources: [source] })
        .length === 0
    ) {
      return source
    }
  }
  return 'none'
}

function brokerEvents(
  result: Awaited<ReturnType<typeof runPreHrcBrokerContractHarness>>
): InvocationEventEnvelope[] {
  return result.brokerStart?.attempted === true ? result.brokerStart.events : []
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

// ---------------------------------------------------------------------------
// Codex rows (fake + real) — shared mechanics
// ---------------------------------------------------------------------------

function codexCompileRequest(input: {
  scopeRef: string
  agentRoot?: string | undefined
  projectRoot: string
  cwd: string
  prompt: string
  marker: string
  timeoutMs: number
  model?: string | undefined
  lockedEnv?: Record<string, string> | undefined
}): RuntimeCompileRequest {
  const identity = allocatePreHrcRuntimeIdentity({
    namespace: 'prehrc_matrix_codex',
    invocationId: `inv_matrix_codex_${input.marker}`,
    initialInputId: `input_matrix_codex_${input.marker}`,
    idempotencyKey: `pre-hrc-matrix-codex-${input.marker}`,
  })
  const placement = buildPlacementFromScopeRef({
    scopeRef: input.scopeRef,
    agentRoot: input.agentRoot,
    projectRoot: input.projectRoot,
    cwd: input.cwd,
    hostSessionId: identity.hostSessionId,
    ...(input.lockedEnv !== undefined ? { lockedEnv: input.lockedEnv } : {}),
  })
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement,
    requested: {
      modelProvider: 'openai',
      model: input.model,
      reasoningEffort: 'medium',
      harnessFamily: 'codex',
      preferredHarnessRuntime: 'codex-cli',
      interactionMode: 'headless',
    },
    materialization: {
      initialPrompt: input.prompt,
      taskContext: {
        taskId: 'T-01667',
        phase: 'matrix',
        role: 'smoke',
        requiredEvidenceKinds: ['contract-artifacts'],
        hintsText: 'pre-HRC broker matrix codex row',
      },
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: input.timeoutMs, turnTimeoutMs: input.timeoutMs },
      observability: { traceId: identity.traceId },
      capabilityPolicy: { allowDegrade: false, requireBrokerDefaultForCodexHeadless: true },
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
      appSessionKey: `pre-hrc-matrix-codex-${input.marker}`,
      scopeRef: input.scopeRef,
      laneRef: 'main',
    },
  }
}

/** continuation.updated presence — codex-row extra (cody bar item 2). */
function assertCodexContinuation(events: InvocationEventEnvelope[]): Failure[] {
  if (events.some((e) => e.type === 'continuation.updated')) return []
  return [
    {
      code: 'codex_continuation_missing',
      message: 'codex row did not emit continuation.updated.',
    },
  ]
}

/** Real-codex app-server / env evidence (ported from the real-codex smoke). */
function assertRealCodexEnvEvidence(
  result: Awaited<ReturnType<typeof runPreHrcBrokerContractHarness>>,
  agentRoot: string,
  marker: string
): Failure[] {
  const failures: Failure[] = []
  const profile = result.selectedProfile
  if (profile === undefined || !result.compileResponse.ok) {
    return [{ code: 'real_codex_no_profile', message: 'no selected broker profile / plan' }]
  }
  const startRequest = profile.harnessInvocation.startRequest
  const processSpec = startRequest.spec.process
  const lockedEnv = processSpec.lockedEnv ?? {}
  const pathPrepend = processSpec.pathPrepend ?? []
  const specHashOf = (value: unknown): string =>
    (project(value, 'spec') as { specHash: string }).specHash
  const baselineSpecHash = specHashOf(startRequest.spec)

  if (processSpec.command !== 'codex' && !processSpec.command.endsWith('/codex')) {
    failures.push({
      code: 'real_codex_command',
      message: `expected codex, got ${processSpec.command}`,
    })
  }
  if (!processSpec.args.includes('app-server')) {
    failures.push({
      code: 'real_codex_app_server',
      message: `expected app-server arg, got ${processSpec.args.join(' ')}`,
    })
  }
  const codexHome = lockedEnv['CODEX_HOME']
  if (codexHome === undefined) {
    failures.push({ code: 'real_codex_codex_home', message: 'CODEX_HOME missing from lockedEnv' })
  } else if (!existsSync(join(codexHome, 'auth.json'))) {
    failures.push({
      code: 'real_codex_codex_auth',
      message: `CODEX_HOME/auth.json missing at ${join(codexHome, 'auth.json')}`,
    })
  }
  // lockedEnv participates in the spec hash (de-redaction model).
  const mutatedKey = {
    ...startRequest.spec,
    process: { ...processSpec, lockedEnv: { ...lockedEnv, ASP_MATRIX_HASH_PROBE: '1' } },
  }
  if (specHashOf(mutatedKey) === baselineSpecHash) {
    failures.push({
      code: 'real_codex_locked_env_hash',
      message: 'adding a lockedEnv key did not change the spec hash',
    })
  }
  const expectedToolBin = join(resolve(agentRoot), 'tools', 'bin')
  if (pathPrepend.length === 0) {
    failures.push({ code: 'real_codex_path_prepend', message: 'process.pathPrepend was empty' })
  } else if (pathPrepend[0] !== expectedToolBin) {
    failures.push({
      code: 'real_codex_path_prepend',
      message: `expected pathPrepend[0] ${expectedToolBin}, got ${pathPrepend[0]}`,
    })
  }
  // assistant marker present in the command turn's reply.
  const events = brokerEvents(result)
  const assistantHasMarker = events.some((e) => {
    const payload = asRecord(e.payload)
    if (e.type === 'assistant.message.delta')
      return String(payload?.['text'] ?? '').includes(marker)
    if (e.type === 'turn.completed') return String(payload?.['finalOutput'] ?? '').includes(marker)
    return false
  })
  if (!assistantHasMarker) {
    failures.push({ code: 'real_codex_marker', message: `assistant marker ${marker} missing` })
  }
  return failures
}

async function runCodexRow(
  ctx: RowContext,
  options: {
    real: boolean
    codexPath: string
    aspHome: string
    artifactDir: string
    agentRoot: string
    projectRoot: string
    scopeRef: string
    lockedEnv?: Record<string, string> | undefined
  }
): Promise<RowResult> {
  const prompt = `Run \`printf '${ctx.marker}'\` then reply with exactly ${ctx.marker} and nothing else.`
  const name: RowName = options.real ? 'real-codex' : 'fake-codex'
  const result: RowResult = {
    name,
    status: 'FAIL',
    marker: ctx.marker,
    prompt,
    observedTurnIds: [],
    compile: {},
    floorFailures: [],
    contractFailures: [],
    extraFailures: [],
    notes: {},
  }

  const savedCodexPath = process.env['ASP_CODEX_PATH']
  const savedSkip = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  process.env['ASP_CODEX_PATH'] = options.codexPath
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

  try {
    const harnessResult = await runPreHrcBrokerContractHarness({
      schemaVersion: 'pre-hrc-broker-contract-harness-input/v1',
      compileRequest: codexCompileRequest({
        scopeRef: options.scopeRef,
        agentRoot: options.agentRoot,
        projectRoot: options.projectRoot,
        cwd: options.projectRoot,
        prompt,
        marker: ctx.marker,
        timeoutMs: ctx.turnTimeoutMs,
        lockedEnv: options.lockedEnv,
      }),
      aspHome: options.aspHome,
      artifactDir: options.artifactDir,
      dryRunCompile: false,
      allowLegacyPermissionEvent: ctx.allowLegacyPermissionEvent,
      timeoutMs: ctx.turnTimeoutMs,
      brokerStartAssertions: {
        baseline: { expectInitialInputAccepted: true, expectedTerminalType: 'turn.completed' },
      },
    })

    const events = brokerEvents(harnessResult)
    const commandTurnId = deriveCommandTurnId(events)
    result.commandTurnId = commandTurnId
    result.observedTurnIds = observedTurnIds(events)
    result.compile = {
      compileId: harnessResult.compiledPlan?.compileId,
      planHash: harnessResult.compiledPlan?.planHash,
      selectedProfileHash: harnessResult.selectedProfile?.profileHash,
      startRequestHash: harnessResult.selectedProfile?.harnessInvocation.startRequestHash,
    }
    result.notes['brokerStartAttempted'] = harnessResult.brokerStart?.attempted === true
    result.notes['eventCount'] = events.length

    // Contract bucket: the harness already ran compile/select/verify + baseline.
    result.contractFailures = harnessResult.assertionReport.failures.map(toFailure)
    if (harnessResult.brokerStart?.attempted !== true) {
      result.contractFailures.push({
        code: 'broker_start_not_attempted',
        message: `broker start not attempted (${harnessResult.brokerStart?.attempted === false ? harnessResult.brokerStart.reason : 'unknown'})`,
      })
    }

    // Uniform floor.
    result.floorFailures = runSharedFloor(
      events,
      ctx.marker,
      commandTurnId,
      ctx.allowLegacyPermissionEvent
    )

    // Per-row extras.
    result.extraFailures.push(...assertCodexContinuation(events))
    if (options.real) {
      result.extraFailures.push(
        ...assertRealCodexEnvEvidence(harnessResult, options.agentRoot, ctx.marker)
      )
    }

    const allFailed =
      result.floorFailures.length + result.contractFailures.length + result.extraFailures.length
    result.status = allFailed === 0 ? 'OK' : 'FAIL'
  } finally {
    process.env['ASP_CODEX_PATH'] = savedCodexPath
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = savedSkip
  }
  return result
}

/** Build a fake-codex shim that execs `bun <fixture>` for `app-server`. */
function createFakeCodexFixture(repoRoot: string): {
  agentRoot: string
  projectRoot: string
  aspHome: string
  artifactDir: string
  codexPath: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-matrix-fake-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  const artifactDir = join(aspHome, 'matrix-fake-artifacts')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    'schemaVersion = 2\n\n[spaces]\nbase = []\n\n[brain]\nenabled = false\n',
    'utf8'
  )
  const fixture = join(
    repoRoot,
    'packages/harness-broker/test/fixtures/fake-codex/command-turn-marker.ts'
  )
  const codexPath = join(aspHome, 'codex')
  writeFileSync(
    codexPath,
    `#!/usr/bin/env bash\nif [[ "$*" == *"--version"* ]]; then\n  echo "codex 999.0.0"\n  exit 0\nfi\nif [[ "$*" == *"app-server"* && "$*" == *"--help"* ]]; then\n  echo "app-server"\n  exit 0\nfi\nif [[ "$*" == *"app-server"* ]]; then\n  exec bun "${fixture}"\nfi\necho "codex shim"\n`,
    'utf8'
  )
  chmodSync(codexPath, 0o755)
  return {
    agentRoot,
    projectRoot,
    aspHome,
    artifactDir,
    codexPath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function localRegistryRepo(projectRoot: string): string | undefined {
  const candidates = [
    process.env['ASP_REGISTRY'],
    process.env['ASP_HOME'] !== undefined ? join(process.env['ASP_HOME'], 'repo') : undefined,
    join(resolve(projectRoot, '..'), 'var', 'spaces-repo', 'repo'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidates.find((c) => existsSync(join(c, 'spaces', 'defaults', 'space.toml')))
}

function ensureAspHomeRegistry(aspHome: string, projectRoot: string): void {
  const repoPath = join(aspHome, 'repo')
  if (existsSync(join(repoPath, 'spaces', 'defaults', 'space.toml'))) return
  if (existsSync(repoPath)) return
  const source = localRegistryRepo(projectRoot)
  if (source === undefined) return
  symlinkSync(source, repoPath, 'dir')
}

// ---------------------------------------------------------------------------
// Claude tmux rows — shared interactive runner deps
// ---------------------------------------------------------------------------

function interactiveDeps(): InteractiveTmuxRunnerDeps {
  return {
    createClaudeCodeTmuxDriver:
      createClaudeCodeTmuxDriver as InteractiveTmuxRunnerDeps['createClaudeCodeTmuxDriver'],
    createInvocationManager:
      createInvocationManager as unknown as InteractiveTmuxRunnerDeps['createInvocationManager'],
    createInvocationEventSequencer:
      createInvocationEventSequencer as InteractiveTmuxRunnerDeps['createInvocationEventSequencer'],
  }
}

function allowPermissionPolicy(): BrokerPermissionPolicy {
  // requestId/createdAt are branded ids; this is test-only provenance.
  return {
    mode: 'allow',
    audit: true,
    provenance: {
      source: 'test',
      requestId: 'request_matrix',
      createdAt: new Date().toISOString(),
    },
  } as BrokerPermissionPolicy
}

// ---------------------------------------------------------------------------
// HARNESS_CONFIGS
// ---------------------------------------------------------------------------

const HARNESS_CONFIGS: HarnessConfig[] = [
  {
    name: 'fake-codex',
    description: 'codex-app-server headless against a deterministic fixture (CI-safe)',
    probe: async () => ({ available: true, reason: 'fake fixture is always available' }),
    run: async (ctx) => {
      const fixture = createFakeCodexFixture(ctx.repoRoot)
      try {
        return await runCodexRow(ctx, {
          real: false,
          codexPath: fixture.codexPath,
          aspHome: fixture.aspHome,
          artifactDir: fixture.artifactDir,
          agentRoot: fixture.agentRoot,
          projectRoot: fixture.projectRoot,
          scopeRef: 'cody@agent-spaces',
          // Propagate the unique per-run marker into the broker-spawned codex
          // process env (lockedEnv) so the deterministic fixture echoes it.
          lockedEnv: { ASP_MATRIX_FAKE_MARKER: ctx.marker },
        })
      } finally {
        if (!ctx.keepArtifacts) fixture.cleanup()
      }
    },
  },
  {
    name: 'real-codex',
    description: 'codex-app-server headless against the REAL codex binary',
    probe: async () => {
      const codex = resolveRealCodexBin()
      if (codex === undefined) {
        return {
          available: false,
          reason:
            'real codex binary not found (set ASP_CODEX_PATH or install codex; shell aliases do not count)',
        }
      }
      if (!existsSync(join(process.env['HOME'] ?? '', '.codex', 'auth.json'))) {
        return { available: false, reason: 'codex auth (~/.codex/auth.json) not present' }
      }
      return { available: true, reason: `real codex at ${codex}` }
    },
    run: async (ctx) => {
      const codex = resolveRealCodexBin()
      if (codex === undefined) throw new Error('real codex binary disappeared after probe')
      const aspHome = mkdtempSync(join(tmpdir(), 'asp-matrix-real-codex-'))
      const artifactDir = join(aspHome, 'matrix-real-codex-artifacts')
      const projectRoot = ctx.repoRoot
      ensureAspHomeRegistry(aspHome, projectRoot)
      const scopeRef = 'cody@agent-spaces'
      const agentRoot = resolve(projectRoot, '..', 'var', 'agents', 'cody')
      try {
        return await runCodexRow(ctx, {
          real: true,
          codexPath: codex,
          aspHome,
          artifactDir,
          agentRoot,
          projectRoot,
          scopeRef,
        })
      } finally {
        if (!ctx.keepArtifacts) rmSync(aspHome, { recursive: true, force: true })
      }
    },
  },
  {
    name: 'real-claude-tmux',
    description: 'claude-code-tmux interactive-tmux against the REAL claude binary',
    probe: async () => {
      const claude = resolveClaudeBin()
      if (claude === undefined) {
        return { available: false, reason: 'claude binary not found (set ASP_CLAUDE_PATH)' }
      }
      if (!existsSync(resolveTmuxBin()) && resolveTmuxBin() === 'tmux') {
        return { available: false, reason: 'tmux not found' }
      }
      return { available: true, reason: `real claude at ${claude}` }
    },
    run: async (ctx) => {
      const aspHome = mkdtempSync(join(tmpdir(), 'asp-matrix-claude-tmux-'))
      const artifactDir = join(aspHome, 'matrix-claude-tmux-artifacts')
      const socketPath = join(tmpdir(), `matrix-claude-tmux-${process.pid}.sock`)
      const prompts = [
        `Run the Bash command: printf '${ctx.marker}' — then reply with exactly ${ctx.marker} and nothing else.`,
        `Reply with exactly the token ${ctx.marker}_T2 and nothing else.`,
      ]
      const result: RowResult = {
        name: 'real-claude-tmux',
        status: 'FAIL',
        marker: ctx.marker,
        prompt: prompts[0],
        observedTurnIds: [],
        compile: {},
        floorFailures: [],
        contractFailures: [],
        extraFailures: [],
        notes: {},
      }
      const { result: run, events } = await runInteractiveClaudeTmuxSession(
        {
          repoRoot: ctx.repoRoot,
          scopeRef: 'curly@agent-spaces',
          projectRoot: ctx.repoRoot,
          cwd: ctx.repoRoot,
          aspHome,
          artifactDir,
          socketPath,
          tmuxBin: ctx.tmuxBin,
          model: 'claude-sonnet-4-5',
          prompts,
          bootWaitMs: ctx.bootWaitMs,
          turnTimeoutMs: ctx.turnTimeoutMs,
          interTurnSettleMs: 3000,
          keepAlive: false,
          mockClaude: false,
          anthropicKeySource: 'inherit',
          permissionPolicy: allowPermissionPolicy(),
          identityNamespace: 'matrix_claude_tmux',
          invocationId: `inv_matrix_claude_${ctx.marker}`,
          initialInputId: `input_matrix_claude_${ctx.marker}`,
          idempotencyKey: `matrix-claude-tmux-${ctx.marker}`,
          appSessionKey: `matrix-claude-tmux-${ctx.marker}`,
          taskId: 'T-01667',
        },
        interactiveDeps()
      )

      // Locate the command turn by its UNIQUE marker in a matched Bash command
      // (robust to real-claude turn-id attribution) rather than blindly trusting
      // the broker-returned id of the first scripted turn.
      const commandTurnId =
        findTurnWithToolCommandMarker(events, ctx.marker) ??
        run.turns[0]?.turnId ??
        deriveCommandTurnId(events)
      result.commandTurnId = commandTurnId
      result.observedTurnIds = observedTurnIds(events)
      result.compile = {
        compileId: run.compile.compileId,
        planHash: run.compile.planHash,
        selectedProfileHash: run.compile.selectedProfileHash,
        startRequestHash: run.compile.startRequestHash,
      }
      result.notes['turns'] = run.turns.map((t) => ({
        index: t.index,
        turnId: t.turnId,
        terminalTurnObserved: t.terminalTurnObserved,
      }))
      result.notes['ledgerEventTypes'] = run.ledgerEventTypes
      result.notes['surface'] = run.surface ?? null

      // Contract bucket: the SIGNED assertInteractiveTmuxEvents ran verbatim per
      // turn inside the lib + the broker-start contract verification.
      result.contractFailures = run.assertionFailures.map((f) => ({
        code: f.code,
        message: f.message,
        path: f.path,
      }))
      if (!run.contractVerification.ok) {
        result.contractFailures.push({
          code: 'broker_start_contract_unverifiable',
          message: 'interactive broker-start contract verification failed',
        })
      }

      // Uniform floor on the command turn (claude surfaces no assistant text;
      // the marker is in the Bash tool command/output).
      result.floorFailures = runSharedFloor(
        events,
        ctx.marker,
        commandTurnId,
        ctx.allowLegacyPermissionEvent,
        CLAUDE_MARKER_SOURCES
      )
      result.notes['markerSatisfiedBy'] = markerSatisfiedBy(
        events,
        commandTurnId,
        ctx.marker,
        CLAUDE_MARKER_SOURCES
      )

      // Per-row extra: >=2 broker-applied turns (turn1=command, turn2=plain token).
      if (run.turns.length < 2) {
        result.extraFailures.push({
          code: 'claude_tmux_turn_count',
          message: `expected >=2 broker-applied turns, got ${run.turns.length}`,
        })
      }
      if (!run.turns.every((t) => t.terminalTurnObserved)) {
        result.extraFailures.push({
          code: 'claude_tmux_turn_terminal',
          message: 'not every scripted turn reached a terminal turn',
        })
      }

      if (!ctx.keepArtifacts) rmSync(aspHome, { recursive: true, force: true })

      const allFailed =
        result.floorFailures.length + result.contractFailures.length + result.extraFailures.length
      result.status = allFailed === 0 ? 'OK' : 'FAIL'
      return result
    },
  },
  {
    name: 'claude-tmux-ghostmux',
    description: 'claude-code-tmux + REAL ghostmux operator-attach (operator-typed turn)',
    probe: async () => {
      const claude = resolveClaudeBin()
      if (claude === undefined) {
        return { available: false, reason: 'claude binary not found (set ASP_CLAUDE_PATH)' }
      }
      const gmux = await ghostmuxAvailable('ghostmux')
      if (!gmux.available) return gmux
      return { available: true, reason: `${gmux.reason}; real claude at ${claude}` }
    },
    run: async (ctx) => {
      const aspHome = mkdtempSync(join(tmpdir(), 'asp-matrix-ghostmux-'))
      const artifactDir = join(aspHome, 'matrix-ghostmux-artifacts')
      const socketPath = join(tmpdir(), `matrix-ghostmux-${process.pid}.sock`)
      const ghostmuxBin = 'ghostmux'
      const enterDelayMs = 250
      const operatorPrompt = `Run the Bash command: printf '${ctx.marker}_OP' — then reply with exactly ${ctx.marker}_OP and nothing else.`
      const operatorMarker = `${ctx.marker}_OP`
      const prompts = [
        `Run the Bash command: printf '${ctx.marker}' — then reply with exactly ${ctx.marker} and nothing else.`,
        `Reply with exactly the token ${ctx.marker}_T2 and nothing else.`,
      ]

      const result: RowResult = {
        name: 'claude-tmux-ghostmux',
        status: 'FAIL',
        marker: ctx.marker,
        prompt: operatorPrompt,
        observedTurnIds: [],
        compile: {},
        floorFailures: [],
        contractFailures: [],
        extraFailures: [],
        notes: {},
      }

      let surfaceId: string | undefined
      let baselineSubmits = 0

      // Operator-attach seam: runs while the tmux session is live, AFTER the two
      // scripted broker turns, BEFORE the runner's clean teardown + signed
      // assertion across ALL turns (so the operator turn is held to the full bar).
      const afterTurns = async (live: {
        socketPath: string
        tmuxBin: string
        attachCommand: string
        surface?: { socketPath: string; sessionName: string; paneId: string } | undefined
        events: InvocationEventEnvelope[]
      }): Promise<void> => {
        baselineSubmits = live.events.filter(
          (e) => e.type === 'turn.started' && e.driver?.rawType === 'UserPromptSubmit'
        ).length
        result.notes['baselineSubmits'] = baselineSubmits

        const newOut = await ghostmux(ghostmuxBin, [
          'new',
          '--command',
          live.attachCommand,
          '--title',
          'matrix-ghostmux-attach',
          '--json',
        ])
        if (newOut.code !== 0) {
          result.extraFailures.push({
            code: 'ghostmux_new_failed',
            message: `ghostmux new failed: ${newOut.stderr.trim() || newOut.stdout.trim()}`,
          })
          return
        }
        surfaceId = (JSON.parse(newOut.stdout) as { id?: string }).id
        if (surfaceId === undefined) {
          result.extraFailures.push({
            code: 'ghostmux_surface_missing',
            message: `ghostmux new returned no surface id: ${newOut.stdout.trim()}`,
          })
          return
        }
        result.notes['surfaceId'] = surfaceId

        const promptVisible = await waitForClaudePrompt(ghostmuxBin, surfaceId, 30_000)
        if (!promptVisible) {
          result.extraFailures.push({
            code: 'attach_prompt_not_visible',
            message: 'Claude prompt (❯) did not render in the attached Ghostty pane within 30000ms',
          })
          return
        }

        await driveOperatorTurn(ghostmuxBin, surfaceId, operatorPrompt, enterDelayMs)

        // Wait for a NEW operator turn boundary (submit + stop) above the baseline.
        const recorded = await pollUntil(
          () => {
            const submits = live.events.filter(
              (e) => e.type === 'turn.started' && e.driver?.rawType === 'UserPromptSubmit'
            ).length
            const stops = live.events.filter(
              (e) => e.type === 'turn.completed' && e.driver?.rawType === 'Stop'
            ).length
            return submits > baselineSubmits && stops >= submits
          },
          ctx.turnTimeoutMs,
          1_500
        )
        if (!recorded) {
          result.extraFailures.push({
            code: 'operator_turn_not_recorded',
            message: 'operator keystrokes did not produce a new hook-originated turn',
          })
        }

        const pane = await capturePane(ghostmuxBin, surfaceId)
        const tokenRendered = pane.includes(operatorMarker)
        result.notes['tokenRenderedInPane'] = tokenRendered
        if (!tokenRendered) {
          result.extraFailures.push({
            code: 'operator_token_not_rendered',
            message: `Claude did not render the operator token ${operatorMarker} in the attached pane`,
          })
        }
      }

      try {
        const { result: run, events } = await runInteractiveClaudeTmuxSession(
          {
            repoRoot: ctx.repoRoot,
            scopeRef: 'curly@agent-spaces',
            projectRoot: ctx.repoRoot,
            cwd: ctx.repoRoot,
            aspHome,
            artifactDir,
            socketPath,
            tmuxBin: ctx.tmuxBin,
            model: 'claude-sonnet-4-5',
            prompts,
            bootWaitMs: ctx.bootWaitMs,
            turnTimeoutMs: ctx.turnTimeoutMs,
            interTurnSettleMs: 3000,
            keepAlive: false,
            mockClaude: false,
            anthropicKeySource: 'inherit',
            permissionPolicy: allowPermissionPolicy(),
            identityNamespace: 'matrix_ghostmux',
            invocationId: `inv_matrix_ghostmux_${ctx.marker}`,
            initialInputId: `input_matrix_ghostmux_${ctx.marker}`,
            idempotencyKey: `matrix-ghostmux-${ctx.marker}`,
            appSessionKey: `matrix-ghostmux-${ctx.marker}`,
            taskId: 'T-01667',
            afterTurns,
          },
          interactiveDeps()
        )

        result.observedTurnIds = observedTurnIds(events)
        result.compile = {
          compileId: run.compile.compileId,
          planHash: run.compile.planHash,
          selectedProfileHash: run.compile.selectedProfileHash,
          startRequestHash: run.compile.startRequestHash,
        }
        result.notes['ledgerEventTypes'] = run.ledgerEventTypes
        result.notes['scriptedTurns'] = run.turns.map((t) => ({
          turnId: t.turnId,
          terminalTurnObserved: t.terminalTurnObserved,
        }))
        const operatorSubmits = events.filter(
          (e) => e.type === 'turn.started' && e.driver?.rawType === 'UserPromptSubmit'
        ).length
        result.notes['operatorSubmits'] = operatorSubmits

        // Contract bucket: the SIGNED clean-exit assertion ran verbatim across ALL
        // observed turns (scripted + operator) inside the lib teardown path.
        result.contractFailures = run.assertionFailures.map((f) => ({
          code: f.code,
          message: f.message,
          path: f.path,
        }))
        if (!run.contractVerification.ok) {
          result.contractFailures.push({
            code: 'broker_start_contract_unverifiable',
            message: 'interactive broker-start contract verification failed',
          })
        }

        // For the ghostmux row the OPERATOR-typed turn IS the shared-floor command
        // turn: it is the headline of this row and the most reliable command turn
        // (driven only after claude is warm + attached + its prompt is visible,
        // then explicitly awaited for its Stop + token render). The scripted broker
        // turns are warmup/baseline only and are NOT gated here — under real-claude
        // load the first scripted send-key can race and never correlate; that is
        // covered by the signed per-turn assertion (which only runs on turns that
        // actually started) and is not a reason to fail the operator row. The
        // operator turn is located by its UNIQUE marker (robust to turn-id
        // attribution) and held to the FULL shared command floor; the SIGNED
        // clean-exit assertInteractiveTmuxEvents already ran across it verbatim.
        const operatorCommandTurnId = findTurnWithToolCommandMarker(events, operatorMarker)
        result.commandTurnId = operatorCommandTurnId
        result.notes['operatorCommandTurnId'] = operatorCommandTurnId ?? null
        if (operatorCommandTurnId === undefined) {
          result.floorFailures.push({
            code: 'operator_turn_missing',
            message: `no operator-typed turn carrying the operator marker ${operatorMarker} in a matched Bash tool command was recorded`,
          })
        } else {
          result.floorFailures = runSharedFloor(
            events,
            operatorMarker,
            operatorCommandTurnId,
            ctx.allowLegacyPermissionEvent,
            CLAUDE_MARKER_SOURCES
          )
          result.notes['markerSatisfiedBy'] = markerSatisfiedBy(
            events,
            operatorCommandTurnId,
            operatorMarker,
            CLAUDE_MARKER_SOURCES
          )
          // Operator extra: the operator turn must be BEYOND the scripted baseline
          // (a UserPromptSubmit appeared after afterTurns started) — proven by the
          // submit-count rise tracked in afterTurns + the token render check there.
          if (operatorSubmits <= baselineSubmits) {
            result.extraFailures.push({
              code: 'operator_turn_not_beyond_baseline',
              message: `operator submit count (${operatorSubmits}) did not exceed the scripted baseline (${baselineSubmits})`,
            })
          }
        }
      } finally {
        if (surfaceId !== undefined) {
          await ghostmux(ghostmuxBin, ['kill-surface', '-t', surfaceId]).catch(() => undefined)
        }
        if (!ctx.keepArtifacts) rmSync(aspHome, { recursive: true, force: true })
      }

      const allFailed =
        result.floorFailures.length + result.contractFailures.length + result.extraFailures.length
      result.status = allFailed === 0 ? 'OK' : 'FAIL'
      return result
    },
  },
]

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

type MatrixReport = {
  schemaVersion: 'pre-hrc-broker-matrix-e2e/v1'
  ok: boolean
  startedAt: string
  finishedAt: string
  rows: RowResult[]
}

function printRow(row: RowResult): void {
  const head = `[${row.status}] ${row.name} — ${row.marker}`
  if (row.status === 'SKIP') {
    console.log(`${head}\n    reason: ${row.reason ?? '(none)'}`)
    return
  }
  console.log(head)
  console.log(
    `    compile: compileId=${row.compile.compileId ?? '(none)'} planHash=${(row.compile.planHash ?? '').slice(0, 12)} profileHash=${(row.compile.selectedProfileHash ?? '').slice(0, 12)}`
  )
  console.log(
    `    commandTurnId: ${row.commandTurnId ?? '(none)'}  turns: ${row.observedTurnIds.length}`
  )
  for (const f of row.floorFailures) console.error(`    FLOOR    ${f.code}: ${f.message}`)
  for (const f of row.contractFailures) console.error(`    CONTRACT ${f.code}: ${f.message}`)
  for (const f of row.extraFailures) console.error(`    EXTRA    ${f.code}: ${f.message}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  const repoRoot = resolve(new URL('..', import.meta.url).pathname)
  const runId = Date.now().toString(36).toUpperCase()
  const configs = args.config
    ? HARNESS_CONFIGS.filter((c) => c.name === args.config)
    : HARNESS_CONFIGS

  const rows: RowResult[] = []
  const startedAt = new Date().toISOString()

  for (const config of configs) {
    const ctx: RowContext = {
      repoRoot,
      marker: `ASP_MATRIX_${config.name.replace(/-/g, '_').toUpperCase()}_${runId}`,
      allowLegacyPermissionEvent: args.allowLegacyPermissionEvent,
      keepArtifacts: args.keepArtifacts,
      bootWaitMs: args.bootWaitMs,
      turnTimeoutMs: args.turnTimeoutMs,
      tmuxBin: resolveTmuxBin(),
    }

    console.log(`\n=== row: ${config.name} (${config.description}) ===`)
    const probe = await config.probe(ctx).catch((e) => ({
      available: false,
      reason: e instanceof Error ? e.message : String(e),
    }))
    if (!probe.available) {
      const skipped: RowResult = {
        name: config.name,
        status: 'SKIP',
        reason: probe.reason,
        marker: ctx.marker,
        observedTurnIds: [],
        compile: {},
        floorFailures: [],
        contractFailures: [],
        extraFailures: [],
        notes: {},
      }
      rows.push(skipped)
      printRow(skipped)
      continue
    }

    try {
      const row = await config.run(ctx)
      rows.push(row)
      printRow(row)
    } catch (error) {
      const failed: RowResult = {
        name: config.name,
        status: 'FAIL',
        reason: error instanceof Error ? error.message : String(error),
        marker: ctx.marker,
        observedTurnIds: [],
        compile: {},
        floorFailures: [
          { code: 'row_threw', message: error instanceof Error ? error.message : String(error) },
        ],
        contractFailures: [],
        extraFailures: [],
        notes: {},
      }
      rows.push(failed)
      printRow(failed)
    }
  }

  const finishedAt = new Date().toISOString()
  // A row counts against the matrix only if it actually FAILED; SKIP is allowed.
  const ok = rows.every((r) => r.status !== 'FAIL')
  const report: MatrixReport = {
    schemaVersion: 'pre-hrc-broker-matrix-e2e/v1',
    ok,
    startedAt,
    finishedAt,
    rows,
  }

  const artifactDir = join(tmpdir(), 'asp-matrix-artifacts')
  mkdirSync(artifactDir, { recursive: true })
  const artifactPath = join(artifactDir, `matrix-${runId}.json`)
  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`)

  console.log('\n=== MATRIX SUMMARY ===')
  for (const row of rows) {
    const counts = `floor=${row.floorFailures.length} contract=${row.contractFailures.length} extra=${row.extraFailures.length}`
    console.log(
      `  ${row.status.padEnd(4)} ${row.name.padEnd(22)} ${row.status === 'SKIP' ? `skip: ${row.reason}` : counts}`
    )
  }
  console.log(`\nmatrix: ${ok ? 'OK' : 'FAILED'}  artifact: ${artifactPath}`)

  if (args.json) console.log(JSON.stringify(report, null, 2))
  if (!ok) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exit(2)
}
