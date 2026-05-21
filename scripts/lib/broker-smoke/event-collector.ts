/**
 * Event collection loop: consumes broker event streams until terminal events,
 * with timeout handling and transcript recording.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'

import type { InvocationEventEnvelope } from '../../../packages/harness-broker-protocol/src/events.ts'
import type { BrokerClient } from '../../../packages/harness-broker-client/src/index.ts'

import type { CollectedRun, ProbeResult, ProbeSpec, ScenarioRun } from './types.ts'

// ---------------------------------------------------------------------------
// Event constants
// ---------------------------------------------------------------------------

export const REQUIRED_EVENTS = [
  'invocation.started',
  'continuation.updated',
  'invocation.ready',
  'input.accepted',
  'turn.started',
] as const

export const REQUIRED_TOOL_EVENTS = ['tool.call.started', 'tool.call.completed'] as const

const TERMINAL_TURN_EVENTS = ['turn.completed', 'turn.failed', 'turn.interrupted'] as const
type TerminalTurnEvent = (typeof TERMINAL_TURN_EVENTS)[number]

export function isTerminalTurnEvent(type: string): type is TerminalTurnEvent {
  return (TERMINAL_TURN_EVENTS as readonly string[]).includes(type)
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function normalizeExistingPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function redactForComparison(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues.reduce((current, sensitive) => {
    if (!sensitive) return current
    return current.replaceAll(sensitive, '[REDACTED]')
  }, value)
}

export function matchesRawOrRedacted(
  actual: unknown,
  expected: string,
  sensitiveValues: readonly string[]
): boolean {
  if (typeof actual !== 'string') return false
  return actual === expected || actual === redactForComparison(expected, sensitiveValues)
}

export function pathOutputMatches(
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

export function commandLooksLikePwdOnly(command: unknown): boolean {
  if (typeof command !== 'string') return false
  if (!/\bpwd\b/.test(command)) return false
  return !/(\bls\b|&&|;|\|\|?)/.test(command)
}

// ---------------------------------------------------------------------------
// Event finders
// ---------------------------------------------------------------------------

export function inputRejectedReason(event: InvocationEventEnvelope | undefined): string | undefined {
  const payload = asRecord(event?.payload)
  return typeof payload?.['reason'] === 'string' ? payload['reason'] : undefined
}

export function findInputRejectedEvent(
  events: InvocationEventEnvelope[],
  inputId: string
): InvocationEventEnvelope | undefined {
  return events.find((event) => {
    if (event.type !== 'input.rejected') return false
    const payload = asRecord(event.payload)
    return event.inputId === inputId || payload?.['inputId'] === inputId
  })
}

export function findInputQueuedEvent(
  events: InvocationEventEnvelope[],
  inputId: string
): InvocationEventEnvelope | undefined {
  return events.find((event) => {
    if (event.type !== 'input.queued') return false
    const payload = asRecord(event.payload)
    return event.inputId === inputId || payload?.['inputId'] === inputId
  })
}

export function findEventIndex(
  events: InvocationEventEnvelope[],
  predicate: (event: InvocationEventEnvelope) => boolean
): number {
  return events.findIndex(predicate)
}

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

function errorReason(err: unknown): string {
  const record = asRecord(err)
  if (typeof record?.['message'] === 'string' && record['message'].length > 0) {
    return record['message']
  }
  return String(err)
}

export async function sendBusyProbe(
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

// ---------------------------------------------------------------------------
// Event formatting
// ---------------------------------------------------------------------------

export function formatEventBrief(event: InvocationEventEnvelope): string {
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
// Core event collection loop
// ---------------------------------------------------------------------------

export async function collectEventsUntilTerminal(
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

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function cleanupInvocation(brokerClient: BrokerClient, invocationId: string): Promise<void> {
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
