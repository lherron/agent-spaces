export function parseHookDecision(
  raw: string,
  accepts: (decision: Record<string, unknown>) => boolean
): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed === 'ok') {
    return undefined
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined
    }
    const decision = parsed as Record<string, unknown>
    if (accepts(decision)) {
      return decision
    }
  } catch {
    return undefined
  }
  return undefined
}
