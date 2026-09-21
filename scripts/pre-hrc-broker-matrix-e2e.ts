#!/usr/bin/env bun

/**
 * The pre-HRC broker matrix exercises the real public v2 compile contract.
 * It deliberately reaches the broker only through the one execution dispatch
 * request returned by `plan.execution`; no caller selects a profile or driver.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectAgentLocalComponents,
  harnessRegistry,
  planPlacementRuntime,
  prepareAgentToolRuntime,
  prepareCodexRuntimeHome,
} from 'spaces-execution'
import { BrokerClient } from 'spaces-harness-broker-client'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'
import type {
  HarnessId,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'

import { AspcClient } from '../harness/aspc/src/client.js'

export const MATRIX_ROW_NAMES = [
  'fake-codex',
  'unix-jsonrpc-ndjson',
  'real-codex',
  'codex-tui',
  'real-claude-tmux',
  'real-muse-serve',
  'muse-tmux',
] as const
export type RowName = (typeof MATRIX_ROW_NAMES)[number]

export const BROKER_MANAGED_MATRIX_ROWS = MATRIX_ROW_NAMES
export const SPARKY_CODEX_MATRIX_ROWS = [
  'fake-codex',
  'unix-jsonrpc-ndjson',
  'real-codex',
  'codex-tui',
] as const

type CompileTransport = 'sdk' | 'aspc-rpc'
type RowResult = {
  name: RowName
  status: 'OK' | 'FAIL'
  marker: string
  compile: {
    compileId?: string | undefined
    planHash?: string | undefined
    profileHash?: string | undefined
    startRequestHash?: string | undefined
  }
  events: number
  failures: Array<{ code: string; message: string }>
}

type MatrixReport = {
  schemaVersion: 'pre-hrc-broker-matrix-e2e/v2'
  results: RowResult[]
  ok: boolean
}

type CliArgs = {
  config?: RowName | undefined
  compileTransport: CompileTransport
  json: boolean
  timeoutMs: number
  help: boolean
}

const compilerRuntimeDependencies = {
  getHarnessAdapter: (harnessId: string) => harnessRegistry.getOrThrow(harnessId),
  detectAgentLocalComponents,
  planPlacementRuntime,
  prepareCodexRuntimeHome,
  prepareAgentToolRuntime,
}

function usage(): void {
  console.log(
    `Usage: bun scripts/pre-hrc-broker-matrix-e2e.ts [--config ${MATRIX_ROW_NAMES.join('|')}] [--compile-transport sdk|aspc-rpc] [--timeout-ms n] [--json]`
  )
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { compileTransport: 'sdk', json: false, timeoutMs: 120_000, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
      continue
    }
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg === '--config') {
      const value = argv[++index]
      if (value === undefined || !MATRIX_ROW_NAMES.includes(value as RowName)) {
        throw new Error(`--config must name one of: ${MATRIX_ROW_NAMES.join(', ')}`)
      }
      parsed.config = value as RowName
      continue
    }
    if (arg === '--compile-transport') {
      const value = argv[++index]
      if (value !== 'sdk' && value !== 'aspc-rpc') {
        throw new Error('--compile-transport must be sdk or aspc-rpc')
      }
      parsed.compileTransport = value
      continue
    }
    if (arg === '--timeout-ms') {
      const value = Number(argv[++index])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error('--timeout-ms must be positive')
      parsed.timeoutMs = value
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return parsed
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8')
  chmodSync(path, 0o755)
}

function createFixture(row: RowName): {
  root: string
  agentRoot: string
  projectRoot: string
  aspHome: string
  cleanup: () => void
} {
  const root = mkdtempSync(join(tmpdir(), `asp-prehrc-${row}-`))
  const agentRoot = join(root, 'agents', 'sparky')
  const projectRoot = join(root, 'project')
  const aspHome = join(root, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    'version = 4\n\n[spaces]\nbase = []\n',
    'utf8'
  )

  const fakeCodex = new URL(
    '../harness/harness-broker/test/fixtures/fake-codex/command-turn-marker.ts',
    import.meta.url
  ).pathname
  writeExecutable(
    join(aspHome, 'codex'),
    `#!/usr/bin/env bash\nif [[ "$1" == "--version" ]]; then echo "codex 999.0.0"; exit 0; fi\nif [[ "$1" == "app-server" && "$2" == "--help" ]]; then echo "app-server"; exit 0; fi\nif [[ "$1" == "app-server" ]]; then exec bun ${JSON.stringify(fakeCodex)}; fi\necho "codex shim"\n`
  )
  writeExecutable(
    join(aspHome, 'claude'),
    '#!/usr/bin/env bash\nif [[ "$1" == "--version" ]]; then echo "claude 1.0.0"; exit 0; fi\necho "claude shim"\n'
  )
  writeExecutable(
    join(aspHome, 'muse'),
    '#!/usr/bin/env bash\nif [[ "$1" == "--version" ]]; then echo "Muse Code 1.3.0"; exit 0; fi\necho "muse shim"\n'
  )
  return {
    root,
    agentRoot,
    projectRoot,
    aspHome,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function realExecutable(name: 'codex' | 'claude' | 'muse'): string | undefined {
  const explicit = process.env[`ASP_${name.toUpperCase()}_PATH`]
  if (explicit !== undefined && explicit.length > 0) return explicit
  const found = Bun.which(name)
  return found === null ? undefined : found
}

function rowSelection(row: RowName): {
  harness: HarnessId
  modelProvider: string
  model: string
  presentation: boolean
} {
  switch (row) {
    case 'fake-codex':
    case 'unix-jsonrpc-ndjson':
    case 'real-codex':
      return {
        harness: 'codex',
        modelProvider: 'openai-codex',
        model: 'gpt-5.6-terra',
        presentation: false,
      }
    case 'codex-tui':
      return {
        harness: 'codex',
        modelProvider: 'openai-codex',
        model: 'gpt-5.6-terra',
        presentation: true,
      }
    case 'real-claude-tmux':
      return {
        harness: 'claude',
        modelProvider: 'anthropic',
        model: 'claude-sonnet-4-5',
        presentation: true,
      }
    case 'real-muse-serve':
      return {
        harness: 'muse',
        modelProvider: 'meta',
        model: 'muse-spark-1.3-contributor',
        presentation: false,
      }
    case 'muse-tmux':
      return {
        harness: 'muse',
        modelProvider: 'meta',
        model: 'muse-spark-1.3-contributor',
        presentation: true,
      }
  }
}

function identity(row: RowName, marker: string): RuntimeCompileRequest['identity'] {
  const suffix = `${row.replaceAll('-', '_')}_${marker}`
  return {
    requestId: `request_${suffix}`,
    operationId: `operation_${suffix}`,
    hostSessionId: `host_${suffix}`,
    generation: 1,
    runtimeId: `runtime_${suffix}`,
    invocationId: `inv_${suffix}`,
    initialInputId: `input_${suffix}`,
    runId: `run_${suffix}`,
    traceId: `trace_${suffix}`,
    idempotencyKey: `prehrc-matrix-${suffix}`,
  } as RuntimeCompileRequest['identity']
}

function createRequest(
  row: RowName,
  fixture: ReturnType<typeof createFixture>,
  marker: string
): RuntimeCompileRequest {
  const allocated = identity(row, marker)
  const selection = rowSelection(row)
  return {
    schemaVersion: 'agent-runtime-compile-request/v2',
    agent: { id: 'sparky' },
    identity: allocated,
    placement: {
      agentRoot: fixture.agentRoot,
      projectRoot: fixture.projectRoot,
      cwd: fixture.projectRoot,
      runMode: 'task',
      bundle: { kind: 'agent-project', agentName: 'sparky', projectRoot: fixture.projectRoot },
      correlation: {
        sessionRef: { scopeRef: 'sparky@agent-spaces', laneRef: 'main' },
        hostSessionId: allocated.hostSessionId,
      },
    } as RuntimeCompileRequest['placement'],
    requested: { ...selection, reasoningEffort: 'medium' },
    materialization: {
      initialPrompt: `Run the Bash command: printf '${marker}' then reply with exactly ${marker}.`,
      taskContext: {
        taskId: 'T-08704',
        phase: 'pre-hrc-matrix',
        role: 'smoke',
        requiredEvidenceKinds: ['contract-artifacts'],
      },
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 30_000, turnTimeoutMs: 120_000 },
      observability: { traceId: allocated.traceId },
      capabilityPolicy: { allowDegrade: false, requireBrokerDefaultForCodexHeadless: true },
    },
    correlation: {
      requestId: allocated.requestId,
      operationId: allocated.operationId,
      hostSessionId: allocated.hostSessionId,
      generation: allocated.generation,
      runtimeId: allocated.runtimeId,
      runId: allocated.runId,
      invocationId: allocated.invocationId,
      traceId: allocated.traceId,
      appId: 'agent-spaces',
      appSessionKey: `prehrc-matrix-${row}`,
      scopeRef: 'sparky@agent-spaces',
      laneRef: 'main',
    },
  }
}

async function compileForMatrix(
  transport: CompileTransport,
  fixture: ReturnType<typeof createFixture>,
  request: RuntimeCompileRequest
): Promise<RuntimeCompileResponse> {
  if (transport === 'sdk') {
    const { createAgentSpacesClient } = await import('../compiler/agent-spaces/src/index.js')
    return createAgentSpacesClient({
      aspHome: fixture.aspHome,
      runtime: compilerRuntimeDependencies,
    }).compileRuntimePlan(request)
  }
  const facade = await AspcClient.start({
    command: process.execPath,
    args: ['harness/aspc-facade/bin/aspc-facade.js', 'run', '--transport', 'stdio'],
    cwd: new URL('..', import.meta.url).pathname,
  })
  try {
    const response = await facade.compileHarnessInvocation({
      compileRequest: request,
      aspHome: fixture.aspHome,
    })
    return response
  } finally {
    await facade.close()
  }
}

function hasTerminalTurn(events: InvocationEventEnvelope[]): boolean {
  return events.some(
    (event) =>
      event.type === 'turn.completed' ||
      event.type === 'turn.failed' ||
      event.type === 'turn.interrupted'
  )
}

async function waitForTerminal(
  events: InvocationEventEnvelope[],
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasTerminalTurn(events)) return true
    await Bun.sleep(50)
  }
  return hasTerminalTurn(events)
}

async function runRow(
  row: RowName,
  transport: CompileTransport,
  timeoutMs: number
): Promise<RowResult> {
  const marker = `MATRIX_${row.replaceAll('-', '_')}_${Date.now()}`
  const result: RowResult = {
    name: row,
    status: 'FAIL',
    marker,
    compile: {},
    events: 0,
    failures: [],
  }
  const fixture = createFixture(row)
  const originalCodex = process.env['ASP_CODEX_PATH']
  const originalClaude = process.env['ASP_CLAUDE_PATH']
  const originalMuse = process.env['ASP_MUSE_PATH']
  const originalSkip = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  let broker: BrokerClient | undefined
  let invocationId: InvocationId | undefined
  try {
    if (row === 'real-codex') {
      const binary = realExecutable('codex')
      if (binary === undefined) throw new Error('real codex binary is unavailable')
      process.env['ASP_CODEX_PATH'] = binary
    } else {
      process.env['ASP_CODEX_PATH'] = join(fixture.aspHome, 'codex')
    }
    if (row === 'real-claude-tmux') {
      const binary = realExecutable('claude')
      if (binary === undefined) throw new Error('real claude binary is unavailable')
      process.env['ASP_CLAUDE_PATH'] = binary
    } else {
      process.env['ASP_CLAUDE_PATH'] = join(fixture.aspHome, 'claude')
    }
    if (row === 'real-muse-serve' || row === 'muse-tmux') {
      const binary = realExecutable('muse')
      if (binary === undefined) throw new Error('real muse binary is unavailable')
      process.env['ASP_MUSE_PATH'] = binary
    } else {
      process.env['ASP_MUSE_PATH'] = join(fixture.aspHome, 'muse')
    }
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

    const response = await compileForMatrix(
      row === 'unix-jsonrpc-ndjson' ? 'aspc-rpc' : transport,
      fixture,
      createRequest(row, fixture, marker)
    )
    if (!response.ok) {
      result.failures.push({
        code: 'compile_failed',
        message: JSON.stringify(response.diagnostics),
      })
      return result
    }
    const { plan } = response
    result.compile = {
      compileId: plan.compileId,
      planHash: plan.planHash,
      profileHash: plan.execution.profile.profileHash,
      startRequestHash: plan.execution.profile.startRequestHash,
    }
    if (plan.execution.driver !== plan.execution.dispatchRequest.startRequest.spec.driver.kind) {
      result.failures.push({
        code: 'execution_driver_mismatch',
        message: `execution driver ${plan.execution.driver} disagrees with dispatch driver ${plan.execution.dispatchRequest.startRequest.spec.driver.kind}`,
      })
      return result
    }

    broker = await BrokerClient.start({
      command: process.execPath,
      args: ['harness/harness-broker/bin/harness-broker.js', 'run', '--transport', 'stdio'],
      cwd: new URL('..', import.meta.url).pathname,
    })
    await broker.hello({
      clientInfo: { name: 'pre-hrc-broker-matrix', version: 'v2' },
      protocolVersions: ['harness-broker/0.2'],
      capabilities: { permissionRequests: true },
    })
    broker.onPermissionRequest(async () => ({ decision: 'deny' }))
    const dispatch = plan.execution.dispatchRequest
    const started = await broker.startInvocationFromRequest(dispatch.startRequest, {
      dispatchEnv: dispatch.dispatchEnv,
      runtime: dispatch.runtime,
      lifecyclePolicy: dispatch.lifecyclePolicy,
    })
    invocationId = started.invocationId as InvocationId
    const events: InvocationEventEnvelope[] = []
    const collecting = (async () => {
      for await (const event of started.events) events.push(event)
    })()
    const terminal = await waitForTerminal(events, timeoutMs)
    result.events = events.length
    if (!terminal) {
      result.failures.push({
        code: 'terminal_turn_timeout',
        message: `no terminal turn after ${timeoutMs}ms`,
      })
    }
    if (!events.some((event) => event.type === 'invocation.ready')) {
      result.failures.push({
        code: 'invocation_not_ready',
        message: 'broker did not report invocation.ready',
      })
    }
    if (!JSON.stringify(events).includes(marker)) {
      result.failures.push({
        code: 'marker_missing',
        message: `broker events did not contain ${marker}`,
      })
    }
    await broker.dispose({ invocationId }).catch(() => undefined)
    await collecting.catch(() => undefined)
    invocationId = undefined
    result.status = result.failures.length === 0 ? 'OK' : 'FAIL'
    return result
  } catch (error) {
    result.failures.push({
      code: 'matrix_exception',
      message: error instanceof Error ? error.message : String(error),
    })
    return result
  } finally {
    if (broker !== undefined && invocationId !== undefined) {
      await broker.dispose({ invocationId }).catch(() => undefined)
    }
    await broker?.close().catch(() => undefined)
    if (originalCodex === undefined) process.env['ASP_CODEX_PATH'] = undefined
    else process.env['ASP_CODEX_PATH'] = originalCodex
    if (originalClaude === undefined) process.env['ASP_CLAUDE_PATH'] = undefined
    else process.env['ASP_CLAUDE_PATH'] = originalClaude
    if (originalMuse === undefined) process.env['ASP_MUSE_PATH'] = undefined
    else process.env['ASP_MUSE_PATH'] = originalMuse
    if (originalSkip === undefined) process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
    else process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkip
    fixture.cleanup()
  }
}

export async function runPreHrcBrokerMatrixE2e(
  argv: string[] = process.argv.slice(2),
  defaults: Partial<Pick<CliArgs, 'compileTransport'>> = {}
): Promise<MatrixReport> {
  const args = parseArgs(argv)
  if (defaults.compileTransport !== undefined && !argv.includes('--compile-transport')) {
    args.compileTransport = defaults.compileTransport
  }
  if (args.help) {
    usage()
    return { schemaVersion: 'pre-hrc-broker-matrix-e2e/v2', results: [], ok: true }
  }
  const rows = args.config === undefined ? MATRIX_ROW_NAMES : [args.config]
  const results: RowResult[] = []
  for (const row of rows) {
    const result = await runRow(row, args.compileTransport, args.timeoutMs)
    results.push(result)
    const outcome =
      result.status === 'OK'
        ? 'OK'
        : `FAIL ${result.failures.map((failure) => failure.code).join(',')}`
    console.log(`${row}: ${outcome}`)
  }
  const report: MatrixReport = {
    schemaVersion: 'pre-hrc-broker-matrix-e2e/v2',
    results,
    ok: results.every((result) => result.status === 'OK'),
  }
  if (args.json) console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
  return report
}

if (import.meta.main) {
  await runPreHrcBrokerMatrixE2e()
}
