#!/usr/bin/env bun
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

import type { BrokerPermissionPolicy, RuntimeCompileRequest } from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY, project } from 'spaces-runtime-contracts'

import { runPreHrcBrokerContractHarness } from '../packages/agent-spaces/src/testing/pre-hrc-broker-contract-harness.js'
import {
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
} from '../packages/agent-spaces/src/testing/pre-hrc-broker-helpers.js'

type CliArgs = {
  scopeRef: string
  agentRoot?: string | undefined
  projectRoot: string
  cwd: string
  aspHome: string
  artifactDir: string
  prompt: string
  model?: string | undefined
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
  permissionMode: 'deny' | 'allow' | 'ask-client'
  timeout: number
  expectedMarker: string
  invocationId: string
  initialInputId: string
  dryRunCompile: boolean
  writeRawStartRequest: boolean
  allowLegacyPermissionEvent: boolean
  json: boolean
  help: boolean
}

const DEFAULT_PROMPT =
  'Execute `printf "PATH_HEAD=%s\\n" "${PATH%%:*}"; command -v sparky-spark || true; pwd`, then reply ASP_BROKER_OK <scope>.'
const DEFAULT_EXPECTED_MARKER = 'ASP_BROKER_OK'

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  bun scripts/smoke-runtime-contract-broker-real-codex.ts --dry-run-compile [options]',
      '',
      'Options:',
      '  --scope-ref <handle>             Scope handle, e.g. cody@agent-spaces (default: cody@agent-spaces)',
      '  --agent-root <path>              Agent root directory (default: <repo>/../var/agents/<agent>)',
      '  --project-root <path>            Project root directory (default: current working directory)',
      '  --cwd <path>                     Runtime working directory (default: project root)',
      '  --asp-home <path>                ASP home for materialization (default: /tmp/asp-runtime-contract-broker)',
      '  --artifact-dir <path>            Artifact output directory (default: <asp-home>/pre-hrc-contract-artifacts)',
      '  --prompt <text>                  Initial prompt for compiled broker input',
      '  --model <id>                     Requested OpenAI model',
      '  --reasoning-effort <level>       low, medium, high, or xhigh',
      '  --permission-mode <mode>         deny, allow, or ask-client (default: deny)',
      '  --timeout <seconds>              Startup/turn timeout seconds (default: 120)',
      '  --expected-marker <text>         Assistant marker asserted in broker events (default: ASP_BROKER_OK)',
      '  --invocation-id <id>             Broker invocation id',
      '  --initial-input-id <id>          Initial broker input id',
      '  --dry-run-compile                Compile, select broker profile, assert contract, and write artifacts',
      '  --write-raw-start-request        Loud unsafe debug artifact; only allowed under OS temp dir',
      '  --allow-legacy-permission-event  TEMPORARY: tolerate the legacy invocation.permission.request event',
      '  --json                           Print result JSON',
      '  --help                           Show this message',
      '',
      'Omit --dry-run-compile to start the broker and consume normalized events.',
    ].join('\n')
  )
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.length === 0) throw new Error(`Missing value for ${flag}`)
  return value
}

function parseArgs(argv: string[]): CliArgs {
  const now = Math.floor(Date.now() / 1000)
  const projectRoot = process.cwd()
  const aspHome = '/tmp/asp-runtime-contract-broker'
  const args: CliArgs = {
    scopeRef: 'cody@agent-spaces',
    projectRoot,
    cwd: projectRoot,
    aspHome,
    artifactDir: join(aspHome, 'pre-hrc-contract-artifacts'),
    prompt: DEFAULT_PROMPT,
    permissionMode: 'deny',
    timeout: 120,
    expectedMarker: DEFAULT_EXPECTED_MARKER,
    invocationId: `inv_prehrc_${now}`,
    initialInputId: `input_prehrc_${now}`,
    dryRunCompile: false,
    writeRawStartRequest: false,
    allowLegacyPermissionEvent: false,
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
        args.agentRoot = readValue(argv, i, arg)
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
      case '--asp-home':
        args.aspHome = resolve(readValue(argv, i, arg))
        if (args.artifactDir === join(aspHome, 'pre-hrc-contract-artifacts')) {
          args.artifactDir = join(args.aspHome, 'pre-hrc-contract-artifacts')
        }
        i += 1
        break
      case '--artifact-dir':
        args.artifactDir = resolve(readValue(argv, i, arg))
        i += 1
        break
      case '--prompt':
        args.prompt = readValue(argv, i, arg)
        i += 1
        break
      case '--model':
        args.model = readValue(argv, i, arg)
        i += 1
        break
      case '--reasoning-effort': {
        const value = readValue(argv, i, arg)
        if (value !== 'low' && value !== 'medium' && value !== 'high' && value !== 'xhigh') {
          throw new Error('--reasoning-effort must be one of: low, medium, high, xhigh')
        }
        args.reasoningEffort = value
        i += 1
        break
      }
      case '--permission-mode': {
        const value = readValue(argv, i, arg)
        if (value !== 'deny' && value !== 'allow' && value !== 'ask-client') {
          throw new Error('--permission-mode must be one of: deny, allow, ask-client')
        }
        args.permissionMode = value
        i += 1
        break
      }
      case '--timeout':
        args.timeout = Number(readValue(argv, i, arg))
        if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
          throw new Error('--timeout must be a positive number')
        }
        i += 1
        break
      case '--expected-marker':
        args.expectedMarker = readValue(argv, i, arg)
        i += 1
        break
      case '--invocation-id':
        args.invocationId = readValue(argv, i, arg)
        i += 1
        break
      case '--initial-input-id':
        args.initialInputId = readValue(argv, i, arg)
        i += 1
        break
      case '--dry-run-compile':
        args.dryRunCompile = true
        break
      case '--write-raw-start-request':
        args.writeRawStartRequest = true
        break
      case '--allow-legacy-permission-event':
        args.allowLegacyPermissionEvent = true
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value)
  if (record === undefined) throw new Error(`${label} was not an object.`)
  return record
}

function asStringMap(value: unknown): Record<string, string> {
  const record = requireRecord(value, 'env')
  const result: Record<string, string> = {}
  for (const [key, envValue] of Object.entries(record)) {
    if (typeof envValue === 'string') result[key] = envValue
  }
  return result
}

function summarizeBrokerEvents(
  result: Awaited<ReturnType<typeof runPreHrcBrokerContractHarness>>,
  expectedMarker: string
): {
  continuation: string
  terminal: string
  command: string
  assistantMarker: string
  commandOutput: string
} {
  const events = result.brokerStart?.attempted === true ? result.brokerStart.events : []
  const continuation = events.find((event) => event.type === 'continuation.updated')
  const terminal = events.find((event) =>
    ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.type)
  )
  const started = events.find((event) => {
    const payload = asRecord(event.payload)
    return event.type === 'tool.call.started' && payload?.['name'] === 'command'
  })
  const startedPayload = asRecord(started?.payload)
  const startedInput = asRecord(startedPayload?.['input'])
  const toolCallId = startedPayload?.['toolCallId']
  const completed =
    typeof toolCallId === 'string'
      ? events.find((event) => {
          const payload = asRecord(event.payload)
          return event.type === 'tool.call.completed' && payload?.['toolCallId'] === toolCallId
        })
      : undefined
  const completedPayload = asRecord(completed?.payload)
  const completedResult = asRecord(completedPayload?.['result'])
  const completedOutput = String(completedResult?.['output'] ?? '')
  const assistantText = events
    .map((event) => {
      const payload = asRecord(event.payload)
      if (event.type === 'assistant.message.delta') return String(payload?.['text'] ?? '')
      if (event.type === 'turn.completed') return String(payload?.['finalOutput'] ?? '')
      if (event.type !== 'assistant.message.completed') return ''
      const content = Array.isArray(payload?.['content']) ? payload['content'] : []
      return content
        .map((part) => {
          const record = asRecord(part)
          return record?.['type'] === 'text' ? String(record['text'] ?? '') : ''
        })
        .join('')
    })
    .join('')

  const continuationPayload = asRecord(continuation?.payload)
  const terminalPayload = asRecord(terminal?.payload)
  return {
    continuation:
      continuation === undefined
        ? '(missing)'
        : `${String(continuationPayload?.['provider'] ?? '?')}:${String(continuationPayload?.['key'] ?? '?')}`,
    terminal:
      terminal === undefined
        ? '(missing)'
        : `${terminal.type} status=${String(terminalPayload?.['status'] ?? terminal.type)}`,
    command:
      started === undefined
        ? '(missing)'
        : `${String(startedInput?.['command'] ?? '?')} cwd=${String(startedInput?.['cwd'] ?? '?')} exit=${String(completedResult?.['exitCode'] ?? '?')} toolCallId=${String(toolCallId ?? '?')}`,
    assistantMarker: assistantText.includes(expectedMarker) ? expectedMarker : '(missing)',
    commandOutput: completedOutput.replaceAll('\n', '\\n').slice(0, 500) || '(missing)',
  }
}

function collectCommandOutputs(
  result: Awaited<ReturnType<typeof runPreHrcBrokerContractHarness>>
): string[] {
  const events = result.brokerStart?.attempted === true ? result.brokerStart.events : []
  return events
    .filter((event) => event.type === 'tool.call.completed')
    .map((event) => {
      const payload = asRecord(event.payload)
      const resultPayload = asRecord(payload?.['result'])
      return String(resultPayload?.['output'] ?? '')
    })
    .filter((output) => output.length > 0)
}

function assertRealCodexEnvEvidence(
  result: Awaited<ReturnType<typeof runPreHrcBrokerContractHarness>>,
  args: CliArgs
): string[] {
  if (result.selectedProfile === undefined) {
    throw new Error('No selected broker profile was produced.')
  }
  if (!result.compileResponse.ok) {
    throw new Error('Compile did not produce a plan.')
  }

  const failures: string[] = []
  const startRequest = result.selectedProfile.harnessInvocation.startRequest
  const processSpec = startRequest.spec.process
  const lockedEnv = processSpec.lockedEnv ?? {}
  const pathPrepend = processSpec.pathPrepend ?? []
  const startRequestProjection = project(startRequest, 'start-request')
  const specProjection = project(startRequest.spec, 'spec')
  const startProjectionJson = JSON.stringify(startRequestProjection)
  const specProjectionJson = JSON.stringify(specProjection)
  const events = result.brokerStart?.attempted === true ? result.brokerStart.events : []
  const summary = summarizeBrokerEvents(result, args.expectedMarker)

  if (processSpec.command !== 'codex' && !processSpec.command.endsWith('/codex')) {
    failures.push(`expected codex command, got ${processSpec.command}`)
  }
  if (!processSpec.args.includes('app-server')) {
    failures.push(`expected app-server arg, got ${processSpec.args.join(' ')}`)
  }

  const codexHome = lockedEnv['CODEX_HOME']
  if (codexHome === undefined) {
    failures.push('CODEX_HOME was not present in spec.process.lockedEnv')
  } else if (!existsSync(join(codexHome, 'auth.json'))) {
    failures.push(`CODEX_HOME/auth.json was not available at ${join(codexHome, 'auth.json')}`)
  }
  if (JSON.stringify(lockedEnv).includes('dispatch-hash-probe')) {
    failures.push('dispatch hash probe leaked into lockedEnv')
  }
  if (
    startProjectionJson.includes('dispatch-hash-probe') ||
    specProjectionJson.includes('dispatch-hash-probe')
  ) {
    failures.push('dispatchEnv hash probe leaked into hash projection')
  }

  if (!events.some((event) => event.type === 'invocation.started')) {
    failures.push('broker events did not include invocation.started')
  }
  if (!events.some((event) => event.type === 'turn.completed')) {
    failures.push('broker events did not include turn.completed')
  }
  if (summary.assistantMarker !== args.expectedMarker) {
    failures.push(`assistant marker ${args.expectedMarker} was missing`)
  }
  if (summary.command === '(missing)' || !summary.command.includes('exit=0')) {
    failures.push('command tool did not complete with exit=0')
  }

  const lockedMutatedValue = {
    ...startRequest.spec,
    process: {
      ...processSpec,
      lockedEnv: { ...lockedEnv, CODEX_HOME: `${codexHome ?? args.aspHome}/hash-check` },
    },
  }
  if (project(lockedMutatedValue, 'spec').specHash === specProjection.specHash) {
    failures.push('changing a lockedEnv value did not change the spec hash')
  }
  const lockedMutatedKey = {
    ...startRequest.spec,
    process: {
      ...processSpec,
      lockedEnv: { ...lockedEnv, ASP_PHASE5_HASH_KEY_PROBE: '1' },
    },
  }
  if (project(lockedMutatedKey, 'spec').specHash === specProjection.specHash) {
    failures.push('adding a lockedEnv key did not change the spec hash')
  }

  const expectedToolBin = join(resolve(args.agentRoot ?? ''), 'tools', 'bin')
  if (pathPrepend.length === 0) {
    failures.push('process.pathPrepend was empty; tool-bin PATH prepend was not exercised')
  } else if (pathPrepend[0] !== expectedToolBin) {
    failures.push(`expected pathPrepend[0] ${expectedToolBin}, got ${pathPrepend[0]}`)
  }

  const commandOutput = collectCommandOutputs(result).join('\n')
  if (pathPrepend[0] !== undefined && !commandOutput.includes(pathPrepend[0])) {
    failures.push('command output did not prove the tool-bin path was visible in spawned PATH')
  }

  return failures
}

async function assertDispatchEnvHashOmitted(args: CliArgs): Promise<string[]> {
  const baseline = await runPreHrcBrokerContractHarness({
    schemaVersion: 'pre-hrc-broker-contract-harness-input/v1',
    compileRequest: compileRequest(args),
    aspHome: args.aspHome,
    dryRunCompile: true,
    timeoutMs: args.timeout * 1000,
  })
  const variant = await runPreHrcBrokerContractHarness({
    schemaVersion: 'pre-hrc-broker-contract-harness-input/v1',
    compileRequest: compileRequest(args, {
      dispatchEnv: { ASP_DISPATCH_HASH_PROBE: 'dispatch-hash-probe' },
    }),
    aspHome: args.aspHome,
    dryRunCompile: true,
    timeoutMs: args.timeout * 1000,
  })

  const failures: string[] = []
  if (!baseline.ok) failures.push('baseline dry compile for dispatch hash check failed')
  if (!variant.ok) failures.push('variant dry compile for dispatch hash check failed')
  const baselineProfile = baseline.selectedProfile
  const variantProfile = variant.selectedProfile
  if (baseline.compileResponse.ok && variant.compileResponse.ok) {
    if (baseline.compileResponse.plan.planHash !== variant.compileResponse.plan.planHash) {
      failures.push('dispatchEnv changed planHash')
    }
  }
  if (baselineProfile !== undefined && variantProfile !== undefined) {
    if (baselineProfile.profileHash !== variantProfile.profileHash) {
      failures.push('dispatchEnv changed profileHash')
    }
    if (baselineProfile.harnessInvocation.specHash !== variantProfile.harnessInvocation.specHash) {
      failures.push('dispatchEnv changed specHash')
    }
    if (
      baselineProfile.harnessInvocation.startRequestHash !==
      variantProfile.harnessInvocation.startRequestHash
    ) {
      failures.push('dispatchEnv changed startRequestHash')
    }
  }
  return failures
}

function permissionPolicy(args: CliArgs): BrokerPermissionPolicy {
  if (args.permissionMode === 'allow') {
    return {
      mode: 'allow',
      audit: true,
      provenance: {
        source: 'test',
        requestId: 'request_prehrc_contract',
        createdAt: new Date().toISOString(),
      },
    }
  }
  if (args.permissionMode === 'ask-client') {
    return {
      mode: 'ask-client',
      timeoutMs: args.timeout * 1000,
      defaultDecision: 'deny',
      surface: 'api',
      audit: true,
    }
  }
  return { mode: 'deny', audit: true }
}

function compileRequest(
  args: CliArgs,
  overrides: { dispatchEnv?: Record<string, string> | undefined } = {}
): RuntimeCompileRequest {
  const timeoutMs = args.timeout * 1000
  const identity = allocatePreHrcRuntimeIdentity({
    namespace: 'prehrc_contract',
    invocationId: args.invocationId,
    initialInputId: args.initialInputId,
    idempotencyKey: 'pre-hrc-broker-contract',
  })
  const placement = buildPlacementFromScopeRef({
    scopeRef: args.scopeRef,
    agentRoot: args.agentRoot,
    projectRoot: args.projectRoot,
    cwd: args.cwd,
    hostSessionId: identity.hostSessionId,
    ...(overrides.dispatchEnv !== undefined ? { dispatchEnv: overrides.dispatchEnv } : {}),
  })
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement,
    requested: {
      modelProvider: 'openai',
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      harnessFamily: 'codex',
      preferredHarnessRuntime: 'codex-cli',
      interactionMode: 'headless',
    },
    materialization: {
      initialPrompt: args.prompt,
      taskContext: {
        taskId: 'pre-hrc-broker-contract',
        phase: 'contract',
        role: 'smoke',
        requiredEvidenceKinds: ['contract-artifacts'],
        hintsText: 'pre-HRC broker contract harness',
      },
    },
    hrcPolicy: {
      permissionPolicy: permissionPolicy(args),
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: timeoutMs, turnTimeoutMs: timeoutMs },
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
      appSessionKey: 'pre-hrc-broker-contract',
      scopeRef: args.scopeRef,
      laneRef: 'main',
    },
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  mkdirSync(args.aspHome, { recursive: true })
  ensureAspHomeRegistry(args)
  const result = await runPreHrcBrokerContractHarness({
    schemaVersion: 'pre-hrc-broker-contract-harness-input/v1',
    compileRequest: compileRequest(args),
    aspHome: args.aspHome,
    artifactDir: args.artifactDir,
    dryRunCompile: args.dryRunCompile,
    writeRawStartRequest: args.writeRawStartRequest,
    allowLegacyPermissionEvent: args.allowLegacyPermissionEvent,
    timeoutMs: args.timeout * 1000,
    brokerStartAssertions:
      args.dryRunCompile === true
        ? undefined
        : {
            baseline: {
              expectInitialInputAccepted: true,
              expectedTerminalType: 'turn.completed',
            },
          },
  })
  const realEvidenceFailures =
    args.dryRunCompile === true ? [] : assertRealCodexEnvEvidence(result, args)
  const dispatchHashFailures =
    args.dryRunCompile === true ? [] : await assertDispatchEnvHashOmitted(args)
  const evidenceFailures = [...realEvidenceFailures, ...dispatchHashFailures]

  if (args.json) {
    console.log(JSON.stringify({ ...result, evidenceFailures }, null, 2))
  } else {
    console.log(`pre-HRC broker contract: ${result.ok ? 'ok' : 'failed'}`)
    console.log(`mode: ${result.mode}`)
    console.log(`artifactDir: ${result.artifacts?.artifactDir ?? '(not written)'}`)
    console.log(
      `compileId: ${result.artifacts?.contractFields?.compileId ?? result.compiledPlan?.compileId ?? '(none)'}`
    )
    console.log(
      `planHash: ${result.artifacts?.contractFields?.planHash ?? result.compiledPlan?.planHash ?? '(none)'}`
    )
    console.log(
      `selectedProfileHash: ${result.artifacts?.contractFields?.selectedProfileHash ?? result.selectedProfile?.profileHash ?? '(none)'}`
    )
    console.log(
      `startRequestHash: ${result.artifacts?.contractFields?.startRequestHash ?? result.selectedProfile?.harnessInvocation.startRequestHash ?? '(none)'}`
    )
    console.log(
      `brokerEvents: ${result.artifacts?.files['broker-events.jsonl'] ?? '(not written)'}`
    )
    const summary = summarizeBrokerEvents(result, args.expectedMarker)
    const profile = result.selectedProfile
    const processSpec = profile?.harnessInvocation.startRequest.spec.process
    const lockedEnv = asStringMap(processSpec?.lockedEnv ?? {})
    const pathPrepend = processSpec?.pathPrepend ?? []
    console.log(`continuation: ${summary.continuation}`)
    console.log(`terminalTurn: ${summary.terminal}`)
    console.log(`commandTool: ${summary.command}`)
    console.log(`commandOutput: ${summary.commandOutput}`)
    console.log(`assistantMarker: ${summary.assistantMarker}`)
    console.log(`processCommand: ${processSpec?.command ?? '(missing)'}`)
    console.log(`processArgs: ${processSpec?.args.join(' ') ?? '(missing)'}`)
    console.log(`lockedEnvKeys: ${Object.keys(lockedEnv).sort().join(',')}`)
    console.log(`codexHome: ${lockedEnv['CODEX_HOME'] ?? '(missing)'}`)
    console.log(
      `codexAuth: ${
        lockedEnv['CODEX_HOME'] !== undefined &&
        existsSync(join(lockedEnv['CODEX_HOME'], 'auth.json'))
          ? join(lockedEnv['CODEX_HOME'], 'auth.json')
          : '(missing)'
      }`
    )
    console.log(`pathPrepend: ${pathPrepend.join(delimiter) || '(empty)'}`)
    console.log(
      `dispatchEnvHashCheck: ${
        dispatchHashFailures.length === 0 ? 'omitted-from-plan-profile-spec-start-hashes' : 'failed'
      }`
    )
    console.log(
      `lockedEnvHashCheck: ${realEvidenceFailures.length === 0 ? 'keys-and-values-in-spec-hash' : 'failed'}`
    )
    for (const failure of result.assertionReport.failures) {
      console.error(`${failure.code}: ${failure.message}`)
    }
    for (const failure of evidenceFailures) {
      console.error(`phase5_evidence_failed: ${failure}`)
    }
  }

  if (!result.ok || evidenceFailures.length > 0) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}
