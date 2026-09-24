import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import type { ContractHarnessFailure } from './pre-hrc-broker-contract-types.js'

type TerminalTurnType = 'turn.completed' | 'turn.failed' | 'turn.interrupted'

const TERMINAL_TURN_EVENT_TYPES = new Set<TerminalTurnType>([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function assistantTexts(events: readonly InvocationEventEnvelope[]): string[] {
  const texts: string[] = []
  let deltaText = ''
  for (const event of events) {
    const payload = asRecord(event.payload)
    if (event.type === 'assistant.message.delta' && typeof payload?.['text'] === 'string') {
      deltaText += payload['text']
    }
    if (event.type === 'assistant.message.completed') {
      const content = Array.isArray(payload?.['content']) ? payload['content'] : []
      const text = content
        .map((part) => {
          const record = asRecord(part)
          return record?.['type'] === 'text' ? String(record['text'] ?? '') : ''
        })
        .join('')
      if (text.length > 0) texts.push(text)
    }
    if (event.type === 'turn.completed' && typeof payload?.['finalOutput'] === 'string') {
      texts.push(payload['finalOutput'])
    }
  }
  if (deltaText.length > 0) texts.push(deltaText)
  return texts
}

/**
 * SEMANTIC, harness-agnostic command-turn assertion (T-01667, cody bar C-02759
 * item 2). The matrix runner drives ONE canonical command turn through every
 * harness (codex `command`, claude `Bash`, ghostmux operator) with a unique
 * per-row marker; this proves the broker event vocabulary fired for that turn
 * WITHOUT pinning provider-exact payload shapes. This only requires:
 *   - turn.started for the turn id,
 *   - a tool.call.started with a NON-EMPTY normalized name + toolCallId,
 *   - a tool.call.completed matching that toolCallId that is NOT an error,
 *   - the expected marker observed in assistant.message.delta/.completed OR
 *     turn.completed.finalOutput,
 *   - exactly one terminal turn event for the turn id.
 * This is the cross-harness floor.
 *
 * Marker source: by DEFAULT the marker must be observed in assistant text
 * (assistant.message.delta/.completed) OR turn.completed.finalOutput — the
 * codex-style "assistant marker observed" requirement. Harnesses that do NOT
 * surface assistant text in the normalized event stream (claude-code-tmux only
 * emits hook-derived turn/tool events; its turn.completed carries no transcript)
 * supply `markerSources` to point the SAME shared check at the provider-correct
 * evidence — e.g. the Bash `tool.call` command input/output that ran
 * `printf '<marker>'` ("command/Bash evidence consistent with prompt",
 * C-02759 item 2: SEMANTIC not provider-exact, row-specific may tighten). The
 * default keeps the assistant-text bar unchanged.
 */
export type SharedCommandTurnMarkerSource = 'assistant' | 'tool-command' | 'tool-output'

export function assertSharedCommandTurn(
  events: readonly InvocationEventEnvelope[],
  options: {
    turnId: string
    expectedMarker: string
    markerSources?: readonly SharedCommandTurnMarkerSource[] | undefined
  }
): ContractHarnessFailure[] {
  const failures: ContractHarnessFailure[] = []
  const { turnId, expectedMarker } = options
  const markerSources = options.markerSources ?? (['assistant'] as const)
  const turnEvents = events.filter((event) => event.turnId === turnId)

  if (!turnEvents.some((event) => event.type === 'turn.started')) {
    failures.push({
      code: 'shared_command_turn_missing',
      message: `Command turn ${turnId} did not emit a turn.started event.`,
      path: 'brokerEvents',
      redactedDetails: { turnId },
    })
  }

  const toolStarted = turnEvents.find((event) => event.type === 'tool.call.started')
  const startedPayload = asRecord(toolStarted?.payload)
  const toolName = startedPayload?.['name']
  const toolCallId = startedPayload?.['toolCallId']

  if (toolStarted === undefined || startedPayload === undefined) {
    failures.push({
      code: 'shared_command_turn_missing',
      message: `Command turn ${turnId} did not emit a tool.call.started event.`,
      path: 'brokerEvents',
      redactedDetails: { turnId },
    })
  } else {
    if (typeof toolName !== 'string' || toolName.length === 0) {
      failures.push({
        code: 'shared_command_turn_invalid',
        message: 'Command turn tool.call.started must carry a non-empty normalized tool name.',
        path: `brokerEvents.${toolStarted.invocationId}.${toolStarted.seq}.payload.name`,
        redactedDetails: { name: toolName },
      })
    }
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      failures.push({
        code: 'shared_command_turn_invalid',
        message: 'Command turn tool.call.started must carry a non-empty toolCallId.',
        path: `brokerEvents.${toolStarted.invocationId}.${toolStarted.seq}.payload.toolCallId`,
      })
    }
  }

  // The matched non-error completion is required AND is the ONLY tool evidence
  // tool-command/tool-output may inspect (cody C-02759 re-sign constraint): a
  // marker in a command string without the matching non-error completion is
  // still a FAIL, and evidence is scoped to this turn's matched toolCallId pair.
  let matchedCompletion: InvocationEventEnvelope | undefined
  let matchedCompletionNonError = false
  if (typeof toolCallId === 'string' && toolCallId.length > 0) {
    matchedCompletion = turnEvents.find((event) => {
      if (event.type !== 'tool.call.completed') return false
      const payload = asRecord(event.payload)
      return payload?.['toolCallId'] === toolCallId
    })
    if (matchedCompletion === undefined) {
      failures.push({
        code: 'shared_command_turn_missing',
        message: 'Command turn did not emit a tool.call.completed matching the started toolCallId.',
        path: 'brokerEvents',
        redactedDetails: { turnId, toolCallId },
      })
    } else {
      const completedPayload = asRecord(matchedCompletion.payload)
      if (completedPayload?.['isError'] === true) {
        failures.push({
          code: 'shared_command_turn_invalid',
          message: 'Command turn tool.call.completed must not be an error.',
          path: `brokerEvents.${matchedCompletion.invocationId}.${matchedCompletion.seq}.payload.isError`,
        })
      } else {
        matchedCompletionNonError = true
      }
    }
  }

  const markerHaystacks: string[] = []
  if (markerSources.includes('assistant')) markerHaystacks.push(...assistantTexts(turnEvents))
  // Tool evidence is admissible ONLY when the matched, non-error completion for
  // the started toolCallId is present, and ONLY from that matched pair.
  if (
    (markerSources.includes('tool-command') || markerSources.includes('tool-output')) &&
    matchedCompletion !== undefined &&
    matchedCompletionNonError
  ) {
    // tool-output is the strongest evidence (the marker appeared in the executed
    // command's output → proves execution), so it is considered before
    // tool-command.
    if (markerSources.includes('tool-output')) {
      const completedPayload = asRecord(matchedCompletion.payload)
      const result = asRecord(completedPayload?.['result'])
      if (typeof result?.['output'] === 'string') markerHaystacks.push(result['output'])
      else if (result !== undefined) markerHaystacks.push(JSON.stringify(result))
      const details = completedPayload?.['details']
      if (typeof details === 'string') markerHaystacks.push(details)
      const content = completedPayload?.['content']
      if (typeof content === 'string') markerHaystacks.push(content)
    }
    if (markerSources.includes('tool-command') && startedPayload !== undefined) {
      const input = asRecord(startedPayload['input'])
      if (typeof input?.['command'] === 'string') markerHaystacks.push(input['command'])
      else if (input !== undefined) markerHaystacks.push(JSON.stringify(input))
    }
  }
  if (!markerHaystacks.some((text) => text.includes(expectedMarker))) {
    failures.push({
      code: 'shared_command_turn_invalid',
      message: `Command turn output did not include marker ${expectedMarker} (sources: ${markerSources.join(', ')}).`,
      path: 'brokerEvents',
      redactedDetails: { turnId, expectedMarker, markerSources },
    })
  }

  const terminalTurns = turnEvents.filter((event) =>
    TERMINAL_TURN_EVENT_TYPES.has(event.type as TerminalTurnType)
  )
  if (terminalTurns.length !== 1) {
    failures.push({
      code: 'shared_command_turn_invalid',
      message: 'Command turn must contain exactly one terminal turn event for the turn id.',
      path: 'brokerEvents',
      redactedDetails: {
        turnId,
        count: terminalTurns.length,
        terminalTypes: terminalTurns.map((event) => event.type),
      },
    })
  }

  return failures
}
