import type { UsageContext } from 'spaces-harness-broker-protocol'

function isCount(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min
}

/**
 * Build the normalized `usage.updated` context (T-10927) from a driver's raw
 * readings. Returns undefined when `usedTokens` is not a non-negative integer,
 * so the driver omits `context` rather than emitting a guess; a window that is
 * not a positive integer is dropped, never inferred.
 */
export function usageContext(
  usedTokens: unknown,
  windowTokens?: unknown
): UsageContext | undefined {
  if (!isCount(usedTokens, 0)) return undefined
  return isCount(windowTokens, 1) ? { usedTokens, windowTokens } : { usedTokens }
}

/**
 * Claude assistant-row context fill: everything the request put in the window
 * (fresh input, cache reads, cache writes) plus the reply it added. Any missing
 * or malformed component leaves the sum uncomputable.
 */
export function claudeAssistantUsageContext(usage: unknown): UsageContext | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const row = usage as Record<string, unknown>
  const parts = [
    row['input_tokens'],
    row['cache_read_input_tokens'],
    row['cache_creation_input_tokens'],
    row['output_tokens'],
  ]
  if (!parts.every((part) => isCount(part, 0))) return undefined
  return usageContext((parts as number[]).reduce((sum, part) => sum + part, 0))
}
