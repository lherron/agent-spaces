#!/usr/bin/env bun
/**
 * Real-Codex E2E Smoke Harness
 *
 * Drives the COMPLETE broker flow against a real installed Codex app-server:
 *   ScopeRef → RuntimePlacement → buildHarnessBrokerInvocation → BrokerClient → turn lifecycle
 *
 * Default prompt exercises both real shell execution and priming introspection:
 * it asks Codex to run `pwd`, then reply with a marker and the runtime scope
 * handle from its priming context.
 *
 * Usage:
 *   bun scripts/smoke-asp-broker-real-codex.ts \
 *     --scope-ref cody@agent-spaces \
 *     --asp-home /tmp/asp-broker-smoke \
 *     --timeout 120
 *
 * Exit codes:
 *   0  Success — all required events observed, turn completed successfully
 *   1  Assertion failure — required event missing or turn failed/interrupted
 *   2  Broker/Codex startup failure
 */
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { formatScopeHandle, resolveScopeInput } from '../packages/agent-scope/src/index.ts'
import { createAgentSpacesClient } from '../packages/agent-spaces/src/index.ts'
import type { BuildHarnessBrokerInvocationRequest } from '../packages/agent-spaces/src/index.ts'
import type { RuntimePlacement } from '../packages/config/src/core/types/placement.ts'
import { resolvePlacementContext } from '../packages/config/src/index.ts'
import {
  buildRuntimeBundleRef,
  resolveAgentPlacementPaths,
} from '../packages/config/src/store/runtime-placement.ts'
import { BrokerClient } from '../packages/harness-broker-client/src/index.ts'
import type {
  InputPolicy,
  InvocationInput,
  InvocationInputResponse,
} from '../packages/harness-broker-protocol/src/commands.ts'
import type { InvocationEventEnvelope } from '../packages/harness-broker-protocol/src/events.ts'
import { validateInvocationStartRequest } from '../packages/harness-broker-protocol/src/schemas.ts'
import { expandTemplate } from '../packages/runtime/src/index.ts'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT =
  'Execute the shell command `pwd`. Do not execute any other shell commands. After it completes, reply with exactly two tokens separated by a space: ASP_BROKER_OK and the full runtime scope handle from your priming context. Use the shorthand handle form such as <agent>@<project>:<task>; do not use the colon-separated scopeRef form such as agent:<agent>:project:<project>:task:<task>.'
const QUEUE_POLICY_PROMPT =
  'Execute the shell command `sleep 6 && pwd`. Do not execute any other shell commands. After it completes, reply with exactly two tokens separated by a space: QUEUE_HOLDER_OK and the full runtime scope handle from your priming context. Use the shorthand handle form such as <agent>@<project>:<task>; do not use the colon-separated scopeRef form such as agent:<agent>:project:<project>:task:<task>.'
const DEFAULT_TIMEOUT_S = 120

type ScenarioName = 'happy' | 'queue-policy'
type ScenarioSelection = ScenarioName | 'all'

interface ParsedArgs {
  scopeRef: string
  agentRoot?: string | undefined
  projectRoot?: string | undefined
  cwd?: string | undefined
  aspHome: string
  invocationId: string
  timeout: number // seconds
  transcript: string
  prompt: string
  scenario: ScenarioSelection
  help: boolean
}

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  bun scripts/smoke-asp-broker-real-codex.ts [options]',
      '',
      'Options:',
      '  --scope-ref <handle>    Scope handle, e.g. cody@agent-spaces (default: cody@agent-spaces)',
      '  --agent-root <path>     Explicit agent root directory',
      '  --project-root <path>   Explicit project root directory',
      '  --cwd <path>            Working directory for execution',
      '  --asp-home <path>       ASP home for materialization (default: /tmp/asp-broker-smoke)',
      '  --invocation-id <id>    Invocation ID (default: smoke-<unix-timestamp>)',
      `  --timeout <seconds>     Overall timeout in seconds (default: ${DEFAULT_TIMEOUT_S})`,
      '  --transcript <path>     JSONL transcript output path (default: <asp-home>/transcript-<ts>.jsonl)',
      `  --prompt <text>         Prompt text (default: "${DEFAULT_PROMPT}")`,
      '  --scenario <name>       Scenario to run: happy, queue-policy, all (default: happy)',
      '  --help                  Show this message',
      '',
      'Exit codes:',
      '  0  All required events observed, turn completed successfully',
      '  1  Assertion failure (missing events, turn failed/interrupted)',
      '  2  Broker/Codex startup failure',
      '',
      'Example:',
      '  bun scripts/smoke-asp-broker-real-codex.ts \\',
      '    --scope-ref cody@agent-spaces \\',
      '    --asp-home /tmp/asp-broker-smoke',
    ].join('\n')
  )
}

function parseArgs(argv: string[]): ParsedArgs {
  const now = Math.floor(Date.now() / 1000)
  const args: ParsedArgs = {
    scopeRef: 'cody@agent-spaces',
    aspHome: '/tmp/asp-broker-smoke',
    invocationId: `smoke-${now}`,
    timeout: DEFAULT_TIMEOUT_S,
    transcript: '', // filled after aspHome is known
    prompt: DEFAULT_PROMPT,
    scenario: 'happy',
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--help') {
      args.help = true
      return args
    }
    switch (arg) {
      case '--scope-ref':
        args.scopeRef = argv[++i] ?? ''
        if (!args.scopeRef) throw new Error('Missing value for --scope-ref')
        break
      case '--agent-root':
        args.agentRoot = argv[++i]
        if (!args.agentRoot) throw new Error('Missing value for --agent-root')
        break
      case '--project-root':
        args.projectRoot = argv[++i]
        if (!args.projectRoot) throw new Error('Missing value for --project-root')
        break
      case '--cwd':
        args.cwd = argv[++i]
        if (!args.cwd) throw new Error('Missing value for --cwd')
        break
      case '--asp-home':
        args.aspHome = argv[++i] ?? ''
        if (!args.aspHome) throw new Error('Missing value for --asp-home')
        break
      case '--invocation-id':
        args.invocationId = argv[++i] ?? ''
        if (!args.invocationId) throw new Error('Missing value for --invocation-id')
        break
      case '--timeout':
        args.timeout = Number(argv[++i])
        if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
          throw new Error('--timeout must be a positive number')
        }
        break
      case '--transcript':
        args.transcript = argv[++i] ?? ''
        if (!args.transcript) throw new Error('Missing value for --transcript')
        break
      case '--prompt':
        args.prompt = argv[++i] ?? ''
        if (!args.prompt) throw new Error('Missing value for --prompt')
        break
      case '--scenario': {
        const scenario = argv[++i] ?? ''
        if (scenario !== 'happy' && scenario !== 'queue-policy' && scenario !== 'all') {
          throw new Error('--scenario must be one of: happy, queue-policy, all')
        }
        args.scenario = scenario
        break
      }
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  // Default transcript path
  if (!args.transcript) {
    args.transcript = join(args.aspHome, `transcript-${now}.jsonl`)
  }

  return args
}

// ---------------------------------------------------------------------------
// Placement construction
// ---------------------------------------------------------------------------

function buildPlacement(args: ParsedArgs): RuntimePlacement {
  const { parsed, scopeRef } = resolveScopeInput(args.scopeRef)

  const paths = resolveAgentPlacementPaths({
    agentId: parsed.agentId,
    projectId: parsed.projectId,
    agentRoot: args.agentRoot,
    projectRoot: args.projectRoot,
    cwd: args.cwd,
    aspHome: args.aspHome,
  })

  if (!paths.agentRoot) {
    throw new Error(
      `Could not resolve agentRoot for "${args.scopeRef}". Provide --agent-root or ensure ASP_AGENTS_ROOT is set.`
    )
  }

  const bundle = buildRuntimeBundleRef({
    agentName: parsed.agentId,
    agentRoot: paths.agentRoot,
    projectRoot: paths.projectRoot,
  })

  return {
    agentRoot: paths.agentRoot,
    projectRoot: paths.projectRoot,
    cwd: args.cwd ?? paths.cwd,
    runMode: 'task',
    bundle,
    correlation: {
      sessionRef: { scopeRef, laneRef: 'main' },
      hostSessionId: `smoke-host-${args.invocationId}`,
    },
  }
}

// ---------------------------------------------------------------------------
// Event tracking
// ---------------------------------------------------------------------------

const REQUIRED_EVENTS = [
  'invocation.started',
  'continuation.updated',
  'invocation.ready',
  'input.accepted',
  'turn.started',
] as const

const REQUIRED_TOOL_EVENTS = ['tool.call.started', 'tool.call.completed'] as const

const TERMINAL_TURN_EVENTS = ['turn.completed', 'turn.failed', 'turn.interrupted'] as const
type TerminalTurnEvent = (typeof TERMINAL_TURN_EVENTS)[number]

function isTerminalTurnEvent(type: string): type is TerminalTurnEvent {
  return (TERMINAL_TURN_EVENTS as readonly string[]).includes(type)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizeExistingPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function redactForComparison(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues.reduce((current, sensitive) => {
    if (!sensitive) return current
    return current.replaceAll(sensitive, '[REDACTED]')
  }, value)
}

function matchesRawOrRedacted(
  actual: unknown,
  expected: string,
  sensitiveValues: readonly string[]
): boolean {
  if (typeof actual !== 'string') return false
  return actual === expected || actual === redactForComparison(expected, sensitiveValues)
}

function pathOutputMatches(
  output: string,
  expectedPath: string,
  sensitiveValues: readonly string[]
): boolean {
  const trimmedOutput = output.trim()
  const normalizedExpected = normalizeExistingPath(expectedPath)
  const normalizedOutput = normalizeExistingPath(trimmedOutput)
  const redactedExpected = redactForComparison(expectedPath, sensitiveValues)
  const redactedNormalizedExpected = redactForComparison(normalizedExpected, sensitiveValues)
  return (
    trimmedOutput === expectedPath ||
    trimmedOutput.includes(expectedPath) ||
    normalizedOutput === normalizedExpected ||
    trimmedOutput.includes(normalizedExpected) ||
    trimmedOutput === redactedExpected ||
    trimmedOutput.includes(redactedExpected) ||
    trimmedOutput === redactedNormalizedExpected ||
    trimmedOutput.includes(redactedNormalizedExpected)
  )
}

function commandLooksLikePwdOnly(command: unknown): boolean {
  if (typeof command !== 'string') return false
  if (!/\bpwd\b/.test(command)) return false
  return !/(\bls\b|&&|;|\|\|?)/.test(command)
}

function buildPromptExpansionContext(placement: RuntimePlacement): {
  agentRoot: string
  agentsRoot: string
  projectRoot?: string | undefined
  projectId?: string | undefined
  agentId?: string | undefined
  agentName?: string | undefined
  taskId?: string | undefined
  lane?: string | undefined
  runMode: string
} {
  const sessionRef = placement.correlation?.sessionRef
  const parsed = sessionRef?.scopeRef ? resolveScopeInput(sessionRef.scopeRef).parsed : undefined
  const lane =
    sessionRef?.laneRef === undefined
      ? undefined
      : sessionRef.laneRef === 'main'
        ? 'main'
        : sessionRef.laneRef.slice(5)
  const agentId = parsed?.agentId ?? basename(placement.agentRoot)
  return {
    agentRoot: placement.agentRoot,
    agentsRoot: dirname(placement.agentRoot),
    agentId,
    agentName: agentId,
    projectId: parsed?.projectId,
    taskId: parsed?.taskId,
    lane,
    ...(placement.projectRoot !== undefined ? { projectRoot: placement.projectRoot } : {}),
    runMode: placement.runMode,
  }
}

async function expectedExpandedPrimingPrompt(
  placement: RuntimePlacement
): Promise<string | undefined> {
  const placementContext = await resolvePlacementContext({ ...placement, dryRun: true })
  const primingPrompt = placementContext.materialization.effectiveConfig?.priming_prompt
  return primingPrompt === undefined
    ? undefined
    : expandTemplate(primingPrompt, buildPromptExpansionContext(placement))
}

function assertInitialInputStartsWithPriming(
  initialInput: InvocationInput | undefined,
  expectedPriming: string | undefined
): void {
  if (expectedPriming === undefined) {
    console.log('[smoke]   No priming prompt found in effective config; skipping prefix assertion.')
    return
  }
  const firstContent = initialInput?.content[0]
  if (firstContent?.type !== 'text') {
    throw new Error('Expected initialInput.content[0] to be text with expanded priming prompt')
  }
  if (!firstContent.text.startsWith(expectedPriming)) {
    throw new Error('initialInput.content[0].text does not start with expanded priming prompt')
  }
  console.log('[smoke]   Verified: initialInput starts with expanded priming prompt.')
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface ScenarioRun {
  name: ScenarioName
  args: ParsedArgs
}

interface CollectedRun {
  collectedEvents: InvocationEventEnvelope[]
  seenTypes: Set<string>
  terminalTurnEvent?: InvocationEventEnvelope | undefined
  terminalTurnEvents: InvocationEventEnvelope[]
  assistantTexts: string[]
}

interface ProbeSpec {
  label: string
  inputId: string
  whenBusy: InputPolicy['whenBusy']
  text?: string | undefined
  expectedReason?: string | undefined
}

interface ProbeResult {
  probe: ProbeSpec
  response: InvocationInputResponse
  rpcRejected: boolean
}

function selectedScenarios(selection: ScenarioSelection): ScenarioName[] {
  return selection === 'all' ? ['happy', 'queue-policy'] : [selection]
}

function scenarioInvocationId(
  args: ParsedArgs,
  scenario: ScenarioName,
  multiScenario: boolean
): string {
  return multiScenario ? `${args.invocationId}-${scenario}` : args.invocationId
}

function scenarioTranscript(
  args: ParsedArgs,
  scenario: ScenarioName,
  multiScenario: boolean
): string {
  if (!multiScenario) return args.transcript
  return args.transcript.endsWith('.jsonl')
    ? args.transcript.replace(/\.jsonl$/, `-${scenario}.jsonl`)
    : `${args.transcript}-${scenario}`
}

function scenarioArgs(
  args: ParsedArgs,
  scenario: ScenarioName,
  multiScenario: boolean
): ParsedArgs {
  return {
    ...args,
    invocationId: scenarioInvocationId(args, scenario, multiScenario),
    transcript: scenarioTranscript(args, scenario, multiScenario),
    prompt: scenario === 'queue-policy' ? QUEUE_POLICY_PROMPT : args.prompt,
  }
}

async function buildScenarioInvocation(
  run: ScenarioRun,
  inputQueueOverride?: 'fifo' | 'none' | undefined
) {
  const { args } = run
  const transcriptDir = dirname(args.transcript)
  mkdirSync(transcriptDir, { recursive: true })

  console.log(`[smoke] Scenario:       ${run.name}`)
  console.log(`[smoke] scope-ref:      ${args.scopeRef}`)
  console.log(`[smoke] asp-home:       ${args.aspHome}`)
  console.log(`[smoke] invocation-id:  ${args.invocationId}`)
  console.log(`[smoke] timeout:        ${args.timeout}s`)
  console.log(`[smoke] transcript:     ${args.transcript}`)
  console.log(`[smoke] prompt:         ${args.prompt}`)
  console.log()

  console.log('[smoke] Step 1: Building RuntimePlacement from scope-ref...')
  const placement = buildPlacement(args)
  console.log(`[smoke]   agentRoot:   ${placement.agentRoot}`)
  console.log(`[smoke]   projectRoot: ${placement.projectRoot ?? '(none)'}`)
  console.log(`[smoke]   cwd:         ${placement.cwd ?? '(none)'}`)
  console.log(`[smoke]   bundle:      ${JSON.stringify(placement.bundle)}`)
  if (placement.bundle.kind !== 'agent-project') {
    throw new Error(
      `Expected placement.bundle.kind to be "agent-project"; got "${placement.bundle.kind}"`
    )
  }
  console.log('[smoke]   Verified: placement bundle kind is agent-project.')
  console.log()

  console.log('[smoke] Step 2: Building broker invocation via ASP SDK...')
  const spacesClient = createAgentSpacesClient({ aspHome: args.aspHome })
  const brokerReq: BuildHarnessBrokerInvocationRequest = {
    placement,
    provider: 'openai',
    frontend: 'codex-cli',
    interactionMode: 'headless',
    prompt: args.prompt,
    invocationId: args.invocationId,
    permissionPolicy: { mode: 'deny' },
    labels: { scenario: `asp-broker-real-codex-smoke:${run.name}` },
  }

  const invocationResponse = await spacesClient.buildHarnessBrokerInvocation(brokerReq)
  if (run.name === 'queue-policy') {
    invocationResponse.spec.interaction = {
      ...invocationResponse.spec.interaction,
      mode: invocationResponse.spec.interaction?.mode ?? 'headless',
      turnConcurrency: invocationResponse.spec.interaction?.turnConcurrency ?? 'single',
      inputQueue: inputQueueOverride ?? 'fifo',
    }
    invocationResponse.startRequest.spec = invocationResponse.spec
  }

  const expectedPriming = await expectedExpandedPrimingPrompt(placement)
  assertInitialInputStartsWithPriming(invocationResponse.initialInput, expectedPriming)
  console.log(`[smoke]   spec.invocationId: ${invocationResponse.spec.invocationId ?? '(auto)'}`)
  console.log(`[smoke]   spec.process.command: ${invocationResponse.spec.process.command}`)
  console.log(`[smoke]   spec.process.cwd: ${invocationResponse.spec.process.cwd}`)
  console.log(
    `[smoke]   spec.interaction.inputQueue: ${invocationResponse.spec.interaction?.inputQueue ?? '(none)'}`
  )
  console.log(`[smoke]   initialInput: ${invocationResponse.initialInput ? 'present' : 'absent'}`)
  if (invocationResponse.warnings?.length) {
    console.log(`[smoke]   warnings: ${invocationResponse.warnings.join(', ')}`)
  }
  console.log()

  console.log('[smoke] Step 3: Validating InvocationStartRequest...')
  validateInvocationStartRequest(invocationResponse.startRequest)
  console.log('[smoke]   Validation passed.')
  console.log()

  return { placement, invocationResponse }
}

async function collectEventsUntilTerminal(
  run: ScenarioRun,
  events: AsyncIterable<InvocationEventEnvelope>,
  expectedCwd: string,
  onTurnStarted?: (() => void) | undefined,
  minTerminalTurnEvents = 1
): Promise<CollectedRun> {
  console.log('[smoke] Step 7: Consuming broker events...')
  const collectedEvents: InvocationEventEnvelope[] = []
  const seenTypes = new Set<string>()
  let terminalTurnEvent: InvocationEventEnvelope | undefined
  const terminalTurnEvents: InvocationEventEnvelope[] = []
  let assistantOutput = ''
  const assistantFinalOutputs: string[] = []
  let turnStartedHookCalled = false

  writeFileSync(run.args.transcript, '')

  const timeoutMs = run.args.timeout * 1000
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Overall timeout of ${run.args.timeout}s exceeded`)),
      timeoutMs
    )
  })

  try {
    const consumeEvents = async () => {
      for await (const event of events) {
        collectedEvents.push(event)
        seenTypes.add(event.type)

        appendFileSync(run.args.transcript, `${JSON.stringify(event)}\n`)

        const payload = event.payload as Record<string, unknown> | undefined
        const brief = formatEventBrief(event)
        console.log(`[smoke]   [${String(event.seq).padStart(3)}] ${event.type}${brief}`)

        if (event.type === 'assistant.message.delta' && payload?.['text']) {
          assistantOutput += payload['text'] as string
        }
        if (event.type === 'assistant.message.completed') {
          const content = Array.isArray(payload?.['content']) ? payload?.['content'] : []
          const assistantFinalOutput = content
            .map((part) => {
              const record = asRecord(part)
              return record?.['type'] === 'text' ? String(record['text'] ?? '') : ''
            })
            .join('')
          if (assistantFinalOutput.length > 0) {
            assistantFinalOutputs.push(assistantFinalOutput)
          }
        }

        if (event.type === 'invocation.started' && payload?.['cwd']) {
          const launchedCwd = payload['cwd'] as string
          if (launchedCwd !== expectedCwd) {
            console.log(
              `[smoke]   WARNING: launched cwd "${launchedCwd}" differs from spec cwd "${expectedCwd}"`
            )
          } else {
            console.log(`[smoke]   Verified: cwd matches spec (${launchedCwd})`)
          }
        }

        if (event.type === 'turn.started' && !turnStartedHookCalled) {
          turnStartedHookCalled = true
          onTurnStarted?.()
        }

        if (isTerminalTurnEvent(event.type)) {
          terminalTurnEvent = event
          terminalTurnEvents.push(event)
          if (terminalTurnEvents.length >= minTerminalTurnEvents) {
            break
          }
        }

        if (
          event.type === 'invocation.exited' ||
          event.type === 'invocation.failed' ||
          event.type === 'invocation.disposed'
        ) {
          break
        }
      }
    }

    await Promise.race([consumeEvents(), timeoutPromise])
  } catch (err) {
    console.error(`\n[smoke] Event consumption error: ${err}`)
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
  }

  console.log()

  const assistantTexts = [...assistantFinalOutputs, assistantOutput].filter(
    (text) => text.length > 0
  )
  const assistantText = assistantTexts[0] ?? ''
  if (assistantText) {
    console.log(`[smoke] Assistant output: ${assistantText.trim()}`)
    console.log()
  }

  return { collectedEvents, seenTypes, terminalTurnEvent, terminalTurnEvents, assistantTexts }
}

async function cleanupInvocation(brokerClient: BrokerClient, invocationId: string): Promise<void> {
  console.log('[smoke] Step 8: Cleanup...')
  try {
    await brokerClient.stop({ invocationId })
    console.log('[smoke]   Invocation stopped.')
  } catch {
    // May already be stopped
  }
  try {
    await brokerClient.dispose({ invocationId })
    console.log('[smoke]   Invocation disposed.')
  } catch {
    // May already be disposed
  }
  console.log()
}

function assertTerminalTurnCompleted(
  terminalTurnEvent: InvocationEventEnvelope | undefined
): number {
  if (terminalTurnEvent) {
    const payload = terminalTurnEvent.payload as Record<string, unknown> | undefined
    if (terminalTurnEvent.type === 'turn.completed') {
      console.log(
        `[smoke]   \u2713 ${terminalTurnEvent.type} (turnId: ${payload?.['turnId'] ?? 'n/a'})`
      )
      return 0
    }
    console.error(
      `[smoke]   \u2717 Terminal event is ${terminalTurnEvent.type}, expected turn.completed`
    )
    if (payload) console.error(`[smoke]     payload: ${JSON.stringify(payload)}`)
    return 1
  }

  console.error('[smoke]   \u2717 MISSING: terminal turn event (turn.completed/failed/interrupted)')
  return 1
}

function assertHappyScenario(
  run: ScenarioRun,
  invocationResponse: Awaited<ReturnType<typeof buildScenarioInvocation>>['invocationResponse'],
  collected: CollectedRun
): number {
  console.log('[smoke] Step 9: Assertions...')
  console.log(`[smoke]   Total events collected: ${collected.collectedEvents.length}`)
  console.log(`[smoke]   Unique event types seen: ${[...collected.seenTypes].join(', ')}`)
  console.log(`[smoke]   Transcript: ${run.args.transcript}`)
  console.log()

  let failures = 0

  for (const required of REQUIRED_EVENTS) {
    if (collected.seenTypes.has(required)) {
      console.log(`[smoke]   \u2713 ${required}`)
    } else {
      console.error(`[smoke]   \u2717 MISSING: ${required}`)
      failures++
    }
  }

  for (const required of REQUIRED_TOOL_EVENTS) {
    if (collected.seenTypes.has(required)) {
      console.log(`[smoke]   \u2713 ${required}`)
    } else {
      console.error(`[smoke]   \u2717 MISSING: ${required}`)
      failures++
    }
  }

  const resolvedScope = resolveScopeInput(run.args.scopeRef)
  const sensitiveValues = [
    resolvedScope.parsed.agentId,
    resolvedScope.parsed.projectId,
    resolvedScope.parsed.taskId,
    resolvedScope.parsed.roleName,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  const expectedCwd = invocationResponse.spec.process.cwd
  const commandStarted = collected.collectedEvents.find((event) => {
    if (event.type !== 'tool.call.started') return false
    const payload = asRecord(event.payload)
    return payload?.['name'] === 'command'
  })
  const commandStartedPayload = asRecord(commandStarted?.payload)
  const commandInput = asRecord(commandStartedPayload?.['input'])
  const toolCallId = commandStartedPayload?.['toolCallId']

  if (!commandStarted || !commandStartedPayload || !commandInput) {
    console.error('[smoke]   \u2717 missing command tool.call.started payload')
    failures++
  } else {
    let commandFailures = 0
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      console.error('[smoke]   \u2717 command tool.call.started missing toolCallId')
      commandFailures++
    }
    if (!commandLooksLikePwdOnly(commandInput['command'])) {
      console.error(
        `[smoke]   \u2717 command input mismatch: expected a pwd-only command, got ${JSON.stringify(commandInput['command'])}`
      )
      commandFailures++
    }
    if (!matchesRawOrRedacted(commandInput['cwd'], expectedCwd, sensitiveValues)) {
      console.error(
        `[smoke]   \u2717 command cwd mismatch: expected "${expectedCwd}", got ${JSON.stringify(commandInput['cwd'])}`
      )
      commandFailures++
    }
    if (typeof commandStarted.turnId !== 'string' || commandStarted.turnId.length === 0) {
      console.error('[smoke]   \u2717 command tool.call.started missing turnId')
      commandFailures++
    }
    if (typeof commandStarted.itemId !== 'string' || commandStarted.itemId.length === 0) {
      console.error('[smoke]   \u2717 command tool.call.started missing itemId')
      commandFailures++
    }

    if (commandFailures === 0) {
      console.log('[smoke]   \u2713 command tool.call.started payload')
    } else {
      failures += commandFailures
    }
  }

  const commandCompleted =
    typeof toolCallId === 'string'
      ? collected.collectedEvents.find((event) => {
          if (event.type !== 'tool.call.completed') return false
          const payload = asRecord(event.payload)
          return payload?.['toolCallId'] === toolCallId
        })
      : undefined
  const commandCompletedPayload = asRecord(commandCompleted?.payload)
  const commandResult = asRecord(commandCompletedPayload?.['result'])

  if (!commandCompleted || !commandCompletedPayload || !commandResult) {
    console.error('[smoke]   \u2717 missing matching command tool.call.completed payload')
    failures++
  } else {
    let commandFailures = 0
    if (commandCompletedPayload['name'] !== 'command') {
      console.error(
        `[smoke]   \u2717 command completion name mismatch: ${JSON.stringify(commandCompletedPayload['name'])}`
      )
      commandFailures++
    }
    if (commandCompletedPayload['isError'] !== false) {
      console.error(
        `[smoke]   \u2717 command completion isError mismatch: ${JSON.stringify(commandCompletedPayload['isError'])}`
      )
      commandFailures++
    }
    if (commandResult['exitCode'] !== 0) {
      console.error(
        `[smoke]   \u2717 command exitCode mismatch: ${JSON.stringify(commandResult['exitCode'])}`
      )
      commandFailures++
    }
    if (typeof commandResult['output'] !== 'string') {
      console.error('[smoke]   \u2717 command result.output is not a string')
      commandFailures++
    } else if (!pathOutputMatches(commandResult['output'], expectedCwd, sensitiveValues)) {
      console.error(
        `[smoke]   \u2717 command output does not match cwd: output=${JSON.stringify(commandResult['output'])}, expected=${JSON.stringify(expectedCwd)}`
      )
      commandFailures++
    }

    if (commandFailures === 0) {
      console.log('[smoke]   \u2713 command tool.call.completed payload')
    } else {
      failures += commandFailures
    }
  }

  failures += assertTerminalTurnCompleted(collected.terminalTurnEvent)

  const expectedScopeHandle = formatScopeHandle(resolvedScope.parsed)
  const redactedExpectedScopeHandle = redactForComparison(expectedScopeHandle, sensitiveValues)
  const hasExpectedIntrospection = collected.assistantTexts.some(
    (text) =>
      text.includes('ASP_BROKER_OK') &&
      (text.includes(expectedScopeHandle) || text.includes(redactedExpectedScopeHandle))
  )
  if (hasExpectedIntrospection) {
    console.log(
      `[smoke]   \u2713 introspect reply contains ASP_BROKER_OK and ${expectedScopeHandle}`
    )
  } else {
    console.error(
      `[smoke]   \u2717 introspect reply missing ASP_BROKER_OK or expected runtime scope handle ${expectedScopeHandle}`
    )
    failures++
  }

  console.log()
  return failures
}

function inputRejectedReason(event: InvocationEventEnvelope | undefined): string | undefined {
  const payload = asRecord(event?.payload)
  return typeof payload?.['reason'] === 'string' ? payload['reason'] : undefined
}

function findInputRejectedEvent(
  events: InvocationEventEnvelope[],
  inputId: string
): InvocationEventEnvelope | undefined {
  return events.find((event) => {
    if (event.type !== 'input.rejected') return false
    const payload = asRecord(event.payload)
    return event.inputId === inputId || payload?.['inputId'] === inputId
  })
}

function findInputQueuedEvent(
  events: InvocationEventEnvelope[],
  inputId: string
): InvocationEventEnvelope | undefined {
  return events.find((event) => {
    if (event.type !== 'input.queued') return false
    const payload = asRecord(event.payload)
    return event.inputId === inputId || payload?.['inputId'] === inputId
  })
}

function findEventIndex(
  events: InvocationEventEnvelope[],
  predicate: (event: InvocationEventEnvelope) => boolean
): number {
  return events.findIndex(predicate)
}

function errorReason(err: unknown): string {
  const record = asRecord(err)
  if (typeof record?.['message'] === 'string' && record['message'].length > 0) {
    return record['message']
  }
  return String(err)
}

async function sendBusyProbe(
  brokerClient: BrokerClient,
  invocationId: string,
  probe: ProbeSpec
): Promise<ProbeResult> {
  try {
    const response = await brokerClient.input({
      invocationId,
      input: {
        inputId: probe.inputId,
        kind: 'user',
        content: [{ type: 'text', text: probe.text ?? `busy-input smoke probe ${probe.label}` }],
      },
      policy: { whenBusy: probe.whenBusy },
    })
    return { probe, response, rpcRejected: false }
  } catch (err) {
    return {
      probe,
      response: {
        inputId: probe.inputId,
        accepted: false,
        disposition: 'rejected',
        reason: errorReason(err),
      },
      rpcRejected: true,
    }
  }
}

function assertQueuePolicyFifoScenario(
  run: ScenarioRun,
  collected: CollectedRun,
  queueCapability: boolean | undefined,
  probeResults: ProbeResult[] | undefined
): number {
  console.log('[smoke] Step 9: Queue-policy FIFO assertions...')
  console.log(`[smoke]   Total events collected: ${collected.collectedEvents.length}`)
  console.log(`[smoke]   Unique event types seen: ${[...collected.seenTypes].join(', ')}`)
  console.log(`[smoke]   Transcript: ${run.args.transcript}`)
  console.log()

  let failures = 0
  if (queueCapability === true) {
    console.log('[smoke]   \u2713 capabilities.input.queue is true')
  } else {
    console.error(
      `[smoke]   \u2717 capabilities.input.queue expected true, got ${JSON.stringify(queueCapability)}`
    )
    failures++
  }

  if (collected.seenTypes.has('turn.started')) {
    console.log('[smoke]   \u2713 holder turn started before busy-input probes')
  } else {
    console.error('[smoke]   \u2717 MISSING: holder turn.started')
    failures++
  }

  const probes: ProbeSpec[] = [
    { label: 'A reject', inputId: 'queue_policy_probe_reject', whenBusy: 'reject' },
    {
      label: 'B queue',
      inputId: 'queue_policy_probe_queue',
      whenBusy: 'queue',
      text: 'Reply with exactly this single token: DRAIN_OK',
    },
    {
      label: 'C interrupt_then_apply',
      inputId: 'queue_policy_probe_interrupt',
      whenBusy: 'interrupt_then_apply',
      expectedReason: 'unsupported_busy_policy',
    },
  ]
  const resultsById = new Map(probeResults?.map((result) => [result.probe.inputId, result]) ?? [])

  for (const probe of probes) {
    const result = resultsById.get(probe.inputId)
    const rejectedEvent = findInputRejectedEvent(collected.collectedEvents, probe.inputId)
    const eventReason = inputRejectedReason(rejectedEvent)
    let probeFailures = 0

    if (probe.inputId === 'queue_policy_probe_queue') {
      const queuedEvent = findInputQueuedEvent(collected.collectedEvents, probe.inputId)
      const holderCompletedIndex = findEventIndex(
        collected.collectedEvents,
        (event) => event.type === 'turn.completed' && event.inputId !== probe.inputId
      )
      const drainedStartedIndex = findEventIndex(
        collected.collectedEvents,
        (event) => event.type === 'turn.started' && event.inputId === probe.inputId
      )
      const drainedCompletedIndex = findEventIndex(
        collected.collectedEvents,
        (event) => event.type === 'turn.completed' && event.inputId === probe.inputId
      )

      if (!result) {
        console.error(`[smoke]   \u2717 probe ${probe.label} did not return a result`)
        probeFailures++
      } else if (
        result.response.accepted !== true ||
        result.response.disposition !== 'queued' ||
        result.response.inputId !== probe.inputId
      ) {
        console.error(
          `[smoke]   \u2717 probe ${probe.label} response mismatch: ${JSON.stringify(result.response)}`
        )
        probeFailures++
      }

      if (!queuedEvent) {
        console.error(`[smoke]   \u2717 probe ${probe.label} missing input.queued event`)
        probeFailures++
      }
      if (rejectedEvent) {
        console.error(`[smoke]   \u2717 probe ${probe.label} unexpectedly emitted input.rejected`)
        probeFailures++
      }
      if (holderCompletedIndex < 0) {
        console.error('[smoke]   \u2717 holder turn.completed not observed before drain')
        probeFailures++
      }
      if (drainedStartedIndex < 0) {
        console.error(`[smoke]   \u2717 probe ${probe.label} missing drained turn.started`)
        probeFailures++
      } else if (holderCompletedIndex >= 0 && drainedStartedIndex <= holderCompletedIndex) {
        console.error(
          `[smoke]   \u2717 probe ${probe.label} drained turn.started did not occur after holder turn.completed`
        )
        probeFailures++
      }
      if (drainedCompletedIndex < 0) {
        console.error(`[smoke]   \u2717 probe ${probe.label} missing drained turn.completed`)
        probeFailures++
      }
      if (!collected.assistantTexts.some((text) => text.includes('DRAIN_OK'))) {
        console.error(`[smoke]   \u2717 probe ${probe.label} reply missing DRAIN_OK`)
        probeFailures++
      }

      if (probeFailures === 0) {
        console.log(
          `[smoke]   \u2713 probe ${probe.label} queued, emitted input.queued, and drained into a second completed turn`
        )
      } else {
        failures += probeFailures
      }
      continue
    }

    if (!result) {
      console.error(`[smoke]   \u2717 probe ${probe.label} did not return a result`)
      probeFailures++
    } else {
      if (result.response.accepted !== false || result.response.disposition !== 'rejected') {
        console.error(
          `[smoke]   \u2717 probe ${probe.label} response mismatch: ${JSON.stringify(result.response)}`
        )
        probeFailures++
      }
      const responseReason = result.response.reason
      if (probe.expectedReason !== undefined && responseReason !== probe.expectedReason) {
        console.error(
          `[smoke]   \u2717 probe ${probe.label} reason mismatch: expected ${probe.expectedReason}, got ${JSON.stringify(responseReason)}`
        )
        probeFailures++
      }
      if (probe.expectedReason === undefined && !responseReason) {
        console.error(`[smoke]   \u2717 probe ${probe.label} response reason is empty`)
        probeFailures++
      }
    }

    if (!rejectedEvent) {
      console.error(`[smoke]   \u2717 probe ${probe.label} missing input.rejected event`)
      probeFailures++
    } else if (probe.expectedReason !== undefined && eventReason !== probe.expectedReason) {
      console.error(
        `[smoke]   \u2717 probe ${probe.label} event reason mismatch: expected ${probe.expectedReason}, got ${JSON.stringify(eventReason)}`
      )
      probeFailures++
    } else if (probe.expectedReason === undefined && !eventReason) {
      console.error(`[smoke]   \u2717 probe ${probe.label} event reason is empty`)
      probeFailures++
    }

    if (probeFailures === 0) {
      const transport = result?.rpcRejected ? 'rpc rejection' : 'response'
      console.log(
        `[smoke]   \u2713 probe ${probe.label} rejected via ${transport} with input.rejected event`
      )
    } else {
      failures += probeFailures
    }
  }

  if (collected.terminalTurnEvents.length >= 2) {
    console.log('[smoke]   \u2713 observed holder and drained terminal turn events')
  } else {
    console.error(
      `[smoke]   \u2717 expected 2 terminal turn events, saw ${collected.terminalTurnEvents.length}`
    )
    failures++
  }

  for (const [index, terminal] of collected.terminalTurnEvents.entries()) {
    if (terminal.type === 'turn.completed') {
      const payload = terminal.payload as Record<string, unknown> | undefined
      console.log(
        `[smoke]   \u2713 turn ${index + 1} completed (turnId: ${payload?.['turnId'] ?? 'n/a'})`
      )
    } else {
      console.error(
        `[smoke]   \u2717 turn ${index + 1} terminal event is ${terminal.type}, expected turn.completed`
      )
      failures++
    }
  }

  const resolvedScope = resolveScopeInput(run.args.scopeRef)
  const sensitiveValues = [
    resolvedScope.parsed.agentId,
    resolvedScope.parsed.projectId,
    resolvedScope.parsed.taskId,
    resolvedScope.parsed.roleName,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  const expectedScopeHandle = formatScopeHandle(resolvedScope.parsed)
  const redactedExpectedScopeHandle = redactForComparison(expectedScopeHandle, sensitiveValues)
  const hasExpectedHolderOutput = collected.assistantTexts.some(
    (text) =>
      text.includes('QUEUE_HOLDER_OK') &&
      (text.includes(expectedScopeHandle) || text.includes(redactedExpectedScopeHandle))
  )
  if (hasExpectedHolderOutput) {
    console.log(`[smoke]   \u2713 holder reply contains QUEUE_HOLDER_OK and ${expectedScopeHandle}`)
  } else {
    console.error(
      `[smoke]   \u2717 holder reply missing QUEUE_HOLDER_OK or expected runtime scope handle ${expectedScopeHandle}`
    )
    failures++
  }

  console.log()
  return failures
}

function assertQueuePolicyNoneScenario(
  run: ScenarioRun,
  collected: CollectedRun,
  queueCapability: boolean | undefined,
  probeResults: ProbeResult[] | undefined
): number {
  console.log('[smoke] Step 10: Queue-policy none assertions...')
  console.log(`[smoke]   Total events collected: ${collected.collectedEvents.length}`)
  console.log(`[smoke]   Unique event types seen: ${[...collected.seenTypes].join(', ')}`)
  console.log(`[smoke]   Transcript: ${run.args.transcript}`)
  console.log()

  let failures = 0
  if (queueCapability === false) {
    console.log('[smoke]   \u2713 capabilities.input.queue is false')
  } else {
    console.error(
      `[smoke]   \u2717 capabilities.input.queue expected false, got ${JSON.stringify(queueCapability)}`
    )
    failures++
  }

  const probe: ProbeSpec = {
    label: 'B2 queue none',
    inputId: 'queue_policy_probe_queue_none',
    whenBusy: 'queue',
    expectedReason: 'queue_not_supported',
  }
  const result = probeResults?.find((candidate) => candidate.probe.inputId === probe.inputId)
  const rejectedEvent = findInputRejectedEvent(collected.collectedEvents, probe.inputId)
  const eventReason = inputRejectedReason(rejectedEvent)

  if (!result) {
    console.error(`[smoke]   \u2717 probe ${probe.label} did not return a result`)
    failures++
  } else {
    if (result.response.accepted !== false || result.response.disposition !== 'rejected') {
      console.error(
        `[smoke]   \u2717 probe ${probe.label} response mismatch: ${JSON.stringify(result.response)}`
      )
      failures++
    }
    if (result.response.reason !== probe.expectedReason) {
      console.error(
        `[smoke]   \u2717 probe ${probe.label} reason mismatch: expected ${probe.expectedReason}, got ${JSON.stringify(result.response.reason)}`
      )
      failures++
    }
  }

  if (!rejectedEvent) {
    console.error(`[smoke]   \u2717 probe ${probe.label} missing input.rejected event`)
    failures++
  } else if (eventReason !== probe.expectedReason) {
    console.error(
      `[smoke]   \u2717 probe ${probe.label} event reason mismatch: expected ${probe.expectedReason}, got ${JSON.stringify(eventReason)}`
    )
    failures++
  }

  failures += assertTerminalTurnCompleted(collected.terminalTurnEvent)

  if (failures === 0) {
    const transport = result?.rpcRejected ? 'rpc rejection' : 'response'
    console.log(
      `[smoke]   \u2713 probe ${probe.label} rejected via ${transport} with queue_not_supported and input.rejected event`
    )
  }

  console.log()
  return failures
}

async function runHappyScenario(brokerClient: BrokerClient, run: ScenarioRun): Promise<number> {
  const { invocationResponse } = await buildScenarioInvocation(run)
  console.log('[smoke] Step 6: Starting invocation (with initialInput)...')
  const { invocationId, events } = await brokerClient.startInvocation(
    invocationResponse.startRequest.spec,
    invocationResponse.startRequest.initialInput
  )
  console.log(`[smoke]   invocationId: ${invocationId}`)
  console.log()

  let collected: CollectedRun | undefined
  try {
    collected = await collectEventsUntilTerminal(run, events, invocationResponse.spec.process.cwd)
  } finally {
    await cleanupInvocation(brokerClient, invocationId)
  }
  if (!collected) {
    throw new Error('Happy scenario did not collect events')
  }

  return assertHappyScenario(run, invocationResponse, collected)
}

async function runQueuePolicyScenario(
  brokerClient: BrokerClient,
  run: ScenarioRun
): Promise<number> {
  const fifoRun: ScenarioRun = {
    ...run,
    args: {
      ...run.args,
      invocationId: `${run.args.invocationId}-fifo`,
      transcript: run.args.transcript.endsWith('.jsonl')
        ? run.args.transcript.replace(/\.jsonl$/, '-fifo.jsonl')
        : `${run.args.transcript}-fifo`,
    },
  }
  const { invocationResponse } = await buildScenarioInvocation(fifoRun, 'fifo')
  console.log('[smoke] Step 6: Starting FIFO invocation (with initialInput)...')
  const { invocationId, events } = await brokerClient.startInvocation(
    invocationResponse.startRequest.spec,
    invocationResponse.startRequest.initialInput
  )
  const status = await brokerClient.status({ invocationId })
  console.log(`[smoke]   invocationId: ${invocationId}`)
  console.log(`[smoke]   capabilities.input.queue: ${status.capabilities.input.queue}`)
  console.log()

  const probes: ProbeSpec[] = [
    { label: 'A reject', inputId: 'queue_policy_probe_reject', whenBusy: 'reject' },
    {
      label: 'B queue',
      inputId: 'queue_policy_probe_queue',
      whenBusy: 'queue',
      text: 'Reply with exactly this single token: DRAIN_OK',
    },
    {
      label: 'C interrupt_then_apply',
      inputId: 'queue_policy_probe_interrupt',
      whenBusy: 'interrupt_then_apply',
      expectedReason: 'unsupported_busy_policy',
    },
  ]
  let probePromise: Promise<ProbeResult[]> | undefined
  const fireProbes = () => {
    console.log('[smoke]   turn.started observed; firing busy-input probes...')
    probePromise = Promise.all(
      probes.map((probe) => sendBusyProbe(brokerClient, invocationId, probe))
    )
  }

  let collected: CollectedRun | undefined
  try {
    collected = await collectEventsUntilTerminal(
      fifoRun,
      events,
      invocationResponse.spec.process.cwd,
      fireProbes,
      2
    )
  } finally {
    await cleanupInvocation(brokerClient, invocationId)
  }
  if (!collected) {
    throw new Error('Queue-policy scenario did not collect events')
  }

  const probeResults = probePromise ? await probePromise : undefined
  let failures = assertQueuePolicyFifoScenario(
    fifoRun,
    collected,
    status.capabilities.input.queue,
    probeResults
  )

  const noneRun: ScenarioRun = {
    ...run,
    args: {
      ...run.args,
      invocationId: `${run.args.invocationId}-none`,
      transcript: run.args.transcript.endsWith('.jsonl')
        ? run.args.transcript.replace(/\.jsonl$/, '-none.jsonl')
        : `${run.args.transcript}-none`,
    },
  }
  const noneInvocation = await buildScenarioInvocation(noneRun, 'none')
  console.log('[smoke] Step 6b: Starting inputQueue=none invocation (with initialInput)...')
  const noneStarted = await brokerClient.startInvocation(
    noneInvocation.invocationResponse.startRequest.spec,
    noneInvocation.invocationResponse.startRequest.initialInput
  )
  const noneStatus = await brokerClient.status({ invocationId: noneStarted.invocationId })
  console.log(`[smoke]   invocationId: ${noneStarted.invocationId}`)
  console.log(`[smoke]   capabilities.input.queue: ${noneStatus.capabilities.input.queue}`)
  console.log()

  const noneProbe: ProbeSpec = {
    label: 'B2 queue none',
    inputId: 'queue_policy_probe_queue_none',
    whenBusy: 'queue',
    expectedReason: 'queue_not_supported',
  }
  let noneProbePromise: Promise<ProbeResult[]> | undefined
  const fireNoneProbe = () => {
    console.log('[smoke]   turn.started observed; firing inputQueue=none busy-input probe...')
    noneProbePromise = Promise.all([
      sendBusyProbe(brokerClient, noneStarted.invocationId, noneProbe),
    ])
  }

  let noneCollected: CollectedRun | undefined
  try {
    noneCollected = await collectEventsUntilTerminal(
      noneRun,
      noneStarted.events,
      noneInvocation.invocationResponse.spec.process.cwd,
      fireNoneProbe
    )
  } finally {
    await cleanupInvocation(brokerClient, noneStarted.invocationId)
  }
  if (!noneCollected) {
    throw new Error('Queue-policy inputQueue=none scenario did not collect events')
  }

  const noneProbeResults = noneProbePromise ? await noneProbePromise : undefined
  failures += assertQueuePolicyNoneScenario(
    noneRun,
    noneCollected,
    noneStatus.capabilities.input.queue,
    noneProbeResults
  )
  return failures
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

  mkdirSync(args.aspHome, { recursive: true })
  const scenarios = selectedScenarios(args.scenario)
  const multiScenario = scenarios.length > 1

  console.log(`[smoke] selected scenario(s): ${scenarios.join(', ')}`)
  console.log()

  console.log('[smoke] Starting broker process...')
  const repoRoot = new URL('..', import.meta.url).pathname
  let brokerClient: BrokerClient
  try {
    brokerClient = await BrokerClient.start({
      command: 'bun',
      args: ['packages/harness-broker/bin/harness-broker.js', 'run', '--transport', 'stdio'],
      cwd: repoRoot,
    })
  } catch (err) {
    console.error('[smoke] Failed to start broker:', err)
    process.exit(2)
  }
  console.log('[smoke]   Broker process started.')
  console.log()

  try {
    console.log('[smoke] Sending broker.hello...')
    const helloResp = await brokerClient.hello({
      clientInfo: { name: 'smoke-asp-broker-real-codex', version: '0.1.0' },
      protocolVersions: ['harness-broker/0.1'],
      capabilities: { permissionRequests: true },
    })
    console.log(`[smoke]   Broker: ${helloResp.brokerInfo.name} v${helloResp.brokerInfo.version}`)
    console.log(`[smoke]   Protocol: ${helloResp.protocolVersion}`)
    console.log(`[smoke]   Drivers: ${helloResp.drivers.map((d) => d.kind).join(', ')}`)
    console.log()

    brokerClient.onPermissionRequest(async (req) => {
      console.log(`[smoke]   Permission request: ${req.kind} -> deny`)
      return { decision: 'deny' as const }
    })

    let failures = 0
    for (const scenario of scenarios) {
      const run = { name: scenario, args: scenarioArgs(args, scenario, multiScenario) }
      failures +=
        scenario === 'happy'
          ? await runHappyScenario(brokerClient, run)
          : await runQueuePolicyScenario(brokerClient, run)
    }

    if (failures > 0) {
      console.error(`[smoke] FAILED: ${failures} assertion(s) failed`)
      process.exitCode = 1
      return
    }

    console.log('[smoke] SUCCESS: All selected scenario assertions passed')
  } finally {
    try {
      await brokerClient.close()
      console.log('[smoke] Broker client closed.')
    } catch {
      // Best effort
    }
  }
}

function formatEventBrief(event: InvocationEventEnvelope): string {
  const p = event.payload as Record<string, unknown> | undefined
  if (!p) return ''
  switch (event.type) {
    case 'invocation.started':
      return ` (pid: ${p['pid'] ?? '?'}, cwd: ${p['cwd'] ?? '?'})`
    case 'continuation.updated':
      return ` (provider: ${p['provider'] ?? '?'}, key: ${String(p['key'] ?? '?').slice(0, 20)})`
    case 'input.accepted':
      return ` (inputId: ${p['inputId'] ?? '?'})`
    case 'input.queued':
      return ` (inputId: ${p['inputId'] ?? '?'})`
    case 'input.rejected':
      return ` (inputId: ${p['inputId'] ?? '?'}, reason: ${p['reason'] ?? '?'})`
    case 'turn.started':
      return ` (turnId: ${p['turnId'] ?? '?'})`
    case 'turn.completed':
      return ` (turnId: ${p['turnId'] ?? '?'}, status: ${p['status'] ?? '?'})`
    case 'turn.failed':
      return ` (message: ${p['message'] ?? '?'})`
    case 'assistant.message.delta':
      return ` (${String(p['text'] ?? '').slice(0, 40)}${String(p['text'] ?? '').length > 40 ? '...' : ''})`
    case 'tool.call.started': {
      const input = asRecord(p['input'])
      return ` (${p['name'] ?? '?'}: ${String(input?.['command'] ?? input?.['path'] ?? '?').slice(0, 60)})`
    }
    case 'tool.call.completed': {
      const result = asRecord(p['result'])
      return ` (${p['name'] ?? '?'}: exit ${result?.['exitCode'] ?? '?'})`
    }
    case 'diagnostic':
      return ` (${p['level']}: ${String(p['message'] ?? '').slice(0, 60)})`
    default:
      return ''
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

try {
  await main()
} catch (err) {
  console.error('[smoke] Fatal error:', err)
  process.exit(2)
}
