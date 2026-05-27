#!/usr/bin/env bun
import { spawn } from 'node:child_process'
/**
 * Pre-HRC broker MATRIX e2e runner (T-01667, Lance directive 2026-05-26).
 *
 * ONE parameterized runner that iterates ALL implemented harness configurations,
 * drives the SAME canonical command turn through each, and validates the SAME
 * normalized broker event vocabulary fired — reusing existing coverage instead
 * of duplicating per-harness scripts.
 *
 * Rows (HARD-FAIL gate, Lance directive 2026-05-27): every row's real dependency
 * (binary + auth + tool) is probed up front. A MISSING dependency is a row FAILURE,
 * never a skip — the matrix only goes green on a host where all rows ran and passed.
 *   (a) fake-codex            codex-app-server headless, deterministic fixture (CI-safe)
 *   (b) real-codex            codex-app-server headless, REAL `codex`
 *   (c) real-claude-tmux      claude-code-tmux interactive-tmux, REAL `claude`
 *   (d) claude-tmux-ghostmux  claude-code-tmux + REAL ghostmux operator-attach
 *   (e) real-pi-sdk-embedded  in-process pi-sdk embedded executor, REAL pi auth
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
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type {
  InputId,
  InvocationEventEnvelope,
  InvocationId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  BrokerPermissionPolicy,
  EmbeddedSdkExecutionProfile,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY, project } from 'spaces-runtime-contracts'

import { executeEmbeddedSdkTurn } from '../packages/agent-spaces/src/execute-embedded-sdk.js'
import { createAgentSpacesClient } from '../packages/agent-spaces/src/index.js'
import { piSessionPath } from '../packages/agent-spaces/src/runtime-env.js'

import { createClaudeCodeTmuxDriver } from '../packages/harness-broker/src/drivers/claude-code-tmux/driver'
import { createCodexCliTmuxDriver } from '../packages/harness-broker/src/drivers/codex-cli-tmux/driver'
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
  verifyBrokerStartContract,
} from '../packages/agent-spaces/src/testing/pre-hrc-broker-helpers.js'
import {
  capturePane,
  driveOperatorTurn,
  ghostmux,
  ghostmuxAvailable,
  pollUntil,
  sleep,
  waitForClaudePrompt,
} from '../packages/agent-spaces/src/testing/pre-hrc-ghostmux-operator.js'
import type { InteractiveTmuxRunnerDeps } from '../packages/agent-spaces/src/testing/pre-hrc-interactive-tmux-runner.js'
import { runInteractiveClaudeTmuxSession } from '../packages/agent-spaces/src/testing/pre-hrc-interactive-tmux-runner.js'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type RowName =
  | 'fake-codex'
  | 'real-codex'
  | 'real-codex-tmux'
  | 'codex-tmux-ghostmux'
  | 'real-claude-tmux'
  | 'claude-tmux-ghostmux'
  | 'real-pi-sdk-embedded'
const ALL_ROWS: RowName[] = [
  'fake-codex',
  'real-codex',
  'real-codex-tmux',
  'codex-tmux-ghostmux',
  'real-claude-tmux',
  'claude-tmux-ghostmux',
  'real-pi-sdk-embedded',
]

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
// Hard-fail gate: a row either ran and passed (OK) or it did not (FAIL). A missing
// real dependency is a FAIL, never a skip (Lance directive 2026-05-27).
type RowStatus = 'OK' | 'FAIL'

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

/**
 * nvm installs codex per node version under ~/.nvm/versions/node/<v>/bin/codex.
 * The version dirs are not a fixed path, so enumerate them (newest first by string
 * sort, good enough — we just need any real install) rather than hardcoding a version.
 */
function nvmCodexCandidates(): string[] {
  const versionsDir = join(process.env['HOME'] ?? '', '.nvm/versions/node')
  if (!existsSync(versionsDir)) return []
  try {
    return readdirSync(versionsDir)
      .sort()
      .reverse()
      .map((v) => join(versionsDir, v, 'bin/codex'))
  } catch {
    return []
  }
}

function resolveRealCodexBin(): string | undefined {
  for (const candidate of [
    process.env['ASP_CODEX_PATH'], // explicit override wins
    join(process.env['HOME'] ?? '', '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
    // version-manager installs (headless agents rarely have these bin dirs on PATH):
    ...nvmCodexCandidates(),
    join(process.env['HOME'] ?? '', '.volta/bin/codex'),
    join(process.env['HOME'] ?? '', '.asdf/shims/codex'),
  ]) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  // Final fallback: PATH resolution for any other install location. Bun.which
  // resolves a real executable on PATH — NOT a shell alias — so an interactive
  // `alias codex=...` stays correctly excluded.
  const onPath = Bun.which('codex')
  if (onPath !== null && onPath.length > 0 && existsSync(onPath)) return onPath
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

/**
 * Concatenate the assistant transcript across the normalized event stream the way
 * the deleted real-codex smoke did: streamed assistant.message.delta chunks are
 * joined (so a marker split across deltas is whole), assistant.message.completed
 * text parts are appended, and turn.completed finalOutput (when present) is too.
 */
function assembleAssistantText(events: InvocationEventEnvelope[]): string {
  let deltaText = ''
  const parts: string[] = []
  for (const event of events) {
    const payload = asRecord(event.payload)
    if (event.type === 'assistant.message.delta' && typeof payload?.['text'] === 'string') {
      deltaText += payload['text']
    } else if (event.type === 'assistant.message.completed') {
      const content = Array.isArray(payload?.['content']) ? payload['content'] : []
      for (const part of content) {
        const record = asRecord(part)
        if (record?.['type'] === 'text' && typeof record['text'] === 'string') {
          parts.push(record['text'])
        }
      }
    } else if (event.type === 'turn.completed' && typeof payload?.['finalOutput'] === 'string') {
      parts.push(payload['finalOutput'])
    }
  }
  if (deltaText.length > 0) parts.push(deltaText)
  return parts.join('\n')
}

/** Outputs of every completed command/tool call (ported from the deleted smoke). */
function collectCommandOutputs(events: InvocationEventEnvelope[]): string[] {
  return events
    .filter((event) => event.type === 'tool.call.completed')
    .map((event) => {
      const result = asRecord(asRecord(event.payload)?.['result'])
      return String(result?.['output'] ?? '')
    })
    .filter((output) => output.length > 0)
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
  // Compiled-spec evidence: the sparky tool-bin is emitted as the FIRST typed
  // process.pathPrepend entry (sparky tool-bin contract case, not cody-specific).
  const expectedToolBin = join(resolve(agentRoot), 'tools', 'bin')
  if (pathPrepend.length === 0) {
    failures.push({ code: 'real_codex_path_prepend', message: 'process.pathPrepend was empty' })
  } else if (pathPrepend[0] !== expectedToolBin) {
    failures.push({
      code: 'real_codex_path_prepend',
      message: `expected pathPrepend[0] ${expectedToolBin}, got ${pathPrepend[0]}`,
    })
  }
  // Runtime-visibility evidence (cody re-sign Q2, faithful to the deleted smoke):
  // the compiled spec alone is not enough — prove the tool-bin was actually visible
  // on the SPAWNED process PATH and that `command -v sparky-spark` resolved through
  // it, by inspecting the executed command's tool output (the resolved
  // `<toolsbin>/sparky-spark` line carries the tool-bin path).
  const events = brokerEvents(result)
  const commandOutput = collectCommandOutputs(events).join('\n')
  const sparkySparkPath = join(expectedToolBin, 'sparky-spark')
  if (pathPrepend[0] !== undefined && !commandOutput.includes(pathPrepend[0])) {
    failures.push({
      code: 'real_codex_path_visible',
      message: `tool-bin ${pathPrepend[0]} was not visible in the spawned process PATH (command output)`,
    })
  }
  if (!commandOutput.includes(sparkySparkPath)) {
    failures.push({
      code: 'real_codex_sparky_spark',
      message: `command -v sparky-spark did not resolve to ${sparkySparkPath} in command output`,
    })
  }
  // assistant marker present in the reply. codex STREAMS the reply as many
  // assistant.message.delta chunks (e.g. "ASP","_MATRIX","_REAL",...), so the
  // full marker never lands in a single delta; it is whole only in the
  // CONCATENATED delta stream and in assistant.message.completed content (and
  // turn.completed carries no finalOutput here). Mirror the deleted smoke's full
  // assistant extraction — concat deltas + completed text parts + finalOutput —
  // rather than testing each event in isolation (the consolidation regression).
  const assistantText = assembleAssistantText(events)
  if (!assistantText.includes(marker)) {
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
  // The real-codex row is the sparky tool-bin CONTRACT case (not cody-specific):
  // it must prove the compiled `process.pathPrepend` tool-bin is actually visible
  // on the spawned process PATH and that `sparky-spark` resolves through it — so
  // the command echoes PATH_HEAD for diagnostics and runs `command -v sparky-spark`
  // to prove the tools bin is visible on the spawned PATH. (Codex executes through
  // `/bin/zsh -lc`, whose rc may re-prepend other dirs, so PATH_HEAD is NOT asserted
  // to equal pathPrepend[0]; the contract is visibility + resolution, not position.)
  // The fake row keeps the minimal marker prompt (its deterministic fixture has no
  // tools/bin and runs no PATH-visibility assertion).
  const prompt = options.real
    ? [
        'Run this exact Bash command and nothing else:',
        `printf 'PATH_HEAD=%s\\n' "\${PATH%%:*}"; command -v sparky-spark || true`,
        `Then reply with exactly ${ctx.marker} and nothing else.`,
      ].join('\n')
    : `Run \`printf '${ctx.marker}'\` then reply with exactly ${ctx.marker} and nothing else.`
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

function codexInteractiveCompileRequest(input: {
  scopeRef: string
  agentRoot?: string | undefined
  projectRoot: string
  cwd: string
  prompt: string
  marker: string
  timeoutMs: number
  model?: string | undefined
}): RuntimeCompileRequest {
  const identity = allocatePreHrcRuntimeIdentity({
    namespace: 'prehrc_matrix_codex_tmux',
    invocationId: `inv_matrix_codex_tmux_${input.marker}`,
    initialInputId: `input_matrix_codex_tmux_${input.marker}`,
    idempotencyKey: `pre-hrc-matrix-codex-tmux-${input.marker}`,
  })
  const placement = buildPlacementFromScopeRef({
    scopeRef: input.scopeRef,
    agentRoot: input.agentRoot,
    projectRoot: input.projectRoot,
    cwd: input.cwd,
    hostSessionId: identity.hostSessionId,
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
      interactionMode: 'interactive',
    },
    materialization: {
      initialPrompt: input.prompt,
      taskContext: {
        taskId: 'T-01673',
        phase: 'matrix',
        role: 'smoke',
        requiredEvidenceKinds: ['contract-artifacts'],
        hintsText: 'pre-HRC broker matrix codex-cli-tmux row',
      },
    },
    hrcPolicy: {
      permissionPolicy: allowPermissionPolicy(),
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
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
      appSessionKey: `pre-hrc-matrix-codex-tmux-${input.marker}`,
      scopeRef: input.scopeRef,
      laneRef: 'main',
    },
  }
}

type MatrixTmuxExecResult = { stdout: string; stderr: string }

function runMatrixTmux(
  tmuxBin: string,
  argv: string[],
  env: Record<string, string | undefined> = process.env
): Promise<MatrixTmuxExecResult> {
  return new Promise((resolvePromise, reject) => {
    const cleanEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) cleanEnv[key] = value
    }
    const proc = spawn(tmuxBin, argv, { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
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

function makeCodexHookListener(
  socketPath: string
): (
  handler: (envelope: unknown) => void | Promise<void>
) => Promise<{ socketPath: string; close: () => Promise<void> }> {
  return async (handler) => {
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
          server.close(() => resolvePromise())
        }),
    }
  }
}

function terminalTurnCount(events: InvocationEventEnvelope[]): number {
  return events.filter(
    (event) =>
      event.type === 'turn.completed' ||
      event.type === 'turn.failed' ||
      event.type === 'turn.interrupted'
  ).length
}

async function waitForAdditionalTerminalTurn(
  events: InvocationEventEnvelope[],
  baseline: number,
  timeoutMs: number
): Promise<boolean> {
  return pollUntil(() => terminalTurnCount(events) > baseline, timeoutMs, 1_500)
}

async function captureTmuxPane(
  tmuxBin: string,
  socketPath: string,
  paneId: string
): Promise<string> {
  const result = await runMatrixTmux(tmuxBin, [
    '-S',
    socketPath,
    'capture-pane',
    '-t',
    paneId,
    '-p',
    '-S',
    '-200',
  ])
  return result.stdout
}

async function waitForTmuxPaneReady(
  tmuxBin: string,
  socketPath: string,
  paneId: string,
  timeoutMs: number
): Promise<{ ready: boolean; pane: string; dismissedUpdatePrompt: boolean }> {
  let latest = ''
  let dismissedUpdatePrompt = false
  const ready = await pollUntil(
    async () => {
      latest = await captureTmuxPane(tmuxBin, socketPath, paneId).catch((error) =>
        error instanceof Error ? error.message : String(error)
      )
      if (
        !dismissedUpdatePrompt &&
        latest.includes('Update available') &&
        latest.includes('Skip until next version')
      ) {
        dismissedUpdatePrompt = true
        await runMatrixTmux(tmuxBin, ['-S', socketPath, 'send-keys', '-l', '-t', paneId, '3'])
        await runMatrixTmux(tmuxBin, ['-S', socketPath, 'send-keys', '-t', paneId, 'Enter'])
        return false
      }
      return latest.includes('OpenAI Codex') && latest.includes('Context') && latest.includes('›')
    },
    timeoutMs,
    1_000
  )
  return { ready, pane: latest, dismissedUpdatePrompt }
}

async function waitForCodexPaneReady(
  ghostmuxBin: string,
  surfaceId: string,
  timeoutMs: number
): Promise<boolean> {
  let previous = ''
  let stable = 0
  return pollUntil(
    async () => {
      const pane = await capturePane(ghostmuxBin, surfaceId)
      if (pane.length > 40 && pane === previous) stable += 1
      else stable = 0
      previous = pane
      return stable >= 2
    },
    timeoutMs,
    1_000
  )
}

async function runCodexTmuxRow(
  ctx: RowContext,
  options: { ghostmuxOperator: boolean }
): Promise<RowResult> {
  const codex = resolveRealCodexBin()
  if (codex === undefined) throw new Error('real codex binary disappeared after probe')

  const rowName: RowName = options.ghostmuxOperator ? 'codex-tmux-ghostmux' : 'real-codex-tmux'
  const operatorMarker = `${ctx.marker}_OP`
  const commandMarker = options.ghostmuxOperator ? operatorMarker : ctx.marker
  const prompts = [
    `Run the Bash command: printf '${ctx.marker}' — then reply with exactly ${ctx.marker} and nothing else.`,
    `Run the Bash command: printf '${ctx.marker}_T2' — then reply with exactly ${ctx.marker}_T2 and nothing else.`,
  ]
  const operatorPrompt = `Run the Bash command: printf '${operatorMarker}' — then reply with exactly ${operatorMarker} and nothing else.`
  const result: RowResult = {
    name: rowName,
    status: 'FAIL',
    marker: commandMarker,
    prompt: options.ghostmuxOperator ? operatorPrompt : prompts[0],
    observedTurnIds: [],
    compile: {},
    floorFailures: [],
    contractFailures: [],
    extraFailures: [],
    notes: {},
  }

  const savedCodexPath = process.env['ASP_CODEX_PATH']
  const savedSkip = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  process.env['ASP_CODEX_PATH'] = codex
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

  const aspHome = mkdtempSync(join(tmpdir(), `asp-matrix-${rowName}-`))
  const socketPath = join(tmpdir(), `matrix-${rowName}-${process.pid}.sock`)
  const hookSocketPath = `${socketPath}.hooks`
  const projectRoot = ctx.repoRoot
  const scopeRef = 'sparky@agent-spaces'
  const agentRoot = resolve(projectRoot, '..', 'var', 'agents', 'sparky')
  const events: InvocationEventEnvelope[] = []
  const ledger = new PreHrcBrokerEventLedger()
  const tmuxArgv: string[][] = []
  let surface: { socketPath: string; sessionName: string; paneId: string } | undefined
  let surfaceId: string | undefined

  try {
    ensureAspHomeRegistry(aspHome, projectRoot)
    const client = createAgentSpacesClient({ aspHome }) as ReturnType<
      typeof createAgentSpacesClient
    > & { compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse> }
    const response = await client.compileRuntimePlan(
      codexInteractiveCompileRequest({
        scopeRef,
        agentRoot,
        projectRoot,
        cwd: projectRoot,
        prompt: prompts[0],
        marker: ctx.marker,
        timeoutMs: ctx.turnTimeoutMs,
      })
    )
    if (!response.ok) {
      result.contractFailures.push({
        code: 'codex_tmux_compile_failed',
        message: `compileRuntimePlan returned diagnostics: ${JSON.stringify(response.diagnostics)}`,
      })
      return result
    }

    const profile = response.plan.executionProfiles.find(
      (candidate): candidate is BrokerExecutionProfile =>
        candidate.kind === 'harness-broker' && candidate.brokerDriver === 'codex-cli-tmux'
    )
    if (profile === undefined) {
      result.contractFailures.push({
        code: 'codex_tmux_profile_missing',
        message: 'compileRuntimePlan did not emit codex-cli-tmux broker profile',
      })
      return result
    }

    const verification = verifyBrokerStartContract(profile)
    result.contractFailures.push(...verification.failures.map(toFailure))
    result.compile = {
      compileId: response.plan.compileId,
      planHash: response.plan.planHash,
      selectedProfileHash: profile.profileHash,
      startRequestHash: profile.harnessInvocation.startRequestHash,
    }
    result.notes['brokerDriver'] = profile.brokerDriver

    await runMatrixTmux(ctx.tmuxBin, ['-S', socketPath, 'start-server'])
    const bridgeCommand = `bun ${join(ctx.repoRoot, 'packages/harness-broker/bin/harness-broker.js')} codex-hook`
    const driver = createCodexCliTmuxDriver({
      tmux: {
        socketPath,
        tmuxBin: ctx.tmuxBin,
        exec: async (argv, execOptions) => {
          tmuxArgv.push([...argv])
          return runMatrixTmux(ctx.tmuxBin, argv.slice(1), execOptions?.env ?? process.env)
        },
      },
      hooks: {
        listen: makeCodexHookListener(hookSocketPath),
        bridgeCommand,
      },
    })
    const manager = createInvocationManager({
      sequencer: createInvocationEventSequencer({ now: () => new Date() }),
      onEvent: (event) => {
        events.push(event)
        ledger.append(event)
      },
    })

    const spec = profile.harnessInvocation.startRequest.spec
    const invocationId = (spec.invocationId ??
      `inv_matrix_codex_tmux_${ctx.marker}`) as InvocationId
    await manager.start(spec, driver, undefined, undefined, { tmux: { socketPath } })

    const surfaceEvent = events.find((event) => event.type === 'terminal.surface.reported')
    const sp = surfaceEvent?.payload as
      | { socketPath?: string; sessionName?: string; paneId?: string }
      | undefined
    if (
      sp !== undefined &&
      typeof sp.socketPath === 'string' &&
      typeof sp.sessionName === 'string' &&
      typeof sp.paneId === 'string'
    ) {
      surface = { socketPath: sp.socketPath, sessionName: sp.sessionName, paneId: sp.paneId }
      result.notes['surface'] = surface
    }

    if (ctx.bootWaitMs > 0) await sleep(ctx.bootWaitMs)
    if (surface !== undefined) {
      const paneReady = await waitForTmuxPaneReady(
        ctx.tmuxBin,
        surface.socketPath,
        surface.paneId,
        60_000
      )
      result.notes['preTurnPane'] = paneReady.pane
      if (paneReady.dismissedUpdatePrompt) {
        result.notes['codexUpdatePromptDismissed'] = true
      }
      if (!paneReady.ready) {
        result.extraFailures.push({
          code: 'codex_tmux_pane_not_ready',
          message: 'Codex tmux pane did not become stable before scripted turns',
        })
      }
    }

    const scriptedTurns: Array<{ prompt: string; terminalTurnObserved: boolean }> = []
    for (const prompt of prompts) {
      const baseline = terminalTurnCount(events)
      await manager.input({
        invocationId,
        input: { kind: 'user', content: [{ type: 'text', text: prompt }] },
        policy: { whenBusy: 'reject' },
      })
      const terminalTurnObserved = await waitForAdditionalTerminalTurn(
        events,
        baseline,
        ctx.turnTimeoutMs
      )
      scriptedTurns.push({ prompt, terminalTurnObserved })
      await sleep(2_000)
    }
    result.notes['scriptedTurns'] = scriptedTurns

    if (options.ghostmuxOperator) {
      const ghostmuxBin = 'ghostmux'
      const attachCommand =
        surface !== undefined
          ? `${ctx.tmuxBin} -S ${surface.socketPath} attach-session -t ${surface.sessionName}`
          : `${ctx.tmuxBin} -S ${socketPath} attach-session`
      const newOut = await ghostmux(ghostmuxBin, [
        'new',
        '--command',
        attachCommand,
        '--title',
        'matrix-codex-ghostmux-attach',
        '--json',
      ])
      if (newOut.code !== 0) {
        result.extraFailures.push({
          code: 'ghostmux_new_failed',
          message: `ghostmux new failed: ${newOut.stderr.trim() || newOut.stdout.trim()}`,
        })
      } else {
        surfaceId = (JSON.parse(newOut.stdout) as { id?: string }).id
        result.notes['surfaceId'] = surfaceId ?? null
        if (surfaceId === undefined) {
          result.extraFailures.push({
            code: 'ghostmux_surface_missing',
            message: `ghostmux new returned no surface id: ${newOut.stdout.trim()}`,
          })
        } else {
          const ready = await waitForCodexPaneReady('ghostmux', surfaceId, 30_000)
          if (!ready) {
            result.extraFailures.push({
              code: 'attach_prompt_not_visible',
              message:
                'Codex pane did not become stable in the attached Ghostty pane within 30000ms',
            })
          } else {
            const baseline = terminalTurnCount(events)
            await driveOperatorTurn('ghostmux', surfaceId, operatorPrompt, 250)
            const recorded = await waitForAdditionalTerminalTurn(
              events,
              baseline,
              ctx.turnTimeoutMs
            )
            if (!recorded) {
              result.extraFailures.push({
                code: 'operator_turn_not_recorded',
                message: 'operator keystrokes did not produce a new hook-originated Codex turn',
              })
            }
            const pane = await capturePane('ghostmux', surfaceId)
            result.notes['tokenRenderedInPane'] = pane.includes(operatorMarker)
            if (!pane.includes(operatorMarker)) {
              result.extraFailures.push({
                code: 'operator_token_not_rendered',
                message: `Codex did not render the operator token ${operatorMarker} in the attached pane`,
              })
            }
          }
        }
      }
    }

    result.observedTurnIds = observedTurnIds(events)
    result.notes['ledgerEventTypes'] = [...new Set(events.map((event) => event.type))]
    result.notes['tmuxArgv'] = tmuxArgv
    result.notes['eventCount'] = events.length
    if (surface !== undefined) {
      result.notes['postTurnPane'] = await captureTmuxPane(
        ctx.tmuxBin,
        surface.socketPath,
        surface.paneId
      ).catch((error) => (error instanceof Error ? error.message : String(error)))
    }

    const commandTurnId =
      findTurnWithToolCommandMarker(events, commandMarker) ?? deriveCommandTurnId(events)
    result.commandTurnId = commandTurnId
    result.floorFailures = runSharedFloor(
      events,
      commandMarker,
      commandTurnId,
      ctx.allowLegacyPermissionEvent,
      CLAUDE_MARKER_SOURCES
    )
    result.notes['markerSatisfiedBy'] = markerSatisfiedBy(
      events,
      commandTurnId,
      commandMarker,
      CLAUDE_MARKER_SOURCES
    )

    result.extraFailures.push(...assertCodexContinuation(events))
    if (observedTurnIds(events).length < 2) {
      result.extraFailures.push({
        code: 'codex_tmux_turn_count',
        message: `expected >=2 hook-originated turns, got ${observedTurnIds(events).length}`,
      })
    }
    for (const required of [
      'assistant.message.completed',
      'turn.completed',
      'tool.call.started',
      'tool.call.completed',
      'continuation.updated',
    ] as const) {
      if (!events.some((event) => event.type === required)) {
        result.extraFailures.push({
          code: 'codex_tmux_event_missing',
          message: `codex-cli-tmux row did not emit ${required}`,
        })
      }
    }
    if (!scriptedTurns.every((turn) => turn.terminalTurnObserved)) {
      result.extraFailures.push({
        code: 'codex_tmux_turn_terminal',
        message: 'not every scripted Codex turn reached a terminal turn',
      })
    }

    await manager.stop({ invocationId, reason: 'matrix complete' })
    await manager.dispose({ invocationId })
  } finally {
    if (surfaceId !== undefined) {
      await ghostmux('ghostmux', ['kill-surface', '-t', surfaceId]).catch(() => undefined)
    }
    await runMatrixTmux(ctx.tmuxBin, ['-S', socketPath, 'kill-server']).catch(() => undefined)
    if (!ctx.keepArtifacts) rmSync(aspHome, { recursive: true, force: true })
    process.env['ASP_CODEX_PATH'] = savedCodexPath
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = savedSkip
  }

  const allFailed =
    result.floorFailures.length + result.contractFailures.length + result.extraFailures.length
  result.status = allFailed === 0 ? 'OK' : 'FAIL'
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
// Real pi-sdk embedded-sdk row (in-process executor; NOT the broker harness)
// ---------------------------------------------------------------------------

// pi-sdk surfaces the marker via the Bash tool command + output (and the
// assistant reply); reuse the harness-agnostic shared floor with all three
// marker sources, like the claude rows.
const EMBEDDED_MARKER_SOURCES: readonly SharedCommandTurnMarkerSource[] = [
  'tool-output',
  'tool-command',
  'assistant',
]

function createPiSdkFixture(): {
  agentRoot: string
  projectRoot: string
  aspHome: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-matrix-pi-embedded-'))
  const agentRoot = join(base, 'agents', 'curly')
  const projectRoot = join(base, 'project')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    'schemaVersion = 2\n\n[spaces]\nbase = []\n\n[brain]\nenabled = false\n',
    'utf8'
  )
  // pi-sdk frontend may probe a codex binary; provide a harmless version shim.
  const codex = join(aspHome, 'codex')
  writeFileSync(codex, '#!/usr/bin/env bash\necho "codex 999.0.0"\n', 'utf8')
  chmodSync(codex, 0o755)
  return {
    agentRoot,
    projectRoot,
    aspHome,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function embeddedCompileRequest(input: {
  agentRoot: string
  projectRoot: string
  hostSessionId: string
  prompt: string
  marker: string
  timeoutMs: number
}): RuntimeCompileRequest {
  const ids = {
    requestId: `request_pi_${input.marker}`,
    operationId: `op_pi_${input.marker}`,
    hostSessionId: input.hostSessionId,
    generation: 1 as const,
    runtimeId: `runtime_pi_${input.marker}`,
    runId: `run_pi_${input.marker}`,
    invocationId: `inv_pi_${input.marker}` as InvocationId,
    traceId: `trace_pi_${input.marker}`,
  }
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity: {
      ...ids,
      initialInputId: `input_pi_${input.marker}` as InputId,
      idempotencyKey: `pre-hrc-matrix-pi-${input.marker}`,
    },
    placement: {
      agentRoot: input.agentRoot,
      projectRoot: input.projectRoot,
      cwd: input.projectRoot,
      runMode: 'task',
      bundle: { kind: 'agent-project', agentName: 'curly', projectRoot: input.projectRoot },
      correlation: {
        sessionRef: {
          scopeRef: 'agent:curly:project:agent-spaces:task:T-01669',
          laneRef: 'main',
        },
        hostSessionId: input.hostSessionId,
      },
    } as RuntimeCompileRequest['placement'],
    requested: {
      modelProvider: 'openai',
      model: 'openai-codex/gpt-5.5',
      reasoningEffort: 'low',
      harnessFamily: 'pi',
      preferredHarnessRuntime: 'pi-sdk',
      interactionMode: 'nonInteractive',
    },
    materialization: {
      initialPrompt: input.prompt,
      taskContext: {
        taskId: 'T-01669',
        phase: 'matrix',
        role: 'smoke',
        requiredEvidenceKinds: ['contract-artifacts'],
        hintsText: 'pre-HRC matrix pi-sdk embedded row',
      },
    },
    hrcPolicy: {
      resourceLimits: { startupTimeoutMs: input.timeoutMs, turnTimeoutMs: input.timeoutMs },
      observability: { traceId: ids.traceId },
    },
    correlation: {
      ...ids,
      appId: 'agent-spaces',
      appSessionKey: `pre-hrc-matrix-pi-${input.marker}`,
      scopeRef: 'agent:curly:project:agent-spaces:task:T-01669',
      laneRef: 'main',
    },
  } as RuntimeCompileRequest
}

/** Embedded-specific extras: profile shape + producedContent + continuation. */
function assertEmbeddedExtras(
  profile: EmbeddedSdkExecutionProfile,
  result: Awaited<ReturnType<typeof executeEmbeddedSdkTurn>>,
  commandTurnId: string | undefined,
  events: InvocationEventEnvelope[]
): Failure[] {
  const failures: Failure[] = []
  const fields = profile as unknown as Record<string, unknown>
  if (profile.kind !== 'embedded-sdk')
    failures.push({
      code: 'pi_profile_kind',
      message: `expected embedded-sdk, got ${profile.kind}`,
    })
  if (profile.interactionMode !== 'nonInteractive')
    failures.push({
      code: 'pi_profile_mode',
      message: `expected nonInteractive, got ${profile.interactionMode}`,
    })
  if (profile.sdk?.runtime !== 'pi-sdk')
    failures.push({
      code: 'pi_profile_runtime',
      message: `expected pi-sdk, got ${String(profile.sdk?.runtime)}`,
    })
  if (profile.session?.provider !== 'openai')
    failures.push({
      code: 'pi_profile_provider',
      message: `expected openai, got ${String(profile.session?.provider)}`,
    })
  for (const forbidden of [
    'brokerProtocol',
    'brokerDriver',
    'brokerTerminal',
    'process',
    'transport',
    'terminal',
  ] as const) {
    if (forbidden in fields)
      failures.push({
        code: 'pi_profile_forbidden_field',
        message: `embedded profile must not declare ${forbidden}`,
      })
  }
  const commandTurnCompleted = events.find(
    (e) => e.type === 'turn.completed' && e.turnId === commandTurnId
  )
  const producedContent = (commandTurnCompleted?.payload as { producedContent?: boolean })
    ?.producedContent
  if (producedContent !== true)
    failures.push({
      code: 'pi_command_turn_no_content',
      message: `command turn producedContent !== true (${String(producedContent)})`,
    })
  const continuation = events.find((e) => e.type === 'continuation.updated')
  const cpayload = continuation?.payload as { kind?: string; key?: string } | undefined
  if (continuation === undefined)
    failures.push({
      code: 'pi_continuation_missing',
      message: 'no continuation.updated event emitted',
    })
  else if (cpayload?.kind !== 'session')
    failures.push({
      code: 'pi_continuation_kind',
      message: `continuation kind !== session (${String(cpayload?.kind)})`,
    })
  if (typeof result.sessionKey !== 'string' || result.sessionKey.length === 0)
    failures.push({
      code: 'pi_session_key_missing',
      message: 'result.sessionKey is empty on the real path',
    })
  return failures
}

async function runEmbeddedPiSdkRow(ctx: RowContext): Promise<RowResult> {
  const prompt = [
    'Run this exact Bash command and nothing else:',
    `printf '${ctx.marker}\\n'`,
    `Then reply with exactly ${ctx.marker} and nothing else.`,
  ].join('\n')
  const result: RowResult = {
    name: 'real-pi-sdk-embedded',
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
  const fx = createPiSdkFixture()
  const hostSessionId = `host_pi_${ctx.marker}`
  try {
    const client = createAgentSpacesClient({ aspHome: fx.aspHome }) as ReturnType<
      typeof createAgentSpacesClient
    > & { compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse> }
    const response = await client.compileRuntimePlan(
      embeddedCompileRequest({
        agentRoot: fx.agentRoot,
        projectRoot: fx.projectRoot,
        hostSessionId,
        prompt,
        marker: ctx.marker,
        timeoutMs: ctx.turnTimeoutMs,
      })
    )
    if (!response.ok) {
      result.contractFailures.push({
        code: 'pi_compile_failed',
        message: `compileRuntimePlan returned diagnostics: ${JSON.stringify(response.diagnostics)}`,
      })
      return result
    }
    const profile = response.plan.executionProfiles[0] as EmbeddedSdkExecutionProfile
    const bundleRoot = response.plan.artifacts.materializedBundleRoot as string
    result.compile = {
      compileId: response.plan.compileId,
      planHash: response.plan.planHash,
      selectedProfileHash: profile.profileHash,
    }
    // pi-sdk continuation IS the SessionManager session-file path; the CALLER
    // derives it via the legacy piSessionPath shape and passes it explicitly.
    const sessionPath = piSessionPath(fx.aspHome, hostSessionId)
    mkdirSync(sessionPath, { recursive: true })

    const events: InvocationEventEnvelope[] = []
    const turnResult = await executeEmbeddedSdkTurn({
      profile,
      prompt,
      invocationId: `inv_pi_${ctx.marker}` as InvocationId,
      inputId: `input_pi_${ctx.marker}` as InputId,
      turnId: `turn_pi_${ctx.marker}` as TurnId,
      runId: `run_pi_${ctx.marker}`,
      bundleRoot,
      sessionPath,
      dispatchEnv: { AGENT_HOST_SESSION_ID: hostSessionId },
      onEvent: (event) => events.push(event),
    })

    const commandTurnId = deriveCommandTurnId(events)
    result.commandTurnId = commandTurnId
    result.observedTurnIds = observedTurnIds(events)
    result.notes['eventCount'] = events.length
    result.notes['finalOutput'] = turnResult.finalOutput ?? null
    result.notes['sessionKey'] = turnResult.sessionKey ?? null
    result.notes['producedContent'] = turnResult.producedContent

    if (!turnResult.success) {
      result.contractFailures.push({
        code: 'pi_turn_failed',
        message: `executeEmbeddedSdkTurn failed: ${JSON.stringify(turnResult.error)}`,
      })
    }

    result.floorFailures = runSharedFloor(
      events,
      ctx.marker,
      commandTurnId,
      ctx.allowLegacyPermissionEvent,
      EMBEDDED_MARKER_SOURCES
    )
    result.notes['markerSatisfiedBy'] = markerSatisfiedBy(
      events,
      commandTurnId,
      ctx.marker,
      EMBEDDED_MARKER_SOURCES
    )
    result.extraFailures.push(...assertEmbeddedExtras(profile, turnResult, commandTurnId, events))
  } finally {
    if (!ctx.keepArtifacts) fx.cleanup()
  }

  const allFailed =
    result.floorFailures.length + result.contractFailures.length + result.extraFailures.length
  result.status = allFailed === 0 ? 'OK' : 'FAIL'
  return result
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
      // sparky is the canonical tool-bin smoke agent (var/agents/sparky/tools/bin/
      // sparky-spark): the deleted real-codex smoke ran against it precisely so the
      // compiler emits a real tool-bin pathPrepend that assertRealCodexEnvEvidence
      // can verify. cody@agent-spaces has NO tools/bin, so pointing the row there
      // (matrix-setup divergence from the smoke) left pathPrepend legitimately empty.
      const scopeRef = 'sparky@agent-spaces'
      const agentRoot = resolve(projectRoot, '..', 'var', 'agents', 'sparky')
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
    name: 'real-codex-tmux',
    description: 'codex-cli-tmux interactive-tmux against the REAL codex binary',
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
      if (!existsSync(resolveTmuxBin()) && resolveTmuxBin() === 'tmux') {
        return { available: false, reason: 'tmux not found' }
      }
      return { available: true, reason: `real codex at ${codex}` }
    },
    run: async (ctx) => runCodexTmuxRow(ctx, { ghostmuxOperator: false }),
  },
  {
    name: 'codex-tmux-ghostmux',
    description: 'codex-cli-tmux + REAL ghostmux operator-attach (operator-typed turn)',
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
      const gmux = await ghostmuxAvailable('ghostmux')
      if (!gmux.available) return gmux
      return { available: true, reason: `${gmux.reason}; real codex at ${codex}` }
    },
    run: async (ctx) => runCodexTmuxRow(ctx, { ghostmuxOperator: true }),
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
  {
    name: 'real-pi-sdk-embedded',
    description: 'pi-sdk embedded-sdk in-process executor against the REAL pi-sdk path',
    probe: async () => {
      const authPath = join(process.env['HOME'] ?? '', '.pi', 'agent', 'auth.json')
      if (!existsSync(authPath)) {
        return { available: false, reason: `pi auth (${authPath}) not present` }
      }
      return { available: true, reason: `pi auth at ${authPath}` }
    },
    run: async (ctx) => runEmbeddedPiSdkRow(ctx),
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
      // Missing real dependency = hard FAIL, never a skip. The matrix may only go
      // green on a host where every row's binary/auth/tool is present and reachable.
      const failed: RowResult = {
        name: config.name,
        status: 'FAIL',
        reason: probe.reason,
        marker: ctx.marker,
        observedTurnIds: [],
        compile: {},
        floorFailures: [{ code: 'dependency_missing', message: probe.reason }],
        contractFailures: [],
        extraFailures: [],
        notes: {},
      }
      rows.push(failed)
      printRow(failed)
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
  // Hard-fail gate: every row must have run AND passed. No skips allowed.
  const ok = rows.every((r) => r.status === 'OK')
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
    console.log(`  ${row.status.padEnd(4)} ${row.name.padEnd(22)} ${counts}`)
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
