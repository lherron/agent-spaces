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
import type { InvocationInput } from '../packages/harness-broker-protocol/src/commands.ts'
import type { InvocationEventEnvelope } from '../packages/harness-broker-protocol/src/events.ts'
import { validateInvocationStartRequest } from '../packages/harness-broker-protocol/src/schemas.ts'
import { expandTemplate } from '../packages/runtime/src/index.ts'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT =
  'Execute the shell command `pwd`. Do not execute any other shell commands. After it completes, reply with exactly two tokens separated by a space: ASP_BROKER_OK and the full runtime scope handle from your priming context. Use the shorthand handle form such as <agent>@<project>:<task>; do not use the colon-separated scopeRef form such as agent:<agent>:project:<project>:task:<task>.'
const DEFAULT_TIMEOUT_S = 120

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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  // Ensure transcript directory exists
  const transcriptDir = dirname(args.transcript)
  mkdirSync(transcriptDir, { recursive: true })

  console.log(`[smoke] scope-ref:      ${args.scopeRef}`)
  console.log(`[smoke] asp-home:       ${args.aspHome}`)
  console.log(`[smoke] invocation-id:  ${args.invocationId}`)
  console.log(`[smoke] timeout:        ${args.timeout}s`)
  console.log(`[smoke] transcript:     ${args.transcript}`)
  console.log(`[smoke] prompt:         ${args.prompt}`)
  console.log()

  // Ensure asp-home exists
  mkdirSync(args.aspHome, { recursive: true })

  // Step 1: Build placement from scope-ref
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

  // Step 2: Build broker invocation via ASP SDK
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
    labels: { scenario: 'asp-broker-real-codex-smoke' },
  }

  const invocationResponse = await spacesClient.buildHarnessBrokerInvocation(brokerReq)
  const expectedPriming = await expectedExpandedPrimingPrompt(placement)
  assertInitialInputStartsWithPriming(invocationResponse.initialInput, expectedPriming)
  console.log(`[smoke]   spec.invocationId: ${invocationResponse.spec.invocationId ?? '(auto)'}`)
  console.log(`[smoke]   spec.process.command: ${invocationResponse.spec.process.command}`)
  console.log(`[smoke]   spec.process.cwd: ${invocationResponse.spec.process.cwd}`)
  console.log(`[smoke]   initialInput: ${invocationResponse.initialInput ? 'present' : 'absent'}`)
  if (invocationResponse.warnings?.length) {
    console.log(`[smoke]   warnings: ${invocationResponse.warnings.join(', ')}`)
  }
  console.log()

  // Step 3: Validate start request
  console.log('[smoke] Step 3: Validating InvocationStartRequest...')
  try {
    validateInvocationStartRequest(invocationResponse.startRequest)
    console.log('[smoke]   Validation passed.')
  } catch (err) {
    console.error('[smoke]   Validation FAILED:', err)
    process.exit(2)
  }
  console.log()

  // Step 4: Start broker process
  console.log('[smoke] Step 4: Starting broker process...')
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

  // Step 5: Send hello
  console.log('[smoke] Step 5: Sending broker.hello...')
  const helloResp = await brokerClient.hello({
    clientInfo: { name: 'smoke-asp-broker-real-codex', version: '0.1.0' },
    protocolVersions: ['harness-broker/0.1'],
    capabilities: { permissionRequests: true },
  })
  console.log(`[smoke]   Broker: ${helloResp.brokerInfo.name} v${helloResp.brokerInfo.version}`)
  console.log(`[smoke]   Protocol: ${helloResp.protocolVersion}`)
  console.log(`[smoke]   Drivers: ${helloResp.drivers.map((d) => d.kind).join(', ')}`)
  console.log()

  // Register permission handler — default deny (matches permissionPolicy)
  brokerClient.onPermissionRequest(async (req) => {
    console.log(`[smoke]   Permission request: ${req.kind} → deny`)
    return { decision: 'deny' as const }
  })

  // Step 6: Start invocation with initialInput
  console.log('[smoke] Step 6: Starting invocation (with initialInput)...')
  const { invocationId, events } = await brokerClient.startInvocation(
    invocationResponse.startRequest.spec,
    invocationResponse.startRequest.initialInput
  )
  console.log(`[smoke]   invocationId: ${invocationId}`)
  console.log()

  // Step 7: Consume events until terminal turn event
  console.log('[smoke] Step 7: Consuming broker events...')
  const collectedEvents: InvocationEventEnvelope[] = []
  const seenTypes = new Set<string>()
  let terminalTurnEvent: InvocationEventEnvelope | undefined
  let assistantOutput = ''
  let assistantFinalOutput = ''

  // Initialize empty transcript file
  writeFileSync(args.transcript, '')

  // Set up overall timeout
  const timeoutMs = args.timeout * 1000
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Overall timeout of ${args.timeout}s exceeded`)),
      timeoutMs
    )
  })

  try {
    const consumeEvents = async () => {
      for await (const event of events) {
        collectedEvents.push(event)
        seenTypes.add(event.type)

        // Write to JSONL transcript
        const line = `${JSON.stringify(event)}\n`
        appendFileSync(args.transcript, line)

        // Log event
        const payload = event.payload as Record<string, unknown> | undefined
        const brief = formatEventBrief(event)
        console.log(`[smoke]   [${String(event.seq).padStart(3)}] ${event.type}${brief}`)

        // Accumulate assistant text for output
        if (event.type === 'assistant.message.delta' && payload?.['text']) {
          assistantOutput += payload['text'] as string
        }
        if (event.type === 'assistant.message.completed') {
          const content = Array.isArray(payload?.['content']) ? payload?.['content'] : []
          assistantFinalOutput = content
            .map((part) => {
              const record = asRecord(part)
              return record?.['type'] === 'text' ? String(record['text'] ?? '') : ''
            })
            .join('')
        }

        // Verify cwd from invocation.started payload
        if (event.type === 'invocation.started' && payload?.['cwd']) {
          const launchedCwd = payload['cwd'] as string
          const expectedCwd = invocationResponse.spec.process.cwd
          if (launchedCwd !== expectedCwd) {
            console.log(
              `[smoke]   WARNING: launched cwd "${launchedCwd}" differs from spec cwd "${expectedCwd}"`
            )
          } else {
            console.log(`[smoke]   Verified: cwd matches spec (${launchedCwd})`)
          }
        }

        // Check for terminal turn event
        if (isTerminalTurnEvent(event.type)) {
          terminalTurnEvent = event
          break
        }

        // Also break on invocation-level terminal events
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
    // Still attempt cleanup
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
  }

  console.log()

  // Print assistant output
  const assistantTexts = [assistantFinalOutput, assistantOutput].filter((text) => text.length > 0)
  const assistantText = assistantTexts[0] ?? ''
  if (assistantText) {
    console.log(`[smoke] Assistant output: ${assistantText.trim()}`)
    console.log()
  }

  // Step 8: Cleanup — stop and dispose
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
  try {
    await brokerClient.close()
    console.log('[smoke]   Broker client closed.')
  } catch {
    // Best effort
  }
  console.log()

  // Step 9: Assertions
  console.log('[smoke] Step 9: Assertions...')
  console.log(`[smoke]   Total events collected: ${collectedEvents.length}`)
  console.log(`[smoke]   Unique event types seen: ${[...seenTypes].join(', ')}`)
  console.log(`[smoke]   Transcript: ${args.transcript}`)
  console.log()

  let failures = 0

  // Check required events
  for (const required of REQUIRED_EVENTS) {
    if (seenTypes.has(required)) {
      console.log(`[smoke]   \u2713 ${required}`)
    } else {
      console.error(`[smoke]   \u2717 MISSING: ${required}`)
      failures++
    }
  }

  // Check tool execution events and payloads
  for (const required of REQUIRED_TOOL_EVENTS) {
    if (seenTypes.has(required)) {
      console.log(`[smoke]   \u2713 ${required}`)
    } else {
      console.error(`[smoke]   \u2717 MISSING: ${required}`)
      failures++
    }
  }

  const resolvedScope = resolveScopeInput(args.scopeRef)
  const sensitiveValues = [
    resolvedScope.parsed.agentId,
    resolvedScope.parsed.projectId,
    resolvedScope.parsed.taskId,
    resolvedScope.parsed.roleName,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  const expectedCwd = invocationResponse.spec.process.cwd
  const commandStarted = collectedEvents.find((event) => {
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
      ? collectedEvents.find((event) => {
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

  // Check terminal turn event
  if (terminalTurnEvent) {
    const payload = terminalTurnEvent.payload as Record<string, unknown> | undefined
    if (terminalTurnEvent.type === 'turn.completed') {
      console.log(
        `[smoke]   \u2713 ${terminalTurnEvent.type} (turnId: ${payload?.['turnId'] ?? 'n/a'})`
      )
    } else {
      console.error(
        `[smoke]   \u2717 Terminal event is ${terminalTurnEvent.type}, expected turn.completed`
      )
      if (payload) console.error(`[smoke]     payload: ${JSON.stringify(payload)}`)
      failures++
    }
  } else {
    console.error(
      '[smoke]   \u2717 MISSING: terminal turn event (turn.completed/failed/interrupted)'
    )
    failures++
  }

  const expectedScopeHandle = formatScopeHandle(resolvedScope.parsed)
  const redactedExpectedScopeHandle = redactForComparison(expectedScopeHandle, sensitiveValues)
  const hasExpectedIntrospection = assistantTexts.some(
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

  if (failures > 0) {
    console.error(`[smoke] FAILED: ${failures} assertion(s) failed`)
    process.exit(1)
  }

  console.log('[smoke] SUCCESS: All assertions passed')
  console.log(`[smoke] Transcript written to: ${args.transcript}`)
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
