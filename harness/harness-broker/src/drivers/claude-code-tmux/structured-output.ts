import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import type { InvocationInput, TurnId } from 'spaces-harness-broker-protocol'
import type { DriverContext } from '../driver'
import { asRecord as asHookRecord } from '../hook-json'
import type { HookEnvelopeDecision } from '../tmux-shared'
import { CLAUDE_CODE_TMUX_DRIVER_KIND, type ClaudeCodeHookEnvelope } from './hook-events'

interface StructuredTurnState {
  turnId: string
  attempts: number
  validator: ValidateFunction
}

const STRUCTURED_OUTPUT_MAX_ATTEMPTS = 3

// Broker-synthesized structured-output enforcement for claude-code-tmux uses
// Ajv draft-07 defaults with strict schema linting disabled, allErrors enabled,
// and schema validation enabled. This intentionally mirrors the advertised
// strict:false capability: Claude is prompted, then the driver validates the
// Stop-hook candidate before allowing final capture.
const structuredOutputAjv = new Ajv({
  strict: false,
  allErrors: true,
})

export type StructuredHookDecision =
  | { action: 'continue'; envelope: ClaudeCodeHookEnvelope }
  | { action: 'drop'; decision?: HookEnvelopeDecision | undefined }

export interface ClaudeStructuredOutputGateOptions {
  /** The live driver context; notices and failures are dropped once disposed. */
  getContext: () => DriverContext | undefined
  /** Turns whose transcript carried a provider API error (shared with the reader). */
  apiErrorTurns: Set<string>
  /** Tell turn attribution a structured turn was closed by the gate itself. */
  onTurnFailed: (turnId: TurnId) => void
}

export interface ClaudeStructuredOutputGate {
  /** Arm the turn's validator and return the prompt that asks for schema JSON. */
  promptFor(input: InvocationInput, text: string, turnId: string): string
  /** Gate one hook envelope: pass it on (possibly rewritten) or drop it. */
  handleHook(envelope: ClaudeCodeHookEnvelope): StructuredHookDecision
  clear(): void
}

/**
 * Per-invocation structured-output enforcement (T-05145). A json_schema turn
 * may pass final capture only once its Stop-hook candidate validates; invalid
 * candidates block Stop with the validation reason until the retry cap, then
 * fail the turn.
 */
export function createClaudeStructuredOutputGate(
  options: ClaudeStructuredOutputGateOptions
): ClaudeStructuredOutputGate {
  const structuredTurns = new Map<string, StructuredTurnState>()
  const completedStructuredTurns = new Set<string>()

  function promptFor(input: InvocationInput, text: string, turnId: string): string {
    if (input.responseFormat?.kind !== 'json_schema') {
      return text
    }
    const schema = input.responseFormat.schema
    const validator = structuredOutputAjv.compile(schema)
    structuredTurns.set(turnId, {
      turnId,
      attempts: 0,
      validator,
    })
    completedStructuredTurns.delete(turnId)
    return `${text}\n\nreturn ONLY JSON matching this schema, no prose/markdown.\nSchema:\n${JSON.stringify(schema)}`
  }

  function handleHook(envelope: ClaudeCodeHookEnvelope): StructuredHookDecision {
    const hook = asHookRecord(envelope.hookData)
    const rawType =
      typeof hook['hook_event_name'] === 'string' ? hook['hook_event_name'] : undefined
    const mailDecision = rawType === 'Stop' ? envelope.mailStopDecision : undefined
    const turnId = envelope.turnId
    if (
      turnId !== undefined &&
      completedStructuredTurns.has(turnId) &&
      rawType === 'MessageDisplay'
    ) {
      return { action: 'drop' }
    }
    if (turnId === undefined) {
      return mailDecision === undefined
        ? { action: 'continue', envelope }
        : { action: 'drop', decision: mailDecision }
    }
    const state = structuredTurns.get(turnId)
    if (state === undefined) {
      return mailDecision === undefined
        ? { action: 'continue', envelope }
        : { action: 'drop', decision: mailDecision }
    }

    if (rawType === 'MessageDisplay') {
      // T-05145 invariant: for claude-code-tmux a structured turn may NOT pass
      // final capture unless its turn-local validator positively cleared the
      // candidate. MessageDisplay is racy with Stop and is never authoritative
      // for structured final capture; Stop's last_assistant_message is the gate.
      return { action: 'drop' }
    }
    if (rawType !== 'Stop') {
      if (rawType === 'SessionEnd') {
        failStructuredTurn(state, 'Structured output ended before Stop validation cleared')
        return { action: 'drop' }
      }
      return { action: 'continue', envelope }
    }

    const candidate =
      typeof hook['last_assistant_message'] === 'string' ? hook['last_assistant_message'] : ''
    const validation = validateStructuredCandidate(state, candidate)
    if (validation.valid) {
      if (mailDecision !== undefined) {
        return { action: 'drop', decision: mailDecision }
      }
      structuredTurns.delete(turnId)
      completedStructuredTurns.add(turnId)
      return {
        action: 'continue',
        envelope: {
          ...envelope,
          hookData: {
            ...hook,
            last_assistant_message: validation.normalized,
          },
        },
      }
    }

    state.attempts += 1
    const reason = formatValidationErrors(validation.errors)
    emitStructuredValidationNotice(state, reason, validation.errors)
    if (state.attempts < STRUCTURED_OUTPUT_MAX_ATTEMPTS) {
      return {
        action: 'drop',
        decision: {
          decision: 'block',
          reason:
            mailDecision === undefined
              ? reason
              : `${reason}\n\nMailbox drain is also required:\n${mailDecision.reason}`,
        },
      }
    }

    emitStructuredDiagnostic(state, candidate)
    failStructuredTurn(state, reason, validation.errors)
    return { action: 'drop' }
  }

  function failureCode(turnId: string): string {
    return options.apiErrorTurns.has(turnId)
      ? 'provider_error_truncated_output'
      : 'StructuredOutputValidationFailed'
  }

  function emitStructuredValidationNotice(
    state: StructuredTurnState,
    reason: string,
    errors: ErrorObject[]
  ): void {
    options.getContext()?.emit(
      'driver.notice',
      {
        message: reason,
        code: 'structured_output_validation_retry',
        data: { validation: formatValidationData(errors), attempts: state.attempts },
      },
      {
        turnId: state.turnId as TurnId,
        driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND },
      }
    )
  }

  function emitStructuredDiagnostic(state: StructuredTurnState, candidate: string): void {
    options.getContext()?.emit(
      'diagnostic',
      {
        level: 'warn',
        source: 'harness',
        message: 'Structured output validation failed after retry cap',
        data: {
          code: failureCode(state.turnId),
          rawCandidate: candidate,
        },
      },
      {
        turnId: state.turnId as TurnId,
        driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND },
      }
    )
  }

  function failStructuredTurn(
    state: StructuredTurnState,
    reason: string,
    errors: ErrorObject[] = []
  ): void {
    const code = failureCode(state.turnId)
    structuredTurns.delete(state.turnId)
    completedStructuredTurns.add(state.turnId)
    options.apiErrorTurns.delete(state.turnId)
    options.getContext()?.emit(
      'turn.failed',
      {
        turnId: state.turnId as TurnId,
        status: 'failed',
        message: reason,
        code,
        retryable: false,
        data: {
          validation: formatValidationData(errors),
          attempts: state.attempts,
        },
      },
      {
        turnId: state.turnId as TurnId,
        driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND },
      }
    )
    options.onTurnFailed(state.turnId as TurnId)
  }

  return {
    promptFor,
    handleHook,
    clear() {
      structuredTurns.clear()
      completedStructuredTurns.clear()
    },
  }
}

function validateStructuredCandidate(
  state: StructuredTurnState,
  candidate: string
): { valid: true; normalized: string } | { valid: false; errors: ErrorObject[] } {
  const parsed = parseStructuredJsonCandidate(candidate)
  if (!parsed.valid) {
    return {
      valid: false,
      errors: [
        {
          instancePath: '',
          schemaPath: '',
          keyword: 'parse',
          params: {},
          message: parsed.message,
        } as ErrorObject,
      ],
    }
  }
  if (state.validator(parsed.value)) {
    return { valid: true, normalized: JSON.stringify(parsed.value) }
  }
  return { valid: false, errors: [...(state.validator.errors ?? [])] }
}

/**
 * Extract the JSON value Claude answered with: the bare text, a single fenced
 * block, or one JSON root after leading prose with nothing trailing it.
 */
function parseStructuredJsonCandidate(
  candidate: string
): { valid: true; value: unknown } | { valid: false; message: string } {
  const trimmed = candidate.trim()
  const bare = tryParseJson(trimmed)
  if (bare.valid) {
    return bare
  }
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  if (fenced?.[1] !== undefined) {
    const fencedJson = tryParseJson(fenced[1].trim())
    if (fencedJson.valid) {
      return fencedJson
    }
    return { valid: false, message: 'must be valid JSON matching schema' }
  }
  const prefixed = tryParsePrefixedJsonRoot(trimmed)
  if (prefixed.valid) {
    return prefixed
  }
  return { valid: false, message: 'must be valid JSON matching schema' }
}

function tryParseJson(raw: string): { valid: true; value: unknown } | { valid: false } {
  try {
    return { valid: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { valid: false }
  }
}

function tryParsePrefixedJsonRoot(raw: string): { valid: true; value: unknown } | { valid: false } {
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char !== '{' && char !== '[') {
      continue
    }
    const endIndex = findJsonRootEnd(raw, index)
    if (endIndex === undefined) {
      continue
    }
    const json = raw.slice(index, endIndex)
    const parsed = tryParseJson(json)
    if (!parsed.valid) {
      continue
    }
    if (raw.slice(endIndex).trim().length > 0) {
      return { valid: false }
    }
    return parsed
  }
  return { valid: false }
}

function findJsonRootEnd(raw: string, startIndex: number): number | undefined {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let index = startIndex; index < raw.length; index += 1) {
    const char = raw[index]
    if (char === undefined) {
      return undefined
    }
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      stack.push('}')
      continue
    }
    if (char === '[') {
      stack.push(']')
      continue
    }
    if (char === '}' || char === ']') {
      if (stack.pop() !== char) {
        return undefined
      }
      if (stack.length === 0) {
        return index + 1
      }
    }
  }
  return undefined
}

function formatValidationErrors(errors: ErrorObject[]): string {
  if (errors.length === 0) {
    return 'must match schema'
  }
  return errors
    .slice(0, 3)
    .map((error) => {
      const path = error.instancePath.length > 0 ? error.instancePath : '/'
      return `${path} ${error.message ?? error.keyword}`.trim()
    })
    .join('; ')
}

function formatValidationData(errors: ErrorObject[]): Array<Record<string, unknown>> {
  return errors.map((error) => ({
    path: error.instancePath.length > 0 ? error.instancePath : '/',
    keyword: error.keyword,
    message: error.message ?? error.keyword,
    params: error.params,
  }))
}
