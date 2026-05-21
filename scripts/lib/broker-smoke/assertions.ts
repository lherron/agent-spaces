/**
 * Assertion DSL and shared assertion functions for broker smoke tests.
 *
 * Provides check/requireEvents helpers and reusable assertion blocks
 * for terminal-turn verification, introspection output, and tool-call validation.
 */
import { formatScopeHandle, resolveScopeInput } from '../../../packages/agent-scope/src/index.ts'
import type { InvocationEventEnvelope } from '../../../packages/harness-broker-protocol/src/events.ts'

import {
  REQUIRED_EVENTS,
  REQUIRED_TOOL_EVENTS,
  asRecord,
  commandLooksLikePwdOnly,
  findEventIndex,
  findInputQueuedEvent,
  findInputRejectedEvent,
  inputRejectedReason,
  matchesRawOrRedacted,
  pathOutputMatches,
  redactForComparison,
} from './event-collector.ts'
import type { CollectedRun, ProbeResult, ProbeSpec, ScenarioRun } from './types.ts'

// ---------------------------------------------------------------------------
// Assertion DSL
// ---------------------------------------------------------------------------

/** Log pass/fail and return failure count increment (0 or 1). */
export function check(condition: boolean, okMsg: string, failMsg: string): number {
  if (condition) {
    console.log(`[smoke]   \u2713 ${okMsg}`)
    return 0
  }
  console.error(`[smoke]   \u2717 ${failMsg}`)
  return 1
}

/** Check that all event types in `expected` appear in `seenTypes`. Returns failure count. */
export function requireEvents(
  seenTypes: Set<string>,
  expected: readonly string[]
): number {
  let failures = 0
  for (const required of expected) {
    failures += check(seenTypes.has(required), required, `MISSING: ${required}`)
  }
  return failures
}

// ---------------------------------------------------------------------------
// Sensitive-value helpers
// ---------------------------------------------------------------------------

export function buildSensitiveValues(scopeRef: string): string[] {
  const resolved = resolveScopeInput(scopeRef)
  return [
    resolved.parsed.agentId,
    resolved.parsed.projectId,
    resolved.parsed.taskId,
    resolved.parsed.roleName,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
}

// ---------------------------------------------------------------------------
// Terminal turn assertion
// ---------------------------------------------------------------------------

export function assertTerminalTurnCompleted(
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

// ---------------------------------------------------------------------------
// Introspection assertion (shared: happy checks ASP_BROKER_OK, queue checks QUEUE_HOLDER_OK)
// ---------------------------------------------------------------------------

export function assertIntrospectionOutput(
  assistantTexts: string[],
  marker: string,
  scopeRef: string,
  sensitiveValues: string[]
): number {
  const expectedScopeHandle = formatScopeHandle(resolveScopeInput(scopeRef).parsed)
  const redactedExpectedScopeHandle = redactForComparison(expectedScopeHandle, sensitiveValues)
  const hasExpected = assistantTexts.some(
    (text) =>
      text.includes(marker) &&
      (text.includes(expectedScopeHandle) || text.includes(redactedExpectedScopeHandle))
  )
  return check(
    hasExpected,
    `introspect reply contains ${marker} and ${expectedScopeHandle}`,
    `introspect reply missing ${marker} or expected runtime scope handle ${expectedScopeHandle}`
  )
}

// ---------------------------------------------------------------------------
// Command tool-call assertion (happy scenario)
// ---------------------------------------------------------------------------

export function assertCommandToolCall(
  collected: CollectedRun,
  expectedCwd: string,
  sensitiveValues: string[]
): number {
  let failures = 0

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
    return failures + 1
  }

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

  // Verify completion
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
    return failures + 1
  }

  let completionFailures = 0
  if (commandCompletedPayload['name'] !== 'command') {
    console.error(
      `[smoke]   \u2717 command completion name mismatch: ${JSON.stringify(commandCompletedPayload['name'])}`
    )
    completionFailures++
  }
  if (commandCompletedPayload['isError'] !== false) {
    console.error(
      `[smoke]   \u2717 command completion isError mismatch: ${JSON.stringify(commandCompletedPayload['isError'])}`
    )
    completionFailures++
  }
  if (commandResult['exitCode'] !== 0) {
    console.error(
      `[smoke]   \u2717 command exitCode mismatch: ${JSON.stringify(commandResult['exitCode'])}`
    )
    completionFailures++
  }
  if (typeof commandResult['output'] !== 'string') {
    console.error('[smoke]   \u2717 command result.output is not a string')
    completionFailures++
  } else if (!pathOutputMatches(commandResult['output'], expectedCwd, sensitiveValues)) {
    console.error(
      `[smoke]   \u2717 command output does not match cwd: output=${JSON.stringify(commandResult['output'])}, expected=${JSON.stringify(expectedCwd)}`
    )
    completionFailures++
  }

  if (completionFailures === 0) {
    console.log('[smoke]   \u2713 command tool.call.completed payload')
  } else {
    failures += completionFailures
  }

  return failures
}

// ---------------------------------------------------------------------------
// Queue-policy probe assertions
// ---------------------------------------------------------------------------

/**
 * Assert FIFO probe results: reject probe rejected, queue probe queued + drained,
 * interrupt probe rejected with unsupported_busy_policy.
 */
export function assertFifoProbes(
  collected: CollectedRun,
  probes: readonly ProbeSpec[],
  probeResults: ProbeResult[] | undefined
): number {
  let failures = 0
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

    // Reject / interrupt probes
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

  return failures
}

/**
 * Assert inputQueue=none probe: queue attempt rejected with queue_not_supported.
 */
export function assertNoneProbe(
  collected: CollectedRun,
  probe: ProbeSpec,
  probeResults: ProbeResult[] | undefined
): number {
  let failures = 0
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

  if (failures === 0) {
    const transport = result?.rpcRejected ? 'rpc rejection' : 'response'
    console.log(
      `[smoke]   \u2713 probe ${probe.label} rejected via ${transport} with queue_not_supported and input.rejected event`
    )
  }

  return failures
}
