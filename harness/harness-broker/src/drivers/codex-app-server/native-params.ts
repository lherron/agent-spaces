/**
 * Readers for native Codex notification params. `asRecord` deliberately treats
 * arrays as records, unlike `hook-json.ts`'s variant.
 */
import type { MessageId, ToolCallId, TurnId } from 'spaces-harness-broker-protocol'

export function asTurnId(value: string): TurnId {
  return value as TurnId
}

export function asMessageId(value: string): MessageId {
  return value as MessageId
}

export function asToolCallId(value: string): ToolCallId {
  return value as ToolCallId
}

export function objectWithDefined(
  values: Record<string, unknown>
): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}
