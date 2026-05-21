#!/usr/bin/env bun
/**
 * Real-Codex E2E Smoke Harness
 *
 * Drives the COMPLETE broker flow against a real installed Codex app-server:
 *   ScopeRef → RuntimePlacement → buildHarnessBrokerInvocation → BrokerClient → turn lifecycle
 *
 * Default prompt is a no-tool single-line reply that runs safely under
 * permissionPolicy { mode: 'deny' }. A separate scenario (e.g. --prompt-mode tool-use --yolo)
 * can exercise tool calls later; that is not included in the default invocation.
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
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveScopeInput } from '../packages/agent-scope/src/index.ts'
import {
  buildRuntimeBundleRef,
  resolveAgentPlacementPaths,
} from '../packages/config/src/store/runtime-placement.ts'
import type { RuntimePlacement } from '../packages/config/src/core/types/placement.ts'
import { createAgentSpacesClient } from '../packages/agent-spaces/src/index.ts'
import type { BuildHarnessBrokerInvocationRequest } from '../packages/agent-spaces/src/index.ts'
import { BrokerClient } from '../packages/harness-broker-client/src/index.ts'
import { validateInvocationStartRequest } from '../packages/harness-broker-protocol/src/schemas.ts'
import type { InvocationEventEnvelope } from '../packages/harness-broker-protocol/src/events.ts'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT = 'Reply exactly ASP_BROKER_REAL_CODEX_OK and do not run tools.'
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
      `Could not resolve agentRoot for "${args.scopeRef}". ` +
        'Provide --agent-root or ensure ASP_AGENTS_ROOT is set.'
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

const TERMINAL_TURN_EVENTS = ['turn.completed', 'turn.failed', 'turn.interrupted'] as const
type TerminalTurnEvent = (typeof TERMINAL_TURN_EVENTS)[number]

function isTerminalTurnEvent(type: string): type is TerminalTurnEvent {
  return (TERMINAL_TURN_EVENTS as readonly string[]).includes(type)
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
  const transcriptDir = join(args.transcript, '..')
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

  // Initialize empty transcript file
  writeFileSync(args.transcript, '')

  // Set up overall timeout
  const timeoutMs = args.timeout * 1000
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Overall timeout of ${args.timeout}s exceeded`)), timeoutMs)
  })

  try {
    const consumeEvents = async () => {
      for await (const event of events) {
        collectedEvents.push(event)
        seenTypes.add(event.type)

        // Write to JSONL transcript
        const line = JSON.stringify(event) + '\n'
        appendFileSync(args.transcript, line)

        // Log event
        const payload = event.payload as Record<string, unknown> | undefined
        const brief = formatEventBrief(event)
        console.log(`[smoke]   [${String(event.seq).padStart(3)}] ${event.type}${brief}`)

        // Accumulate assistant text for output
        if (event.type === 'assistant.message.delta' && payload?.['text']) {
          assistantOutput += payload['text'] as string
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
  }

  console.log()

  // Print assistant output
  if (assistantOutput) {
    console.log(`[smoke] Assistant output: ${assistantOutput.trim()}`)
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

  // Check terminal turn event
  if (terminalTurnEvent) {
    const payload = terminalTurnEvent.payload as Record<string, unknown> | undefined
    if (terminalTurnEvent.type === 'turn.completed') {
      console.log(`[smoke]   \u2713 ${terminalTurnEvent.type} (turnId: ${payload?.['turnId'] ?? 'n/a'})`)
    } else {
      console.error(
        `[smoke]   \u2717 Terminal event is ${terminalTurnEvent.type}, expected turn.completed`
      )
      if (payload) console.error(`[smoke]     payload: ${JSON.stringify(payload)}`)
      failures++
    }
  } else {
    console.error('[smoke]   \u2717 MISSING: terminal turn event (turn.completed/failed/interrupted)')
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
